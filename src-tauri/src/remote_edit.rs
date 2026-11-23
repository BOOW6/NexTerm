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
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::pin::Pin;
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
fn next_retry_delay(current: Duration, max: Duration) -> Duration {
    (current * 2).min(max)
}

type Baseline = (u64, Option<SystemTime>);

/// Timing of the watch loop; parameterized so tests can drive the real loop
/// without waiting seconds per iteration.
#[derive(Clone, Copy)]
struct WatchTiming {
    poll: Duration,
    quiet: Duration,
    max_retry: Duration,
}

const WATCH_TIMING: WatchTiming = WatchTiming {
    poll: POLL_INTERVAL,
    quiet: QUIET_PERIOD,
    max_retry: MAX_RETRY_DELAY,
};

/// Observable outcomes of one watch-loop iteration.
enum WatchEvent {
    Synced,
    Error(String),
}

#[derive(Debug, PartialEq, Eq)]
enum WatchExit {
    Cancelled,
    ScratchGone,
    SessionGone,
}

type UploadFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

/// The watcher state machine: poll the scratch copy, wait for writes to
/// settle, upload, and advance the baseline only after a completed upload.
/// Injected effects (upload, event sink, liveness probe) make the retry
/// contract testable without a live SSH session or a Tauri runtime.
async fn run_watch_loop<U, N, C>(
    scratch: &PathBuf,
    mut baseline: Baseline,
    cancel: &Arc<AtomicBool>,
    timing: WatchTiming,
    mut upload: U,
    mut notify: N,
    connection_alive: C,
) -> WatchExit
where
    U: FnMut(PathBuf) -> UploadFuture,
    N: FnMut(WatchEvent),
    C: Fn() -> bool,
{
    let mut interval = tokio::time::interval(timing.poll);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut retry_delay = timing.poll;

    loop {
        interval.tick().await;
        if cancel.load(Ordering::SeqCst) {
            return WatchExit::Cancelled;
        }
        // The scratch file is the source of truth for the watcher's lifetime:
        // once it disappears (cleanup, editor moved it) there is nothing to sync.
        let Some(current) = stat_baseline(scratch).await else {
            return WatchExit::ScratchGone;
        };
        if current == baseline {
            continue;
        }
        tokio::time::sleep(timing.quiet).await;
        if cancel.load(Ordering::SeqCst) {
            return WatchExit::Cancelled;
        }
        let Some(settled) = stat_baseline(scratch).await else {
            return WatchExit::ScratchGone;
        };
        if settled != current {
            // Still being written; the next poll sees the final state.
            continue;
        }

        if !connection_alive() {
            return WatchExit::SessionGone;
        }
        match upload(scratch.clone()).await {
            Ok(()) => {
                // Only a completed upload advances the baseline: the file
                // stays dirty across failures so a later poll retries it.
                baseline = settled;
                retry_delay = timing.poll;
                notify(WatchEvent::Synced);
            }
            Err(error) => {
                notify(WatchEvent::Error(error));
                if !connection_alive() {
                    return WatchExit::SessionGone;
                }
                // Back off so a persistent failure does not fire an error
                // event every couple of seconds; cancel is honoured between
                // attempts.
                tokio::time::sleep(retry_delay).await;
                retry_delay = next_retry_delay(retry_delay, timing.max_retry);
                if cancel.load(Ordering::SeqCst) {
                    return WatchExit::Cancelled;
                }
            }
        }
    }
}

