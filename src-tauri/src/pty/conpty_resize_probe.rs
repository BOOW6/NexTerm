//! Diagnostic probe for the bundled ConPTY's resize byte stream. Run with:
//! `cargo test --manifest-path src-tauri/Cargo.toml conpty_resize_byte_stream_probe -- --ignored --nocapture`
//!
//! It boots cmd.exe at 100x30, resizes through a narrow width and back while
//! recording every byte the PTY emits, then types a command to reveal where
//! ConPTY thinks the cursor ended up after its rewrap. Nothing is asserted —
//! the point is the escaped byte dump.

#![cfg(all(windows, test))]

use std::{
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn escape(data: &[u8]) -> String {
    let mut out = String::new();
    for &b in data {
        match b {
            b'\r' => out.push_str("\\r"),
            b'\n' => out.push_str("\\n"),
            0x1b => out.push_str("\\e"),
            0x20..=0x7e => out.push(b as char),
            _ => out.push_str(&format!("\\x{b:02x}")),
        }
    }
    out
}

/// Load the bundled conpty.dll/OpenConsole.exe the same way
/// `conpty_bundle::install` does, so the probe exercises the same backend.
fn load_bundled_conpty() -> Result<(), anyhow::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::LibraryLoader::LoadLibraryW;

    let dir = std::env::temp_dir()
        .join("nexterm-conpty-probe")
        .join(conpty_assets::VERSION);
    std::fs::create_dir_all(&dir)?;
    let dll = dir.join("conpty.dll");
    std::fs::write(&dll, conpty_assets::x64::CONPTY_DLL)?;
    std::fs::write(
        dir.join("OpenConsole.exe"),
        conpty_assets::x64::OPENCONSOLE_EXE,
    )?;
    let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())) }
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!("failed to load {}: {error}", dll.display()))
}

#[test]
#[ignore]
fn conpty_resize_byte_stream_probe() {
    load_bundled_conpty().expect("bundled conpty");

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let mut child = pair
        .slave
        .spawn_command(CommandBuilder::new("cmd.exe"))
        .expect("spawn cmd");
    let mut reader = pair.master.try_clone_reader().expect("clone reader");

    let log: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let log_thread = log.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => log_thread
                    .lock()
                    .unwrap()
                    .extend_from_slice(&buffer[..size]),
            }
        }
    });

    let mut printed = 0_usize;
    let mut segment = |label: &str, settle_ms: u64| {
        std::thread::sleep(Duration::from_millis(settle_ms));
        let data = log.lock().unwrap()[printed..].to_vec();
        printed += data.len();
        println!("=== {label} ({} bytes) ===\n{}", data.len(), escape(&data));
    };

    segment("boot 100x30 (prompt)", 1500);

    pair.master
        .resize(PtySize {
            rows: 30,
            cols: 12,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("resize narrow");
    segment("resize -> 12x30", 1200);

    let mut writer = pair.master.take_writer().expect("writer");
    writer.write_all(b"X").expect("write X");
    writer.flush().expect("flush");
    segment("typed X at 12 cols (conhost cursor view)", 800);

    pair.master
        .resize(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("resize wide");
    segment("resize -> 100x30", 1200);

    writer.write_all(b"Y").expect("write Y");
    writer.flush().expect("flush");
    segment("typed Y at 100 cols (conhost cursor view)", 800);

    writer.write_all(b"echo MARKER1\r\n").expect("write");
    writer.flush().expect("flush");
    segment("typed echo MARKER1", 1200);

    let _ = child.kill();
}
