//! Beschriftungen für die Anwendungs-Menüleiste.
//!
//! Eine produktive Quelle: Boot setzt einmal [`set_boot_labels`].
//! [`labels`] ist parameterlos und liefert `&'static MenuLabels`.

use std::sync::OnceLock;

use crate::i18n::MenuLabels;

static BOOT_LABELS: OnceLock<MenuLabels> = OnceLock::new();

/// Einmaliger Boot-Set der Menü-Labels (aus `menu_labels_from_translator`).
pub fn set_boot_labels(labels: MenuLabels) {
    let _ = BOOT_LABELS.set(labels);
}

/// Aktive Menü-Labels (Boot-OnceLock).
///
/// Vor dem Boot: in Release `debug_assert` + leere Labels; in Tests Fallback
/// auf [`test_reference_en`] (nur damit Unit-Tests nicht panicken).
pub fn labels() -> &'static MenuLabels {
    if let Some(l) = BOOT_LABELS.get() {
        return l;
    }
    #[cfg(test)]
    {
        TEST_FALLBACK.get_or_init(test_reference_en)
    }
    #[cfg(not(test))]
    {
        debug_assert!(
            false,
            "menu::strings::labels() called before set_boot_labels"
        );
        EMPTY_LABELS.get_or_init(MenuLabels::empty)
    }
}

#[cfg(not(test))]
static EMPTY_LABELS: OnceLock<MenuLabels> = OnceLock::new();

#[cfg(test)]
static TEST_FALLBACK: OnceLock<MenuLabels> = OnceLock::new();

// ─── Test-Referenzdaten (Migrationsschutz) ───────────────────────────────────

/// Historische de-Hardcodes — nur Tests (Oracle für I1a menu_labels-Tests).
#[cfg(test)]
pub(crate) fn test_reference_de() -> MenuLabels {
    MenuLabels {
        file: "Datei".into(),
        file_open: "Öffnen…".into(),
        file_save: "Speichern".into(),
        file_save_as: "Speichern unter…".into(),
        file_recent: "Zuletzt geöffnet".into(),
        file_recent_empty: "(keine Einträge)".into(),
        file_rename: "Umbenennen…".into(),
        file_export: "Exportieren…".into(),
        file_close: "Tab schließen".into(),
        file_quit: "Beenden".into(),
        edit: "Bearbeiten".into(),
        edit_undo: "Rückgängig".into(),
        edit_redo: "Wiederholen".into(),
        edit_find: "Suchen…".into(),
        edit_search_vault: "Im Vault suchen…".into(),
        edit_ai_translate: "Mit KI übersetzen…".into(),
        edit_ai_actions: "KI-Aktionen…".into(),
        edit_settings: "Einstellungen…".into(),
        view: "Ansicht".into(),
        view_mode_view: "View-Mode".into(),
        view_mode_edit: "Edit-Mode".into(),
        view_mode_split: "Split-Mode".into(),
        view_git_diff: "Änderungen anzeigen".into(),
        view_theme: "Theme".into(),
        view_theme_light: "Hell".into(),
        view_theme_dark: "Dunkel".into(),
        view_rail_left: "Vault ein/aus".into(),
        view_rail_right: "Inhaltsverzeichnis ein/aus".into(),
        view_minimap: "Minimap ein/aus".into(),
        view_fullscreen: "Vollbild".into(),
        view_zen: "Zen-Modus".into(),
        help: "Hilfe".into(),
        help_cheatsheet: "Cheat-Sheet".into(),
        help_setup_md_icon: "Markdown-Icon-Integration einrichten…".into(),
        help_about: "Über folio".into(),
        save_as_filter_markdown: "Markdown".into(),
        save_as_filter_text: "Textdatei".into(),
        save_as_filter_all: "Alle Dateien".into(),
    }
}

/// Historische en-Hardcodes — nur Tests.
#[cfg(test)]
pub(crate) fn test_reference_en() -> MenuLabels {
    MenuLabels {
        file: "File".into(),
        file_open: "Open…".into(),
        file_save: "Save".into(),
        file_save_as: "Save As…".into(),
        file_recent: "Recent".into(),
        file_recent_empty: "(no entries)".into(),
        file_rename: "Rename…".into(),
        file_export: "Export…".into(),
        file_close: "Close Tab".into(),
        file_quit: "Quit".into(),
        edit: "Edit".into(),
        edit_undo: "Undo".into(),
        edit_redo: "Redo".into(),
        edit_find: "Find…".into(),
        edit_search_vault: "Search Vault…".into(),
        edit_ai_translate: "Translate with AI…".into(),
        edit_ai_actions: "AI Actions…".into(),
        edit_settings: "Settings…".into(),
        view: "View".into(),
        view_mode_view: "View Mode".into(),
        view_mode_edit: "Edit Mode".into(),
        view_mode_split: "Split Mode".into(),
        view_git_diff: "Show Changes".into(),
        view_theme: "Theme".into(),
        view_theme_light: "Light".into(),
        view_theme_dark: "Dark".into(),
        view_rail_left: "Toggle Vault".into(),
        view_rail_right: "Toggle Outline".into(),
        view_minimap: "Toggle Minimap".into(),
        view_fullscreen: "Full Screen".into(),
        view_zen: "Zen Mode".into(),
        help: "Help".into(),
        help_cheatsheet: "Cheat Sheet".into(),
        help_setup_md_icon: "Set up Markdown icon integration…".into(),
        help_about: "About Folio".into(),
        save_as_filter_markdown: "Markdown".into(),
        save_as_filter_text: "Text File".into(),
        save_as_filter_all: "All Files".into(),
    }
}
