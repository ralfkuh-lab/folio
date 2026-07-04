use axum::extract::{rejection::JsonRejection, Json, State as AxumState};
use tauri::Manager;

use crate::automation::context::AutomationContext;
use crate::automation::error::{json_payload, ApiError, ApiResult};
use crate::settings::{SettingsData, SettingsPatch};
use crate::state::AppState;

pub(in crate::automation) async fn get_settings(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<SettingsData>> {
    let state = context.app_handle.state::<AppState>();
    crate::commands::app::settings::get_settings(state.inner())
        .map(Json)
        .map_err(ApiError::internal)
}

pub(in crate::automation) async fn post_settings(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<SettingsPatch>, JsonRejection>,
) -> ApiResult<Json<SettingsData>> {
    let Json(patch) = json_payload(payload)?;
    if let Some(theme_id) = patch.view_theme.as_deref() {
        let valid = crate::export::view_themes()
            .iter()
            .any(|theme| theme.id == theme_id);
        if !valid {
            return Err(ApiError::bad_request(format!(
                "Unbekanntes View-Theme: '{theme_id}'"
            )));
        }
    }
    let state = context.app_handle.state::<AppState>();
    crate::commands::app::settings::update_settings(patch, &context.app_handle, state.inner())
        .map(Json)
        .map_err(ApiError::internal)
}
