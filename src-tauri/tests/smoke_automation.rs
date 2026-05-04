use axum::{
    body::{to_bytes, Body},
    extract::connect_info::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use folio_rs::automation::{build_mock_router, MockAutomationState};
use serde_json::{json, Value};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
};
use tempfile::TempDir;
use tower::ServiceExt;

#[tokio::test]
async fn get_state_returns_expected_json_shape() {
    let state = Arc::new(Mutex::new(MockAutomationState {
        text: "# Title\n## Child\n".into(),
        editor_ready: true,
        selection_start: 2,
        selection_length: 5,
        ..MockAutomationState::default()
    }));
    let response = request(build_mock_router(state), "GET", "/state", None, loopback()).await;

    assert_eq!(StatusCode::OK, response.status);
    assert_eq!("Folio RS", response.json["title"]);
    assert_eq!(false, response.json["dirty"]);
    assert_eq!("view", response.json["viewMode"]);
    assert_eq!(true, response.json["editor"]["ready"]);
    assert_eq!(2, response.json["editor"]["selectionStart"]);
    assert_eq!("Title", response.json["toc"][0]["text"]);
}

#[tokio::test]
async fn post_open_loads_temp_file_and_updates_state() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("doc.md");
    std::fs::write(&path, "# Opened\r\n").unwrap();
    let state = Arc::new(Mutex::new(MockAutomationState::default()));

    let response = request(
        build_mock_router(state.clone()),
        "POST",
        "/open",
        Some(json!({ "path": path.to_str().unwrap() })),
        loopback(),
    )
    .await;

    assert_eq!(StatusCode::OK, response.status);
    assert_eq!(true, response.json["ok"]);
    let state = state.lock().unwrap();
    assert_eq!(Some(path.to_string_lossy().into_owned()), state.file);
    assert_eq!("# Opened\n", state.text);
    assert!(!state.dirty);
}

#[tokio::test]
async fn post_save_clears_dirty_and_returns_ok() {
    let state = Arc::new(Mutex::new(MockAutomationState {
        dirty: true,
        ..MockAutomationState::default()
    }));
    let response = request(
        build_mock_router(state.clone()),
        "POST",
        "/save",
        None,
        loopback(),
    )
    .await;

    assert_eq!(StatusCode::OK, response.status);
    assert_eq!(true, response.json["ok"]);
    assert!(!state.lock().unwrap().dirty);
}

#[tokio::test]
async fn post_quit_marks_mock_state_without_exiting() {
    let state = Arc::new(Mutex::new(MockAutomationState::default()));
    let response = request(
        build_mock_router(state.clone()),
        "POST",
        "/quit",
        None,
        loopback(),
    )
    .await;

    assert_eq!(StatusCode::OK, response.status);
    assert_eq!(true, response.json["ok"]);
    assert!(state.lock().unwrap().quit_requested);
}

#[tokio::test]
async fn rejects_non_loopback_requests() {
    let state = Arc::new(Mutex::new(MockAutomationState::default()));
    let response = request(
        build_mock_router(state),
        "GET",
        "/state",
        None,
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10)), 4200),
    )
    .await;

    assert_eq!(StatusCode::FORBIDDEN, response.status);
    assert_eq!("loopback only", response.json["error"]);
}

#[tokio::test]
async fn unknown_routes_return_404() {
    let state = Arc::new(Mutex::new(MockAutomationState::default()));
    let response = request(
        build_mock_router(state),
        "GET",
        "/missing",
        None,
        loopback(),
    )
    .await;

    assert_eq!(StatusCode::NOT_FOUND, response.status);
    assert_eq!("no route for GET /missing", response.json["error"]);
}

struct TestResponse {
    status: StatusCode,
    json: Value,
}

async fn request(
    router: Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    addr: SocketAddr,
) -> TestResponse {
    let body = body.map_or_else(Body::empty, |value| Body::from(value.to_string()));
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(body)
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(addr));

    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap();

    TestResponse { status, json }
}

fn loopback() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 9876)
}
