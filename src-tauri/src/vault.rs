//! Small encrypted credential vault.
//!
//! Secrets are encrypted with AES-256-GCM and a key derived from the user's
//! master password with Argon2id. The vault stays locked until the user
//! unlocks it after an application restart, so persisted passwords never
//! become readable just by opening the app.

use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

const VAULT_VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[derive(Clone, Serialize)]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub entry_count: usize,
}

/// The exact KDF parameters a vault file was written with. Persisted so a
/// dependency upgrade can never silently change the derivation and lock every
/// existing vault out.
#[derive(Clone, Copy, Serialize, Deserialize)]
struct KdfParams {
    /// Argon2 memory cost in KiB.
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        // Matches argon2::Params::default(); vaults written before the params
        // were persisted were derived with exactly these values.
        Self {
            m_cost: 19456,
            t_cost: 2,
            p_cost: 1,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u8,
    kdf: String,
    /// Absent in vault files written before the parameters were persisted.
    #[serde(default)]
    kdf_params: Option<KdfParams>,
    salt: String,
    nonce: String,
    data: String,
}

#[derive(Clone, Default)]
struct VaultState {
    salt: Option<[u8; SALT_LEN]>,
    key: Option<[u8; KEY_LEN]>,
    kdf_params: KdfParams,
    entries: BTreeMap<String, String>,
}

pub struct VaultManager {
    /// `None` when the platform could not provide an app config directory:
    /// the vault then refuses to operate instead of silently degrading to a
    /// temp directory that periodic cleanups may wipe.
    path: Option<PathBuf>,
    state: Mutex<VaultState>,
    /// Serializes every disk-touching operation. Tauri runs async commands
    /// concurrently, so the main-thread ordering sync commands used to get
    /// for free has to be explicit here.
    io: AsyncMutex<()>,
}

impl VaultManager {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            state: Mutex::new(VaultState::default()),
            io: AsyncMutex::new(()),
        }
    }

    fn vault_path(&self) -> anyhow::Result<&Path> {
        self.path
            .as_deref()
            .ok_or_else(|| anyhow!("无法确定应用配置目录，凭据保险库不可用"))
    }

    pub fn status(&self) -> VaultStatus {
        let state = lock(&self.state);
        VaultStatus {
            initialized: self
                .path
                .as_ref()
                .map(|path| path.exists())
                .unwrap_or(false),
            unlocked: state.key.is_some(),
            entry_count: state.entries.len(),
        }
    }

    pub async fn initialize(&self, master_password: &str) -> anyhow::Result<VaultStatus> {
        let _io = self.io.lock().await;
        let path = self.vault_path()?;
        if path.exists() {
            return Err(anyhow!("凭据保险库已存在"));
        }
        validate_master_password(master_password)?;

        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let params = KdfParams::default();
        let key = derive_key_async(master_password.to_string(), salt, params).await?;

        let mut state = lock(&self.state);
        let previous = state.clone();
        state.salt = Some(salt);
        state.key = Some(key);
        state.kdf_params = params;
        state.entries.clear();
        if let Err(err) = self.persist(&state) {
            *state = previous;
            return Err(err);
        }

        Ok(VaultStatus {
            initialized: true,
            unlocked: true,
            entry_count: 0,
        })
    }

    pub async fn unlock(&self, master_password: &str) -> anyhow::Result<bool> {
        let _io = self.io.lock().await;
        self.unlock_inner(master_password).await
    }

    async fn unlock_inner(&self, master_password: &str) -> anyhow::Result<bool> {
        let path = self.vault_path()?;
        let text = std::fs::read_to_string(path).context("failed to read credential vault")?;
        let file: VaultFile =
            serde_json::from_str(&text).context("failed to parse credential vault")?;
        if file.version != VAULT_VERSION {
            return Err(anyhow!("不支持的凭据保险库版本"));
        }
        if file.kdf != "argon2id" {
            return Err(anyhow!("不支持的 KDF 算法: {}", file.kdf));
        }
        let params = file.kdf_params.unwrap_or_default();

        let salt_bytes = BASE64
            .decode(file.salt.as_bytes())
            .context("failed to decode vault salt")?;
        let salt: [u8; SALT_LEN] = salt_bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("凭据保险库 salt 长度无效"))?;
        let key = derive_key_async(master_password.to_string(), salt, params).await?;

        let plaintext = match decrypt(&key, &file.nonce, &file.data) {
            Ok(value) => value,
            // Wrong master password or a corrupted ciphertext: both surface
            // as an authentication failure, never as a hard error.
            Err(_) => return Ok(false),
        };
        let entries: BTreeMap<String, String> =
            serde_json::from_slice(&plaintext).context("failed to parse vault entries")?;

        let mut state = lock(&self.state);
        state.salt = Some(salt);
        state.key = Some(key);
        state.kdf_params = params;
        state.entries = entries;
        Ok(true)
    }

    pub async fn lock(&self) {
        let _io = self.io.lock().await;
        let mut state = lock(&self.state);
        state.key = None;
        state.entries.clear();
    }

    pub async fn set(&self, name: &str, secret: &str) -> anyhow::Result<()> {
        if name.trim().is_empty() {
            return Err(anyhow!("凭据名称不能为空"));
        }
        let _io = self.io.lock().await;
        let mut state = lock(&self.state);
        require_unlocked(&state)?;
        let previous = state.entries.insert(name.to_string(), secret.to_string());
        if let Err(err) = self.persist(&state) {
            match previous {
                Some(value) => {
                    state.entries.insert(name.to_string(), value);
                }
                None => {
                    state.entries.remove(name);
                }
            }
            return Err(err);
        }
        Ok(())
    }

    pub fn get(&self, name: &str) -> anyhow::Result<Option<String>> {
        let state = lock(&self.state);
        require_unlocked(&state)?;
        Ok(state.entries.get(name).cloned())
    }

    pub async fn delete(&self, name: &str) -> anyhow::Result<()> {
        let _io = self.io.lock().await;
        let mut state = lock(&self.state);
        require_unlocked(&state)?;
        let Some(removed) = state.entries.remove(name) else {
            return Ok(());
        };
        if let Err(err) = self.persist(&state) {
            state.entries.insert(name.to_string(), removed);
            return Err(err);
        }
        Ok(())
    }

    pub async fn clear(&self) -> anyhow::Result<()> {
        let _io = self.io.lock().await;
        let mut state = lock(&self.state);
        require_unlocked(&state)?;
        let previous = state.entries.clone();
        state.entries.clear();
        if let Err(err) = self.persist(&state) {
            state.entries = previous;
            return Err(err);
        }
        Ok(())
    }

    pub async fn change_password(
        &self,
        old_password: &str,
        new_password: &str,
    ) -> anyhow::Result<VaultStatus> {
        validate_master_password(new_password)?;
        let _io = self.io.lock().await;
        if !self.unlock_inner(old_password).await? {
            return Err(anyhow!("当前主密码错误"));
        }

        let params = {
            let state = lock(&self.state);
            state.kdf_params
        };
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let key = derive_key_async(new_password.to_string(), salt, params).await?;

        let mut state = lock(&self.state);
        let previous_salt = state.salt;
        let previous_key = state.key;
        state.salt = Some(salt);
        state.key = Some(key);
        if let Err(err) = self.persist(&state) {
            state.salt = previous_salt;
            state.key = previous_key;
            return Err(err);
        }

        Ok(VaultStatus {
            initialized: true,
            unlocked: true,
            entry_count: state.entries.len(),
        })
    }

    pub async fn reset(&self) -> anyhow::Result<()> {
        let _io = self.io.lock().await;
        let path = self.vault_path()?;
        if path.exists() {
            std::fs::remove_file(path).context("failed to remove credential vault")?;
        }
        let mut state = lock(&self.state);
        *state = VaultState::default();
        Ok(())
    }

    fn persist(&self, state: &VaultState) -> anyhow::Result<()> {
        let salt = state.salt.ok_or_else(|| anyhow!("凭据保险库尚未解锁"))?;
        let key = state.key.ok_or_else(|| anyhow!("凭据保险库尚未解锁"))?;
        let path = self.vault_path()?;

        let plaintext =
            serde_json::to_vec(&state.entries).context("failed to serialize vault entries")?;
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);

        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| anyhow!("failed to initialize vault cipher"))?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
            .map_err(|_| anyhow!("failed to encrypt credential vault"))?;

        let file = VaultFile {
            version: VAULT_VERSION,
            kdf: "argon2id".to_string(),
            kdf_params: Some(state.kdf_params),
            salt: BASE64.encode(salt),
            nonce: BASE64.encode(nonce),
            data: BASE64.encode(ciphertext),
        };
        let json =
            serde_json::to_vec_pretty(&file).context("failed to serialize credential vault")?;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("failed to create vault directory")?;
        }

        // Rename replaces the target on every platform, so a failure is
        // surfaced as-is. Never fall back to deleting the old vault first: a
        // failed retry would then destroy the only good copy on disk.
        let temp = path.with_extension("tmp");
        let mut temp_file =
            std::fs::File::create(&temp).context("failed to create credential vault temp file")?;
        temp_file
            .write_all(&json)
            .context("failed to write credential vault")?;
        temp_file
            .sync_all()
            .context("failed to flush credential vault")?;
        drop(temp_file);
        std::fs::rename(&temp, path).context("failed to replace credential vault")?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            if let Some(parent) = path.parent() {
                if let Ok(dir) = std::fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
        }

        Ok(())
    }
}

