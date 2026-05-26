//! JS-Eval-Roundtrip für `POST /eval`.
//!
//! Pattern analog zu [`super::dom`]: Backend emittiert
//! `automation:eval { requestId, js }`, das Frontend führt den Code
//! via `Function(js)()` aus und ruft den Tauri-Command
//! `automation_eval_response(id, payload)`. Backend wartet via
//! [`tokio::sync::oneshot`] auf die Response (mit Timeout).

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::state::AppState;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalResult {
    pub ok: bool,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn register(state: &AppState) -> Result<(u64, oneshot::Receiver<EvalResult>), String> {
    let id = state
        .next_ack_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    state
        .pending_evals
        .lock()
        .map_err(|_| "pending evals lock poisoned".to_string())?
        .insert(id, sender);
    Ok((id, receiver))
}

pub async fn wait_for(
    state: &AppState,
    id: u64,
    receiver: oneshot::Receiver<EvalResult>,
    timeout_ms: u64,
) -> Option<EvalResult> {
    match timeout(Duration::from_millis(timeout_ms), receiver).await {
        Ok(Ok(payload)) => Some(payload),
        _ => {
            if let Ok(mut map) = state.pending_evals.lock() {
                map.remove(&id);
            }
            None
        }
    }
}

pub fn deliver(state: &AppState, id: u64, payload: EvalResult) -> Result<(), String> {
    let sender = state
        .pending_evals
        .lock()
        .map_err(|_| "pending evals lock poisoned".to_string())?
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
    async fn deliver_resolves_pending_wait() {
        let state = AppState::new();
        let (id, receiver) = register(&state).unwrap();
        let result = EvalResult {
            ok: true,
            value: Some(serde_json::json!("hello")),
            error: None,
        };
        deliver(&state, id, result).unwrap();
        let got = wait_for(&state, id, receiver, 100).await.unwrap();
        assert!(got.ok);
        assert_eq!(got.value, Some(serde_json::json!("hello")));
    }

    #[tokio::test]
    async fn timeout_cleans_map() {
        let state = AppState::new();
        let (id, receiver) = register(&state).unwrap();
        let got = wait_for(&state, id, receiver, 10).await;
        assert!(got.is_none());
        assert!(state.pending_evals.lock().unwrap().is_empty());
    }
}
