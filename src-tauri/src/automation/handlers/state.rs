use axum::extract::{Json, State as AxumState};
use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::automation::context::AutomationContext;
use crate::automation::error::{ApiError, ApiResult};
use crate::automation::eval;
use crate::automation::helpers::emit;
use crate::automation::mock::MockAutomationState;
use crate::automation::types::{
    AutomationState, EditorAutomationState, HexAutomationState, PinnedAutomationEntry,
    RecentAutomationEntry, TocEntry, ViewAutomationState, WorkspaceAutomationState,
};
use crate::file_kind::FileKind;
use crate::state::AppState;
use crate::toc;

const HEX_STATE_EVAL_TIMEOUT_MS: u64 = 400;

async fn hex_state_from_hook(context: &AutomationContext) -> Option<HexAutomationState> {
    let state = context.app_handle.state::<AppState>();
    let (request_id, receiver) = eval::register(state.inner()).ok()?;
    if emit(
        context,
        "automation:eval",
        serde_json::json!({
            "requestId": request_id,
            "js": "(() => { const s = window.__folioHexViewState && window.__folioHexViewState(); if (!s || !s.path) return null; return { windowStart: s.windowStart, windowLen: s.windowLen, error: s.error }; })()",
        }),
    )
    .is_err()
    {
        return None;
    }
    let result = eval::wait_for(
        state.inner(),
        request_id,
        receiver,
        HEX_STATE_EVAL_TIMEOUT_MS,
    )
    .await?;
    if !result.ok {
        return None;
    }
    let value = result.value?;
    if value.is_null() {
        return None;
    }
    let window_start = json_u64(value.get("windowStart")?)?;
    let window_len = json_u64(value.get("windowLen")?)?;
    let error = match value.get("error") {
        Some(serde_json::Value::Null) | None => None,
        Some(other) => other.as_str().map(str::to_string),
    };
    Some(HexAutomationState {
        window_start,
        window_len,
        error,
    })
}

fn json_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| {
            value.as_f64().and_then(|n| {
                if n.is_finite() && n >= 0.0 && n.fract() == 0.0 {
                    Some(n as u64)
                } else {
                    None
                }
            })
        })
}

fn kind_label(kind: FileKind) -> &'static str {
    match kind {
        FileKind::Markdown => "markdown",
        FileKind::Text => "text",
        FileKind::Image => "image",
        FileKind::Binary => "binary",
    }
}

