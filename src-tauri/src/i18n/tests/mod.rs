//! I1a TDD-Tests — Spezifikationsverträge. Erwartung Phase 1: rot (`todo!()`).

mod catalog_gate;
mod generator;
mod menu_labels;
mod migration;
mod plural_rules;
mod resolve;
mod translate;
// Fix-Paket I1a (F1–F14) — zusätzliche Tests, Phase-1-Suite unangetastet
mod fix_pack;

use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

pub(super) fn locales_dir() -> PathBuf {
    crate::i18n::production_locales_dir()
}

pub(super) fn fr_fixture() -> PathBuf {
    crate::i18n::fr_fixture_path()
}

/// Kopiert de.json, en.json und optional fr.json in ein Temp-Verzeichnis.
pub(super) fn copy_locales_to_temp(include_fr: bool) -> TempDir {
    let tmp = TempDir::new().expect("tempdir");
    let src = locales_dir();
    for name in ["de.json", "en.json"] {
        fs::copy(src.join(name), tmp.path().join(name)).unwrap_or_else(|e| {
            panic!("copy {name}: {e}");
        });
    }
    if include_fr {
        fs::copy(fr_fixture(), tmp.path().join("fr.json")).expect("copy fr fixture");
    }
    tmp
}

pub(super) fn write_json(dir: &Path, name: &str, body: &str) {
    fs::write(dir.join(name), body).expect("write json");
}

/// Minimal gültiges en-Meta + ein Key (für fail-closed-Gegenstücke).
pub(super) fn minimal_en_json() -> &'static str {
    r#"{
  "@meta": { "tag": "en", "name": "English", "locale": "en-US" },
  "menu.file": "File"
}"#
}

pub(super) fn minimal_de_json() -> &'static str {
    r#"{
  "@meta": { "tag": "de", "name": "Deutsch", "locale": "de-DE" },
  "menu.file": "Datei"
}"#
}

/// Erwartete menu.*-Keys (alphabetisch, wie in den Katalogdateien).
pub(super) fn expected_menu_keys() -> &'static [&'static str] {
    &[
        "menu.edit",
        "menu.edit.aiActions",
        "menu.edit.aiTranslate",
        "menu.edit.find",
        "menu.edit.redo",
        "menu.edit.searchVault",
        "menu.edit.settings",
        "menu.edit.undo",
        "menu.file",
        "menu.file.closeTab",
        "menu.file.export",
        "menu.file.open",
        "menu.file.quit",
        "menu.file.recent",
        "menu.file.recentEmpty",
        "menu.file.rename",
        "menu.file.save",
        "menu.file.saveAs",
        "menu.filter.all",
        "menu.filter.markdown",
        "menu.filter.text",
        "menu.help",
        "menu.help.about",
        "menu.help.cheatsheet",
        "menu.help.setupMdIcon",
        "menu.view",
        "menu.view.minimap",
        "menu.view.modeEdit",
        "menu.view.modeSplit",
        "menu.view.modeView",
        "menu.view.railLeft",
        "menu.view.railRight",
        "menu.view.theme",
        "menu.view.themeDark",
        "menu.view.themeLight",
    ]
}
