//! Small encrypted credential vault.
//!
//! Secrets are encrypted with AES-256-GCM and a key derived from the user's
//! master password with Argon2id. The vault stays locked until the user
//! unlocks it after an application restart, so persisted passwords never
//! become readable just by opening the app.

use std::{
    collections::BTreeMap,
    io::Write,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

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

#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u8,
    kdf: String,
    salt: String,
    nonce: String,
    data: String,
}

#[derive(Default)]
struct VaultState {
    salt: Option<[u8; SALT_LEN]>,
    key: Option<[u8; KEY_LEN]>,
    entries: BTreeMap<String, String>,
}

pub struct VaultManager {
    path: PathBuf,
    state: Mutex<VaultState>,
}

impl VaultManager {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(VaultState::default()),
        }
    }

    pub fn status(&self) -> VaultStatus {
        let state = lock(&self.state);
        VaultStatus {
            initialized: self.path.exists(),
            unlocked: state.key.is_some(),
            entry_count: state.entries.len(),
        }
    }

    pub fn initialize(&self, master_password: &str) -> anyhow::Result<VaultStatus> {
        if self.path.exists() {
            return Err(anyhow!("凭据保险库已存在"));
        }
        validate_master_password(master_password)?;

        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let key = derive_key(master_password, &salt)?;

        let mut state = lock(&self.state);
        state.salt = Some(salt);
        state.key = Some(key);
        state.entries.clear();
        self.persist(&state)?;

        Ok(VaultStatus {
            initialized: true,
            unlocked: true,
            entry_count: 0,
        })
    }

    pub fn unlock(&self, master_password: &str) -> anyhow::Result<bool> {
        let text =
            std::fs::read_to_string(&self.path).context("failed to read credential vault")?;
        let file: VaultFile =
            serde_json::from_str(&text).context("failed to parse credential vault")?;
        if file.version != VAULT_VERSION {
            return Err(anyhow!("不支持的凭据保险库版本"));
        }

        let salt_bytes = BASE64
            .decode(file.salt.as_bytes())
            .context("failed to decode vault salt")?;
        let salt: [u8; SALT_LEN] = salt_bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("凭据保险库 salt 长度无效"))?;
        let key = derive_key(master_password, &salt)?;

        let plaintext = match decrypt(&key, &file.nonce, &file.data) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        let entries: BTreeMap<String, String> =
            serde_json::from_slice(&plaintext).context("failed to parse vault entries")?;

        let mut state = lock(&self.state);
        state.salt = Some(salt);
        state.key = Some(key);
        state.entries = entries;
        Ok(true)
    }

    pub fn lock(&self) {
        let mut state = lock(&self.state);
        state.key = None;
        state.entries.clear();
    }

    pub fn set(&self, name: &str, secret: &str) -> anyhow::Result<()> {
        if name.trim().is_empty() {
            return Err(anyhow!("凭据名称不能为空"));
        }
        let mut state = lock(&self.state);
        require_unlocked(&state)?;
        state.entries.insert(name.to_string(), secret.to_string());
        self.persist(&state)
    }

    pub fn get(&self, name: &str) -> anyhow::Result<Option<String>> {
        let state = lock(&self.state);
        require_unlocked(&state)?;
        Ok(state.entries.get(name).cloned())
    }

    pub fn delete(&self, name: &str) -> anyhow::Result<()> {
        let mut state = lock(&self.state);
        require_unlocked(&state)?;
        if state.entries.remove(name).is_some() {
            self.persist(&state)?;
        }
        Ok(())
    }

    pub fn clear(&self) -> anyhow::Result<()> {
        let mut state = lock(&self.state);
        require_unlocked(&state)?;
        state.entries.clear();
        self.persist(&state)
    }

    pub fn change_password(
        &self,
        old_password: &str,
        new_password: &str,
    ) -> anyhow::Result<VaultStatus> {
        validate_master_password(new_password)?;
        if !self.unlock(old_password)? {
            return Err(anyhow!("当前主密码错误"));
        }

        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let key = derive_key(new_password, &salt)?;

        let mut state = lock(&self.state);
        state.salt = Some(salt);
        state.key = Some(key);
        self.persist(&state)?;

        Ok(VaultStatus {
            initialized: true,
            unlocked: true,
            entry_count: state.entries.len(),
        })
    }

    pub fn reset(&self) -> anyhow::Result<()> {
        if self.path.exists() {
            std::fs::remove_file(&self.path).context("failed to remove credential vault")?;
        }
        let mut state = lock(&self.state);
        *state = VaultState::default();
        Ok(())
    }

    fn persist(&self, state: &VaultState) -> anyhow::Result<()> {
        let salt = state.salt.ok_or_else(|| anyhow!("凭据保险库尚未解锁"))?;
        let key = state.key.ok_or_else(|| anyhow!("凭据保险库尚未解锁"))?;

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
            salt: BASE64.encode(salt),
            nonce: BASE64.encode(nonce),
            data: BASE64.encode(ciphertext),
        };
        let json =
            serde_json::to_vec_pretty(&file).context("failed to serialize credential vault")?;

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).context("failed to create vault directory")?;
        }

        // Rename replaces the target on every platform, so a failure is
        // surfaced as-is. Never fall back to deleting the old vault first: a
        // failed retry would then destroy the only good copy on disk.
        let temp = self.path.with_extension("tmp");
        let mut temp_file =
            std::fs::File::create(&temp).context("failed to create credential vault temp file")?;
        temp_file
            .write_all(&json)
            .context("failed to write credential vault")?;
        temp_file
            .sync_all()
            .context("failed to flush credential vault")?;
        drop(temp_file);
        std::fs::rename(&temp, &self.path).context("failed to replace credential vault")?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
            if let Some(parent) = self.path.parent() {
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

fn derive_key(password: &str, salt: &[u8; SALT_LEN]) -> anyhow::Result<[u8; KEY_LEN]> {
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|err| anyhow!("无法派生保险库密钥: {err}"))?;
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

    #[test]
    fn round_trip_encrypted_entries() {
        let dir = tempfile::tempdir().expect("temp dir");
        let manager = VaultManager::new(dir.path().join("vault.json"));

        assert!(!manager.status().initialized);
        assert!(manager.set("a", "b").is_err());

        manager.initialize("correct horse").expect("initialize");
        manager.set("session:one:password", "secret").expect("set");
        manager.lock();
        assert!(manager.get("session:one:password").is_err());

        assert!(!manager.unlock("wrong password").expect("unlock wrong"));
        assert!(!manager.status().unlocked);
        assert!(manager.unlock("correct horse").expect("unlock"));
        assert_eq!(
            manager.get("session:one:password").expect("get"),
            Some("secret".to_string())
        );

        let raw = std::fs::read_to_string(dir.path().join("vault.json")).expect("read vault");
        assert!(!raw.contains("secret"));
    }

    #[test]
    fn change_password_reencrypts() {
        let dir = tempfile::tempdir().expect("temp dir");
        let manager = VaultManager::new(dir.path().join("vault.json"));
        manager.initialize("first password").expect("initialize");
        manager.set("key", "value").expect("set");
        manager
            .change_password("first password", "second password")
            .expect("change");
        manager.lock();

        assert!(!manager.unlock("first password").expect("old password"));
        assert!(manager.unlock("second password").expect("new password"));
        assert_eq!(manager.get("key").expect("get"), Some("value".to_string()));
    }
}