pub(in crate::automation) async fn get_state(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<AutomationState>> {
    let title = context
        .app_handle
        .get_webview_window("main")
        .and_then(|window| window.title().ok())
        .unwrap_or_else(|| "Folio".into());
    let state = context.app_handle.state::<AppState>();
    let (
        document_path,
        document_text,
        document_dirty,
        document_line_ending,
        document_kind,
        document_file_size,
        wants_hex,
        view_mode,
        navigation_state,
        tabs_list,
    ) = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| ApiError::internal("tabs lock poisoned"))?;
        let tab = tabs.active();
        let navigation_state = tab
            .navigation
            .current()
            .map(|entry| {
                (
                    entry.scroll_y,
                    entry.anchor.clone(),
                    entry.editor_scroll_y,
                    entry.editor_cursor,
                )
            })
            .unwrap_or((0.0, None, 0.0, 0));
        // Opaque-Docs (Bilder/Binary) liefern kein lineEnding, auch mit gesetztem Pfad.
        let line_ending = if tab.document_store.path.is_some() && !tab.document_store.is_opaque() {
            Some(tab.document_store.line_ending_label().to_string())
        } else {
            None
        };
        let descriptor = tab.document_store.descriptor();
        let document_kind = descriptor.map(|d| kind_label(d.kind).to_string());
        let document_file_size = descriptor.map(|d| d.file_size);
        let wants_hex = descriptor.is_some_and(|d| d.kind == FileKind::Binary);
        (
            tab.document_store.path.clone(),
            tab.document_store.text.clone(),
            tab.document_store.is_dirty,
            line_ending,
            document_kind,
            document_file_size,
            wants_hex,
            tab.view_mode.clone(),
            navigation_state,
            tabs.summaries(),
        )
    };
    let panel = state
        .panel_state
        .lock()
        .map_err(|_| ApiError::internal("panel state lock poisoned"))?
        .data();
    let automation = state
        .automation
        .lock()
        .map_err(|_| ApiError::internal("automation state lock poisoned"))?
        .clone();
    let (view_scroll_y, view_anchor, editor_scroll_y, editor_cursor) = navigation_state;
    let workspace = {
        let ws = state
            .workspace
            .lock()
            .map_err(|_| ApiError::internal("workspace lock poisoned"))?;
        let pinned = ws
            .pinned()
            .iter()
            .map(|p| PinnedAutomationEntry {
                path: p.path.clone(),
                is_directory: p.is_directory,
            })
            .collect();
        let recent = ws
            .recent()
            .iter()
            .map(|r| RecentAutomationEntry {
                path: r.path.clone(),
                last_opened: r.last_opened,
            })
            .collect();
        (pinned, recent)
    };
    let expanded_dirs = state
        .vault
        .lock()
        .map_err(|_| ApiError::internal("vault lock poisoned"))?
        .expanded_paths();
    let console_error_count = state
        .console_errors
        .lock()
        .map_err(|_| ApiError::internal("console errors lock poisoned"))?
        .len();
    let toc = toc::extract(&document_text)
        .into_iter()
        .map(|entry| TocEntry {
            level: entry.level,
            text: entry.text,
            slug: entry.slug,
            number: entry.number,
        })
        .collect();

    let lang = crate::i18n::process_translator()
        .map(|tr| tr.catalog_tag().to_string())
        .unwrap_or_else(|| "en".into());
    let fullscreen = context
        .app_handle
        .get_webview_window("main")
        .and_then(|window| window.is_fullscreen().ok())
        .unwrap_or(false);
    let hex = if wants_hex {
        hex_state_from_hook(&context).await
    } else {
        None
    };

    Ok(Json(AutomationState {
        title,
        file: document_path,
        kind: document_kind,
        file_size: document_file_size,
        hex,
        dirty: document_dirty,
        line_ending: document_line_ending,
        view_mode,
        theme: automation.theme,
        left_rail_visible: panel.left_rail_visible,
        right_rail_visible: panel.right_rail_visible,
        split_mid_percent: panel.split_mid_percent,
        zen: automation.zen,
        fullscreen,
        toc,
        editor: EditorAutomationState {
            ready: automation.editor_ready,
            selection_start: automation.selection_start,
            selection_length: automation.selection_length,
            left_rail_width: panel.left_rail_width,
            right_rail_width: panel.right_rail_width,
            scroll_y: editor_scroll_y,
            cursor_offset: editor_cursor,
        },
        view: ViewAutomationState {
            scroll_y: view_scroll_y,
            anchor: view_anchor,
        },
        workspace: WorkspaceAutomationState {
            pinned: workspace.0,
            recent: workspace.1,
            expanded_dirs,
        },
        tabs: tabs_list,
        console_error_count,
        frontend_ready: crate::i18n::ready::is_ready(),
        lang,
    }))
}

pub(in crate::automation) async fn mock_get_state(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
) -> ApiResult<Json<AutomationState>> {
    let state = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
    let toc = toc::extract(&state.text)
        .into_iter()
        .map(|entry| TocEntry {
            level: entry.level,
            text: entry.text,
            slug: entry.slug,
            number: entry.number,
        })
        .collect();

    Ok(Json(AutomationState {
        title: state.title.clone(),
        file: state.file.clone(),
        kind: None,
        file_size: None,
        hex: None,
        dirty: state.dirty,
        line_ending: state.file.as_ref().map(|_| "lf".to_string()),
        view_mode: state.view_mode.clone(),
        theme: state.theme.clone(),
        left_rail_visible: true,
        right_rail_visible: true,
        split_mid_percent: 50.0,
        zen: false,
        fullscreen: false,
        toc,
        editor: EditorAutomationState {
            ready: state.editor_ready,
            selection_start: state.selection_start,
            selection_length: state.selection_length,
            left_rail_width: 260.0,
            right_rail_width: 300.0,
            scroll_y: state.editor_scroll_y,
            cursor_offset: state.editor_cursor,
        },
        view: ViewAutomationState {
            scroll_y: state.view_scroll_y,
            anchor: state.view_anchor.clone(),
        },
        workspace: WorkspaceAutomationState {
            pinned: state
                .pinned
                .iter()
                .map(|p| PinnedAutomationEntry {
                    path: p.path.clone(),
                    is_directory: p.is_directory,
                })
                .collect(),
            recent: state
                .recent
                .iter()
                .map(|r| RecentAutomationEntry {
                    path: r.path.clone(),
                    last_opened: r.last_opened,
                })
                .collect(),
            expanded_dirs: state.expanded_dirs.clone(),
        },
        tabs: vec![crate::tab_manager::TabSummary {
            id: 1,
            path: state.file.clone(),
            dirty: state.dirty,
            active: true,
        }],
        console_error_count: state.console_errors.len(),
        frontend_ready: crate::i18n::ready::is_ready(),
        lang: crate::i18n::process_translator()
            .map(|tr| tr.catalog_tag().to_string())
            .unwrap_or_else(|| "en".into()),
    }))
}
