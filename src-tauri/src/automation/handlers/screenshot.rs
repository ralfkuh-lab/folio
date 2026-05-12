//! `/screenshot`-Handler. Liefert einen PNG-Schnappschuss des Monitors
//! ueber `tauri-plugin-screenshots`. Monitor-Capture statt Window-
//! Capture, weil der Monaco-Editor-Canvas in Xvfb/Headless nur im
//! globalen Screen-Framebuffer landet, nicht im Window-Pixmap —
//! siehe `docs/headless-monaco-test-results.md`, Option 3.

use axum::extract::State as AxumState;
use axum::response::IntoResponse;

use crate::automation::context::AutomationContext;
use crate::automation::error::{ApiError, ApiResult};

pub(in crate::automation) async fn get_screenshot(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<impl IntoResponse> {
    let monitors = tauri_plugin_screenshots::get_screenshotable_monitors()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let first_monitor = monitors
        .first()
        .ok_or_else(|| ApiError::internal("no monitors found"))?;

    let path = tauri_plugin_screenshots::get_monitor_screenshot(
        context.app_handle.clone(),
        first_monitor.id,
    )
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;

    let bytes = std::fs::read(&path).map_err(|error| ApiError::internal(error.to_string()))?;
    let _ = std::fs::remove_file(&path);

    Ok(([(axum::http::header::CONTENT_TYPE, "image/png")], bytes))
}
