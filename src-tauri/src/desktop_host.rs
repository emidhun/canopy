//! Native capabilities for the embedded desktop host during runtime extraction.
use crate::runtime::{Audience, Host};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub struct DesktopHost(pub AppHandle);

fn interested(audience: Audience, visible: bool) -> bool {
    // Terminal lifecycle changes must reach hidden terminal windows too. Only
    // the byte stream is rehydrated from a snapshot when a window reappears.
    matches!(audience, Audience::All | Audience::TerminalState) || visible
}

impl Host for DesktopHost {
    fn interested(&self, audience: Audience) -> bool {
        // Preserve delivery of state changes to hidden windows. High-volume
        // streams retain the existing visibility gate until event subscriptions
        // replace the desktop cache in the next runtime slice.
        interested(audience, crate::windows_visible())
    }

    fn publish(&self, audience: Audience, event: &str, payload: serde_json::Value) -> Result<(), String> {
        let result = match audience {
            Audience::All => self.0.emit(event, payload),
            Audience::Main => self.0.emit_filter(event, payload, |target| {
                matches!(target, tauri::EventTarget::WebviewWindow { label } if label == "main")
            }),
            Audience::Terminals | Audience::TerminalState => self.0.emit_filter(event, payload, |target| {
                matches!(target, tauri::EventTarget::WebviewWindow { label } if label == "main" || label.starts_with("term-"))
            }),
        };
        result.map_err(|e| e.to_string())
    }

    fn notify(&self, title: &str, body: &str, sound: bool) -> Result<(), String> {
        let builder = self.0.notification().builder().title(title).body(body);
        let builder = if sound { builder.sound("default") } else { builder };
        builder.show().map_err(|e| e.to_string())
    }

    fn badge(&self, mode: &str, count: i64) {
        let Some(win) = self.0.get_webview_window("main") else { return };
        match mode {
            "off" => { let _ = win.set_badge_count(None); }
            "dot" => {
                #[cfg(target_os = "macos")]
                let _ = win.set_badge_label(if count > 0 { Some("●".to_string()) } else { None });
                #[cfg(not(target_os = "macos"))]
                let _ = win.set_badge_count(if count > 0 { Some(1) } else { None });
            }
            _ => { let _ = win.set_badge_count(if count > 0 { Some(count) } else { None }); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_windows_receive_terminal_lifecycle_but_not_stream_bytes() {
        assert!(interested(Audience::TerminalState, false));
        assert!(interested(Audience::All, false));
        assert!(!interested(Audience::Terminals, false));
        assert!(!interested(Audience::Main, false));
        assert!(interested(Audience::Terminals, true));
    }
}
