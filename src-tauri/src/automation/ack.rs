//! Ack-Semantik fuer die Automation-API.
//!
//! Endpoints wie `/click`, `/key`, `/toc/activate` emittieren ein Tauri-Event
//! ans Frontend und sollen erst antworten, wenn der Frontend-Handler durch
//! ist (oder ein Timeout abgelaufen ist). Das verhindert Race-Conditions,
//! wenn ein E2E-Treiber direkt nach `/click` `/state` abfragt, bevor die
//! DOM-Mutationen + Render-Effekte durch sind.
//!
//! Mechanismus (synthetisiert mit Codex 2026-05-12, Doku in `TODO.md`):
//! - Pro Request generiert `register()` eine `u64`-ID und legt einen
//!   [`oneshot::Sender`] in der `pending_acks`-Map ab. Frontend bekommt die
//!   ID im Event-Payload.
//! - `wait_for_ack()` wartet via [`tokio::time::timeout`] auf den
//!   Receiver; im Timeout-Pfad entfernt es die ID wieder, damit die Map
//!   nicht waechst.
//! - Das Tauri-Command [`crate::commands::automation::automation_ack`]
//!   ruft [`signal_ack`], das den Sender aus der Map nimmt und feuert. Wer
//!   nach dem Timeout kommt, findet keinen Sender mehr und wird ignoriert.

use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::state::AppState;

/// Reserviert eine neue Ack-ID und legt den Sender in `AppState.pending_acks`
/// ab. Gibt die ID und den passenden Receiver zurueck.
pub fn register(state: &AppState) -> Result<(u64, oneshot::Receiver<()>), String> {
    let id = state
        .next_ack_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    state
        .pending_acks
        .lock()
        .map_err(|_| "pending ack lock poisoned".to_string())?
        .insert(id, sender);
    Ok((id, receiver))
}

/// Wartet bis zur angegebenen Frist auf das ACK. Bei Timeout wird die ID
/// aus der Map entfernt (Cleanup); bei Erfolg ist der Sender schon
/// konsumiert, weil [`signal_ack`] vorher `remove` gemacht hat.
pub async fn wait_for_ack(
    state: &AppState,
    id: u64,
    receiver: oneshot::Receiver<()>,
    timeout_ms: u64,
) -> bool {
    match timeout(Duration::from_millis(timeout_ms), receiver).await {
        Ok(Ok(())) => true,
        _ => {
            if let Ok(mut map) = state.pending_acks.lock() {
                map.remove(&id);
            }
            false
        }
    }
}

/// Signalisiert das ACK fuer die gegebene ID. Idempotent: wenn die ID
/// bereits durch Timeout entfernt wurde, ist das kein Fehler.
pub fn signal_ack(state: &AppState, id: u64) -> Result<(), String> {
    let sender = state
        .pending_acks
        .lock()
        .map_err(|_| "pending ack lock poisoned".to_string())?
        .remove(&id);
    if let Some(sender) = sender {
        // Empfaenger ist evtl. schon weg (Receiver gedroppt) — fuer uns ok.
        let _ = sender.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    #[tokio::test]
    async fn signal_before_wait_resolves_immediately() {
        let state = AppState::new();
        let (id, receiver) = register(&state).unwrap();
        signal_ack(&state, id).unwrap();
        let acked = wait_for_ack(&state, id, receiver, 100).await;
        assert!(acked);
        assert!(state.pending_acks.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn timeout_returns_false_and_cleans_map() {
        let state = AppState::new();
        let (id, receiver) = register(&state).unwrap();
        let acked = wait_for_ack(&state, id, receiver, 20).await;
        assert!(!acked);
        assert!(state.pending_acks.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn signal_for_unknown_id_is_noop() {
        let state = AppState::new();
        // Kein register() vorher — signal_ack muss trotzdem Ok zurueckgeben.
        signal_ack(&state, 9999).unwrap();
    }

    #[tokio::test]
    async fn late_signal_after_timeout_is_ignored() {
        let state = AppState::new();
        let (id, receiver) = register(&state).unwrap();
        // Timeout zuerst — entfernt die ID.
        let acked = wait_for_ack(&state, id, receiver, 10).await;
        assert!(!acked);
        // Spaeteres ACK darf nicht panicken oder das State korruptieren.
        signal_ack(&state, id).unwrap();
        assert!(state.pending_acks.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unique_ids_per_register() {
        let state = AppState::new();
        let (a, _) = register(&state).unwrap();
        let (b, _) = register(&state).unwrap();
        assert_ne!(a, b);
        assert_eq!(state.pending_acks.lock().unwrap().len(), 2);
    }
}
