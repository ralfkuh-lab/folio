//! Zentraler Dispatcher für Menü-Klicks.
//!
//! Backend-Aktionen (Save-As, Rename, Beenden) laufen direkt in Rust;
//! UI-Aktionen, deren Logik im Frontend lebt, werden als
//! `menu:<id>`-Events emittiert. So bleibt die Toolbar-Logik die
//! einzige Implementierung; das Menü triggert sie nur.

use tauri::{AppHandle, Emitter, Manager};

use super::ids;
use crate::commands;

pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    dispatch_menu_action(app, event.id().0.as_str());
}

/// Führt die Aktion zu einer Menü-ID aus — gleicher Pfad wie ein echter
/// Menü-Klick, nur ohne `MenuEvent`. Damit kann die Automation-API
/// (`POST /menu/click`) Menü-Items synthetisch triggern, ohne dass eine
/// native OS-Eingabe simuliert werden muss.
pub fn dispatch_menu_action(app: &AppHandle, id: &str) {
    // Recent-Items: dynamische IDs, daher Prefix-Match. Index → Pfad aus
    // workspace.recent, Frontend bekommt den Pfad direkt im Payload und
    // ruft seinen üblichen openDocument-Pfad (mit Dirty-Prompt) auf.
    if let Some(rest) = id.strip_prefix(ids::FILE_RECENT_ITEM_PREFIX) {
        if rest == "empty" {
            return;
        }
        if let Ok(index) = rest.parse::<usize>() {
            let path = app.try_state::<crate::state::AppState>().and_then(|state| {
                state
                    .workspace
                    .lock()
                    .ok()
                    .and_then(|w| w.recent().get(index).map(|r| r.path.clone()))
            });
            if let Some(path) = path {
                let _ = app.emit("menu:file_recent", serde_json::json!({ "path": path }));
            }
        }
        return;
    }
    match id {
        ids::FILE_QUIT => {
            // Dirty-Gate ueber ALLE Tabs: hat irgendein Tab ungespeicherte
            // Aenderungen, entscheidet das Frontend per Prompt(s)
            // (menu:file_quit -> requestSaveIfDirty -> quit_app),
            // sonst direkt beenden. Ohne das Gate verwarf Strg+Q /
            // Menue-Beenden Dirty-Inhalt kommentarlos.
            let is_dirty = app
                .try_state::<crate::state::AppState>()
                .map(|state| {
                    let tabs_dirty = state
                        .tabs
                        .lock()
                        .ok()
                        .map(|tabs| tabs.any_dirty())
                        .unwrap_or(false);
                    // Eine editierte KI-Diff-Review zaehlt wie ein dirty
                    // Tab — sie lebt nur im Frontend (virtueller Tab).
                    tabs_dirty
                        || state
                            .ai_review_dirty
                            .load(std::sync::atomic::Ordering::Acquire)
                })
                .unwrap_or(false);
            if is_dirty {
                let _ = app.emit("menu:file_quit", serde_json::json!({}));
            } else {
                app.exit(0);
            }
        }
        ids::FILE_SAVE_AS => {
            let handle = app.clone();
            // Dialog ist blocking; wegen on_menu_event auf Main-Thread
            // in einen separaten Thread auslagern, damit das Menu nicht
            // hängt, während der User wählt.
            std::thread::spawn(move || {
                let state = handle.state::<crate::state::AppState>();
                if let Err(error) = commands::file::run_save_as(&state, &handle) {
                    tracing::error!(target: "folio::menu", %error, "save_as failed");
                }
            });
        }
        ids::FILE_RENAME => {
            let handle = app.clone();
            std::thread::spawn(move || {
                let state = handle.state::<crate::state::AppState>();
                if let Err(error) = commands::file::run_rename_dialog(&state, &handle) {
                    tracing::error!(target: "folio::menu", %error, "rename failed");
                    let _ = handle.emit("status:error", serde_json::json!({ "message": error }));
                }
            });
        }
        // Übrige Aktionen leben im Frontend (Toolbar-Pfad bleibt einzige
        // Implementierung). Wir emittieren je ein menu:<id>-Event, das
        // dort die bestehende Funktion ruft.
        // Linux-only: Markdown-Icon-Integration im Datei-Manager. Das
        // Skript ist blocking (startet u. a. nemo-desktop neu) und zeigt
        // am Ende selbst einen Ergebnis-Dialog — daher wie FILE_SAVE_AS
        // in einen eigenen Thread, damit die Menueleiste nicht haengt.
        #[cfg(target_os = "linux")]
        ids::HELP_SETUP_MD_ICON => {
            let handle = app.clone();
            std::thread::spawn(move || {
                crate::commands::app::icon_integration::run_icon_integration(&handle);
            });
        }
        ids::HELP_ABOUT => {
            let _ = app.emit(
                "menu:about",
                serde_json::json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "gitHash": env!("FOLIO_GIT_HASH"),
                    "buildDate": env!("FOLIO_BUILD_DATE"),
                }),
            );
        }
        _ => {
            // Tauri-Event-Namen erlauben keine Punkte; Menü-IDs nutzen
            // sie aber als Namespace-Trenner (file.save). Umwandeln.
            let event_name = format!("menu:{}", id.replace('.', "_"));
            let _ = app.emit(&event_name, serde_json::json!({}));
        }
    }
}
