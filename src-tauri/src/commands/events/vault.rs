//! Handler für Vault-Events aus dem Frontend
//! (Sektion ein-/ausklappen, Verzeichnisse expand/collapse, Dokument öffnen,
//! Kontextmenü, Datei/Ordner hinzufügen).

use crate::state::AppState;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

pub(super) fn toggle_section(
    section: String,
    expanded: bool,
    state: &AppState,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_section_expanded(&section, expanded)
        .map_err(|error| error.to_string())
}

pub(super) fn expand_dir(path: String, state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let html = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .on_expand(path.clone())
        .map_err(|error| error.to_string())?;
    handle
        .emit(
            "shell:command",
            serde_json::json!({ "type": "insertVaultChildren", "path": path, "html": html }),
        )
        .map_err(|error| error.to_string())
}

pub(super) fn collapse_dir(path: String, state: &AppState) -> Result<(), String> {
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .on_collapse(&path);
    Ok(())
}

pub(super) fn open_document(path: String, state: &AppState) -> Result<(), String> {
    crate::document_service::open(
        state,
        path,
        crate::document_service::OpenDocumentOptions {
            anchor: None,
            reload: crate::document_service::ReloadPolicy::Always,
            dirty: crate::document_service::DirtyPolicy::Discard,
        },
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

pub(super) fn context(payload: &Value, handle: &AppHandle) -> Result<(), String> {
    handle
        .emit(
            "vault:context",
            serde_json::json!({
                "path": payload.get("path").and_then(Value::as_str),
                "kind": payload.get("kind").and_then(Value::as_str),
                "isPinned": payload.get("isPinned").and_then(Value::as_bool).unwrap_or(false),
                "isInRecent": payload.get("isInRecent").and_then(Value::as_bool).unwrap_or(false),
                "x": payload.get("x").and_then(Value::as_f64).unwrap_or_default(),
                "y": payload.get("y").and_then(Value::as_f64).unwrap_or_default(),
            }),
        )
        .map_err(|error| error.to_string())
}

pub(super) fn add_file(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let Some(path) = handle
        .dialog()
        .file()
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok())
    else {
        return Ok(());
    };
    open_document(path.to_string_lossy().into_owned(), state)
}

pub(super) fn add_folder(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let Some(path) = handle
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
    else {
        return Ok(());
    };
    let path = path.to_string_lossy().into_owned();
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .pin(path, true)
        .map_err(|error| error.to_string())?;
    emit_vault_refresh(state, handle)
}

fn emit_vault_refresh(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    handle
        .emit("vault:refresh", vault.compute_refresh_delta(&workspace))
        .map_err(|error| error.to_string())
}
