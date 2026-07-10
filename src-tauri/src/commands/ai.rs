use crate::{
    ai::{
        actions,
        catalog::{self, CatalogResult},
        client::{self, ChatMessage},
        config::{AiConfigError, AiConfigService},
        mask,
        types::{AiConfig, AuthStatus, Catalog, CustomProviderDefinition},
    },
    file_kind::{classify, FileKind},
    state::{AiJob, AiJobKind, AppState},
    theme::author,
};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
    time::Instant,
};
use tauri::{AppHandle, Emitter, State};

/// RAII-Guard fuer den exklusiven KI-Job-Slot: gibt den Slot in jedem
/// Ausgang (auch bei `?`/frühem Return) wieder frei.
struct AiJobGuard<'a> {
    slot: &'a Mutex<Option<AiJob>>,
}

impl Drop for AiJobGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = None;
        }
    }
}

/// Atomare Admission: Check + Set des Job-Slots in EINEM Lock-Scope,
/// damit zwei KI-Commands nicht gleichzeitig "frei" sehen (TOCTOU).
fn acquire_ai_job(slot: &Mutex<Option<AiJob>>, job: AiJob) -> Result<AiJobGuard<'_>, String> {
    let mut active = slot
        .lock()
        .map_err(|_| "AI job lock poisoned".to_string())?;
    if active.is_some() {
        return Err("Es läuft bereits ein KI-Vorgang.".to_string());
    }
    *active = Some(job);
    drop(active);
    Ok(AiJobGuard { slot })
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

