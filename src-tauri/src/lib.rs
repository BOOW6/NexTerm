pub mod commands;
pub mod pty;
pub mod ssh;

use pty::PtySessionManager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(PtySessionManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_pty_session,
            commands::write_pty,
            commands::resize_pty
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
