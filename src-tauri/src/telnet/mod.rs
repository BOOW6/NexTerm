//! Minimal Telnet transport (RFC 854) for plain-text hosts and BBSes.
//!
//! Options are refused by default; only the handful that real telnetd and
//! console servers rely on are accepted: ECHO and SUPPRESS-GO-AHEAD (server
//! side), NAWS (window size), and TERMINAL-TYPE (answers `VT100`). The
//! displayable payload still feeds the same decoded event/log pipeline as the
//! PTY and SSH transports.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
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

const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;
const TTYPE_NAME: &[u8] = b"VT100";

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// A negotiation may legally split across TCP reads; a peer streaming an
/// unterminated subnegotiation must not grow the carry buffer unboundedly.
const MAX_PENDING_ESCAPE_BYTES: usize = 16 * 1024;

type SharedWriter = Arc<tokio::sync::Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>>;

/// `IAC SB NAWS <cols hi> <cols lo> <rows hi> <rows lo> IAC SE`.
pub fn encode_naws(cols: u16, rows: u16) -> Vec<u8> {
    let cols = cols.max(1).to_be_bytes();
    let rows = rows.max(1).to_be_bytes();
    vec![
        IAC, SB, OPT_NAWS, cols[0], cols[1], rows[0], rows[1], IAC, SE,
    ]
}

