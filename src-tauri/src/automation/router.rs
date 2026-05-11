use axum::{
    middleware,
    routing::{get, options, post},
    Router,
};
use std::sync::{Arc, Mutex};

use super::context::AutomationContext;
use super::handlers::{document, screenshot, state, ui};
use super::middleware as mw;
use super::mock::MockAutomationState;

pub(super) fn build_router(context: AutomationContext) -> Router {
    Router::new()
        .route("/state", get(state::get_state))
        .route("/screenshot", get(screenshot::get_screenshot))
        .route("/open", post(document::post_open))
        .route("/open-ui", post(document::post_open_ui))
        .route("/mode", post(ui::post_mode))
        .route("/theme", post(ui::post_theme))
        .route("/rail", post(ui::post_rail))
        .route("/click", post(ui::post_click))
        .route("/toc/activate", post(ui::post_toc_activate))
        .route("/focus", post(ui::post_focus))
        .route("/find", post(ui::post_find))
        .route("/find/text", post(ui::post_find_text))
        .route("/editor/text", post(document::post_editor_text))
        .route("/resize", post(ui::post_resize))
        .route("/save", post(document::post_save))
        .route("/quit", post(document::post_quit))
        .route("/{*path}", options(mw::preflight))
        .fallback(mw::not_found)
        .method_not_allowed_fallback(mw::method_not_allowed)
        .layer(middleware::from_fn(mw::loopback_only))
        .with_state(context)
}

pub fn build_mock_router(state: Arc<Mutex<MockAutomationState>>) -> Router {
    Router::new()
        .route("/state", get(state::mock_get_state))
        .route("/open", post(document::mock_post_open))
        .route("/save", post(document::mock_post_save))
        .route("/quit", post(document::mock_post_quit))
        .route("/{*path}", options(mw::preflight))
        .fallback(mw::not_found)
        .method_not_allowed_fallback(mw::method_not_allowed)
        .layer(middleware::from_fn(mw::loopback_only))
        .with_state(state)
}
