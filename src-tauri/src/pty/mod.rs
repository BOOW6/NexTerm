use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use anyhow::{anyhow, Context};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::log_sink::LogSink;

pub(crate) mod conpty_bundle;
#[cfg(test)]
mod conpty_resize_probe;

/// Larger reads keep the number of Tauri events (and therefore IPC framing
/// overhead and scheduling jitter) low during bursty output such as `help`.
const READ_BUFFER_SIZE: usize = 32 * 1024;

/// ConPTY sizes travel through `COORD` (`i16`) and a 0x0 pty is an invalid
/// Win32 parameter; clamp instead of passing hostile or degenerate values on.
const MIN_TERMINAL_COLS: u16 = 2;
const MAX_TERMINAL_COLS: u16 = 1000;
const MIN_TERMINAL_ROWS: u16 = 2;
const MAX_TERMINAL_ROWS: u16 = 1000;

type SessionMap = Arc<Mutex<HashMap<String, Arc<PtySession>>>>;

#[derive(Default)]
pub struct PtySessionManager {
    sessions: SessionMap,
}

struct PtySession {
    /// `None` once the session has been finalized; dropping the master is
    /// what closes the ConPTY (Windows) or the pty master fd (Unix).
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    /// Signal handle for the child, split from the child itself so
    /// `close_session` can kill while the watcher thread is blocked in
    /// `wait()`.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    size: Mutex<PtySize>,
    /// Session output log shared with the read thread; dropping the session
    /// closes the file.
    log: Arc<LogSink>,
    /// Guard so the reader-EOF path and the child-exit watcher finalize the
    /// session exactly once.
    closed: AtomicBool,
}

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyPlatformInfo {
    backend: Option<&'static str>,
    build_number: Option<u32>,
}

fn validate_session_id(id: &str) -> anyhow::Result<()> {
    // The frontend generates the id so it can register output listeners
    // before the shell starts. Validate it so an event stream can never be
    // attached to the wrong session.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(anyhow!("invalid pty session id"));
    }
    Ok(())
}

fn clamp_terminal_size(cols: u16, rows: u16) -> (u16, u16) {
    (
        cols.clamp(MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
        rows.clamp(MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
    )
}

impl PtySessionManager {
    pub async fn create_session(
        &self,
        app: AppHandle,
        id: String,
        cols: u16,
        rows: u16,
        log_path: Option<String>,
    ) -> anyhow::Result<String> {
        let sessions = self.sessions.clone();
        // openpty + spawn shell are blocking calls; keep them off the async
        // runtime workers.
        tokio::task::spawn_blocking(move || {
            create_session_blocking(&sessions, app, id, cols, rows, log_path)
        })
        .await
        .map_err(|err| anyhow!("failed to create pty session: {err}"))?
    }

    pub async fn write_session(&self, id: &str, data: Vec<u8>) -> anyhow::Result<()> {
        // Clone the Arc out of the map so the global session map lock is not
        // held while a potentially blocking PTY write is in flight, and run
        // the write on the blocking pool: a shell that stops consuming stdin
        // fills the pipe and would otherwise stall the IPC main thread.
        let session = self.session(id)?;
        tokio::task::spawn_blocking(move || {
            let mut writer = session
                .writer
                .lock()
                .map_err(|_| anyhow!("failed to lock pty writer"))?;
            let writer = writer
                .as_mut()
                .ok_or_else(|| anyhow!("pty session is closed"))?;
            writer.write_all(&data).context("failed to write pty")?;
            writer.flush().context("failed to flush pty")?;
            anyhow::Ok(())
        })
        .await
        .map_err(|err| anyhow!("failed to write pty: {err}"))?
    }

    pub async fn resize_session(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let sessions = self.sessions.clone();
        let id = id.to_string();
        // ResizePseudoConsole synchronizes with conhost and can block; keep
        // it off the async runtime workers.
        tokio::task::spawn_blocking(move || resize_session_blocking(&sessions, &id, cols, rows))
            .await
            .map_err(|err| anyhow!("failed to resize pty: {err}"))?
    }

    pub async fn close_session(&self, id: &str) -> anyhow::Result<()> {
        let sessions = self.sessions.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || close_session_blocking(&sessions, &id))
            .await
            .map_err(|err| anyhow!("failed to close pty session: {err}"))?
    }

    /// Re-point the session's output log mid-flight. Called when the user
    /// toggles session logging while the shell is already running.
    pub async fn set_log(&self, id: &str, path: Option<&str>) -> anyhow::Result<()> {
        let session = self.session(id)?;
        let path = path.map(str::to_string);
        tokio::task::spawn_blocking(move || {
            session.log.set_path(path.as_deref());
        })
        .await
        .map_err(|err| anyhow!("failed to set pty session log: {err}"))?;
        Ok(())
    }

    pub fn platform_info(&self) -> PtyPlatformInfo {
        #[cfg(windows)]
        {
            PtyPlatformInfo {
                backend: Some("conpty"),
                build_number: conpty_bundle::reported_build_number(windows_build_number()),
            }
        }

        #[cfg(not(windows))]
        {
            PtyPlatformInfo {
                backend: None,
                build_number: None,
            }
        }
    }

    fn session(&self, id: &str) -> anyhow::Result<Arc<PtySession>> {
        self.sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("pty session not found"))
    }
}

