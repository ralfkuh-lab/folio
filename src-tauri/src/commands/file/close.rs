use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// Schließt das aktuell geladene Dokument: leert den `DocumentStore`,
/// hebt den aktiven Vault-Pfad auf und emittiert `document:closed` ans
/// Frontend, das daraufhin Editor/Statusbar/Menü-State zurücksetzt. Der
/// Dirty-Prompt liegt im Frontend (vor dem Aufruf), nicht hier.
#[tauri::command]
pub async fn close_document(state: State<'_, AppState>, handle: AppHandle) -> Result<(), String> {
    state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .close();
    if let Ok(mut vault) = state.vault.lock() {
        vault.set_active(None);
    }
    handle
        .emit("document:closed", serde_json::json!({}))
        .map_err(|error| error.to_string())
}
