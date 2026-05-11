use tauri::{Emitter, Manager};

use super::context::AutomationContext;
use super::error::{ApiError, ApiResult};

pub(super) fn emit(
    context: &AutomationContext,
    event: &str,
    payload: serde_json::Value,
) -> Result<(), ApiError> {
    context
        .app_handle
        .emit(event, payload)
        .map_err(|error| ApiError::internal(error.to_string()))
}

pub(super) fn main_window(
    context: &AutomationContext,
) -> ApiResult<tauri::WebviewWindow<tauri::Wry>> {
    context
        .app_handle
        .get_webview_window("main")
        .ok_or_else(|| ApiError::internal("main window not found"))
}
