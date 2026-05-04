pub mod automation;
pub mod commands;
pub mod document_store;
pub mod editor_commands;
pub mod file_resolver;
pub mod frontmatter;
pub mod heading_anchor;
pub mod link_interceptor;
pub mod navigation;
pub mod panel_state;
mod persist;
pub mod renderer;
pub mod state;
pub mod text_statistics;
pub mod theme;
pub mod toc;
pub mod vault;
pub mod workspace;

use state::AppState;
use tauri::{LogicalPosition, LogicalSize, Listener, Manager, WindowEvent};

pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            match event {
                WindowEvent::Resized(_) => {
                    if let Ok(size) = window.inner_size() {
                        if let Ok(scale) = window.scale_factor() {
                            let logical = size.to_logical::<f64>(scale);
                            if let Some(state) = app.try_state::<AppState>() {
                                if let Ok(mut panel) = state.panel_state.lock() {
                                    let _ = panel.set_window_size(logical.width, logical.height);
                                }
                            }
                        }
                    }
                }
                WindowEvent::Moved(_) => {
                    if let Ok(pos) = window.outer_position() {
                        if let Ok(scale) = window.scale_factor() {
                            let logical = pos.to_logical::<f64>(scale);
                            if let Some(state) = app.try_state::<AppState>() {
                                if let Ok(mut panel) = state.panel_state.lock() {
                                    let _ = panel.set_window_position(logical.x, logical.y);
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let state = app.state::<AppState>();
            state.install_document_events(app.handle().clone())?;
            if let Some(window) = app.get_webview_window("main") {
                let panel = state
                    .panel_state
                    .lock()
                    .map_err(|_| "panel state lock poisoned".to_string())?
                    .data();
                if let (Some(w), Some(h)) = (panel.window_width, panel.window_height) {
                    let _ = window.set_size(LogicalSize::new(w, h));
                }
                if let (Some(x), Some(y)) = (panel.window_x, panel.window_y) {
                    let _ = window.set_position(LogicalPosition::new(x, y));
                }
            }
            let automation = automation::AutomationServer::new(app.handle().clone(), state.inner());
            let automation_handle = automation.start();
            app.manage(automation_handle);
            let handle = app.handle().clone();
            app.listen("shell:event", {
                let handle = handle.clone();
                move |event| {
                    let payload = match serde_json::from_str(event.payload()) {
                        Ok(payload) => payload,
                        Err(error) => {
                            eprintln!("invalid shell:event payload: {error}");
                            return;
                        }
                    };
                    let state = handle.state::<AppState>();
                    if let Err(error) =
                        commands::shell::route_shell_event(&payload, &state, &handle)
                    {
                        eprintln!("shell:event failed: {error}");
                    }
                }
            });
            app.listen("editor:event", move |event| {
                let payload = match serde_json::from_str(event.payload()) {
                    Ok(payload) => payload,
                    Err(error) => {
                        eprintln!("invalid editor:event payload: {error}");
                        return;
                    }
                };
                let state = handle.state::<AppState>();
                if let Err(error) = commands::shell::route_editor_event(&payload, &state, &handle) {
                    eprintln!("editor:event failed: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::open_folder,
            commands::app::pick_folder,
            commands::app::pick_file,
            commands::app::theme_get,
            commands::app::show_in_file_manager,
            commands::file::read_file,
            commands::file::write_file,
            commands::file::file_list,
            commands::editor::editor_text_changed,
            commands::editor::editor_save_requested,
            commands::editor::apply_editor_command,
            commands::editor::editor_ready,
            commands::editor::editor_selection,
            commands::vault_cmd::vault_expand_dir,
            commands::vault_cmd::vault_collapse_dir,
            commands::vault_cmd::vault_toggle_section,
            commands::vault_cmd::vault_build_tree,
            commands::vault_cmd::rail_resize,
            commands::vault_cmd::context,
            commands::nav::navigate,
            commands::nav::go_back,
            commands::nav::go_forward,
            commands::nav::update_scroll,
            commands::nav::link_click,
            commands::nav::visible_heading,
            commands::nav::scroll_position,
            commands::nav::toc_click,
            commands::shell::shell_event,
            commands::shell::editor_event,
            commands::workspace_cmd::workspace_pin,
            commands::workspace_cmd::workspace_unpin,
            commands::workspace_cmd::workspace_add_recent,
            commands::workspace_cmd::workspace_remove_recent,
            commands::workspace_cmd::workspace_get
        ])
}

pub fn run() {
    builder()
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}