fn require_unlocked(state: &VaultState) -> anyhow::Result<()> {
    if state.key.is_none() {
        return Err(anyhow!("凭据保险库已锁定"));
    }
    Ok(())
}

fn validate_master_password(password: &str) -> anyhow::Result<()> {
    if password.chars().count() < 8 {
        return Err(anyhow!("主密码至少需要 8 个字符"));
    }
    Ok(())
}

fn derive_key_with_params(
    password: &str,
    salt: &[u8; SALT_LEN],
    params: &KdfParams,
) -> anyhow::Result<[u8; KEY_LEN]> {
    let params = Params::new(params.m_cost, params.t_cost, params.p_cost, None)
        .map_err(|err| anyhow!("无效的 KDF 参数: {err}"))?;
    let mut key = [0u8; KEY_LEN];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|err| anyhow!("无法派生保险库密钥: {err}"))?;
    Ok(key)
}

/// Argon2id is memory-hard enough to stall the UI thread for hundreds of
/// milliseconds; run it on the blocking pool instead.
async fn derive_key_async(
    password: String,
    salt: [u8; SALT_LEN],
    params: KdfParams,
) -> anyhow::Result<[u8; KEY_LEN]> {
    let key =
        tokio::task::spawn_blocking(move || derive_key_with_params(&password, &salt, &params))
            .await
            .map_err(|err| anyhow!("无法派生保险库密钥: {err}"))??;
    Ok(key)
}

