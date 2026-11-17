//! Ships the ConPTY redistributable next to the app so portable-pty sidesteps
//! the OS ConPTY's resize reprint behavior.
//!
//! The system ConPTY on Windows 11 ignores `PSEUDOCONSOLE_RESIZE_QUIRK` and
//! reprints the whole screen on every resize. xterm.js already reflows its own
//! buffer, so that reprint is what causes duplicated/ghosted rows. The newer
//! Microsoft ConPTY honors the quirk: it emits only a cursor-line repaint
//! (CUP, erase, CUP, text plus padding, CUP), matching VS Code's "ship
//! conpty.dll" approach (microsoft/vscode#224488). The terminal must still
//! reflow the cursor line locally; the padding is clipped with autowrap off so
//! it cannot scroll the viewport when the prompt is on the last row.

#[cfg(all(windows, target_arch = "x86_64"))]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};

    use anyhow::{anyhow, Context};
    use tauri::{AppHandle, Manager};
    use windows::core::PCWSTR;
    use windows::Win32::System::LibraryLoader::LoadLibraryW;

    static BUNDLED_CONPTY_LOADED: AtomicBool = AtomicBool::new(false);

    pub fn install(app: &AppHandle) {
        if let Err(error) = try_install(app) {
            eprintln!("[conpty] bundled ConPTY unavailable, using system ConPTY: {error:#}");
        }
    }

    fn is_loaded() -> bool {
        BUNDLED_CONPTY_LOADED.load(Ordering::Relaxed)
    }

    pub fn reported_build_number(os_build: Option<u32>) -> Option<u32> {
        if is_loaded() {
            // The bundled ConPTY supports native reflow and the resize quirk
            // semantics introduced after build 21376. Tell xterm it may reflow
            // locally even on older OS builds.
            Some(os_build.unwrap_or(0).max(21376))
        } else {
            os_build
        }
    }

    /// SHA-256 of the bundled binaries (see THIRD_PARTY_NOTICES.md). The
    /// runtime verifies the on-disk copy against these before loading, so a
    /// corrupted or swapped file is re-extracted instead of loaded.
    const CONPTY_DLL_SHA256: &str =
        "feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a";
    const OPENCONSOLE_EXE_SHA256: &str =
        "3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586";

    fn try_install(app: &AppHandle) -> anyhow::Result<()> {
        let base = app
            .path()
            .app_local_data_dir()
            .context("failed to resolve app local data directory")?;
        let dir = base.join("conpty").join(conpty_assets::VERSION);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;

        write_if_needed(
            &dir.join("conpty.dll"),
            conpty_assets::x64::CONPTY_DLL,
            CONPTY_DLL_SHA256,
        )?;
        write_if_needed(
            &dir.join("OpenConsole.exe"),
            conpty_assets::x64::OPENCONSOLE_EXE,
            OPENCONSOLE_EXE_SHA256,
        )?;
        let license = dir.join("LICENSE-MICROSOFT.txt");
        if !license.exists() {
            std::fs::write(&license, conpty_assets::MICROSOFT_LICENSE)
                .context("failed to write ConPTY license")?;
        }

        load_dll(&dir.join("conpty.dll"))?;
        BUNDLED_CONPTY_LOADED.store(true, Ordering::Relaxed);
        #[cfg(debug_assertions)]
        eprintln!(
            "[conpty] using bundled Microsoft ConPTY {}",
            conpty_assets::VERSION
        );
        Ok(())
    }

    fn write_if_needed(path: &Path, bytes: &[u8], expected_sha256: &str) -> anyhow::Result<()> {
        if std::fs::metadata(path).is_ok() {
            let on_disk = std::fs::read(path)
                .map(|contents| sha256_hex(&contents))
                .unwrap_or_default();
            if on_disk == expected_sha256 {
                return Ok(());
            }
            eprintln!(
                "[conpty] {} failed the integrity check; re-extracting",
                path.display()
            );
        }
        std::fs::write(path, bytes)
            .with_context(|| format!("failed to write {}", path.display()))?;
        let actual = std::fs::read(path)
            .map(|contents| sha256_hex(&contents))
            .unwrap_or_default();
        if actual != expected_sha256 {
            // Never load a binary we cannot verify: install() falls back to
            // the system ConPTY with a loud warning.
            return Err(anyhow!(
                "{} failed the post-extraction integrity check",
                path.display()
            ));
        }
        Ok(())
    }

    /// Minimal SHA-256 (FIPS 180-4) so the integrity check needs no extra
    /// dependency. Verified in tests against the standard vectors.
    pub fn sha256_hex(bytes: &[u8]) -> String {
        let mut state: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
            0x5be0cd19,
        ];

        let bit_len = (bytes.len() as u64).wrapping_mul(8);
        let mut message = bytes.to_vec();
        message.push(0x80);
        while message.len() % 64 != 56 {
            message.push(0);
        }
        message.extend_from_slice(&bit_len.to_be_bytes());

        let mut chunk = [0u8; 64];
        for block in message.as_chunks::<64>().0 {
            chunk.copy_from_slice(block);
            let mut w = [0u32; 64];
            for (i, word) in w.iter_mut().take(16).enumerate() {
                *word = u32::from_be_bytes([
                    chunk[i * 4],
                    chunk[i * 4 + 1],
                    chunk[i * 4 + 2],
                    chunk[i * 4 + 3],
                ]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16]
                    .wrapping_add(s0)
                    .wrapping_add(w[i - 7])
                    .wrapping_add(s1);
            }

            let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let choose = (e & f) ^ ((!e) & g);
                let temp1 = h
                    .wrapping_add(s1)
                    .wrapping_add(choose)
                    .wrapping_add(K[i])
                    .wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let majority = (a & b) ^ (a & c) ^ (b & c);
                let temp2 = s0.wrapping_add(majority);

                h = g;
                g = f;
                f = e;
                e = d.wrapping_add(temp1);
                d = c;
                c = b;
                b = a;
                a = temp1.wrapping_add(temp2);
            }

            for (word, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
                *word = word.wrapping_add(value);
            }
        }

        state.iter().map(|word| format!("{word:08x}")).collect()
    }

    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    fn load_dll(path: &Path) -> anyhow::Result<()> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())) }
            .map(|_| ())
            .map_err(|error| anyhow!("failed to load {}: {error}", path.display()))
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
mod imp {
    use tauri::AppHandle;

    pub fn install(_app: &AppHandle) {}

    // Only `#[cfg(windows)]` callers reference this; compiling it on other
    // targets trips `-D warnings` (dead_code + unused re-export).
    #[cfg(windows)]
    pub fn reported_build_number(os_build: Option<u32>) -> Option<u32> {
        os_build
    }
}

pub use imp::install;

#[cfg(windows)]
pub use imp::reported_build_number;

#[cfg(all(test, windows, target_arch = "x86_64"))]
mod tests {
    use super::imp::sha256_hex;

    #[test]
    fn sha256_matches_standard_vectors() {
        // FIPS 180-4 test vectors.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }
}
