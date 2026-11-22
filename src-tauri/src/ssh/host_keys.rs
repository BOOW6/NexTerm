//! TOFU host-key storage: the known_hosts JSON store, the pre-dialog
//! classification of a presented server key, and the OpenSSH
//! known_hosts import/export codecs. Connection-flow glue (waiting for the
//! user's decision, wiring into the handshake) stays in `super`.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use russh::keys::{HashAlg, PublicKey};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use tokio::sync::oneshot;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// The pure, pre-dialog part of the TOFU decision: is this host known, and
/// does the presented fingerprint match? Extracted so the state machine can
/// be unit-tested without a live `AppHandle` (the `tauri::test` mock runtime
/// breaks the test binary loader on Windows).
#[derive(Debug)]
pub(crate) enum HostKeyCheck {
    /// Fingerprint matches the stored record.
    KnownOk,
    /// The host is known but the fingerprint differs; carries the expected one.
    Mismatch { expected: String },
    /// First contact with this host label.
    Unknown,
}

pub(crate) fn classify_server_key(
    state: &HostKeyState,
    host_label: &str,
    fingerprint: &str,
) -> HostKeyCheck {
    let known = lock(&state.known);
    let Some(entry) = known.get(host_label) else {
        return HostKeyCheck::Unknown;
    };
    if constant_time_eq(&entry.fingerprint, fingerprint) {
        return HostKeyCheck::KnownOk;
    }
    HostKeyCheck::Mismatch {
        expected: entry.fingerprint.clone(),
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct KnownHost {
    pub host: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub added_at: u64,
    /// OpenSSH public key blob (`algorithm base64`), used for known_hosts export.
    #[serde(default)]
    pub public_key: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct KnownHostsImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub invalid: usize,
}

#[derive(Clone, Serialize)]
pub struct KnownHostsExportResult {
    pub exported: usize,
    pub skipped: usize,
}

pub struct HostKeyState {
    /// `None` when no usable config directory exists: TOFU records then stay
    /// in memory only instead of silently degrading to a world-readable temp
    /// file that periodic cleanups may wipe (same policy as the vault).
    path: Option<PathBuf>,
    known: Mutex<HashMap<String, KnownHost>>,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl HostKeyState {
    pub(crate) fn new(path: Option<PathBuf>) -> Self {
        let known = path.as_deref().map(Self::load).unwrap_or_default();

        Self {
            path,
            known: Mutex::new(known),
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn load(path: &Path) -> HashMap<String, KnownHost> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            // Missing file: first run, start empty.
            Err(_) => return HashMap::new(),
        };
        match serde_json::from_slice::<Vec<KnownHost>>(&bytes) {
            Ok(entries) => entries
                .into_iter()
                .map(|entry| (entry.host.clone(), entry))
                .collect(),
            Err(error) => {
                // A truncated or corrupted file must not silently wipe every
                // recorded TOFU decision; keep it around for inspection.
                let backup = path.with_extension("json.corrupt");
                if std::fs::rename(path, &backup).is_ok() {
                    eprintln!(
                        "[known_hosts] unreadable file ({error}); moved to {}",
                        backup.display()
                    );
                }
                HashMap::new()
            }
        }
    }

    pub(crate) fn list(&self) -> Vec<KnownHost> {
        let mut entries: Vec<KnownHost> = lock(&self.known).values().cloned().collect();
        entries.sort_by(|a, b| a.host.cmp(&b.host));
        entries
    }

    pub(crate) fn remove(&self, host: &str) -> anyhow::Result<()> {
        let mut known = lock(&self.known);
        known.remove(host);
        self.persist(&known)
    }

    pub(crate) fn add(
        &self,
        host: String,
        algorithm: String,
        fingerprint: String,
        public_key: Option<String>,
    ) -> anyhow::Result<()> {
        let mut known = lock(&self.known);
        known.insert(
            host.clone(),
            KnownHost {
                host,
                algorithm,
                fingerprint,
                added_at: now_unix(),
                public_key,
            },
        );
        self.persist(&known)
    }

    fn persist(&self, known: &HashMap<String, KnownHost>) -> anyhow::Result<()> {
        let Some(path) = self.path.as_deref() else {
            // No usable config directory: keep the in-memory map, do not
            // degrade to a temp file.
            return Err(anyhow!("no usable config directory for known_hosts"));
        };
        let entries: Vec<&KnownHost> = known.values().collect();
        let json =
            serde_json::to_vec_pretty(&entries).context("failed to serialize known_hosts")?;
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Write-through-temp-then-rename: a crash mid-write leaves the
        // previous file intact instead of a truncated, unparsable one.
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, json)
            .and_then(|()| std::fs::rename(&temp, path))
            .with_context(|| format!("failed to persist known_hosts to {}", path.display()))?;
        Ok(())
    }

    /// Backfill the OpenSSH blob for a record created before export support.
    /// A missing host label or an already-filled blob changes nothing.
    pub(crate) fn backfill_public_key(
        &self,
        host: &str,
        public_key: Option<String>,
    ) -> anyhow::Result<bool> {
        let mut known = lock(&self.known);
        let Some(entry) = known.get_mut(host) else {
            return Ok(false);
        };
        if entry.public_key.is_some() {
            return Ok(false);
        }
        entry.public_key = public_key;
        self.persist(&known)?;
        Ok(true)
    }

    /// Upsert every entry in one pass and persist once: merging a whole
    /// imported file per-entry used to rewrite the file for every line.
    pub(crate) fn merge_and_persist(&self, entries: Vec<KnownHost>) -> anyhow::Result<()> {
        let mut known = lock(&self.known);
        for entry in entries {
            known.insert(entry.host.clone(), entry);
        }
        self.persist(&known)
    }

    /// Register a host-key decision wait (the TOFU dialog answers it later).
    pub(crate) fn insert_pending(&self, request_id: String, sender: oneshot::Sender<bool>) {
        lock(&self.pending).insert(request_id, sender);
    }

    /// Take a pending decision out of the map: either resolved, or abandoned
    /// by a disconnect/timeout (dropping the sender closes that wait).
    pub(crate) fn take_pending(&self, request_id: &str) -> Option<oneshot::Sender<bool>> {
        lock(&self.pending).remove(request_id)
    }

    #[cfg(test)]
    pub(crate) fn pending_is_empty(&self) -> bool {
        lock(&self.pending).is_empty()
    }
}

fn openssh_host_to_label(pattern: &str) -> Option<String> {
    if pattern.is_empty()
        || pattern.starts_with('|')
        || pattern.starts_with('!')
        || pattern.contains('*')
        || pattern.contains('?')
    {
        return None;
    }

    let (host, port) = if let Some(rest) = pattern.strip_prefix('[') {
        match rest.split_once("]:") {
            Some((host, port)) => (host, port.parse::<u16>().ok()?),
            None => (rest.strip_suffix(']')?, 22),
        }
    } else if pattern.matches(':').count() > 1 {
        // A bare IPv6 address: OpenSSH omits the brackets and the port when
        // it is 22, and splitting on the last colon would mangle the address.
        (pattern, 22)
    } else if let Some((host, port)) = pattern.rsplit_once(':') {
        match port.parse::<u16>() {
            Ok(port) => (host, port),
            Err(_) => (pattern, 22),
        }
    } else {
        (pattern, 22)
    };

    if host.is_empty() {
        return None;
    }

    Some(format!("{host}:{port}"))
}

fn openssh_host_field(label: &str) -> Option<String> {
    let (host, port) = match label.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()?),
        None => (label, 22),
    };

    if host.is_empty() {
        return None;
    }

    if port == 22 && !host.contains(':') {
        Some(host.to_string())
    } else {
        Some(format!("[{host}]:{port}"))
    }
}

