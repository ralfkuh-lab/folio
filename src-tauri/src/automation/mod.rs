//! Loopback-only HTTP-API für E2E-Tests und externe Automation.
//!
//! Lauscht auf `127.0.0.1:9876`. [`middleware::security_guard`] blockt
//! Nicht-Loopback-Peers, prüft den Host-Header gegen eine Allowlist
//! (DNS-Rebinding) und erlaubt Origin-Header nur von den Tauri-WebView-
//! Origins — CORS-Header werden gespiegelt statt `*`. Im Release-Build
//! startet der Server nur mit `FOLIO_AUTOMATION=1` (siehe [`enabled`]).
//! Routen werden in [`router::build_router`] zusammengestellt; ein
//! pendant-Router für Tests ohne Tauri-State liegt in
//! [`build_mock_router`].

use std::{net::SocketAddr, sync::Arc};
use tauri::AppHandle;
use tokio::{net::TcpListener, sync::Notify};

use crate::state::AppState;

pub mod ack;
mod context;
pub mod dom;
mod error;
pub mod eval;
mod extract;
mod handlers;
mod helpers;
mod middleware;
pub mod mock;
mod router;
mod types;
pub mod wait;

pub use mock::MockAutomationState;
pub use router::build_mock_router;

pub(crate) const PORT: u16 = 9876;

/// Im Debug-Build immer aktiv; im Release-Build nur mit `FOLIO_AUTOMATION=1`
/// (setzt `scripts/run-e2e.sh` bzw. `tests/e2e/run.py`). Verhindert, dass
/// ausgelieferte Installationen dauerhaft eine lokale Automations-Fläche
/// (insbesondere `/eval`) öffnen.
pub fn enabled() -> bool {
    cfg!(debug_assertions) || std::env::var("FOLIO_AUTOMATION").is_ok_and(|v| v == "1")
}

pub struct AutomationServer<'a> {
    pub port: u16,
    pub app_handle: AppHandle,
    pub state: &'a AppState,
    shutdown: Arc<Notify>,
}

#[derive(Clone)]
pub struct AutomationServerHandle {
    shutdown: Arc<Notify>,
}

impl Drop for AutomationServerHandle {
    fn drop(&mut self) {
        self.shutdown.notify_waiters();
    }
}

impl<'a> AutomationServer<'a> {
    pub fn new(app_handle: AppHandle, state: &'a AppState) -> Self {
        Self {
            port: PORT,
            app_handle,
            state,
            shutdown: Arc::new(Notify::new()),
        }
    }

    pub fn start(&self) -> AutomationServerHandle {
        let port = self.port;
        let shutdown = self.shutdown.clone();
        let app = router::build_router(context::AutomationContext {
            app_handle: self.app_handle.clone(),
        });

        tauri::async_runtime::spawn(async move {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            match TcpListener::bind(addr).await {
                Ok(listener) => {
                    tracing::info!(target: "folio::automation", port, "automation server listening");
                    if let Err(error) = axum::serve(
                        listener,
                        app.into_make_service_with_connect_info::<SocketAddr>(),
                    )
                    .with_graceful_shutdown(async move {
                        shutdown.notified().await;
                    })
                    .await
                    {
                        tracing::error!(target: "folio::automation", %error, "automation server failed");
                    }
                }
                Err(error) => {
                    tracing::error!(target: "folio::automation", port, %error, "automation server bind failed");
                }
            }
        });

        AutomationServerHandle {
            shutdown: self.shutdown.clone(),
        }
    }
}
