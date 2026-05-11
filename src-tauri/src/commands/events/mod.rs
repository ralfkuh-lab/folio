//! Event-Gateway: routet `shell:event`/`editor:event`-Payloads vom
//! Frontend an die entsprechenden Backend-Handler. Vor Phase 2 hieß
//! das Modul `shell`, was den Inhalt (Navigation, Vault, Editor-Status,
//! Dialoge) nicht widerspiegelte. Die Tauri-Command-Namen
//! (`shell_event`/`editor_event`) und die IPC-Event-Strings
//! (`shell:event`/`editor:event`) bleiben stabil — nur die interne
//! Modulstruktur ist umgezogen.

mod navigation;
mod payload;
pub mod router;
mod vault;

use crate::state::AppState;
use serde_json::Value;
use tauri::{AppHandle, State};

pub use router::{route_editor_event, route_shell_event};

#[tauri::command]
pub async fn shell_event(
    payload: Value,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    route_shell_event(&payload, &state, &handle)
}

#[tauri::command]
pub async fn editor_event(
    payload: Value,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    route_editor_event(&payload, &state, &handle)
}
