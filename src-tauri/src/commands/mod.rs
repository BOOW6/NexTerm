use tauri::{AppHandle, State};

use crate::pty::PtySessionManager;

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
    state.write_session(&id, data.as_bytes())
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
