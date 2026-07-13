//! Generator fail-closed-Matrix, Determinismus, fr-Erweiterbarkeit.

use super::*;
use crate::i18n::{generate_registry, CatalogRegistry, RegistryError, Translator};
use std::fs;
use tempfile::TempDir;

#[test]
fn generate_registry_rejects_invalid_json() {
    let tmp = TempDir::new().unwrap();
    write_json(tmp.path(), "en.json", "{ not json");
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::InvalidJson { .. }) || matches!(err, RegistryError::Other(_)),
        "expected InvalidJson, got {err:?}"
    );
}

#[test]
fn generate_registry_rejects_meta_tag_mismatch() {
    let tmp = TempDir::new().unwrap();
    write_json(
        tmp.path(),
        "en.json",
        r#"{ "@meta": { "tag": "de", "name": "English", "locale": "en-US" }, "menu.file": "File" }"#,
    );
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::MetaTagMismatch { .. }),
        "expected MetaTagMismatch, got {err:?}"
    );
}

#[test]
fn generate_registry_rejects_missing_en() {
    let tmp = TempDir::new().unwrap();
    write_json(tmp.path(), "de.json", minimal_de_json());
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::MissingEn),
        "expected MissingEn, got {err:?}"
    );
}

#[test]
fn generate_registry_rejects_duplicate_keys() {
    // Duplikate sind in strengem JSON-Parser oft unsichtbar — der Generator
    // muss order-/duplicate-erhaltend parsen und den zweiten Key melden.
    let tmp = TempDir::new().unwrap();
    write_json(
        tmp.path(),
        "en.json",
        r#"{
  "@meta": { "tag": "en", "name": "English", "locale": "en-US" },
  "menu.file": "File",
  "menu.file": "Duplicate"
}"#,
    );
    write_json(tmp.path(), "de.json", minimal_de_json());
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::DuplicateKey { .. }),
        "expected DuplicateKey, got {err:?}"
    );
}

#[test]
fn generate_registry_rejects_unsorted_keys() {
    let tmp = TempDir::new().unwrap();
    write_json(
        tmp.path(),
        "en.json",
        r#"{
  "@meta": { "tag": "en", "name": "English", "locale": "en-US" },
  "menu.file.save": "Save",
  "menu.file": "File"
}"#,
    );
    write_json(
        tmp.path(),
        "de.json",
        r#"{
  "@meta": { "tag": "de", "name": "Deutsch", "locale": "de-DE" },
  "menu.file": "Datei",
  "menu.file.save": "Speichern"
}"#,
    );
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::UnsortedKeys { .. }),
        "expected UnsortedKeys, got {err:?}"
    );
}

#[test]
fn generate_registry_rejects_unknown_plural_tag() {
    // Kunst-Tag ohne plural_rules-Eintrag.
    let tmp = TempDir::new().unwrap();
    write_json(tmp.path(), "en.json", minimal_en_json());
    write_json(
        tmp.path(),
        "xx.json",
        r#"{
  "@meta": { "tag": "xx", "name": "X", "locale": "xx" },
  "menu.file": "X"
}"#,
    );
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::UnknownPluralTag { .. }),
        "expected UnknownPluralTag, got {err:?}"
    );
}

#[test]
fn generate_registry_rejects_at_format_object() {
    let tmp = TempDir::new().unwrap();
    write_json(
        tmp.path(),
        "en.json",
        r#"{
  "@meta": { "tag": "en", "name": "English", "locale": "en-US" },
  "menu.file": { "@format": "icu", "value": "File" }
}"#,
    );
    write_json(tmp.path(), "de.json", minimal_de_json());
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::UnsupportedFormat { .. }),
        "expected UnsupportedFormat, got {err:?}"
    );
}

#[test]
fn generate_registry_rejects_incomplete_meta() {
    let tmp = TempDir::new().unwrap();
    write_json(
        tmp.path(),
        "en.json",
        r#"{ "@meta": { "tag": "en" }, "menu.file": "File" }"#,
    );
    write_json(tmp.path(), "de.json", minimal_de_json());
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::IncompleteMeta { .. }),
        "expected IncompleteMeta, got {err:?}"
    );
}

