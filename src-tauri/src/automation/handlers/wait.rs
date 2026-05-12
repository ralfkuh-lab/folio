use axum::extract::{rejection::JsonRejection, Json, State as AxumState};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::time::{sleep, Duration};

use crate::automation::context::AutomationContext;
use crate::automation::error::{json_payload, ApiError, ApiResult};
use crate::automation::mock::MockAutomationState;
use crate::automation::types::{WaitRequest, WaitResponse};
use crate::automation::wait;
use crate::state::AppState;

const DEFAULT_WAIT_TIMEOUT_MS: u64 = 5000;

pub(in crate::automation) async fn post_wait(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<WaitRequest>, JsonRejection>,
) -> ApiResult<Json<WaitResponse>> {
    let Json(payload) = json_payload(payload)?;
    if !wait::is_known(&payload.event) {
        return Err(ApiError::bad_request(format!(
            "unknown event '{}', allowed: {}",
            payload.event,
            wait::KNOWN_EVENTS.join(", ")
        )));
    }
    let state = context.app_handle.state::<AppState>();
    // Latch-Check: editor.ready ist schon true → sofort return.
    if wait::already_satisfied(state.inner(), &payload.event) {
        return Ok(Json(WaitResponse {
            ok: true,
            fired: true,
            event: payload.event,
        }));
    }
    let (id, receiver) =
        wait::register(state.inner(), &payload.event).map_err(ApiError::internal)?;
    let timeout_ms = payload.timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
    let fired = wait::wait_for(state.inner(), &payload.event, id, receiver, timeout_ms).await;
    Ok(Json(WaitResponse {
        ok: true,
        fired,
        event: payload.event,
    }))
}

/// Mock-Variante fuer smoke_automation. Latch fuer `editor.ready` ueber
/// den Mock-State; transienten Events steht kein Trigger zur Verfuegung,
/// daher laufen sie deterministisch ins Timeout (fired=false).
pub(in crate::automation) async fn mock_post_wait(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
    payload: Result<Json<WaitRequest>, JsonRejection>,
) -> ApiResult<Json<WaitResponse>> {
    let Json(payload) = json_payload(payload)?;
    if !wait::is_known(&payload.event) {
        return Err(ApiError::bad_request(format!(
            "unknown event '{}', allowed: {}",
            payload.event,
            wait::KNOWN_EVENTS.join(", ")
        )));
    }
    if payload.event == "editor.ready" {
        let ready = state
            .lock()
            .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?
            .editor_ready;
        if ready {
            return Ok(Json(WaitResponse {
                ok: true,
                fired: true,
                event: payload.event,
            }));
        }
    }
    sleep(Duration::from_millis(
        payload.timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS),
    ))
    .await;
    Ok(Json(WaitResponse {
        ok: true,
        fired: false,
        event: payload.event,
    }))
}
