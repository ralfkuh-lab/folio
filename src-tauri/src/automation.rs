use crate::{state::AppState, toc};
use axum::{
    body::Body,
    extract::{rejection::JsonRejection, ConnectInfo, Json, Request, State as AxumState},
    http::{header, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, options, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Cursor,
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Size};
use tokio::{net::TcpListener, sync::Notify};

pub struct AutomationServer<'a> {
    pub port: u16,
    pub app_handle: AppHandle,
    pub state: &'a AppState,
    shutdown: Arc<Notify>,
}

#[derive(Clone)]
pub struct AutomationServerHandle {
    shutdown: Arc<Notify>,
}

impl Drop for AutomationServerHandle {
    fn drop(&mut self) {
        self.shutdown.notify_waiters();
    }
}

#[derive(Clone)]
struct AutomationContext {
    app_handle: AppHandle,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationState {
    title: String,
    file: Option<String>,
    dirty: bool,
    view_mode: String,
    theme: String,
    left_rail_visible: bool,
    right_rail_visible: bool,
    toc: Vec<TocEntry>,
    editor: EditorAutomationState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TocEntry {
    level: u8,
    text: String,
    slug: String,
    number: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorAutomationState {
    ready: bool,
    selection_start: usize,
    selection_length: usize,
    left_rail_width: f64,
    right_rail_width: f64,
}

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

#[derive(Debug, Deserialize)]
struct OpenRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
struct ModeRequest {
    mode: String,
}

#[derive(Debug, Deserialize)]
struct ThemeRequest {
    mode: String,
}

#[derive(Debug, Deserialize)]
struct RailRequest {
    side: String,
    visible: bool,
}

#[derive(Debug, Deserialize)]
struct ClickRequest {
    name: String,
}

#[derive(Debug, Deserialize)]
struct TocActivateRequest {
    slug: String,
}

#[derive(Debug, Deserialize)]
struct FindTextRequest {
    term: String,
}

#[derive(Debug, Deserialize)]
struct ResizeRequest {
    width: f64,
    height: f64,
}

type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockAutomationState {
    pub title: String,
    pub file: Option<String>,
    pub text: String,
    pub dirty: bool,
    pub view_mode: String,
    pub theme: String,
    pub editor_ready: bool,
    pub selection_start: usize,
    pub selection_length: usize,
    pub quit_requested: bool,
}

impl Default for MockAutomationState {
    fn default() -> Self {
        Self {
            title: "Folio RS".into(),
            file: None,
            text: String::new(),
            dirty: false,
            view_mode: "view".into(),
            theme: "light".into(),
            editor_ready: false,
            selection_start: 0,
            selection_length: 0,
            quit_requested: false,
        }
    }
}

pub fn build_mock_router(state: Arc<Mutex<MockAutomationState>>) -> Router {
    Router::new()
        .route("/state", get(mock_get_state))
        .route("/open", post(mock_post_open))
        .route("/save", post(mock_post_save))
        .route("/quit", post(mock_post_quit))
        .route("/{*path}", options(preflight))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn(loopback_only))
        .with_state(state)
}

impl<'a> AutomationServer<'a> {
    pub fn new(app_handle: AppHandle, state: &'a AppState) -> Self {
        Self {
            port: 9876,
            app_handle,
            state,
            shutdown: Arc::new(Notify::new()),
        }
    }

    pub fn start(&self) -> AutomationServerHandle {
        let port = self.port;
        let shutdown = self.shutdown.clone();
        let app = build_router(AutomationContext {
            app_handle: self.app_handle.clone(),
        });

        tauri::async_runtime::spawn(async move {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            match TcpListener::bind(addr).await {
                Ok(listener) => {
                    eprintln!("Automation listening on http://127.0.0.1:{port}");
                    if let Err(error) = axum::serve(
                        listener,
                        app.into_make_service_with_connect_info::<SocketAddr>(),
                    )
                    .with_graceful_shutdown(async move {
                        shutdown.notified().await;
                    })
                    .await
                    {
                        eprintln!("automation server failed: {error}");
                    }
                }
                Err(error) => eprintln!("automation server bind failed: {error}"),
            }
        });

        AutomationServerHandle {
            shutdown: self.shutdown.clone(),
        }
    }
}

fn build_router(context: AutomationContext) -> Router {
    Router::new()
        .route("/state", get(get_state))
        .route("/screenshot", get(get_screenshot))
        .route("/open", post(post_open))
        .route("/mode", post(post_mode))
        .route("/theme", post(post_theme))
        .route("/rail", post(post_rail))
        .route("/click", post(post_click))
        .route("/toc/activate", post(post_toc_activate))
        .route("/focus", post(post_focus))
        .route("/find", post(post_find))
        .route("/find/text", post(post_find_text))
        .route("/resize", post(post_resize))
        .route("/save", post(post_save))
        .route("/quit", post(post_quit))
        .route("/{*path}", options(preflight))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn(loopback_only))
        .with_state(context)
}

async fn loopback_only(
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

async fn preflight() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn get_state(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<AutomationState>> {
    let title = context
        .app_handle
        .get_webview_window("main")
        .and_then(|window| window.title().ok())
        .unwrap_or_else(|| "Folio RS".into());
    let state = context.app_handle.state::<AppState>();
    let document = state
        .document_store
        .lock()
        .map_err(|_| ApiError::internal("document store lock poisoned"))?;
    let panel = state
        .panel_state
        .lock()
        .map_err(|_| ApiError::internal("panel state lock poisoned"))?
        .data();
    let automation = state
        .automation
        .lock()
        .map_err(|_| ApiError::internal("automation state lock poisoned"))?
        .clone();
    let toc = toc::extract(&document.text)
        .into_iter()
        .map(|entry| TocEntry {
            level: entry.level,
            text: entry.text,
            slug: entry.slug,
            number: entry.number,
        })
        .collect();

    Ok(Json(AutomationState {
        title,
        file: document.path.clone(),
        dirty: document.is_dirty,
        view_mode: automation.view_mode,
        theme: automation.theme,
        left_rail_visible: panel.left_rail_visible,
        right_rail_visible: panel.right_rail_visible,
        toc,
        editor: EditorAutomationState {
            ready: automation.editor_ready,
            selection_start: automation.selection_start,
            selection_length: automation.selection_length,
            left_rail_width: panel.left_rail_width,
            right_rail_width: panel.right_rail_width,
        },
    }))
}

async fn mock_get_state(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
) -> ApiResult<Json<AutomationState>> {
    let state = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
    let toc = toc::extract(&state.text)
        .into_iter()
        .map(|entry| TocEntry {
            level: entry.level,
            text: entry.text,
            slug: entry.slug,
            number: entry.number,
        })
        .collect();

    Ok(Json(AutomationState {
        title: state.title.clone(),
        file: state.file.clone(),
        dirty: state.dirty,
        view_mode: state.view_mode.clone(),
        theme: state.theme.clone(),
        left_rail_visible: true,
        right_rail_visible: true,
        toc,
        editor: EditorAutomationState {
            ready: state.editor_ready,
            selection_start: state.selection_start,
            selection_length: state.selection_length,
            left_rail_width: 260.0,
            right_rail_width: 300.0,
        },
    }))
}

async fn get_screenshot() -> ApiResult<impl IntoResponse> {
    let bytes = tauri::async_runtime::spawn_blocking(capture_png)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))??;
    Ok(([(axum::http::header::CONTENT_TYPE, "image/png")], bytes))
}

async fn post_open(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<OpenRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let state = context.app_handle.state::<AppState>();
    state
        .document_store
        .lock()
        .map_err(|_| ApiError::internal("document store lock poisoned"))?
        .load(&payload.path)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    state
        .vault
        .lock()
        .map_err(|_| ApiError::internal("vault lock poisoned"))?
        .set_active(Some(payload.path));
    ok()
}

async fn mock_post_open(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
    payload: Result<Json<OpenRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let text =
        fs::read_to_string(&payload.path).map_err(|error| ApiError::internal(error.to_string()))?;
    let mut state = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
    state.file = Some(payload.path);
    state.text = text.replace("\r\n", "\n");
    state.dirty = false;
    ok()
}

async fn post_mode(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<ModeRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let mode = payload.mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "view" | "edit" | "split") {
        return Err(ApiError::bad_request(format!("unknown mode '{mode}'")));
    }
    context
        .app_handle
        .state::<AppState>()
        .automation
        .lock()
        .map_err(|_| ApiError::internal("automation state lock poisoned"))?
        .view_mode = mode.clone();
    emit(
        &context,
        "app:set_mode",
        serde_json::json!({ "mode": mode }),
    )?;
    ok()
}

