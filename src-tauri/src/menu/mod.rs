//! Anwendungs-Menüleiste (Datei / Bearbeiten / Ansicht / Hilfe).
//!
//! Architektur:
//! - [`build`] konstruiert das `tauri::menu::Menu` aus den i18n-Labels.
//! - [`on_menu_event`] ist der zentrale Dispatcher: Backend-Aktionen
//!   (Save-As, Beenden) laufen direkt in Rust; UI-Aktionen, deren Logik
//!   im Frontend lebt, werden als `menu:<id>`-Events emittiert. So
//!   bleibt die Toolbar-Logik die einzige Implementierung; das Menu
//!   triggert sie nur.

pub mod strings;

use crate::commands;
use tauri::menu::{
    Menu, MenuBuilder, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

pub mod ids {
    pub const FILE_OPEN: &str = "file.open";
    pub const FILE_SAVE: &str = "file.save";
    pub const FILE_SAVE_AS: &str = "file.save_as";
    pub const FILE_QUIT: &str = "file.quit";
    pub const EDIT_FIND: &str = "edit.find";
    pub const EDIT_CHEATSHEET: &str = "edit.cheatsheet";
    pub const VIEW_MODE_VIEW: &str = "view.mode.view";
    pub const VIEW_MODE_EDIT: &str = "view.mode.edit";
    pub const VIEW_MODE_SPLIT: &str = "view.mode.split";
    pub const VIEW_THEME_TOGGLE: &str = "view.theme_toggle";
    pub const VIEW_RAIL_LEFT: &str = "view.rail_left";
    pub const VIEW_RAIL_RIGHT: &str = "view.rail_right";
    pub const HELP_ABOUT: &str = "help.about";
}

pub fn build(handle: &AppHandle, lang: &str) -> tauri::Result<Menu<Wry>> {
    let l = strings::labels(lang);

    // Datei
    let item_open = MenuItemBuilder::with_id(ids::FILE_OPEN, l.file_open)
        .accelerator("CmdOrCtrl+O")
        .build(handle)?;
    // file.save: nur bei dirty aktiv — Frontend toggelt via markDirty().
    let item_save = MenuItemBuilder::with_id(ids::FILE_SAVE, l.file_save)
        .accelerator("CmdOrCtrl+S")
        .enabled(false)
        .build(handle)?;
    // file.save_as: nur bei geladenem Dokument — Frontend togget via applyDocKind.
    let item_save_as = MenuItemBuilder::with_id(ids::FILE_SAVE_AS, l.file_save_as)
        .accelerator("CmdOrCtrl+Shift+S")
        .enabled(false)
        .build(handle)?;
    let item_quit = MenuItemBuilder::with_id(ids::FILE_QUIT, l.file_quit)
        .accelerator("CmdOrCtrl+Q")
        .build(handle)?;
    let file_menu = SubmenuBuilder::new(handle, l.file)
        .item(&item_open)
        .item(&item_save)
        .item(&item_save_as)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&item_quit)
        .build()?;

    // Bearbeiten
    let item_find = MenuItemBuilder::with_id(ids::EDIT_FIND, l.edit_find)
        .accelerator("CmdOrCtrl+F")
        .build(handle)?;
    // edit.cheatsheet: nur im Edit-Mode — Frontend toggelt via app:set_mode.
    let item_cheatsheet = MenuItemBuilder::with_id(ids::EDIT_CHEATSHEET, l.edit_cheatsheet)
        .accelerator("F1")
        .enabled(false)
        .build(handle)?;
    let edit_menu = SubmenuBuilder::new(handle, l.edit)
        .item(&item_find)
        .item(&item_cheatsheet)
        .build()?;

    // Ansicht
    // view.mode.view: nur für Markdown — Frontend toggelt via applyDocKind.
    let item_mode_view = MenuItemBuilder::with_id(ids::VIEW_MODE_VIEW, l.view_mode_view)
        .accelerator("CmdOrCtrl+1")
        .enabled(false)
        .build(handle)?;
    let item_mode_edit = MenuItemBuilder::with_id(ids::VIEW_MODE_EDIT, l.view_mode_edit)
        .accelerator("CmdOrCtrl+2")
        .build(handle)?;
    // view.mode.split: Stub — Feature noch nicht implementiert.
    let item_mode_split = MenuItemBuilder::with_id(ids::VIEW_MODE_SPLIT, l.view_mode_split)
        .accelerator("CmdOrCtrl+3")
        .enabled(false)
        .build(handle)?;
    let item_theme =
        MenuItemBuilder::with_id(ids::VIEW_THEME_TOGGLE, l.view_theme_toggle).build(handle)?;
    let item_rail_left = MenuItemBuilder::with_id(ids::VIEW_RAIL_LEFT, l.view_rail_left)
        .accelerator("CmdOrCtrl+B")
        .build(handle)?;
    let item_rail_right = MenuItemBuilder::with_id(ids::VIEW_RAIL_RIGHT, l.view_rail_right)
        .accelerator("CmdOrCtrl+Slash")
        .build(handle)?;
    let view_menu = SubmenuBuilder::new(handle, l.view)
        .item(&item_mode_view)
        .item(&item_mode_edit)
        .item(&item_mode_split)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&item_theme)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&item_rail_left)
        .item(&item_rail_right)
        .build()?;

    // Hilfe
    let item_about = MenuItemBuilder::with_id(ids::HELP_ABOUT, l.help_about).build(handle)?;
    let help_menu = SubmenuBuilder::new(handle, l.help)
        .item(&item_about)
        .build()?;

    MenuBuilder::new(handle)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&help_menu)
        .build()
}

