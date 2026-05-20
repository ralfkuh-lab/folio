use crate::document_service::{self, DirtyPolicy, OpenDocumentOptions, ReloadPolicy};
use crate::file_kind::{classify, editor_language, FileKind};
use crate::state::AppState;
use std::{fs, path::Path};
use tauri::{AppHandle, Emitter, State};

use super::types::FileData;

#[tauri::command]
pub async fn read_file(
    path: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<FileData, String> {
    let kind = classify(&path);
    if kind == FileKind::Binary {
        return Err(format!(
            "Dateityp wird nicht unterstützt: {}",
            Path::new(&path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&path)
        ));
    }
    let outcome = document_service::open(
        &state,
        path,
        OpenDocumentOptions {
            anchor: None,
            reload: ReloadPolicy::Always,
            dirty: DirtyPolicy::Discard,
            apply_default_mode: true,
        },
    )
    .map_err(|error| error.to_string())?;
    if let Some(mode) = outcome.mode_override.as_deref() {
        let _ = handle.emit("app:set_mode", serde_json::json!({ "mode": mode }));
    }
    let loaded = outcome
        .loaded
        .expect("ReloadPolicy::Always always produces a loaded document");
    let language = editor_language(&loaded.path).to_string();
    Ok(FileData {
        path: loaded.path,
        content: loaded.text,
        kind,
        language,
    })
}

#[tauri::command]
pub async fn reload_document(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .reload_if_changed()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn write_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    fs::write(&path, content.clone()).map_err(|error| error.to_string())?;
    let mut store = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?;
    if store.path.as_deref() == Some(path.as_str()) {
        store.text = content.replace("\r\n", "\n");
        store.set_dirty(false);
    }
    Ok(())
}
