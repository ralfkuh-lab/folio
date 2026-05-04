use crate::{
    document_store::{DocumentEvents, DocumentStore},
    link_interceptor::LinkInterceptor,
    navigation::NavigationController,
    panel_state::PanelState,
    vault::Vault,
    workspace::Workspace,
};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct AppState {
    pub document_store: Mutex<DocumentStore>,
    pub workspace: Mutex<Workspace>,
    pub panel_state: Mutex<PanelState>,
    pub vault: Mutex<Vault>,
    pub navigation: Mutex<NavigationController>,
    pub link_interceptor: LinkInterceptor,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            document_store: Mutex::new(DocumentStore::new()),
            workspace: Mutex::new(Workspace::load()),
            panel_state: Mutex::new(PanelState::load()),
            vault: Mutex::new(Vault::new()),
            navigation: Mutex::new(NavigationController::new()),
            link_interceptor: LinkInterceptor::new(),
        }
    }

    pub fn install_document_events(&self, app: AppHandle) -> Result<(), String> {
        let events = DocumentEvents {
            loaded: Some(Arc::new({
                let app = app.clone();
                move |payload| {
                    let _ = app.emit("document:loaded", payload);
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
                move |path| {
                    let _ = app.emit("document:saved", serde_json::json!({ "path": path }));
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
