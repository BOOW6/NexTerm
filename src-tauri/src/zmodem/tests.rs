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
    assert!(everything.ends_with(b"zz trailing"));
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
