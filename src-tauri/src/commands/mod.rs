use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Backend-held root directory for session output logs, synced from settings.
/// Every `log_path` crossing IPC must live underneath it, so a compromised
/// renderer cannot point session logging at arbitrary locations.
/// Window-level behavior synced from the settings store: whether the main
/// window hides to the tray instead of quitting on close.
#[derive(Default)]
pub struct WindowBehavior {
    pub(crate) close_to_tray: std::sync::atomic::AtomicBool,
}

#[tauri::command]
pub async fn set_window_behavior(
    app: AppHandle,
    close_to_tray: bool,
    global_show_hotkey: Option<String>,
) -> Result<(), String> {
    app.state::<WindowBehavior>()
        .close_to_tray
        .store(close_to_tray, std::sync::atomic::Ordering::SeqCst);

    // Re-register the global show/hide shortcut from scratch on every sync;
    // an empty value disables it entirely.
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all().map_err(|err| err.to_string())?;
    if let Some(hotkey) = global_show_hotkey
        .as_deref()
        .map(str::trim)
        .filter(|hotkey| !hotkey.is_empty())
    {
        let accelerator = hotkey
            .to_lowercase()
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .map_err(|err| format!("无效的全局快捷键 \"{hotkey}\": {err}"))?;
        shortcuts
            .register(accelerator)
            .map_err(|err| format!("全局快捷键注册失败: {err}"))?;
    }
    Ok(())
}

#[derive(Default)]
pub struct SessionLogRoot(Mutex<Option<PathBuf>>);

impl SessionLogRoot {
    fn set(&self, dir: Option<String>) {
        let normalized = dir
            .map(|dir| dir.trim().to_string())
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from);
        *self.0.lock().unwrap_or_else(|poison| poison.into_inner()) = normalized;
    }

    /// Returns `false` when logging was requested but the path has no
    /// configured root or escapes it.
    fn allows(&self, path: &Option<String>) -> bool {
        let Some(path) = path else {
            return true; // logging disabled — nothing to confine
        };
        let Some(root) = self
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
        else {
            return false;
        };
        validate_log_path(&root, path).is_ok()
    }
}

fn validate_log_path(root: &Path, path: &str) -> Result<(), String> {
    let path = PathBuf::from(path);
    let Some(file_name) = path.file_name() else {
        return Err("无效的日志文件名".to_string());
    };
    let name = file_name.to_string_lossy();
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err("日志文件名包含非法字符".to_string());
    }
    if path
        .extension()
        .map(|ext| !ext.eq_ignore_ascii_case("log"))
        .unwrap_or(true)
    {
        return Err("日志文件必须以 .log 结尾".to_string());
    }
    let Some(parent) = path.parent() else {
        return Err("无效的日志路径".to_string());
    };
    // Canonicalize both sides: a lexical prefix check would accept
    // `<root>\..\evil.log`.
    let canon_parent = parent
        .canonicalize()
        .map_err(|err| format!("日志目录不可用: {err}"))?;
    let canon_root = root
        .canonicalize()
        .map_err(|err| format!("日志目录不可用: {err}"))?;
    if !canon_parent.starts_with(&canon_root) {
        return Err("日志路径必须位于配置的日志目录内".to_string());
    }
    Ok(())
}

/// The frontend mirrors its configured log directory into the backend (both
/// windows may call it; last writer wins with identical values).
#[tauri::command]
pub fn set_session_log_root(state: State<'_, SessionLogRoot>, dir: Option<String>) {
    state.set(dir);
}

use crate::fonts::{FontManager, SystemFontFace, SystemFontFamily};
use crate::pty::{PtyPlatformInfo, PtySessionManager};
use crate::ssh::{
    JumpTarget, KnownHost, KnownHostsExportResult, KnownHostsImportResult, PortForwardInfo,
    SftpEntry, SftpTransferOptions, SshManager,
};
use crate::telnet::TelnetSessionManager;
use crate::vault::{VaultManager, VaultStatus};

#[tauri::command]
pub async fn fonts_list(state: State<'_, FontManager>) -> Result<Vec<SystemFontFamily>, String> {
    state.list_families().await
}

#[tauri::command]
pub async fn font_lookup(
    state: State<'_, FontManager>,
    family: String,
    style: Option<String>,
    weight: Option<u16>,
) -> Result<SystemFontFace, String> {
    state.lookup(&family, style.as_deref(), weight).await
}

