//! Menü-Konstruktion aus i18n-Labels. Initial-State (enabled/checked)
//! wird per `applyDocKind`/`set_view_mode`/`app:set_theme` vom Frontend
//! synchronisiert; hier sind alle State-abhängigen Items mit
//! `.enabled(false)` / `.checked(false)` vorbelegt.

use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Wry};

use super::ids;
use super::strings;

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
    // wird es per `rebuild_recent_submenu`, gerufen vom workspace_cmd-
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
    // Rail- und Minimap-Toggles haben bewusst keinen Accelerator —
    // Toggle-Optionen sind schneller per Toolbar erreichbar als per
    // Shortcut-Muskelgedaechtnis, und freie Shortcuts (Strg+B/Strg+/)
    // kollidieren mit Markdown-Edits (Bold) bzw. wirken unintuitiv.
    let item_rail_left = MenuItemBuilder::with_id(ids::VIEW_RAIL_LEFT, l.view_rail_left)
        .build(handle)?;
    let item_rail_right = MenuItemBuilder::with_id(ids::VIEW_RAIL_RIGHT, l.view_rail_right)
        .build(handle)?;
    // view.minimap: nur im Edit-Mode bei Markdown aktiv — Frontend toggelt
    // via app:set_mode + applyDocKind, analog zu help.cheatsheet.
    let item_minimap = MenuItemBuilder::with_id(ids::VIEW_MINIMAP, l.view_minimap)
        .enabled(false)
        .build(handle)?;
    let view_menu = SubmenuBuilder::new(handle, l.view)
        .item(&item_mode_view)
        .item(&item_mode_edit)
        .item(&item_mode_split)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&theme_submenu)
        .item(&PredefinedMenuItem::separator(handle)?)
        .item(&item_rail_left)
        .item(&item_minimap)
        .item(&item_rail_right)
        .build()?;

    // Hilfe
    // help.cheatsheet: nur im Edit-Mode bei Markdown-Dokumenten — Frontend
    // toggelt via app:set_mode + applyDocKind.
    // Kein Accelerator: F1 ist Monacos Command-Palette im Editor-Fokus.
    let item_cheatsheet = MenuItemBuilder::with_id(ids::HELP_CHEATSHEET, l.help_cheatsheet)
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
