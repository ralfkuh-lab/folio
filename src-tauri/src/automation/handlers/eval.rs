use axum::extract::State as AxumState;
use axum::Json;
use serde::Deserialize;
use tauri::Manager;

use crate::automation::context::AutomationContext;
use crate::automation::error::{ApiError, ApiResult};
use crate::automation::eval;
use crate::automation::helpers::emit;
use crate::state::AppState;

const DEFAULT_EVAL_TIMEOUT_MS: u64 = 5000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::automation) struct EvalRequest {
    pub(in crate::automation) js: String,
    #[serde(default)]
    pub(in crate::automation) timeout_ms: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::automation) struct EvalResponse {
    pub(in crate::automation) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::automation) value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::automation) error: Option<String>,
    pub(in crate::automation) timed_out: bool,
}

pub(in crate::automation) async fn post_eval(
    AxumState(context): AxumState<AutomationContext>,
    Json(payload): Json<EvalRequest>,
) -> ApiResult<Json<EvalResponse>> {
    if payload.js.is_empty() {
        return Err(ApiError::bad_request("js must not be empty"));
    }
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = eval::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "automation:eval",
        serde_json::json!({
            "requestId": request_id,
            "js": payload.js,
        }),
    )?;
    let timeout_ms = payload.timeout_ms.unwrap_or(DEFAULT_EVAL_TIMEOUT_MS);
    match eval::wait_for(state.inner(), request_id, receiver, timeout_ms).await {
        Some(result) => Ok(Json(EvalResponse {
            ok: result.ok,
            value: result.value,
            error: result.error,
            timed_out: false,
        })),
        None => Ok(Json(EvalResponse {
            ok: false,
            value: None,
            error: Some("eval timed out".into()),
            timed_out: true,
        })),
    }
}
