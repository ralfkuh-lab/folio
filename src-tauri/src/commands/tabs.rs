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
    /// Ungueltige Aufruf-Argumente (z. B. Reorder-IDs, die keine exakte
    /// Permutation der aktuellen Tabs sind) — Automation mappt auf 400.
    InvalidArgument(String),
    Internal(String),
    TooLarge {
        size: u64,
    },
    UnsupportedType {
        path: String,
    },
}

impl TabError {
    pub fn user_message(&self) -> String {
        match self {
            Self::TooLarge { size } => crate::i18n::t_args(
                "errors.file.tooLargeToAddress",
                &[("detail", &size.to_string())],
            ),
            Self::UnsupportedType { path } => {
                let detail = Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path);
                crate::i18n::t_args("errors.file.unsupportedType", &[("detail", detail)])
            }
            other => other.to_string(),
        }
    }
}

impl std::fmt::Display for TabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownId(id) => write!(f, "unknown tab id: {id}"),
            Self::DirtyRejected(id) => {
                write!(f, "tab {id} has unsaved changes; discard is required")
            }
            Self::InvalidPath(path) => write!(f, "invalid file path: {path}"),
            Self::InvalidArgument(message) => f.write_str(message),
            Self::Internal(message) => f.write_str(message),
            Self::TooLarge { size } => write!(f, "file too large to address ({size} bytes)"),
            Self::UnsupportedType { path } => write!(f, "unsupported file type: {path}"),
        }
    }
}

impl std::error::Error for TabError {}

impl From<TabError> for String {
    fn from(error: TabError) -> Self {
        error.user_message()
    }
}

#[derive(Debug)]
pub struct TabTransition {
    pub tab: TabSummary,
    pub navigation: Option<NavEntry>,
    pub frontend_changed: bool,
}

fn tab_error_from_open(error: document_service::OpenDocumentError) -> TabError {
    match error {
        document_service::OpenDocumentError::Load(error) => {
            TabError::InvalidPath(error.to_string())
        }
        document_service::OpenDocumentError::TooLarge { size } => TabError::TooLarge { size },
        document_service::OpenDocumentError::UnsupportedType { path } => {
            TabError::UnsupportedType { path }
        }
        other => TabError::Internal(other.to_string()),
    }
}

