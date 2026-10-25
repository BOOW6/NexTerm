//! Ships the ConPTY redistributable next to the app so portable-pty sidesteps
//! the OS ConPTY's resize reprint behavior.
//!
//! The system ConPTY on Windows 11 ignores `PSEUDOCONSOLE_RESIZE_QUIRK` and
//! reprints the whole screen on every resize. xterm.js already reflows its own
//! buffer, so that reprint is what causes duplicated/ghosted rows. The newer
//! Microsoft ConPTY honors the quirk (no output on resize), matching VS Code's
//! "ship conpty.dll" approach (microsoft/vscode#224488).

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

    fn try_install(app: &AppHandle) -> anyhow::Result<()> {
        let base = app
            .path()
            .app_local_data_dir()
            .context("failed to resolve app local data directory")?;
        let dir = base.join("conpty").join(conpty_assets::VERSION);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;

        write_if_needed(&dir.join("conpty.dll"), conpty_assets::x64::CONPTY_DLL)?;
        write_if_needed(
            &dir.join("OpenConsole.exe"),
            conpty_assets::x64::OPENCONSOLE_EXE,
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

    fn write_if_needed(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
        match std::fs::metadata(path) {
            Ok(meta) if meta.len() == bytes.len() as u64 => Ok(()),
            _ => std::fs::write(path, bytes)
                .with_context(|| format!("failed to write {}", path.display())),
        }
    }

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
