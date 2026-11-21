//! Minimal serial-port sessions: one port per session, a blocking read
//! thread decoding through the shared UTF-8 pipeline, and events mirroring
//! the Telnet transport (`serial-output-{id}` / `serial-closed-{id}`).
//!
//! Disconnecting drops the port handles, which unblocks the reader and makes
//! it emit the closed event itself — exactly one close path.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use anyhow::{anyhow, Context};
use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, StopBits};
use tauri::{AppHandle, Emitter};

use crate::log_sink::LogSink;

/// Reader poll interval; short enough to feel responsive to the close flag,
/// long enough to keep idle CPU negligible.
const READ_TIMEOUT: Duration = Duration::from_millis(100);
const READ_BUFFER: usize = 4 * 1024;

#[derive(Default)]
pub struct SerialSessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SerialSession>>>>,
}

pub struct SerialSession {
    port: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    log: Arc<LogSink>,
    closed: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Serialize)]
struct SerialOutputPayload {
    id: String,
    data: String,
}

/// Why a session ended: `closed` (the user disconnected), `eof`, or `error`
/// (the device was unplugged / the driver failed). Without the reason the UI
/// cannot tell a deliberate close from an adapter that vanished.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialClosedPayload {
    reason: &'static str,
    message: Option<String>,
}

fn validate_session_id(id: &str) -> anyhow::Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(anyhow!("invalid serial session id"));
    }
    Ok(())
}

// --- configuration parsing (pure, unit-tested) ---

