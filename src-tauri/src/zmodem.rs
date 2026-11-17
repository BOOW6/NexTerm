//! ZMODEM receive state machine (interop with lrzsz-compatible `sz`).
//!
//! The machine is pure: `feed()` consumes raw channel bytes and returns the
//! bytes that must still reach the terminal (`passthrough`), the bytes to
//! write back to the remote (`Action::WriteToRemote`), and file events. File
//! data is streamed out as `Action::FileData`; the caller owns the local file.
//!
//! Handshake summary (receiver side, per the Forsberg spec + lrzsz):
//! - ZRQINIT (hex `**DLE B00…`) → answer ZRINIT (hex, CANFDX|CANOVIO, CRC-16).
//! - ZFILE + its info subpacket → answer ZRPOS(0).
//! - ZDATA subpackets: ZCRCG/ZCRCE silent, ZCRCQ/ZCRCW answered with ZACK
//!   carrying the received offset.
//! - ZEOF (complete) → answer ZRINIT for the next file; short ZEOF → ZRPOS.
//! - ZFIN → answer ZFIN (no XON), then expect the sender's `OO`.
//! - Five successive CANs abort the session; we answer with the cancel
//!   sequence (8×CAN + 10×BS).

use serde::Serialize;

pub const ZDLE: u8 = 0x18;

const ZPAD: u8 = 0x2A;
const ZDLEE: u8 = 0x58;
const ZBIN: u8 = 0x41;
const ZHEX: u8 = 0x42;
const ZBIN32: u8 = 0x43;

const ZRQINIT: u8 = 0;
const ZRINIT: u8 = 1;
const ZSINIT: u8 = 2;
const ZACK: u8 = 3;
const ZFILE: u8 = 4;
const ZSKIP: u8 = 5;
const ZNAK: u8 = 6;
const ZFIN: u8 = 8;
const ZRPOS: u8 = 9;
const ZDATA: u8 = 10;
const ZEOF: u8 = 11;
const ZCAN: u8 = 16;
const ZFREECNT: u8 = 17;
const ZCHALLENGE: u8 = 14;

const ZCRCE: u8 = 0x68;
const ZCRCG: u8 = 0x69;
const ZCRCQ: u8 = 0x6A;
const ZCRCW: u8 = 0x6B;
const ZRUB0: u8 = 0x6C;
const ZRUB1: u8 = 0x6D;

const CANFDX: u8 = 0x01;
const CANOVIO: u8 = 0x02;

/// Capability bits this receiver advertises in every ZRINIT.
const RECEIVER_FLAGS: u32 = (CANFDX | CANOVIO) as u32;

const CANCEL_SEQUENCE: &[u8] = &[
    0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
];

/// Bytes to keep back while scanning for a ZRQINIT sentinel split across
/// reads (`** DLE B 0 0` minus one). Only a suffix that is actually a prefix
/// of the sentinel is held; see [`sentinel_prefix_len`].
const SENTINEL: [u8; 6] = [ZPAD, ZPAD, ZDLE, ZHEX, b'0', b'0'];

/// Length of the longest suffix of `buf` that is a proper prefix of
/// [`SENTINEL`] — the only bytes that can still turn into a sentinel once the
/// next read arrives.
///
/// Holding back a fixed window instead (the old `SCAN_KEEP`) stalled the last
/// bytes of every burst that was followed by an idle period: a shell prompt is
/// written and then nothing else arrives, so the withheld tail never got
/// flushed and the prompt rendered truncated (`dietpi@NanoPC-T4:~$` showed as
/// `dietpi@NanoPC-T`).
fn sentinel_prefix_len(buf: &[u8]) -> usize {
    let max = buf.len().min(SENTINEL.len() - 1);
    (1..=max)
        .rev()
        .find(|&len| buf[buf.len() - len..] == SENTINEL[..len])
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    /// Bytes to write back to the remote channel.
    WriteToRemote {
        data: Vec<u8>,
    },
    FileStart {
        name: String,
        size: Option<u64>,
    },
    FileData {
        data: Vec<u8>,
    },
    /// The current file is closed (complete, or truncated by an abort).
    FileEnd {
        bytes: u64,
        complete: bool,
    },
    /// The whole batch finished cleanly (ZFIN/OO exchange done).
    BatchDone,
}

