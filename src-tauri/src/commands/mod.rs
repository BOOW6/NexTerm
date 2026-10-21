use tauri::{ipc::Response, AppHandle, State};

use crate::fonts::{FontManager, SystemFontFace, SystemFontFamily};
use crate::pty::{PtyPlatformInfo, PtySessionManager};
use crate::ssh::{
    KnownHost, KnownHostsExportResult, KnownHostsImportResult, PortForwardInfo, SftpEntry,
    SftpTransferOptions, SshManager,
};

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
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    state
        .create_session(app, cols, rows)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn write_pty(
    state: State<'_, PtySessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state
        .write_session(&id, data.as_bytes())
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