pub(crate) fn parse_data_bits(value: &str) -> DataBits {
    match value {
        "five" => DataBits::Five,
        "six" => DataBits::Six,
        "seven" => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

pub(crate) fn parse_parity(value: &str) -> Parity {
    match value {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    }
}

pub(crate) fn parse_stop_bits(value: &str) -> StopBits {
    match value {
        "two" => StopBits::Two,
        _ => StopBits::One,
    }
}

pub(crate) fn parse_flow_control(value: &str) -> FlowControl {
    match value {
        "software" => FlowControl::Software,
        "hardware" => FlowControl::Hardware,
        _ => FlowControl::None,
    }
}

impl SerialSessionManager {
    pub async fn list_ports(&self) -> anyhow::Result<Vec<SerialPortInfo>> {
        // USB enumeration can block briefly; keep it off the async workers.
        tokio::task::spawn_blocking(|| {
            Ok(serialport::available_ports()?
                .into_iter()
                .map(|info| SerialPortInfo {
                    name: info.port_name,
                    kind: match info.port_type {
                        serialport::SerialPortType::UsbPort(usb) => {
                            format!("USB {}:{}", usb.vid, usb.pid)
                        }
                        serialport::SerialPortType::BluetoothPort => "Bluetooth".to_string(),
                        serialport::SerialPortType::PciPort => "PCI".to_string(),
                        _ => "Native".to_string(),
                    },
                })
                .collect())
        })
        .await
        .map_err(|err| anyhow!("failed to enumerate serial ports: {err}"))?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        &self,
        app: AppHandle,
        id: String,
        port_name: String,
        baud: u32,
        data_bits: String,
        parity: String,
        stop_bits: String,
        flow_control: String,
        log_path: Option<String>,
    ) -> anyhow::Result<String> {
        validate_session_id(&id)?;
        if port_name.trim().is_empty() {
            return Err(anyhow!("串口名称为空"));
        }

        let log = Arc::new(LogSink::new(log_path.as_deref()));
        let session = Arc::new(SerialSession {
            port: Mutex::new(None),
            log,
            closed: Arc::new(AtomicBool::new(false)),
        });
        {
            let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            if sessions.contains_key(&id) {
                return Err(anyhow!("serial session id already exists"));
            }
            sessions.insert(id.clone(), session.clone());
        }

        // Open + configure off the async runtime.
        let open_result = tokio::task::spawn_blocking(move || {
            serialport::new(&port_name, baud.max(50))
                .data_bits(parse_data_bits(&data_bits))
                .parity(parse_parity(&parity))
                .stop_bits(parse_stop_bits(&stop_bits))
                .flow_control(parse_flow_control(&flow_control))
                .timeout(READ_TIMEOUT)
                .open()
                .context("failed to open serial port")
        })
        .await
        .map_err(|err| {
            // The blocking task panicked or was cancelled before the open
            // result arrived: roll the reservation back so the id stays
            // usable, same as the open-failure path below.
            self.sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            anyhow!("failed to open serial port: {err}")
        })?;

        let port = match open_result {
            Ok(port) => port,
            Err(error) => {
                // Roll the reservation back so the id stays usable.
                self.sessions
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                return Err(error);
            }
        };

        let write_handle = port.try_clone().map_err(|error| {
            // Roll the reservation back so the id stays usable: without it a
            // half-open session would squat the id and the port forever.
            self.sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            anyhow::Error::new(error).context("failed to clone serial port handle")
        })?;
        *session.port.lock().unwrap_or_else(|p| p.into_inner()) = Some(write_handle);

        let sessions = Arc::clone(&self.sessions);
        let event_id = id.clone();
        let app_handle = app.clone();
        let read_log = Arc::clone(&session.log);
        let read_closed = Arc::clone(&session.closed);
        let read_session = Arc::clone(&session);
        std::thread::spawn(move || {
            let mut port = port;
            let mut decoder = crate::text_stream::Utf8StreamDecoder::new();
            let mut buffer = [0u8; READ_BUFFER];
            let mut close_reason: &'static str = "closed";
            let mut close_message: Option<String> = None;
            loop {
                if read_closed.load(Ordering::SeqCst) {
                    break;
                }
                match port.read(&mut buffer) {
                    Ok(0) => continue,
                    Ok(size) => {
                        let decoded = decoder.feed(&buffer[..size]);
                        if decoded.is_empty() {
                            continue;
                        }
                        read_log.write(&decoded);
                        let payload = SerialOutputPayload {
                            id: event_id.clone(),
                            data: decoded,
                        };
                        let _ = app_handle.emit(&format!("serial-output-{}", event_id), payload);
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::TimedOut
                            || error.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        continue;
                    }
                    // The read only fails after the user disconnected (the
                    // handle was dropped, so `closed` is already set) when the
                    // device went away: report that distinct reason.
                    Err(error) => {
                        if !read_closed.load(Ordering::SeqCst) {
                            close_reason = "error";
                            close_message = Some(error.to_string());
                        }
                        break;
                    }
                }
            }
            let _ = app_handle.emit(
                &format!("serial-closed-{}", event_id),
                SerialClosedPayload {
                    reason: close_reason,
                    message: close_message,
                },
            );
            // Only remove our own entry: the id may already have been
            // recycled by a newer session.
            let mut sessions = sessions.lock().unwrap_or_else(|p| p.into_inner());
            if sessions
                .get(&event_id)
                .map(|current| Arc::ptr_eq(current, &read_session))
                .unwrap_or(false)
            {
                sessions.remove(&event_id);
            }
        });

        Ok(id)
    }

    pub async fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let session = self.session(id)?;
        let data = data.to_vec();
        // A serial device with flow control (or one that stopped reading) can
        // block `write_all` until the driver timeout; keep that off the async
        // workers, exactly like the PTY writer.
        tokio::task::spawn_blocking(move || {
            let mut guard = session.port.lock().unwrap_or_else(|p| p.into_inner());
            let port = guard
                .as_mut()
                .ok_or_else(|| anyhow!("serial session closed"))?;
            port.write_all(&data)
                .context("failed to write serial data")?;
            port.flush().context("failed to flush serial data")?;
            anyhow::Ok(())
        })
        .await
        .map_err(|err| anyhow!("failed to write serial data: {err}"))?
    }

    pub fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> anyhow::Result<()> {
        // Serial has no window-size negotiation; resize is a no-op (Telnet parity).
        Ok(())
    }

    pub async fn disconnect(&self, id: &str) -> anyhow::Result<()> {
        let session = self.session(id)?;
        session.closed.store(true, Ordering::SeqCst);
        *session.port.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
        Ok(())
    }

    pub fn set_log(&self, id: &str, path: Option<&str>) -> anyhow::Result<()> {
        let session = self.session(id)?;
        session.log.set_path(path);
        Ok(())
    }

    fn session(&self, id: &str) -> anyhow::Result<Arc<SerialSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("serial session not found"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_bits_parse_with_default() {
        assert!(matches!(parse_data_bits("five"), DataBits::Five));
        assert!(matches!(parse_data_bits("seven"), DataBits::Seven));
        assert!(matches!(parse_data_bits("eight"), DataBits::Eight));
        assert!(matches!(parse_data_bits("nonsense"), DataBits::Eight));
        assert!(matches!(parse_data_bits(""), DataBits::Eight));
    }

    #[test]
    fn parity_parse_with_default() {
        assert!(matches!(parse_parity("odd"), Parity::Odd));
        assert!(matches!(parse_parity("even"), Parity::Even));
        assert!(matches!(parse_parity("none"), Parity::None));
        assert!(matches!(parse_parity("nonsense"), Parity::None));
    }

    #[test]
    fn stop_bits_parse_with_default() {
        assert!(matches!(parse_stop_bits("two"), StopBits::Two));
        assert!(matches!(parse_stop_bits("one"), StopBits::One));
        assert!(matches!(parse_stop_bits("nonsense"), StopBits::One));
    }

    #[test]
    fn flow_control_parse_with_default() {
        assert!(matches!(
            parse_flow_control("software"),
            FlowControl::Software
        ));
        assert!(matches!(
            parse_flow_control("hardware"),
            FlowControl::Hardware
        ));
        assert!(matches!(parse_flow_control("none"), FlowControl::None));
        assert!(matches!(parse_flow_control("nonsense"), FlowControl::None));
    }

    #[test]
    fn rejects_invalid_session_ids() {
        assert!(validate_session_id("ok-ID-1").is_ok());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("bad/id").is_err());
        assert!(validate_session_id("bad id").is_err());
    }
}
