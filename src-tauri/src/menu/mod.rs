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
use std::path::Path;
use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, MenuItemKind, PredefinedMenuItem,
    Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

pub mod ids {
    pub const FILE_OPEN: &str = "file.open";
    pub const FILE_SAVE: &str = "file.save";
    pub const FILE_SAVE_AS: &str = "file.save_as";
    pub const FILE_RECENT: &str = "file.recent";
    pub const FILE_RECENT_EMPTY: &str = "file.recent.empty";
    /// Prefix für dynamisch eingehängte Recent-Einträge: `file.recent.<index>`.
    pub const FILE_RECENT_ITEM_PREFIX: &str = "file.recent.";
    pub const FILE_RENAME: &str = "file.rename";
    pub const FILE_CLOSE: &str = "file.close";
    pub const FILE_QUIT: &str = "file.quit";
    pub const EDIT_UNDO: &str = "edit.undo";
    pub const EDIT_REDO: &str = "edit.redo";
    pub const EDIT_FIND: &str = "edit.find";
    pub const VIEW_MODE_VIEW: &str = "view.mode.view";
    pub const VIEW_MODE_EDIT: &str = "view.mode.edit";
    pub const VIEW_MODE_SPLIT: &str = "view.mode.split";
    pub const VIEW_THEME_LIGHT: &str = "view.theme.light";
    pub const VIEW_THEME_DARK: &str = "view.theme.dark";
    pub const VIEW_RAIL_LEFT: &str = "view.rail_left";
    pub const VIEW_RAIL_RIGHT: &str = "view.rail_right";
    pub const HELP_CHEATSHEET: &str = "help.cheatsheet";
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
    // file.rename: nur bei geladenem Dokument aktiv — Frontend toggelt
    // analog zu file.save_as via applyDocKind. Kein Shortcut, da Inline-
    // Rename im Vault-Kontextmenü die Standard-Geste ist und der Menü-
    // Pfad nur den Save-As-artigen Verzeichniswechsel anbietet.
    let item_rename = MenuItemBuilder::with_id(ids::FILE_RENAME, l.file_rename)
        .enabled(false)
        .build(handle)?;
    // file.close: nur bei geladenem Dokument aktiv — Frontend toggelt
    // analog zu file.save_as via applyDocKind.
    let item_close = MenuItemBuilder::with_id(ids::FILE_CLOSE, l.file_close)
        .accelerator("CmdOrCtrl+W")
        .enabled(false)
        .build(handle)?;
    let item_quit = MenuItemBuilder::with_id(ids::FILE_QUIT, l.file_quit)
        .accelerator("CmdOrCtrl+Q")
        .build(handle)?;
    // Recent-Submenü startet leer mit einem disabled Placeholder; befüllt
    // wird es per [`rebuild_recent_submenu`], gerufen vom workspace_cmd-
    // Modul nach jeder add/remove und beim Boot in setup().
    let item_recent_empty = MenuItemBuilder::with_id(ids::FILE_RECENT_EMPTY, l.file_recent_empty)
        .enabled(false)
        .build(handle)?;
    let recent_submenu = SubmenuBuilder::with_id(handle, ids::FILE_RECENT, l.file_recent)
        .item(&item_recent_empty)
        .build()?;
    let file_menu = SubmenuBuilder::new(handle, l.file)
        .item(&item_open)
        .item(&recent_submenu)
        .item(&item_save)
        .item(&item_save_as)
        .item(&item_rename)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&item_close)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&item_quit)
        .build()?;

    // Bearbeiten
    // edit.undo / edit.redo: nur im Edit-Mode aktiv — Frontend toggelt
    // via app:set_mode-Listener. Wir reichen den Click an Monaco's
    // editor.trigger('undo'/'redo') durch (FolioEditor.undo/redo).
    let item_undo = MenuItemBuilder::with_id(ids::EDIT_UNDO, l.edit_undo)
        .accelerator("CmdOrCtrl+Z")
        .enabled(false)
        .build(handle)?;
    let item_redo = MenuItemBuilder::with_id(ids::EDIT_REDO, l.edit_redo)
        .accelerator("CmdOrCtrl+Shift+Z")
        .enabled(false)
        .build(handle)?;
    let item_find = MenuItemBuilder::with_id(ids::EDIT_FIND, l.edit_find)
        .accelerator("CmdOrCtrl+F")
        .build(handle)?;
    let edit_menu = SubmenuBuilder::new(handle, l.edit)
        .item(&item_undo)
        .item(&item_redo)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&item_find)
        .build()?;

    // Ansicht
    // View/Edit/Split sind sich ausschließende Modi — als CheckMenuItems
    // mit Häkchen am aktiven. Synchron-Halten passiert im Frontend
    // (setActiveMode + app:set_mode-Listener) per `menu_set_checked`.
    // view.mode.view: nur für Markdown — Frontend toggelt via applyDocKind.
    let item_mode_view = CheckMenuItemBuilder::with_id(ids::VIEW_MODE_VIEW, l.view_mode_view)
        .accelerator("CmdOrCtrl+1")
        .enabled(false)
        .checked(false)
        .build(handle)?;
    let item_mode_edit = CheckMenuItemBuilder::with_id(ids::VIEW_MODE_EDIT, l.view_mode_edit)
        .accelerator("CmdOrCtrl+2")
        .checked(false)
        .build(handle)?;
    // view.mode.split: Stub — Feature noch nicht implementiert.
    let item_mode_split = CheckMenuItemBuilder::with_id(ids::VIEW_MODE_SPLIT, l.view_mode_split)
        .accelerator("CmdOrCtrl+3")
        .enabled(false)
        .checked(false)
        .build(handle)?;
    // Theme-Submenü: Hell/Dunkel als CheckMenuItems mit Häkchen am
    // aktiven. Initialer Zustand wird vom Frontend beim Boot über
    // `app:set_theme` synchronisiert.
    let item_theme_light = CheckMenuItemBuilder::with_id(ids::VIEW_THEME_LIGHT, l.view_theme_light)
        .checked(false)
        .build(handle)?;
    let item_theme_dark = CheckMenuItemBuilder::with_id(ids::VIEW_THEME_DARK, l.view_theme_dark)
        .checked(false)
        .build(handle)?;
    let theme_submenu = SubmenuBuilder::new(handle, l.view_theme)
        .item(&item_theme_light)
        .item(&item_theme_dark)
        .build()?;
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
        .item(&theme_submenu)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&item_rail_left)
        .item(&item_rail_right)
        .build()?;

    // Hilfe
    // help.cheatsheet: nur im Edit-Mode bei Markdown-Dokumenten — Frontend
    // toggelt via app:set_mode + applyDocKind.
    let item_cheatsheet = MenuItemBuilder::with_id(ids::HELP_CHEATSHEET, l.help_cheatsheet)
        .accelerator("F1")
        .enabled(false)
        .build(handle)?;
    let item_about = MenuItemBuilder::with_id(ids::HELP_ABOUT, l.help_about).build(handle)?;
    let help_menu = SubmenuBuilder::new(handle, l.help)
        .item(&item_cheatsheet)
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
    // Sowohl normale MenuItems als auch CheckMenuItems unterstützen —
    // view.mode.view ist seit dem Häkchen-Umbau ein CheckMenuItem, soll
    // aber weiterhin per applyDocKind enabled/disabled werden.
    if let Some(item) = find_menu_item(&menu, &id) {
        item.set_enabled(enabled).map_err(|e| e.to_string())?;
    } else if let Some(item) = find_check_menu_item(&menu, &id) {
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
    if let Some(item) = find_check_menu_item(&menu, &id) {
        item.set_checked(checked).map_err(|e| e.to_string())?;
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

/// Tauscht alle Children des Recent-Submenüs aus. Pfade in der
/// Reihenfolge der `workspace.recent`-Liste; bei leer ein disabled
/// Placeholder. Items bekommen IDs `file.recent.<index>` — `on_menu_event`
/// resolved den Pfad zur Click-Zeit aus `workspace.recent`, statt ihn in
/// die ID zu kodieren (Pfade enthalten oft Punkte/Slashes).
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

fn find_submenu(menu: &Menu<Wry>, id: &str) -> Option<Submenu<Wry>> {
    fn walk(items: &[MenuItemKind<Wry>], id: &str) -> Option<Submenu<Wry>> {
        for item in items {
            if let MenuItemKind::Submenu(sm) = item {
                if sm.id().0.as_str() == id {
                    return Some(sm.clone());
                }
                if let Ok(children) = sm.items() {
                    if let Some(found) = walk(&children, id) {
                        return Some(found);
                    }
                }
            }
        }
        None
    }
    walk(&menu.items().ok()?, id)
}

fn find_check_menu_item(menu: &Menu<Wry>, id: &str) -> Option<tauri::menu::CheckMenuItem<Wry>> {
    fn walk(items: &[MenuItemKind<Wry>], id: &str) -> Option<tauri::menu::CheckMenuItem<Wry>> {
        for item in items {
            match item {
                MenuItemKind::Check(ci) if ci.id().0.as_str() == id => return Some(ci.clone()),
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
        ids::FILE_RENAME => {
            let handle = app.clone();
            std::thread::spawn(move || {
                let state = handle.state::<crate::state::AppState>();
                if let Err(error) = commands::file::run_rename_dialog(&state, &handle) {
                    eprintln!("rename failed: {error}");
                    let _ = handle.emit("status:error", serde_json::json!({ "message": error }));
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
