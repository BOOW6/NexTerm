//! Remote file editing: download a remote file to a scratch copy, open it in
//! the user's local editor, and watch the scratch copy so every save syncs
//! back through the normal SFTP upload engine (visible in the transfer queue).
//!
//! The watcher polls size + mtime every couple of seconds instead of using a
//! file-watch crate: editors write in several chunks, so a quiet period is
//! required anyway, and polling keeps the dependency tree small. The watcher
//! stops when the session drops, the scratch file is deleted, or the app
//! exits; scratch copies live under `app_data_dir/remote-edit`.

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

use crate::ssh::{SftpTransferOptions, SshManager};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Editors save in several chunks; wait for the write to settle before
/// syncing so we never upload a half-written file.
const QUIET_PERIOD: Duration = Duration::from_millis(1500);

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
    fn stop_if_current(&self, key: &str, cancel: &Arc<AtomicBool>) {
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
        .map_err(|_| anyhow!("无法确定应用数据目录"))?
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
        baseline = settled;

        let ssh = app.state::<SshManager>();
        if !ssh.has_connection(&id) {
            break;
        }
        let options = SftpTransferOptions {
            recursive: false,
            resume: false,
            conflict: "overwrite".to_string(),
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
            }
        }
    }

    if let Some(manager) = app.try_state::<RemoteEditManager>() {
        manager.stop_if_current(&key, &cancel);
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
        return Err("远程路径为空".to_string());
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
        return Err("不能编辑目录".to_string());
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
        .insert(key, cancel.clone());

    let baseline = stat_baseline(&scratch)
        .await
        .ok_or_else(|| "临时文件创建失败".to_string())?;
    tokio::spawn(watch_task(
        app.clone(),
        id.clone(),
        remote_path.clone(),
        scratch.clone(),
        cancel,
        baseline,
    ));

    Ok(RemoteEditSession {
        temp_path: scratch.to_string_lossy().into_owned(),
        size,
    })
}

/// Stop watching a file (also used when the caller knows the edit is done).
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
