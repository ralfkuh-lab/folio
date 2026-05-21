//! App-Lifecycle-Commands: View-Mode/Theme/Rail/Window/Zoom (Core-State),
//! `open_find`, `cli_pending_open`. Datei-/Ordner-Picker liegen in
//! `dialog`, OS-Integration (File-Manager, Terminal) in `shell_opener`.
//!
//! Tauri-Commands aus den Submodulen werden in `lib.rs::generate_handler!`
//! ueber explizite Pfade (`commands::app::dialog::pick_file` etc.)
//! registriert — `pub use` reicht hier nicht, weil das Macro die
//! `__cmd__*`-Companion-Funktionen ueber den Original-Modulpfad sucht.

pub mod dialog;
pub mod log_bridge;
pub mod settings;
pub mod shell_opener;

use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn set_view_mode(
    mode: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mode = mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "view" | "edit" | "split") {
        return Err(format!("unknown mode '{mode}'"));
    }
    state
        .automation
        .lock()
        .map_err(|_| "automation state lock poisoned".to_string())?
        .view_mode = mode.clone();
    state
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?
        .update_view_mode(&mode);
    handle
        .emit("app:set_mode", serde_json::json!({ "mode": mode }))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn theme_get(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .theme
        .lock()
        .map_err(|_| "theme lock poisoned".to_string())?
        .mode()
        .to_string())
}

#[tauri::command]
pub async fn theme_set(
    mode: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mode = mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "light" | "dark" | "toggle") {
        return Err(format!("unknown theme '{mode}'"));
    }
    let resolved = {
        let mut theme = state
            .theme
            .lock()
            .map_err(|_| "theme lock poisoned".to_string())?;
        if mode == "toggle" {
            theme.toggle().map_err(|error| error.to_string())?;
        } else {
            theme.set_mode(&mode).map_err(|error| error.to_string())?;
        }
        theme.mode().to_string()
    };
    state
        .automation
        .lock()
        .map_err(|_| "automation state lock poisoned".to_string())?
        .theme = resolved.clone();
    handle
        .emit("app:set_theme", serde_json::json!({ "mode": resolved }))
        .map_err(|error| error.to_string())?;
    Ok(resolved)
}

#[tauri::command]
pub async fn set_rail_visible(
    side: String,
    visible: bool,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let side = side.to_ascii_lowercase();
    if !matches!(side.as_str(), "left" | "right") {
        return Err(format!("unknown side '{side}'"));
    }
    let panel = {
        let mut panel_state = state
            .panel_state
            .lock()
            .map_err(|_| "panel state lock poisoned".to_string())?;
        panel_state
            .set_rail_visible(&side, visible)
            .map_err(|error| error.to_string())?;
        panel_state.data()
    };
    handle
        .emit(
            "panel:rail_changed",
            serde_json::json!({
                "side": side,
                "visible": visible,
                "leftRailVisible": panel.left_rail_visible,
                "rightRailVisible": panel.right_rail_visible,
            }),
        )
        .map_err(|error| error.to_string())
}

/// Liefert die persistierten Rail-Visibility-Werte ans Frontend. Wird
/// beim Boot gerufen, damit die Toolbar-Buttons `tb-rail-left` /
/// `tb-rail-right` ihren `active`-State synchron zur tatsaechlichen
/// Body-CSS-Klasse setzen koennen. Ohne diesen Call zeigten die Buttons
/// auch dann „aktiv", wenn `panel-state.json` `false` persistierte.
#[tauri::command]
pub async fn panel_rails_get(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let data = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data();
    Ok(serde_json::json!({
        "leftRailVisible": data.left_rail_visible,
        "rightRailVisible": data.right_rail_visible,
    }))
}

#[tauri::command]
pub async fn editor_minimap_get(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .editor_minimap_visible)
}

#[tauri::command]
pub async fn set_editor_minimap_visible(
    visible: bool,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_editor_minimap_visible(visible)
        .map_err(|error| error.to_string())?;
    handle
        .emit(
            "panel:minimap_changed",
            serde_json::json!({ "visible": visible }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_window_title(title: String, handle: AppHandle) -> Result<(), String> {
    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.set_title(&title).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_webview_zoom(zoom: f64, handle: AppHandle) -> Result<(), String> {
    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.set_zoom(zoom).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_find(handle: AppHandle) -> Result<(), String> {
    handle
        .emit("editor:open_find", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cli_pending_open(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .cli_open_path
        .lock()
        .map_err(|_| "cli open path lock poisoned".to_string())?
        .take())
}