/// Setzt den Enabled-State eines Menü-Items per ID. Wird vom Frontend
/// aus den existierenden State-Wechseln gerufen (markDirty, applyDocKind,
/// app:set_mode etc.). Unbekannte IDs sind ein No-op (keine Fehlerflut
/// beim Initial-Render, falls die Liste sich verschiebt).
#[tauri::command]
pub async fn menu_set_enabled(handle: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let Some(menu) = handle.menu() else {
        return Ok(());
    };
    if let Some(item) = find_menu_item(&menu, &id) {
        item.set_enabled(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Rekursive Suche nach einem MenuItem über alle Untermenüs.
/// `Menu::get(id)` macht das in Tauri 2 nur top-level — wir wollen aber
/// in die Datei/Bearbeiten/Ansicht-Submenüs rein.
fn find_menu_item(menu: &Menu<Wry>, id: &str) -> Option<tauri::menu::MenuItem<Wry>> {
    fn walk(items: &[MenuItemKind<Wry>], id: &str) -> Option<tauri::menu::MenuItem<Wry>> {
        for item in items {
            match item {
                MenuItemKind::MenuItem(mi) if mi.id().0.as_str() == id => return Some(mi.clone()),
                MenuItemKind::Submenu(sm) => {
                    if let Ok(children) = sm.items() {
                        if let Some(found) = walk(&children, id) {
                            return Some(found);
                        }
                    }
                }
                _ => {}
            }
        }
        None
    }
    walk(&menu.items().ok()?, id)
}

pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();
    match id {
        ids::FILE_QUIT => {
            app.exit(0);
        }
        ids::FILE_SAVE_AS => {
            let handle = app.clone();
            // Dialog ist blocking; wegen on_menu_event auf Main-Thread
            // in einen separaten Thread auslagern, damit das Menu nicht
            // hängt, während der User wählt.
            std::thread::spawn(move || {
                let state = handle.state::<crate::state::AppState>();
                if let Err(error) = commands::file::run_save_as(&state, &handle) {
                    eprintln!("save_as failed: {error}");
                }
            });
        }
        // Übrige Aktionen leben im Frontend (Toolbar-Pfad bleibt einzige
        // Implementierung). Wir emittieren je ein menu:<id>-Event, das
        // dort die bestehende Funktion ruft.
        ids::HELP_ABOUT => {
            let _ = app.emit(
                "menu:about",
                serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
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
