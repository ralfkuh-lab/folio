use axum::{
    body::Body,
    extract::{ConnectInfo, Request},
    http::{header, HeaderValue, Method, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;
use std::sync::OnceLock;

use super::error::ApiError;
use super::PORT;

/// Origins der Tauri-WebView: Windows/WebView2 nutzt `http(s)://tauri.localhost`,
/// Linux (WebKitGTK) und macOS (WKWebView) `tauri://localhost`. Nur diese
/// Origins bekommen CORS-Antworten (gespiegelt, kein `*`). Requests ohne
/// Origin-Header (curl, Python requests) sind erlaubt, erhalten aber keine
/// CORS-Header. Alles andere — insbesondere Browser-Seiten und `Origin: null`
/// (opaque Origins aus file:/data:/sandboxed iframes) — wird mit 403 abgelehnt.
const ALLOWED_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

/// Zentrale Security-Middleware: Loopback-Peer, Host-Header-Allowlist
/// (gegen DNS-Rebinding), Origin-Allowlist (gegen Browser-CSRF/Exfiltration)
/// und optionales Shared-Secret-Token. 403-Antworten tragen bewusst keine
/// CORS-Header — ein abgelehnter Browser-Kontext soll die Antwort nicht
/// lesen können.
pub(super) async fn security_guard(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !addr.ip().is_loopback() {
        return ApiError::forbidden("loopback only").into_response();
    }

    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !host.is_some_and(host_allowed) {
        tracing::warn!(
            target: "folio::automation",
            host = host.unwrap_or("<missing>"),
            "request with invalid host header rejected"
        );
        return ApiError::forbidden("invalid host header").into_response();
    }

    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let cors_origin = match origin {
        None => None,
        Some(origin) if ALLOWED_ORIGINS.contains(&origin.as_str()) => Some(origin),
        Some(origin) => {
            tracing::warn!(
                target: "folio::automation",
                %origin,
                "request from disallowed origin rejected"
            );
            return ApiError::forbidden("origin not allowed").into_response();
        }
    };

    // Preflights tragen nie Custom-Header und lösen selbst nichts aus —
    // der eigentliche Request wird erneut geprüft. OPTIONS hier beantworten
    // (statt catch-all-Route), damit unbekannte Pfade weiterhin 404 via
    // Fallback bekommen und nicht fälschlich 405 (method_not_allowed).
    if request.method() == Method::OPTIONS {
        let mut response = preflight().await.into_response();
        if let Some(origin) = cors_origin {
            add_cors_headers(&mut response, &origin);
        }
        return response;
    }

    let provided = request
        .headers()
        .get("x-folio-automation-token")
        .and_then(|value| value.to_str().ok());
    if !token_matches(required_token(), provided) {
        return ApiError::forbidden("missing or invalid automation token").into_response();
    }

    let mut response = next.run(request).await;
    if let Some(origin) = cors_origin {
        add_cors_headers(&mut response, &origin);
    }
    response
}

// ─── Frontend-Ready-Gate (Spec I1b) ─────────────────────────────────────────
//
// POSITIVE Matrix: nur bekannte FE-abhängige (Methode, Pfad)-Paare warten.
// Unbekannte Pfade und falsche Methoden laufen ohne Wait durch und
// liefern sofort 404/405 (kein 10s-Startup-Timeout).
//
// Warten NICHT (kein Eintrag unten):
//   GET  /state, /tabs, /console/errors, /settings, /editor/text
//   POST /search
//   OPTIONS *
//
// Warten (Eintrag unten): Routen die FE-Events/ACK/Screenshot brauchen.

/// Positive Allowlist: (METHOD, path) die auf frontend_ready warten.
fn needs_frontend_ready(method: &Method, path: &str) -> bool {
    matches!(
        (method.as_str(), path),
        ("GET", "/screenshot")
            | ("GET", "/dom")
            | ("POST", "/settings")
            | ("POST", "/open")
            | ("POST", "/open-ui")
            | ("POST", "/tabs/open")
            | ("POST", "/tabs/close")
            | ("POST", "/tabs/activate")
            | ("POST", "/tabs/close_all")
            | ("POST", "/tabs/reorder")
            | ("POST", "/tabs/restore_last")
            | ("POST", "/mode")
            | ("POST", "/theme")
            | ("POST", "/rail")
            | ("POST", "/split")
            | ("POST", "/click")
            | ("POST", "/rightclick")
            | ("POST", "/key")
            | ("POST", "/toc/activate")
            | ("POST", "/menu/click")
            | ("POST", "/editor/command")
            | ("POST", "/workspace/pin")
            | ("POST", "/workspace/unpin")
            | ("POST", "/workspace/clear_recents")
            | ("POST", "/history/back")
            | ("POST", "/history/forward")
            | ("POST", "/focus")
            | ("POST", "/find")
            | ("POST", "/find/text")
            | ("POST", "/eval")
            | ("POST", "/sync/render")
            | ("POST", "/editor/text")
            | ("POST", "/editor/selection")
            | ("POST", "/resize")
            | ("POST", "/save")
            | ("POST", "/wait")
            | ("POST", "/quit")
    )
}

/// Effective startup timeout: short in unit tests so gate tests stay fast.
fn ready_gate_timeout() -> std::time::Duration {
    #[cfg(test)]
    {
        std::time::Duration::from_millis(80)
    }
    #[cfg(not(test))]
    {
        crate::i18n::ready::STARTUP_TIMEOUT
    }
}

/// Wartet auf `frontend_ready` nur für FE-abhängige bekannte Routen.
pub(super) async fn frontend_ready_guard(request: Request<Body>, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    if needs_frontend_ready(&method, &path) && !crate::i18n::ready::is_ready() {
        let ok = crate::i18n::ready::wait_ready(ready_gate_timeout()).await;
        if !ok {
            tracing::warn!(
                target: "folio::automation",
                %method,
                %path,
                "frontend_ready timeout before automation route"
            );
            return ApiError::service_unavailable(
                "frontend not ready (frontend_ready timeout)".to_string(),
            )
            .into_response();
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod ready_matrix_tests {
    use super::*;
    use axum::http::Method;

    #[test]
    fn no_wait_routes() {
        assert!(!needs_frontend_ready(&Method::GET, "/state"));
        assert!(!needs_frontend_ready(&Method::GET, "/tabs"));
        assert!(!needs_frontend_ready(&Method::GET, "/console/errors"));
        assert!(!needs_frontend_ready(&Method::GET, "/settings"));
        assert!(!needs_frontend_ready(&Method::POST, "/search"));
        assert!(!needs_frontend_ready(&Method::GET, "/editor/text"));
        assert!(!needs_frontend_ready(&Method::OPTIONS, "/dom"));
        // Unknown path / wrong method: do not gate
        assert!(!needs_frontend_ready(&Method::GET, "/no-such-route"));
        assert!(!needs_frontend_ready(&Method::POST, "/dom"));
        assert!(!needs_frontend_ready(&Method::GET, "/click"));
    }

    #[test]
    fn wait_routes() {
        assert!(needs_frontend_ready(&Method::GET, "/dom"));
        assert!(needs_frontend_ready(&Method::GET, "/screenshot"));
        assert!(needs_frontend_ready(&Method::POST, "/click"));
        assert!(needs_frontend_ready(&Method::POST, "/eval"));
        assert!(needs_frontend_ready(&Method::POST, "/find"));
        assert!(needs_frontend_ready(&Method::POST, "/find/text"));
        assert!(needs_frontend_ready(&Method::POST, "/sync/render"));
        assert!(needs_frontend_ready(&Method::POST, "/menu/click"));
        assert!(needs_frontend_ready(&Method::POST, "/settings"));
        assert!(needs_frontend_ready(&Method::POST, "/open"));
        assert!(needs_frontend_ready(&Method::POST, "/tabs/open"));
        assert!(needs_frontend_ready(&Method::POST, "/quit"));
    }
}

#[cfg(test)]
mod ready_gate_integration {
    //! Router-level tests for the ready gate (F3).
    //! Serialised via GATE_LOCK because READY is process-global.
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        middleware,
        routing::{get, post},
        Router,
    };
    use std::time::{Duration, Instant};
    use tower::ServiceExt;

    /// Serialise ready-gate tests: process-global READY flag.
    static GATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn mini_router() -> Router {
        // No OPTIONS catch-all here: a `/{*path}` OPTIONS-only route would make
        // unknown paths hit method_not_allowed (405) instead of fallback (404).
        Router::new()
            .route("/state", get(|| async { "state-ok" }))
            .route("/dom", get(|| async { "dom-ok" }))
            .route("/click", post(|| async { "click-ok" }))
            .fallback(not_found)
            .method_not_allowed_fallback(method_not_allowed)
            .layer(middleware::from_fn(frontend_ready_guard))
    }

    async fn call(router: Router, method: &str, uri: &str) -> (StatusCode, String) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8_lossy(&bytes).into_owned();
        (status, body)
    }

    #[tokio::test]
    async fn never_ready_gated_route_returns_503_after_timeout() {
        let _guard = GATE_LOCK.lock().await;
        crate::i18n::ready::reset_for_tests();
        let start = Instant::now();
        let (status, body) = call(mini_router(), "GET", "/dom").await;
        let elapsed = start.elapsed();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(body.contains("frontend not ready"), "{body}");
        // Short test timeout (~80ms); must not hang for production 10s.
        assert!(elapsed < Duration::from_secs(2), "elapsed={elapsed:?}");
        assert!(elapsed >= Duration::from_millis(40), "elapsed={elapsed:?}");
    }

    #[tokio::test]
    async fn ready_during_wait_returns_ok() {
        let _guard = GATE_LOCK.lock().await;
        crate::i18n::ready::reset_for_tests();
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            crate::i18n::ready::mark_ready();
        });
        let (status, body) = call(mini_router(), "GET", "/dom").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "dom-ok");
    }

    #[tokio::test]
    async fn unknown_path_returns_404_immediately() {
        let _guard = GATE_LOCK.lock().await;
        crate::i18n::ready::reset_for_tests();
        let start = Instant::now();
        let (status, _) = call(mini_router(), "GET", "/no-such-route").await;
        let elapsed = start.elapsed();
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(
            elapsed < Duration::from_millis(200),
            "must not wait for ready-gate: elapsed={elapsed:?}"
        );
    }

    #[tokio::test]
    async fn wrong_method_returns_405_immediately() {
        let _guard = GATE_LOCK.lock().await;
        crate::i18n::ready::reset_for_tests();
        let start = Instant::now();
        // /dom is GET-only; POST is wrong method.
        let (status, _) = call(mini_router(), "POST", "/dom").await;
        let elapsed = start.elapsed();
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert!(
            elapsed < Duration::from_millis(200),
            "must not wait for ready-gate: elapsed={elapsed:?}"
        );
    }

    #[tokio::test]
    async fn ungated_state_works_while_not_ready() {
        let _guard = GATE_LOCK.lock().await;
        crate::i18n::ready::reset_for_tests();
        let (status, body) = call(mini_router(), "GET", "/state").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "state-ok");
    }
}

