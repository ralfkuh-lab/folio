//! Vault-Volltextsuche — Command-Layer (Spec-Entscheidung 5).
//!
//! `vault_search_start` löst den Scope gegen die angepinnten Einträge auf und
//! startet den Suchkern (`crate::search`) in einem `spawn_blocking`-Task.
//! Treffer werden gebündelt pro Datei als `search:hits`-Event gestreamt, der
//! Abschluss als `search:done` (mit `runId`-Korrelation). `vault_search_cancel`
//! setzt das kooperative Abbruch-Flag des Laufs.
//!
//! Die reine Suchlogik bleibt in `search.rs` (ohne Tauri-/State-Bezug); hier
//! liegt nur die Verdrahtung mit Workspace-Pins, State-Registry und Events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::search::{self, FileResult, SearchError, SearchOptions, SearchRoots, SearchScope};
use crate::state::AppState;

/// Löst den Such-Umfang aus den angepinnten Workspace-Einträgen auf.
/// `scope` = `Some(pfad)` → Ordner-Scope, `None` → gesamter Vault.
fn resolve_roots(state: &AppState, scope: Option<String>) -> Result<SearchRoots, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let scope = match scope {
        Some(path) => SearchScope::Folder(path),
        None => SearchScope::Vault,
    };
    Ok(search::resolve_scope(workspace.pinned(), &scope))
}

/// Startet einen Suchlauf. Liefert die `runId`, über die Events und Cancel
/// korrelieren. Vorab-Fehler (zu kurzer Begriff, nicht existenter Ordner-Scope)
/// kommen synchron als `Err(String)` zurück.
#[tauri::command]
pub async fn vault_search_start(
    query: String,
    scope: Option<String>,
    case_sensitive: bool,
    whole_word: bool,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<u64, String> {
    let options = SearchOptions {
        case_sensitive,
        whole_word,
    };
    let roots = resolve_roots(&state, scope)?;

    // Synchrone Vorabprüfung, damit QueryTooShort/RootNotFound als Command-Err
    // beim Aufrufer landen statt nur als Event. Die beiden Scope-Fehler
    // (toter/relativer Ordner-Scope) bekommen ein stabiles `scope:`-Präfix,
    // das das Frontend parst, um NUR dann auf die Vault-weite Suche
    // zurückzufallen und den Scope-Chip zu entfernen.
    search::validate(&roots, &query, &options).map_err(|error| match error {
        SearchError::RootNotFound(_) | SearchError::InvalidScope(_) => {
            format!("scope:{error}")
        }
        other => other.to_string(),
    })?;

    let run_id = state.search_run_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut cancels = state
            .search_cancels
            .lock()
            .map_err(|_| "search cancels lock poisoned".to_string())?;
        cancels.insert(run_id, cancel.clone());
    }

    tracing::debug!(
        target: "folio::search",
        run_id,
        dirs = roots.dirs.len(),
        files = roots.files.len(),
        case_sensitive,
        whole_word,
        "vault search started"
    );

    let handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // RAII-Guard: räumt die Registry beim Verlassen des Tasks IMMER auf und
        // emittiert bei abnormalem Exit (Panic ohne reguläres `search:done`) ein
        // Error-`search:done`, damit das Frontend nie ewig auf den Lauf wartet.
        let mut guard = SearchRunGuard {
            handle: handle.clone(),
            run_id,
            completed: false,
        };
        let mut on_file = |file: FileResult| {
            let _ = handle.emit(
                "search:hits",
                serde_json::json!({ "runId": run_id, "files": [file] }),
            );
        };
        match search::run_search(&roots, &query, &options, &cancel, &mut on_file) {
            Ok(stats) => {
                let _ = handle.emit(
                    "search:done",
                    serde_json::json!({ "runId": run_id, "stats": stats }),
                );
            }
            Err(error) => {
                let _ = handle.emit(
                    "search:done",
                    serde_json::json!({ "runId": run_id, "error": error.to_string() }),
                );
            }
        }
        guard.completed = true;
    });

    Ok(run_id)
}

struct SearchRunGuard<R: tauri::Runtime = tauri::Wry> {
    handle: tauri::AppHandle<R>,
    run_id: u64,
    completed: bool,
}

impl<R: tauri::Runtime> Drop for SearchRunGuard<R> {
    fn drop(&mut self) {
        if let Some(state) = self.handle.try_state::<AppState>() {
            if let Ok(mut cancels) = state.search_cancels.lock() {
                cancels.remove(&self.run_id);
            }
        }
        if !self.completed {
            let _ = self.handle.emit(
                "search:done",
                serde_json::json!({ "runId": self.run_id, "error": "internal error" }),
            );
            tracing::error!(
                target: "folio::search",
                run_id = self.run_id,
                "vault search task ended abnormally (panic?)"
            );
        }
    }
}

/// Bricht den Lauf mit `run_id` ab (kooperatives Flag). Unbekannte IDs sind
/// ein No-op — ein verspäteter Cancel eines längst beendeten Laufs schadet
/// nicht.
#[tauri::command]
pub async fn vault_search_cancel(run_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    let cancels = state
        .search_cancels
        .lock()
        .map_err(|_| "search cancels lock poisoned".to_string())?;
    if let Some(flag) = cancels.get(&run_id) {
        flag.store(true, Ordering::Release);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    #[test]
    fn test_search_run_guard_emits_internal_error_on_abnormal_drop() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let received = Arc::new(Mutex::new(None));
        let received_clone = received.clone();

        handle.listen("search:done", move |event| {
            let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            *received_clone.lock().unwrap() = Some(payload);
        });

        let guard = SearchRunGuard {
            handle: handle.clone(),
            run_id: 12345,
            completed: false,
        };

        drop(guard);

        let result = received.lock().unwrap().clone().unwrap();
        assert_eq!(result["runId"], 12345);
        assert_eq!(result["error"], "internal error");
    }
}