fn decrypt(key: &[u8; KEY_LEN], nonce: &str, data: &str) -> anyhow::Result<Vec<u8>> {
    let nonce_bytes = BASE64
        .decode(nonce.as_bytes())
        .context("failed to decode vault nonce")?;
    let nonce_bytes: [u8; NONCE_LEN] = nonce_bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("凭据保险库 nonce 长度无效"))?;
    let ciphertext = BASE64
        .decode(data.as_bytes())
        .context("failed to decode vault data")?;
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| anyhow!("failed to initialize vault cipher"))?;
    cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_slice())
        .map_err(|_| anyhow!("failed to decrypt credential vault"))
}

#[cfg(test)]
mod tests {
    use super::VaultManager;

    #[tokio::test]
    async fn round_trip_encrypted_entries() {
        let dir = tempfile::tempdir().expect("temp dir");
        let manager = VaultManager::new(Some(dir.path().join("vault.json")));

        assert!(!manager.status().initialized);
        assert!(manager.set("a", "b").await.is_err());

        manager
            .initialize("correct horse")
            .await
            .expect("initialize");
        manager
            .set("session:one:password", "secret")
            .await
            .expect("set");
        manager.lock().await;
        assert!(manager.get("session:one:password").is_err());

        assert!(!manager
            .unlock("wrong password")
            .await
            .expect("unlock wrong"));
        assert!(!manager.status().unlocked);
        assert!(manager.unlock("correct horse").await.expect("unlock"));
        assert_eq!(
            manager.get("session:one:password").expect("get"),
            Some("secret".to_string())
        );

        let raw = std::fs::read_to_string(dir.path().join("vault.json")).expect("read vault");
        assert!(!raw.contains("secret"));
    }

