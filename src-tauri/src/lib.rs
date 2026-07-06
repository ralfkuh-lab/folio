pub mod ai;
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
pub mod logging;
pub mod menu;
pub mod navigation;
pub mod panel_state;
pub mod pdf_export;
mod persist;
pub mod renderer;
pub mod settings;
pub mod state;
pub mod tab_manager;
pub mod text_statistics;
pub mod theme;
pub mod toc;
pub mod vault;
pub mod vault_watcher;
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
            // Setting openFileTarget entscheidet: neuer Tab direkt im
            // Backend (Default) oder Replace-Semantik ueber den
            // bestehenden cli:open-Frontend-Pfad (openDocument ersetzt
            // das Dokument im aktiven Tab).
            let target = app
                .try_state::<crate::state::AppState>()
                .and_then(|state| {
                    state
                        .settings
                        .lock()
                        .ok()
                        .map(|settings| settings.data().open_file_target)
                })
                .unwrap_or_default();
            if target == crate::settings::OpenFileTarget::Newtab {
                if let Some(state) = app.try_state::<crate::state::AppState>() {
                    match crate::commands::tabs::open(&state, app, path.clone()) {
                        Ok(transition) => {
                            let _ = crate::commands::tabs::emit_navigation_changed(
                                app,
                                &transition,
                                None,
                            );
                            return;
                        }
                        Err(error) => {
                            tracing::warn!(
                                target: "folio::tabs",
                                %error,
                                "external open as new tab failed; falling back to cli:open"
                            );
                        }
                    }
                }
            }
            let _ = app.emit("cli:open", serde_json::json!({ "path": path }));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(|handle| {
            // Sprache aus den persistierten Settings ziehen — Live-Switch
            // gibt es bewusst nicht (Codex-Review: Menue-Rebuild verliert
            // den vom Frontend nachgepflegten checked/enabled-State).
            // Stattdessen wirkt die Sprachwahl beim naechsten Start.
            let lang = crate::settings::SettingsService::load()
                .data()
                .language
                .code();
            menu::build(handle, lang)
        })
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
                                    panel.set_window_size_in_memory(logical.width, logical.height);
                                }
                            }
                            // Persistenz debounced — Resized/Moved feuern
                            // waehrend eines Drags dutzendfach pro Sekunde,
                            // ein atomic Write pro Tick im UI-Thread waere
                            // unnoetige IO-Last.
                            schedule_panel_geometry_save(app);
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
                                    panel.set_window_position_in_memory(logical.x, logical.y);
                                }
                            }
                            schedule_panel_geometry_save(app);
                        }
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // Fenster-X mit ungespeicherten Aenderungen: Close
                    // abfangen und denselben Quit-Prompt-Pfad wie
                    // Strg+Q/Menue nutzen (menu:file_quit -> Frontend-
                    // Prompt -> quit_app). Ohne Dirty-State (oder wenn
                    // er nicht lesbar ist) schliesst das Fenster normal —
                    // so kann ein totes Frontend den Close nie blockieren.
                    let is_dirty = app
                        .try_state::<AppState>()
                        .and_then(|state| {
                            state
                                .tabs
                                .lock()
                                .ok()
                                .map(|tabs| tabs.any_dirty())
                        })
                        .unwrap_or(false);
                    if is_dirty {
                        api.prevent_close();
                        let _ = app.emit("menu:file_quit", serde_json::json!({}));
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let state = app.state::<AppState>();
            // Session vor der Event-Verdrahtung rekonstruieren: nur der
            // aktive Tab liest seine Datei; inaktive bleiben watcher-frei
            // pending. Der spaetere cli_pending_open-Aufruf re-emittiert
            // den aktiven Zustand, sobald das Frontend lauscht.
            state.restore_tabs()?;
            state.install_document_events(app.handle().clone())?;
            // VaultWatcher-Callback registrieren + initial-State aus
            // dem persistierten `vaultAutoRefresh`-Setting setzen.
            // Vault-Command-Handler (expand-dir/collapse-dir) rufen
            // danach watch/unwatch direkt auf state.vault_watcher.
            {
                let handle = app.handle().clone();
                let callback: crate::vault_watcher::ChangeCallback =
                    std::sync::Arc::new(move |path: String| {
                        let _ =
                            handle.emit("vault:dir_changed", serde_json::json!({ "path": path }));
                    });
                let enabled = state
                    .settings
                    .lock()
                    .map(|s| s.data().vault_auto_refresh)
                    .unwrap_or(true);
                if let Ok(mut watcher) = state.vault_watcher.lock() {
                    watcher.set_callback(callback);
                    watcher.set_enabled(enabled);
                }
            }
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
            if automation::enabled() {
                let automation =
                    automation::AutomationServer::new(app.handle().clone(), state.inner());
                let automation_handle = automation.start();
                app.manage(automation_handle);
            } else {
                tracing::info!(
                    target: "folio::automation",
                    "automation api disabled (release build without FOLIO_AUTOMATION=1)"
                );
            }
            let handle = app.handle().clone();
            app.listen("shell:event", {
                let handle = handle.clone();
                move |event| {
                    let payload = match serde_json::from_str(event.payload()) {
                        Ok(payload) => payload,
                        Err(error) => {
                            tracing::warn!(target: "folio::ipc", %error, "invalid shell:event payload");
                            return;
                        }
                    };
                    let state = handle.state::<AppState>();
                    if let Err(error) =
                        commands::events::route_shell_event(&payload, &state, &handle)
                    {
                        tracing::error!(target: "folio::ipc", %error, "shell:event failed");
                    }
                }
            });
            app.listen("editor:event", move |event| {
                let payload = match serde_json::from_str(event.payload()) {
                    Ok(payload) => payload,
                    Err(error) => {
                        tracing::warn!(target: "folio::ipc", %error, "invalid editor:event payload");
                        return;
                    }
                };
                let state = handle.state::<AppState>();
                if let Err(error) = commands::events::route_editor_event(&payload, &state, &handle)
                {
                    tracing::error!(target: "folio::ipc", %error, "editor:event failed");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_catalog_get,
            commands::ai::ai_catalog_refresh,
            commands::ai::ai_config_get,
            commands::ai::ai_provider_enable,
            commands::ai::ai_model_toggle,
            commands::ai::ai_custom_upsert,
            commands::ai::ai_custom_delete,
            commands::ai::ai_custom_models_fetch,
            commands::ai::ai_default_model_set,
            commands::ai::ai_recent_languages_set,
            commands::ai::ai_auth_set,
            commands::ai::ai_auth_remove,
            commands::ai::ai_auth_status,
            commands::ai::ai_translate_document,
            commands::ai::ai_translate_cancel,
            commands::app::dialog::open_folder,
            commands::app::dialog::pick_folder,
            commands::app::dialog::pick_file,
            commands::app::theme_get,
            commands::app::theme_set,
            commands::app::set_view_mode,
            commands::app::set_rail_visible,
            commands::app::editor_minimap_get,
            commands::app::panel_rails_get,
            commands::app::set_editor_minimap_visible,
            commands::app::split_mid_get,
            commands::app::set_split_mid_percent,
            commands::app::open_find,
            commands::app::cli_pending_open,
            commands::app::set_window_title,
            commands::app::set_webview_zoom,
            commands::app::shell_opener::show_in_file_manager,
            commands::app::shell_opener::open_terminal_at,
            commands::app::shell_opener::open_with_default,
            commands::app::shell_opener::run_file,
            commands::app::settings::settings_get,
            commands::app::settings::settings_update,
            commands::app::log_bridge::frontend_log,
            commands::file::read::read_file,
            commands::file::read::reload_document,
            commands::file::list::file_list,
            commands::file::save_as::save_as,
            commands::file::close::close_document,
            commands::file::rename::rename_file,
            commands::file::image::save_clipboard_image,
            commands::file::image::save_file_image,
            commands::file::image::pick_image_file,
            commands::file::image::pick_image_target_dir,
            commands::file::image::current_document_dir,
            menu::menu_set_enabled,
            menu::menu_set_checked,
            menu::menu_dispatch,
            menu::quit_app,
            commands::editor::editor_text_changed,
            commands::editor::editor_save_requested,
            commands::editor::discard_editor_changes,
            commands::editor::apply_editor_command,
            commands::editor::editor_ready,
            commands::editor::editor_selection,
            commands::editor::render_markdown_preview,
            commands::export::export_layouts,
            commands::export::view_themes,
            commands::export::themes_dir_path,
            commands::export::view_theme_css,
            commands::theme::theme_read,
            commands::theme::theme_write,
            commands::theme::theme_delete,
            commands::theme::theme_clone,
            commands::theme::theme_preview_render,
            commands::export::export_render,
            commands::export::export_html,
            commands::export::export_pdf,
            commands::export::pick_export_target,
            commands::icon::file_icon_data_uri,
            commands::icon::file_icons_batch,
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
            commands::tabs::tab_open,
            commands::tabs::tab_close,
            commands::tabs::tab_activate,
            commands::tabs::tabs_list,
            commands::events::shell_event,
            commands::events::editor_event,
            commands::workspace_cmd::workspace_pin,
            commands::workspace_cmd::workspace_unpin,
            commands::workspace_cmd::workspace_reorder_pinned,
            commands::workspace_cmd::workspace_add_recent,
            commands::workspace_cmd::workspace_remove_recent,
            commands::workspace_cmd::workspace_get,
            commands::workspace_cmd::workspace_get_image_dir,
            commands::workspace_cmd::workspace_set_image_dir,
            commands::automation::automation_ack,
            commands::automation::automation_dom_response,
            commands::automation::automation_eval_response,
            commands::automation::automation_console_error
        ])
}

/// Debounced Persistenz der Fenster-Geometrie: pro Resized/Moved-Tick
/// wird nur die Generation gebumpt und ein Save-Task geplant; schreiben
/// darf nur der Task, dessen Generation beim Aufwachen noch aktuell ist
/// (= seit 300 ms kein weiterer Tick).
fn schedule_panel_geometry_save(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let generation = state
        .panel_geometry_save_gen
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let result = {
            let Some(state) = app.try_state::<AppState>() else {
                return;
            };
            if state.panel_geometry_save_gen.load(Ordering::Relaxed) != generation {
                return;
            }
            let Ok(panel) = state.panel_state.lock() else {
                return;
            };
            panel.save()
        };
        if let Err(error) = result {
            tracing::warn!(target: "folio::settings", %error, "panel geometry save failed");
        }
    });
}

pub fn run() {
    // GTK-Menüs lösen auf Wayland einen Stack Overflow im GTK-Signal-
    // Layer aus (tauri-apps/tauri#5940). XWayland als Backend umgeht
    // das Problem; auf Nicht-Wayland-Systemen ist der Env-Var ein No-op.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    // Logging zuerst hochziehen — alle nachfolgenden Module (inkl.
    // `builder().setup(...)`) sollen schon einen Subscriber haben.
    // Level: persistiert in `settings.json`; `RUST_LOG` und
    // `cfg(debug_assertions)` haben Vorrang (siehe `logging::init`).
    let level = crate::settings::SettingsService::load().data().log_level;
    crate::logging::init(level, &crate::persist::log_dir());

    builder()
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Pending debounced Geometrie-Save flushen — sonst ginge
                // ein Move/Resize aus den letzten 300 ms vor dem Beenden
                // verloren.
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(panel) = state.panel_state.lock() {
                        let _ = panel.save();
                    }
                }
            }
        });
}