/// Laedt den Pending-Pfad des aktiven Tabs. Load-/Typ-/Groessenfehler
/// schliessen genau diesen Tab und kommen als Fehler zurueck — der
/// Nachbar darf nicht als Erfolg der angefragten Datei gelten.
fn load_pending_after_activate(
    state: &AppState,
) -> Result<Option<document_service::OpenDocumentOutcome>, TabError> {
    match document_service::load_active_pending(state) {
        Ok(outcome) => Ok(outcome),
        Err(
            error @ (document_service::OpenDocumentError::Load(_)
            | document_service::OpenDocumentError::TooLarge { .. }
            | document_service::OpenDocumentError::UnsupportedType { .. }),
        ) => {
            let mapped = tab_error_from_open(error);
            let failed_id = {
                let tabs = state
                    .tabs
                    .lock()
                    .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
                tabs.active().id
            };
            tracing::warn!(
                target: "folio::tabs",
                %mapped,
                "closing lazy tab after load failed"
            );
            state
                .tabs
                .lock()
                .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?
                .close(failed_id);
            Err(mapped)
        }
        Err(error) => Err(TabError::Internal(error.to_string())),
    }
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

pub fn apply_reorder(state: &AppState, ids: Vec<u64>) -> Result<(), TabError> {
    let mut tabs = state
        .tabs
        .lock()
        .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
    if !tabs.reorder(&ids) {
        return Err(TabError::InvalidArgument(
            "invalid reorder: ids must be exact permutation of current document tabs".into(),
        ));
    }
    Ok(())
}

pub fn reorder(state: &AppState, handle: &AppHandle, ids: Vec<u64>) -> Result<(), TabError> {
    apply_reorder(state, ids)?;
    AppState::emit_tabs_changed(handle).map_err(TabError::Internal)?;
    Ok(())
}

pub fn open(state: &AppState, handle: &AppHandle, path: String) -> Result<TabTransition, TabError> {
    open_with_anchor(state, handle, path, None)
}

/// Wie [`open`], reicht zusaetzlich einen Sprung-Anker bis in
/// [`OpenDocumentOptions`] durch — damit entsteht EIN History-Eintrag
/// `(path, anchor)` statt eines Nachtrags per zweitem `navigate`
/// (Review codex #8 / kimi #3).
pub fn open_with_anchor(
    state: &AppState,
    handle: &AppHandle,
    path: String,
    anchor: Option<String>,
) -> Result<TabTransition, TabError> {
    let path = normalized_file_path(path)?;
    let existing = state
        .tabs
        .lock()
        .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?
        .find_by_path(&path);
    if let Some(id) = existing {
        return activate_with_anchor(state, handle, id, anchor);
    }

    // Einen leeren aktiven Tab (kein Dokument, kein pending Restore-
    // Pfad) wiederverwenden statt daneben einzufuegen — sonst bleibt
    // z. B. nach Boot-CLI-Open ein unerreichbarer leerer Zombie-Tab
    // zurueck (die Leiste blendet pfadlose Tabs aus).
    let reused_empty = {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        let active_is_empty = tabs.active().document_store.path.is_none()
            && tabs.active().pending_path().is_none()
            && !tabs.active().document_store.is_dirty;
        if !active_is_empty {
            tabs.add_tab();
        }
        active_is_empty
    };
    let outcome = document_service::open(
        state,
        path,
        OpenDocumentOptions {
            anchor,
            reload: ReloadPolicy::Always,
            dirty: DirtyPolicy::Discard,
            apply_default_mode: true,
        },
    );
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            if !reused_empty {
                if let Ok(mut tabs) = state.tabs.lock() {
                    let id = tabs.active().id;
                    tabs.close(id);
                }
            }
            return Err(tab_error_from_open(error));
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

/// Ist `path` bereits in einem ANDEREN Tab offen, wird dieser aktiviert
/// (inkl. document:loaded/tabs:changed) und die Transition geliefert —
/// die Replace-Open-Pfade (Vault-Klick, Recent, /open) springen damit
/// zum bestehenden Tab statt die Datei doppelt zu oeffnen. Der aktive
/// Tab selbst zaehlt nicht: Re-Open dort bleibt ein normaler Reload.
/// History-Back/Forward nutzt diesen Helper bewusst NICHT (tab-lokale
/// Browser-Semantik; Back darf nie den Tab wechseln).
pub fn focus_existing_tab(
    state: &AppState,
    handle: &AppHandle,
    path: &str,
) -> Result<Option<TabTransition>, TabError> {
    focus_existing_tab_with_anchor(state, handle, path, None)
}

/// Wie [`focus_existing_tab`], mit Sprung-Anker auf dem aktuellen
/// History-Eintrag des fokussierten Tabs (Review codex #8).
pub fn focus_existing_tab_with_anchor(
    state: &AppState,
    handle: &AppHandle,
    path: &str,
    anchor: Option<String>,
) -> Result<Option<TabTransition>, TabError> {
    let other = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        tab_to_focus_for_path(&tabs, path)
    };
    match other {
        Some(id) => {
            let transition = activate_with_anchor(state, handle, id, anchor)?;
            emit_navigation_changed(handle, &transition, None)?;
            Ok(Some(transition))
        }
        None => Ok(None),
    }
}

fn tab_to_focus_for_path(tabs: &crate::tab_manager::TabManager, path: &str) -> Option<u64> {
    let normalized = path.replace('\\', "/");
    if tabs.active().document_path() == Some(normalized.as_str()) {
        return None;
    }
    tabs.find_by_path(&normalized)
        .filter(|id| !tabs.is_active(*id))
}

pub fn activate(state: &AppState, handle: &AppHandle, id: u64) -> Result<TabTransition, TabError> {
    activate_with_anchor(state, handle, id, None)
}

/// Wie [`activate`], setzt zusaetzlich den Anker auf dem AKTUELLEN
/// History-Eintrag des Ziel-Tabs (kein zweiter Eintrag — Review codex #8).
pub fn activate_with_anchor(
    state: &AppState,
    handle: &AppHandle,
    id: u64,
    anchor: Option<String>,
) -> Result<TabTransition, TabError> {
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
    // Schlaegt das Laden fehl, kommt der Fehler beim Aufrufer an — der
    // Nachbartab darf nicht als Erfolg der angefragten Datei gelten.
    let mut lazy_loaded = false;
    match load_pending_after_activate(state) {
        Ok(Some(outcome)) => {
            if let Some(mode) = outcome.mode_override.as_deref() {
                handle
                    .emit("app:set_mode", serde_json::json!({ "mode": mode }))
                    .map_err(|error| TabError::Internal(error.to_string()))?;
            }
            // Der Store-load-Callback hat document:loaded (inkl.
            // /wait-Signal) und dirty_changed bereits emittiert —
            // unten NICHT erneut emitten, sonst rendert das Frontend
            // doppelt und der Model-Cache sieht zwei loaded-Events.
            lazy_loaded = true;
        }
        Ok(None) => {}
        Err(error) => {
            let _ = AppState::emit_tabs_changed(handle);
            return Err(error);
        }
    }

    let (loaded, dirty, tab_id) = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        let tab = tabs.active();
        (
            tab.document_store
                .path
                .as_ref()
                .map(|_| tab.document_store.snapshot()),
            tab.document_store.is_dirty,
            tab.id,
        )
    };

    state
        .vault
        .lock()
        .map_err(|_| TabError::Internal("vault lock poisoned".into()))?
        .set_active(loaded.as_ref().map(|l| l.path.clone()));

    if let Some(loaded) = loaded {
        if !lazy_loaded {
            AppState::emit_document_loaded(handle, tab_id, &loaded).map_err(TabError::Internal)?;
            handle
                .emit(
                    "document:dirty_changed",
                    serde_json::json!({ "is_dirty": dirty, "tabId": tab_id, "seq": crate::state::next_doc_seq() }),
                )
                .map_err(|error| TabError::Internal(error.to_string()))?;
            crate::automation::wait::signal_document_loaded(handle.state::<AppState>().inner());
        }
    } else {
        emit_document_closed(handle, tab_id)?;
    }
    if anchor.is_some() {
        state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?
            .active_mut()
            .navigation
            .set_current_anchor(anchor);
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
    let (was_active, was_dirty, closed_path) = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        let tab = tabs.tab(id).ok_or(TabError::UnknownId(id))?;
        (
            tabs.is_active(id),
            tab.document_store.is_dirty,
            tab.document_path().map(str::to_string),
        )
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
        // Closed-Stack nur bei User-Schließen (nicht close_all). Pfad
        // war vor dem close bekannt (document_path oder pending_path).
        if let Some(path) = closed_path {
            tabs.push_recently_closed(path);
        }
    }

    if was_active {
        emit_active_document(state, handle)?;
    }
    AppState::emit_tabs_changed(handle).map_err(TabError::Internal)?;
    transition_for_active(state, was_active)
}

