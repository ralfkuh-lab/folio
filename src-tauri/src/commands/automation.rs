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
use crate::automation::eval::EvalResult;
use crate::state::{AppState, ConsoleErrorRecord, CONSOLE_ERROR_BUFFER_MAX};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleErrorPayload {
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    pub timestamp_ms: i64,
}

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

#[tauri::command]
pub fn automation_eval_response(
    id: u64,
    payload: EvalResult,
    state: State<'_, AppState>,
) -> Result<(), String> {
    automation::eval::deliver(state.inner(), id, payload)
}

#[tauri::command]
pub fn automation_console_error(
    payload: ConsoleErrorPayload,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut buf = state
        .console_errors
        .lock()
        .map_err(|_| "console errors lock poisoned".to_string())?;
    if buf.len() >= CONSOLE_ERROR_BUFFER_MAX {
        buf.pop_front();
    }
    buf.push_back(ConsoleErrorRecord {
        kind: payload.kind,
        message: payload.message,
        stack: payload.stack,
        source: payload.source,
        timestamp_ms: payload.timestamp_ms,
    });
    Ok(())
}
