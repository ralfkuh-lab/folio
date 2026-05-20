//! Beschriftungen für die Anwendungs-Menüleiste.
//!
//! Beide Sprachen (de/en) sind heute echte Übersetzungen. Welche aktiv
//! ist, entscheidet das Settings-Panel ([`crate::settings::SettingsData`]
//! `language`-Feld); der gewählte Sprachcode geht in [`labels`] und
//! kommt als statisches `MenuLabels` zurück.

#[derive(Debug, Clone, Copy)]
pub struct MenuLabels {
    pub file: &'static str,
    pub file_open: &'static str,
    pub file_save: &'static str,
    pub file_save_as: &'static str,
    pub file_recent: &'static str,
    pub file_recent_empty: &'static str,
    pub file_rename: &'static str,
    pub file_close: &'static str,
    pub file_quit: &'static str,
    pub edit: &'static str,
    pub edit_undo: &'static str,
    pub edit_redo: &'static str,
    pub edit_find: &'static str,
    pub edit_settings: &'static str,
    pub view: &'static str,
    pub view_mode_view: &'static str,
    pub view_mode_edit: &'static str,
    pub view_mode_split: &'static str,
    pub view_theme: &'static str,
    pub view_theme_light: &'static str,
    pub view_theme_dark: &'static str,
    pub view_rail_left: &'static str,
    pub view_rail_right: &'static str,
    pub view_minimap: &'static str,
    pub help: &'static str,
    pub help_cheatsheet: &'static str,
    pub help_about: &'static str,
    pub save_as_filter_markdown: &'static str,
    pub save_as_filter_text: &'static str,
    pub save_as_filter_all: &'static str,
}

pub fn labels(lang: &str) -> MenuLabels {
    match lang {
        "en" => en(),
        _ => de(),
    }
}

const fn de() -> MenuLabels {
    MenuLabels {
        file: "Datei",
        file_open: "Öffnen…",
        file_save: "Speichern",
        file_save_as: "Speichern unter…",
        file_recent: "Zuletzt geöffnet",
        file_recent_empty: "(keine Einträge)",
        file_rename: "Umbenennen…",
        file_close: "Schließen",
        file_quit: "Beenden",
        edit: "Bearbeiten",
        edit_undo: "Rückgängig",
        edit_redo: "Wiederholen",
        edit_find: "Suchen…",
        edit_settings: "Einstellungen…",
        view: "Ansicht",
        view_mode_view: "View-Mode",
        view_mode_edit: "Edit-Mode",
        view_mode_split: "Split-Mode",
        view_theme: "Theme",
        view_theme_light: "Hell",
        view_theme_dark: "Dunkel",
        view_rail_left: "Vault ein/aus",
        view_rail_right: "Inhaltsverzeichnis ein/aus",
        view_minimap: "Minimap ein/aus",
        help: "Hilfe",
        help_cheatsheet: "Cheat-Sheet",
        help_about: "Über folio",
        save_as_filter_markdown: "Markdown",
        save_as_filter_text: "Textdatei",
        save_as_filter_all: "Alle Dateien",
    }
}

const fn en() -> MenuLabels {
    MenuLabels {
        file: "File",
        file_open: "Open…",
        file_save: "Save",
        file_save_as: "Save As…",
        file_recent: "Recent",
        file_recent_empty: "(no entries)",
        file_rename: "Rename…",
        file_close: "Close",
        file_quit: "Quit",
        edit: "Edit",
        edit_undo: "Undo",
        edit_redo: "Redo",
        edit_find: "Find…",
        edit_settings: "Settings…",
        view: "View",
        view_mode_view: "View Mode",
        view_mode_edit: "Edit Mode",
        view_mode_split: "Split Mode",
        view_theme: "Theme",
        view_theme_light: "Light",
        view_theme_dark: "Dark",
        view_rail_left: "Toggle Vault",
        view_rail_right: "Toggle Outline",
        view_minimap: "Toggle Minimap",
        help: "Help",
        help_cheatsheet: "Cheat Sheet",
        help_about: "About Folio",
        save_as_filter_markdown: "Markdown",
        save_as_filter_text: "Text File",
        save_as_filter_all: "All Files",
    }
}
