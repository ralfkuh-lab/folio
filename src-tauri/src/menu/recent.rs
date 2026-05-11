//! Recent-Submenü: dynamische Einträge nach `workspace.recent`.
//!
//! Items bekommen IDs `file.recent.<index>` — `on_menu_event` resolved
//! den Pfad zur Click-Zeit aus `workspace.recent`, statt ihn in die ID
//! zu kodieren (Pfade enthalten oft Punkte/Slashes, die Tauri-Event-
//! Namen nicht erlauben).

use std::path::Path;
use tauri::menu::MenuItemBuilder;
use tauri::{AppHandle, Manager};

use super::ids;
use super::lookup::find_submenu;
use super::strings;

/// Tauscht alle Children des Recent-Submenüs aus. Pfade in der
/// Reihenfolge der `workspace.recent`-Liste; bei leer ein disabled
/// Placeholder.
pub fn rebuild_recent_submenu(handle: &AppHandle, paths: &[String]) -> tauri::Result<()> {
    let Some(menu) = handle.menu() else {
        return Ok(());
    };
    let Some(submenu) = find_submenu(&menu, ids::FILE_RECENT) else {
        return Ok(());
    };
    // Vorhandene Children entfernen — Tauri 2 hat kein `clear`, also
    // iterativ remove_at(0) bis leer.
    while let Ok(Some(_)) = submenu.remove_at(0) {}

    if paths.is_empty() {
        let l = strings::labels("de");
        let placeholder = MenuItemBuilder::with_id(ids::FILE_RECENT_EMPTY, l.file_recent_empty)
            .enabled(false)
            .build(handle)?;
        submenu.append(&placeholder)?;
        return Ok(());
    }
    for (index, path) in paths.iter().enumerate().take(15) {
        let id = format!("{}{index}", ids::FILE_RECENT_ITEM_PREFIX);
        let label = recent_label(path);
        let item = MenuItemBuilder::with_id(id, label).build(handle)?;
        submenu.append(&item)?;
    }
    Ok(())
}

/// Convenience-Helper: liest workspace.recent aus dem AppState und ruft
/// `rebuild_recent_submenu`. Vom setup() und nach jeder Änderung an
/// workspace.recent (workspace_cmd, run_save_as) gerufen.
pub fn refresh_recent_from_workspace(handle: &AppHandle) {
    let Some(state) = handle.try_state::<crate::state::AppState>() else {
        return;
    };
    let paths = state
        .workspace
        .lock()
        .map(|w| {
            w.recent()
                .iter()
                .map(|r| r.path.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let _ = rebuild_recent_submenu(handle, &paths);
}

fn recent_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}
