use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};

use anyhow::{anyhow, Context};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Default)]
pub struct PtySessionManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    _child: Box<dyn Child + Send>,
}

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

impl PtySessionManager {
    pub fn create_session(&self, app: AppHandle, cols: u16, rows: u16) -> anyhow::Result<String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
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

        let mut reader = pair.master.try_clone_reader().context("failed to clone reader")?;
        let writer = pair.master.take_writer().context("failed to get writer")?;

        let id = Uuid::new_v4().to_string();
        let event_id = id.clone();
        let app_handle = app.clone();

        std::thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let payload = PtyOutputPayload {
                            id: event_id.clone(),
                            data: String::from_utf8_lossy(&buffer[..size]).to_string(),
                        };

                        let _ = app_handle.emit(format!("pty-output-{}", event_id), payload.clone());
                        let _ = app_handle.emit("pty-output", payload);
                    }
                    Err(_) => break,
                }
            }
        });

        self.sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?
            .insert(
                id.clone(),
                PtySession {
                    master: pair.master,
                    writer,
                    _child: child,
                },
            );

        Ok(id)
    }

    pub fn write_session(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("pty session not found"))?;
        session.writer.write_all(data).context("failed to write pty")?;
        session.writer.flush().context("failed to flush pty")?;
        Ok(())
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock session map"))?;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("pty session not found"))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize pty")?;
        Ok(())
    }
}
