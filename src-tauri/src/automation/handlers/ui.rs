use axum::extract::{rejection::JsonRejection, Json, State as AxumState};
use tauri::{LogicalSize, Manager, Size};

use crate::automation::ack;
use crate::automation::context::AutomationContext;
use crate::automation::error::{json_payload, ok, ApiError, ApiResult};
use crate::automation::extract::ApiQuery;
use crate::automation::helpers::{emit, main_window};
use crate::automation::types::{
    AckOptions, AckedResponse, ClickRequest, EditorCommandRequest, FindTextRequest,
    HistoryEntryResponse, HistoryMoveResponse, KeyRequest, MenuClickRequest, ModeRequest,
    OkResponse, RailRequest, ResizeRequest, RightClickRequest, SplitRequest, SplitResponse,
    ThemeRequest, TocActivateRequest, WorkspacePinRequest, WorkspaceUnpinRequest,
};
use crate::menu;
use crate::state::AppState;

const DEFAULT_ACK_TIMEOUT_MS: u64 = 1000;

pub(in crate::automation) async fn post_mode(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<ModeRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
    let Json(payload) = json_payload(payload)?;
    let mode = payload.mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "view" | "edit" | "split") {
        return Err(ApiError::bad_request(format!("unknown mode '{mode}'")));
    }
    let state = context.app_handle.state::<AppState>();
    {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| ApiError::internal("tabs lock poisoned"))?;
        let tab = tabs.active_mut();
        tab.view_mode = mode.clone();
        tab.navigation.update_view_mode(&mode);
    }
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
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<ThemeRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
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
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "app:set_theme",
        serde_json::json!({ "mode": resolved, "requestId": request_id }),
    )?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn post_rail(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<RailRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
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
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "panel:rail_changed",
        serde_json::json!({
            "side": side,
            "visible": payload.visible,
            "leftRailVisible": panel.left_rail_visible,
            "rightRailVisible": panel.right_rail_visible,
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

pub(in crate::automation) async fn post_split(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<SplitRequest>, JsonRejection>,
) -> ApiResult<Json<SplitResponse>> {
    let Json(payload) = json_payload(payload)?;
    if !payload.percent.is_finite() {
        return Err(ApiError::bad_request("percent must be finite"));
    }
    let state = context.app_handle.state::<AppState>();
    let percent = {
        let mut panel_state = state
            .panel_state
            .lock()
            .map_err(|_| ApiError::internal("panel state lock poisoned"))?;
        panel_state
            .set_split_mid_percent(payload.percent)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        panel_state.data().split_mid_percent
    };
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "panel:split_mid_changed",
        serde_json::json!({ "percent": percent, "requestId": request_id }),
    )?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(SplitResponse {
        ok: true,
        acked,
        request_id,
        percent,
    }))
}

pub(in crate::automation) async fn post_click(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
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
    ApiQuery(options): ApiQuery<AckOptions>,
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

/// Deterministischer Render-Sync fuer E2E-Screenshots: emittiert
/// `automation:sync_render` und antwortet erst, wenn das Frontend einen
/// Microtask + zwei Frames durch hat (und laufende CSS-Transitions
/// abgeklungen sind). Ersetzt das fruehere fixe `time.sleep(0.20)` vor
/// jedem Screenshot — kein Body, nur optionaler `ackTimeoutMs`-Query.
pub(in crate::automation) async fn post_sync_render(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
) -> ApiResult<Json<AckedResponse>> {
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    emit(
        &context,
        "automation:sync_render",
        serde_json::json!({ "requestId": request_id }),
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
    ApiQuery(options): ApiQuery<AckOptions>,
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
    ApiQuery(options): ApiQuery<AckOptions>,
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
    emit(&context, "editor:open_find", serde_json::json!({}))?;
    emit(
        &context,
        "editor:set_find_term",
        serde_json::json!({
            "term": payload.term,
            "caseSensitive": payload.case_sensitive,
            "wholeWord": payload.whole_word,
        }),
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
    ApiQuery(options): ApiQuery<AckOptions>,
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
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<WorkspacePinRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
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
    // Sync GitHeadWatcher on pin (new git root may appear) — use shared helper
    crate::commands::workspace_cmd::sync_git_head_watcher(state.inner());
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    let mut event_payload =
        serde_json::to_value(delta).map_err(|e| ApiError::internal(e.to_string()))?;
    event_payload["requestId"] = serde_json::json!(request_id);
    emit(&context, "vault:refresh", event_payload)?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn post_workspace_unpin(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
    payload: Result<Json<WorkspaceUnpinRequest>, JsonRejection>,
) -> ApiResult<Json<AckedResponse>> {
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
    // Sync GitHeadWatcher on unpin (git root may be removed) — use shared helper
    crate::commands::workspace_cmd::sync_git_head_watcher(state.inner());
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    let mut event_payload =
        serde_json::to_value(delta).map_err(|e| ApiError::internal(e.to_string()))?;
    event_payload["requestId"] = serde_json::json!(request_id);
    emit(&context, "vault:refresh", event_payload)?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn post_workspace_clear_recents(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
) -> ApiResult<Json<AckedResponse>> {
    let state = context.app_handle.state::<AppState>();
    let delta = {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|_| ApiError::internal("workspace lock poisoned"))?;
        workspace
            .clear_recent()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        // Vault-Delta separat berechnen, damit das Frontend genauso
        // refresht wie nach einem Tauri-Command-Unpin.
        let vault = state
            .vault
            .lock()
            .map_err(|_| ApiError::internal("vault lock poisoned"))?;
        vault.compute_refresh_delta(&workspace)
    };
    // Recents-Menue im nativen Menuebaum nachziehen (analog
    // workspace_remove_recent-Command). Kein GitHeadWatcher-Sync noetig:
    // Recents tragen keine Git-Roots, nur Pins tun das.
    crate::menu::refresh_recent_from_workspace(&context.app_handle);
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    let _guard = ack::PendingGuard::new(&state.inner().pending_acks, request_id);
    let mut event_payload =
        serde_json::to_value(delta).map_err(|e| ApiError::internal(e.to_string()))?;
    event_payload["requestId"] = serde_json::json!(request_id);
    emit(&context, "vault:refresh", event_payload)?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(AckedResponse {
        ok: true,
        acked,
        request_id,
    }))
}

pub(in crate::automation) async fn post_history_back(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
) -> ApiResult<Json<HistoryMoveResponse>> {
    history_move(context, false, options).await
}

pub(in crate::automation) async fn post_history_forward(
    AxumState(context): AxumState<AutomationContext>,
    ApiQuery(options): ApiQuery<AckOptions>,
) -> ApiResult<Json<HistoryMoveResponse>> {
    history_move(context, true, options).await
}

async fn history_move(
    context: AutomationContext,
    forward: bool,
    options: AckOptions,
) -> ApiResult<Json<HistoryMoveResponse>> {
    let state = context.app_handle.state::<AppState>();
    let entry = crate::document_service::move_history(&state.tabs, &state.vault, forward)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let Some(entry) = entry else {
        // Stack-Edge: can_go_*-Gate hat den Move verhindert.
        return Ok(Json(HistoryMoveResponse {
            ok: true,
            moved: false,
            acked: false,
            request_id: None,
            entry: None,
        }));
    };
    let view_mode =
        crate::document_service::history_view_mode(&entry.absolute_path, &entry.view_mode);
    let response_entry = HistoryEntryResponse {
        path: entry.absolute_path.clone(),
        anchor: entry.anchor.clone(),
        scroll_y: entry.scroll_y,
        view_mode,
        editor_scroll_y: entry.editor_scroll_y,
        editor_cursor: entry.editor_cursor,
    };
    let (request_id, receiver) = ack::register(state.inner()).map_err(ApiError::internal)?;
    let mut event_payload =
        serde_json::to_value(&response_entry).map_err(|e| ApiError::internal(e.to_string()))?;
    event_payload["requestId"] = serde_json::json!(request_id);
    emit(&context, "navigation:changed", event_payload)?;
    let timeout_ms = options.ack_timeout_ms.unwrap_or(DEFAULT_ACK_TIMEOUT_MS);
    let acked = ack::wait_for_ack(state.inner(), request_id, receiver, timeout_ms).await;
    Ok(Json(HistoryMoveResponse {
        ok: true,
        moved: true,
        acked,
        request_id: Some(request_id),
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
