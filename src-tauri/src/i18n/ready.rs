//! Frontend-Ready-Gate für die Automation-API.
//!
//! `frontend_ready` (Tauri-Command) setzt das Gate; Routen, die Frontend-
//! Events emittieren oder einen ACK/Screenshot brauchen, warten bis dahin
//! (mit Startup-Timeout). `/state` bleibt ungesperrt und meldet den Stand.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Notify;

static READY: AtomicBool = AtomicBool::new(false);
static NOTIFY: OnceLock<Notify> = OnceLock::new();

fn notify() -> &'static Notify {
    NOTIFY.get_or_init(Notify::new)
}

/// Idempotent: mehrfaches `frontend_ready` ist erlaubt und ein No-op.
pub fn mark_ready() {
    let was = READY.swap(true, Ordering::SeqCst);
    if !was {
        notify().notify_waiters();
        tracing::info!(target: "folio::i18n", "frontend_ready");
    }
}

pub fn is_ready() -> bool {
    READY.load(Ordering::SeqCst)
}

/// Wartet bis Ready oder Timeout. `true` = ready, `false` = Timeout.
pub async fn wait_ready(timeout: Duration) -> bool {
    if is_ready() {
        return true;
    }
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if is_ready() {
            return true;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return is_ready();
        }
        let n = notify();
        // Subscribe *before* re-check (Notify is edge-triggered).
        let notified = n.notified();
        if is_ready() {
            return true;
        }
        match tokio::time::timeout(remaining, notified).await {
            Ok(()) => continue, // re-check is_ready at top
            Err(_) => return is_ready(),
        }
    }
}

/// Startup-Timeout für wartende Automation-Routen (Spec I1b).
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(test)]
pub fn reset_for_tests() {
    READY.store(false, Ordering::SeqCst);
    // Notify itself has no reset; new waiters after mark_ready still work
    // because is_ready short-circuits.
}
