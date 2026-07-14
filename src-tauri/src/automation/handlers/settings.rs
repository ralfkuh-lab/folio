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
    if let Some(lang) = patch.language.as_deref() {
        let registry = crate::i18n::embedded_registry();
        if !crate::i18n::is_valid_language_setting(lang, registry) {
            return Err(ApiError::bad_request(format!("invalid language: '{lang}'")));
        }
    }
    if let Some(theme_id) = patch.view_theme.as_deref() {
        let valid = crate::export::view_themes()
            .iter()
            .any(|theme| theme.id == theme_id);
        if !valid {
            return Err(ApiError::bad_request(format!(
                "unknown view theme: '{theme_id}'"
            )));
        }
    }
    if let Some(favorites) = patch.theme_favorites.as_deref() {
        let themes = crate::export::view_themes();
        for theme_id in favorites {
            if theme_id == "standard" {
                return Err(ApiError::bad_request(
                    "the standard theme cannot be a favorite",
                ));
            }
            if !themes.iter().any(|theme| theme.id == *theme_id) {
                return Err(ApiError::bad_request(format!(
                    "unknown favorite theme: '{theme_id}'"
                )));
            }
        }
    }
    let state = context.app_handle.state::<AppState>();
    crate::commands::app::settings::update_settings(patch, &context.app_handle, state.inner())
        .map(Json)
        .map_err(ApiError::internal)
}

#[cfg(test)]
mod language_validation_tests {
    use crate::automation::error::ApiError;
    use axum::http::StatusCode;

    #[test]
    fn unknown_language_maps_to_http_400() {
        let registry = crate::i18n::embedded_registry();
        assert!(!crate::i18n::is_valid_language_setting("xx", registry));
        let err = ApiError::bad_request("invalid language: 'xx'");
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn known_tags_accepted() {
        let registry = crate::i18n::embedded_registry();
        for tag in ["system", "de", "en"] {
            assert!(
                crate::i18n::is_valid_language_setting(tag, registry),
                "{tag}"
            );
        }
    }
}