async fn post_theme(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<ThemeRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let mode = payload.mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "light" | "dark" | "toggle") {
        return Err(ApiError::bad_request(format!("unknown theme '{mode}'")));
    }
    let resolved = {
        let state = context.app_handle.state::<AppState>();
        let mut theme = state
            .theme
            .lock()
            .map_err(|_| ApiError::internal("theme lock poisoned"))?;
        let resolved = if mode == "toggle" {
            theme
                .toggle()
                .map_err(|error| ApiError::internal(error.to_string()))?
                .to_string()
        } else {
            theme
                .set_mode(&mode)
                .map_err(|error| ApiError::internal(error.to_string()))?;
            theme.mode().to_string()
        };
        state
            .automation
            .lock()
            .map_err(|_| ApiError::internal("automation state lock poisoned"))?
            .theme = resolved.clone();
        resolved
    };
    emit(
        &context,
        "app:set_theme",
        serde_json::json!({ "mode": resolved }),
    )?;
    ok()
}

async fn post_rail(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<RailRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    let side = payload.side.to_ascii_lowercase();
    if !matches!(side.as_str(), "left" | "right") {
        return Err(ApiError::bad_request(format!("unknown side '{side}'")));
    }
    let panel = {
        let state = context.app_handle.state::<AppState>();
        let mut panel_state = state
            .panel_state
            .lock()
            .map_err(|_| ApiError::internal("panel state lock poisoned"))?;
        panel_state
            .set_rail_visible(&side, payload.visible)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        panel_state.data()
    };
    emit(
        &context,
        "panel:rail_changed",
        serde_json::json!({
            "side": side,
            "visible": payload.visible,
            "leftRailVisible": panel.left_rail_visible,
            "rightRailVisible": panel.right_rail_visible,
        }),
    )?;
    ok()
}