fn create_session_blocking(
    sessions: &SessionMap,
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
    log_path: Option<String>,
) -> anyhow::Result<String> {
    validate_session_id(&id)?;
    let (cols, rows) = clamp_terminal_size(cols, rows);

    let pty_system = native_pty_system();
    let initial_size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(initial_size)
        .context("failed to open pty")?;

    let shell = if cfg!(windows) {
        "cmd.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    };

    let command = CommandBuilder::new(shell);
    let mut child = pair
        .slave
        .spawn_command(command)
        .context("failed to spawn shell")?;
    let killer = child.clone_killer();

    // If anything fails after the shell was spawned, kill and reap it instead
    // of leaving an orphan (and, on Unix, a zombie) behind.
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.context("failed to clone reader"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.context("failed to get writer"));
        }
    };

    let log = Arc::new(LogSink::new(log_path.as_deref()));
    let read_log = log.clone();
    let session = Arc::new(PtySession {
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(killer),
        size: Mutex::new(initial_size),
        log,
        closed: AtomicBool::new(false),
    });

    // Register before spawning the reader/watcher threads so a session that
    // loses a create race never emits events or removes entries for an id
    // owned by the winner. Holding the map lock across this check+insert
    // closes the old check-then-spawn-then-insert TOCTOU window.
    {
        let mut sessions = sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?;
        if sessions.contains_key(&id) {
            drop(sessions);
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("pty session id already exists"));
        }
        sessions.insert(id.clone(), session.clone());
    }

    let read_app = app.clone();
    let read_id = id.clone();
    let read_session = session.clone();
    let read_sessions = sessions.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; READ_BUFFER_SIZE];
        let mut decoder = crate::text_stream::Utf8StreamDecoder::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let decoded = decoder.feed(&buffer[..size]);
                    read_log.write(&decoded);
                    let payload = PtyOutputPayload {
                        id: read_id.clone(),
                        data: decoded,
                    };

                    let _ = read_app.emit(&format!("pty-output-{}", read_id), payload);
                }
                Err(_) => break,
            }
        }

        // Unix: EOF means every slave fd is closed. Finalize right away so
        // the entry is reclaimed even if the watcher's wait() has not
        // returned yet (finalize is idempotent).
        finalize_pty_session(&read_session, &read_id, &read_sessions, &read_app);
    });

    let watch_app = app.clone();
    let watch_id = id.clone();
    let watch_sessions = sessions.clone();
    std::thread::spawn(move || {
        // The single place where the child is reaped: on Unix this prevents
        // zombies; on Windows ConPTY pipes never report EOF when the client
        // exits, so this wait() is what detects the exit at all. Once it
        // returns, dropping the master is what unblocks the reader thread.
        let _ = child.wait();
        finalize_pty_session(&session, &watch_id, &watch_sessions, &watch_app);
    });

    Ok(id)
}

