//! Event-Wait fuer die Automation-API.
//!
//! `POST /wait { event, timeoutMs }` haelt die HTTP-Verbindung, bis das
//! benannte Event triggert oder das Timeout abgelaufen ist. Damit
//! eliminiert der E2E-Treiber Polling-Schleifen wie "alle 50 ms /state
//! pruefen, ob editor.ready true ist".
//!
//! Allowlist (Erstausbau):
//! - `editor.ready` — Latch: liefert sofort, wenn der Editor schon
//!   ready ist, sonst Warten bis [`signal_editor_ready`] gerufen wird.
//! - `document.loaded` — Future-Event: wartet auf das naechste
//!   `document:loaded`-Emit aus dem DocumentStore-Callback.
//!
//! Trigger werden in [`signal_editor_ready`] (aus
//! `commands::editor::editor_ready`) und [`signal_document_loaded`]
//! (aus `AppState::install_document_events`) gerufen.

use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::state::AppState;

/// Erlaubte Event-Namen fuer `POST /wait`. Liegt im Modul, damit die
/// Liste eine einzige Quelle hat und vom Handler + Trigger-Seite geteilt
/// werden kann.
pub const KNOWN_EVENTS: &[&str] = &["editor.ready", "document.loaded"];

pub fn is_known(event: &str) -> bool {
    KNOWN_EVENTS.contains(&event)
}

/// Latch-Check: ist das Event "schon erfuellt"? Nur fuer
/// editor.ready relevant; transiente Events liefern immer false.
pub fn already_satisfied(state: &AppState, event: &str) -> bool {
    if event == "editor.ready" {
        return state
            .automation
            .lock()
            .map(|s| s.editor_ready)
            .unwrap_or(false);
    }
    false
}

/// Registriert einen Receiver fuer das Event und gibt die ID + Receiver
/// zurueck.
pub fn register(state: &AppState, event: &str) -> Result<(u64, oneshot::Receiver<()>), String> {
    let id = state
        .next_ack_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    state
        .pending_waits
        .lock()
        .map_err(|_| "pending wait lock poisoned".to_string())?
        .entry(event.to_string())
        .or_insert_with(HashMap::new)
        .insert(id, sender);
    Ok((id, receiver))
}

/// Wartet bis zur Timeout-Frist auf das Event. Bei Timeout entfernt
/// `wait_for` die ID aus der Map (Cleanup).
pub async fn wait_for(
    state: &AppState,
    event: &str,
    id: u64,
    receiver: oneshot::Receiver<()>,
    timeout_ms: u64,
) -> bool {
    match timeout(Duration::from_millis(timeout_ms), receiver).await {
        Ok(Ok(())) => true,
        _ => {
            if let Ok(mut map) = state.pending_waits.lock() {
                if let Some(per_event) = map.get_mut(event) {
                    per_event.remove(&id);
                }
            }
            false
        }
    }
}

/// Feuert alle Wartenden fuer einen Event-Namen. Spaetere Wartende
/// fangen das Event nicht ab.
pub fn signal(state: &AppState, event: &str) {
    let senders = match state.pending_waits.lock() {
        Ok(mut map) => map.remove(event).unwrap_or_default(),
        Err(_) => return,
    };
    for (_, sender) in senders {
        let _ = sender.send(());
    }
}

/// Convenience-Funktion fuer den `editor_ready`-Command.
pub fn signal_editor_ready(state: &AppState) {
    signal(state, "editor.ready");
}

/// Convenience-Funktion fuer den `document:loaded`-Callback.
pub fn signal_document_loaded(state: &AppState) {
    signal(state, "document.loaded");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    #[tokio::test]
    async fn signal_resolves_pending_wait() {
        let state = AppState::new();
        let (id, receiver) = register(&state, "document.loaded").unwrap();
        signal_document_loaded(&state);
        let fired = wait_for(&state, "document.loaded", id, receiver, 100).await;
        assert!(fired);
    }

    #[tokio::test]
    async fn timeout_cleans_per_event_entry() {
        let state = AppState::new();
        let (id, receiver) = register(&state, "document.loaded").unwrap();
        let fired = wait_for(&state, "document.loaded", id, receiver, 10).await;
        assert!(!fired);
        let map = state.pending_waits.lock().unwrap();
        // Bucket darf leer sein, muss aber jedenfalls die ID nicht mehr enthalten.
        assert!(map
            .get("document.loaded")
            .map(|m| !m.contains_key(&id))
            .unwrap_or(true));
    }

    #[tokio::test]
    async fn editor_ready_latch_returns_true_when_already_set() {
        let state = AppState::new();
        state.automation.lock().unwrap().editor_ready = true;
        assert!(already_satisfied(&state, "editor.ready"));
        assert!(!already_satisfied(&state, "document.loaded"));
    }

    #[tokio::test]
    async fn signal_drains_all_waiters() {
        let state = AppState::new();
        let (a, ra) = register(&state, "document.loaded").unwrap();
        let (b, rb) = register(&state, "document.loaded").unwrap();
        assert_ne!(a, b);
        signal_document_loaded(&state);
        assert!(wait_for(&state, "document.loaded", a, ra, 50).await);
        assert!(wait_for(&state, "document.loaded", b, rb, 50).await);
    }

    #[tokio::test]
    async fn signal_for_other_event_does_not_release() {
        let state = AppState::new();
        let (id, receiver) = register(&state, "document.loaded").unwrap();
        signal_editor_ready(&state);
        let fired = wait_for(&state, "document.loaded", id, receiver, 20).await;
        assert!(!fired);
    }

    #[test]
    fn known_events_lists_both() {
        assert!(is_known("editor.ready"));
        assert!(is_known("document.loaded"));
        assert!(!is_known("garbage"));
    }
}
