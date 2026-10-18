pub mod commands;
pub mod pty;
pub mod ssh;
pub mod windows;
pub mod windows_ext;

use pty::PtySessionManager;
use ssh::SshManager;
use tauri::{Manager, WindowEvent};
use tauri_plugin_decorum::WebviewWindowExt;
use windows::ModalManager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_decorum::init())
        .manage(PtySessionManager::default())
        .manage(ModalManager::default())
        .setup(|app| {
            // Load the bundled ConPTY before the first PTY session is created.
            pty::conpty_bundle::install(app.handle());

            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }

            if let Some(window) = app.get_webview_window("main") {
                windows_ext::disable_webview_autofill(&window);
                windows::install_context_menu_listener(&window);
                let _ = window.create_overlay_titlebar();

                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::CloseRequested { .. }) {
                        for (label, child) in app_handle.webview_windows() {
                            if label != "main" {
                                let _ = child.close();
                            }
                        }
                    }
                });
            }

            let known_hosts_path = app
                .path()
                .app_config_dir()
                .map(|dir| {
                    let _ = std::fs::create_dir_all(&dir);
                    dir.join("known_hosts.json")
                })
                .unwrap_or_else(|_| std::env::temp_dir().join("nexterm-known_hosts.json"));

            app.manage(SshManager::new(known_hosts_path));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_platform_info,
            commands::create_pty_session,
            commands::write_pty,
            commands::resize_pty,
            commands::close_pty_session,
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::ssh_host_key_response,
            commands::known_hosts_list,
            commands::known_hosts_remove,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_mkdir,
            windows::show_context_menu,
            windows::show_input_context_menu,
            windows::open_modal_window,
            windows::get_modal_payload,
            windows::submit_modal,
            windows::cancel_modal,
            windows::open_settings_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