fn hash_openssh_host(host: &str) -> String {
    let salt: [u8; 20] = rand::random();
    let mut mac = Hmac::<Sha1>::new_from_slice(&salt).expect("HMAC accepts any key size");
    mac.update(host.as_bytes());
    let digest = mac.finalize().into_bytes();

    format!(
        "|1|{}|{}",
        STANDARD_NO_PAD.encode(salt),
        STANDARD_NO_PAD.encode(digest)
    )
}

pub(crate) fn parse_openssh_known_hosts(content: &str) -> (Vec<KnownHost>, KnownHostsImportResult) {
    let mut entries = Vec::new();
    let mut result = KnownHostsImportResult {
        imported: 0,
        skipped: 0,
        invalid: 0,
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let mut parts = line.split_whitespace();
        let Some(hosts) = parts.next() else {
            continue;
        };

        if hosts.starts_with('@') {
            result.skipped += 1;
            continue;
        }

        let (Some(key_type), Some(key_data)) = (parts.next(), parts.next()) else {
            result.invalid += 1;
            continue;
        };

        let key = match PublicKey::from_openssh(&format!("{key_type} {key_data}")) {
            Ok(key) => key,
            Err(_) => {
                result.invalid += 1;
                continue;
            }
        };
        let algorithm = key.algorithm().to_string();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let public_key = key.to_openssh().ok();

        for pattern in hosts.split(',') {
            match openssh_host_to_label(pattern) {
                Some(host) => {
                    entries.push(KnownHost {
                        host,
                        algorithm: algorithm.clone(),
                        fingerprint: fingerprint.clone(),
                        added_at: now_unix(),
                        public_key: public_key.clone(),
                    });
                    result.imported += 1;
                }
                None => result.skipped += 1,
            }
        }
    }

    (entries, result)
}

