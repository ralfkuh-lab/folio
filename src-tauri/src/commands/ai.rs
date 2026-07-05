use crate::{
    ai::{
        catalog::{self, CatalogResult},
        client::{self, ChatMessage},
        config::{AiConfigError, AiConfigService},
        mask,
        types::{AiConfig, AuthStatus, Catalog, CustomProviderDefinition},
    },
    file_kind::{classify, FileKind},
    state::AppState,
};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
    time::Duration,
    time::Instant,
};
use tauri::{AppHandle, Emitter, State};

struct ActiveTranslation<'a> {
    active: &'a Mutex<bool>,
}

impl Drop for ActiveTranslation<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            *active = false;
        }
    }
}

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
    if let Some(key) = key.as_deref() {
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
        return Err(http_error(&provider_id, status, &body, key.as_deref()));
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
pub async fn ai_translate_document(
    languages: Vec<String>,
    provider_id: String,
    model_id: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<Vec<String>, String> {
    let _active = {
        let mut active = state
            .ai_translate_active
            .lock()
            .map_err(|_| "AI translation lock poisoned".to_string())?;
        if *active {
            return Err("Es läuft bereits eine KI-Übersetzung.".to_string());
        }
        *active = true;
        ActiveTranslation {
            active: &state.ai_translate_active,
        }
    };
    state.ai_translate_cancel.store(false, Ordering::Release);
    let languages = normalize_languages(languages)?;
    let (source_path, source_text) = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        let store = &tabs.active().document_store;
        let path = store.path.clone().ok_or_else(|| {
            "Für die Übersetzung muss ein gespeichertes Dokument geöffnet sein.".to_string()
        })?;
        if classify(&path) != FileKind::Markdown {
            return Err("Nur Markdown-Dokumente können mit KI übersetzt werden.".to_string());
        }
        // `DocumentStore::text` ist derselbe kanonische Inhalt, den Save
        // verwendet. `editor_text_changed` hält ihn auch bei Dirty-Text
        // aktuell; der Dialog awaited direkt vor diesem Command zusätzlich
        // einen expliziten Sync.
        (path, store.text.clone())
    };

    let (base_url, api_key) = {
        let config = config_data(state.inner())?;
        let catalog = catalog::load().catalog;
        let provider = config
            .provider
            .get(&provider_id)
            .ok_or_else(|| format!("KI-Provider '{provider_id}' ist nicht konfiguriert."))?;
        if !provider.enabled {
            return Err(format!("KI-Provider '{provider_id}' ist nicht aktiviert."));
        }
        if !provider.whitelist.iter().any(|id| id == &model_id) {
            return Err(format!(
                "Modell '{model_id}' ist für Provider '{provider_id}' nicht freigeschaltet."
            ));
        }
        let base_url = provider_base_url(&config, &catalog, &provider_id)?;
        let key = state
            .ai_auth
            .lock()
            .map_err(|_| "AI auth lock poisoned".to_string())?
            .get_key(&provider_id);
        (base_url, key)
    };

    mutate_config(state.inner(), |service| {
        service.recent_languages_set(languages.clone())
    })?;

    let masked = mask::mask(&source_text);
    let mut created = Vec::with_capacity(languages.len());
    for language in languages {
        if state.ai_translate_cancel.load(Ordering::Acquire) {
            break;
        }

        let path = reserve_translation(&source_path, &language)
            .map_err(|error| translation_error(&language, &created, error))?;
        let normalized_path = path.to_string_lossy().replace('\\', "/");
        let transition =
            match crate::commands::tabs::open(state.inner(), &handle, normalized_path.clone()) {
                Ok(transition) => transition,
                Err(error) => {
                    remove_translation_file(&path);
                    return Err(translation_error(&language, &created, error.to_string()));
                }
            };
        let tab_id = transition.tab.id;
        if let Err(error) =
            crate::commands::tabs::emit_navigation_changed(&handle, &transition, None)
        {
            cleanup_translation(state.inner(), &handle, tab_id, &path);
            return Err(translation_error(&language, &created, error.to_string()));
        }

        let messages = [
            ChatMessage::system(client::translation_system_prompt(&language)),
            ChatMessage::user(masked.text.clone()),
        ];
        let cancel = state.ai_translate_cancel.clone();
        let mut last_emit = None;
        let mut emit_error = None;
        let translated_raw = client::chat_stream_cancellable(
            &state.ai_http,
            &base_url,
            api_key.as_deref(),
            &model_id,
            &messages,
            |accumulated| {
                let now = Instant::now();
                if last_emit.is_some_and(|last: Instant| {
                    now.duration_since(last) < Duration::from_millis(150)
                }) {
                    return;
                }
                last_emit = Some(now);
                let text = mask::unmask_partial(accumulated, &masked);
                let chars = text.chars().count();
                if let Err(error) = handle.emit(
                    "ai:translate_stream",
                    serde_json::json!({
                        "tabId": tab_id,
                        "language": language,
                        "text": text,
                        "chars": chars,
                    }),
                ) {
                    emit_error = Some(error.to_string());
                }
            },
            || cancel.load(Ordering::Acquire),
        )
        .await;

        if matches!(translated_raw, Err(client::ChatError::Cancelled))
            || state.ai_translate_cancel.load(Ordering::Acquire)
        {
            cleanup_translation(state.inner(), &handle, tab_id, &path);
            break;
        }
        let translated_raw = match translated_raw {
            Ok(translated) => translated,
            Err(error) => {
                cleanup_translation(state.inner(), &handle, tab_id, &path);
                return Err(translation_error(&language, &created, error.to_string()));
            }
        };
        if let Some(error) = emit_error {
            cleanup_translation(state.inner(), &handle, tab_id, &path);
            return Err(translation_error(&language, &created, error));
        }
        let translated = match mask::unmask(&translated_raw, &masked) {
            Ok(translated) => translated,
            Err(error) => {
                cleanup_translation(state.inner(), &handle, tab_id, &path);
                return Err(translation_error(&language, &created, error.to_string()));
            }
        };
        if let Err(error) = finalize_translation(&path, translated.as_bytes()) {
            cleanup_translation(state.inner(), &handle, tab_id, &path);
            return Err(translation_error(&language, &created, error));
        }
        if let Err(error) = reload_translation_tab(state.inner(), tab_id, &normalized_path) {
            cleanup_translation(state.inner(), &handle, tab_id, &path);
            return Err(translation_error(&language, &created, error));
        }
        created.push(normalized_path.clone());
        handle
            .emit(
                "ai:translate_done",
                serde_json::json!({
                    "tabId": tab_id,
                    "language": language,
                    "path": normalized_path,
                }),
            )
            .map_err(|error| translation_error(&language, &created, error.to_string()))?;
    }

    tracing::info!(
        target: "folio::ai",
        provider_id,
        model_id,
        files = created.len(),
        "AI document translation completed"
    );
    Ok(created)
}

#[tauri::command]
pub async fn ai_translate_cancel(state: State<'_, AppState>) -> Result<(), String> {
    state.ai_translate_cancel.store(true, Ordering::Release);
    Ok(())
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

fn provider_base_url(
    config: &AiConfig,
    catalog: &Catalog,
    provider_id: &str,
) -> Result<String, String> {
    let configured = config.provider.get(provider_id);
    let endpoint = if configured.is_some_and(|provider| provider.custom) {
        configured
            .and_then(|provider| provider.options.as_ref())
            .map(|options| options.base_url.trim())
            .filter(|url| !url.is_empty())
    } else {
        catalog
            .get(provider_id)
            .and_then(|provider| provider.api.as_deref())
            .map(str::trim)
            .filter(|url| !url.is_empty())
    };
    endpoint
        .map(str::to_string)
        .ok_or_else(|| format!("Provider '{provider_id}' hat keinen bekannten Endpoint."))
}

fn normalize_languages(languages: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for language in languages {
        let language = language.trim().to_ascii_lowercase();
        if language.is_empty() {
            continue;
        }
        if !language
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(format!(
                "Ungültiger Sprachcode '{language}': erlaubt sind Buchstaben, Zahlen und '-'."
            ));
        }
        if !normalized.contains(&language) {
            normalized.push(language);
        }
    }
    if normalized.is_empty() {
        return Err("Bitte mindestens eine Zielsprache auswählen.".to_string());
    }
    Ok(normalized)
}

fn reserve_translation(source_path: &str, language: &str) -> Result<PathBuf, String> {
    let source = Path::new(source_path);
    let parent = source
        .parent()
        .ok_or_else(|| "Das Quelldokument hat kein Zielverzeichnis.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Der Dateiname des Quelldokuments ist ungültig.".to_string())?;

    for suffix in 0usize.. {
        let filename = if suffix == 0 {
            format!("{stem}.{language}.md")
        } else {
            format!("{stem}.{language}-{suffix}.md")
        };
        let path = parent.join(filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Übersetzungsdatei '{}' konnte nicht angelegt werden: {error}",
                    path.display()
                ));
            }
        }
    }
    unreachable!("unbounded collision suffix loop")
}

