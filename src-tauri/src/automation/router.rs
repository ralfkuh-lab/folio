use axum::{
    middleware,
    routing::{get, options, post},
    Router,
};
use std::sync::{Arc, Mutex};

use super::context::AutomationContext;
use super::handlers::{console, document, dom, eval, screenshot, state, ui, wait};
use super::middleware as mw;
use super::mock::MockAutomationState;

pub(super) fn build_router(context: AutomationContext) -> Router {
    Router::new()
        .route("/state", get(state::get_state))
        .route("/screenshot", get(screenshot::get_screenshot))
        .route("/dom", get(dom::get_dom))
        .route("/console/errors", get(console::get_console_errors))
        .route("/open", post(document::post_open))
        .route("/open-ui", post(document::post_open_ui))
        .route("/mode", post(ui::post_mode))
        .route("/theme", post(ui::post_theme))
        .route("/rail", post(ui::post_rail))
        .route("/click", post(ui::post_click))
        .route("/rightclick", post(ui::post_rightclick))
        .route("/key", post(ui::post_key))
        .route("/toc/activate", post(ui::post_toc_activate))
        .route("/menu/click", post(ui::post_menu_click))
        .route("/editor/command", post(ui::post_editor_command))
        .route("/workspace/pin", post(ui::post_workspace_pin))
        .route("/workspace/unpin", post(ui::post_workspace_unpin))
        .route("/history/back", post(ui::post_history_back))
        .route("/history/forward", post(ui::post_history_forward))
        .route("/focus", post(ui::post_focus))
        .route("/find", post(ui::post_find))
        .route("/find/text", post(ui::post_find_text))
        .route("/eval", post(eval::post_eval))
        .route(
            "/editor/text",
            get(document::get_editor_text).post(document::post_editor_text),
        )
        .route("/editor/selection", post(document::post_editor_selection))
        .route("/resize", post(ui::post_resize))
        .route("/save", post(document::post_save))
        .route("/wait", post(wait::post_wait))
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
        .route("/editor/text", get(document::mock_get_editor_text))
        .route(
            "/editor/selection",
            post(document::mock_post_editor_selection),
        )
        .route("/save", post(document::mock_post_save))
        .route("/wait", post(wait::mock_post_wait))
        .route("/console/errors", get(console::mock_get_console_errors))
        .route("/quit", post(document::mock_post_quit))
        .route("/{*path}", options(mw::preflight))
        .fallback(mw::not_found)
        .method_not_allowed_fallback(mw::method_not_allowed)
        .layer(middleware::from_fn(mw::loopback_only))
        .with_state(state)
}
