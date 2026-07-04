use axum::extract::{rejection::JsonRejection, Json, State as AxumState};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::automation::ack;
use crate::automation::context::AutomationContext;
use crate::automation::error::{json_payload, ApiError, ApiResult};
use crate::automation::extract::ApiQuery;
use crate::automation::types::AckOptions;
use crate::commands::tabs::{self, TabError, TabTransition};
use crate::document_service::DirtyPolicy;
use crate::state::AppState;
use crate::tab_manager::{TabSummary, TabsPayload};

const DEFAULT_ACK_TIMEOUT_MS: u64 = 3000;

#[derive(Debug, Deserialize)]
pub(in crate::automation) struct TabOpenRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
pub(in crate::automation) struct TabIdRequest {
    id: u64,
}

#[derive(Debug, Deserialize)]
pub(in crate::automation) struct TabCloseRequest {
    id: u64,
    #[serde(default)]
    discard: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::automation) struct TabMutationResponse {
    ok: bool,
    acked: bool,
    request_id: Option<u64>,
    tab: TabSummary,
}

pub(in crate::automation) async fn get_tabs(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<TabsPayload>> {
    let state = context.app_handle.state::<AppState>();
    Ok(Json(tabs::list(&state).map_err(api_error)?))
}

pub(in crate::automation) async fn post_open(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<TabOpenRequest>, JsonRejection>,
) -> ApiResult<Json<TabMutationResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    let transition = tabs::open(&state, &context.app_handle, payload.path).map_err(api_error)?;
    respond_after_frontend(context, transition, options).await
}

pub(in crate::automation) async fn post_close(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<TabCloseRequest>, JsonRejection>,
) -> ApiResult<Json<TabMutationResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    let policy = if payload.discard {
        DirtyPolicy::Discard
    } else {
        DirtyPolicy::Reject
    };
    let transition =
        tabs::close(&state, &context.app_handle, payload.id, policy).map_err(api_error)?;
    respond_after_frontend(context, transition, options).await
}

pub(in crate::automation) async fn post_activate(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<TabIdRequest>, JsonRejection>,
) -> ApiResult<Json<TabMutationResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    let transition = tabs::activate(&state, &context.app_handle, payload.id).map_err(api_error)?;
    respond_after_frontend(context, transition, options).await
}

pub(in crate::automation) async fn post_close_all(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
) -> ApiResult<Json<TabMutationResponse>> {
    let state = context.app_handle.state::<AppState>();
    let transition = tabs::close_all(&state, &context.app_handle).map_err(api_error)?;
    respond_after_frontend(context, transition, options).await
}

async fn respond_after_frontend(
    context: AutomationContext,
    transition: TabTransition,
    options: AckOptions,
) -> ApiResult<Json<TabMutationResponse>> {
    if !transition.frontend_changed {
        return Ok(Json(TabMutationResponse {
            ok: true,
            acked: false,
            request_id: None,
            tab: transition.tab,
        }));
    }

    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    tabs::emit_navigation_changed(&context.app_handle, &transition, Some(request_id))
        .map_err(api_error)?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(TabMutationResponse {
        ok: true,
        acked,
        request_id: Some(request_id),
        tab: transition.tab,
    }))
}

fn api_error(error: TabError) -> ApiError {
    match error {
        TabError::UnknownId(_) => ApiError::not_found(error.to_string()),
        TabError::DirtyRejected(_) => ApiError::conflict(error.to_string()),
        TabError::InvalidPath(_) => ApiError::bad_request(error.to_string()),
        TabError::Internal(_) => ApiError::internal(error.to_string()),
    }
}