fn finalize_translation(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|error| {
        format!(
            "Übersetzungsdatei '{}' konnte nicht geschrieben werden: {error}",
            path.display()
        )
    })
}

fn reload_translation_tab(state: &AppState, tab_id: u64, path: &str) -> Result<(), String> {
    let mut tabs = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?;
    let active = tabs.is_active(tab_id);
    let tab = tabs
        .tab_mut(tab_id)
        .ok_or_else(|| format!("translation tab {tab_id} no longer exists"))?;
    if active {
        tab.document_store.load(path)
    } else {
        tab.document_store.load_silent(path)
    }
    .map(|_| ())
    .map_err(|error| {
        format!(
            "Übersetzungsdatei '{}' konnte nicht neu geladen werden: {error}",
            path
        )
    })
}

fn remove_translation_file(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                target: "folio::ai",
                path = %path.display(),
                %error,
                "failed to remove incomplete translation file"
            );
        }
    }
}

fn cleanup_translation(state: &AppState, handle: &AppHandle, tab_id: u64, path: &Path) {
    remove_translation_file(path);
    match crate::commands::tabs::close(
        state,
        handle,
        tab_id,
        crate::document_service::DirtyPolicy::Discard,
    ) {
        Ok(transition) => {
            if let Err(error) =
                crate::commands::tabs::emit_navigation_changed(handle, &transition, None)
            {
                tracing::warn!(
                    target: "folio::ai",
                    %error,
                    tab_id,
                    "failed to emit navigation after translation cleanup"
                );
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ai",
                %error,
                tab_id,
                "failed to close incomplete translation tab"
            );
        }
    }
}

