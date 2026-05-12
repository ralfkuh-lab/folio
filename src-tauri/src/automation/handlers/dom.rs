use axum::extract::{Query, State as AxumState};
use axum::Json;
use tauri::Manager;

use crate::automation::context::AutomationContext;
use crate::automation::dom::{self, DomSnapshot};
use crate::automation::error::{ApiError, ApiResult};
use crate::automation::helpers::emit;
use crate::automation::types::{DomQuery, DomResponse};
use crate::state::AppState;

const DEFAULT_DOM_TIMEOUT_MS: u64 = 1000;

pub(in crate::automation) async fn get_dom(
    AxumState(context): AxumState<AutomationContext>,
    Query(query): Query<DomQuery>,
) -> ApiResult<Json<DomResponse>> {
    if query.selector.is_empty() {
        return Err(ApiError::bad_request("selector must not be empty"));
    }
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = dom::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "automation:dom_query",
        serde_json::json!({
            "selector": query.selector,
            "requestId": request_id,
        }),
    )?;
    let timeout_ms = query.timeout_ms.unwrap_or(DEFAULT_DOM_TIMEOUT_MS);
    match dom::wait_for(state.inner(), request_id, receiver, timeout_ms).await {
        Some(snapshot) => Ok(Json(DomResponse {
            ok: true,
            timed_out: false,
            snapshot,
        })),
        None => Ok(Json(DomResponse {
            ok: true,
            timed_out: true,
            snapshot: DomSnapshot::default(),
        })),
    }
}