async fn post_click(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<ClickRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    emit(
        &context,
        "automation:click",
        serde_json::json!({ "name": payload.name }),
    )?;
    ok()
}

async fn post_toc_activate(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<TocActivateRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    emit(
        &context,
        "navigation:toc_click",
        serde_json::json!({ "anchor": payload.slug, "slug": payload.slug }),
    )?;
    ok()
}

async fn post_focus(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<OkResponse>> {
    let window = main_window(&context)?;
    window
        .show()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    window
        .set_focus()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    ok()
}

async fn post_find(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<OkResponse>> {
    emit(&context, "editor:open_find", serde_json::json!({}))?;
    ok()
}

async fn post_find_text(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<FindTextRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    emit(
        &context,
        "editor:set_find_term",
        serde_json::json!({ "term": payload.term }),
    )?;
    ok()
}

async fn post_resize(
    AxumState(context): AxumState<AutomationContext>,
    payload: Result<Json<ResizeRequest>, JsonRejection>,
) -> ApiResult<Json<OkResponse>> {
    let Json(payload) = json_payload(payload)?;
    main_window(&context)?
        .set_size(Size::Logical(LogicalSize::new(
            payload.width,
            payload.height,
        )))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    ok()
}

async fn post_save(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<OkResponse>> {
    let saved = context
        .app_handle
        .state::<AppState>()
        .document_store
        .lock()
        .map_err(|_| ApiError::internal("document store lock poisoned"))?
        .save()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(OkResponse { ok: saved }))
}

async fn mock_post_save(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
) -> ApiResult<Json<OkResponse>> {
    let mut state = state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?;
    state.dirty = false;
    ok()
}

async fn post_quit(
    AxumState(context): AxumState<AutomationContext>,
) -> ApiResult<Json<OkResponse>> {
    context.app_handle.exit(0);
    ok()
}

async fn mock_post_quit(
    AxumState(state): AxumState<Arc<Mutex<MockAutomationState>>>,
) -> ApiResult<Json<OkResponse>> {
    state
        .lock()
        .map_err(|_| ApiError::internal("mock automation state lock poisoned"))?
        .quit_requested = true;
    ok()
}

async fn not_found(method: Method, uri: Uri) -> ApiError {
    ApiError::not_found(format!("no route for {method} {}", uri.path()))
}

async fn method_not_allowed(method: Method, uri: Uri) -> Response {
    if method == Method::OPTIONS {
        return preflight().await.into_response();
    }
    ApiError::not_found(format!("no route for {method} {}", uri.path())).into_response()
}

fn ok() -> ApiResult<Json<OkResponse>> {
    Ok(Json(OkResponse { ok: true }))
}

fn json_payload<T>(payload: Result<Json<T>, JsonRejection>) -> ApiResult<Json<T>> {
    payload.map_err(|error| ApiError::bad_request(error.to_string()))
}

fn emit(
    context: &AutomationContext,
    event: &str,
    payload: serde_json::Value,
) -> Result<(), ApiError> {
    context
        .app_handle
        .emit(event, payload)
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn main_window(context: &AutomationContext) -> ApiResult<tauri::WebviewWindow<tauri::Wry>> {
    context
        .app_handle
        .get_webview_window("main")
        .ok_or_else(|| ApiError::internal("main window not found"))
}

fn capture_png() -> ApiResult<Vec<u8>> {
    let image = xcap::Window::all()
        .map_err(|error| ApiError::internal(error.to_string()))?
        .into_iter()
        .find(|window| window.title().is_ok_and(|title| title == "Folio RS"))
        .ok_or_else(|| ApiError::internal("Folio RS window not found"))?
        .capture_image()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let mut cursor = Cursor::new(Vec::new());
    xcap::image::DynamicImage::ImageRgba8(image)
        .write_to(&mut cursor, xcap::image::ImageFormat::Png)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(cursor.into_inner())
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response()
    }
}
