//! Remote file editing: download a remote file to a scratch copy, open it in
//! the user's local editor, and watch the scratch copy so every save syncs
//! back through the normal SFTP upload engine (visible in the transfer queue).
//!
//! The watcher polls size + mtime every couple of seconds instead of using a
//! file-watch crate: editors write in several chunks, so a quiet period is
//! required anyway, and polling keeps the dependency tree small. The watcher
//! stops when the session drops, the scratch file is deleted, or the app
//! exits; scratch copies live under `app_data_dir/remote-edit`. A scratch
//! copy never outlives its watcher: the watcher deletes it on exit, and
//! startup wipes whatever a previous run left behind, so remote content does
//! not linger in the app data dir.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Context};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::MissedTickBehavior;

use crate::ssh::{ConflictPolicy, SftpTransferOptions, SshManager};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Editors save in several chunks; wait for the write to settle before
/// syncing so we never upload a half-written file.
const QUIET_PERIOD: Duration = Duration::from_millis(1500);
/// Retry ladder after a failed upload: the file stays dirty and is retried,
/// doubling from the poll interval up to this cap so a persistent failure
/// (full remote disk, permission error) does not spam the transfer queue.
const MAX_RETRY_DELAY: Duration = Duration::from_secs(60);

/// Next delay before retrying a failed sync.
fn next_retry_delay(current: Duration) -> Duration {
    (current * 2).min(MAX_RETRY_DELAY)
}

type Baseline = (u64, Option<SystemTime>);

#[derive(Default)]
pub struct RemoteEditManager {
    watchers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl RemoteEditManager {
    fn stop(&self, key: &str) {
        if let Some(cancel) = self
            .watchers
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(key)
        {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Stop a watcher only when `cancel` is the token currently registered for
    /// `key`. A watcher that is finishing must not tear down its replacement:
    /// re-opening the same file stops the old watcher and installs a new one,
    /// and the old task notices its cancel flag up to one poll interval later.
    /// Returns whether this watcher was still the current one (only the
    /// current watcher owns and cleans up the scratch copy).
    fn stop_if_current(&self, key: &str, cancel: &Arc<AtomicBool>) -> bool {
        let mut watchers = self
            .watchers
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let is_current = watchers
            .get(key)
            .map(|current| Arc::ptr_eq(current, cancel))
            .unwrap_or(false);
        if is_current {
            watchers.remove(key);
            cancel.store(true, Ordering::SeqCst);
        }
        is_current
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEditSession {
    pub temp_path: String,
    pub size: u64,
}

fn sanitize_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

/// Stable per-(session, remote path) key: the session id plus a hash of the
/// remote path (paths can be long and contain characters hostile to Windows
/// directory names).
fn edit_key(id: &str, remote_path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    remote_path.hash(&mut hasher);
    format!("{}\u{1f}{:016x}", id, hasher.finish())
}

fn scratch_dir(app: &AppHandle, id: &str, remote_path: &str) -> anyhow::Result<PathBuf> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    remote_path.hash(&mut hasher);
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| anyhow!("no usable app data directory"))?
        .join("remote-edit")
        .join(sanitize_component(id))
        .join(format!("{:016x}", hasher.finish())))
}

async fn download_to(
    sftp: &SftpSession,
    remote_path: &str,
    target: &PathBuf,
) -> anyhow::Result<u64> {
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create scratch dir: {}", parent.display()))?;
    }
    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .context("failed to open remote file")?;
    let mut local = tokio::fs::File::create(target)
        .await
        .with_context(|| format!("failed to create scratch file: {}", target.display()))?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = remote
            .read(&mut buffer)
            .await
            .context("failed to read remote file")?;
        if read == 0 {
            break;
        }
        local
            .write_all(&buffer[..read])
            .await
            .context("failed to write scratch file")?;
        total += read as u64;
    }
    local
        .flush()
        .await
        .context("failed to flush scratch file")?;
    Ok(total)
}

async fn stat_baseline(path: &PathBuf) -> Option<Baseline> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