/// Idempotent teardown shared by the reader-EOF path, the child-exit watcher
/// and (indirectly, via its own take-drops) close_session.
fn finalize_pty_session(
    session: &Arc<PtySession>,
    id: &str,
    sessions: &SessionMap,
    app: &AppHandle,
) {
    if session.closed.swap(true, Ordering::SeqCst) {
        return;
    }

    if let Ok(mut master) = session.master.lock() {
        *master = None;
    }
    if let Ok(mut writer) = session.writer.lock() {
        *writer = None;
    }

    // Only remove our own entry: the id may already have been recycled by a
    // newer session.
    if let Ok(mut sessions) = sessions.lock() {
        if sessions
            .get(id)
            .map(|current| Arc::ptr_eq(current, session))
            .unwrap_or(false)
        {
            sessions.remove(id);
        }
    }

    let _ = app.emit(&format!("pty-closed-{id}"), ());
}

fn resize_session_blocking(
    sessions: &SessionMap,
    id: &str,
    cols: u16,
    rows: u16,
) -> anyhow::Result<()> {
    let session = {
        let sessions = sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?;
        match sessions.get(id).cloned() {
            Some(session) => session,
            None => {
                // The session may have already exited while a resize was in
                // flight; treat that as a no-op instead of surfacing an error
                // to the UI.
                eprintln!("[pty] resize ignored: session {id} not found");
                return Ok(());
            }
        }
    };

    let (cols, rows) = clamp_terminal_size(cols, rows);

    // Hold the size lock across the resize so concurrent requests are
    // applied in order and the final size always matches the last caller.
    // Only this session is blocked; writes and other sessions keep running.
    let mut size = session
        .size
        .lock()
        .map_err(|_| anyhow!("failed to lock pty size"))?;
    if size.cols == cols && size.rows == rows {
        return Ok(());
    }

    let next = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let master = session
        .master
        .lock()
        .map_err(|_| anyhow!("failed to lock pty master"))?;
    let Some(master) = master.as_ref() else {
        eprintln!("[pty] resize ignored: session {id} already closed");
        return Ok(());
    };
    if let Err(error) = master.resize(next) {
        eprintln!("[pty] failed to resize session {id} to {cols}x{rows}: {error}");
        return Err(anyhow!("failed to resize pty: {error}"));
    }

    *size = next;
    Ok(())
}

fn close_session_blocking(sessions: &SessionMap, id: &str) -> anyhow::Result<()> {
    let session = sessions
        .lock()
        .map_err(|_| anyhow!("failed to lock session map"))?
        .remove(id);

    if let Some(session) = session {
        // kill() through the split killer handle: the child itself is owned
        // by the watcher thread, which is possibly blocked in wait().
        if let Ok(mut killer) = session.killer.lock() {
            let _ = killer.kill();
        }
        // Dropping the master closes the ConPTY (Windows) or the master fd
        // (Unix); the watcher's wait() then completes and finishes cleanup
        // (reap + pty-closed event).
        if let Ok(mut master) = session.master.lock() {
            *master = None;
        }
        if let Ok(mut writer) = session.writer.lock() {
            *writer = None;
        }
    }

    Ok(())
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };

    // GetVersionExW lies unless the executable is manifested for the current
    // Windows version; RtlGetVersion always reports the real build number.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status.0 >= 0 {
        Some(info.dwBuildNumber)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_session_ids() {
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("has space").is_err());
        assert!(validate_session_id("slash/dot").is_err());
        assert!(validate_session_id("emoji🎉").is_err());
        assert!(validate_session_id("ok-ID-123").is_ok());
    }

    #[test]
    fn clamps_terminal_sizes_into_conpty_safe_range() {
        assert_eq!(clamp_terminal_size(80, 24), (80, 24));
        assert_eq!(
            clamp_terminal_size(0, 0),
            (MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS)
        );
        assert_eq!(
            clamp_terminal_size(65535, 65535),
            (MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS)
        );
        assert_eq!(clamp_terminal_size(1, 1), (2, 2));
    }
}
