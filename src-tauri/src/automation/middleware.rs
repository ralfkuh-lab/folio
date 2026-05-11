use axum::{
    body::Body,
    extract::{ConnectInfo, Request},
    http::{header, HeaderValue, Method, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;

use super::error::ApiError;

pub(super) async fn loopback_only(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !addr.ip().is_loopback() {
        let mut response = ApiError::forbidden("loopback only").into_response();
        add_cors_headers(&mut response);
        return response;
    }
    let mut response = next.run(request).await;
    add_cors_headers(&mut response);
    response
}

fn add_cors_headers(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
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
