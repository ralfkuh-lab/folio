//! Event-Wait fuer die Automation-API.
//!
//! `POST /wait { event, timeoutMs }` haelt die HTTP-Verbindung, bis das
//! benannte Event triggert oder das Timeout abgelaufen ist. Damit
//! eliminiert der E2E-Treiber Polling-Schleifen wie "alle 50 ms /state
//! pruefen, ob editor.ready true ist".
//!
//! Allowlist:
//! - `editor.ready` — Latch: liefert sofort, wenn der Editor schon
//!   ready ist, sonst Warten bis [`signal_editor_ready`] gerufen wird.
//! - `document.loaded` — Future-Event: wartet auf das naechste
//!   `document:loaded`-Emit aus dem DocumentStore-Callback.
//! - `document.saved` — Future-Event: wartet auf das naechste
//!   `document:saved`-Emit (z. B. nach Strg+S oder POST /save).
//! - `document.dirty_clean` — Latch: liefert sofort, wenn das aktuelle
//!   Dokument nicht dirty ist (Zustand `is_dirty=false`); sonst warten
//!   bis das naechste `dirty_changed(false)` triggert.
//!
//! Trigger werden in [`signal_editor_ready`] (aus
//! `commands::editor::editor_ready`) und [`signal_document_loaded`],
//! [`signal_document_saved`], [`signal_document_dirty_clean`] (aus
//! `AppState::install_document_events`) gerufen.

use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::state::AppState;

/// TTL fuer den last-emitted-Buffer (siehe [`recently_emitted`]).
/// Late-Subscriber innerhalb dieser Frist greifen ein zuvor gefeuertes
/// transientes Event ab. 2 s ist grob genug fuer E2E-Wait-Registrierung
/// nach `POST /save`, ohne dass ein vorhergehendes Event in einer
/// spaeteren Test-Phase faelschlich matcht.
pub const RECENT_EVENT_TTL_MS: u64 = 2000;

/// Erlaubte Event-Namen fuer `POST /wait`. Liegt im Modul, damit die
/// Liste eine einzige Quelle hat und vom Handler + Trigger-Seite geteilt
/// werden kann.
pub const KNOWN_EVENTS: &[&str] = &[
    "editor.ready",
    "document.loaded",
    "document.saved",
    "document.dirty_clean",
];

pub fn is_known(event: &str) -> bool {
    KNOWN_EVENTS.contains(&event)
}

/// Latch-Check: ist das Event "schon erfuellt"? Echte Latch-Events
/// (`editor.ready`, `document.dirty_clean`) lesen direkt den State.
/// Transiente Events (`document.loaded`, `document.saved`) greifen auf
/// den last-emitted-Buffer zurueck — innerhalb [`RECENT_EVENT_TTL_MS`]
/// gilt das Event als "schon passiert", auch wenn der Wait-Caller spaet
/// dran ist.
pub fn already_satisfied(state: &AppState, event: &str) -> bool {
    match event {
        "editor.ready" => state
            .automation
            .lock()
            .map(|s| s.editor_ready)
            .unwrap_or(false),
        "document.dirty_clean" => state
            .document_store
            .lock()
            .map(|s| !s.is_dirty)
            .unwrap_or(false),
        "document.loaded" | "document.saved" => {
            recently_emitted(state, event, RECENT_EVENT_TTL_MS)
        }
        _ => false,
    }
}

/// Liefert `true`, wenn das Event innerhalb der letzten `ttl_ms` ueber
/// [`signal`] gefeuert wurde. Lock-Fehler werden als `false` behandelt
/// (Wartender geht den normalen Timeout-Pfad).
pub fn recently_emitted(state: &AppState, event: &str, ttl_ms: u64) -> bool {
    let Ok(map) = state.recent_events.lock() else {
        return false;
    };
    map.get(event)
        .map(|t| t.elapsed() < Duration::from_millis(ttl_ms))
        .unwrap_or(false)
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

/// Feuert alle Wartenden fuer einen Event-Namen. Hinterlegt zusaetzlich
/// einen Timestamp im last-emitted-Buffer, damit Late-Subscribers
/// innerhalb [`RECENT_EVENT_TTL_MS`] das Event ueber
/// [`already_satisfied`] noch greifen koennen.
pub fn signal(state: &AppState, event: &str) {
    if let Ok(mut buffer) = state.recent_events.lock() {
        buffer.insert(event.to_string(), Instant::now());
    }
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

/// Convenience-Funktion fuer den `document:saved`-Callback.
pub fn signal_document_saved(state: &AppState) {
    signal(state, "document.saved");
}

/// Wird aus dem `dirty_changed`-Callback gerufen — feuert nur, wenn
/// dirty=false, weil dirty_clean nur den Uebergang in den sauberen
/// Zustand signalisiert. Latch-Pfad geht ueber `already_satisfied`.
pub fn signal_document_dirty_clean(state: &AppState) {
    signal(state, "document.dirty_clean");
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
    fn known_events_lists_all_four() {
        assert!(is_known("editor.ready"));
        assert!(is_known("document.loaded"));
        assert!(is_known("document.saved"));
        assert!(is_known("document.dirty_clean"));
        assert!(!is_known("garbage"));
    }

    #[tokio::test]
    async fn dirty_clean_latch_true_when_doc_not_dirty() {
        let state = AppState::new();
        // Frisch erzeugter Store hat is_dirty=false.
        assert!(already_satisfied(&state, "document.dirty_clean"));
    }

    #[tokio::test]
    async fn document_saved_signal_resolves_pending_wait() {
        let state = AppState::new();
        let (id, receiver) = register(&state, "document.saved").unwrap();
        signal_document_saved(&state);
        let fired = wait_for(&state, "document.saved", id, receiver, 50).await;
        assert!(fired);
    }

    #[test]
    fn already_satisfied_uses_recent_buffer_for_transient_events() {
        let state = AppState::new();
        // Vor Signal: kein Late-Subscriber-Hit.
        assert!(!already_satisfied(&state, "document.saved"));
        assert!(!already_satisfied(&state, "document.loaded"));

        signal_document_saved(&state);
        signal_document_loaded(&state);

        // Direkt nach Signal: Late-Subscriber bekommt true zurueck.
        assert!(already_satisfied(&state, "document.saved"));
        assert!(already_satisfied(&state, "document.loaded"));
    }

    #[test]
    fn recently_emitted_respects_ttl() {
        let state = AppState::new();
        signal_document_saved(&state);
        assert!(recently_emitted(&state, "document.saved", 1000));
        // Mit TTL=0 ist nichts mehr "recent" — strict less-than-Vergleich.
        assert!(!recently_emitted(&state, "document.saved", 0));
    }
}
