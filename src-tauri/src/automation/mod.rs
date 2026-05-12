//! Loopback-only HTTP-API für E2E-Tests und externe Automation.
//!
//! Lauscht auf `127.0.0.1:9876`, blockt nicht-loopback-Anfragen via
//! [`middleware::loopback_only`], hängt CORS-Header für WebView-POSTs an.
//! Routen werden in [`router::build_router`] zusammengestellt; ein
//! pendant-Router für Tests ohne Tauri-State liegt in
//! [`build_mock_router`].

use std::{net::SocketAddr, sync::Arc};
use tauri::AppHandle;
use tokio::{net::TcpListener, sync::Notify};

use crate::state::AppState;

pub mod ack;
mod context;
mod error;
mod handlers;
mod helpers;
mod middleware;
pub mod mock;
mod router;
mod types;
pub mod wait;

pub use mock::MockAutomationState;
pub use router::build_mock_router;

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
            port: 9876,
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
                    eprintln!("Automation listening on http://127.0.0.1:{port}");
                    if let Err(error) = axum::serve(
                        listener,
                        app.into_make_service_with_connect_info::<SocketAddr>(),
                    )
                    .with_graceful_shutdown(async move {
                        shutdown.notified().await;
                    })
                    .await
                    {
                        eprintln!("automation server failed: {error}");
                    }
                }
                Err(error) => eprintln!("automation server bind failed: {error}"),
            }
        });

        AutomationServerHandle {
            shutdown: self.shutdown.clone(),
        }
    }
}
