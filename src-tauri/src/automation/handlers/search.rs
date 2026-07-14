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
use crate::search::{self, FileResult, SearchError, SearchOptions, SearchScope, SearchStats};
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
    let options = SearchOptions {
        case_sensitive: request.case_sensitive,
        whole_word: request.whole_word,
    };

    let state = context.app_handle.state::<AppState>();
    let roots = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| ApiError::internal("workspace lock poisoned"))?;
        let scope = match request.scope {
            Some(path) => SearchScope::Folder(path),
            None => SearchScope::Vault,
        };
        search::resolve_scope(workspace.pinned(), &scope)
    };

    let query = request.query;
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_task = cancel.clone();

    let join = tauri::async_runtime::spawn_blocking(move || {
        let mut files: Vec<FileResult> = Vec::new();
        let stats = search::run_search(&roots, &query, &options, &cancel_task, &mut |file| {
            files.push(file)
        });
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
    match outcome {
        Ok(response) => Ok(Json(response)),
        Err(
            error @ (SearchError::QueryTooShort
            | SearchError::RootNotFound(_)
            | SearchError::InvalidScope(_)),
        ) => Err(ApiError::bad_request(error.to_string())),
        Err(error) => Err(ApiError::internal(error.to_string())),
    }
}