#[allow(clippy::too_many_arguments)]
async fn watch_task(
    app: AppHandle,
    id: String,
    remote_path: String,
    scratch: PathBuf,
    cancel: Arc<AtomicBool>,
    mut baseline: Baseline,
) {
    let key = edit_key(&id, &remote_path);
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut retry_delay = POLL_INTERVAL;

    loop {
        interval.tick().await;
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        // The scratch file is the source of truth for the watcher's lifetime:
        // once it disappears (cleanup, editor moved it) there is nothing to sync.
        let Some(current) = stat_baseline(&scratch).await else {
            break;
        };
        if current == baseline {
            continue;
        }
        tokio::time::sleep(QUIET_PERIOD).await;
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let Some(settled) = stat_baseline(&scratch).await else {
            break;
        };
        if settled != current {
            // Still being written; the next poll sees the final state.
            continue;
        }

        let ssh = app.state::<SshManager>();
        if !ssh.has_connection(&id) {
            break;
        }
        let options = SftpTransferOptions {
            recursive: false,
            resume: false,
            conflict: ConflictPolicy::Overwrite,
        };
        let name = scratch
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_string());
        match ssh
            .sftp_upload(
                app.clone(),
                &id,
                scratch.to_string_lossy().into_owned(),
                remote_path.clone(),
                options,
            )
            .await
        {
            Ok(_) => {
                // Only a successful sync advances the baseline. Advancing it
                // before the upload made the next poll see "no local change"
                // and never retry a failed save.
                baseline = settled;
                retry_delay = POLL_INTERVAL;
                let _ = app.emit(
                    "remote-edit-synced",
                    serde_json::json!({
                        "sessionId": id,
                        "remotePath": remote_path,
                        "name": name,
                    }),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "remote-edit-error",
                    serde_json::json!({
                        "sessionId": id,
                        "remotePath": remote_path,
                        "name": name,
                        "error": err.to_string(),
                    }),
                );
                if !ssh.has_connection(&id) {
                    break;
                }
                // The file stays dirty and is retried on a later poll; back
                // off so a persistent failure does not fire an error event
                // every couple of seconds.
                tokio::time::sleep(retry_delay).await;
                retry_delay = next_retry_delay(retry_delay);
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }

    if let Some(manager) = app.try_state::<RemoteEditManager>() {
        let was_current = manager.stop_if_current(&key, &cancel);
        if was_current {
            // Remote content must not linger in the app data dir: delete the
            // scratch copy and tidy the now-empty hash and session dirs
            // (remove_dir only succeeds when they hold no other edit).
            let _ = tokio::fs::remove_file(&scratch).await;
            if let Some(hash_dir) = scratch.parent() {
                let _ = tokio::fs::remove_dir(hash_dir).await;
                if let Some(session_dir) = hash_dir.parent() {
                    let _ = tokio::fs::remove_dir(session_dir).await;
                }
            }
        }
    }
}

/// Remove every scratch copy left behind by a previous run. Watchers live
/// only in memory, so after a restart nothing can be synced anymore and
/// the leftover remote content must not stay on disk.
pub async fn cleanup_stale_scratch(app: AppHandle) {
    let Ok(root) = app.path().app_data_dir() else {
        return;
    };
    let root = root.join("remote-edit");
    if let Err(err) = tokio::fs::remove_dir_all(&root).await {
        if err.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[remote-edit] failed to clean stale scratch copies: {err}");
        }
    }
}

#[tauri::command]
pub async fn remote_edit_open(
    app: AppHandle,
    ssh: tauri::State<'_, SshManager>,
    edits: tauri::State<'_, RemoteEditManager>,
    id: String,
    remote_path: String,
) -> Result<RemoteEditSession, String> {
    if remote_path.trim().is_empty() {
        return Err("remote path must not be empty".to_string());
    }
    let key = edit_key(&id, &remote_path);
    // Re-opening the same file restarts the watcher on a fresh download.
    edits.stop(&key);

    let sftp = ssh.open_sftp(&id).await.map_err(|err| err.to_string())?;
    let metadata = sftp
        .metadata(&remote_path)
        .await
        .map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        return Err("cannot edit a directory".to_string());
    }

    let file_name = remote_path
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("file");
    let scratch = scratch_dir(&app, &id, &remote_path)
        .map_err(|err| err.to_string())?
        .join(sanitize_component(file_name));

    download_to(&sftp, &remote_path, &scratch)
        .await
        .map_err(|err| err.to_string())?;
    let size = scratch.metadata().map(|meta| meta.len()).unwrap_or(0);

    let cancel = Arc::new(AtomicBool::new(false));
    edits
        .watchers
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .insert(key.clone(), cancel.clone());

    let baseline = stat_baseline(&scratch)
        .await
        .ok_or_else(|| "failed to create scratch file".to_string())?;
    let watch_cancel = cancel.clone();
    let watch_task_handle = tokio::spawn(watch_task(
        app.clone(),
        id.clone(),
        remote_path.clone(),
        scratch.clone(),
        cancel,
        baseline,
    ));

    // A panicking watcher never reaches its own `stop_if_current`, which would
    // leave the key pointing at a dead task and let `remote_edit_stop` be a
    // no-op for every later open of the same file.
    let watchdog_app = app.clone();
    tokio::spawn(async move {
        if let Err(join_error) = watch_task_handle.await {
            eprintln!("[remote-edit] watcher aborted: {join_error}");
            if let Some(manager) = watchdog_app.try_state::<RemoteEditManager>() {
                manager.stop_if_current(&key, &watch_cancel);
            }
        }
    });

    Ok(RemoteEditSession {
        temp_path: scratch.to_string_lossy().into_owned(),
        size,
    })
}

/// Stop watching a file (also used when the caller knows the edit is done).
/// The watcher deletes its scratch copy on exit, so remote content does not
/// stay in the app data dir after the edit ends.
#[tauri::command]
pub async fn remote_edit_stop(
    app: AppHandle,
    id: String,
    remote_path: String,
) -> Result<(), String> {
    if let Some(manager) = app.try_state::<RemoteEditManager>() {
        manager.stop(&edit_key(&id, &remote_path));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_doubles_up_to_the_cap() {
        let mut delay = POLL_INTERVAL;
        let mut steps = 0;
        while delay < MAX_RETRY_DELAY {
            delay = next_retry_delay(delay);
            steps += 1;
        }
        assert_eq!(delay, MAX_RETRY_DELAY);
        // 2s -> 4s -> 8s -> 16s -> 32s -> 60s cap: the ladder stays short.
        assert!(steps <= 5, "backoff reached the cap in {steps} steps");
        assert_eq!(next_retry_delay(MAX_RETRY_DELAY), MAX_RETRY_DELAY);
    }

    #[test]
    fn sanitize_component_is_filesystem_safe() {
        assert_eq!(sanitize_component("notes.txt"), "notes.txt");
        assert_eq!(sanitize_component("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_component(""), "file");
    }

    #[test]
    fn edit_key_separates_paths_within_one_session() {
        let first = edit_key("sess", "/a/one.txt");
        assert_ne!(first, edit_key("sess", "/a/two.txt"));
        assert_eq!(first, edit_key("sess", "/a/one.txt"));
        assert_ne!(first, edit_key("sess2", "/a/one.txt"));
    }
}
