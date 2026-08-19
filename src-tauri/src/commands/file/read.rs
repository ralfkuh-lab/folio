use crate::document_service::{self, DirtyPolicy, OpenDocumentOptions, ReloadPolicy};
use crate::file_kind::editor_language;
use crate::i18n;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

use super::types::FileData;

#[tauri::command]
pub async fn read_file(
    path: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<FileData, String> {
    // Bereits in einem anderen Tab offen? Dann dorthin springen statt
    // die Datei doppelt zu oeffnen (Replace im aktiven Tab). Bestehende
    // Tabs entscheiden ausschliesslich ueber ihren Deskriptor — kein
    // vorgelagerter Sniff, der nach einem externen Typwechsel das
    // Fokussieren verweigern wuerde.
    if crate::commands::tabs::focus_existing_tab(&state, &handle, &path)
        .map_err(String::from)?
        .is_some()
    {
        let snapshot = {
            let tabs = state
                .tabs
                .lock()
                .map_err(|_| "tabs lock poisoned".to_string())?;
            tabs.active().document_store.snapshot()
        };
        let language = editor_language(&snapshot.path).to_string();
        return Ok(FileData {
            path: snapshot.path,
            content: snapshot.text,
            kind: snapshot.kind,
            language,
            encoding: snapshot.encoding,
            line_ending: snapshot.line_ending,
        });
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
    .map_err(|error| match error {
        document_service::OpenDocumentError::TooLarge { .. }
        | document_service::OpenDocumentError::UnsupportedType { .. } => error.user_message(),
        other => {
            let detail = other.to_string();
            i18n::t_args("errors.file.openFailedWithDetail", &[("detail", &detail)])
        }
    })?;
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
        kind: loaded.kind,
        language,
        encoding: loaded.encoding,
        line_ending: loaded.line_ending,
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
        .map_err(|error| {
            let detail = error.to_string();
            i18n::t_args("errors.file.reloadFailed", &[("detail", &detail)])
        })
}