pub(crate) fn format_openssh_known_hosts(
    entries: &[KnownHost],
    hash_hosts: bool,
) -> (String, KnownHostsExportResult) {
    let mut lines = Vec::new();
    let mut result = KnownHostsExportResult {
        exported: 0,
        skipped: 0,
    };

    for entry in entries {
        let Some(public_key) = entry
            .public_key
            .as_deref()
            .filter(|value| !value.is_empty())
        else {
            result.skipped += 1;
            continue;
        };
        let Some(host_field) = openssh_host_field(&entry.host) else {
            result.skipped += 1;
            continue;
        };

        let host_field = if hash_hosts {
            hash_openssh_host(&host_field)
        } else {
            host_field
        };
        lines.push(format!("{host_field} {public_key}"));
        result.exported += 1;
    }

    let content = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };

    (content, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const TEST_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    fn read_known_hosts(path: &std::path::Path) -> Vec<KnownHost> {
        let bytes = std::fs::read(path).expect("known_hosts file should exist");
        serde_json::from_slice(&bytes).expect("known_hosts should be valid JSON")
    }

    fn test_key() -> russh::keys::PublicKey {
        russh::keys::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINGF4nxcqidKQd9FQxlVweDSP+e0WiQVkdSHUHQgV1nP tofu-test",
        )
        .expect("fixed test key parses")
    }

    fn known_host(host: &str, public_key: Option<&str>) -> KnownHost {
        KnownHost {
            host: host.to_string(),
            algorithm: "Ed25519".to_string(),
            fingerprint: "SHA256:test".to_string(),
            added_at: 1,
            public_key: public_key.map(str::to_string),
        }
    }

    #[test]
    fn host_key_classify_accepts_matching_fingerprints() {
        let dir = tempdir().unwrap();
        let state = HostKeyState::new(Some(dir.path().join("known_hosts.json")));
        let key = test_key();
        state
            .add(
                "example.com:22".to_string(),
                key.algorithm().to_string(),
                key.fingerprint(HashAlg::Sha256).to_string(),
                None,
            )
            .unwrap();

        assert!(matches!(
            classify_server_key(
                &state,
                "example.com:22",
                &key.fingerprint(HashAlg::Sha256).to_string()
            ),
            HostKeyCheck::KnownOk
        ));
        // A different host label stays unknown.
        assert!(matches!(
            classify_server_key(&state, "other.example.com:22", "SHA256:whatever"),
            HostKeyCheck::Unknown
        ));
    }

    #[test]
    fn host_key_classify_reports_mismatch_with_expected_fingerprint() {
        let dir = tempdir().unwrap();
        let state = HostKeyState::new(Some(dir.path().join("known_hosts.json")));
        let key = test_key();
        state
            .add(
                "example.com:22".to_string(),
                key.algorithm().to_string(),
                key.fingerprint(HashAlg::Sha256).to_string(),
                None,
            )
            .unwrap();

        match classify_server_key(&state, "example.com:22", "SHA256:tampered") {
            HostKeyCheck::Mismatch { expected } => {
                assert_eq!(expected, key.fingerprint(HashAlg::Sha256).to_string());
            }
            other => panic!("expected Mismatch, got {other:?}"),
        }
    }

    #[test]
    fn host_key_classify_flags_unknown_hosts() {
        let dir = tempdir().unwrap();
        let state = HostKeyState::new(Some(dir.path().join("known_hosts.json")));

        assert!(matches!(
            classify_server_key(&state, "example.com:22", "SHA256:whatever"),
            HostKeyCheck::Unknown
        ));
    }

    #[test]
    fn known_hosts_starts_empty_when_file_is_missing() {
        let dir = tempdir().unwrap();
        let state = HostKeyState::new(Some(dir.path().join("known_hosts.json")));

        assert!(state.list().is_empty());
    }

    #[test]
    fn known_hosts_ignores_corrupted_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        std::fs::write(&path, b"not json").unwrap();

        let state = HostKeyState::new(Some(path));

        assert!(state.list().is_empty());
    }

    #[test]
    fn add_persists_entries_and_sorts_them_by_host() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("known_hosts.json");
        let state = HostKeyState::new(Some(path.clone()));

        state
            .add("zeta:22".into(), "Rsa".into(), "SHA256:zeta".into(), None)
            .unwrap();
        state
            .add(
                "alpha:22".into(),
                "Ed25519".into(),
                "SHA256:alpha".into(),
                None,
            )
            .unwrap();

        let entries = state.list();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.host.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha:22", "zeta:22"]
        );
        assert_eq!(entries[0].algorithm, "Ed25519");
        assert!(entries[0].added_at > 0);

        let persisted = read_known_hosts(&path);
        assert_eq!(persisted.len(), 2);
    }

    #[test]
    fn add_replaces_an_existing_host_entry() {
        let dir = tempdir().unwrap();
        let state = HostKeyState::new(Some(dir.path().join("known_hosts.json")));

        state
            .add("host:22".into(), "Rsa".into(), "SHA256:old".into(), None)
            .unwrap();
        state
            .add("host:22".into(), "Rsa".into(), "SHA256:new".into(), None)
            .unwrap();

        let entries = state.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].fingerprint, "SHA256:new");
    }

    #[test]
    fn remove_deletes_and_persists_the_change() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        let state = HostKeyState::new(Some(path.clone()));
        state
            .add("keep:22".into(), "Rsa".into(), "SHA256:keep".into(), None)
            .unwrap();
        state
            .add("drop:22".into(), "Rsa".into(), "SHA256:drop".into(), None)
            .unwrap();

        state.remove("drop:22").unwrap();

        assert_eq!(state.list().len(), 1);
        let reloaded = HostKeyState::new(Some(path));
        let entries = reloaded.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "keep:22");
    }

    #[test]
    fn loads_previously_persisted_entries() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        let saved = vec![KnownHost {
            host: "saved:2222".into(),
            algorithm: "Ed25519".into(),
            fingerprint: "SHA256:saved".into(),
            added_at: 42,
            public_key: None,
        }];
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();

        let state = HostKeyState::new(Some(path));
        let entries = state.list();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "saved:2222");
        assert_eq!(entries[0].added_at, 42);
    }

    #[test]
    fn corrupt_known_hosts_file_is_moved_aside() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        std::fs::write(&path, b"{ definitely not json").unwrap();

        let state = HostKeyState::new(Some(path.clone()));

        assert!(state.list().is_empty());
        // The unreadable original is kept for inspection, not deleted.
        assert!(path.with_extension("json.corrupt").exists());
        assert!(!path.exists());

        // New records persist normally again after the reset.
        state
            .add(
                "recovered:22".to_string(),
                "ssh-ed25519".to_string(),
                "SHA256:test".to_string(),
                None,
            )
            .unwrap();
        assert_eq!(state.list().len(), 1);
    }

    #[test]
    fn openssh_host_labels_round_trip() {
        assert_eq!(
            openssh_host_to_label("example.com").as_deref(),
            Some("example.com:22")
        );
        assert_eq!(
            openssh_host_to_label("[example.com]:2222").as_deref(),
            Some("example.com:2222")
        );
        assert_eq!(openssh_host_to_label("[::1]:22").as_deref(), Some("::1:22"));
        assert_eq!(openssh_host_to_label("|1|salt|hash"), None);
        assert_eq!(openssh_host_to_label("*.example.com"), None);
        assert_eq!(openssh_host_to_label("!bad.example.com"), None);

        assert_eq!(
            openssh_host_field("example.com:22").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            openssh_host_field("example.com:2222").as_deref(),
            Some("[example.com]:2222")
        );
        assert_eq!(openssh_host_field("::1:22").as_deref(), Some("[::1]:22"));
    }

    #[test]
    fn openssh_import_handles_bare_ipv6_hosts() {
        // OpenSSH omits brackets and the port for port-22 IPv6 hosts; the
        // whole address is the host and the port defaults to 22.
        assert_eq!(openssh_host_to_label("::1"), Some("::1:22".to_string()));
        assert_eq!(
            openssh_host_to_label("2001:db8::1"),
            Some("2001:db8::1:22".to_string())
        );
        // A single colon remains host:port.
        assert_eq!(
            openssh_host_to_label("example.com:2222"),
            Some("example.com:2222".to_string())
        );
        assert_eq!(
            openssh_host_to_label("example.com"),
            Some("example.com:22".to_string())
        );
        // Bracketed IPv6 keeps working, with and without a port.
        assert_eq!(
            openssh_host_to_label("[::1]:22"),
            Some("::1:22".to_string())
        );
        assert_eq!(
            openssh_host_to_label("[2001:db8::1]:2200"),
            Some("2001:db8::1:2200".to_string())
        );
        // Export brackets IPv6 hosts again so OpenSSH can parse them.
        assert_eq!(
            openssh_host_field("2001:db8::1:22"),
            Some("[2001:db8::1]:22".to_string())
        );
    }

    #[test]
    fn parses_openssh_known_hosts_entries() {
        let content = format!(
            "# comment\n\
             example.com ssh-ed25519 {TEST_KEY}\n\
             [example.com]:2222 ssh-ed25519 {TEST_KEY}\n\
             |1|salt|hash ssh-ed25519 {TEST_KEY}\n\
             @revoked * ssh-ed25519 {TEST_KEY}\n\
             *.example.com ssh-ed25519 {TEST_KEY}\n\
             not-a-valid-line\n"
        );

        let (entries, result) = parse_openssh_known_hosts(&content);

        assert_eq!(result.imported, 2);
        assert_eq!(result.skipped, 3);
        assert_eq!(result.invalid, 1);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry.host == "example.com:22"));
        assert!(entries.iter().any(|entry| entry.host == "example.com:2222"));
        assert!(entries.iter().all(|entry| entry.public_key.is_some()));
        assert!(entries
            .iter()
            .all(|entry| entry.fingerprint.starts_with("SHA256:")));
    }

    #[test]
    fn formats_openssh_known_hosts_entries() {
        let entries = vec![
            known_host("example.com:22", Some(&format!("ssh-ed25519 {TEST_KEY}"))),
            known_host("example.com:2222", Some(&format!("ssh-ed25519 {TEST_KEY}"))),
            known_host("missing-key:22", None),
        ];

        let (content, result) = format_openssh_known_hosts(&entries, false);

        assert_eq!(result.exported, 2);
        assert_eq!(result.skipped, 1);
        assert!(content.contains(&format!("example.com ssh-ed25519 {TEST_KEY}")));
        assert!(content.contains(&format!("[example.com]:2222 ssh-ed25519 {TEST_KEY}")));
    }

    #[test]
    fn formats_hashed_known_hosts_entries() {
        let entries = vec![known_host(
            "example.com:22",
            Some(&format!("ssh-ed25519 {TEST_KEY}")),
        )];
        let (content, result) = format_openssh_known_hosts(&entries, true);

        assert_eq!(result.exported, 1);
        let host_field = content.split_whitespace().next().unwrap();
        let parts: Vec<&str> = host_field.split('|').collect();
        assert_eq!(parts.len(), 4, "expected |1|salt|hash");
        assert_eq!(parts[1], "1");
        assert!(!parts[2].is_empty());
        assert!(!parts[3].is_empty());
        assert!(!content.contains("example.com"));
    }
}
