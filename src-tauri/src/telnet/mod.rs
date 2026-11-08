//! Minimal Telnet transport (RFC 854) for plain-text hosts and BBSes.
//!
//! The client refuses every option negotiation, keeping the stream a
//! transparent 8-bit NVT channel, and feeds the payload to the same decoded
//! event/log pipeline as the PTY and SSH transports.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, Context};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

use crate::log_sink::LogSink;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

/// A negotiation may legally split across TCP reads; a peer streaming an
/// unterminated subnegotiation must not grow the carry buffer unboundedly.
const MAX_PENDING_ESCAPE_BYTES: usize = 16 * 1024;

type SharedWriter = Arc<tokio::sync::Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>>;

/// Remove `session` from `sessions` only when the entry still points at that
/// exact session — a recycled id must never be torn down by a stale closer.
fn remove_reserved_session(
    sessions: &Mutex<HashMap<String, Arc<TelnetSession>>>,
    id: &str,
    session: &Arc<TelnetSession>,
) {
    let mut sessions = sessions.lock().unwrap_or_else(|poison| poison.into_inner());
    if sessions
        .get(id)
        .map(|current| Arc::ptr_eq(current, session))
        .unwrap_or(false)
    {
        sessions.remove(id);
    }
}

#[derive(Default)]
pub struct TelnetSessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TelnetSession>>>>,
}

struct TelnetSession {
    writer: SharedWriter,
    log: Arc<LogSink>,
    /// Signalled by `disconnect` to break the read loop out of its blocking
    /// read: a peer that keeps sending after our write half shuts down must
    /// not keep `telnet-output-{id}` events flowing for a closed session.
    close_signal: Arc<tokio::sync::Notify>,
}

#[derive(Clone, Serialize)]
struct TelnetOutputPayload {
    id: String,
    data: String,
}

/// Decode one buffer of Telnet data: returns the displayable payload bytes
/// plus, appended to `responses`, the refusal answers for every negotiation
/// command found. Returns the number of input bytes consumed; a trailing
/// incomplete escape (command or subnegotiation split across reads) is left
/// unconsumed so the caller can carry it over.
pub fn decode_telnet(input: &[u8], responses: &mut Vec<u8>) -> (Vec<u8>, usize) {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;

    while i < input.len() {
        let byte = input[i];
        if byte != IAC {
            out.push(byte);
            i += 1;
            continue;
        }

        let Some(command) = input.get(i + 1).copied() else {
            break; // lone trailing IAC: incomplete
        };
        match command {
            // Escaped 0xFF data byte.
            IAC => {
                out.push(IAC);
                i += 2;
            }
            // DO/DONT/WILL/WONT + option: refuse everything so no further
            // subnegotiations are expected on this connection.
            DO | DONT | WILL | WONT => {
                let Some(option) = input.get(i + 2).copied() else {
                    break;
                };
                // RFC 854: answer an offer (WILL) with a refusal (DONT),
                // answer a request (DO) or a demand (DONT) with WONT, and
                // stay silent on WONT — the peer only announced that it will
                // not enable the option; answering it is protocol noise that
                // strict peers treat as an error.
                match command {
                    WILL => responses.extend_from_slice(&[IAC, DONT, option]),
                    DO | DONT => responses.extend_from_slice(&[IAC, WONT, option]),
                    _ => {}
                }
                i += 3;
            }
            SB => {
                // Skip the subnegotiation body to its IAC SE (0xFF bytes
                // inside are escaped data).
                let mut j = i + 2;
                let mut closed = false;
                while j < input.len() {
                    if input[j] == IAC {
                        match input.get(j + 1) {
                            Some(&SE) => {
                                closed = true;
                                j += 2;
                                break;
                            }
                            Some(&IAC) => {
                                j += 2;
                                continue;
                            }
                            Some(_) => {
                                // Protocol violation: RFC 854 only allows
                                // IAC SE or IAC IAC inside a subnegotiation.
                                // Skip the pair and keep scanning instead of
                                // stalling the stream on unterminated garbage.
                                j += 2;
                                continue;
                            }
                            None => break,
                        }
                    }
                    j += 1;
                }
                if !closed {
                    break;
                }
                i = j;
            }
            // Two-byte commands (NOP, AYT, ...) are consumed and ignored.
            _ => {
                i += 2;
            }
        }
    }

    (out, i)
}

