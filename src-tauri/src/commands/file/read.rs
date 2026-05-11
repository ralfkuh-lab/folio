use crate::file_kind::{classify, editor_language, FileKind};
use crate::state::AppState;
use std::{fs, path::Path};
use tauri::State;

use super::types::FileData;

#[tauri::command]
pub async fn read_file(path: String, state: State<'_, AppState>) -> Result<FileData, String> {
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
    let loaded = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .load(&path)
        .map_err(|error| error.to_string())?;
    state
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?
        .navigate(path.clone(), None);
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .set_active(Some(path));
    let language = editor_language(&loaded.path).to_string();
    Ok(FileData {
        path: loaded.path,
        content: loaded.text,
        kind,
        language,
    })
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
