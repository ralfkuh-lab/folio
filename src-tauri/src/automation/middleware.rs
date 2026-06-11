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
    // der eigentliche Request wird erneut geprüft.
    if request.method() != Method::OPTIONS {
        let provided = request
            .headers()
            .get("x-folio-automation-token")
            .and_then(|value| value.to_str().ok());
        if !token_matches(required_token(), provided) {
            return ApiError::forbidden("missing or invalid automation token").into_response();
        }
    }

    let mut response = next.run(request).await;
    if let Some(origin) = cors_origin {
        add_cors_headers(&mut response, &origin);
    }
    response
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
    ApiError::not_found(format!("no route for {method} {}", uri.path())).into_response()
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
