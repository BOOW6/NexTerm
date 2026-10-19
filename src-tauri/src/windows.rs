use std::{
    collections::HashMap,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    menu::{MenuBuilder, MenuItem},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Default)]
pub struct ModalManager {
    entries: Mutex<HashMap<String, ModalEntry>>,
}

struct ModalEntry {
    payload: Value,
    sender: Option<oneshot::Sender<Option<Value>>>,
}

impl ModalManager {
    fn insert(&self, id: String, payload: Value, sender: oneshot::Sender<Option<Value>>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                id,
                ModalEntry {
                    payload,
                    sender: Some(sender),
                },
            );
        }
    }

    fn payload(&self, id: &str) -> Option<Value> {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(id).map(|entry| entry.payload.clone()))
    }

    fn resolve(&self, id: &str, value: Option<Value>) -> bool {
        let sender = self
            .entries
            .lock()
            .ok()
            .and_then(|mut entries| entries.get_mut(id).and_then(|entry| entry.sender.take()));

        if let Some(sender) = sender {
            let _ = sender.send(value);
            true
        } else {
            false
        }
    }

    fn remove(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(id);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItem {
    label: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    separator_before: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextMenuSelection {
    request_id: String,
    index: usize,
}

pub(crate) fn install_context_menu_listener(window: &WebviewWindow) {
    let target = window.clone();
    window.on_menu_event(move |_window, event| {
        let id = event.id().0.as_str();
        let Some(rest) = id.strip_prefix("ctx|") else {
            return;
        };

        let mut parts = rest.splitn(2, '|');
        let request_id = parts.next().unwrap_or_default();
        let index = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);

        let _ = target.emit(
            "nexterm-context-menu",
            ContextMenuSelection {
                request_id: request_id.to_string(),
                index,
            },
        );
    });
}

#[tauri::command]
pub async fn show_context_menu(
    window: WebviewWindow,
    request_id: String,
    items: Vec<ContextMenuItem>,
) -> Result<(), String> {
    let mut builder = MenuBuilder::new(&window);

    for (index, item) in items.iter().enumerate() {
        if item.separator_before {
            builder = builder.separator();
        }
        let id = format!("ctx|{request_id}|{index}");
        let menu_item = MenuItem::with_id(&window, id, item.label.clone(), item.enabled, None::<&str>)
            .map_err(|err| err.to_string())?;
        builder = builder.item(&menu_item);
    }

    let menu = builder.build().map_err(|err| err.to_string())?;
    window.popup_menu(&menu).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn show_input_context_menu(window: WebviewWindow) -> Result<(), String> {
    let menu = MenuBuilder::new(&window)
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()
        .map_err(|err| err.to_string())?;
    window.popup_menu(&menu).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_modal_payload(
    app: AppHandle,
    id: String,
) -> Result<Value, String> {
    app.state::<ModalManager>()
        .payload(&id)
        .ok_or_else(|| "窗口数据不存在".to_string())
}

#[tauri::command]
pub async fn submit_modal(app: AppHandle, id: String, value: Value) -> Result<(), String> {
    app.state::<ModalManager>().resolve(&id, Some(value));
    if let Some(window) = app.get_webview_window(&format!("modal-{id}")) {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_modal(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<ModalManager>().resolve(&id, None);
    if let Some(window) = app.get_webview_window(&format!("modal-{id}")) {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn open_modal_window(
    app: AppHandle,
    kind: String,
    title: String,
    width: f64,
    height: f64,
    data: Value,
) -> Result<Option<Value>, String> {
    let kind: String = kind
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || *value == '-')
        .collect();
    if kind.is_empty() {
        return Err("无效的窗口类型".to_string());
    }

    let id = Uuid::new_v4().to_string();
    let label = format!("modal-{id}");
    let (sender, receiver) = oneshot::channel();

    app.state::<ModalManager>().insert(id.clone(), data, sender);

    let url = WebviewUrl::App(format!("index.html?window={kind}&id={id}").into());
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(title)
        .inner_size(width, height)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(true)
        .center()
        .focused(true)
        .disable_drag_drop_handler();

    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Visible);
    }

    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            app.state::<ModalManager>().remove(&id);
            return Err(error.to_string());
        }
    };

    install_context_menu_listener(&window);
    crate::windows_ext::disable_webview_autofill(&window);

    let app_handle = app.clone();
    let close_id = id.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            if let Some(manager) = app_handle.try_state::<ModalManager>() {
                manager.resolve(&close_id, None);
            }
        }
    });

    let result = receiver.await.map_err(|_| "窗口已关闭".to_string())?;
    app.state::<ModalManager>().remove(&id);
    Ok(result)
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle, tab: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(tab) = tab {
            let _ = window.emit("nexterm-settings-tab", tab);
        }
        return Ok(());
    }

    let tab = tab.unwrap_or_else(|| "appearance".to_string());
    let url = WebviewUrl::App(format!("index.html?window=settings&tab={tab}").into());
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, "settings", url)
        .title("设置")
        .inner_size(880.0, 640.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true)
        .decorations(true)
        .center()
        .disable_drag_drop_handler();

    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Visible);
    }

    let window = builder.build().map_err(|err| err.to_string())?;
    install_context_menu_listener(&window);
    crate::windows_ext::disable_webview_autofill(&window);
    Ok(())
}
