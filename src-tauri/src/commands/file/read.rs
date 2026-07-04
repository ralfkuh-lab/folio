use crate::document_service::{self, DirtyPolicy, OpenDocumentOptions, ReloadPolicy};
use crate::file_kind::{classify, editor_language, FileKind};
use crate::state::AppState;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

use super::types::FileData;

#[tauri::command]
pub async fn read_file(
    path: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<FileData, String> {
    let kind = classify(&path);
    if matches!(kind, FileKind::Binary) {
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
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?
        .active_mut()
        .document_store
        .reload_if_changed()
        .map_err(|error| error.to_string())
}
