use super::*;

/// Sender-side ZDLE escaping (over-escaping is legal; the receiver must cope).
fn zesc(out: &mut Vec<u8>, c: u8) {
    match c {
        ZDLE => {
            out.push(ZDLE);
            out.push(ZDLEE);
        }
        0x7F => {
            out.push(ZDLE);
            out.push(b'l');
        }
        0xFF => {
            out.push(ZDLE);
            out.push(b'm');
        }
        _ if c & 0x60 == 0 => {
            out.push(ZDLE);
            out.push(c ^ 0x40);
        }
        _ => out.push(c),
    }
}

fn hex_frame(type_: u8, data: [u8; 4]) -> Vec<u8> {
    let crc = crc16(&[type_, data[0], data[1], data[2], data[3]]);
    let mut out = vec![ZPAD, ZPAD, ZDLE, ZHEX];
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

fn bin16_frame(type_: u8, data: [u8; 4]) -> Vec<u8> {
    let crc = crc16(&[type_, data[0], data[1], data[2], data[3]]);
    let mut out = vec![ZPAD, ZDLE, ZBIN];
    for byte in [
        type_,
        data[0],
        data[1],
        data[2],
        data[3],
        (crc >> 8) as u8,
        (crc & 0xFF) as u8,
    ] {
        zesc(&mut out, byte);
    }
    out
}

/// A data subpacket: escaped payload + ZDLE + end char + escaped CRC-16.
fn subpacket(payload: &[u8], end: u8) -> Vec<u8> {
    let crc = crc16(&[payload, &[end]].concat());
    let mut out = Vec::new();
    for &b in payload {
        zesc(&mut out, b);
    }
    out.push(ZDLE);
    out.push(end);
    zesc(&mut out, (crc >> 8) as u8);
    zesc(&mut out, (crc & 0xFF) as u8);
    out
}

fn pos_data(pos: u32) -> [u8; 4] {
    pos.to_le_bytes()
}

#[test]
fn crc16_all_zeros_is_zero() {
    // The canonical sz ZRQINIT hex header is `**DLEB` + fourteen '0' digits:
    // type 00, data 00000000, crc 0000. So crc16 over [0,0,0,0,0] must be 0.
    assert_eq!(crc16(&[0, 0, 0, 0, 0]), 0);
}

#[test]
fn zrqinit_yields_zrinit() {
    let mut z = ZmodemReceiver::new();
    let mut stream = b"rz\r".to_vec();
    stream.extend_from_slice(&hex_frame(ZRQINIT, [0; 4]));

    let feed = z.feed(&stream);
    assert!(feed.passthrough.starts_with(b"rz\r"));
    assert_eq!(
        feed.actions,
        vec![Action::WriteToRemote {
            data: hex_header(ZRINIT, 0x03)
        }]
    );
    assert!(!feed.done);
}

#[test]
fn full_single_file_session() {
    let mut z = ZmodemReceiver::new();
    let mut stream = Vec::new();
    stream.extend_from_slice(b"$ rz\r");
    stream.extend_from_slice(&hex_frame(ZRQINIT, [0; 4]));
    stream.extend_from_slice(&bin16_frame(ZFILE, [0; 4]));
    let mut info = b"test.txt\0".to_vec();
    info.extend_from_slice(b"16 0 100644 0 1 16 -\0");
    stream.extend_from_slice(&subpacket(&info, ZCRCW));
    stream.extend_from_slice(&bin16_frame(ZDATA, [0; 4]));
    stream.extend_from_slice(&subpacket(b"He\x18llo ", ZCRCG));
    stream.extend_from_slice(&subpacket(b"wo\x11rld!\r\n", ZCRCE));
    stream.extend_from_slice(&hex_frame(ZEOF, pos_data(16)));
    stream.extend_from_slice(&hex_frame(ZFIN, [0; 4]));
    stream.extend_from_slice(b"OO");

    let feed = z.feed(&stream);
    assert!(feed.passthrough.starts_with(b"$ rz\r"));
    assert!(!feed.passthrough[feed.passthrough.len() - 2..].contains(&ZDLE));
    assert!(feed.done);
    assert!(!feed.aborted);

    let mut started = None;
    let mut data = Vec::new();
    let mut ended = Vec::new();
    let mut responses: Vec<Vec<u8>> = Vec::new();
    let mut batch_done = false;
    for action in feed.actions {
        match action {
            Action::FileStart { name, size } => started = Some((name, size)),
            Action::FileData { data: chunk } => data.extend_from_slice(&chunk),
            Action::FileEnd { bytes, complete } => ended.push((bytes, complete)),
            Action::WriteToRemote { data } => responses.push(data),
            Action::BatchDone => batch_done = true,
        }
    }

    assert_eq!(started, Some(("test.txt".to_string(), Some(16))));
    // 0x18 survives as literal ZDLE in the file; 0x11 and CR LF as well.
    assert_eq!(data, b"He\x18llo wo\x11rld!\r\n".to_vec());
    assert_eq!(ended, vec![(16, true)]);
    assert!(batch_done);

    // ZRINIT (after ZRQINIT), ZRPOS(0) (after file info), ZRINIT (after ZEOF),
    // ZFIN (no XON) — in that order.
    assert_eq!(responses.len(), 4);
    assert_eq!(responses[0], hex_header(ZRINIT, 0x03));
    assert_eq!(responses[1], hex_header(ZRPOS, 0));
    assert_eq!(responses[2], hex_header(ZRINIT, 0x03));
    assert_eq!(responses[3], hex_header(ZFIN, 0));
    assert!(
        !responses[3].ends_with(&[0x11]),
        "ZFIN must not be followed by XON"
    );
}

#[test]
fn byte_by_byte_feeding_matches_bulk() {
    let mut stream = Vec::new();
    stream.extend_from_slice(&hex_frame(ZRQINIT, [0; 4]));
    stream.extend_from_slice(&bin16_frame(ZFILE, [0; 4]));
    let mut info = b"bin.dat\0".to_vec();
    info.extend_from_slice(b"4 0 100644\0");
    stream.extend_from_slice(&subpacket(&info, ZCRCW));
    stream.extend_from_slice(&bin16_frame(ZDATA, [0; 4]));
    stream.extend_from_slice(&subpacket(&[0x00, 0x11, 0x13, 0x7F, 0x2A], ZCRCW));
    // Sender rewinds are answered with ZRPOS; second attempt delivers.
    stream.extend_from_slice(&bin16_frame(ZDATA, pos_data(5)));
    stream.extend_from_slice(&subpacket(b"abcd", ZCRCE));
    stream.extend_from_slice(&hex_frame(ZEOF, pos_data(5)));
    stream.extend_from_slice(&hex_frame(ZFIN, [0; 4]));
    stream.extend_from_slice(b"OO");

    let mut bulk = ZmodemReceiver::new();
    let bulk_feed = bulk.feed(&stream);

    let mut bytewise = ZmodemReceiver::new();
    let mut joined = Feed::default();
    for &b in &stream {
        let mut feed = bytewise.feed(&[b]);
        joined.passthrough.extend_from_slice(&feed.passthrough);
        joined.actions.append(&mut feed.actions);
        joined.done |= feed.done;
        joined.aborted |= feed.aborted;
    }

    assert_eq!(joined.done, bulk_feed.done);
    assert_eq!(joined.actions, bulk_feed.actions);
    let data = bulk_feed
        .actions
        .iter()
        .filter_map(|a| match a {
            Action::FileData { data } => Some(data.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .concat();
    assert_eq!(
        data,
        [0x00, 0x11, 0x13, 0x7F, 0x2A, b'a', b'b', b'c', b'd'].to_vec()
    );
}

#[test]
fn corrupt_data_subpacket_requests_rewind() {
    let mut z = ZmodemReceiver::new();
    let mut stream = Vec::new();
    stream.extend_from_slice(&hex_frame(ZRQINIT, [0; 4]));
    stream.extend_from_slice(&bin16_frame(ZFILE, [0; 4]));
    let mut info = b"f.bin\0".to_vec();
    info.extend_from_slice(b"2 0 100644\0");
    stream.extend_from_slice(&subpacket(&info, ZCRCW));
    stream.extend_from_slice(&bin16_frame(ZDATA, [0; 4]));
    // Two good bytes, then a subpacket whose CRC is wrong.
    stream.extend_from_slice(&subpacket(b"ok", ZCRCG));
    let mut bad = subpacket(b"NO", ZCRCE);
    let last = bad.last_mut().unwrap();
    *last ^= 0x01;
    stream.extend_from_slice(&bad);

    let feed = z.feed(&stream);
    let rewinds: Vec<&Vec<u8>> = feed
        .actions
        .iter()
        .filter_map(|a| match a {
            Action::WriteToRemote { data } if data == &hex_header(ZRPOS, 2) => Some(data),
            _ => None,
        })
        .collect();
    assert_eq!(rewinds.len(), 1);
    assert_eq!(z.received(), 2);
}

#[test]
fn five_cans_abort_and_request_cancel() {
    let mut z = ZmodemReceiver::new();
    let mut stream = Vec::new();
    stream.extend_from_slice(&hex_frame(ZRQINIT, [0; 4]));
    stream.extend_from_slice(&bin16_frame(ZFILE, [0; 4]));
    let mut info = b"f.bin\0".to_vec();
    info.extend_from_slice(b"100 0 100644\0");
    stream.extend_from_slice(&subpacket(&info, ZCRCW));
    stream.extend_from_slice(&bin16_frame(ZDATA, [0; 4]));
    stream.extend_from_slice(&subpacket(b"partial", ZCRCG));
    stream.extend_from_slice(&[0x18; 5]);

    let feed = z.feed(&stream);
    assert!(feed.aborted);
    assert!(feed.done);
    assert!(feed.actions.contains(&Action::WriteToRemote {
        data: CANCEL_SEQUENCE.to_vec()
    }));
    assert!(feed.actions.iter().any(|a| matches!(
        a,
        Action::FileEnd {
            complete: false,
            ..
        }
    )));
    assert_eq!(z.cancel(), CANCEL_SEQUENCE);
}

#[test]
fn false_positive_sentinel_passes_through() {
    let mut z = ZmodemReceiver::new();
    let feed = z.feed(b"cat out **\x18B00zz ");
    assert_eq!(z.state, State::Scan);
    assert!(feed.actions.is_empty());
    assert!(feed.passthrough.starts_with(b"cat out *"));
    // Later feeds flush the bytes the scanner held back.
    let feed2 = z.feed(b"trailing");
    let feed3 = z.feed(b"12345");
    let everything: Vec<u8> = [
        feed.passthrough.as_slice(),
        feed2.passthrough.as_slice(),
        feed3.passthrough.as_slice(),
    ]
    .concat();
    // A rejected candidate is terminal output and must reach the screen
    // verbatim, tail included — nothing is withheld once the stream carries
    // no pending sentinel prefix.
    assert_eq!(everything, b"cat out **\x18B00zz trailing12345");
    assert!(everything
        .windows(6)
        .any(|w| w == [b'*', b'*', 0x18, b'B', b'0', b'0']));
}

#[test]
fn sentinel_split_across_feeds_is_found() {
    let mut z = ZmodemReceiver::new();
    let pattern = [ZPAD, ZPAD, ZDLE, ZHEX, b'0', b'0'];
    // Feed the pattern one byte at a time; only the last byte completes it.
    for &b in &pattern[..5] {
        let feed = z.feed(&[b]);
        assert!(feed.actions.is_empty());
        assert_eq!(z.state, State::Scan);
    }
    let mut tail = pattern[5..].to_vec();
    tail.extend_from_slice(b"0000000000000\r\n\x11");
    let feed = z.feed(&tail);
    assert_eq!(
        feed.actions[0],
        Action::WriteToRemote {
            data: hex_header(ZRINIT, 0x03)
        }
    );
}

#[test]
fn trailing_output_is_not_withheld_when_the_stream_goes_idle() {
    // Regression: the scanner used to keep the last 5 bytes of every feed
    // waiting for a sentinel split across reads. A shell prompt is written
    // and then nothing follows, so those bytes never flushed and the prompt
    // rendered truncated (`dietpi@NanoPC-T4:~$` arrived as `dietpi@NanoPC-T`).
    let mut z = ZmodemReceiver::new();
    let prompt = b"dietpi@NanoPC-T4:~$ ";
    let feed = z.feed(prompt);
    assert_eq!(feed.passthrough, prompt, "prompt must pass through intact");
    assert!(feed.actions.is_empty());

    // A second burst must not release held bytes either — nothing is pending.
    let feed = z.feed(b"cat .bashrc\r\n");
    assert_eq!(feed.passthrough, b"cat .bashrc\r\n");
}

#[test]
fn only_a_genuine_sentinel_prefix_is_held_back() {
    // A trailing `*` may still become `** DLE B 0 0`, so it is held.
    let mut z = ZmodemReceiver::new();
    let feed = z.feed(b"ls *");
    assert_eq!(feed.passthrough, b"ls ");
    // The next chunk completes an ordinary line: the held byte flows out.
    let feed = z.feed(b".txt\r\n");
    assert_eq!(feed.passthrough, b"*.txt\r\n");

    // Nothing else is held: text with no sentinel prefix passes fully.
    let mut z = ZmodemReceiver::new();
    let feed = z.feed(b"ab**cd");
    assert_eq!(feed.passthrough, b"ab**cd");
}

#[test]
fn sentinel_prefix_len_matches_only_real_prefixes() {
    let s = |bytes: &[u8]| sentinel_prefix_len(bytes);
    assert_eq!(s(b""), 0);
    assert_eq!(s(b"hello"), 0);
    assert_eq!(s(b"*"), 1);
    assert_eq!(s(b"a*"), 1);
    assert_eq!(s(b"**"), 2);
    assert_eq!(s(b"**\x18"), 3);
    assert_eq!(s(b"**\x18B"), 4);
    assert_eq!(s(b"**\x18B0"), 5);
    // A full sentinel is found by the matcher, not held as a prefix.
    assert_eq!(s(b"**\x18B00"), 0);
    // `*` after a non-matching byte is the only held suffix.
    assert_eq!(s(b"***"), 2);
}

#[test]
fn cancel_keeps_the_same_chunk_as_terminal_output() {
    let mut z = ZmodemReceiver::new();
    // Establish a session first (cancel needs a machine to tear down).
    let hello = hex_frame(ZRQINIT, [0; 4]);
    let feed = z.feed(&hello);
    assert!(!feed.aborted);

    assert_eq!(z.cancel(), CANCEL_SEQUENCE);
    // The read that carries the abort usually also carries the shell prompt
    // that follows; it must still be rendered instead of being swallowed.
    let feed = z.feed(b"prompt$ ");
    assert!(feed.aborted);
    assert!(feed.cancelled);
    assert_eq!(feed.passthrough, b"prompt$ ");
    assert!(feed.actions.iter().any(|action| matches!(
        action,
        Action::WriteToRemote { data } if data == &CANCEL_SEQUENCE.to_vec()
    )));
}

mod batch_start_scanner {
    use super::super::{BatchStartScanner, ZDLE, ZHEX, ZPAD};

    fn sentinel() -> Vec<u8> {
        vec![ZPAD, ZPAD, ZDLE, ZHEX, b'0', b'0']
    }

    #[test]
    fn detects_the_sentinel_in_one_chunk() {
        let mut scanner = BatchStartScanner::new();
        let mut chunk = b"prompt\r\n".to_vec();
        chunk.extend_from_slice(&sentinel());
        chunk.extend_from_slice(b"0000000\r\n");
        assert!(scanner.feed(&chunk));
    }

    #[test]
    fn detects_the_sentinel_split_across_chunks() {
        let s = sentinel();
        let mut scanner = BatchStartScanner::new();
        assert!(!scanner.feed(b"prompt\r\n**"));
        assert!(!scanner.feed(&s[..4]));
        assert!(scanner.feed(&s[4..]));
    }

    #[test]
    fn keeps_only_real_prefixes_as_carry() {
        // A suffix that merely looks like `**` must not latch onto garbage.
        let mut scanner = BatchStartScanner::new();
        assert!(!scanner.feed(b"idle output **"));
        assert!(!scanner.feed(b"more text without a sentinel\r\n"));
        // The carry was dropped: the sentinel now has to appear in full.
        let mut chunk = b"x".to_vec();
        chunk.extend_from_slice(&sentinel());
        assert!(scanner.feed(&chunk));
    }

    #[test]
    fn stays_sticky_until_reset() {
        let mut scanner = BatchStartScanner::new();
        assert!(scanner.feed(&sentinel()));
        assert!(scanner.feed(b"anything"));
        scanner.reset();
        assert!(!scanner.feed(b"plain text"));
        let mut chunk = b"x".to_vec();
        chunk.extend_from_slice(&sentinel());
        assert!(scanner.feed(&chunk));
    }

    #[test]
    fn shell_text_never_trips_it() {
        let mut scanner = BatchStartScanner::new();
        for chunk in [
            "root@host:~$ ls\r\n".as_bytes(),
            "total 0\r\n".as_bytes(),
            &[b'*', b'*', 0x18][..],
        ] {
            assert!(!scanner.feed(chunk));
        }
    }
}

mod crc_interop {
    use super::super::{crc16, crc32, hex_header, ZDLE, ZHEX, ZPAD};

    #[test]
    fn crc16_matches_the_xmodem_reference_vector() {
        // CRC-16/XMODEM of "123456789" is 0x31C3. The previous reflected
        // implementation produced 0x6C0D, so no real sz ever accepted a
        // header from this receiver (it answered ZNAK instead).
        assert_eq!(crc16(b"123456789"), 0x31C3);
        assert_eq!(crc16(&[0, 0, 0, 0, 0]), 0);
    }

    #[test]
    fn crc32_matches_the_reference_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF43926);
    }

    #[test]
    fn zrinit_header_pins_the_interoperable_wire_format() {
        // type 1 (ZRINIT), flags CANFDX|CANOVIO = 3, CRC 0x9A32.
        let header = hex_header(1, 3);
        let mut expected = vec![ZPAD, ZPAD, ZDLE, ZHEX];
        expected.extend_from_slice(b"01000000039a32\r\n\x11");
        assert_eq!(header, expected);
    }
}

mod real_sz_frames {
    use super::super::{Action, ZmodemReceiver};

    /// Bytes captured from lrzsz `sz small.txt` on Alpine: ZRQINIT hex
    /// header (CR + high-bit LF + XON trailer), then the ZFILE binary
    /// header and its Fileinfo subpacket, up to the point where sz waits
    /// for our ZRPOS.
    const CAPTURE_HEX: &str = "2a2a184230303030303030303030303030300d8a112a184104000000008906736d616c6c2e747874003238203135333031313035343135203130303634342030203120323800186be44411";

    fn captured() -> Vec<u8> {
        let mut out = Vec::new();
        let bytes = CAPTURE_HEX.as_bytes();
        for pair in bytes.chunks(2) {
            let hi = (pair[0] as char).to_digit(16).unwrap() as u8;
            let lo = (pair[1] as char).to_digit(16).unwrap() as u8;
            out.push((hi << 4) | lo);
        }
        out
    }

    fn assert_flow(actions: &[Action], passthrough: &[u8]) {
        // Regression: the 0x8A trailer byte used to drop the parser back to
        // Scan, so the whole ZFILE frame leaked to the terminal and no file
        // was ever started.
        assert!(
            passthrough.is_empty(),
            "frame bytes leaked to the terminal: {:?}",
            String::from_utf8_lossy(passthrough)
        );
        let start = actions
            .iter()
            .find_map(|action| match action {
                Action::FileStart { name, size } => Some((name.clone(), *size)),
                _ => None,
            })
            .expect("FileStart must be emitted");
        assert_eq!(start, ("small.txt".to_string(), Some(28)));
        let writes: Vec<&Vec<u8>> = actions
            .iter()
            .filter_map(|action| match action {
                Action::WriteToRemote { data } => Some(data),
                _ => None,
            })
            .collect();
        assert!(
            writes
                .iter()
                .any(|data| data.starts_with(b"**\x18B01000000039a32")),
            "ZRINIT answer missing: {:?}",
            writes
        );
        assert!(
            writes.len() >= 2,
            "ZRPOS answer missing after FileStart: {:?}",
            writes
        );
    }

    #[test]
    fn real_sz_handshake_and_file_header_are_parsed() {
        let mut receiver = ZmodemReceiver::new();
        let feed = receiver.feed(&captured());
        assert_flow(&feed.actions, &feed.passthrough);
    }

    #[test]
    fn inter_frame_xon_padding_does_not_drop_to_scan() {
        use super::super::hex_header;
        let mut receiver = ZmodemReceiver::new();
        let feed = receiver.feed(&captured());
        assert_flow(&feed.actions, &feed.passthrough);
        // sz pads between frames with XON; it must not end the header state.
        let pad = receiver.feed(&[0x11]);
        assert!(pad.passthrough.is_empty());
        // The next header (ZEOF) must still be parsed, not leaked as text.
        let next = receiver.feed(&hex_header(0x0B, 0));
        assert!(
            next.passthrough.is_empty(),
            "inter-frame padding leaked the next frame: {:?}",
            String::from_utf8_lossy(&next.passthrough)
        );
    }

    #[test]
    fn real_sz_frame_survives_byte_by_byte_feeding() {
        let mut receiver = ZmodemReceiver::new();
        let mut actions = Vec::new();
        let mut passthrough = Vec::new();
        for byte in captured() {
            let feed = receiver.feed(&[byte]);
            actions.extend(feed.actions);
            passthrough.extend(feed.passthrough);
        }
        assert_flow(&actions, &passthrough);
    }
}