/// Poppt den Closed-Stack und öffnet den Pfad über `tab_open` (Dedup/
/// Aktivierung). Tote Pfade werden übersprungen; leerer Stack → No-op.
///
/// Locking-Vertrag: der `tabs`-Guard fällt VOR jedem weiteren Aufruf,
/// der den Mutex nimmt (`transition_for_active`, `open`,
/// `emit_tabs_changed`) — Review-Befund codex 2026-07-21: der frühere
/// `return transition_for_active(...)` im None-Arm lief noch unter
/// gehaltenem Guard und deadlockte bei leerem Stack deterministisch.
pub fn restore_last(state: &AppState, handle: &AppHandle) -> Result<TabTransition, TabError> {
    let (path, dead) = {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        tabs.pop_next_live_recently_closed(|p| Path::new(p).is_file())
    };
    for path in &dead {
        tracing::debug!(
            target: "folio::tabs",
            %path,
            "skipping dead path from recently-closed stack"
        );
    }
    match path {
        // open() dedupliziert bereits offene Pfade (aktivieren statt neu)
        // und emittiert tabs:changed — der neue Count läuft dort mit.
        Some(path) => open(state, handle, path),
        None => {
            if !dead.is_empty() {
                // Nur tote Pfade entfernt: Frontend-Snapshot syncen,
                // sonst bleibt recentlyClosedCount > 0 und
                // „Wiederherstellen" fälschlich aktiv (Review-Befund).
                AppState::emit_tabs_changed(handle).map_err(TabError::Internal)?;
            }
            transition_for_active(state, false)
        }
    }
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
    let (id, loaded, dirty) = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| TabError::Internal("tabs lock poisoned".into()))?;
        let tab = tabs.active();
        (
            tab.id,
            tab.document_store
                .path
                .as_ref()
                .map(|_| tab.document_store.snapshot()),
            tab.document_store.is_dirty,
        )
    };
    state
        .vault
        .lock()
        .map_err(|_| TabError::Internal("vault lock poisoned".into()))?
        .set_active(loaded.as_ref().map(|l| l.path.clone()));
    if let Some(loaded) = loaded {
        AppState::emit_document_loaded(handle, id, &loaded).map_err(TabError::Internal)?;
        handle
            .emit(
                "document:dirty_changed",
                serde_json::json!({ "is_dirty": dirty, "tabId": id, "seq": crate::state::next_doc_seq() }),
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
        .emit(
            "document:closed",
            serde_json::json!({ "tabId": id, "seq": crate::state::next_doc_seq() }),
        )
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
        tab.navigation
            .current()
            .map(|entry| NavEntry::from_kind(entry, tab.document_store.kind()))
    } else {
        tab.navigation.current().map(NavEntry::from)
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

#[tauri::command]
pub async fn tab_reorder(
    ids: Vec<u64>,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    reorder(&state, &handle, ids).map_err(String::from)
}

#[tauri::command]
pub async fn tab_restore_last(
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<TabSummary, String> {
    let transition = restore_last(&state, &handle).map_err(String::from)?;
    emit_navigation_changed(&handle, &transition, None).map_err(String::from)?;
    Ok(transition.tab)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab_manager::TabManager;

    #[test]
    fn tab_to_focus_for_path_returns_other_tab_with_matching_path() {
        let mut tabs = TabManager::new();
        tabs.active_mut().document_store.path = Some("/notes/source.md".into());
        let target_id = tabs.add_tab();
        tabs.active_mut().document_store.path = Some("/notes/target.md".into());
        assert!(tabs.activate(1));

        assert_eq!(
            Some(target_id),
            tab_to_focus_for_path(&tabs, r"\notes\target.md")
        );
    }

    #[test]
    fn activating_pending_binary_loads_opaque_not_neighbor() {
        use crate::file_kind::FileKind;
        use crate::state::AppState;
        use std::fs;
        use tempfile::TempDir;

        let temp = TempDir::new().unwrap();
        let md = temp.path().join("ok.md");
        fs::write(&md, "hello").unwrap();
        let md = md.to_string_lossy().replace('\\', "/");
        let bin = temp.path().join("blob");
        fs::write(&bin, b"x\0y").unwrap();
        let bin = bin.to_string_lossy().replace('\\', "/");

        let state = AppState::new();
        {
            let mut tabs = state.tabs.lock().unwrap();
            tabs.restore_session(&[md.clone(), bin.clone()], Some(0));
        }
        let loaded = document_service::load_active_pending(&state)
            .unwrap()
            .unwrap();
        assert_eq!(md, loaded.loaded.as_ref().unwrap().path);

        let bin_id = state.tabs.lock().unwrap().find_by_path(&bin).unwrap();
        assert!(state.tabs.lock().unwrap().activate(bin_id));

        let outcome = load_pending_after_activate(&state).unwrap().unwrap();
        assert_eq!(bin, outcome.loaded.as_ref().unwrap().path);
        assert_eq!("", outcome.loaded.as_ref().unwrap().text);

        let tabs = state.tabs.lock().unwrap();
        assert_eq!(Some(bin.as_str()), tabs.active().document_path());
        assert_eq!(2, tabs.tabs().len());
        assert!(tabs.active().document_store.is_opaque());
        assert_eq!(Some(FileKind::Binary), tabs.active().document_store.kind());
    }

    #[test]
    fn tab_to_focus_for_path_keeps_active_tab_for_anchor_only_path() {
        let mut tabs = TabManager::new();
        tabs.active_mut().document_store.path = Some("/notes/source.md".into());
        tabs.add_tab();
        tabs.active_mut().document_store.path = Some("/notes/source.md".into());

        assert_eq!(None, tab_to_focus_for_path(&tabs, "/notes/source.md"));
    }
}
