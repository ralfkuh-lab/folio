//! Menü-Item-IDs. Werden vom Frontend per `menu_set_enabled`/`menu_set_checked`
//! per String referenziert; Recent-Items hängen sich an
//! [`FILE_RECENT_ITEM_PREFIX`] mit einem laufenden Index.

pub(super) const FILE_OPEN: &str = "file.open";
pub(super) const FILE_SAVE: &str = "file.save";
pub(super) const FILE_SAVE_AS: &str = "file.save_as";
pub(super) const FILE_RECENT: &str = "file.recent";
pub(super) const FILE_RECENT_EMPTY: &str = "file.recent.empty";
/// Prefix für dynamisch eingehängte Recent-Einträge: `file.recent.<index>`.
pub(super) const FILE_RECENT_ITEM_PREFIX: &str = "file.recent.";
pub(super) const FILE_RENAME: &str = "file.rename";
pub(super) const FILE_CLOSE: &str = "file.close";
pub(super) const FILE_QUIT: &str = "file.quit";
pub(super) const EDIT_UNDO: &str = "edit.undo";
pub(super) const EDIT_REDO: &str = "edit.redo";
pub(super) const EDIT_FIND: &str = "edit.find";
pub(super) const VIEW_MODE_VIEW: &str = "view.mode.view";
pub(super) const VIEW_MODE_EDIT: &str = "view.mode.edit";
pub(super) const VIEW_MODE_SPLIT: &str = "view.mode.split";
pub(super) const VIEW_THEME_LIGHT: &str = "view.theme.light";
pub(super) const VIEW_THEME_DARK: &str = "view.theme.dark";
pub(super) const VIEW_RAIL_LEFT: &str = "view.rail_left";
pub(super) const VIEW_RAIL_RIGHT: &str = "view.rail_right";
pub(super) const HELP_CHEATSHEET: &str = "help.cheatsheet";
pub(super) const HELP_ABOUT: &str = "help.about";
