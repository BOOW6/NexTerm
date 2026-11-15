pub mod commands;
pub mod fonts;
pub mod log_sink;
pub mod pty;
mod remote_edit;
mod serial;
pub mod ssh;
pub mod telnet;
pub mod text_stream;
mod themes;
pub mod vault;
pub mod windows;
pub mod windows_ext;
mod zmodem;

use fonts::FontManager;
use pty::PtySessionManager;
use ssh::SshManager;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    Manager, WindowEvent,
};
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let visible = window.is_visible().unwrap_or(false);
                            let focused = window.is_focused().unwrap_or(false);
                            if visible && focused {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .manage(commands::WindowBehavior::default())
        .manage(serial::SerialSessionManager::default())
        .manage(telnet::TelnetSessionManager::default())
        .manage(commands::SessionLogRoot::default())
        .manage(ModalManager::default())
        .manage(FontManager::default())
        .manage(remote_edit::RemoteEditManager::default())
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
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        for (label, child) in app_handle.webview_windows() {
                            if label != "main" {
                                let _ = child.close();
                            }
                        }
                        // The tray setting is applied by the frontend via
                        // set_window_behavior; default stays "really quit".
                        let behavior = app_handle.state::<commands::WindowBehavior>();
                        if behavior
                            .close_to_tray
                            .load(std::sync::atomic::Ordering::SeqCst)
                        {
                            api.prevent_close();
                            let _ = app_handle.get_webview_window("main").map(|w| w.hide());
                        }
                    }
                });
            }

            // System tray: quick launcher + quit (menu labels follow the
            // codebase-wide Chinese UI strings).
            {
                let show = MenuItem::with_id(app, "tray-show", "显示 NexTerm", true, None::<&str>)?;
                let new_local =
                    MenuItem::with_id(app, "tray-new-local", "新建本地终端", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "tray-quit", "退出 NexTerm", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &new_local, &quit])?;
                let mut tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "tray-show" => show_main_window(app),
                        "tray-new-local" => {
                            show_main_window(app);
                            use tauri::Emitter;
                            let _ = app.emit("tray-new-local", ());
                        }
                        "tray-quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
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

            // Custom theme folder: scanned on demand by themes_list; a
            // watcher re-emits `themes-changed` so dropped-in files are
            // picked up live. The JSON Schema is materialized next to the
            // themes so editors can autocomplete them.
            let themes_dir = app.path().app_config_dir().ok().and_then(|dir| {
                std::fs::create_dir_all(&dir).ok()?;
                Some(dir.join("themes"))
            });
            if let Some(dir) = &themes_dir {
                let _ = std::fs::create_dir_all(dir);
                themes::ensure_schema_file(dir);
            }
            let theme_manager = themes::ThemeManager::new(themes_dir);
            theme_manager.spawn_watcher(app.handle().clone());
            app.manage(theme_manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fonts_list,
            commands::font_lookup,
            commands::font_data,
            commands::pty_platform_info,
            commands::probe_shell_availability,
            commands::detect_git_bash,
            commands::set_window_behavior,
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
            commands::serial_list,
            commands::serial_connect,
            commands::serial_write,
            commands::serial_resize,
            commands::serial_disconnect,
            remote_edit::remote_edit_open,
            remote_edit::remote_edit_stop,
            themes::themes_list,
            themes::themes_open_folder,
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

/// Bring the main window back from the tray (show, unminimize, focus).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
