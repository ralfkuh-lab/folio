use crate::i18n;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// Schließt das aktuell geladene Dokument: leert den `DocumentStore`,
/// hebt den aktiven Vault-Pfad auf und emittiert `document:closed` ans
/// Frontend, das daraufhin Editor/Statusbar/Menü-State zurücksetzt. Der
/// Dirty-Prompt liegt im Frontend (vor dem Aufruf), nicht hier.
#[tauri::command]
pub async fn close_document(state: State<'_, AppState>, handle: AppHandle) -> Result<(), String> {
    let closed_id = {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        let id = tabs.active().id;
        tabs.active_mut().document_store.close();
        id
    };
    if let Ok(mut vault) = state.vault.lock() {
        vault.set_active(None);
    }
    handle
        .emit(
            "document:closed",
            serde_json::json!({ "tabId": closed_id, "seq": crate::state::next_doc_seq() }),
        )
        .map_err(|error| {
            let detail = error.to_string();
            i18n::t_args("errors.file.closeFailed", &[("detail", &detail)])
        })?;
    AppState::emit_tabs_changed(&handle)
}