#[tauri::command]
pub async fn font_data(
    state: State<'_, FontManager>,
    family: String,
    style: Option<String>,
    weight: Option<u16>,
) -> Result<Response, String> {
    state.font_data(&family, style.as_deref(), weight).await
}

#[tauri::command]
pub fn pty_platform_info(state: State<'_, PtySessionManager>) -> PtyPlatformInfo {
    state.platform_info()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_pty_session(
    app: AppHandle,
    state: State<'_, PtySessionManager>,
    log_root: State<'_, SessionLogRoot>,
    id: String,
    cols: u16,
    rows: u16,
    log_path: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
) -> Result<String, String> {
    let log_path = confine_log_path(&log_root, log_path);
    let pty_command = command.map(|program| crate::pty::PtyCommand {
        program,
        args: args.unwrap_or_default(),
    });
    state
        .create_session(app, id, cols, rows, log_path, pty_command)
        .await
        .map_err(|err| err.to_string())
}

/// Resolve which local shell candidates point at an existing executable.
/// Each result is the command to spawn (`None` = not found) and stays aligned
/// with the input order. Bare program names stay bare — `PATH` is consulted
/// again at spawn time — while explicit paths get `%VAR%` segments expanded.
#[tauri::command]
pub async fn probe_shell_availability(
    candidates: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    // Filesystem lookups (and a cold `PATH` scan on network drives) can block;
    // keep them off the IPC thread.
    tokio::task::spawn_blocking(move || candidates.iter().map(|c| resolve_executable(c)).collect())
        .await
        .map_err(|err| format!("shell probe failed: {err}"))
}

fn resolve_executable(candidate: &str) -> Option<String> {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return None;
    }
    let expanded = expand_env_vars(candidate);
    let path = Path::new(&expanded);
    if path.components().count() > 1 {
        return path.is_file().then_some(expanded);
    }
    if path.is_file() {
        return Some(expanded);
    }
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let mut entry = dir.join(&expanded);
        if cfg!(windows) && entry.extension().is_none() {
            entry.set_extension("exe");
        }
        if entry.is_file() {
            return Some(expanded);
        }
    }
    None
}

/// Locate Git for Windows' `bin\bash.exe` when it is installed somewhere other
/// than the standard `C:\Program Files\Git` (the installer allows any drive).
/// The registry `InstallPath` is authoritative; PATH entries ending in
/// `...\Git\cmd` / `...\Git\bin` are the fallback for installs that skipped the
/// registry (portable/extracted copies).
///
/// Returns `None` on non-Windows platforms and when no usable copy exists.
#[tauri::command]
pub async fn detect_git_bash() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(discover_git_bash)
        .await
        .map_err(|err| format!("git bash detection failed: {err}"))
}

#[cfg(windows)]
fn discover_git_bash() -> Option<String> {
    let mut roots = registry_git_roots();
    let path_entries: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    roots.extend(git_roots_from_path_entries(&path_entries));
    git_bash_from_roots(&roots, |candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn discover_git_bash() -> Option<String> {
    None
}

/// Derive install roots from PATH entries shaped like `<root>\Git\cmd` or
/// `<root>\Git\bin`. Kept free of Windows APIs so it is unit-testable.
#[cfg(windows)]
fn git_roots_from_path_entries(entries: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for entry in entries {
        let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.eq_ignore_ascii_case("cmd") && !name.eq_ignore_ascii_case("bin") {
            continue;
        }
        let Some(root) = entry.parent() else {
            continue;
        };
        let is_git_root = root
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("Git"))
            .unwrap_or(false);
        if is_git_root {
            roots.push(root.to_path_buf());
        }
    }
    roots
}

/// First `<root>\bin\bash.exe` that satisfies `exists`.
#[cfg(windows)]
fn git_bash_from_roots(roots: &[PathBuf], exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join("bin").join("bash.exe"))
        .find(|candidate| exists(candidate))
}

#[cfg(windows)]
fn registry_git_roots() -> Vec<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };

    fn read_install_path(hive: HKEY, subkey: &str) -> Option<PathBuf> {
        let subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
        let value: Vec<u16> = "InstallPath"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut buffer = [0u16; 512];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: both strings are NUL-terminated and outlive the call; the
        // buffer is sized in bytes and the API writes at most `size` bytes.
        let status = unsafe {
            RegGetValueW(
                hive,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let len = (size as usize / 2).saturating_sub(1);
        let path = String::from_utf16_lossy(&buffer[..len.min(buffer.len())]);
        let path = path.trim();
        (!path.is_empty()).then(|| PathBuf::from(path))
    }

    let mut roots = Vec::new();
    // HKLM covers machine-wide installs; the WOW6432Node view covers a 32-bit
    // Git on 64-bit Windows. HKCU covers per-user installs.
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for subkey in [
            "SOFTWARE\\GitForWindows",
            "SOFTWARE\\WOW6432Node\\GitForWindows",
        ] {
            if let Some(root) = read_install_path(hive, subkey) {
                roots.push(root);
            }
        }
    }
    roots
}

