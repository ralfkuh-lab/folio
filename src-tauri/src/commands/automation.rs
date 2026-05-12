//! Tauri-Commands fuer die Automation-API-Ack-Semantik.
//!
//! Das Frontend ruft `automation_ack(id)` nach Handler-Ende auf
//! (siehe `src-tauri/web/app/automation/events.ts`). Der Aufruf
//! signalisiert dem wartenden axum-Handler ueber den oneshot-Sender
//! in `AppState.pending_acks`. Wenn die ID bereits durch Timeout
//! entfernt wurde, ist der Call ein No-Op.

use tauri::State;

use crate::automation;
use crate::automation::dom::DomSnapshot;
use crate::state::AppState;

#[tauri::command]
pub fn automation_ack(id: u64, state: State<'_, AppState>) -> Result<(), String> {
    automation::ack::signal_ack(state.inner(), id)
}

#[tauri::command]
pub fn automation_dom_response(
    id: u64,
    payload: DomSnapshot,
    state: State<'_, AppState>,
) -> Result<(), String> {
    automation::dom::deliver(state.inner(), id, payload)
}
