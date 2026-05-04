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
pub mod toc;
pub mod vault;
pub mod workspace;

use state::AppState;
use tauri::{Listener, Manager};

pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .setup(|app| {
            let state = app.state::<AppState>();
            state.install_document_events(app.handle().clone())?;
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
            commands::workspace_cmd::workspace_get
        ])
}

pub fn run() {
    builder()
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}
