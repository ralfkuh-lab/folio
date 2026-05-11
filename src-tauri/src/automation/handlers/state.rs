use axum::extract::{Json, State as AxumState};
use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::automation::context::AutomationContext;
use crate::automation::error::{ApiError, ApiResult};
use crate::automation::mock::MockAutomationState;
use crate::automation::types::{AutomationState, EditorAutomationState, TocEntry};
use crate::state::AppState;
use crate::toc;

pub(in crate::automation) async fn get_state(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<AutomationState>> {
    let title = context
        .app_handle
        .get_webview_window("main")
        .and_then(|window| window.title().ok())
        .unwrap_or_else(|| "Folio".into());
    let state = context.app_handle.state::<AppState>();
    let document = state
        .document_store
        .lock()
        .map_err(|_| ApiError::internal("document store lock poisoned"))?;
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
    let toc = toc::extract(&document.text)
        .into_iter()
        .map(|entry| TocEntry {
            level: entry.level,
            text: entry.text,
            slug: entry.slug,
            number: entry.number,
        })
        .collect();

    Ok(Json(AutomationState {
        title,
        file: document.path.clone(),
        dirty: document.is_dirty,
        view_mode: automation.view_mode,
        theme: automation.theme,
        left_rail_visible: panel.left_rail_visible,
        right_rail_visible: panel.right_rail_visible,
        toc,
        editor: EditorAutomationState {
            ready: automation.editor_ready,
            selection_start: automation.selection_start,
            selection_length: automation.selection_length,
            left_rail_width: panel.left_rail_width,
            right_rail_width: panel.right_rail_width,
        },
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
        dirty: state.dirty,
        view_mode: state.view_mode.clone(),
        theme: state.theme.clone(),
        left_rail_visible: true,
        right_rail_visible: true,
        toc,
        editor: EditorAutomationState {
            ready: state.editor_ready,
            selection_start: state.selection_start,
            selection_length: state.selection_length,
            left_rail_width: 260.0,
            right_rail_width: 300.0,
        },
    }))
}