fn encode_ttype_is() -> Vec<u8> {
    let mut out = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
    out.extend_from_slice(TTYPE_NAME);
    out.extend_from_slice(&[IAC, SE]);
    out
}

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
    /// Latest client grid; echoed to peers that negotiate NAWS.
    size: Mutex<(u16, u16)>,
    /// Set once the peer accepted NAWS: SB NAWS updates are only legal after
    /// negotiation, so resizes stay silent on hosts that never asked.
    naws_accepted: AtomicBool,
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
/// plus, appended to `responses`, the answers for every negotiation command
/// found. `size` is the client grid reported when NAWS is negotiated. Returns
/// the number of input bytes consumed; a trailing incomplete escape (command
/// or subnegotiation split across reads) is left unconsumed so the caller can
/// carry it over.
pub fn decode_telnet(input: &[u8], responses: &mut Vec<u8>, size: (u16, u16)) -> (Vec<u8>, usize) {
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
            DO | DONT | WILL | WONT => {
                let Some(option) = input.get(i + 2).copied() else {
                    break;
                };
                match (command, option) {
                    // The server echoes our keystrokes.
                    (WILL, OPT_ECHO) => responses.extend_from_slice(&[IAC, DO, OPT_ECHO]),
                    // Suppress-go-ahead in either direction is safe for us.
                    (WILL, OPT_SGA) => responses.extend_from_slice(&[IAC, DO, OPT_SGA]),
                    (DO, OPT_SGA) => responses.extend_from_slice(&[IAC, WILL, OPT_SGA]),
                    // Window size: accept and report the current grid.
                    (WILL, OPT_NAWS) => {
                        responses.extend_from_slice(&[IAC, DO, OPT_NAWS]);
                        responses.extend_from_slice(&encode_naws(size.0, size.1));
                    }
                    (DO, OPT_NAWS) => {
                        responses.extend_from_slice(&[IAC, WILL, OPT_NAWS]);
                        responses.extend_from_slice(&encode_naws(size.0, size.1));
                    }
                    // Terminal type: we will send it once the peer asks.
                    (DO, OPT_TTYPE) => responses.extend_from_slice(&[IAC, WILL, OPT_TTYPE]),
                    // RFC 854: answer an offer (WILL) with a refusal (DONT),
                    // a request (DO) or a demand (DONT) with WONT, and stay
                    // silent on WONT — the peer only announced that it will
                    // not enable the option; answering is protocol noise that
                    // strict peers treat as an error.
                    (WILL, _) => responses.extend_from_slice(&[IAC, DONT, option]),
                    (DO | DONT, _) => responses.extend_from_slice(&[IAC, WONT, option]),
                    _ => {}
                }
                i += 3;
            }
            SB => {
                let Some(option) = input.get(i + 2).copied() else {
                    break;
                };
                // Collect the body (unescaping IAC IAC) up to IAC SE.
                let mut body = Vec::new();
                let mut j = i + 3;
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
                                body.push(IAC);
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
                    body.push(input[j]);
                    j += 1;
                }
                if !closed {
                    break;
                }
                // A peer asking for the terminal type gets a VT100 answer.
                if option == OPT_TTYPE && body.first() == Some(&TTYPE_SEND) {
                    responses.extend_from_slice(&encode_ttype_is());
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
            size: Mutex::new((DEFAULT_COLS, DEFAULT_ROWS)),
            naws_accepted: AtomicBool::new(false),
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
        let reader_task = tokio::spawn(async move {
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
                        let grid = *read_session
                            .size
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        let (raw, consumed) = decode_telnet(&pending, &mut responses, grid);
                        pending.drain(..consumed);
                        if pending.len() > MAX_PENDING_ESCAPE_BYTES {
                            // A peer must never split commands this far; drop
                            // the garbage instead of growing the buffer.
                            eprintln!("[telnet] {event_id}: dropping {0} bytes of unterminated escape garbage", pending.len());
                            pending.clear();
                        }
                        if responses.windows(3).any(|pair| {
                            pair[0] == IAC
                                && (pair[1] == DO || pair[1] == WILL)
                                && pair[2] == OPT_NAWS
                        }) {
                            read_session.naws_accepted.store(true, Ordering::Relaxed);
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

        // A panicking read loop (third-party IO internals) would leave the
        // session listed with no reader and no closed event, so treat an
        // abnormal task end exactly like a normal shutdown.
        let watchdog_app = app.clone();
        let watchdog_sessions = Arc::clone(&self.sessions);
        let watchdog_session = Arc::clone(&session);
        let watchdog_id = id.clone();
        tokio::spawn(async move {
            if let Err(join_error) = reader_task.await {
                eprintln!("[telnet] {watchdog_id}: read loop aborted: {join_error}");
                let _ = watchdog_app.emit(&format!("telnet-closed-{}", watchdog_id), ());
                remove_reserved_session(&watchdog_sessions, &watchdog_id, &watchdog_session);
            }
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

    /// Store the grid and, once the peer negotiated NAWS, push the new size
    /// as a subnegotiation. Hosts that never asked stay on their own default
    /// geometry; sending SB NAWS before negotiation would be a protocol error.
    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let session = self.session(id)?;
        *session
            .size
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = (cols, rows);
        if !session.naws_accepted.load(Ordering::Relaxed) {
            return Ok(());
        }
        let mut guard = session.writer.lock().await;
        if let Some(writer) = guard.as_mut() {
            writer
                .write_all(&encode_naws(cols, rows))
                .await
                .context("failed to send telnet window size")?;
            writer
                .flush()
                .await
                .context("failed to flush telnet window size")?;
        }
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
        let (out, consumed) = decode_telnet(input, &mut responses, (100, 40));
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
        // DO ECHO(1) asks us to echo remote output: refused with WONT.
        // WILL SGA(3) is accepted with DO.
        let (out, responses, consumed) = decode(&[IAC, DO, 1, b'x', IAC, WILL, 3]);
        assert_eq!(out, b"x");
        assert_eq!(responses, vec![IAC, WONT, 1, IAC, DO, 3]);
        assert_eq!(consumed, 7);
    }

    #[test]
    fn accepts_server_echo_and_client_sga() {
        let (_out, responses, _consumed) = decode(&[IAC, WILL, OPT_ECHO, IAC, DO, OPT_SGA]);
        assert_eq!(responses, vec![IAC, DO, OPT_ECHO, IAC, WILL, OPT_SGA]);
    }

    #[test]
    fn naws_offer_is_accepted_and_reports_the_grid() {
        let (_out, responses, _consumed) = decode(&[IAC, WILL, OPT_NAWS]);
        assert_eq!(
            responses,
            vec![IAC, DO, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 100, 0, 40, IAC, SE]
        );
    }

    #[test]
    fn naws_request_gets_will_and_the_grid() {
        let (_out, responses, _consumed) = decode(&[IAC, DO, OPT_NAWS]);
        assert_eq!(
            responses,
            vec![IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 100, 0, 40, IAC, SE]
        );
    }

    #[test]
    fn ttype_send_is_answered_with_vt100() {
        let (out, responses, consumed) = decode(&[
            IAC, DO, OPT_TTYPE, b'a', IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE, b'b',
        ]);
        assert_eq!(out, b"ab");
        let mut expected = vec![IAC, WILL, OPT_TTYPE, IAC, SB, OPT_TTYPE, TTYPE_IS];
        expected.extend_from_slice(TTYPE_NAME);
        expected.extend_from_slice(&[IAC, SE]);
        assert_eq!(responses, expected);
        assert_eq!(consumed, 11);
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
    fn unescapes_iac_data_bytes_and_swallows_unknown_subnegotiations() {
        // IAC IAC is a literal 0xFF; an unrelated SB (option 99) is skipped.
        let (out, responses, consumed) =
            decode(&[b'a', IAC, IAC, IAC, SB, 99, 0, 80, 0, 24, IAC, SE, b'b']);
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
        // IAC SB 99 IAC <junk> 1 IAC SE: the violating pair is skipped and the
        // subnegotiation still closes cleanly instead of stalling the stream.
        let (out, responses, consumed) = decode(&[b'a', IAC, SB, 99, IAC, 200, 1, IAC, SE, b'b']);
        assert_eq!(out, b"ab");
        assert!(responses.is_empty());
        assert_eq!(consumed, 10);
    }

    #[test]
    fn naws_encoding_is_big_endian_and_clamped() {
        assert_eq!(
            encode_naws(120, 30),
            vec![IAC, SB, OPT_NAWS, 0, 120, 0, 30, IAC, SE]
        );
        // A zero grid would be "unknown size" to many servers.
        assert_eq!(
            encode_naws(0, 0),
            vec![IAC, SB, OPT_NAWS, 0, 1, 0, 1, IAC, SE]
        );
    }
}
