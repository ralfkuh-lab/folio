pub mod automation;
pub mod commands;
pub mod document_service;
pub mod document_store;
pub mod editor_commands;
pub mod export;
pub mod file_icon;
pub mod file_kind;
pub mod file_resolver;
pub mod frontmatter;
pub mod heading_anchor;
pub mod link_interceptor;
pub mod menu;
pub mod navigation;
pub mod panel_state;
pub mod pdf_export;
mod persist;
pub mod renderer;
pub mod state;
pub mod text_statistics;
pub mod theme;
pub mod toc;
pub mod vault;
pub mod workspace;

use state::AppState;
use std::path::Path;
use tauri::{
    webview::Color, Emitter, Listener, LogicalPosition, LogicalSize, Manager, Theme, WindowEvent,
};

/// Findet im Argv-Stream den ersten Pfad, der wie eine zu öffnende Datei aussieht.
/// Skip: argv[0] (Programmname), Flags (`--foo`, `-x`), nicht-existente Pfade.
fn first_file_arg<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter();
    iter.next(); // argv[0]
    for arg in iter {
        let value = arg.as_ref();
        if value.is_empty() || value.starts_with('-') {
            continue;
        }
        if Path::new(value).is_file() {
            return Some(value.to_string());
        }
    }
    None
}

pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let Some(path) = first_file_arg(args) else {
                return;
            };
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit("cli:open", serde_json::json!({ "path": path }));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_screenshots::init())
        .menu(|handle| menu::build(handle, "de"))
        .on_menu_event(menu::on_menu_event)
        .manage(AppState::new())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            match event {
                WindowEvent::Resized(_) => {
                    let maximized = window.is_maximized().unwrap_or(false);
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut panel) = state.panel_state.lock() {
                            let _ = panel.set_window_maximized(maximized);
                        }
                    }
                    if maximized {
                        return;
                    }
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
                    if window.is_maximized().unwrap_or(false) {
                        return;
                    }
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
            // Recent-Submenü beim Boot mit den aktuellen workspace.recent
            // füllen — sonst zeigt es bis zur ersten Änderung "(keine
            // Einträge)".
            menu::refresh_recent_from_workspace(app.handle());
            if let Some(path) = first_file_arg(std::env::args()) {
                if let Ok(mut slot) = state.cli_open_path.lock() {
                    *slot = Some(path);
                }
            }
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
                if panel.window_maximized {
                    let _ = window.maximize();
                }
                // Phase-2-Flicker fixen: WebView-Hintergrund noch vor dem
                // ersten Show passend zum aktiven OS-Theme setzen. Default
                // ist sonst weiß (HTML-Spec) — sieht im Dark-Mode kurz
                // grell aus. Tauri 2's `theme()` liest auf Linux das
                // GTK-`prefer-dark-theme`, auf Windows die System-Pref,
                // auf macOS NSAppearance.
                let bg = match window.theme().unwrap_or(Theme::Dark) {
                    Theme::Light => Color(0xff, 0xff, 0xff, 0xff),
                    _ => Color(0x1e, 0x1e, 0x1e, 0xff),
                };
                let _ = window.set_background_color(Some(bg));
                let _ = window.show();
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
                        commands::events::route_shell_event(&payload, &state, &handle)
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
                if let Err(error) = commands::events::route_editor_event(&payload, &state, &handle)
                {
                    eprintln!("editor:event failed: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::dialog::open_folder,
            commands::app::dialog::pick_folder,
            commands::app::dialog::pick_file,
            commands::app::theme_get,
            commands::app::theme_set,
            commands::app::set_view_mode,
            commands::app::set_rail_visible,
            commands::app::open_find,
            commands::app::cli_pending_open,
            commands::app::set_window_title,
            commands::app::set_webview_zoom,
            commands::app::shell_opener::show_in_file_manager,
            commands::app::shell_opener::open_terminal_at,
            commands::file::read::read_file,
            commands::file::read::reload_document,
            commands::file::read::write_file,
            commands::file::list::file_list,
            commands::file::save_as::save_as,
            commands::file::close::close_document,
            commands::file::rename::rename_file,
            menu::menu_set_enabled,
            menu::menu_set_checked,
            commands::editor::editor_text_changed,
            commands::editor::editor_save_requested,
            commands::editor::discard_editor_changes,
            commands::editor::apply_editor_command,
            commands::editor::editor_ready,
            commands::editor::editor_selection,
            commands::export::export_layouts,
            commands::export::export_render,
            commands::export::export_html,
            commands::export::export_pdf,
            commands::export::pick_export_target,
            commands::icon::file_icon_data_uri,
            commands::icon::file_icons_batch,
            commands::vault_cmd::vault_expand_dir,
            commands::vault_cmd::vault_collapse_dir,
            commands::vault_cmd::vault_toggle_section,
            commands::vault_cmd::vault_build_tree,
            commands::vault_cmd::rail_resize,
            commands::vault_cmd::context,
            commands::nav::navigate,
            commands::nav::go_back,
            commands::nav::go_forward,
            commands::nav::go_back_and_emit,
            commands::nav::go_forward_and_emit,
            commands::nav::update_scroll,
            commands::nav::update_history_view_mode,
            commands::nav::update_history_editor_scroll,
            commands::nav::update_history_editor_cursor,
            commands::nav::visible_heading,
            commands::nav::scroll_position,
            commands::nav::toc_click,
            commands::events::shell_event,
            commands::events::editor_event,
            commands::workspace_cmd::workspace_pin,
            commands::workspace_cmd::workspace_unpin,
            commands::workspace_cmd::workspace_add_recent,
            commands::workspace_cmd::workspace_remove_recent,
            commands::workspace_cmd::workspace_get,
            commands::automation::automation_ack,
            commands::automation::automation_dom_response,
            commands::automation::automation_console_error
        ])
}

pub fn run() {
    builder()
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}
