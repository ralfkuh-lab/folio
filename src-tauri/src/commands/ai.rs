use crate::{
    ai::{
        catalog::{self, CatalogResult},
        config::{AiConfigError, AiConfigService},
        types::{AiConfig, AuthStatus, CustomProviderDefinition},
    },
    state::AppState,
};
use tauri::State;

#[tauri::command]
pub async fn ai_catalog_get() -> Result<CatalogResult, String> {
    Ok(catalog::load())
}

#[tauri::command]
pub async fn ai_catalog_refresh(state: State<'_, AppState>) -> Result<CatalogResult, String> {
    let result = catalog::refresh(&state.ai_http)
        .await
        .map_err(|error| error.to_string())?;
    tracing::info!(
        target: "folio::ai",
        updated_at = %result.updated_at,
        providers = result.catalog.len(),
        "AI catalog refreshed"
    );
    Ok(result)
}

#[tauri::command]
pub async fn ai_config_get(state: State<'_, AppState>) -> Result<AiConfig, String> {
    config_data(state.inner())
}

#[tauri::command]
pub async fn ai_provider_enable(
    provider_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<AiConfig, String> {
    let result = mutate_config(state.inner(), |service| {
        service.provider_enable(provider_id.clone(), enabled)
    })?;
    tracing::debug!(
        target: "folio::ai",
        provider_id,
        enabled,
        "AI provider setting updated"
    );
    Ok(result)
}

#[tauri::command]
pub async fn ai_model_toggle(
    provider_id: String,
    model_id: String,
    on: bool,
    state: State<'_, AppState>,
) -> Result<AiConfig, String> {
    let result = mutate_config(state.inner(), |service| {
        service.model_toggle(provider_id.clone(), model_id.clone(), on)
    })?;
    tracing::debug!(
        target: "folio::ai",
        provider_id,
        model_id,
        on,
        "AI model whitelist updated"
    );
    Ok(result)
}

#[tauri::command]
pub async fn ai_custom_upsert(
    definition: CustomProviderDefinition,
    state: State<'_, AppState>,
) -> Result<AiConfig, String> {
    let provider_id = definition.id.clone();
    let result = mutate_config(state.inner(), |service| service.custom_upsert(definition))?;
    tracing::info!(
        target: "folio::ai",
        provider_id,
        "custom AI provider saved"
    );
    Ok(result)
}

#[tauri::command]
pub async fn ai_custom_delete(id: String, state: State<'_, AppState>) -> Result<AiConfig, String> {
    let result = mutate_config(state.inner(), |service| service.custom_delete(&id))?;
    tracing::info!(
        target: "folio::ai",
        provider_id = id,
        "custom AI provider deleted; auth entry left unchanged"
    );
    Ok(result)
}

#[tauri::command]
pub async fn ai_default_model_set(
    provider_id: Option<String>,
    model_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<AiConfig, String> {
    let cleared = provider_id.is_none() && model_id.is_none();
    let result = mutate_config(state.inner(), |service| {
        service.default_model_set(provider_id, model_id)
    })?;
    tracing::debug!(
        target: "folio::ai",
        cleared,
        "default AI model updated"
    );
    Ok(result)
}

#[tauri::command]
pub async fn ai_recent_languages_set(
    languages: Vec<String>,
    state: State<'_, AppState>,
) -> Result<AiConfig, String> {
    let count = languages.len();
    let result = mutate_config(state.inner(), |service| {
        service.recent_languages_set(languages)
    })?;
    tracing::debug!(
        target: "folio::ai",
        count,
        "recent AI translation languages updated"
    );
    Ok(result)
}

#[tauri::command]
pub async fn ai_auth_set(
    provider_id: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<AuthStatus, String> {
    let mut auth = state
        .ai_auth
        .lock()
        .map_err(|_| "AI auth lock poisoned".to_string())?;
    auth.set(provider_id.clone(), key)
        .map_err(|error| error.to_string())?;
    let status = auth.status();
    drop(auth);
    tracing::info!(
        target: "folio::ai",
        provider_id,
        "AI provider credentials saved"
    );
    Ok(status)
}

#[tauri::command]
pub async fn ai_auth_remove(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<AuthStatus, String> {
    let mut auth = state
        .ai_auth
        .lock()
        .map_err(|_| "AI auth lock poisoned".to_string())?;
    auth.remove(&provider_id)
        .map_err(|error| error.to_string())?;
    let status = auth.status();
    drop(auth);
    tracing::info!(
        target: "folio::ai",
        provider_id,
        "AI provider credentials removed"
    );
    Ok(status)
}

#[tauri::command]
pub async fn ai_auth_status(state: State<'_, AppState>) -> Result<AuthStatus, String> {
    Ok(state
        .ai_auth
        .lock()
        .map_err(|_| "AI auth lock poisoned".to_string())?
        .status())
}

fn config_data(state: &AppState) -> Result<AiConfig, String> {
    Ok(state
        .ai_config
        .lock()
        .map_err(|_| "AI config lock poisoned".to_string())?
        .data())
}

fn mutate_config(
    state: &AppState,
    mutation: impl FnOnce(&mut AiConfigService) -> Result<(), AiConfigError>,
) -> Result<AiConfig, String> {
    let mut service = state
        .ai_config
        .lock()
        .map_err(|_| "AI config lock poisoned".to_string())?;
    mutation(&mut service).map_err(|error| error.to_string())?;
    Ok(service.data())
}
