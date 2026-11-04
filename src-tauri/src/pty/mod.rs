use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};

use anyhow::{anyhow, Context};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub(crate) mod conpty_bundle;
#[cfg(test)]
mod conpty_resize_probe;

/// Larger reads keep the number of Tauri events (and therefore IPC framing
/// overhead and scheduling jitter) low during bursty output such as `help`.
const READ_BUFFER_SIZE: usize = 32 * 1024;

#[derive(Default)]
pub struct PtySessionManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    size: Mutex<PtySize>,
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

impl PtySessionManager {
    pub fn create_session(
        &self,
        app: AppHandle,
        id: String,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<String> {
        // The frontend generates the id so it can register output listeners
        // before the shell starts. Validate it and reject duplicates so an
        // event stream can never be attached to the wrong session.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(anyhow!("invalid pty session id"));
        }
        if self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?
            .contains_key(&id)
        {
            return Err(anyhow!("pty session id already exists"));
        }

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
        let child = pair
            .slave
            .spawn_command(command)
            .context("failed to spawn shell")?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone reader")?;
        let writer = pair.master.take_writer().context("failed to get writer")?;

        let event_id = id.clone();
        let closed_event_id = id.clone();
        let app_handle = app.clone();

        std::thread::spawn(move || {
            let mut buffer = [0_u8; READ_BUFFER_SIZE];
            let mut decoder = crate::text_stream::Utf8StreamDecoder::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let payload = PtyOutputPayload {
                            id: event_id.clone(),
                            data: decoder.feed(&buffer[..size]),
                        };

                        let _ = app_handle.emit(&format!("pty-output-{}", event_id), payload);
                    }
                    Err(_) => break,
                }
            }

            let _ = app_handle.emit(&format!("pty-closed-{}", closed_event_id), ());
        });

        let session = Arc::new(PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            size: Mutex::new(initial_size),
        });

        self.sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?
            .insert(id.clone(), session);

        Ok(id)
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
            writer.write_all(&data).context("failed to write pty")?;
            writer.flush().context("failed to flush pty")?;
            anyhow::Ok(())
        })
        .await
        .map_err(|err| anyhow!("failed to write pty: {err}"))?
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let Some(session) = self.session(id).ok() else {
            // The session may have already exited while a resize was in flight;
            // treat that as a no-op instead of surfacing an error to the UI.
            eprintln!("[pty] resize ignored: session {id} not found");
            return Ok(());
        };

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
        if let Err(error) = master.resize(next) {
            eprintln!("[pty] failed to resize session {id} to {cols}x{rows}: {error}");
            return Err(anyhow!("failed to resize pty: {error}"));
        }

        *size = next;
        Ok(())
    }

    pub fn close_session(&self, id: &str) -> anyhow::Result<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?
            .remove(id);

        if let Some(session) = session {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
        }

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
