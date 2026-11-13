pub mod commands;
pub mod fonts;
pub mod log_sink;
pub mod pty;
pub mod ssh;
pub mod telnet;
pub mod text_stream;
pub mod vault;
pub mod windows;
pub mod windows_ext;

use fonts::FontManager;
use pty::PtySessionManager;
use ssh::SshManager;
use tauri::{Manager, WindowEvent};
use tauri_plugin_decorum::WebviewWindowExt;
use vault::VaultManager;
use windows::ModalManager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_decorum::init())
        .manage(PtySessionManager::default())
        .manage(telnet::TelnetSessionManager::default())
        .manage(commands::SessionLogRoot::default())
        .manage(ModalManager::default())
        .manage(FontManager::default())
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

            // Without a usable config directory the known-hosts store stays
            // in memory only (TOFU re-prompts every session) instead of
            // silently degrading to a world-readable temp file — same policy
            // as the vault below.
            let known_hosts_path = app.path().app_config_dir().ok().and_then(|dir| {
                std::fs::create_dir_all(&dir).ok()?;
                Some(dir.join("known_hosts.json"))
            });
            app.manage(SshManager::new(known_hosts_path));

            // Without a config directory the vault refuses to operate (the
            // manager reports clear errors) instead of silently degrading to
            // a temp directory that periodic cleanups may wipe.
            let vault_path = app.path().app_config_dir().ok().and_then(|dir| {
                std::fs::create_dir_all(&dir).ok()?;
                Some(dir.join("credentials.vault.json"))
            });
            app.manage(VaultManager::new(vault_path));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fonts_list,
            commands::font_lookup,
            commands::font_data,
            commands::pty_platform_info,
            commands::probe_shell_availability,
            commands::create_pty_session,
            commands::write_pty,
            commands::resize_pty,
            commands::close_pty_session,
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::set_session_log,
            commands::set_session_log_root,
            commands::telnet_connect,
            commands::telnet_write,
            commands::telnet_resize,
            commands::telnet_disconnect,
            commands::ssh_host_key_response,
            commands::known_hosts_list,
            commands::known_hosts_remove,
            commands::known_hosts_import,
            commands::known_hosts_export,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_mkdir,
            commands::sftp_pause_transfer,
            commands::sftp_cancel_transfer,
            commands::sftp_conflict_response,
            commands::port_forward_list,
            commands::port_forward_start,
            commands::port_forward_stop,
            commands::import_sessions,
            commands::export_sessions,
            commands::vault_status,
            commands::vault_initialize,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_set,
            commands::vault_get,
            commands::vault_delete,
            commands::vault_clear,
            commands::vault_change_password,
            commands::vault_reset,
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
