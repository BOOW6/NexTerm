use tauri::{ipc::Response, AppHandle, Emitter, State};

use crate::fonts::{FontManager, SystemFontFace, SystemFontFamily};
use crate::pty::{PtyPlatformInfo, PtySessionManager};
use crate::ssh::{
    KnownHost, KnownHostsExportResult, KnownHostsImportResult, PortForwardInfo, SftpEntry,
    SftpTransferOptions, SshManager,
};
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
pub fn create_pty_session(
    app: AppHandle,
    state: State<'_, PtySessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    state
        .create_session(app, id, cols, rows)
        .map_err(|err| err.to_string())
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
pub fn resize_pty(
    state: State<'_, PtySessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .resize_session(&id, cols, rows)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn close_pty_session(state: State<'_, PtySessionManager>, id: String) -> Result<(), String> {
    state.close_session(&id).map_err(|err| err.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshManager>,
    id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: String,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    state
        .connect(
            app,
            id,
            host,
            port,
            username,
            auth_method,
            password,
            private_key_path,
            passphrase,
            cols,
            rows,
        )
        .await
        .map_err(|err| err.to_string())
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
pub fn sftp_pause_transfer(
    state: State<'_, SshManager>,
    transfer_id: String,
    paused: bool,
) -> Result<(), String> {
    state
        .set_transfer_paused(&transfer_id, paused)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn sftp_cancel_transfer(
    state: State<'_, SshManager>,
    transfer_id: String,
) -> Result<(), String> {
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

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|err| err.to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err("文件过大（上限 8 MiB）".to_string());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| err.to_string())?;
    Ok(decode_text(bytes))
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

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|err| err.to_string())
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
pub async fn vault_reset(state: State<'_, VaultManager>, app: AppHandle) -> Result<(), String> {
    state.reset().await.map_err(|err| err.to_string())?;
    let _ = app.emit("nexterm-vault-cleared", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::decode_text;

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
