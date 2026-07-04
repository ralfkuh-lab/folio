use crate::commands::nav::NavEntry;
use crate::document_service::{self, DirtyPolicy, OpenDocumentOptions, ReloadPolicy};
use crate::state::AppState;
use crate::tab_manager::{TabSummary, TabsPayload};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug)]
pub enum TabError {
    UnknownId(u64),
    DirtyRejected(u64),
    InvalidPath(String),
    Internal(String),
}

impl std::fmt::Display for TabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownId(id) => write!(f, "unknown tab id: {id}"),
            Self::DirtyRejected(id) => {
                write!(f, "tab {id} has unsaved changes; discard is required")
            }
            Self::InvalidPath(path) => write!(f, "invalid file path: {path}"),
            Self::Internal(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for TabError {}

impl From<TabError> for String {
    fn from(error: TabError) -> Self {
        error.to_string()
    }
}

#[derive(Debug)]
pub struct TabTransition {
    pub tab: TabSummary,
    pub navigation: Option<NavEntry>,
    pub frontend_changed: bool,
}

fn normalized_file_path(path: String) -> Result<String, TabError> {
    let path = path.replace('\\', "/");
    if path.trim().is_empty() || !Path::new(&path).is_file() {
        return Err(TabError::InvalidPath(path));
    }
    Ok(path)
}

pub fn list(state: &AppState) -> Result<TabsPayload, TabError> {
    state.tabs_payload().map_err(TabError::Internal)
}

pub fn open(state: &AppState, handle: &AppHandle, path: String) -> Result<TabTransition, TabError> {
    let path = normalized_file_path(path)?;
    let existing = state
        .tabs
        .lock()
        .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?
        .find_by_path(&path);
    if let Some(id) = existing {
        return activate(state, handle, id);
    }

    let id = state
        .tabs
        .lock()
        .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?
        .add_tab();
    let outcome = document_service::open(
        state,
        path,
        OpenDocumentOptions {
            anchor: None,
            reload: ReloadPolicy::Always,
            dirty: DirtyPolicy::Discard,
            apply_default_mode: true,
        },
    );
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            if let Ok(mut tabs) = state.tabs.lock() {
                tabs.close(id);
            }
            return Err(match error {
                document_service::OpenDocumentError::Load(error) => {
                    TabError::InvalidPath(error.to_string())
                }
                other => TabError::Internal(other.to_string()),
            });
        }
    };

    if let Some(mode) = outcome.mode_override.as_deref() {
        handle
            .emit("app:set_mode", serde_json::json!({ "mode": mode }))
            .map_err(|error| TabError::Internal(error.to_string()))?;
    }
    AppState::emit_tabs_changed(handle).map_err(TabError::Internal)?;
    transition_for_active(state, true)
}

pub fn activate(state: &AppState, handle: &AppHandle, id: u64) -> Result<TabTransition, TabError> {
    {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        if !tabs.activate(id) {
            return Err(TabError::UnknownId(id));
        }
    }

    // Restore-Tabs tragen bis zur ersten Aktivierung nur `pending_path`.
    // Schlaegt das Laden inzwischen fehl, wird der tote Tab entfernt und
    // der dadurch aktive Nachbar bei Bedarf ebenfalls lazy geladen.
    loop {
        match document_service::load_active_pending(state) {
            Ok(Some(outcome)) => {
                if let Some(mode) = outcome.mode_override.as_deref() {
                    handle
                        .emit("app:set_mode", serde_json::json!({ "mode": mode }))
                        .map_err(|error| TabError::Internal(error.to_string()))?;
                }
                break;
            }
            Ok(None) => break,
            Err(document_service::OpenDocumentError::Load(error)) => {
                let (failed_id, path) = {
                    let tabs = state
                        .tabs
                        .lock()
                        .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
                    (
                        tabs.active().id,
                        tabs.active().document_path().map(str::to_string),
                    )
                };
                tracing::warn!(
                    target: "folio::tabs",
                    ?path,
                    %error,
                    "closing lazy tab after load failed"
                );
                state
                    .tabs
                    .lock()
                    .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?
                    .close(failed_id);
            }
            Err(error) => return Err(TabError::Internal(error.to_string())),
        }
    }

    let (path, text, dirty, tab_id) = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        let tab = tabs.active();
        (
            tab.document_store.path.clone(),
            tab.document_store.text.clone(),
            tab.document_store.is_dirty,
            tab.id,
        )
    };

    state
        .vault
        .lock()
        .map_err(|_| TabError::Internal("vault lock poisoned".into()))?
        .set_active(path.clone());

    if let Some(path) = path {
        AppState::emit_document_loaded(handle, tab_id, &path, &text).map_err(TabError::Internal)?;
        handle
            .emit(
                "document:dirty_changed",
                serde_json::json!({ "is_dirty": dirty, "tabId": tab_id }),
            )
            .map_err(|error| TabError::Internal(error.to_string()))?;
        crate::automation::wait::signal_document_loaded(handle.state::<AppState>().inner());
    } else {
        emit_document_closed(handle, tab_id)?;
    }
    AppState::emit_tabs_changed(handle).map_err(TabError::Internal)?;
    transition_for_active(state, true)
}

