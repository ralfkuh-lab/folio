//! DOM-Query-Roundtrip fuer `GET /dom?selector=...`.
//!
//! Pattern analog zu [`super::ack`], aber mit typed Payload statt
//! Unit-Signal: Backend emittet `automation:dom_query { requestId,
//! selector }`, das Frontend macht den DOM-Lookup und ruft den
//! Tauri-Command `automation_dom_response(id, payload)`. Backend
//! wartet via [`tokio::sync::oneshot`] auf die Response (mit Timeout).
//!
//! Cleanup: Timeout-Pfad entfernt die ID aus der Map; spaete Responses
//! finden keinen Sender mehr und werden ignoriert.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::state::AppState;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomSnapshot {
    pub exists: bool,
    #[serde(default)]
    pub text_content: Option<String>,
    #[serde(default)]
    pub inner_html: Option<String>,
    #[serde(default)]
    pub tag_name: Option<String>,
    #[serde(default)]
    pub attributes: HashMap<String, String>,
    /// Anzahl der Treffer fuer den Selektor; nuetzlich um zu erkennen,
    /// ob ein CSS-Selektor mehrere Elemente matcht — Snapshot enthaelt
    /// dann immer das erste.
    #[serde(default)]
    pub match_count: usize,
}

pub fn register(state: &AppState) -> Result<(u64, oneshot::Receiver<DomSnapshot>), String> {
    let id = state
        .next_ack_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    state
        .pending_dom_queries
        .lock()
        .map_err(|_| "pending dom query lock poisoned".to_string())?
        .insert(id, sender);
    Ok((id, receiver))
}

pub async fn wait_for(
    state: &AppState,
    id: u64,
    receiver: oneshot::Receiver<DomSnapshot>,
    timeout_ms: u64,
) -> Option<DomSnapshot> {
    match timeout(Duration::from_millis(timeout_ms), receiver).await {
        Ok(Ok(payload)) => Some(payload),
        _ => {
            if let Ok(mut map) = state.pending_dom_queries.lock() {
                map.remove(&id);
            }
            None
        }
    }
}

pub fn deliver(state: &AppState, id: u64, payload: DomSnapshot) -> Result<(), String> {
    let sender = state
        .pending_dom_queries
        .lock()
        .map_err(|_| "pending dom query lock poisoned".to_string())?
        .remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(payload);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    #[tokio::test]
    async fn deliver_resolves_pending_wait_with_payload() {
        let state = AppState::new();
        let (id, receiver) = register(&state).unwrap();
        let snap = DomSnapshot {
            exists: true,
            text_content: Some("hi".into()),
            ..DomSnapshot::default()
        };
        deliver(&state, id, snap.clone()).unwrap();
        let got = wait_for(&state, id, receiver, 100).await.unwrap();
        assert!(got.exists);
        assert_eq!(Some("hi".into()), got.text_content);
    }

    #[tokio::test]
    async fn timeout_cleans_map() {
        let state = AppState::new();
        let (id, receiver) = register(&state).unwrap();
        let got = wait_for(&state, id, receiver, 10).await;
        assert!(got.is_none());
        assert!(state.pending_dom_queries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deliver_for_unknown_id_is_noop() {
        let state = AppState::new();
        let snap = DomSnapshot::default();
        deliver(&state, 999, snap).unwrap();
    }
}
