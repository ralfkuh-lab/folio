//! Handler für Navigations-Events aus dem Frontend
//! (Link-Klicks, sichtbare Headings, Scroll, TOC-Klicks, Rail-Resize).

use crate::link_interceptor::LinkAction;
use crate::state::AppState;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

pub(super) fn link_click(href: String, state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let current_file = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .path
        .clone();
    match state
        .link_interceptor
        .handle(&href, current_file.as_deref())
    {
        LinkAction::OpenExternal(target) =>
        {
            #[allow(deprecated)]
            handle
                .shell()
                .open(target, None)
                .map_err(|error| error.to_string())
        }
        LinkAction::Navigate { path, anchor } => {
            let entry = {
                let mut navigation = state
                    .navigation
                    .lock()
                    .map_err(|_| "navigation lock poisoned".to_string())?;
                crate::commands::nav::NavEntry::from(navigation.navigate(path, anchor))
            };
            // Bei Ziel != aktuellem Dokument das neue Dokument laden, sonst
            // bleibt der Body auf dem alten Stand und Anker-Restore feuert in
            // den falschen Content. Anker-only-Links (path == current) ueber-
            // springen die Disk-IO, damit Scroll/Editor-State erhalten bleibt.
            let needs_load = {
                let store = state
                    .document_store
                    .lock()
                    .map_err(|_| "document store lock poisoned".to_string())?;
                store.path.as_deref() != Some(entry.path.as_str())
            };
            if needs_load {
                state
                    .document_store
                    .lock()
                    .map_err(|_| "document store lock poisoned".to_string())?
                    .load(&entry.path)
                    .map_err(|error| error.to_string())?;
                state
                    .vault
                    .lock()
                    .map_err(|_| "vault lock poisoned".to_string())?
                    .set_active(Some(entry.path.clone()));
            }
            handle
                .emit("navigation:changed", &entry)
                .map_err(|error| error.to_string())
        }
        LinkAction::Missing => Ok(()),
    }
}

pub(super) fn visible_heading(anchor: String, handle: &AppHandle) -> Result<(), String> {
    handle
        .emit(
            "navigation:heading_changed",
            serde_json::json!({ "anchor": anchor }),
        )
        .map_err(|error| error.to_string())
}

pub(super) fn scroll_position(y: f64, state: &AppState) -> Result<(), String> {
    state
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?
        .update_scroll_position(y);
    Ok(())
}

pub(super) fn toc_click(anchor: String, handle: &AppHandle) -> Result<(), String> {
    handle
        .emit(
            "navigation:toc_click",
            serde_json::json!({ "anchor": anchor }),
        )
        .map_err(|error| error.to_string())
}

pub(super) fn rail_resize(side: String, width: f64, state: &AppState) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_rail_width(&side, width)
        .map_err(|error| error.to_string())
}