pub fn close(
    state: &AppState,
    handle: &AppHandle,
    id: u64,
    policy: DirtyPolicy,
) -> Result<TabTransition, TabError> {
    let (was_active, was_dirty) = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        let tab = tabs.tab(id).ok_or(TabError::UnknownId(id))?;
        (tabs.is_active(id), tab.document_store.is_dirty)
    };
    if was_dirty && policy == DirtyPolicy::Reject {
        return Err(TabError::DirtyRejected(id));
    }

    {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        if !tabs.close(id) {
            return Err(TabError::UnknownId(id));
        }
    }

    if was_active {
        emit_active_document(state, handle)?;
    }
    AppState::emit_tabs_changed(handle).map_err(TabError::Internal)?;
    transition_for_active(state, was_active)
}

pub fn close_all(state: &AppState, handle: &AppHandle) -> Result<TabTransition, TabError> {
    state
        .tabs
        .lock()
        .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?
        .close_all();
    emit_active_document(state, handle)?;
    AppState::emit_tabs_changed(handle).map_err(TabError::Internal)?;
    transition_for_active(state, true)
}

fn emit_active_document(state: &AppState, handle: &AppHandle) -> Result<(), TabError> {
    let (id, path, text, dirty) = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        let tab = tabs.active();
        (
            tab.id,
            tab.document_store.path.clone(),
            tab.document_store.text.clone(),
            tab.document_store.is_dirty,
        )
    };
    state
        .vault
        .lock()
        .map_err(|_| TabError::Internal("vault lock poisoned".into()))?
        .set_active(path.clone());
    if let Some(path) = path {
        AppState::emit_document_loaded(handle, id, &path, &text).map_err(TabError::Internal)?;
        handle
            .emit(
                "document:dirty_changed",
                serde_json::json!({ "is_dirty": dirty, "tabId": id }),
            )
            .map_err(|error| TabError::Internal(error.to_string()))?;
        crate::automation::wait::signal_document_loaded(handle.state::<AppState>().inner());
    } else {
        emit_document_closed(handle, id)?;
    }
    Ok(())
}

fn emit_document_closed(handle: &AppHandle, id: u64) -> Result<(), TabError> {
    handle
        .emit("document:closed", serde_json::json!({ "tabId": id }))
        .map_err(|error| TabError::Internal(error.to_string()))
}

fn transition_for_active(
    state: &AppState,
    frontend_changed: bool,
) -> Result<TabTransition, TabError> {
    let tabs = state
        .tabs
        .lock()
        .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
    let tab = tabs.active();
    let summary = tabs
        .summaries()
        .into_iter()
        .find(|summary| summary.active)
        .expect("TabManager always has an active tab");
    let navigation = if tab.document_store.path.is_some() {
        tab.navigation.current().map(NavEntry::from)
    } else {
        None
    };
    Ok(TabTransition {
        tab: summary,
        navigation,
        frontend_changed,
    })
}

pub fn emit_navigation_changed(
    handle: &AppHandle,
    transition: &TabTransition,
    request_id: Option<u64>,
) -> Result<(), TabError> {
    if !transition.frontend_changed {
        return Ok(());
    }
    // Leerer Tab (kein Dokument, kein Nav-Entry): es gibt nichts zu
    // restoren. Insbesondere der Boot ohne Dokument darf keinen
    // Editor-Restore im Frontend anstossen — der Editor ist dann noch
    // nicht gemountet.
    if transition.navigation.is_none() && transition.tab.path.is_none() {
        return Ok(());
    }
    let mut payload = transition
        .navigation
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| TabError::Internal(error.to_string()))?
        .unwrap_or_else(|| {
            serde_json::json!({
                "scrollY": 0.0,
                "editorScrollY": 0.0,
                "editorCursor": 0,
            })
        });
    if let Some(request_id) = request_id {
        payload["requestId"] = serde_json::json!(request_id);
    }
    handle
        .emit("navigation:changed", payload)
        .map_err(|error| TabError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn tab_open(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<TabSummary, String> {
    let transition = open(&state, &handle, path).map_err(String::from)?;
    emit_navigation_changed(&handle, &transition, None).map_err(String::from)?;
    Ok(transition.tab)
}

#[tauri::command]
pub async fn tab_close(
    id: u64,
    discard: Option<bool>,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<TabSummary, String> {
    let policy = if discard.unwrap_or(false) {
        DirtyPolicy::Discard
    } else {
        DirtyPolicy::Reject
    };
    let transition = close(&state, &handle, id, policy).map_err(String::from)?;
    emit_navigation_changed(&handle, &transition, None).map_err(String::from)?;
    Ok(transition.tab)
}

#[tauri::command]
pub async fn tab_activate(
    id: u64,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<TabSummary, String> {
    let transition = activate(&state, &handle, id).map_err(String::from)?;
    emit_navigation_changed(&handle, &transition, None).map_err(String::from)?;
    Ok(transition.tab)
}

#[tauri::command]
pub async fn tabs_list(state: State<'_, AppState>) -> Result<TabsPayload, String> {
    list(&state).map_err(String::from)
}
