//! Automation-Handler `POST /search` (Spec-Entscheidung 10).
//!
//! Synchron: löst den Scope gegen die angepinnten Workspace-Einträge auf,
//! führt den Suchkern in einem Blocking-Task aus und liefert das komplette
//! Ergebnis (`files` + `stats`) zurück — kein Streaming, kein Frontend-
//! Roundtrip (E2E-Tests brauchen kein SSE).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{rejection::JsonRejection, Json, State as AxumState};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::automation::context::AutomationContext;
use crate::automation::error::{json_payload, ApiError, ApiResult};
use crate::commands::search_cmd::{build_scope_and_options, snapshot_open_tab_docs};
use crate::search::{self, FileResult, SearchScopeEx, SearchStats};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::automation) struct SearchRequest {
    query: String,
    /// Ordner-Scope (absoluter Pfad). Fehlt/`null` → gesamter Vault.
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    whole_word: bool,
    /// Regex-Modus (S4). Default aus → S1-Literalsuche.
    #[serde(default)]
    regex: bool,
    /// Dateityp-Filter (`markdown` | `allText` | `custom`). Fehlt → `allText`.
    #[serde(default)]
    file_filter: Option<String>,
    /// Roher Endungs-Feldtext für `fileFilter=custom` (gleiche Zerlegung wie
    /// UI/Tauri).
    #[serde(default)]
    custom_extensions: String,
    /// OpenTabs-Scope (S4): durchsucht die offenen Tab-Puffer statt des Vaults.
    #[serde(default)]
    open_tabs: bool,
    /// Auch versteckte und gitignorierte Dateien (Default aus).
    #[serde(default)]
    include_hidden: bool,
    /// Optionales Zeitlimit; danach wird der Lauf abgebrochen und 500 geliefert.
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub(in crate::automation) struct SearchResponse {
    files: Vec<FileResult>,
    stats: SearchStats,
}

pub(in crate::automation) async fn post_search(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<SearchRequest>, JsonRejection>,
) -> ApiResult<Json<SearchResponse>> {
    let Json(request) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();

    // Grenz-Validierung synchron → 400 (openTabs+scope-Konflikt, unbekannter
    // Filter, leere Custom-Liste, verbotene Endungszeichen).
    let (scope_ex, options) = build_scope_and_options(
        request.scope,
        request.open_tabs,
        request.case_sensitive,
        request.whole_word,
        request.regex,
        request.file_filter.as_deref().unwrap_or("allText"),
        &request.custom_extensions,
        request.include_hidden,
    )
    .map_err(|error| ApiError::bad_request(error.to_string()))?;

    // Ziel auflösen (Roots vs. OpenTabs-Snapshot) — beides vor dem Blocking-Task
    // und ohne die tabs/workspace-Locks über den Task zu halten.
    enum Work {
        Roots(search::SearchRoots),
        Buffers(Vec<search::BufferDoc>),
    }
    let work = match scope_ex {
        SearchScopeEx::OpenTabs => {
            Work::Buffers(snapshot_open_tab_docs(state.inner()).map_err(ApiError::internal)?)
        }
        SearchScopeEx::Vault | SearchScopeEx::Folder(_) => {
            let scope = match scope_ex {
                SearchScopeEx::Folder(path) => Some(path),
                _ => None,
            };
            let workspace = state
                .workspace
                .lock()
                .map_err(|_| ApiError::internal("workspace lock poisoned"))?;
            let scope = match scope {
                Some(path) => crate::search::SearchScope::Folder(path),
                None => crate::search::SearchScope::Vault,
            };
            Work::Roots(search::resolve_scope(workspace.pinned(), &scope))
        }
    };

    let query = request.query;
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_task = cancel.clone();

    let join = tauri::async_runtime::spawn_blocking(move || {
        let mut files: Vec<FileResult> = Vec::new();
        let stats = match &work {
            Work::Roots(roots) => {
                // S6: Verzeichnis-Scopes (Vault/Folder) laufen parallel.
                search::run_search_parallel(roots, &query, &options, &cancel_task, &mut |file| {
                    files.push(file)
                })
            }
            Work::Buffers(docs) => {
                search::run_search_buffers(docs, &query, &options, &cancel_task, &mut |file| {
                    files.push(file)
                })
            }
        };
        stats.map(|stats| SearchResponse { files, stats })
    });

    let joined = match request.timeout_ms {
        Some(ms) => match tokio::time::timeout(Duration::from_millis(ms), join).await {
            Ok(result) => result,
            Err(_) => {
                cancel.store(true, std::sync::atomic::Ordering::Release);
                return Err(ApiError::internal("search timed out"));
            }
        },
        None => join.await,
    };

    let outcome = joined.map_err(|error| ApiError::internal(error.to_string()))?;
    // Alle SearchError sind Client-Fehler (inkl. InvalidPattern, früher 500) → 400.
    outcome
        .map(Json)
        .map_err(|error| ApiError::bad_request(error.to_string()))
}