impl TelnetSessionManager {
    pub async fn connect(
        &self,
        app: AppHandle,
        id: String,
        host: String,
        port: u16,
        log_path: Option<String>,
    ) -> anyhow::Result<String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(anyhow!("invalid telnet session id"));
        }

        // Reserve the id before the (up to 8s) TCP connect so a concurrent
        // duplicate create is rejected outright instead of racing the insert;
        // on connect failure the reservation is removed again (by identity).
        let log = Arc::new(LogSink::new(log_path.as_deref()));
        let close_signal = Arc::new(tokio::sync::Notify::new());
        let session = Arc::new(TelnetSession {
            writer: Arc::new(tokio::sync::Mutex::new(None)),
            log,
            close_signal,
        });
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if sessions.contains_key(&id) {
                return Err(anyhow!("telnet session id already exists"));
            }
            sessions.insert(id.clone(), session.clone());
        }

        let sessions = Arc::clone(&self.sessions);

        let stream = match tokio::time::timeout(
            Duration::from_secs(8),
            TcpStream::connect((host.as_str(), port)),
        )
        .await
        {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => {
                remove_reserved_session(&sessions, &id, &session);
                return Err(error).with_context(|| format!("failed to connect to {host}:{port}"));
            }
            Err(_) => {
                remove_reserved_session(&sessions, &id, &session);
                return Err(anyhow!("连接超时：{host}:{port}"));
            }
        };

        let (mut read_half, write_half) = stream.into_split();
        *session.writer.lock().await = Some(write_half);

        let event_id = id.clone();
        let app_handle = app.clone();
        let read_writer = Arc::clone(&session.writer);
        let read_log = Arc::clone(&session.log);
        let read_close = Arc::clone(&session.close_signal);
        let read_session = Arc::clone(&session);
        tokio::spawn(async move {
            let mut buffer = [0_u8; 32 * 1024];
            let mut pending: Vec<u8> = Vec::new();
            let mut decoder = crate::text_stream::Utf8StreamDecoder::new();
            loop {
                let read = tokio::select! {
                    _ = read_close.notified() => break,
                    read = read_half.read(&mut buffer) => read,
                };
                match read {
                    Ok(0) => break,
                    Ok(size) => {
                        pending.extend_from_slice(&buffer[..size]);
                        let mut responses = Vec::new();
                        let (raw, consumed) = decode_telnet(&pending, &mut responses);
                        pending.drain(..consumed);
                        if pending.len() > MAX_PENDING_ESCAPE_BYTES {
                            // A peer must never split commands this far; drop
                            // the garbage instead of growing the buffer.
                            eprintln!("[telnet] {event_id}: dropping {0} bytes of unterminated escape garbage", pending.len());
                            pending.clear();
                        }
                        if !responses.is_empty() {
                            if let Some(writer) = read_writer.lock().await.as_mut() {
                                let _ = writer.write_all(&responses).await;
                                let _ = writer.flush().await;
                            }
                        }
                        let decoded = decoder.feed(&raw);
                        // LogSink performs synchronous file IO; keep it off
                        // the async runtime worker (order preserved by the
                        // await).
                        tokio::task::spawn_blocking({
                            let log = Arc::clone(&read_log);
                            let decoded = decoded.clone();
                            move || log.write(&decoded)
                        })
                        .await
                        .ok();
                        let payload = TelnetOutputPayload {
                            id: event_id.clone(),
                            data: decoded,
                        };
                        let _ = app_handle.emit(&format!("telnet-output-{}", event_id), payload);
                    }
                    Err(_) => break,
                }
            }

            let _ = app_handle.emit(&format!("telnet-closed-{}", event_id), ());
            // Only remove our own entry: the id may already have been
            // recycled by a newer session.
            remove_reserved_session(&sessions, &event_id, &read_session);
        });

        Ok(id)
    }

    pub async fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let session = self.session(id)?;
        let mut guard = session.writer.lock().await;
        let writer = guard
            .as_mut()
            .ok_or_else(|| anyhow!("telnet session closed"))?;
        writer
            .write_all(data)
            .await
            .context("failed to write telnet data")?;
        writer
            .flush()
            .await
            .context("failed to flush telnet data")?;
        Ok(())
    }

    /// Every negotiation is refused, so there is no negotiated window size
    /// to update; kept as a no-op for UI symmetry with the other transports.
    pub fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> anyhow::Result<()> {
        Ok(())
    }

    pub async fn disconnect(&self, id: &str) -> anyhow::Result<()> {
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(id);
        if let Some(session) = session {
            // Shut the write half down (FIN) and break the read loop out of
            // its blocking read: a peer that keeps sending after our FIN
            // must not keep a session the user closed alive.
            session.writer.lock().await.take();
            session.close_signal.notify_one();
        }
        Ok(())
    }

    pub fn set_log(&self, id: &str, path: Option<&str>) -> anyhow::Result<()> {
        let session = self.session(id)?;
        session.log.set_path(path);
        Ok(())
    }

    fn session(&self, id: &str) -> anyhow::Result<Arc<TelnetSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("telnet session not found"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(input: &[u8]) -> (Vec<u8>, Vec<u8>, usize) {
        let mut responses = Vec::new();
        let (out, consumed) = decode_telnet(input, &mut responses);
        (out, responses, consumed)
    }

    #[test]
    fn passes_plain_payload_through() {
        let (out, responses, consumed) = decode(b"login: ");
        assert_eq!(out, b"login: ");
        assert!(responses.is_empty());
        assert_eq!(consumed, 7);
    }

    #[test]
    fn negotiation_responses_follow_rfc_854_directions() {
        // IAC DO ECHO(1) -> IAC WONT 1; IAC WILL SUPPRESS-GO-AHEAD(3) -> IAC DONT 3
        let (out, responses, consumed) = decode(&[IAC, DO, 1, b'x', IAC, WILL, 3]);
        assert_eq!(out, b"x");
        assert_eq!(responses, vec![IAC, WONT, 1, IAC, DONT, 3]);
        assert_eq!(consumed, 7);
    }

    #[test]
    fn wont_is_not_answered_and_dont_is_confirmed_with_wont() {
        // IAC WONT TTYPE(24): the peer only announced a refusal — no answer.
        // IAC DONT ECHO(1): confirm with WONT.
        let (out, responses, consumed) = decode(&[b'x', IAC, WONT, 24, b'y', IAC, DONT, 1]);
        assert_eq!(out, b"xy");
        assert_eq!(responses, vec![IAC, WONT, 1]);
        assert_eq!(consumed, 8);
    }

    #[test]
    fn unescapes_iac_data_bytes_and_skips_subnegotiations() {
        // IAC IAC is a literal 0xFF; an NAWS-style subnegotiation is skipped.
        let (out, responses, consumed) =
            decode(&[b'a', IAC, IAC, IAC, SB, 31, 0, 80, 0, 24, IAC, SE, b'b']);
        assert_eq!(out, &[b'a', 255, b'b']);
        assert!(responses.is_empty());
        assert_eq!(consumed, 13);
    }

    #[test]
    fn keeps_incomplete_trailing_escape_unconsumed() {
        let (out, _responses, consumed) = decode(&[b'x', IAC, DO]);
        assert_eq!(out, b"x");
        assert_eq!(consumed, 1);

        let (_out, _responses, consumed) = decode(&[IAC, SB, 31, 1]);
        assert_eq!(consumed, 0);
    }

    #[test]
    fn recovers_from_illegal_iac_inside_subnegotiation() {
        // IAC SB 31 IAC <junk> 1 IAC SE: the violating pair is skipped and the
        // subnegotiation still closes cleanly instead of stalling the stream.
        let (out, responses, consumed) = decode(&[b'a', IAC, SB, 31, IAC, 200, 1, IAC, SE, b'b']);
        assert_eq!(out, b"ab");
        assert!(responses.is_empty());
        assert_eq!(consumed, 10);
    }
}