fn translation_error(language: &str, created: &[String], error: String) -> String {
    if created.is_empty() {
        format!("Übersetzung für '{language}' fehlgeschlagen: {error}")
    } else {
        format!(
            "Übersetzung für '{language}' fehlgeschlagen: {error} Bereits erzeugt: {}",
            created.join(", ")
        )
    }
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

fn http_error(provider_id: &str, status: StatusCode, body: &str, api_key: Option<&str>) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = match api_key.map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => compact.replace(key, "[REDACTED]"),
        None => compact,
    };
    let message = redacted.chars().take(300).collect::<String>();
    if message.is_empty() {
        format!("Provider '{provider_id}' antwortete mit HTTP-Status {status}")
    } else {
        format!("Provider '{provider_id}' antwortete mit HTTP-Status {status}: {message}")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        custom_models_url, finalize_translation, http_error, normalize_languages,
        parse_custom_models, provider_base_url, reserve_translation,
    };
    use crate::ai::types::{AiConfig, AiProviderConfig, AiProviderOptions, CatalogProvider};
    use std::collections::BTreeMap;
    use tempfile::TempDir;

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

    #[test]
    fn custom_models_http_error_redacts_api_key() {
        let error = http_error(
            "local",
            reqwest::StatusCode::UNAUTHORIZED,
            "rejected top-secret",
            Some("top-secret"),
        );
        assert!(error.contains("[REDACTED]"));
        assert!(!error.contains("top-secret"));
    }

    #[test]
    fn provider_endpoint_prefers_custom_config_and_catalog_api() {
        let mut config = AiConfig::default();
        config.provider.insert(
            "local".into(),
            AiProviderConfig {
                custom: true,
                options: Some(AiProviderOptions {
                    base_url: "http://localhost:1234/v1".into(),
                }),
                ..AiProviderConfig::default()
            },
        );
        config
            .provider
            .insert("hosted".into(), AiProviderConfig::default());
        let catalog = BTreeMap::from([(
            "hosted".into(),
            CatalogProvider {
                id: "hosted".into(),
                name: None,
                env: None,
                api: Some("https://provider.test/v1".into()),
                doc: None,
                models: BTreeMap::new(),
            },
        )]);

        assert_eq!(
            "http://localhost:1234/v1",
            provider_base_url(&config, &catalog, "local").unwrap()
        );
        assert_eq!(
            "https://provider.test/v1",
            provider_base_url(&config, &catalog, "hosted").unwrap()
        );
        assert!(provider_base_url(&config, &catalog, "missing")
            .unwrap_err()
            .contains("keinen bekannten Endpoint"));
    }

    #[test]
    fn languages_are_normalized_deduplicated_and_validated() {
        assert_eq!(
            vec!["de", "en-us"],
            normalize_languages(vec![" DE ".into(), "en-US".into(), "de".into()]).unwrap()
        );
        assert!(normalize_languages(vec!["../de".into()]).is_err());
        assert!(normalize_languages(vec![" ".into()]).is_err());
    }

    #[test]
    fn translation_writer_never_overwrites_collisions() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("notes.md");
        std::fs::write(&source, "source").unwrap();
        std::fs::write(temp.path().join("notes.de.md"), "existing").unwrap();

        let created = reserve_translation(source.to_str().unwrap(), "de").unwrap();
        finalize_translation(&created, b"translated").unwrap();

        assert_eq!(temp.path().join("notes.de-1.md"), created);
        assert_eq!(
            "existing",
            std::fs::read_to_string(temp.path().join("notes.de.md")).unwrap()
        );
        assert_eq!("translated", std::fs::read_to_string(created).unwrap());
    }
}
