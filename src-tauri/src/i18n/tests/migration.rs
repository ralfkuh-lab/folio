//! Settings-Sprach-Migration — alle Spec-Fälle + Idempotenz.

use crate::i18n::migrate_settings_language;
use std::fs;
use tempfile::TempDir;

fn read(path: &std::path::Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

#[test]
fn migrate_object_without_language_injects_de_and_persists() {
    let tmp = TempDir::new().unwrap();
    let cfg = tmp.path();
    fs::write(cfg.join("settings.json"), r#"{"logLevel":"info"}"#).unwrap();

    let r = migrate_settings_language(cfg);
    assert_eq!(r.language, "de");
    assert!(r.persisted, "should write language:de");
    let body = read(&cfg.join("settings.json"));
    assert!(
        body.contains(r#""language":"de""#) || body.contains(r#""language": "de""#),
        "body={body}"
    );
    // anderes Feld bleibt
    assert!(
        body.contains("logLevel") || body.contains("info"),
        "body={body}"
    );
}

#[test]
fn migrate_object_with_language_extracts_and_survives_bad_other_field() {
    let tmp = TempDir::new().unwrap();
    let cfg = tmp.path();
    // language de + ungültiges logLevel (Whole-Object-Recovery darf language nicht droppen)
    fs::write(
        cfg.join("settings.json"),
        r#"{"language":"de","logLevel":"silly"}"#,
    )
    .unwrap();
    let before = read(&cfg.join("settings.json"));

    let r = migrate_settings_language(cfg);
    assert_eq!(r.language, "de");
    // kein Rewrite nötig wenn language bereits gesetzt
    let after = read(&cfg.join("settings.json"));
    assert_eq!(
        before, after,
        "file must stay byte-identical when language present"
    );
    assert!(!r.persisted);
}

#[test]
fn migrate_object_with_en_language_kept() {
    let tmp = TempDir::new().unwrap();
    let cfg = tmp.path();
    fs::write(cfg.join("settings.json"), r#"{"language":"en"}"#).unwrap();
    let r = migrate_settings_language(cfg);
    assert_eq!(r.language, "en");
    assert!(!r.persisted);
}

#[test]
fn migrate_corrupt_file_yields_de_without_overwrite() {
    let tmp = TempDir::new().unwrap();
    let cfg = tmp.path();
    let path = cfg.join("settings.json");
    fs::write(&path, "NOT JSON {{{").unwrap();
    let before = read(&path);

    let r = migrate_settings_language(cfg);
    assert_eq!(r.language, "de");
    assert!(!r.persisted);
    assert_eq!(read(&path), before, "corrupt file must not be overwritten");
}

#[test]
fn migrate_non_object_json_yields_de_without_overwrite() {
    let tmp = TempDir::new().unwrap();
    let cfg = tmp.path();
    let path = cfg.join("settings.json");
    fs::write(&path, r#"[1,2,3]"#).unwrap();
    let before = read(&path);

    let r = migrate_settings_language(cfg);
    assert_eq!(r.language, "de");
    assert!(!r.persisted);
    assert_eq!(read(&path), before);
}

#[test]
fn migrate_non_string_language_yields_de_without_overwrite() {
    let tmp = TempDir::new().unwrap();
    let cfg = tmp.path();
    let path = cfg.join("settings.json");
    fs::write(&path, r#"{"language":null}"#).unwrap();
    let before = read(&path);

    let r = migrate_settings_language(cfg);
    assert_eq!(r.language, "de");
    assert!(!r.persisted);
    assert_eq!(read(&path), before);

    fs::write(&path, r#"{"language":42}"#).unwrap();
    let before = read(&path);
    let r = migrate_settings_language(cfg);
    assert_eq!(r.language, "de");
    assert!(!r.persisted);
    assert_eq!(read(&path), before);
}

#[test]
fn migrate_missing_settings_empty_config_dir_is_system() {
    let tmp = TempDir::new().unwrap();
    // leeres Config-Verzeichnis, keine settings.json, keine Artefakte
    let r = migrate_settings_language(tmp.path());
    assert_eq!(r.language, "system");
    assert!(!r.persisted);
    assert!(!tmp.path().join("settings.json").exists());
}

#[test]
fn migrate_missing_settings_with_theme_json_pins_de() {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("theme.json"), r#"{"mode":"dark"}"#).unwrap();
    let r = migrate_settings_language(tmp.path());
    assert_eq!(r.language, "de");
    // Spec: fehlende Datei + Artefakt → de pinnen — Persistenz: injizieren?
    // Fall 5: fehlende Datei → system nur bei Neuinstallation; sonst wie Fall 1 ("de" pinnen).
    // Fall 1 persistiert. Also sollte settings.json mit de geschrieben werden.
    assert!(
        r.persisted || tmp.path().join("settings.json").exists(),
        "expected de pin to create settings.json, persisted={}",
        r.persisted
    );
}

#[test]
fn migrate_missing_settings_with_ai_json_pins_de() {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("ai.json"), r#"{}"#).unwrap();
    let r = migrate_settings_language(tmp.path());
    assert_eq!(r.language, "de");
}

#[test]
fn migrate_missing_settings_with_workspace_json_pins_de() {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("workspace.json"), r#"{}"#).unwrap();
    let r = migrate_settings_language(tmp.path());
    assert_eq!(r.language, "de");
}

#[test]
fn migrate_missing_settings_with_themes_dir_pins_de() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir(tmp.path().join("themes")).unwrap();
    let r = migrate_settings_language(tmp.path());
    assert_eq!(r.language, "de");
}

#[test]
fn migrate_missing_settings_with_prompts_dir_pins_de() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir(tmp.path().join("prompts")).unwrap();
    let r = migrate_settings_language(tmp.path());
    assert_eq!(r.language, "de");
}

#[test]
fn migrate_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let cfg = tmp.path();
    fs::write(cfg.join("settings.json"), r#"{"themeFavorites":[]}"#).unwrap();

    let r1 = migrate_settings_language(cfg);
    assert_eq!(r1.language, "de");
    let mid = read(&cfg.join("settings.json"));

    let r2 = migrate_settings_language(cfg);
    assert_eq!(r2.language, "de");
    assert!(!r2.persisted, "second load must not rewrite");
    let end = read(&cfg.join("settings.json"));
    assert_eq!(mid, end);
}

#[test]
fn migrate_unknown_stored_tag_kept_as_is() {
    // unbekannter Tag bleibt gespeichert (Resolver fällt später auf en)
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("settings.json"), r#"{"language":"xx"}"#).unwrap();
    let r = migrate_settings_language(tmp.path());
    assert_eq!(r.language, "xx");
    assert!(!r.persisted);
}