/// Expand `%NAME%` segments (Windows style) using process environment values;
/// unresolved or unterminated segments are kept literally.
fn expand_env_vars(input: &str) -> String {
    if !input.contains('%') {
        return input.to_string();
    }
    let mut result = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('%') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            break;
        };
        let name = &after[..end];
        match std::env::var(name) {
            Ok(value) => {
                result.push_str(&rest[..start]);
                result.push_str(&value);
            }
            Err(_) => {
                let literal_end = start + end + 2;
                result.push_str(&rest[..literal_end]);
            }
        }
        rest = &after[end + 1..];
    }
    result.push_str(rest);
    result
}

#[tauri::command]
pub async fn write_pty(
    state: State<'_, PtySessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state
        .write_session(&id, data.into_bytes())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn resize_pty(
    state: State<'_, PtySessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .resize_session(&id, cols, rows)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn close_pty_session(
    state: State<'_, PtySessionManager>,
    id: String,
) -> Result<(), String> {
    state
        .close_session(&id)
        .await
        .map_err(|err| err.to_string())
}

/// A rejected log path only downgrades logging (with a console warning) —
/// it must never fail the session itself.
fn confine_log_path(log_root: &SessionLogRoot, log_path: Option<String>) -> Option<String> {
    if log_root.allows(&log_path) {
        return log_path;
    }
    eprintln!("[session-log] rejecting log path outside the configured log root");
    None
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshManager>,
    log_root: State<'_, SessionLogRoot>,
    id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    // Optional: agent / key / certificate authentication never reads it, and
    // requiring the field forced every non-frontend caller to send "".
    password: Option<String>,
    private_key_path: Option<String>,
    cert_path: Option<String>,
    passphrase: Option<String>,
    jump: Option<JumpTarget>,
    log_path: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let log_path = confine_log_path(&log_root, log_path);
    state
        .connect(
            app,
            id,
            host,
            port,
            username,
            auth_method,
            password.unwrap_or_default(),
            private_key_path,
            cert_path,
            passphrase,
            jump,
            log_path,
            cols,
            rows,
        )
        .await
        .map_err(|err| err.to_string())
}

/// Re-point the output log of a live session (SSH, local PTY, Telnet or
/// serial). The transports use distinct id spaces, so all managers are probed.
#[tauri::command]
pub async fn set_session_log(
    ssh: State<'_, SshManager>,
    pty: State<'_, PtySessionManager>,
    telnet: State<'_, TelnetSessionManager>,
    serial: State<'_, crate::serial::SerialSessionManager>,
    log_root: State<'_, SessionLogRoot>,
    id: String,
    log_path: Option<String>,
) -> Result<(), String> {
    // Explicit user action: a confined-out path is reported, not silently
    // downgraded.
    if !log_root.allows(&log_path) {
        return Err("日志路径必须位于配置的日志目录内".to_string());
    }
    if ssh.set_log(&id, log_path.as_deref()).is_ok() {
        return Ok(());
    }
    if pty.set_log(&id, log_path.as_deref()).await.is_ok() {
        return Ok(());
    }
    if telnet.set_log(&id, log_path.as_deref()).is_ok() {
        return Ok(());
    }
    if serial.set_log(&id, log_path.as_deref()).is_ok() {
        return Ok(());
    }
    Err("session not found".to_string())
}

#[tauri::command]
pub async fn serial_list(
    state: State<'_, crate::serial::SerialSessionManager>,
) -> Result<Vec<crate::serial::SerialPortInfo>, String> {
    state.list_ports().await.map_err(|err| err.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn serial_connect(
    app: AppHandle,
    state: State<'_, crate::serial::SerialSessionManager>,
    log_root: State<'_, SessionLogRoot>,
    id: String,
    port_name: String,
    baud: u32,
    data_bits: Option<String>,
    parity: Option<String>,
    stop_bits: Option<String>,
    flow_control: Option<String>,
    log_path: Option<String>,
) -> Result<String, String> {
    let log_path = confine_log_path(&log_root, log_path);
    let parse = |value: Option<String>, default: &'static str| -> String {
        value
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default.to_string())
    };
    state
        .connect(
            app,
            id,
            port_name,
            baud,
            parse(data_bits, "eight"),
            parse(parity, "none"),
            parse(stop_bits, "one"),
            parse(flow_control, "none"),
            log_path,
        )
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn serial_write(
    state: State<'_, crate::serial::SerialSessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state
        .write(&id, data.into_bytes().as_slice())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn serial_resize(
    state: State<'_, crate::serial::SerialSessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn serial_disconnect(
    state: State<'_, crate::serial::SerialSessionManager>,
    id: String,
) -> Result<(), String> {
    state.disconnect(&id).await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn telnet_connect(
    app: AppHandle,
    state: State<'_, TelnetSessionManager>,
    log_root: State<'_, SessionLogRoot>,
    id: String,
    host: String,
    port: u16,
    log_path: Option<String>,
) -> Result<String, String> {
    let log_path = confine_log_path(&log_root, log_path);
    state
        .connect(app, id, host, port, log_path)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn telnet_write(
    state: State<'_, TelnetSessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state
        .write(&id, data.as_bytes())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn telnet_resize(
    state: State<'_, TelnetSessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn telnet_disconnect(
    state: State<'_, TelnetSessionManager>,
    id: String,
) -> Result<(), String> {
    state.disconnect(&id).await.map_err(|err| err.to_string())
}

#[tauri::command]
pub fn ssh_host_key_response(state: State<'_, SshManager>, request_id: String, accept: bool) {
    state.resolve_host_key(&request_id, accept);
}

#[tauri::command]
pub fn known_hosts_list(state: State<'_, SshManager>) -> Result<Vec<KnownHost>, String> {
    state.known_hosts().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn known_hosts_remove(state: State<'_, SshManager>, host: String) -> Result<(), String> {
    state
        .remove_known_host(&host)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, SshManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state
        .write(&id, data.as_bytes())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, SshManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .resize(&id, cols, rows)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, SshManager>,
    id: String,
) -> Result<(), String> {
    state
        .disconnect(app, &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    state
        .sftp_list(&id, path)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SshManager>,
    id: String,
    remote_path: String,
    local_path: String,
    options: SftpTransferOptions,
) -> Result<String, String> {
    state
        .sftp_download(app, &id, remote_path, local_path, options)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SshManager>,
    id: String,
    local_path: String,
    remote_path: String,
    options: SftpTransferOptions,
) -> Result<String, String> {
    state
        .sftp_upload(app, &id, local_path, remote_path, options)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_pause_transfer(
    state: State<'_, SshManager>,
    transfer_id: String,
    paused: bool,
) -> Result<(), String> {
    if transfer_id.starts_with("zmodem-") {
        return Err("ZMODEM 传输不支持暂停".to_string());
    }
    state
        .set_transfer_paused(&transfer_id, paused)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, SshManager>,
    transfer_id: String,
) -> Result<(), String> {
    // ZMODEM receives share the transfer queue; their ids carry the session.
    if let Some(session_id) = transfer_id.strip_prefix("zmodem-") {
        return state
            .cancel_zmodem(session_id)
            .await
            .map_err(|err| err.to_string());
    }
    state
        .cancel_transfer(&transfer_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn sftp_conflict_response(
    state: State<'_, SshManager>,
    request_id: String,
    action: String,
    apply_to_all: bool,
) -> Result<(), String> {
    state.resolve_sftp_conflict(&request_id, &action, apply_to_all);
    Ok(())
}

#[tauri::command]
pub fn known_hosts_import(
    state: State<'_, SshManager>,
    path: String,
) -> Result<KnownHostsImportResult, String> {
    state
        .import_known_hosts(&path)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn known_hosts_export(
    state: State<'_, SshManager>,
    path: String,
    hash_hosts: bool,
) -> Result<KnownHostsExportResult, String> {
    state
        .export_known_hosts(&path, hash_hosts)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn port_forward_list(state: State<'_, SshManager>) -> Vec<PortForwardInfo> {
    state.list_port_forwards()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn port_forward_start(
    app: AppHandle,
    state: State<'_, SshManager>,
    ssh_id: String,
    kind: String,
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<PortForwardInfo, String> {
    state
        .start_port_forward(
            app,
            ssh_id,
            kind,
            bind_host,
            bind_port,
            target_host,
            target_port,
        )
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn port_forward_stop(
    app: AppHandle,
    state: State<'_, SshManager>,
    id: String,
) -> Result<(), String> {
    state
        .stop_port_forward(app, &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SshManager>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    state
        .sftp_remove(&id, path, is_dir)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SshManager>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    state
        .sftp_rename(&id, from, to)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    state
        .sftp_mkdir(&id, path)
        .await
        .map_err(|err| err.to_string())
}

/// Backend-driven session import. The file path never crosses the IPC
/// boundary: the dialog is opened from Rust and the picked file is read here,
/// so no renderer context can use this command to read arbitrary files.
#[tauri::command]
pub async fn import_sessions(
    app: AppHandle,
    format: String,
    title: Option<String>,
) -> Result<Option<String>, String> {
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    tokio::task::spawn_blocking(move || {
        let mut picker = app.dialog().file();
        picker = match format.as_str() {
            "putty" => picker.add_filter("PuTTY registry export", &["reg"]),
            "mobaxterm" => picker.add_filter("MobaXterm sessions", &["ini", "mxtsessions"]),
            "nexterm" => picker.add_filter("NexTerm backup", &["json"]),
            // ssh-config: any text file may hold the config.
            _ => picker,
        };
        if let Some(title) = title.as_deref() {
            picker = picker.set_title(title);
        }
        let Some(selected) = picker.blocking_pick_file() else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|err| err.to_string())?;
        let metadata = std::fs::metadata(&path).map_err(|err| err.to_string())?;
        if metadata.len() > MAX_BYTES {
            return Err("文件过大（上限 8 MiB）".to_string());
        }
        let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
        Ok(Some(decode_text(bytes)))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Import files such as PuTTY `.reg` exports are commonly UTF-16LE with a BOM,
/// while SSH config and MobaXterm `.ini` are usually UTF-8. Handle both.
fn decode_text(bytes: Vec<u8>) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16(&bytes[2..], false);
    }
    let sample = &bytes[..bytes.len().min(200)];
    let nul_bytes = sample.iter().filter(|byte| **byte == 0).count();
    if nul_bytes > sample.len() / 4 {
        return decode_utf16(&bytes, true);
    }
    String::from_utf8_lossy(&bytes)
        .trim_start_matches('\u{feff}')
        .to_string()
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let (chunks, _) = bytes.as_chunks::<2>();
    let units: Vec<u16> = chunks
        .iter()
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes(*chunk)
            } else {
                u16::from_be_bytes(*chunk)
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// Backend-driven session export. The save dialog and the write both happen
/// in Rust; the renderer only hands over the serialized backup contents.
#[tauri::command]
pub async fn export_sessions(
    app: AppHandle,
    contents: String,
    title: Option<String>,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let mut saver = app
            .dialog()
            .file()
            .add_filter("JSON", &["json"])
            .set_file_name("nexterm-sessions.json");
        if let Some(title) = title.as_deref() {
            saver = saver.set_title(title);
        }
        let Some(selected) = saver.blocking_save_file() else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|err| err.to_string())?;
        std::fs::write(&path, contents).map_err(|err| err.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn vault_status(state: State<'_, VaultManager>) -> VaultStatus {
    state.status()
}

#[tauri::command]
pub async fn vault_initialize(
    state: State<'_, VaultManager>,
    app: AppHandle,
    master_password: String,
) -> Result<VaultStatus, String> {
    let status = state
        .initialize(&master_password)
        .await
        .map_err(|err| err.to_string())?;
    let _ = app.emit("nexterm-vault-unlocked", ());
    Ok(status)
}

#[tauri::command]
pub async fn vault_unlock(
    state: State<'_, VaultManager>,
    app: AppHandle,
    master_password: String,
) -> Result<bool, String> {
    let unlocked = state
        .unlock(&master_password)
        .await
        .map_err(|err| err.to_string())?;
    if unlocked {
        let _ = app.emit("nexterm-vault-unlocked", ());
    }
    Ok(unlocked)
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, VaultManager>, app: AppHandle) -> Result<(), String> {
    state.lock().await;
    let _ = app.emit("nexterm-vault-locked", ());
    Ok(())
}

#[tauri::command]
pub async fn vault_set(
    state: State<'_, VaultManager>,
    name: String,
    secret: String,
) -> Result<(), String> {
    state
        .set(&name, &secret)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn vault_get(state: State<'_, VaultManager>, name: String) -> Result<Option<String>, String> {
    state.get(&name).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn vault_delete(state: State<'_, VaultManager>, name: String) -> Result<(), String> {
    state.delete(&name).await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn vault_clear(state: State<'_, VaultManager>, app: AppHandle) -> Result<(), String> {
    state.clear().await.map_err(|err| err.to_string())?;
    let _ = app.emit("nexterm-vault-cleared", ());
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password(
    state: State<'_, VaultManager>,
    app: AppHandle,
    old_password: String,
    new_password: String,
) -> Result<VaultStatus, String> {
    let status = state
        .change_password(&old_password, &new_password)
        .await
        .map_err(|err| err.to_string())?;
    let _ = app.emit("nexterm-vault-unlocked", ());
    Ok(status)
}

#[tauri::command]
pub async fn vault_reset(
    state: State<'_, VaultManager>,
    app: AppHandle,
    master_password: Option<String>,
) -> Result<(), String> {
    state
        .reset(master_password.as_deref())
        .await
        .map_err(|err| err.to_string())?;
    let _ = app.emit("nexterm-vault-cleared", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decode_text, expand_env_vars, resolve_executable};

    #[test]
    fn shell_probe_rejects_empty_candidates() {
        assert_eq!(resolve_executable(""), None);
        assert_eq!(resolve_executable("   "), None);
    }

    #[test]
    fn shell_probe_reports_missing_bare_name() {
        assert_eq!(
            resolve_executable("definitely-not-a-real-shell-3f9a2b"),
            None
        );
    }

    #[test]
    fn shell_probe_resolves_current_shell() {
        // On Windows cmd.exe always exists; on Unix sh does for any
        // environment that can run this test suite.
        let candidate = if cfg!(windows) { "cmd.exe" } else { "sh" };
        let resolved = resolve_executable(candidate);
        assert_eq!(resolved.as_deref(), Some(candidate));
    }

    #[test]
    fn shell_probe_expands_environment_variables() {
        // PATH exists in every environment that runs this suite.
        let expanded = expand_env_vars("%PATH%");
        assert_ne!(expanded, "%PATH%");
        assert!(expanded.contains(':') || expanded.contains(';'));
        assert_eq!(
            expand_env_vars("%NEXTERM_PROBE_TEST_UNDEFINED_VAR%"),
            "%NEXTERM_PROBE_TEST_UNDEFINED_VAR%"
        );
        assert_eq!(expand_env_vars("no variables here"), "no variables here");
        assert_eq!(
            expand_env_vars("trailing percent 100%"),
            "trailing percent 100%"
        );
    }

    #[test]
    fn decodes_utf8_with_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("Host prod".as_bytes());
        assert_eq!(decode_text(bytes), "Host prod");
    }

    #[test]
    fn decodes_utf16le_with_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "Host prod".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text(bytes), "Host prod");
    }

    #[test]
    fn detects_utf16le_without_bom() {
        let mut bytes = Vec::new();
        for unit in "Windows Registry Editor Version 5.00".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text(bytes), "Windows Registry Editor Version 5.00");
    }
}

#[cfg(all(test, windows))]
mod git_bash_tests {
    use std::path::{Path, PathBuf};

    use super::{git_bash_from_roots, git_roots_from_path_entries};

    fn paths(entries: &[&str]) -> Vec<PathBuf> {
        entries.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn derives_install_root_from_git_cmd_on_path() {
        let roots = git_roots_from_path_entries(&paths(&[
            r"D:\Program Files\Git\cmd",
            r"C:\Windows\System32",
            r"D:\Program Files\Git\bin",
            r"C:\Tools\Git\cmd",
            r"D:\GitStuff\cmd",
        ]));
        assert_eq!(
            roots,
            paths(&[
                r"D:\Program Files\Git",
                r"D:\Program Files\Git",
                r"C:\Tools\Git",
            ])
        );
    }

    #[test]
    fn git_bash_picks_the_first_root_with_a_bash_binary() {
        let roots = paths(&[r"C:\Missing\Git", r"D:\Program Files\Git"]);
        let found = git_bash_from_roots(&roots, |candidate| {
            candidate == Path::new(r"D:\Program Files\Git\bin\bash.exe")
        });
        assert_eq!(
            found,
            Some(PathBuf::from(r"D:\Program Files\Git\bin\bash.exe"))
        );
    }

    #[test]
    fn git_bash_returns_none_when_no_root_has_bash() {
        let roots = paths(&[r"C:\Missing\Git"]);
        assert_eq!(git_bash_from_roots(&roots, |_| false), None);
    }
}