#[test]
fn generate_registry_is_deterministic() {
    let tmp = copy_locales_to_temp(false);
    let a = generate_registry(tmp.path()).expect("generate a");
    let b = generate_registry(tmp.path()).expect("generate b");
    assert_eq!(a.tags, b.tags);
    assert_eq!(a.rust_source, b.rust_source);
    assert_eq!(a.metas.len(), b.metas.len());
}

#[test]
fn generate_registry_production_locales_includes_de_en_only() {
    let gen = generate_registry(&locales_dir()).expect("production locales");
    assert!(gen.tags.contains(&"de".into()));
    assert!(gen.tags.contains(&"en".into()));
    assert!(
        !gen.tags.contains(&"fr".into()),
        "fr fixture must not appear in production locales/"
    );
    // deterministische Sortierung
    let mut sorted = gen.tags.clone();
    sorted.sort();
    assert_eq!(gen.tags, sorted);
}

#[test]
fn extensibility_temp_dir_with_fr_fixture() {
    // Dritter Katalog ohne Code-Änderung: de+en+fr in Temp → Generator + Translator.
    let tmp = copy_locales_to_temp(true);
    let gen = generate_registry(tmp.path()).expect("generate with fr");
    assert!(gen.tags.contains(&"fr".into()), "tags={:?}", gen.tags);
    assert_eq!(gen.tags.iter().filter(|t| *t == "fr").count(), 1);

    let registry = CatalogRegistry::load_from_dir(tmp.path()).expect("load");
    assert!(registry.get("fr").is_some());

    let tr = Translator::new(
        registry,
        crate::i18n::ResolvedLanguage {
            catalog_tag: "fr".into(),
            format_locale: "fr-FR".into(),
        },
    );
    let file = tr.t("menu.file");
    assert_eq!(file, "Fichier");

    // Pluralfall fr (one/other)
    let one = tr
        .t_plural("search.status.hitsPart", 1, &[])
        .expect("plural 1");
    assert!(one.contains('1') || one.contains("résultat"), "got {one}");
    let many = tr
        .t_plural("search.status.hitsPart", 5, &[])
        .expect("plural 5");
    assert!(
        many.contains('5') || many.contains("résultats"),
        "got {many}"
    );

    // Fallback: fehlender Key → en → key
    let missing = tr.t("menu.nonexistent.key");
    // en hat den Key auch nicht → Key selbst
    assert_eq!(missing, "menu.nonexistent.key");
}

#[test]
fn generate_registry_duplicate_case_insensitive_tags() {
    let tmp = TempDir::new().unwrap();
    write_json(tmp.path(), "en.json", minimal_en_json());
    // Dateiname EN.json würde auf case-insensitive FS kollidieren; simuliere
    // doppelten meta.tag mit anderem Dateinamen, der ungültig wäre.
    // Stattdessen: zwei Dateien de.json mit gleichem tag in meta — unmöglich
    // über Dateinamen. Prüfe case-insensitiv: Tag "EN" in en2 — use fr name
    // with tag En
    write_json(
        tmp.path(),
        "fr.json",
        r#"{
  "@meta": { "tag": "EN", "name": "Dup", "locale": "en-GB" },
  "menu.file": "File2"
}"#,
    );
    let err = generate_registry(tmp.path()).unwrap_err();
    // MetaTagMismatch (EN != fr) oder DuplicateTag
    assert!(
        matches!(
            err,
            RegistryError::MetaTagMismatch { .. } | RegistryError::DuplicateTag { .. }
        ),
        "got {err:?}"
    );
}

/// Hilfs-Assert: Produktionskataloge existieren (Fixture-Sanity, grün ohne Impl).
#[test]
fn production_locale_files_exist() {
    assert!(locales_dir().join("de.json").is_file());
    assert!(locales_dir().join("en.json").is_file());
    assert!(fr_fixture().is_file());
    // fr liegt NICHT unter locales/
    assert!(!locales_dir().join("fr.json").exists());
    let _ = fs::metadata(locales_dir().join("de.json"));
}
