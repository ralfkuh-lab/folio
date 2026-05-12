use axum::extract::{rejection::JsonRejection, Json, Query, State as AxumState};
use tauri::{LogicalSize, Manager, Size};

use crate::automation::ack;
use crate::automation::context::AutomationContext;
use crate::automation::error::{json_payload, ok, ApiError, ApiResult};
use crate::automation::helpers::{emit, main_window};
use crate::automation::types::{
    AckOptions, AckedResponse, ClickRequest, FindTextRequest, KeyRequest, ModeRequest, OkResponse,
    RailRequest, ResizeRequest, ThemeRequest, TocActivateRequest,
};
use crate::state::AppState;

const DEFAULT_ACK_TIMEOUT_MS: u64 = 1000;

pub(in crate::automation) async fn post_mode(
    AxumState(context): AxumState<AutomationContext>,
    Query(options): Query<AckOptions>,
    payload: Result<Json<ModeRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    let mode = payload.mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "view" | "edit" | "split") {
        return Err(ApiError::bad_request(format!("unknown mode '{mode}'")));
    }
    let state = context.app_handle.state::<AppState>();
    state
        .automation
        .lock()
        .map_err(|_| ApiError::internal("automation state lock poisoned"))?
        .view_mode = mode.clone();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "app:set_mode",
        serde_json::json!({ "mode": mode, "requestId": request_id }),
    )?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn post_theme(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<ThemeRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let mode = payload.mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "light" | "dark" | "toggle") {
        return Err(ApiError::bad_request(format!("unknown theme '{mode}'")));
    }
    let resolved = {
        let state = context.app_handle.state::<AppState>();
        let mut theme = state
            .theme
            .lock()
            .map_err(|_| ApiError::internal("theme lock poisoned"))?;
        let resolved = if mode == "toggle" {
            theme
                .toggle()
                .map_err(|error| ApiError::internal(error.to_string()))?
                .to_string()
        } else {
            theme
                .set_mode(&mode)
                .map_err(|error| ApiError::internal(error.to_string()))?;
            theme.mode().to_string()
        };
        state
            .automation
            .lock()
            .map_err(|_| ApiError::internal("automation state lock poisoned"))?
            .theme = resolved.clone();
        resolved
    };
    emit(
        &context,
        "app:set_theme",
        serde_json::json!({ "mode": resolved }),
    )?;
    ok()
}

pub(in crate::automation) async fn post_rail(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<RailRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let side = payload.side.to_ascii_lowercase();
    if !matches!(side.as_str(), "left" | "right") {
        return Err(ApiError::bad_request(format!("unknown side '{side}'")));
    }
    let panel = {
        let state = context.app_handle.state::<AppState>();
        let mut panel_state = state
            .panel_state
            .lock()
            .map_err(|_| ApiError::internal("panel state lock poisoned"))?;
        panel_state
            .set_rail_visible(&side, payload.visible)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        panel_state.data()
    };
    emit(
        &context,
        "panel:rail_changed",
        serde_json::json!({
            "side": side,
            "visible": payload.visible,
            "leftRailVisible": panel.left_rail_visible,
            "rightRailVisible": panel.right_rail_visible,
        }),
    )?;
    ok()
}

pub(in crate::automation) async fn post_click(
    AxumState(context): AxumState<AutomationContext>,
    Query(options): Query<AckOptions>,
    payload: Result<Json<ClickRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "automation:click",
        serde_json::json!({ "name": payload.name, "requestId": request_id }),
    )?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn post_key(
    AxumState(context): AxumState<AutomationContext>,
    Query(options): Query<AckOptions>,
    payload: Result<Json<KeyRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    if payload.key.is_empty() {
        return Err(ApiError::bad_request("key must not be empty"));
    }
    let target = payload.target.as_deref().unwrap_or("document");
    if !matches!(target, "document" | "editor") {
        return Err(ApiError::bad_request(format!("unknown target '{target}'")));
    }
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "automation:key",
        serde_json::json!({
            "key": payload.key,
            "modifiers": {
                "ctrl": payload.modifiers.ctrl,
                "shift": payload.modifiers.shift,
                "alt": payload.modifiers.alt,
                "meta": payload.modifiers.meta,
            },
            "target": target,
            "requestId": request_id,
        }),
    )?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn post_toc_activate(
    AxumState(context): AxumState<AutomationContext>,
    Query(options): Query<AckOptions>,
    payload: Result<Json<TocActivateRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "navigation:toc_click",
        serde_json::json!({
            "anchor": payload.slug,
            "slug": payload.slug,
            "requestId": request_id,
        }),
    )?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn post_focus(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<OkResponse>> {
    let window = main_window(&context)?;
    window
        .show()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    window
        .set_focus()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    ok()
}

pub(in crate::automation) async fn post_find(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<OkResponse>> {
    emit(&context, "editor:open_find", serde_json::json!({}))?;
    ok()
}

pub(in crate::automation) async fn post_find_text(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<FindTextRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    emit(
        &context,
        "editor:set_find_term",
        serde_json::json!({ "term": payload.term }),
    )?;
    ok()
}

pub(in crate::automation) async fn post_resize(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<ResizeRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    main_window(&context)?
        .set_size(Size::Logical(LogicalSize::new(
            payload.width,
            payload.height,
        )))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    ok()
}
