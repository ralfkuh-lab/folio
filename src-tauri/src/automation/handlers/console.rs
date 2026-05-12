use axum::extract::{Query, State as AxumState};
use axum::Json;
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::automation::context::AutomationContext;
use crate::automation::error::{ApiError, ApiResult};
use crate::automation::mock::MockAutomationState;
use crate::state::{AppState, ConsoleErrorRecord};

#[derive(Debug, Deserialize)]
pub(in crate::automation) struct ConsoleErrorsQuery {
    #[serde(default)]
    pub(in crate::automation) clear: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::automation) struct ConsoleErrorsResponse {
    pub(in crate::automation) ok: bool,
    pub(in crate::automation) count: usize,
    pub(in crate::automation) errors: Vec<ConsoleErrorRecord>,
}

pub(in crate::automation) async fn get_console_errors(
    AxumState(context): AxumState<AutomationContext>,
    Query(query): Query<ConsoleErrorsQuery>,
) -> ApiResult<Json<ConsoleErrorsResponse>> {
    let state = context.app_handle.state::<AppState>();
    let mut buf = state
        .console_errors
        .lock()
        .map_err(|_| ApiError::internal("console errors lock poisoned"))?;
    let errors: Vec<ConsoleErrorRecord> = buf.iter().cloned().collect();
    if query.clear {
        buf.clear();
    }
    Ok(Json(ConsoleErrorsResponse {
        ok: true,
        count: errors.len(),
        errors,
    }))
}

/// Mock-Variante (smoke_automation). Mock-State buffert die Errors auf
/// gleicher VecDeque-Struktur fuer Tests.
pub(in crate::automation) async fn mock_get_console_errors(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
    Query(query): Query<ConsoleErrorsQuery>,
) -> ApiResult<Json<ConsoleErrorsResponse>> {
    let mut snapshot = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
    let errors: Vec<ConsoleErrorRecord> = snapshot.console_errors.iter().cloned().collect();
    if query.clear {
        snapshot.console_errors.clear();
    }
    Ok(Json(ConsoleErrorsResponse {
        ok: true,
        count: errors.len(),
        errors,
    }))
}