/// Kurzer Chat gegen ein freigeschaltetes Modell zum Verifizieren von
/// Endpoint, Schlüssel und Modell-ID (UI: „Test"-Button in der Modellzeile).
/// Antworten werden nicht persistiert.
#[tauri::command]
pub async fn ai_model_chat_test(
    provider_id: String,
    model_id: String,
    messages: Vec<ChatMessage>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (base_url, api_key) = resolve_provider(state.inner(), &provider_id, &model_id)?;
    client::chat_stream(
        &state.ai_http,
        &base_url,
        api_key.as_deref(),
        &model_id,
        &messages,
        |_| {},
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ai_translate_document(
    languages: Vec<String>,
    provider_id: String,
    model_id: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<Vec<String>, String> {
    let _active = acquire_ai_job(
        &state.ai_job_active,
        AiJob {
            kind: AiJobKind::Translate,
            run_id: 0,
        },
    )?;
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

    let (base_url, api_key) = resolve_provider(state.inner(), &provider_id, &model_id)?;

    mutate_config(state.inner(), |service| {
        service.recent_languages_set(languages.clone())
    })?;

    let masked = mask::mask(&source_text);
    let mut created = Vec::with_capacity(languages.len());
    for language in languages {
        if state.ai_translate_cancel.load(Ordering::Acquire) {
            break;
        }

        let path = reserve_derived_file(&source_path, &language)
            .map_err(|error| translation_error(&language, &created, error))?;
        let normalized_path = path.to_string_lossy().replace('\\', "/");
        let transition =
            match crate::commands::tabs::open(state.inner(), &handle, normalized_path.clone()) {
                Ok(transition) => transition,
                Err(error) => {
                    remove_derived_file(&path);
                    return Err(translation_error(&language, &created, error.to_string()));
                }
            };
        let tab_id = transition.tab.id;
        if let Err(error) =
            crate::commands::tabs::emit_navigation_changed(&handle, &transition, None)
        {
            cleanup_derived_tab(state.inner(), &handle, tab_id, &path);
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
            cleanup_derived_tab(state.inner(), &handle, tab_id, &path);
            break;
        }
        let translated_raw = match translated_raw {
            Ok(translated) => translated,
            Err(error) => {
                cleanup_derived_tab(state.inner(), &handle, tab_id, &path);
                return Err(translation_error(&language, &created, error.to_string()));
            }
        };
        if let Some(error) = emit_error {
            cleanup_derived_tab(state.inner(), &handle, tab_id, &path);
            return Err(translation_error(&language, &created, error));
        }
        let translated = match mask::unmask(&translated_raw, &masked) {
            Ok(translated) => translated,
            Err(error) => {
                cleanup_derived_tab(state.inner(), &handle, tab_id, &path);
                return Err(translation_error(&language, &created, error.to_string()));
            }
        };
        if let Err(error) = write_derived_file(&path, translated.as_bytes()) {
            cleanup_derived_tab(state.inner(), &handle, tab_id, &path);
            return Err(translation_error(&language, &created, error));
        }
        if let Err(error) = reload_derived_tab(state.inner(), tab_id, &normalized_path) {
            cleanup_derived_tab(state.inner(), &handle, tab_id, &path);
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

/// KI-Theme-Autor (Stufe 1, Spec E6): erzeugt einen NICHT persistierten
/// [`author::ThemeDraft`] fuer die Editor-Buffer. Muster wie
/// `ai_translate_document`: Active-Guard, cancellable Stream mit
/// Event-Throttle, hartes Validierungs-Gate vor der Rueckgabe.
#[tauri::command]
pub async fn ai_theme_author(
    prompt: String,
    base_id: Option<String>,
    with_document: Option<bool>,
    provider_id: String,
    model_id: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<author::ThemeDraft, String> {
    let _active = acquire_ai_job(
        &state.ai_job_active,
        AiJob {
            kind: AiJobKind::ThemeAuthor,
            run_id: 0,
        },
    )?;
    state.ai_theme_author_cancel.store(false, Ordering::Release);

    let (base_url, api_key) = resolve_provider(state.inner(), &provider_id, &model_id)?;

    let base = match base_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(id) => {
            let package = crate::theme::package(id)
                .ok_or_else(|| format!("Unbekanntes Basis-Theme: '{id}'"))?;
            Some(author::BaseContext {
                id: package.id,
                content_css: package.content_css,
                dark_css: package.dark_css,
                page_css: package.page_css,
                cover_html: package.cover_html,
                header_html: package.header_html,
                footer_html: package.footer_html,
            })
        }
        None => None,
    };
    let document_context = if with_document.unwrap_or(false) {
        let markdown = {
            let tabs = state
                .tabs
                .lock()
                .map_err(|_| "tabs lock poisoned".to_string())?;
            let store = &tabs.active().document_store;
            if store.path.is_none() {
                return Err("Kein Dokument geöffnet.".to_string());
            }
            store.text.clone()
        };
        Some(author::document_excerpt(&markdown))
    } else {
        None
    };

    let messages = [
        ChatMessage::system(author::system_prompt(
            base.as_ref(),
            document_context.as_deref(),
        )),
        ChatMessage::user(prompt),
    ];
    let cancel = state.ai_theme_author_cancel.clone();
    let mut last_emit = None;
    let raw_response = client::chat_stream_cancellable(
        &state.ai_http,
        &base_url,
        api_key.as_deref(),
        &model_id,
        &messages,
        |accumulated| {
            let now = Instant::now();
            if last_emit
                .is_some_and(|last: Instant| now.duration_since(last) < Duration::from_millis(150))
            {
                return;
            }
            last_emit = Some(now);
            // Nur die Zeichenzahl streamen — das JSON ist erst nach dem
            // Gate vertrauenswuerdig, Partial-Anzeige waere irrefuehrend.
            let _ = handle.emit(
                "ai:theme_stream",
                serde_json::json!({ "chars": accumulated.chars().count() }),
            );
        },
        || cancel.load(Ordering::Acquire),
    )
    .await;

    let done = |ok: bool, error: Option<&str>| {
        let _ = handle.emit(
            "ai:theme_done",
            serde_json::json!({ "ok": ok, "error": error }),
        );
    };

    if matches!(raw_response, Err(client::ChatError::Cancelled))
        || state.ai_theme_author_cancel.load(Ordering::Acquire)
    {
        done(false, Some("abgebrochen"));
        return Err("KI-Theme-Lauf abgebrochen.".to_string());
    }
    let raw_response = match raw_response {
        Ok(response) => response,
        Err(error) => {
            let message = error.to_string();
            done(false, Some(&message));
            return Err(message);
        }
    };

    let draft = author::parse_draft(&raw_response)
        .and_then(|raw| author::validate_draft(raw, None))
        .inspect_err(|error| done(false, Some(error)))?;

    tracing::info!(
        target: "folio::ai",
        provider_id,
        model_id,
        base = base_id.as_deref().unwrap_or(""),
        with_document = with_document.unwrap_or(false),
        "AI theme draft validated"
    );
    done(true, None);
    Ok(draft)
}

#[tauri::command]
pub async fn ai_theme_author_cancel(state: State<'_, AppState>) -> Result<(), String> {
    state.ai_theme_author_cancel.store(true, Ordering::Release);
    Ok(())
}

// === KI-Aktionen (Spec: docs/spec-ki-actions.md) ==========================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiActionSelection {
    pub start: u64,
    pub length: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiActionRequest {
    /// Nur fuer Logging — der wirksame Prompt kommt immer explizit mit.
    pub action_id: Option<String>,
    /// Client-Token fuer den `ai:action_started`-Handshake.
    pub request_id: String,
    pub prompt: String,
    pub provider_id: String,
    pub model_id: String,
    pub target: actions::Target,
    pub masking: bool,
    pub suffix: String,
    /// UTF-16-Offsets auf dem LF-normalisierten Snapshot (Koordinaten-
    /// vertrag der Spec); `None` = ganzes Dokument.
    pub scope: Option<AiActionSelection>,
    pub source_tab_id: u64,
    pub source_path: String,
    pub source_text_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum AiActionOutcome {
    #[serde(rename = "file")]
    File {
        #[serde(rename = "runId")]
        run_id: u64,
        path: String,
    },
    #[serde(rename = "text")]
    Text {
        #[serde(rename = "runId")]
        run_id: u64,
        text: String,
    },
}

#[tauri::command]
pub async fn ai_actions_list() -> Result<Vec<actions::ActionTemplate>, String> {
    Ok(actions::list_templates())
}

#[tauri::command]
pub async fn ai_action_template_save(
    template: actions::ActionTemplate,
) -> Result<actions::ActionTemplate, String> {
    let saved = actions::save_template(template)?;
    tracing::info!(
        target: "folio::ai",
        id = saved.id,
        "AI action template saved"
    );
    Ok(saved)
}

#[tauri::command]
pub async fn ai_action_template_delete(id: String) -> Result<(), String> {
    actions::delete_template(&id)?;
    tracing::info!(
        target: "folio::ai",
        id,
        "AI action template deleted"
    );
    Ok(())
}

/// Frontend meldet den Zustand der KI-Diff-Review (offen + editiert),
/// damit die Quit-Gates sie wie einen dirty Tab behandeln koennen.
#[tauri::command]
pub async fn ai_review_state_set(
    open: bool,
    dirty: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ai_review_dirty
        .store(open && dirty, Ordering::Release);
    Ok(())
}

/// Bricht genau den Lauf mit `run_id` ab — ein verspaeteter Cancel aus
/// einem frueheren Lauf kann einen Folgelauf nicht treffen.
#[tauri::command]
pub async fn ai_action_cancel(run_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    let job = state
        .ai_job_active
        .lock()
        .map_err(|_| "AI job lock poisoned".to_string())?;
    if matches!(
        *job,
        Some(AiJob {
            kind: AiJobKind::Action,
            run_id: active,
        }) if active == run_id
    ) {
        state.ai_action_cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_action_run(
    request: AiActionRequest,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<AiActionOutcome, String> {
    // === Preflight: laeuft komplett VOR der Guard-Annahme. Fehler hier
    // gehen nur ueber den Command-Return — kein Started, kein Done. ===
    actions::validate_slug(&request.suffix, "Datei-Suffix")?;
    if request.prompt.trim().is_empty() {
        return Err("Der Prompt darf nicht leer sein.".to_string());
    }
    if request.prompt.chars().count() > actions::PROMPT_MAX_CHARS {
        return Err(format!(
            "Der Prompt darf höchstens {} Zeichen haben.",
            actions::PROMPT_MAX_CHARS
        ));
    }

    let source_text = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        let tab = tabs
            .tab(request.source_tab_id)
            .ok_or_else(|| "Der Quell-Tab existiert nicht mehr.".to_string())?;
        let store = &tab.document_store;
        let path = store.path.clone().ok_or_else(|| {
            "Für KI-Aktionen muss ein gespeichertes Dokument geöffnet sein.".to_string()
        })?;
        if path.replace('\\', "/") != request.source_path.replace('\\', "/") {
            return Err("Die Quelle hat sich geändert — bitte erneut starten.".to_string());
        }
        if classify(&path) != FileKind::Markdown {
            return Err("KI-Aktionen sind nur für Markdown-Dokumente verfügbar.".to_string());
        }
        store.text.clone()
    };
    // Zweitgurt zum Lone-CR-Waechter im tab-gebundenen Sync: Store und
    // Monaco-Modell waeren bei Lone-CR nicht identisch, jede Offset-
    // Rechnung falsch (Koordinatenvertrag der Spec).
    if mask::has_lone_carriage_return(&source_text) {
        return Err(
            "Dieses Dokument verwendet nicht unterstützte Zeilenenden (einzelne CR).".to_string(),
        );
    }
    if actions::sha256_hex(&source_text) != request.source_text_sha256 {
        return Err("Die Quelle hat sich geändert — bitte erneut starten.".to_string());
    }

    let (base_url, api_key) =
        resolve_provider(state.inner(), &request.provider_id, &request.model_id)?;

    let selection = match &request.scope {
        Some(scope) => Some(actions::resolve_selection(
            &source_text,
            scope.start,
            scope.length,
        )?),
        None => None,
    };
    let (work_text, masked) = match (&selection, request.masking) {
        (Some(range), true) => {
            let masked =
                mask::mask_selection(&source_text, range.clone()).map_err(|e| e.to_string())?;
            (masked.text.clone(), Some(masked))
        }
        (Some(range), false) => (source_text[range.clone()].to_string(), None),
        (None, true) => {
            let masked = mask::mask(&source_text);
            (masked.text.clone(), Some(masked))
        }
        (None, false) => (source_text.clone(), None),
    };
    let delimiter = actions::document_delimiter(&[&request.prompt, &work_text]);
    let messages = [
        ChatMessage::system(actions::system_prompt(masked.is_some(), &delimiter)),
        ChatMessage::user(actions::build_user_message(
            &request.prompt,
            &delimiter,
            &work_text,
        )),
    ];

    // === Atomare Admission (Check+Set in einem Lock) + Started-Handshake.
    // Ab der Guard-Annahme feuert `done` in jedem Ausgang genau einmal. ===
    let run_id = state.ai_action_run_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let _job = acquire_ai_job(
        &state.ai_job_active,
        AiJob {
            kind: AiJobKind::Action,
            run_id,
        },
    )?;
    state.ai_action_cancel.store(false, Ordering::Release);

    let done = {
        let handle = handle.clone();
        move |ok: bool, error: Option<&str>| {
            let _ = handle.emit(
                "ai:action_done",
                serde_json::json!({ "runId": run_id, "ok": ok, "error": error }),
            );
        }
    };
    if let Err(error) = handle.emit(
        "ai:action_started",
        serde_json::json!({ "runId": run_id, "requestId": request.request_id }),
    ) {
        let message = error.to_string();
        done(false, Some(&message));
        return Err(message);
    }

    tracing::info!(
        target: "folio::ai",
        run_id,
        action = request.action_id.as_deref().unwrap_or("custom"),
        provider_id = request.provider_id,
        model_id = request.model_id,
        target = ?request.target,
        masking = masked.is_some(),
        selection = selection.is_some(),
        chars = source_text.chars().count(),
        "AI action started"
    );

    match request.target {
        actions::Target::Replace => {
            run_action_replace(
                &state,
                &handle,
                run_id,
                &base_url,
                api_key.as_deref(),
                &request,
                &messages,
                masked.as_ref(),
                done,
            )
            .await
        }
        actions::Target::NewFile => {
            run_action_new_file(
                &state,
                &handle,
                run_id,
                &base_url,
                api_key.as_deref(),
                &request,
                &messages,
                masked.as_ref(),
                done,
            )
            .await
        }
    }
}

/// Replace-Ziel: Gate-and-Return wie der Theme-Autor — kein Datei-Write,
/// kein Tab; die Diff-Review im Frontend entscheidet über die Übernahme.
#[allow(clippy::too_many_arguments)]
async fn run_action_replace(
    state: &AppState,
    handle: &AppHandle,
    run_id: u64,
    base_url: &str,
    api_key: Option<&str>,
    request: &AiActionRequest,
    messages: &[ChatMessage],
    masked: Option<&mask::Masked>,
    done: impl Fn(bool, Option<&str>),
) -> Result<AiActionOutcome, String> {
    let cancel = state.ai_action_cancel.clone();
    let raw = stream_chat(
        state,
        base_url,
        api_key,
        &request.model_id,
        messages,
        cancel.clone(),
        |accumulated| {
            let _ = handle.emit(
                "ai:action_stream",
                serde_json::json!({ "runId": run_id, "chars": accumulated.chars().count() }),
            );
        },
    )
    .await;

    if matches!(raw, Err(client::ChatError::Cancelled)) || cancel.load(Ordering::Acquire) {
        done(false, Some("abgebrochen"));
        return Err("KI-Aktion abgebrochen.".to_string());
    }
    let raw = match raw {
        Ok(raw) => raw,
        Err(error) => {
            let message = error.to_string();
            done(false, Some(&message));
            return Err(message);
        }
    };
    let text = match masked {
        Some(masked) => match mask::unmask(&raw, masked) {
            Ok(text) => text,
            Err(error) => {
                let message = error.to_string();
                done(false, Some(&message));
                return Err(message);
            }
        },
        None => raw,
    };
    let text = actions::normalize_output_eol(&text);
    if text.trim().is_empty() {
        let message = "Das Modell hat eine leere Antwort geliefert.".to_string();
        done(false, Some(&message));
        return Err(message);
    }
    done(true, None);
    Ok(AiActionOutcome::Text { run_id, text })
}

/// NewFile-Ziel: Reservierung → Tab → Stream mit Live-Preview →
/// Ownership-geprüfter Write → Tab-Reload. Cleanup löscht nur die
/// eigene, noch leere Reservierung und discardet nie einen dirty Tab.
#[allow(clippy::too_many_arguments)]
async fn run_action_new_file(
    state: &AppState,
    handle: &AppHandle,
    run_id: u64,
    base_url: &str,
    api_key: Option<&str>,
    request: &AiActionRequest,
    messages: &[ChatMessage],
    masked: Option<&mask::Masked>,
    done: impl Fn(bool, Option<&str>),
) -> Result<AiActionOutcome, String> {
    let fail = |message: String, done: &dyn Fn(bool, Option<&str>)| -> String {
        done(false, Some(&message));
        message
    };

    let path = match reserve_derived_file(&request.source_path, &request.suffix) {
        Ok(path) => path,
        Err(error) => return Err(fail(error, &done)),
    };
    let normalized_path = path.to_string_lossy().replace('\\', "/");
    let transition = match crate::commands::tabs::open(state, handle, normalized_path.clone()) {
        Ok(transition) => transition,
        Err(error) => {
            remove_derived_file(&path);
            return Err(fail(error.to_string(), &done));
        }
    };
    let tab_id = transition.tab.id;
    if let Err(error) = crate::commands::tabs::emit_navigation_changed(handle, &transition, None) {
        cleanup_action_target(state, handle, tab_id, &path);
        return Err(fail(error.to_string(), &done));
    }

    let cancel = state.ai_action_cancel.clone();
    let raw = stream_chat(
        state,
        base_url,
        api_key,
        &request.model_id,
        messages,
        cancel.clone(),
        |accumulated| {
            let text = match masked {
                Some(masked) => mask::unmask_partial(accumulated, masked),
                None => accumulated.to_string(),
            };
            let _ = handle.emit(
                "ai:action_stream",
                serde_json::json!({
                    "runId": run_id,
                    "tabId": tab_id,
                    "text": text,
                    "chars": text.chars().count(),
                }),
            );
        },
    )
    .await;

    if matches!(raw, Err(client::ChatError::Cancelled)) || cancel.load(Ordering::Acquire) {
        cleanup_action_target(state, handle, tab_id, &path);
        done(false, Some("abgebrochen"));
        return Err("KI-Aktion abgebrochen.".to_string());
    }
    let raw = match raw {
        Ok(raw) => raw,
        Err(error) => {
            cleanup_action_target(state, handle, tab_id, &path);
            return Err(fail(error.to_string(), &done));
        }
    };
    let text = match masked {
        Some(masked) => match mask::unmask(&raw, masked) {
            Ok(text) => text,
            Err(error) => {
                cleanup_action_target(state, handle, tab_id, &path);
                return Err(fail(error.to_string(), &done));
            }
        },
        None => raw,
    };
    let text = actions::normalize_output_eol(&text);
    if text.trim().is_empty() {
        cleanup_action_target(state, handle, tab_id, &path);
        return Err(fail(
            "Das Modell hat eine leere Antwort geliefert.".to_string(),
            &done,
        ));
    }

    // Ownership-Check unmittelbar vor dem Erfolgs-Write: hat der User den
    // Ziel-Tab editiert oder die Datei gefüllt, wird NIE überschrieben —
    // Conflict-Fallback reserviert stattdessen eine frische Datei.
    let ownership_intact = target_still_owned(state, tab_id, &path);
    let (final_path, final_tab_id, final_normalized) = if ownership_intact {
        (path.clone(), tab_id, normalized_path.clone())
    } else {
        tracing::warn!(
            target: "folio::ai",
            run_id,
            path = %path.display(),
            "AI action target was modified during the run; falling back to a fresh reservation"
        );
        // Verwaiste Alt-Reservierung mit aufräumen, soweit sie noch dem
        // Lauf gehört (Tab bereits zu + Datei leer → nur Datei löschen).
        cleanup_action_target(state, handle, tab_id, &path);
        let fallback = match reserve_derived_file(&request.source_path, &request.suffix) {
            Ok(path) => path,
            Err(error) => return Err(fail(error, &done)),
        };
        let fallback_normalized = fallback.to_string_lossy().replace('\\', "/");
        let transition =
            match crate::commands::tabs::open(state, handle, fallback_normalized.clone()) {
                Ok(transition) => transition,
                Err(error) => {
                    remove_derived_file(&fallback);
                    return Err(fail(error.to_string(), &done));
                }
            };
        let fallback_tab = transition.tab.id;
        if let Err(error) =
            crate::commands::tabs::emit_navigation_changed(handle, &transition, None)
        {
            cleanup_action_target(state, handle, fallback_tab, &fallback);
            return Err(fail(error.to_string(), &done));
        }
        (fallback, fallback_tab, fallback_normalized)
    };

    if let Err(error) = write_derived_file(&final_path, text.as_bytes()) {
        cleanup_action_target(state, handle, final_tab_id, &final_path);
        return Err(fail(error, &done));
    }
    if let Err(error) = reload_derived_tab(state, final_tab_id, &final_normalized) {
        cleanup_action_target(state, handle, final_tab_id, &final_path);
        return Err(fail(error, &done));
    }

    tracing::info!(
        target: "folio::ai",
        run_id,
        chars = text.chars().count(),
        "AI action file written"
    );
    done(true, None);
    Ok(AiActionOutcome::File {
        run_id,
        path: final_normalized,
    })
}

/// Gemeinsames Streaming mit 150-ms-Event-Throttle (Muster der
/// Übersetzung); `emit_tick` bekommt den akkumulierten Gesamtstring.
async fn stream_chat(
    state: &AppState,
    base_url: &str,
    api_key: Option<&str>,
    model_id: &str,
    messages: &[ChatMessage],
    cancel: Arc<AtomicBool>,
    mut emit_tick: impl FnMut(&str),
) -> Result<String, client::ChatError> {
    let mut last_emit = None;
    client::chat_stream_cancellable(
        &state.ai_http,
        base_url,
        api_key,
        model_id,
        messages,
        |accumulated| {
            let now = Instant::now();
            if last_emit
                .is_some_and(|last: Instant| now.duration_since(last) < Duration::from_millis(150))
            {
                return;
            }
            last_emit = Some(now);
            emit_tick(accumulated);
        },
        || cancel.load(Ordering::Acquire),
    )
    .await
}

/// Ownership-Regel der Spec: die Reservierung gehört dem Lauf nur,
/// solange der Ziel-Tab nicht dirty ist und die Datei noch leer.
fn target_still_owned(state: &AppState, tab_id: u64, path: &Path) -> bool {
    let tab_clean = state
        .tabs
        .lock()
        .map(|tabs| {
            tabs.tab(tab_id)
                .map(|tab| !tab.document_store.is_dirty)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let file_empty = std::fs::metadata(path)
        .map(|meta| meta.len() == 0)
        .unwrap_or(false);
    tab_clean && file_empty
}

/// Cleanup für den NewFile-Pfad: Datei nur im Reservierungszustand
/// (leer) löschen; Tab nur discarden, wenn er existiert und der User
/// ihn nicht editiert hat. Ist der Tab bereits zu (User-Close während
/// des Streams), wird nur die leere Datei entfernt. Alles andere
/// bleibt dem User erhalten (warn-Log).
fn cleanup_action_target(state: &AppState, handle: &AppHandle, tab_id: u64, path: &Path) {
    let file_empty = std::fs::metadata(path)
        .map(|meta| meta.len() == 0)
        .unwrap_or(false);
    if !file_empty {
        tracing::warn!(
            target: "folio::ai",
            tab_id,
            path = %path.display(),
            "AI action cleanup skipped: target file is no longer empty"
        );
        return;
    }
    let tab_dirty = state
        .tabs
        .lock()
        .ok()
        .map(|tabs| tabs.tab(tab_id).map(|tab| tab.document_store.is_dirty));
    match tab_dirty {
        Some(Some(false)) => cleanup_derived_tab(state, handle, tab_id, path),
        Some(None) => remove_derived_file(path),
        _ => {
            tracing::warn!(
                target: "folio::ai",
                tab_id,
                path = %path.display(),
                "AI action cleanup skipped: target tab was modified by the user"
            );
        }
    }
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

/// Liefert `(base_url, api_key)` fuer einen freigeschalteten Provider +
/// Modell. Validiert Provider aktiviert, Modell aus der Whitelist, und
/// loest die Base-URL via [`provider_base_url`]. Geteilt zwischen
/// Uebersetzung (`ai_translate_document`) und dem kuenftigen KI-Theme-
/// Autor (E6). Reiner Refactor: Verhalten bleibt identisch zur vorher
/// inline aufgeloesten Variante.
fn resolve_provider(
    state: &AppState,
    provider_id: &str,
    model_id: &str,
) -> Result<(String, Option<String>), String> {
    let config = config_data(state)?;
    let catalog = catalog::load().catalog;
    let provider = config
        .provider
        .get(provider_id)
        .ok_or_else(|| format!("KI-Provider '{provider_id}' ist nicht konfiguriert."))?;
    if !provider.enabled {
        return Err(format!("KI-Provider '{provider_id}' ist nicht aktiviert."));
    }
    if !provider.whitelist.iter().any(|id| id == model_id) {
        return Err(format!(
            "Modell '{model_id}' ist für Provider '{provider_id}' nicht freigeschaltet."
        ));
    }
    let base_url = provider_base_url(&config, &catalog, provider_id)?;
    let key = state
        .ai_auth
        .lock()
        .map_err(|_| "AI auth lock poisoned".to_string())?
        .get_key(provider_id);
    Ok((base_url, key))
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

fn reserve_derived_file(source_path: &str, suffix: &str) -> Result<PathBuf, String> {
    let source = Path::new(source_path);
    let parent = source
        .parent()
        .ok_or_else(|| "Das Quelldokument hat kein Zielverzeichnis.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Der Dateiname des Quelldokuments ist ungültig.".to_string())?;

    for attempt in 0usize.. {
        let filename = if attempt == 0 {
            format!("{stem}.{suffix}.md")
        } else {
            format!("{stem}.{suffix}-{attempt}.md")
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

fn write_derived_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|error| {
        format!(
            "Übersetzungsdatei '{}' konnte nicht geschrieben werden: {error}",
            path.display()
        )
    })
}

fn reload_derived_tab(state: &AppState, tab_id: u64, path: &str) -> Result<(), String> {
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

fn remove_derived_file(path: &Path) {
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

fn cleanup_derived_tab(state: &AppState, handle: &AppHandle, tab_id: u64, path: &Path) {
    remove_derived_file(path);
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
        custom_models_url, http_error, normalize_languages, parse_custom_models, provider_base_url,
        reserve_derived_file, write_derived_file,
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

        let created = reserve_derived_file(source.to_str().unwrap(), "de").unwrap();
        write_derived_file(&created, b"translated").unwrap();

        assert_eq!(temp.path().join("notes.de-1.md"), created);
        assert_eq!(
            "existing",
            std::fs::read_to_string(temp.path().join("notes.de.md")).unwrap()
        );
        assert_eq!("translated", std::fs::read_to_string(created).unwrap());
    }
}