#[derive(Debug, Default)]
pub struct Feed {
    /// Raw bytes that must still reach the terminal (pre-decode).
    pub passthrough: Vec<u8>,
    pub actions: Vec<Action>,
    /// The batch ended cleanly; the machine has reset to scanning.
    pub done: bool,
    /// The session was aborted (cancel received or requested).
    pub aborted: bool,
    /// The abort came from `cancel()` (the user), not from the remote peer.
    pub cancelled: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    /// Scanning terminal output for the ZRQINIT sentinel.
    Scan,
    Header,
    Subpacket,
    AwaitOO,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HPhase {
    /// Expecting `ZPAD ZPAD ZDLE`.
    Pads,
    /// Expecting the variant character (ZBIN/ZHEX/ZBIN32).
    Variant,
    /// Collecting 14 hex digits.
    HexDigits,
    /// Skipping CR/LF/XON after a hex header (crosses state changes).
    HexEol,
    /// Collecting `need` ZDLE-decoded bytes (type + 4 data + crc).
    BinBody,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SubCtx {
    Zsinit,
    Fileinfo,
    Data,
}

struct FileInfo {
    size: Option<u64>,
    received: u64,
}

pub struct ZmodemReceiver {
    state: State,
    established: bool,

    scan: Vec<u8>,
    raw_can: u8,

    h_phase: HPhase,
    h_pads: u8,
    h_hex: Vec<u8>,
    h_bin: Vec<u8>,
    h_need: usize,
    h_dle: bool,
    /// Raw bytes of the current header candidate, used to resume scanning
    /// when an unestablished header fails its CRC.
    h_raw: Vec<u8>,

    s_ctx: SubCtx,
    s_data: Vec<u8>,
    s_dle: bool,
    s_end: Option<u8>,
    s_crc: Vec<u8>,

    file: Option<FileInfo>,
    oo: u8,
    cancel_requested: bool,
}

impl Default for ZmodemReceiver {
    fn default() -> Self {
        Self::new()
    }
}

impl ZmodemReceiver {
    pub fn new() -> Self {
        Self {
            state: State::Scan,
            established: false,
            scan: Vec::new(),
            raw_can: 0,
            h_phase: HPhase::Pads,
            h_pads: 0,
            h_hex: Vec::new(),
            h_bin: Vec::new(),
            h_need: 0,
            h_dle: false,
            h_raw: Vec::new(),
            s_ctx: SubCtx::Zsinit,
            s_data: Vec::new(),
            s_dle: false,
            s_end: None,
            s_crc: Vec::new(),
            file: None,
            oo: 0,
            cancel_requested: false,
        }
    }

    /// Bytes of the current file received so far (test/observability API).
    #[allow(dead_code)]
    pub fn received(&self) -> u64 {
        self.file.as_ref().map(|f| f.received).unwrap_or(0)
    }

    /// Request abort: returns the cancel sequence to write to the remote.
    /// The machine marks itself aborted; the next `feed()` call emits the
    /// file-close/BatchDone actions and resets to scanning.
    pub fn cancel(&mut self) -> Vec<u8> {
        self.cancel_requested = true;
        CANCEL_SEQUENCE.to_vec()
    }

    pub fn feed(&mut self, input: &[u8]) -> Feed {
        let mut out = Feed::default();
        if self.cancel_requested {
            self.cancel_requested = false;
            out.cancelled = true;
            self.abort(&mut out);
            // Keep processing this chunk: it usually carries the shell output
            // that follows the cancel (a prompt or the next command's echo),
            // which must not be swallowed just because the cancel landed in
            // the same read.
        }
        let mut rest = input;
        if self.state == State::Scan {
            let consumed = self.scan_chunk(input, &mut out);
            rest = &input[consumed..];
            if self.state == State::Scan {
                return out;
            }
        }
        for &b in rest {
            if self.feed_raw(b, &mut out) {
                break;
            }
        }
        out
    }

    /// Scan for the ZRQINIT sentinel. Returns how many input bytes were
    /// consumed (the remainder belongs to the header parser once matched).
    fn scan_chunk(&mut self, input: &[u8], out: &mut Feed) -> usize {
        self.scan.extend_from_slice(input);
        if let Some(pos) = find_pattern(&self.scan, &SENTINEL) {
            out.passthrough.extend_from_slice(&self.scan[..pos]);
            let rest = self.scan[pos..].to_vec();
            self.scan.clear();
            self.state = State::Header;
            self.h_phase = HPhase::Pads;
            self.h_pads = 0;
            self.h_raw.clear();
            // The sentinel bytes themselves flow through the pad counter; the
            // variant char then switches the parser into hex collection.
            for &b in &rest {
                if self.feed_raw(b, out) {
                    break;
                }
            }
            // Everything from the sentinel to the end of the chunk has been
            // consumed by the header parser.
            return input.len();
        }
        let keep = sentinel_prefix_len(&self.scan);
        let split = self.scan.len() - keep;
        out.passthrough.extend_from_slice(&self.scan[..split]);
        self.scan.drain(..split);
        input.len()
    }

    /// Process one raw byte. Returns `true` when the session aborted and the
    /// caller should stop feeding.
    fn feed_raw(&mut self, b: u8, out: &mut Feed) -> bool {
        if b == ZDLE {
            self.raw_can += 1;
            if self.raw_can >= 5 {
                return self.abort(out);
            }
        } else {
            self.raw_can = 0;
        }

        if self.h_phase == HPhase::HexEol {
            if matches!(b, 0x0D | 0x0A | 0x11) {
                return false;
            }
            self.h_phase = HPhase::Pads;
            self.h_pads = 0;
        }

        match self.state {
            State::Scan => {
                self.scan.push(b);
                false
            }
            State::Header => self.header_byte(b, out),
            State::Subpacket => self.subpacket_byte(b, out),
            State::AwaitOO => {
                if b == b'O' {
                    self.oo += 1;
                    if self.oo >= 2 {
                        if let Some(info) = self.file.take() {
                            out.actions.push(Action::FileEnd {
                                bytes: info.received,
                                complete: true,
                            });
                        }
                        out.actions.push(Action::BatchDone);
                        out.done = true;
                        self.reset();
                    }
                } else {
                    self.oo = 0;
                }
                false
            }
        }
    }

    fn reset(&mut self) {
        self.state = State::Scan;
        self.h_phase = HPhase::Pads;
        self.h_pads = 0;
        self.h_hex.clear();
        self.h_bin.clear();
        self.h_dle = false;
        self.h_raw.clear();
        self.s_data.clear();
        self.s_dle = false;
        self.s_end = None;
        self.s_crc.clear();
        self.file = None;
        self.oo = 0;
        self.cancel_requested = false;
        // `established` stays true: after a batch, CRC failures should NAK
        // instead of silently resuming terminal output.
    }

    fn abort(&mut self, out: &mut Feed) -> bool {
        out.actions.push(Action::WriteToRemote {
            data: CANCEL_SEQUENCE.to_vec(),
        });
        if let Some(info) = self.file.take() {
            out.actions.push(Action::FileEnd {
                bytes: info.received,
                complete: false,
            });
        }
        out.aborted = true;
        out.done = true;
        self.reset();
        true
    }

    fn header_byte(&mut self, b: u8, out: &mut Feed) -> bool {
        match self.h_phase {
            // Binary headers start "ZPAD ZDLE", hex headers "ZPAD ZPAD ZDLE".
            // Any ZPAD arms the parser; the ZDLE after it opens the variant.
            HPhase::Pads => {
                self.h_raw.push(b);
                if b == ZPAD {
                    self.h_pads = 1;
                } else if b == ZDLE && self.h_pads >= 1 {
                    self.h_phase = HPhase::Variant;
                } else {
                    self.resume_scan(out);
                }
            }
            HPhase::Variant => {
                self.h_raw.push(b);
                match b {
                    ZHEX => {
                        self.h_phase = HPhase::HexDigits;
                        self.h_hex.clear();
                    }
                    ZBIN => {
                        self.h_phase = HPhase::BinBody;
                        self.h_need = 7;
                        self.h_bin.clear();
                        self.h_dle = false;
                    }
                    ZBIN32 => {
                        self.h_phase = HPhase::BinBody;
                        self.h_need = 9;
                        self.h_bin.clear();
                        self.h_dle = false;
                    }
                    _ => self.resume_scan(out),
                }
            }
            HPhase::HexDigits => {
                self.h_raw.push(b);
                if !b.is_ascii_hexdigit() {
                    self.resume_scan(out);
                    return false;
                }
                self.h_hex.push(b);
                if self.h_hex.len() == 14 {
                    let bytes: Vec<u8> = (0..7)
                        .map(|i| {
                            u8::from_str_radix(
                                std::str::from_utf8(&self.h_hex[i * 2..i * 2 + 2]).unwrap_or("zz"),
                                16,
                            )
                            .unwrap_or(0xFF)
                        })
                        .collect();
                    let type_ = bytes[0];
                    let data = [bytes[1], bytes[2], bytes[3], bytes[4]];
                    let crc = u16::from_be_bytes([bytes[5], bytes[6]]);
                    if crc16(&[type_, data[0], data[1], data[2], data[3]]) != crc {
                        self.header_crc_error(out);
                        return false;
                    }
                    // Dispatch immediately so the handshake answer leaves
                    // even if the sender goes quiet waiting for it (sz would
                    // time out and retransmit otherwise). The trailing CR/LF/
                    // XON are swallowed by the HexEol pre-check in feed_raw.
                    self.h_raw.clear();
                    self.dispatch_header(type_, data, out);
                    self.h_phase = HPhase::HexEol;
                }
            }
            // HexEol is handled by the pre-check in feed_raw; when it falls
            // through here the phase has already been reset to Pads.
            HPhase::HexEol => self.resume_scan(out),
            HPhase::BinBody => {
                self.h_raw.push(b);
                match Self::decode_byte(b, &mut self.h_bin, &mut self.h_dle) {
                    Decoded::Byte => {
                        if self.h_bin.len() == self.h_need {
                            let type_ = self.h_bin[0];
                            let data = [self.h_bin[1], self.h_bin[2], self.h_bin[3], self.h_bin[4]];
                            let ok = if self.h_need == 9 {
                                let crc = u32::from_le_bytes([
                                    self.h_bin[5],
                                    self.h_bin[6],
                                    self.h_bin[7],
                                    self.h_bin[8],
                                ]);
                                crc32(&[type_, data[0], data[1], data[2], data[3]]) == crc
                            } else {
                                let crc = u16::from_be_bytes([self.h_bin[5], self.h_bin[6]]);
                                crc16(&[type_, data[0], data[1], data[2], data[3]]) == crc
                            };
                            self.h_raw.clear();
                            if ok {
                                self.dispatch_header(type_, data, out);
                            } else {
                                self.header_crc_error(out);
                                return out.aborted;
                            }
                        }
                    }
                    Decoded::Dropped => {}
                    Decoded::Invalid => {
                        self.header_crc_error(out);
                        return out.aborted;
                    }
                }
            }
        }
        false
    }

    fn header_crc_error(&mut self, out: &mut Feed) {
        if self.established {
            out.actions.push(Action::WriteToRemote {
                data: hex_header(ZNAK, 0),
            });
            self.h_raw.clear();
            self.state = State::Header;
            self.h_phase = HPhase::Pads;
            self.h_pads = 0;
        } else {
            self.resume_scan(out);
        }
    }

    /// A header candidate failed before establishment: rewind scanning to the
    /// byte after the first `*` so a real sentinel later in the stream still
    /// matches. (After establishment the bytes are simply dropped — they are
    /// corrupt frame fragments, not terminal output.)
    fn resume_scan(&mut self, out: &mut Feed) {
        let raw = std::mem::take(&mut self.h_raw);
        self.h_hex.clear();
        self.h_bin.clear();
        self.h_dle = false;
        self.state = State::Scan;
        self.h_phase = HPhase::Pads;
        self.h_pads = 0;
        // Re-scan the candidate from its first `*`'s successor: a real
        // sentinel may start inside the failed candidate. scan_chunk passes
        // the non-matching bytes through to the terminal (established
        // sessions drop them instead — corrupt frame fragments, not output).
        match raw.iter().position(|&b| b == ZPAD) {
            Some(star) => {
                if !self.established {
                    out.passthrough.extend_from_slice(&raw[..=star]);
                }
                if star + 1 < raw.len() {
                    let buf = raw[star + 1..].to_vec();
                    self.scan_chunk(&buf, out);
                }
            }
            _ => {
                if !self.established {
                    out.passthrough.extend_from_slice(&raw);
                }
            }
        }
    }

    fn dispatch_header(&mut self, type_: u8, data: [u8; 4], out: &mut Feed) {
        // A fully verified frame marks the session established: from here on,
        // corrupt bytes are dropped/NAKed instead of passed to the terminal.
        self.established = true;
        let pos = u32::from_le_bytes(data);
        match type_ {
            ZRQINIT | ZRINIT => {
                out.actions.push(Action::WriteToRemote {
                    data: hex_header(ZRINIT, RECEIVER_FLAGS),
                });
                self.stay_in_header();
            }
            ZSINIT => {
                self.begin_subpacket(SubCtx::Zsinit);
            }
            ZFILE => {
                self.file = None;
                self.begin_subpacket(SubCtx::Fileinfo);
            }
            ZDATA => {
                let received = self.file.as_ref().map(|f| f.received).unwrap_or(0);
                if (pos as u64) != received {
                    out.actions.push(Action::WriteToRemote {
                        data: hex_header(ZRPOS, received as u32),
                    });
                }
                self.begin_subpacket(SubCtx::Data);
            }
            ZEOF => {
                let (received, size) = match self.file.as_ref() {
                    Some(info) => (info.received, info.size),
                    None => (0, None),
                };
                let complete = size.map(|size| received >= size).unwrap_or(true);
                if complete {
                    if let Some(info) = self.file.take() {
                        out.actions.push(Action::FileEnd {
                            bytes: info.received,
                            complete: true,
                        });
                    }
                    out.actions.push(Action::WriteToRemote {
                        data: hex_header(ZRINIT, RECEIVER_FLAGS),
                    });
                } else {
                    // Missing bytes: ignore the ZEOF, the sender rewinds.
                    out.actions.push(Action::WriteToRemote {
                        data: hex_header(ZRPOS, received as u32),
                    });
                }
                self.stay_in_header();
            }
            ZFIN => {
                out.actions.push(Action::WriteToRemote {
                    data: hex_header(ZFIN, 0),
                });
                self.state = State::AwaitOO;
                self.oo = 0;
            }
            ZCAN => {
                self.abort(out);
            }
            ZFREECNT | ZCHALLENGE => {
                // Free space is reported as 0 (unknown); a challenge echoes
                // the received number back.
                out.actions.push(Action::WriteToRemote {
                    data: hex_header(ZACK, pos),
                });
                self.stay_in_header();
            }
            _ => {
                out.actions.push(Action::WriteToRemote {
                    data: hex_header(ZNAK, 0),
                });
                self.stay_in_header();
            }
        }
    }

    fn stay_in_header(&mut self) {
        self.state = State::Header;
        self.h_phase = HPhase::Pads;
        self.h_pads = 0;
        self.h_hex.clear();
        self.h_bin.clear();
        self.h_dle = false;
    }

    fn begin_subpacket(&mut self, ctx: SubCtx) {
        self.s_ctx = ctx;
        self.s_data.clear();
        self.s_dle = false;
        self.s_end = None;
        self.s_crc.clear();
        self.state = State::Subpacket;
    }

    fn subpacket_byte(&mut self, b: u8, out: &mut Feed) -> bool {
        if self.s_end.is_some() {
            // Collecting the 2 CRC bytes (ZDLE-encoded, high byte first).
            match Self::decode_byte(b, &mut self.s_crc, &mut self.s_dle) {
                Decoded::Byte => {
                    if self.s_crc.len() == 2 {
                        self.finish_subpacket(out);
                        if out.aborted {
                            return true;
                        }
                    }
                }
                Decoded::Dropped => {}
                Decoded::Invalid => self.subpacket_error(out),
            }
            return false;
        }

        if self.s_dle {
            self.s_dle = false;
            match b {
                ZCRCE | ZCRCG | ZCRCQ | ZCRCW => self.s_end = Some(b),
                ZRUB0 => self.s_data.push(0x7F),
                ZRUB1 => self.s_data.push(0xFF),
                ZDLEE => self.s_data.push(ZDLE),
                _ if b & 0x60 == 0x40 => self.s_data.push(b ^ 0x40),
                _ => self.subpacket_error(out),
            }
            return false;
        }

        match b {
            ZDLE => self.s_dle = true,
            0x11 | 0x13 => {} // XON/XOFF padding: drop
            _ => self.s_data.push(b),
        }
        false
    }

    fn finish_subpacket(&mut self, out: &mut Feed) {
        let end = self.s_end.take().unwrap_or(ZCRCE);
        let crc = u16::from_be_bytes([self.s_crc[0], self.s_crc[1]]);
        let mut payload = std::mem::take(&mut self.s_data);
        payload.push(end);
        self.s_crc.clear();
        if crc16(&payload) != crc {
            self.subpacket_error(out);
            return;
        }
        payload.pop();

        match self.s_ctx {
            SubCtx::Zsinit => {
                // The Attn string is ignored (never used by this receiver).
                out.actions.push(Action::WriteToRemote {
                    data: hex_header(ZACK, 0),
                });
                self.stay_in_header();
            }
            SubCtx::Fileinfo => {
                let (name, size) = parse_file_info(&payload);
                if name.is_empty() {
                    out.actions.push(Action::WriteToRemote {
                        data: hex_header(ZSKIP, 0),
                    });
                } else {
                    self.file = Some(FileInfo { size, received: 0 });
                    out.actions.push(Action::FileStart { name, size });
                    out.actions.push(Action::WriteToRemote {
                        data: hex_header(ZRPOS, 0),
                    });
                }
                self.stay_in_header();
            }
            SubCtx::Data => {
                if !payload.is_empty() {
                    if let Some(info) = self.file.as_mut() {
                        info.received += payload.len() as u64;
                    }
                    out.actions.push(Action::FileData { data: payload });
                }
                match end {
                    // Streaming continues with another subpacket.
                    ZCRCG => {}
                    // Frame boundary: a new ZDATA header follows.
                    ZCRCQ | ZCRCW => {
                        let received = self.file.as_ref().map(|f| f.received).unwrap_or(0);
                        out.actions.push(Action::WriteToRemote {
                            data: hex_header(ZACK, received as u32),
                        });
                        self.stay_in_header();
                    }
                    // End of file data: a ZEOF header follows.
                    ZCRCE => self.stay_in_header(),
                    _ => self.stay_in_header(),
                }
            }
        }
    }

    fn subpacket_error(&mut self, out: &mut Feed) {
        let received = self.file.as_ref().map(|f| f.received).unwrap_or(0);
        let frame = if self.s_ctx == SubCtx::Data {
            hex_header(ZRPOS, received as u32)
        } else {
            hex_header(ZNAK, 0)
        };
        out.actions.push(Action::WriteToRemote { data: frame });
        self.s_data.clear();
        self.s_dle = false;
        self.s_end = None;
        self.s_crc.clear();
        self.state = State::Header;
        self.h_phase = HPhase::Pads;
        self.h_pads = 0;
    }

    fn decode_byte(b: u8, buf: &mut Vec<u8>, dle: &mut bool) -> Decoded {
        if *dle {
            *dle = false;
            return match b {
                ZCRCE | ZCRCG | ZCRCQ | ZCRCW | ZRUB0 | ZRUB1 => Decoded::Invalid,
                ZDLEE => {
                    buf.push(ZDLE);
                    Decoded::Byte
                }
                _ if b & 0x60 == 0x40 => {
                    buf.push(b ^ 0x40);
                    Decoded::Byte
                }
                _ => Decoded::Invalid,
            };
        }
        match b {
            ZDLE => {
                *dle = true;
                Decoded::Dropped
            }
            0x11 | 0x13 => Decoded::Dropped,
            _ => {
                buf.push(b);
                Decoded::Byte
            }
        }
    }
}

enum Decoded {
    Byte,
    Dropped,
    Invalid,
}

fn find_pattern(buf: &[u8], pattern: &[u8]) -> Option<usize> {
    if buf.len() < pattern.len() {
        return None;
    }
    (0..=buf.len() - pattern.len()).find(|&i| &buf[i..i + pattern.len()] == pattern)
}

fn parse_file_info(payload: &[u8]) -> (String, Option<u64>) {
    let mut parts = payload.splitn(3, |&b| b == 0);
    let name_raw = parts.next().unwrap_or(&[]);
    let info_raw = parts.next().unwrap_or(&[]);
    let name = String::from_utf8_lossy(name_raw)
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let info = String::from_utf8_lossy(info_raw);
    let size = info
        .split(' ')
        .next()
        .and_then(|field| field.trim().parse::<u64>().ok());
    (name, size)
}

/// ZMODEM CRC-16: CCITT table walk (`crc >> 8 ^ table[(crc ^ byte) & 0xff]`,
/// poly 0x1021, init 0) finalized by feeding two zero bytes.
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc = (crc >> 8) ^ CRC16_TABLE[((crc ^ b as u16) & 0xFF) as usize];
    }
    crc = (crc >> 8) ^ CRC16_TABLE[(crc & 0xFF) as usize];
    (crc >> 8) ^ CRC16_TABLE[(crc & 0xFF) as usize]
}

