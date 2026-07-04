use crate::{
    document_store::DocumentEvents,
    link_interceptor::LinkInterceptor,
    panel_state::PanelState,
    renderer,
    settings::SettingsService,
    tab_manager::{DocumentEventFactory, TabManager, TabsPayload},
    theme::ThemeService,
    toc,
    vault::Vault,
    vault_watcher::VaultWatcher,
    workspace::Workspace,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicU64;
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
    pub settings: Mutex<SettingsService>,
    pub vault: Mutex<Vault>,
    pub vault_watcher: Mutex<VaultWatcher>,
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
        let theme = ThemeService::load();
        let initial_theme = theme.mode().to_string();
        Self {
            tabs: Mutex::new(TabManager::new()),
            workspace: Mutex::new(Workspace::load()),
            panel_state: Mutex::new(PanelState::load()),
            theme: Mutex::new(theme),
            settings: Mutex::new(SettingsService::load()),
            vault: Mutex::new(Vault::new()),
            vault_watcher: Mutex::new(VaultWatcher::new()),
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
                        serde_json::json!({ "is_dirty": is_dirty, "tabId": tab_id }),
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
        })
    }

    pub fn emit_tabs_changed(app: &AppHandle) -> Result<(), String> {
        let payload = app.state::<AppState>().tabs_payload()?;
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
            }),
        )
        .map_err(|error| error.to_string())
    }
}
