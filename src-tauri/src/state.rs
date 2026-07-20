use crate::{
    ai::{auth::AuthStore, config::AiConfigService},
    document_store::DocumentEvents,
    link_interceptor::LinkInterceptor,
    panel_state::PanelState,
    renderer,
    settings::SettingsService,
    tab_manager::{DocumentEventFactory, TabManager, TabsPayload},
    theme::ThemeService,
    toc,
    vault::Vault,
    vault_watcher::{GitHeadWatcher, VaultWatcher},
    workspace::Workspace,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleErrorRecord {
    pub kind: String,
    pub message: String,
    pub stack: Option<String>,
    pub source: Option<String>,
    pub timestamp_ms: i64,
}

pub const CONSOLE_ERROR_BUFFER_MAX: usize = 200;

/// Art des exklusiv laufenden KI-Jobs (v1: gegenseitiger Ausschluss —
/// Uebersetzung, Theme-Autor und KI-Aktionen laufen nie gleichzeitig).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiJobKind {
    Translate,
    ThemeAuthor,
    Action,
}

/// Belegter KI-Job-Slot. `run_id` korreliert Cancel/Events der
/// KI-Aktionen (Uebersetzung/Theme-Autor tragen 0 — sie haben keine
/// laufbezogenen Cancel-Commands).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiJob {
    pub kind: AiJobKind,
    pub run_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationUiState {
    pub theme: String,
    pub editor_ready: bool,
    pub selection_start: usize,
    pub selection_length: usize,
}

impl Default for AutomationUiState {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            editor_ready: false,
            selection_start: 0,
            selection_length: 0,
        }
    }
}

