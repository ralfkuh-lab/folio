use axum::extract::{rejection::JsonRejection, Json, Query, State as AxumState};
use tauri::{LogicalSize, Manager, Size};

use crate::automation::ack;
use crate::automation::context::AutomationContext;
use crate::automation::error::{json_payload, ok, ApiError, ApiResult};
use crate::automation::helpers::{emit, main_window};
use crate::automation::types::{
    AckOptions, AckedResponse, ClickRequest, EditorCommandRequest, FindTextRequest,
    HistoryEntryResponse, HistoryMoveResponse, KeyRequest, MenuClickRequest, ModeRequest,
    OkResponse, RailRequest, ResizeRequest, RightClickRequest, ThemeRequest, TocActivateRequest,
    WorkspacePinRequest, WorkspaceUnpinRequest,
};
use crate::menu;
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

pub(in crate::automation) async fn post_rightclick(
    AxumState(context): AxumState<AutomationContext>,
    Query(options): Query<AckOptions>,
    payload: Result<Json<RightClickRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    let mut event_payload = serde_json::json!({ "name": payload.name, "requestId": request_id });
    if let Some(coords) = payload.coords {
        event_payload["coords"] = serde_json::json!({ "x": coords.x, "y": coords.y });
    }
    emit(&context, "automation:rightclick", event_payload)?;
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

pub(in crate::automation) async fn post_menu_click(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<MenuClickRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    if payload.id.is_empty() {
        return Err(ApiError::bad_request("id must not be empty"));
    }
    // Gleicher Pfad wie ein nativer Menü-Klick: dispatch_menu_action
    // führt Rust-Aktionen synchron aus (Quit, Save-As-Thread-Spawn,
    // Rename-Thread-Spawn) und emittiert `menu:<id>`-Events ans Frontend
    // für UI-Aktionen, deren Logik dort lebt. Kein Ack-Mechanismus —
    // Tests synchronisieren ueber /wait oder /state-Polling, weil die
    // Frontend-`menu:*`-Handler keinen requestId durchreichen.
    menu::dispatch_menu_action(&context.app_handle, &payload.id);
    ok()
}

pub(in crate::automation) async fn post_editor_command(
    AxumState(context): AxumState<AutomationContext>,
    Query(options): Query<AckOptions>,
    payload: Result<Json<EditorCommandRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    if payload.command.is_empty() {
        return Err(ApiError::bad_request("command must not be empty"));
    }
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "automation:editor_command",
        serde_json::json!({
            "command": payload.command,
            "args": payload.args.unwrap_or(serde_json::Value::Null),
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

pub(in crate::automation) async fn post_workspace_pin(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<WorkspacePinRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    if payload.path.is_empty() {
        return Err(ApiError::bad_request("path must not be empty"));
    }
    let state = context.app_handle.state::<AppState>();
    let delta = {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|_| ApiError::internal("workspace lock poisoned"))?;
        workspace
            .pin(payload.path.clone(), payload.is_directory)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        // Vault-Delta separat berechnen, damit das Frontend genauso
        // refresht wie nach einem Tauri-Command-Pin.
        let vault = state
            .vault
            .lock()
            .map_err(|_| ApiError::internal("vault lock poisoned"))?;
        vault.compute_refresh_delta(&workspace)
    };
    emit(
        &context,
        "vault:refresh",
        serde_json::to_value(delta).unwrap(),
    )?;
    ok()
}

pub(in crate::automation) async fn post_workspace_unpin(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<WorkspaceUnpinRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    if payload.path.is_empty() {
        return Err(ApiError::bad_request("path must not be empty"));
    }
    let state = context.app_handle.state::<AppState>();
    let delta = {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|_| ApiError::internal("workspace lock poisoned"))?;
        workspace
            .unpin(&payload.path)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let vault = state
            .vault
            .lock()
            .map_err(|_| ApiError::internal("vault lock poisoned"))?;
        vault.compute_refresh_delta(&workspace)
    };
    emit(
        &context,
        "vault:refresh",
        serde_json::to_value(delta).unwrap(),
    )?;
    ok()
}

pub(in crate::automation) async fn post_history_back(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<HistoryMoveResponse>> {
    history_move(context, false).await
}

pub(in crate::automation) async fn post_history_forward(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<HistoryMoveResponse>> {
    history_move(context, true).await
}

async fn history_move(
    context: AutomationContext,
    forward: bool,
) -> ApiResult<Json<HistoryMoveResponse>> {
    let state = context.app_handle.state::<AppState>();
    // Logik wie in commands::nav::move_history, aber inline weil dort
    // privat und an Tauri-Command-Signaturen gebunden.
    let entry = {
        let mut navigation = state
            .navigation
            .lock()
            .map_err(|_| ApiError::internal("navigation lock poisoned"))?;
        if forward {
            navigation.go_forward().cloned()
        } else {
            navigation.go_back().cloned()
        }
    };
    let Some(entry) = entry else {
        return Ok(Json(HistoryMoveResponse {
            ok: true,
            moved: false,
            entry: None,
        }));
    };
    state
        .document_store
        .lock()
        .map_err(|_| ApiError::internal("document store lock poisoned"))?
        .load(&entry.absolute_path)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    state
        .vault
        .lock()
        .map_err(|_| ApiError::internal("vault lock poisoned"))?
        .set_active(Some(entry.absolute_path.clone()));
    // Non-Markdown kennt keinen View-Mode (s. commands::nav).
    let view_mode = if crate::file_kind::classify(&entry.absolute_path)
        == crate::file_kind::FileKind::Markdown
    {
        entry.view_mode.clone()
    } else {
        "edit".to_string()
    };
    let response_entry = HistoryEntryResponse {
        path: entry.absolute_path.clone(),
        anchor: entry.anchor.clone(),
        scroll_y: entry.scroll_y,
        view_mode,
        editor_scroll_y: entry.editor_scroll_y,
        editor_cursor: entry.editor_cursor,
    };
    emit(
        &context,
        "navigation:changed",
        serde_json::to_value(&response_entry).unwrap(),
    )?;
    Ok(Json(HistoryMoveResponse {
        ok: true,
        moved: true,
        entry: Some(response_entry),
    }))
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
