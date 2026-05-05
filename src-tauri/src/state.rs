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
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

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
                            "text": payload.text,
                            "content": renderer::render_body(&payload.text),
                            "tocHtml": toc::render_html(&toc::extract(&payload.text)),
                        }),
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