pub struct AppState {
    pub tabs: Mutex<TabManager>,
    pub workspace: Mutex<Workspace>,
    pub panel_state: Mutex<PanelState>,
    pub theme: Mutex<ThemeService>,
    pub theme_write: Mutex<()>,
    pub settings: Mutex<SettingsService>,
    pub ai_config: Mutex<AiConfigService>,
    pub ai_auth: Mutex<AuthStore>,
    pub ai_http: reqwest::Client,
    pub ai_translate_cancel: Arc<AtomicBool>,
    pub ai_theme_author_cancel: Arc<AtomicBool>,
    pub ai_action_cancel: Arc<AtomicBool>,
    /// Atomarer Admission-Guard fuer KI-Jobs: Check + Set passieren in
    /// EINEM Lock-Scope (`commands::ai::acquire_ai_job`), damit zwei
    /// Commands nicht gleichzeitig "frei" sehen (TOCTOU).
    pub ai_job_active: Mutex<Option<AiJob>>,
    /// Monotone runId-Quelle fuer KI-Aktionen.
    pub ai_action_run_seq: AtomicU64,
    /// Frontend-gemeldeter Zustand der KI-Diff-Review (Spec
    /// docs/spec-ki-actions.md): true, solange eine Review offen UND
    /// vom User editiert ist. Geht in die Quit-Gates ein, weil der
    /// Backend-Dirty-Check (`tabs.any_dirty`) virtuelle Tabs nicht kennt.
    pub ai_review_dirty: AtomicBool,
    /// Monotone runId-Quelle fuer Vault-Suchlaeufe (`commands::search_cmd`).
    pub search_run_seq: AtomicU64,
    /// Aktive Suchlaeufe: runId -> kooperatives Cancel-Flag. `vault_search_start`
    /// registriert, der Blocking-Task raeumt beim Ende auf, `vault_search_cancel`
    /// setzt das Flag.
    pub search_cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    pub vault: Mutex<Vault>,
    pub vault_watcher: Mutex<VaultWatcher>,
    pub git_head_watcher: Mutex<GitHeadWatcher>,
    pub link_interceptor: LinkInterceptor,
    pub automation: Mutex<AutomationUiState>,
    pub cli_open_path: Mutex<Option<String>>,
    /// Korrelations-Map fuer die Automation-API-Ack-Semantik: Backend
    /// erzeugt pro ack-faehigem Request eine ID + oneshot-Sender, das
    /// Frontend signalisiert nach Handler-Ende ueber `automation_ack`.
    /// Cleanup: Timeout-Pfad entfernt die ID; spaete ACKs ignorieren.
    pub pending_acks: Mutex<HashMap<u64, oneshot::Sender<()>>>,
    pub next_ack_id: AtomicU64,
    /// Generation fuer den debounced Geometrie-Save (siehe
    /// `lib.rs::schedule_panel_geometry_save`): nur der zuletzt
    /// geplante Save-Task schreibt tatsaechlich auf Disk.
    pub panel_geometry_save_gen: AtomicU64,
    /// Pro Event-Name eine Map von Wartenden (siehe
    /// `automation::wait`). `POST /wait` registriert hier, die Trigger-
    /// Punkte (`editor_ready`, DocumentEvents.loaded) drainen den Bucket.
    pub pending_waits: Mutex<HashMap<String, HashMap<u64, oneshot::Sender<()>>>>,
    /// Map fuer `GET /dom` (siehe `automation::dom`). Backend wartet auf
    /// das DOM-Snapshot-Payload, das das Frontend per
    /// `automation_dom_response` liefert.
    pub pending_dom_queries:
        Mutex<HashMap<u64, oneshot::Sender<crate::automation::dom::DomSnapshot>>>,
    pub pending_evals: Mutex<HashMap<u64, oneshot::Sender<crate::automation::eval::EvalResult>>>,
    /// Ringbuffer fuer Frontend-Console-Errors (Hook auf console.error,
    /// window.onerror, unhandledrejection). Max [`CONSOLE_ERROR_BUFFER_MAX`]
    /// Eintraege; ueberlaufende werden vorne abgeschnitten.
    pub console_errors: Mutex<VecDeque<ConsoleErrorRecord>>,
    /// Last-emitted-Zeitstempel pro Wait-Event-Name. Entkoppelt
    /// transiente Events (`document.loaded`/`document.saved`) vom
    /// Subscribe-Timing: `POST /wait` greift binnen TTL (siehe
    /// `automation::wait::RECENT_EVENT_TTL_MS`) auch dann zu, wenn das
    /// Event direkt vor der Registrierung gefeuert hat.
    pub recent_events: Mutex<HashMap<String, Instant>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::with_settings(SettingsService::load())
    }

    /// Boot-Owner-Pfad: denselben einmalig geladenen `SettingsService` übernehmen.
    pub fn with_settings(settings: SettingsService) -> Self {
        let theme = ThemeService::load();
        let initial_theme = theme.mode().to_string();
        let panel_state = PanelState::load();
        // Lazy-Typ-Filter-Spiegel schon beim Boot aus dem Panel-State
        // setzen — sonst rendern fruehe Refresh-Pfade (vault:refresh vor
        // dem ersten vault_build_tree) ein persistiertes "nur Markdown"
        // ungefiltert.
        let mut vault = Vault::new();
        vault.set_markdown_only(panel_state.data().vault_filter_markdown_only);
        Self {
            tabs: Mutex::new(TabManager::new()),
            workspace: Mutex::new(Workspace::load()),
            panel_state: Mutex::new(panel_state),
            theme: Mutex::new(theme),
            theme_write: Mutex::new(()),
            settings: Mutex::new(settings),
            ai_config: Mutex::new(AiConfigService::load()),
            ai_auth: Mutex::new(AuthStore::load()),
            ai_http: reqwest::Client::new(),
            ai_translate_cancel: Arc::new(AtomicBool::new(false)),
            ai_theme_author_cancel: Arc::new(AtomicBool::new(false)),
            ai_action_cancel: Arc::new(AtomicBool::new(false)),
            ai_job_active: Mutex::new(None),
            ai_action_run_seq: AtomicU64::new(0),
            ai_review_dirty: AtomicBool::new(false),
            search_run_seq: AtomicU64::new(0),
            search_cancels: Mutex::new(HashMap::new()),
            vault: Mutex::new(vault),
            vault_watcher: Mutex::new(VaultWatcher::new()),
            git_head_watcher: Mutex::new(GitHeadWatcher::new()),
            link_interceptor: LinkInterceptor::new(),
            automation: Mutex::new(AutomationUiState {
                theme: initial_theme,
                ..AutomationUiState::default()
            }),
            cli_open_path: Mutex::new(None),
            pending_acks: Mutex::new(HashMap::new()),
            next_ack_id: AtomicU64::new(1),
            panel_geometry_save_gen: AtomicU64::new(0),
            pending_waits: Mutex::new(HashMap::new()),
            pending_dom_queries: Mutex::new(HashMap::new()),
            pending_evals: Mutex::new(HashMap::new()),
            console_errors: Mutex::new(VecDeque::with_capacity(CONSOLE_ERROR_BUFFER_MAX)),
            recent_events: Mutex::new(HashMap::new()),
        }
    }

    pub fn install_document_events(&self, app: AppHandle) -> Result<(), String> {
        let mut tabs = self
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        let factory: DocumentEventFactory =
            Arc::new(move |tab_id| Self::document_events(app.clone(), tab_id));
        tabs.set_document_event_factory(factory);
        Ok(())
    }

    /// Rekonstruiert die persistierte Tab-Reihenfolge vor dem Frontend-
    /// Boot. Alle Tabs werden pending angelegt; nur der gespeicherte
    /// aktive Tab wird sofort geladen. Ein Load-Fehler entfernt den Tab
    /// wie eine zwischen Persistenz und Boot verschwundene Datei.
    pub fn restore_tabs(&self) -> Result<(), String> {
        let (open_tabs, active_tab) = {
            let workspace = self
                .workspace
                .lock()
                .map_err(|_| "workspace lock poisoned".to_string())?;
            (workspace.open_tabs().to_vec(), workspace.active_tab())
        };
        let report = self
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?
            .restore_session(&open_tabs, active_tab);
        let mut pruned_restore_paths = !report.discarded_paths.is_empty();
        for path in report.discarded_paths {
            tracing::warn!(
                target: "folio::tabs",
                %path,
                "discarding missing tab path during session restore"
            );
        }

        loop {
            match crate::document_service::load_active_pending(self) {
                Ok(_) => break,
                Err(crate::document_service::OpenDocumentError::Load(error)) => {
                    pruned_restore_paths = true;
                    let (id, path) = {
                        let tabs = self
                            .tabs
                            .lock()
                            .map_err(|_| "tabs lock poisoned".to_string())?;
                        (
                            tabs.active().id,
                            tabs.active().document_path().map(str::to_string),
                        )
                    };
                    tracing::warn!(
                        target: "folio::tabs",
                        path,
                        %error,
                        "discarding tab that failed to load during session restore"
                    );
                    self.tabs
                        .lock()
                        .map_err(|_| "tabs lock poisoned".to_string())?
                        .close(id);
                }
                Err(error) => return Err(error.to_string()),
            }
        }

        // Tote oder nicht lesbare Restore-Pfade sofort aus workspace.json
        // entfernen, nicht erst beim spaeteren Frontend-ready-Emit.
        if pruned_restore_paths {
            let (open_tabs, active_tab) = self
                .tabs
                .lock()
                .map_err(|_| "tabs lock poisoned".to_string())?
                .session_state();
            self.workspace
                .lock()
                .map_err(|_| "workspace lock poisoned".to_string())?
                .set_open_tabs(open_tabs, active_tab)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn document_events(app: AppHandle, tab_id: u64) -> DocumentEvents {
        DocumentEvents {
            loaded: Some(Arc::new({
                let app = app.clone();
                move |payload| {
                    let _ = Self::emit_document_loaded(&app, tab_id, &payload.path, &payload.text);
                    Self::schedule_tabs_changed(app.clone());
                    // Wartende `POST /wait { event: "document.loaded" }` aufwecken.
                    crate::automation::wait::signal_document_loaded(
                        app.state::<AppState>().inner(),
                    );
                }
            })),
            dirty_changed: Some(Arc::new({
                let app = app.clone();
                move |is_dirty| {
                    let _ = app.emit(
                        "document:dirty_changed",
                        serde_json::json!({ "is_dirty": is_dirty, "tabId": tab_id, "seq": next_doc_seq() }),
                    );
                    Self::schedule_tabs_changed(app.clone());
                    if !is_dirty {
                        crate::automation::wait::signal_document_dirty_clean(
                            app.state::<AppState>().inner(),
                        );
                    }
                }
            })),
            saved: Some(Arc::new({
                let app = app.clone();
                move |path, text| {
                    let toc_entries = toc::extract(&text);
                    // kind/language wie bei document:loaded mitgeben —
                    // das Frontend braucht sie im saved-Pfad fuer den
                    // Code-View-Refresh (sonst Endungs-Heuristik/plaintext).
                    let _ = app.emit(
                        "document:saved",
                        serde_json::json!({
                            "path": path,
                            "kind": crate::file_kind::classify(&path),
                            "language": crate::file_kind::editor_language(&path),
                            "text": text,
                            "content": renderer::render_body(&text),
                            "tocHtml": toc::render_html(&toc_entries),
                            "headingMap": crate::commands::editor::heading_map(&toc_entries),
                            "tabId": tab_id,
                            "seq": next_doc_seq(),
                        }),
                    );
                    Self::schedule_tabs_changed(app.clone());
                    crate::automation::wait::signal_document_saved(app.state::<AppState>().inner());
                }
            })),
            text_changed: None,
            external_changed: Some(Arc::new(move |path| {
                let is_active = app
                    .state::<AppState>()
                    .tabs
                    .lock()
                    .map(|tabs| tabs.is_active(tab_id))
                    .unwrap_or(false);
                if !is_active {
                    return;
                }
                let _ = app.emit(
                    "document:external_changed",
                    serde_json::json!({ "path": path, "tabId": tab_id }),
                );
            })),
        }
    }

    pub fn tabs_payload(&self) -> Result<TabsPayload, String> {
        let tabs = self
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        Ok(TabsPayload {
            tabs: tabs.summaries(),
            active_index: tabs.active_index(),
            request_id: None,
        })
    }

    pub fn emit_tabs_changed(app: &AppHandle) -> Result<(), String> {
        Self::emit_tabs_changed_with_request(app, None)
    }

    pub fn emit_tabs_changed_with_request(
        app: &AppHandle,
        request_id: Option<u64>,
    ) -> Result<(), String> {
        let state = app.state::<AppState>();
        let (payload, open_tabs, active_tab) = {
            let tabs = state
                .tabs
                .lock()
                .map_err(|_| "tabs lock poisoned".to_string())?;
            let payload = TabsPayload {
                tabs: tabs.summaries(),
                active_index: tabs.active_index(),
                request_id,
            };
            let (open_tabs, active_tab) = tabs.session_state();
            (payload, open_tabs, active_tab)
        };
        state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?
            .set_open_tabs(open_tabs, active_tab)
            .map_err(|error| error.to_string())?;
        app.emit("tabs:changed", payload)
            .map_err(|error| error.to_string())
    }

    fn schedule_tabs_changed(app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            // DocumentStore-Callbacks laufen unter dem Tabs-Lock. Der
            // asynchrone Hop verhindert einen rekursiven Lock-Versuch.
            tokio::task::yield_now().await;
            if let Err(error) = Self::emit_tabs_changed(&app) {
                tracing::warn!(target: "folio::tabs", %error, "tabs:changed emit failed");
            }
        });
    }

    pub fn emit_document_loaded(
        app: &AppHandle,
        tab_id: u64,
        path: &str,
        text: &str,
    ) -> Result<(), String> {
        let seq = next_doc_seq();
        let toc_entries = toc::extract(text);
        app.emit(
            "document:loaded",
            serde_json::json!({
                "path": path,
                "kind": crate::file_kind::classify(path),
                "language": crate::file_kind::editor_language(path),
                "text": text,
                "content": renderer::render_body(text),
                "tocHtml": toc::render_html(&toc_entries),
                "headingMap": crate::commands::editor::heading_map(&toc_entries),
                "tabId": tab_id,
                "seq": seq,
            }),
        )
        .map_err(|error| error.to_string())
    }
}

/// Gemeinsamer monotoner Sequenzzähler für ALLE vier document:*-Lifecycle-Events
/// (loaded, closed, saved, dirty_changed). Wird im Frontend als Stale-Guard
/// verwendet: Events mit seq <= lastApplied werden verworfen (sichert gegen
/// Reordering/Duplikate über Tab-Wechsel und asynchrone Callbacks).
/// Relaxed reicht für Ticket-Vergabe; SeqCst für Konsistenz mit vorherigem
/// loaded-Pfad.
static DOC_LIFECYCLE_SEQ: AtomicU64 = AtomicU64::new(1);

pub(crate) fn next_doc_seq() -> u64 {
    DOC_LIFECYCLE_SEQ.fetch_add(1, Ordering::SeqCst)
}
