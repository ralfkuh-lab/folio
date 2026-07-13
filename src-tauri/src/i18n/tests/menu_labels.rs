//! MenuLabels aus Translator vs. heutige de()/en()-Hardcodes (Migrationsschutz).

use super::*;
use crate::i18n::{menu_labels_from_translator, CatalogRegistry, ResolvedLanguage, Translator};
use crate::menu::strings as legacy;

fn tr(tag: &str) -> Translator {
    let registry = CatalogRegistry::load_from_dir(&locales_dir()).expect("load");
    let locale = registry.get(tag).unwrap().meta.locale.clone();
    Translator::new(
        registry,
        ResolvedLanguage {
            catalog_tag: tag.into(),
            format_locale: locale,
        },
    )
}

#[test]
fn menu_labels_de_matches_legacy_hardcodes() {
    let built = menu_labels_from_translator(&tr("de"));
    let legacy = legacy::test_reference_de();

    assert_eq!(built.file, legacy.file);
    assert_eq!(built.file_open, legacy.file_open);
    assert_eq!(built.file_save, legacy.file_save);
    assert_eq!(built.file_save_as, legacy.file_save_as);
    assert_eq!(built.file_recent, legacy.file_recent);
    assert_eq!(built.file_recent_empty, legacy.file_recent_empty);
    assert_eq!(built.file_rename, legacy.file_rename);
    assert_eq!(built.file_export, legacy.file_export);
    assert_eq!(built.file_close, legacy.file_close);
    assert_eq!(built.file_quit, legacy.file_quit);
    assert_eq!(built.edit, legacy.edit);
    assert_eq!(built.edit_undo, legacy.edit_undo);
    assert_eq!(built.edit_redo, legacy.edit_redo);
    assert_eq!(built.edit_find, legacy.edit_find);
    assert_eq!(built.edit_search_vault, legacy.edit_search_vault);
    assert_eq!(built.edit_ai_translate, legacy.edit_ai_translate);
    assert_eq!(built.edit_ai_actions, legacy.edit_ai_actions);
    assert_eq!(built.edit_settings, legacy.edit_settings);
    assert_eq!(built.view, legacy.view);
    assert_eq!(built.view_mode_view, legacy.view_mode_view);
    assert_eq!(built.view_mode_edit, legacy.view_mode_edit);
    assert_eq!(built.view_mode_split, legacy.view_mode_split);
    assert_eq!(built.view_theme, legacy.view_theme);
    assert_eq!(built.view_theme_light, legacy.view_theme_light);
    assert_eq!(built.view_theme_dark, legacy.view_theme_dark);
    assert_eq!(built.view_rail_left, legacy.view_rail_left);
    assert_eq!(built.view_rail_right, legacy.view_rail_right);
    assert_eq!(built.view_minimap, legacy.view_minimap);
    assert_eq!(built.help, legacy.help);
    assert_eq!(built.help_cheatsheet, legacy.help_cheatsheet);
    #[cfg(target_os = "linux")]
    assert_eq!(built.help_setup_md_icon, legacy.help_setup_md_icon);
    assert_eq!(built.help_about, legacy.help_about);
    assert_eq!(
        built.save_as_filter_markdown,
        legacy.save_as_filter_markdown
    );
    assert_eq!(built.save_as_filter_text, legacy.save_as_filter_text);
    assert_eq!(built.save_as_filter_all, legacy.save_as_filter_all);
}

#[test]
fn menu_labels_en_matches_legacy_hardcodes() {
    let built = menu_labels_from_translator(&tr("en"));
    let legacy = legacy::test_reference_en();

    assert_eq!(built.file, legacy.file);
    assert_eq!(built.file_open, legacy.file_open);
    assert_eq!(built.file_save, legacy.file_save);
    assert_eq!(built.file_save_as, legacy.file_save_as);
    assert_eq!(built.file_recent, legacy.file_recent);
    assert_eq!(built.file_recent_empty, legacy.file_recent_empty);
    assert_eq!(built.file_rename, legacy.file_rename);
    assert_eq!(built.file_export, legacy.file_export);
    assert_eq!(built.file_close, legacy.file_close);
    assert_eq!(built.file_quit, legacy.file_quit);
    assert_eq!(built.edit, legacy.edit);
    assert_eq!(built.edit_undo, legacy.edit_undo);
    assert_eq!(built.edit_redo, legacy.edit_redo);
    assert_eq!(built.edit_find, legacy.edit_find);
    assert_eq!(built.edit_search_vault, legacy.edit_search_vault);
    assert_eq!(built.edit_ai_translate, legacy.edit_ai_translate);
    assert_eq!(built.edit_ai_actions, legacy.edit_ai_actions);
    assert_eq!(built.edit_settings, legacy.edit_settings);
    assert_eq!(built.view, legacy.view);
    assert_eq!(built.view_mode_view, legacy.view_mode_view);
    assert_eq!(built.view_mode_edit, legacy.view_mode_edit);
    assert_eq!(built.view_mode_split, legacy.view_mode_split);
    assert_eq!(built.view_theme, legacy.view_theme);
    assert_eq!(built.view_theme_light, legacy.view_theme_light);
    assert_eq!(built.view_theme_dark, legacy.view_theme_dark);
    assert_eq!(built.view_rail_left, legacy.view_rail_left);
    assert_eq!(built.view_rail_right, legacy.view_rail_right);
    assert_eq!(built.view_minimap, legacy.view_minimap);
    assert_eq!(built.help, legacy.help);
    assert_eq!(built.help_cheatsheet, legacy.help_cheatsheet);
    #[cfg(target_os = "linux")]
    assert_eq!(built.help_setup_md_icon, legacy.help_setup_md_icon);
    assert_eq!(built.help_about, legacy.help_about);
    assert_eq!(
        built.save_as_filter_markdown,
        legacy.save_as_filter_markdown
    );
    assert_eq!(built.save_as_filter_text, legacy.save_as_filter_text);
    assert_eq!(built.save_as_filter_all, legacy.save_as_filter_all);
}

#[test]
fn menu_labels_fr_fixture_builds_via_fallback_chain() {
    // fr-Katalog laden (Temp mit de+en+fr) — Bau darf nicht fehlschlagen.
    let tmp = copy_locales_to_temp(true);
    let registry = CatalogRegistry::load_from_dir(tmp.path()).expect("load fr set");
    let tr = Translator::new(
        registry,
        ResolvedLanguage {
            catalog_tag: "fr".into(),
            format_locale: "fr-FR".into(),
        },
    );
    let labels = menu_labels_from_translator(&tr);
    assert_eq!(labels.file, "Fichier");
    assert!(!labels.file_open.is_empty());
    // Fehlender optionaler Key würde en/fallback nutzen — setup icon muss gesetzt sein
    assert!(!labels.help_setup_md_icon.is_empty());
}
