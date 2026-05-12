use crate::{
    document_store::{DocumentEvents, DocumentStore},
    link_interceptor::LinkInterceptor,
    navigation::NavigationController,
    panel_state::PanelState,
    renderer,
    theme::ThemeService,
    toc,
    vault::Vault,
    workspace::Workspace,
};
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationUiState {
    pub view_mode: String,
    pub theme: String,
    pub editor_ready: bool,
    pub selection_start: usize,
    pub selection_length: usize,
}

impl Default for AutomationUiState {
    fn default() -> Self {
        Self {
            view_mode: "view".into(),
            theme: "light".into(),
            editor_ready: false,
            selection_start: 0,
            selection_length: 0,
        }
    }
}

pub struct AppState {
    pub document_store: Mutex<DocumentStore>,
    pub workspace: Mutex<Workspace>,
    pub panel_state: Mutex<PanelState>,
    pub theme: Mutex<ThemeService>,
    pub vault: Mutex<Vault>,
    pub navigation: Mutex<NavigationController>,
    pub link_interceptor: LinkInterceptor,
    pub automation: Mutex<AutomationUiState>,
    pub cli_open_path: Mutex<Option<String>>,
    /// Korrelations-Map fuer die Automation-API-Ack-Semantik: Backend
    /// erzeugt pro ack-faehigem Request eine ID + oneshot-Sender, das
    /// Frontend signalisiert nach Handler-Ende ueber `automation_ack`.
    /// Cleanup: Timeout-Pfad entfernt die ID; spaete ACKs ignorieren.
    pub pending_acks: Mutex<HashMap<u64, oneshot::Sender<()>>>,
    pub next_ack_id: AtomicU64,
    /// Pro Event-Name eine Map von Wartenden (siehe
    /// `automation::wait`). `POST /wait` registriert hier, die Trigger-
    /// Punkte (`editor_ready`, DocumentEvents.loaded) drainen den Bucket.
    pub pending_waits: Mutex<HashMap<String, HashMap<u64, oneshot::Sender<()>>>>,
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
            document_store: Mutex::new(DocumentStore::new()),
            workspace: Mutex::new(Workspace::load()),
            panel_state: Mutex::new(PanelState::load()),
            theme: Mutex::new(theme),
            vault: Mutex::new(Vault::new()),
            navigation: Mutex::new(NavigationController::new()),
            link_interceptor: LinkInterceptor::new(),
            automation: Mutex::new(AutomationUiState {
                theme: initial_theme,
                ..AutomationUiState::default()
            }),
            cli_open_path: Mutex::new(None),
            pending_acks: Mutex::new(HashMap::new()),
            next_ack_id: AtomicU64::new(1),
            pending_waits: Mutex::new(HashMap::new()),
        }
    }

    pub fn install_document_events(&self, app: AppHandle) -> Result<(), String> {
        let events = DocumentEvents {
            loaded: Some(Arc::new({
                let app = app.clone();
                move |payload| {
                    let _ = app.emit(
                        "document:loaded",
                        serde_json::json!({
                            "path": payload.path,
                            "kind": crate::file_kind::classify(&payload.path),
                            "language": crate::file_kind::editor_language(&payload.path),
                            "text": payload.text,
                            "content": renderer::render_body(&payload.text),
                            "tocHtml": toc::render_html(&toc::extract(&payload.text)),
                        }),
                    );
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
                        serde_json::json!({ "is_dirty": is_dirty }),
                    );
                }
            })),
            saved: Some(Arc::new({
                let app = app.clone();
                move |path, text| {
                    let _ = app.emit(
                        "document:saved",
                        serde_json::json!({
                            "path": path,
                            "text": text,
                            "content": renderer::render_body(&text),
                            "tocHtml": toc::render_html(&toc::extract(&text)),
                        }),
                    );
                }
            })),
            text_changed: None,
            external_changed: Some(Arc::new(move |path| {
                let _ = app.emit(
                    "document:external_changed",
                    serde_json::json!({ "path": path }),
                );
            })),
        };
        self.document_store
            .lock()
            .map_err(|_| "document store lock poisoned".to_string())?
            .set_events(events);
        Ok(())
    }
}