#[derive(Default)]
pub struct RemoteEditManager {
    watchers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl RemoteEditManager {
    /// Cancel the watcher registered for `key`, if any. The entry is NOT
    /// removed here: the running task owns the scratch copy and must be able
    /// to prove ownership on exit (removing the entry up front made the task
    /// fail its ownership check, so an explicitly stopped edit leaked its
    /// scratch copy). Returns whether a watcher was signalled.
    fn stop(&self, key: &str) -> bool {
        if let Some(cancel) = self
            .watchers
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(key)
        {
            cancel.store(true, Ordering::SeqCst);
            return true;
        }
        false
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

/// Exact scratch file path for one (session, remote path). Deterministic so
/// both the open and the stop path can address the same copy.
fn scratch_path(app: &AppHandle, id: &str, remote_path: &str) -> anyhow::Result<PathBuf> {
    let file_name = remote_path
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("file");
    Ok(scratch_dir(app, id, remote_path)?.join(sanitize_component(file_name)))
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
    baseline: Baseline,
) {
    let key = edit_key(&id, &remote_path);
    let name = scratch
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());

    let upload_app = app.clone();
    let upload_id = id.clone();
    let upload_remote = remote_path.clone();
    let upload = move |path: PathBuf| -> UploadFuture {
        let app = upload_app.clone();
        let id = upload_id.clone();
        let remote = upload_remote.clone();
        Box::pin(async move {
            let ssh = app.state::<SshManager>();
            ssh.sftp_upload_and_wait(
                app.clone(),
                &id,
                path.to_string_lossy().into_owned(),
                remote,
                SftpTransferOptions {
                    recursive: false,
                    resume: false,
                    conflict: ConflictPolicy::Overwrite,
                },
            )
            .await
            .map_err(|error| error.to_string())
        })
    };

    let notify_app = app.clone();
    let notify_id = id.clone();
    let notify_remote = remote_path.clone();
    let notify = move |event: WatchEvent| match event {
        WatchEvent::Synced => {
            let _ = notify_app.emit(
                "remote-edit-synced",
                serde_json::json!({
                    "sessionId": notify_id,
                    "remotePath": notify_remote,
                    "name": name.clone(),
                }),
            );
        }
        WatchEvent::Error(error) => {
            let _ = notify_app.emit(
                "remote-edit-error",
                serde_json::json!({
                    "sessionId": notify_id,
                    "remotePath": notify_remote,
                    "name": name.clone(),
                    "error": error,
                }),
            );
        }
    };

    let alive_app = app.clone();
    let alive_id = id.clone();
    let connection_alive = move || alive_app.state::<SshManager>().has_connection(&alive_id);

    let _exit = run_watch_loop(
        &scratch,
        baseline,
        &cancel,
        WATCH_TIMING,
        upload,
        notify,
        connection_alive,
    )
    .await;

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
    let _ = edits.stop(&key);

    let sftp = ssh.open_sftp(&id).await.map_err(|err| err.to_string())?;
    let metadata = sftp
        .metadata(&remote_path)
        .await
        .map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        return Err("cannot edit a directory".to_string());
    }

    let scratch = scratch_path(&app, &id, &remote_path).map_err(|err| err.to_string())?;

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
/// A stopped watcher deletes its scratch copy on exit; when no watcher owns
/// the copy anymore (it already exited, or the pair was never opened) this
/// command removes the copy directly, so remote content never stays behind
/// in the app data dir after the edit ends.
#[tauri::command]
pub async fn remote_edit_stop(
    app: AppHandle,
    id: String,
    remote_path: String,
) -> Result<(), String> {
    let stopped = app
        .try_state::<RemoteEditManager>()
        .map(|manager| manager.stop(&edit_key(&id, &remote_path)))
        .unwrap_or(false);
    if !stopped {
        if let Ok(scratch) = scratch_path(&app, &id, &remote_path) {
            let _ = tokio::fs::remove_file(&scratch).await;
            if let Some(hash_dir) = scratch.parent() {
                let _ = tokio::fs::remove_dir(hash_dir).await;
                if let Some(session_dir) = hash_dir.parent() {
                    let _ = tokio::fs::remove_dir(session_dir).await;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn retry_backoff_doubles_up_to_the_cap() {
        let mut delay = POLL_INTERVAL;
        let mut steps = 0;
        while delay < MAX_RETRY_DELAY {
            delay = next_retry_delay(delay, MAX_RETRY_DELAY);
            steps += 1;
        }
        assert_eq!(delay, MAX_RETRY_DELAY);
        // 2s -> 4s -> 8s -> 16s -> 32s -> 60s cap: the ladder stays short.
        assert!(steps <= 5, "backoff reached the cap in {steps} steps");
        assert_eq!(
            next_retry_delay(MAX_RETRY_DELAY, MAX_RETRY_DELAY),
            MAX_RETRY_DELAY
        );
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

    #[test]
    fn stopping_a_watcher_keeps_ownership_with_the_task() {
        let manager = RemoteEditManager::default();
        let token = Arc::new(AtomicBool::new(false));
        manager
            .watchers
            .lock()
            .unwrap()
            .insert("k".to_string(), token.clone());

        // stop() only cancels; the running task stays registered so it can
        // prove ownership on exit and delete the scratch copy. Removing the
        // entry here (the old behaviour) made the task skip that cleanup and
        // leak the copy until the next startup sweep.
        assert!(manager.stop("k"));
        assert!(token.load(Ordering::SeqCst));
        assert!(manager.stop_if_current("k", &token));
        assert!(!manager.stop("k"));
    }

    #[test]
    fn a_reopened_watcher_owns_the_scratch() {
        let manager = RemoteEditManager::default();
        let old = Arc::new(AtomicBool::new(false));
        let fresh = Arc::new(AtomicBool::new(false));
        manager
            .watchers
            .lock()
            .unwrap()
            .insert("k".to_string(), old.clone());
        assert!(manager.stop("k"));
        manager
            .watchers
            .lock()
            .unwrap()
            .insert("k".to_string(), fresh.clone());

        // The old task exits later: it must not delete the new download.
        assert!(!manager.stop_if_current("k", &old));
        assert!(manager.stop_if_current("k", &fresh));
    }

    fn watch_timing() -> WatchTiming {
        WatchTiming {
            poll: Duration::from_millis(5),
            quiet: Duration::from_millis(2),
            max_retry: Duration::from_millis(10),
        }
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "condition timed out"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn a_failed_upload_stays_dirty_and_is_retried_until_success() {
        let dir = tempfile::tempdir().unwrap();
        let scratch = dir.path().join("file.txt");
        std::fs::write(&scratch, b"v1").unwrap();
        let baseline = stat_baseline(&scratch).await.unwrap();
        // A different length guarantees the change is visible even on
        // filesystems with coarse mtime granularity.
        std::fs::write(&scratch, b"version-2").unwrap();

        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_upload = attempts.clone();
        let upload = move |_path: PathBuf| -> UploadFuture {
            let attempt = attempts_upload.fetch_add(1, Ordering::SeqCst);
            let fail = attempt == 0;
            Box::pin(async move {
                if fail {
                    Err("disk full".to_string())
                } else {
                    Ok(())
                }
            })
        };
        let synced = Arc::new(AtomicUsize::new(0));
        let synced_notify = synced.clone();
        let notify = move |event: WatchEvent| {
            if matches!(event, WatchEvent::Synced) {
                synced_notify.fetch_add(1, Ordering::SeqCst);
            }
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let scratch = scratch.clone();
            let cancel = cancel.clone();
            async move {
                run_watch_loop(
                    &scratch,
                    baseline,
                    &cancel,
                    watch_timing(),
                    upload,
                    notify,
                    || true,
                )
                .await
            }
        });

        // The first real upload fails. The file stays dirty with no local
        // change in between, so the retry proves the baseline was not
        // advanced on a mere transfer id; the second attempt succeeds.
        wait_until(|| attempts.load(Ordering::SeqCst) >= 2).await;
        wait_until(|| synced.load(Ordering::SeqCst) == 1).await;

        // Success advanced the baseline: no further attempts while the file
        // stays unchanged.
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "a completed sync must not be re-uploaded"
        );

        // A fresh edit triggers exactly one more upload.
        std::fs::write(&scratch, b"version-333").unwrap();
        wait_until(|| attempts.load(Ordering::SeqCst) >= 3).await;

        cancel.store(true, Ordering::SeqCst);
        assert_eq!(task.await.unwrap(), WatchExit::Cancelled);
        assert_eq!(synced.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn losing_the_connection_ends_the_watch_without_uploading() {
        let dir = tempfile::tempdir().unwrap();
        let scratch = dir.path().join("file.txt");
        std::fs::write(&scratch, b"v1").unwrap();
        let baseline = stat_baseline(&scratch).await.unwrap();
        std::fs::write(&scratch, b"version-2").unwrap();

        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_upload = attempts.clone();
        let upload = move |_path: PathBuf| -> UploadFuture {
            attempts_upload.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let exit = tokio::time::timeout(
            Duration::from_secs(5),
            run_watch_loop(
                &scratch,
                baseline,
                &cancel,
                watch_timing(),
                upload,
                |_event| {},
                || false,
            ),
        )
        .await
        .expect("watch loop must stop when the session is gone");
        assert_eq!(exit, WatchExit::SessionGone);
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
    }
}
