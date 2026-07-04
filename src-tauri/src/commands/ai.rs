use crate::{
    ai::{
        catalog::{self, CatalogResult},
        config::{AiConfigError, AiConfigService},
        types::{AiConfig, AuthStatus, CustomProviderDefinition},
    },
    state::AppState,
};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use std::{collections::BTreeSet, time::Duration};
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
pub async fn ai_custom_models_fetch(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<AiConfig, String> {
    let (base_url, key) = {
        let config = config_data(state.inner())?;
        let provider = config
            .provider
            .get(&provider_id)
            .ok_or_else(|| format!("Custom-Provider '{provider_id}' wurde nicht gefunden"))?;
        if !provider.custom {
            return Err(format!("Provider '{provider_id}' ist kein Custom-Provider"));
        }
        let base_url = provider
            .options
            .as_ref()
            .map(|options| options.base_url.clone())
            .filter(|url| !url.trim().is_empty())
            .ok_or_else(|| format!("Custom-Provider '{provider_id}' hat keine Basis-URL"))?;
        let key = state
            .ai_auth
            .lock()
            .map_err(|_| "AI auth lock poisoned".to_string())?
            .get_key(&provider_id);
        (base_url, key)
    };

    let url = custom_models_url(&base_url)?;
    let mut request = state.ai_http.get(url).timeout(Duration::from_secs(15));
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|error| {
        format!("Modelle von Provider '{provider_id}' konnten nicht abgerufen werden: {error}")
    })?;
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        format!("Antwort von Provider '{provider_id}' konnte nicht gelesen werden: {error}")
    })?;
    if !status.is_success() {
        return Err(http_error(&provider_id, status, &body));
    }
    let model_ids = parse_custom_models(&body).map_err(|error| {
        format!("Provider '{provider_id}' lieferte keine gültige Modellliste: {error}")
    })?;

    let count = model_ids.len();
    let result = mutate_config(state.inner(), |service| {
        service.custom_models_replace(&provider_id, model_ids)
    })?;
    tracing::info!(
        target: "folio::ai",
        provider_id,
        count,
        "custom AI provider models refreshed"
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

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

fn custom_models_url(base_url: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url.trim())
        .map_err(|error| format!("Ungültige Basis-URL für Custom-Provider: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Basis-URL des Custom-Providers muss eine HTTP(S)-URL sein".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    if !path.ends_with("/models") {
        url.set_path(&format!("{path}/models"));
    } else {
        url.set_path(&path);
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn parse_custom_models(body: &str) -> Result<BTreeSet<String>, serde_json::Error> {
    let response = serde_json::from_str::<OpenAiModelsResponse>(body)?;
    Ok(response
        .data
        .into_iter()
        .map(|model| model.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect())
}

fn http_error(provider_id: &str, status: StatusCode, body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let message = compact.chars().take(300).collect::<String>();
    if message.is_empty() {
        format!("Provider '{provider_id}' antwortete mit HTTP-Status {status}")
    } else {
        format!("Provider '{provider_id}' antwortete mit HTTP-Status {status}: {message}")
    }
}

#[cfg(test)]
mod tests {
    use super::{custom_models_url, parse_custom_models};

    #[test]
    fn custom_models_url_appends_models_once() {
        assert_eq!(
            "http://localhost:11434/v1/models",
            custom_models_url("http://localhost:11434/v1")
                .unwrap()
                .as_str()
        );
        assert_eq!(
            "https://example.test/v1/models",
            custom_models_url("https://example.test/v1/models/")
                .unwrap()
                .as_str()
        );
    }

    #[test]
    fn custom_models_parser_reads_openai_data_and_deduplicates_ids() {
        let parsed = parse_custom_models(
            r#"{"object":"list","data":[{"id":"zeta"},{"id":"alpha"},{"id":"zeta"},{"id":"  "}]} "#,
        )
        .unwrap();
        assert_eq!(
            vec!["alpha", "zeta"],
            parsed.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert!(parse_custom_models(r#"{"models":[]}"#).is_err());
    }
}
