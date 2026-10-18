use tauri::WebviewWindow;

#[cfg(windows)]
use windows::core::Interface;

/// Keep WebView2 from showing its built-in address/name/password suggestion
/// popups. Application-level credential handling is done by NexTerm itself.
pub fn disable_webview_autofill(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let _ = window.with_webview(|webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;

            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(settings) = core.Settings() else {
                return;
            };
            if let Ok(settings4) = settings.cast::<ICoreWebView2Settings4>() {
                let _ = settings4.SetIsGeneralAutofillEnabled(false);
                let _ = settings4.SetIsPasswordAutosaveEnabled(false);
            }
        });
    }

    #[cfg(not(windows))]
    {
        let _ = window;
    }
}
