//! Anwendungs-Menüleiste (Datei / Bearbeiten / Ansicht / Hilfe).
//!
//! - [`build`] konstruiert das `tauri::menu::Menu` aus den i18n-Labels.
//! - [`on_menu_event`] ist der zentrale Dispatcher: Backend-Aktionen
//!   (Save-As, Beenden) laufen direkt in Rust; UI-Aktionen, deren Logik
//!   im Frontend lebt, werden als `menu:<id>`-Events emittiert. So
//!   bleibt die Toolbar-Logik die einzige Implementierung; das Menü
//!   triggert sie nur.
//! - [`refresh_recent_from_workspace`] / [`rebuild_recent_submenu`]
//!   befüllen das Recent-Submenü dynamisch aus `workspace.recent`.

mod build;
mod events;
mod ids;
mod lookup;
mod recent;
pub mod strings;

pub use build::build;
pub use events::{dispatch_menu_action, on_menu_event};
pub use recent::{rebuild_recent_submenu, refresh_recent_from_workspace};

use tauri::AppHandle;

/// Setzt den Enabled-State eines Menü-Items per ID. Wird vom Frontend
/// aus den existierenden State-Wechseln gerufen (markDirty, applyDocKind,
/// app:set_mode etc.). Unbekannte IDs sind ein No-op (keine Fehlerflut
/// beim Initial-Render, falls die Liste sich verschiebt).
#[tauri::command]
pub async fn menu_set_enabled(handle: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let Some(menu) = handle.menu() else {
        return Ok(());
    };
    // Sowohl normale MenuItems als auch CheckMenuItems unterstützen —
    // view.mode.view ist seit dem Häkchen-Umbau ein CheckMenuItem, soll
    // aber weiterhin per applyDocKind enabled/disabled werden.
    if let Some(item) = lookup::find_menu_item(&menu, &id) {
        item.set_enabled(enabled).map_err(|e| e.to_string())?;
    } else if let Some(item) = lookup::find_check_menu_item(&menu, &id) {
        item.set_enabled(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Setzt den Checked-State eines CheckMenuItems per ID. Wird vom Frontend
/// gerufen (Theme-Wechsel, Mode-Wechsel), damit das Häkchen unabhängig
/// vom Klick-Pfad (Menü, Toolbar, Statusbar, Persistenz beim Boot) zum
/// State passt. Unbekannte IDs sind ein No-op.
#[tauri::command]
pub async fn menu_set_checked(handle: AppHandle, id: String, checked: bool) -> Result<(), String> {
    let Some(menu) = handle.menu() else {
        return Ok(());
    };
    if let Some(item) = lookup::find_check_menu_item(&menu, &id) {
        item.set_checked(checked).map_err(|e| e.to_string())?;
    }
    Ok(())
}