const CRC16_TABLE: [u16; 256] = build_crc16_table();

const fn build_crc16_table() -> [u16; 256] {
    let mut table = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut r = (i as u16) << 8;
        let mut bit = 0;
        while bit < 8 {
            r = if r & 0x8000 != 0 {
                (r << 1) ^ 0x1021
            } else {
                r << 1
            };
            bit += 1;
        }
        table[i] = r;
        i += 1;
    }
    table
}

/// CRC-32 (reflected, init 0xFFFFFFFF, final xor).
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFFFFFF;
    for &b in data {
        crc ^= b as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB88320
            } else {
                crc >> 1
            };
            bit += 1;
        }
    }
    !crc
}

/// Build a hex header frame: `** DLE B <type><d0..d3><crc16> CR LF [XON]`.
/// `flags` is a ZF0-style value (lands in the last transmitted data byte).
/// XON is omitted for ZACK and ZFIN per spec.
pub fn hex_header(type_: u8, flags: u32) -> Vec<u8> {
    // Header array semantics: index 0 = ZP0/ZF3 (transmitted first), index 3
    // = ZP3/ZF0 (transmitted last).
    let data = [
        ((flags >> 24) & 0xFF) as u8,
        ((flags >> 16) & 0xFF) as u8,
        ((flags >> 8) & 0xFF) as u8,
        (flags & 0xFF) as u8,
    ];
    let crc = crc16(&[type_, data[0], data[1], data[2], data[3]]);
    let mut out = Vec::with_capacity(20);
    out.extend_from_slice(&[ZPAD, ZPAD, ZDLE, ZHEX]);
    for byte in [
        type_,
        data[0],
        data[1],
        data[2],
        data[3],
        (crc >> 8) as u8,
        (crc & 0xFF) as u8,
    ] {
        out.extend_from_slice(format!("{:02x}", byte).as_bytes());
    }
    out.push(0x0D);
    out.push(0x0A);
    if type_ != ZFIN && type_ != ZACK {
        out.push(0x11);
    }
    out
}

#[cfg(test)]
mod tests;