    #[tokio::test]
    async fn change_password_reencrypts() {
        let dir = tempfile::tempdir().expect("temp dir");
        let manager = VaultManager::new(Some(dir.path().join("vault.json")));
        manager
            .initialize("first password")
            .await
            .expect("initialize");
        manager.set("key", "value").await.expect("set");
        manager
            .change_password("first password", "second password")
            .await
            .expect("change");
        manager.lock().await;

        assert!(!manager
            .unlock("first password")
            .await
            .expect("old password"));
        assert!(manager
            .unlock("second password")
            .await
            .expect("new password"));
        assert_eq!(manager.get("key").expect("get"), Some("value".to_string()));
    }

    #[tokio::test]
    async fn kdf_params_persisted_and_legacy_files_still_unlock() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("vault.json");
        let manager = VaultManager::new(Some(path.clone()));
        manager
            .initialize("correct horse")
            .await
            .expect("initialize");
        manager.set("key", "value").await.expect("set");
        manager.lock().await;

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read vault"))
                .expect("parse vault");
        assert_eq!(raw["kdf_params"]["m_cost"], 19456);
        assert_eq!(raw["kdf_params"]["t_cost"], 2);
        assert_eq!(raw["kdf_params"]["p_cost"], 1);

        // Simulate a vault written by an older build without persisted params.
        let mut legacy = raw;
        legacy.as_object_mut().expect("object").remove("kdf_params");
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&legacy).expect("serialize"),
        )
        .expect("write legacy vault");

        assert!(manager.unlock("correct horse").await.expect("unlock"));
        assert_eq!(manager.get("key").expect("get"), Some("value".to_string()));
        assert!(!manager
            .unlock("wrong password")
            .await
            .expect("unlock wrong"));
    }

    #[tokio::test]
    async fn failed_persist_rolls_back_memory_changes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("vault.json");
        let manager = VaultManager::new(Some(path.clone()));
        manager
            .initialize("correct horse")
            .await
            .expect("initialize");
        manager.set("a", "1").await.expect("set");

        // A directory where the temp file should go makes every persist fail.
        std::fs::create_dir(path.with_extension("tmp")).expect("block temp file");

        assert!(manager.set("b", "2").await.is_err());
        assert_eq!(manager.get("b").expect("get"), None);

        assert!(manager.delete("a").await.is_err());
        assert_eq!(manager.get("a").expect("get").as_deref(), Some("1"));

        assert!(manager.clear().await.is_err());
        assert_eq!(manager.get("a").expect("get").as_deref(), Some("1"));

        assert!(manager
            .change_password("correct horse", "new password")
            .await
            .is_err());
        assert_eq!(manager.get("a").expect("get").as_deref(), Some("1"));

        // Disk still holds the last successfully persisted state.
        manager.lock().await;
        assert!(manager.unlock("correct horse").await.expect("unlock"));
        assert_eq!(manager.get("a").expect("get").as_deref(), Some("1"));
        assert_eq!(manager.get("b").expect("get"), None);
    }

    #[tokio::test]
    async fn missing_config_dir_disables_the_vault() {
        let manager = VaultManager::new(None);

        assert!(!manager.status().initialized);
        assert!(manager.initialize("correct horse").await.is_err());
        assert!(manager.unlock("correct horse").await.is_err());
        assert!(manager.set("a", "b").await.is_err());
    }
}
