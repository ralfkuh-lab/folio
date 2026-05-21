use axum::extract::{rejection::JsonRejection, Json, Query, State as AxumState};
use std::fs;
use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::automation::ack;
use crate::automation::context::AutomationContext;
use crate::automation::error::{json_payload, ok, ApiError, ApiResult};
use crate::automation::helpers::emit;
use crate::automation::mock::MockAutomationState;
use crate::automation::types::{
    AckOptions, AckedResponse, EditorSelectionRequest, EditorTextRequest, EditorTextResponse,
    OkResponse, OpenRequest,
};
use crate::state::AppState;

const DEFAULT_ACK_TIMEOUT_MS: u64 = 1000;

pub(in crate::automation) async fn post_open(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<OpenRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    let dirty_policy = if payload.discard {
        crate::document_service::DirtyPolicy::Discard
    } else {
        crate::document_service::DirtyPolicy::Reject
    };
    let outcome = crate::document_service::open(
        &state,
        payload.path,
        crate::document_service::OpenDocumentOptions {
            anchor: None,
            reload: crate::document_service::ReloadPolicy::Always,
            // Loopback-API ohne User-Prompt: Standardmaessig ungespeicherte Aenderungen
            // nicht still verwerfen (Reject), um Datenverlust zu vermeiden.
            // Fuer E2E-Tests / Automation-Isolierung kann ueber `payload.discard`
            // explizit opt-in ein Discard erzwungen werden.
            dirty: dirty_policy,
            apply_default_mode: true,
        },
    )
    .map_err(|error| match error {
        crate::document_service::OpenDocumentError::DirtyRejected => {
            ApiError::conflict(error.to_string())
        }
        other => ApiError::internal(other.to_string()),
    })?;
    if let Some(mode) = outcome.mode_override.as_deref() {
        emit(
            &context,
            "app:set_mode",
            serde_json::json!({ "mode": mode }),
        )?;
    }
    ok()
}

pub(in crate::automation) async fn post_open_ui(
    AxumState(context): AxumState<AutomationContext>,
    Query(options): Query<AckOptions>,
    payload: Result<Json<OpenRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "automation:open_document",
        serde_json::json!({ "path": payload.path, "requestId": request_id }),
    )?;
    // /open-ui braucht laenger als /click: Document-Load + Render +
    // optionaler Dirty-Prompt. Default 3 s, per ?ackTimeoutMs= ueberschreibbar.
    let timeout_ms = options.ack_timeout_ms.unwrap_or(3000);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn mock_post_open(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
    payload: Result<Json<OpenRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    {
        let state = state
            .lock()
            .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
        if state.dirty && !payload.discard {
            return Err(ApiError::conflict(
                "unsaved changes; dirty policy rejects open",
            ));
        }
    }
    let text =
        fs::read_to_string(&payload.path).map_err(|error| ApiError::internal(error.to_string()))?;
    let mut state = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
    state.file = Some(payload.path);
    state.text = text.replace("\r\n", "\n");
    state.dirty = false;
    ok()
}

pub(in crate::automation) async fn get_editor_text(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<EditorTextResponse>> {
    let text = context
        .app_handle
        .state::<AppState>()
        .document_store
        .lock()
        .map_err(|_| ApiError::internal("document store lock poisoned"))?
        .text
        .clone();
    Ok(Json(EditorTextResponse { text }))
}

pub(in crate::automation) async fn mock_get_editor_text(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
) -> ApiResult<Json<EditorTextResponse>> {
    let text = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?
        .text
        .clone();
    Ok(Json(EditorTextResponse { text }))
}

pub(in crate::automation) async fn post_editor_selection(
    AxumState(context): AxumState<AutomationContext>,
    Query(options): Query<AckOptions>,
    payload: Result<Json<EditorSelectionRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    {
        let mut automation = state
            .automation
            .lock()
            .map_err(|_| ApiError::internal("automation state lock poisoned"))?;
        automation.selection_start = payload.start;
        automation.selection_length = payload.length;
    }
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "automation:set_editor_selection",
        serde_json::json!({
            "start": payload.start,
            "length": payload.length,
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

pub(in crate::automation) async fn mock_post_editor_selection(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
    payload: Result<Json<EditorSelectionRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let mut state = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
    state.selection_start = payload.start;
    state.selection_length = payload.length;
    ok()
}

pub(in crate::automation) async fn post_editor_text(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<EditorTextRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    context
        .app_handle
        .state::<AppState>()
        .document_store
        .lock()
        .map_err(|_| ApiError::internal("document store lock poisoned"))?
        .update_text(payload.text.clone());
    emit(
        &context,
        "automation:set_editor_text",
        serde_json::json!({ "text": payload.text }),
    )?;
    ok()
}

pub(in crate::automation) async fn post_save(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<OkResponse>> {
    let saved = context
        .app_handle
        .state::<AppState>()
        .document_store
        .lock()
        .map_err(|_| ApiError::internal("document store lock poisoned"))?
        .save()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(OkResponse { ok: saved }))
}

pub(in crate::automation) async fn mock_post_save(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
) -> ApiResult<Json<OkResponse>> {
    let mut state = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
    state.dirty = false;
    ok()
}

pub(in crate::automation) async fn post_quit(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<OkResponse>> {
    context.app_handle.exit(0);
    ok()
}

pub(in crate::automation) async fn mock_post_quit(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
) -> ApiResult<Json<OkResponse>> {
    state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?
        .quit_requested = true;
    ok()
}
