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
use super::payload::{
    bool_field, number_field, optional_bool_field, payload_type, string_field, usize_field,
};
use super::vault;

pub fn route_shell_event(
    payload: &Value,
    state: &AppState,
    handle: &AppHandle,
) -> Result<(), String> {
    let event_type = payload_type(payload)?;
    match event_type {
        "linkClick" => navigation::link_click(
            string_field(payload, "href")?,
            optional_bool_field(payload, "newTab")?,
            state,
            handle,
        ),
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
            tracing::warn!(target: "folio::ipc", event_type = %other, "shell:event: unknown type");
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
                crate::automation::wait::signal_editor_ready(state);
                Ok(())
            }),
        "editorTextChanged" => {
            state
                .tabs
                .lock()
                .map_err(|_| "tabs lock poisoned".to_string())?
                .active_mut()
                .document_store
                .update_text(string_field(payload, "text")?)
                .map_err(crate::commands::editor::localize_store_write_error)?;
            Ok(())
        }
        "editorSelection" => {
            let start = usize_field(payload, "start")?;
            let length = usize_field(payload, "length")?;
            let line = payload
                .get("line")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(0);
            {
                let mut automation = state
                    .automation
                    .lock()
                    .map_err(|_| "automation state lock poisoned".to_string())?;
                automation.selection_start = start;
                automation.selection_length = length;
            }
            state
                .tabs
                .lock()
                .map_err(|_| "tabs lock poisoned".to_string())?
                .active_mut()
                .navigation
                .update_editor_cursor(start);
            handle
                .emit(
                    "editor:selection",
                    serde_json::json!({ "start": start, "length": length, "line": line }),
                )
                .map_err(|error| error.to_string())
        }
        "editorScroll" => {
            let y = number_field(payload, "y")?;
            let line = payload.get("line").and_then(Value::as_f64).unwrap_or(0.0);
            state
                .tabs
                .lock()
                .map_err(|_| "tabs lock poisoned".to_string())?
                .active_mut()
                .navigation
                .update_editor_scroll(y);
            handle
                .emit("editor:scroll", serde_json::json!({ "y": y, "line": line }))
                .map_err(|error| error.to_string())
        }
        "editorSaveRequested" => {
            // Monaco-Strg+S ist fire-and-forget (kein invoke-Rueckkanal wie
            // saveCurrent). Ein Save-Fehler — insbesondere unmappbare Zeichen
            // in einer Windows-1252-Datei — muss der Nutzer trotzdem sehen:
            // deshalb die LOKALISIERTE Meldung ueber `document:save_error`
            // ans Frontend emittieren (statt sie nur in error.to_string() ins
            // Log zu verlieren). Store/Dirty bleiben bei Fehler unveraendert.
            let result = state
                .tabs
                .lock()
                .map_err(|_| "tabs lock poisoned".to_string())?
                .active_mut()
                .document_store
                .save();
            if let Err(error) = result {
                let message = crate::commands::editor::localize_save_error(error);
                handle
                    .emit(
                        "document:save_error",
                        serde_json::json!({ "message": message }),
                    )
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "editorFindState" => handle
            .emit("editor:find_state", payload.clone())
            .map_err(|error| error.to_string()),
        other => {
            tracing::warn!(target: "folio::ipc", event_type = %other, "editor:event: unknown type");
            Ok(())
        }
    }
}