fn host_allowed(host: &str) -> bool {
    let Some((name, port)) = host.rsplit_once(':') else {
        return false;
    };
    port.parse() == Ok(PORT) && matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

/// Optionales Shared-Secret: Ist `FOLIO_AUTOMATION_TOKEN` beim App-Start
/// gesetzt, muss jeder Nicht-OPTIONS-Request denselben Wert im Header
/// `x-folio-automation-token` mitschicken (Defense-in-Depth zusätzlich
/// zur Origin-/Host-Prüfung).
fn required_token() -> Option<&'static str> {
    static TOKEN: OnceLock<Option<String>> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            std::env::var("FOLIO_AUTOMATION_TOKEN")
                .ok()
                .filter(|token| !token.is_empty())
        })
        .as_deref()
}

fn token_matches(required: Option<&str>, provided: Option<&str>) -> bool {
    match required {
        None => true,
        Some(required) => provided == Some(required),
    }
}

fn add_cors_headers(response: &mut Response, origin: &str) {
    let Ok(origin) = HeaderValue::from_str(origin) else {
        return;
    };
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, x-folio-automation-token"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

pub(super) async fn preflight() -> StatusCode {
    StatusCode::NO_CONTENT
}

pub(super) async fn not_found(method: Method, uri: Uri) -> ApiError {
    ApiError::not_found(format!("no route for {method} {}", uri.path()))
}

pub(super) async fn method_not_allowed(method: Method, uri: Uri) -> Response {
    if method == Method::OPTIONS {
        return preflight().await.into_response();
    }
    ApiError::method_not_allowed(format!("method not allowed for {method} {}", uri.path()))
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_allowlist_accepts_loopback_names_with_port() {
        assert!(host_allowed("127.0.0.1:9876"));
        assert!(host_allowed("localhost:9876"));
        assert!(host_allowed("[::1]:9876"));
    }

    #[test]
    fn host_allowlist_rejects_foreign_hosts_and_ports() {
        assert!(!host_allowed("evil.example:9876"));
        assert!(!host_allowed("127.0.0.1:80"));
        assert!(!host_allowed("127.0.0.1"));
        assert!(!host_allowed("localhost"));
        assert!(!host_allowed(""));
    }

    #[test]
    fn token_check_only_enforced_when_configured() {
        assert!(token_matches(None, None));
        assert!(token_matches(None, Some("anything")));
        assert!(token_matches(Some("secret"), Some("secret")));
        assert!(!token_matches(Some("secret"), None));
        assert!(!token_matches(Some("secret"), Some("wrong")));
    }
}
