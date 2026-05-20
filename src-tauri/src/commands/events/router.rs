//! Dispatcher für die zwei IPC-Event-Channels aus dem Frontend:
//! `shell:event` (Toolbar/Vault/Navigation) und `editor:event` (Monaco-
//! Editor-Status). Beide Channels schicken `serde_json::Value`-Payloads
//! mit einem `type`-Feld; pro Typ wird hier ein Handler aufgerufen.
//!
//! Kanonische `shell:event`-Typen: `linkClick`, `visibleHeading`,
//! `scrollPosition`, `tocClick`, `railResize`, `toggle-section`,
//! `expand-dir`, `collapse-dir`, `open`, `context`, `addFile`,
//! `addFolder`, `editorFindState`, `cheatsheetClosed`.
//!
//! Kanonische `editor:event`-Typen: `editorReady`, `editorTextChanged`,
//! `editorSelection`, `editorScroll`, `editorSaveRequested`,
//! `editorFindState`.
//!
//! Unbekannte Typen werden auf stderr geloggt statt silent geschluckt —
//! sonst fallen Frontend-Typos beim Hinzufuegen neuer Events erst beim
//! manuellen Testen auf.

use crate::state::AppState;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::navigation;
use super::payload::{bool_field, number_field, payload_type, string_field, usize_field};
use super::vault;

pub fn route_shell_event(
    payload: &Value,
    state: &AppState,
    handle: &AppHandle,
) -> Result<(), String> {
    let event_type = payload_type(payload)?;
    match event_type {
        "linkClick" => navigation::link_click(string_field(payload, "href")?, state, handle),
        "visibleHeading" => navigation::visible_heading(
            payload
                .get("id")
                .or_else(|| payload.get("anchor"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            handle,
        ),
        "scrollPosition" => navigation::scroll_position(number_field(payload, "y")?, state),
        "tocClick" => navigation::toc_click(string_field(payload, "slug")?, handle),
        "railResize" => navigation::rail_resize(
            string_field(payload, "side")?,
            number_field(payload, "width")?,
            state,
        ),
        "toggle-section" => vault::toggle_section(
            string_field(payload, "section")?,
            bool_field(payload, "expanded")?,
            state,
        ),
        "expand-dir" => vault::expand_dir(string_field(payload, "path")?, state, handle),
        "collapse-dir" => vault::collapse_dir(string_field(payload, "path")?, state),
        "open" => vault::open_document(string_field(payload, "path")?, state, handle),
        "context" => vault::context(payload, handle),
        "addFile" => vault::add_file(state, handle),
        "addFolder" => vault::add_folder(state, handle),
        "editorFindState" => handle
            .emit("editor:find_state", payload.clone())
            .map_err(|error| error.to_string()),
        "cheatsheetClosed" => handle
            .emit("cheatsheet:closed", payload.clone())
            .map_err(|error| error.to_string()),
        other => {
            eprintln!("shell:event: unknown type '{other}'");
            Ok(())
        }
    }
}

pub fn route_editor_event(
    payload: &Value,
    state: &AppState,
    handle: &AppHandle,
) -> Result<(), String> {
    let event_type = payload_type(payload)?;
    match event_type {
        "editorReady" => handle
            .emit("editor:ready", serde_json::json!({}))
            .map_err(|error| error.to_string())
            .and_then(|_| {
                state
                    .automation
                    .lock()
                    .map_err(|_| "automation state lock poisoned".to_string())?
                    .editor_ready = true;
                Ok(())
            }),
        "editorTextChanged" => {
            state
                .document_store
                .lock()
                .map_err(|_| "document store lock poisoned".to_string())?
                .update_text(string_field(payload, "text")?);
            Ok(())
        }
        "editorSelection" => {
            let start = usize_field(payload, "start")?;
            let length = usize_field(payload, "length")?;
            {
                let mut automation = state
                    .automation
                    .lock()
                    .map_err(|_| "automation state lock poisoned".to_string())?;
                automation.selection_start = start;
                automation.selection_length = length;
            }
            state
                .navigation
                .lock()
                .map_err(|_| "navigation lock poisoned".to_string())?
                .update_editor_cursor(start);
            handle
                .emit(
                    "editor:selection",
                    serde_json::json!({ "start": start, "length": length }),
                )
                .map_err(|error| error.to_string())
        }
        "editorScroll" => {
            let y = number_field(payload, "y")?;
            state
                .navigation
                .lock()
                .map_err(|_| "navigation lock poisoned".to_string())?
                .update_editor_scroll(y);
            Ok(())
        }
        "editorSaveRequested" => {
            state
                .document_store
                .lock()
                .map_err(|_| "document store lock poisoned".to_string())?
                .save()
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        "editorFindState" => handle
            .emit("editor:find_state", payload.clone())
            .map_err(|error| error.to_string()),
        other => {
            eprintln!("editor:event: unknown type '{other}'");
            Ok(())
        }
    }
}
