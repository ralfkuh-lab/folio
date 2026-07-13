//! Resolver: FOLIO_LANG, system/OS, Subtag, Fallback — ENV injizierbar.

use super::*;
use crate::i18n::{resolve_language, CatalogRegistry, ResolvedLanguage};

fn reg() -> CatalogRegistry {
    CatalogRegistry::load_from_dir(&locales_dir()).expect("load")
}

#[test]
fn resolve_explicit_setting_tag() {
    let r = resolve_language("de", None, None, &reg());
    assert_eq!(
        r,
        ResolvedLanguage {
            catalog_tag: "de".into(),
            format_locale: "de-DE".into(),
        }
    );
    let r = resolve_language("en", None, None, &reg());
    assert_eq!(r.catalog_tag, "en");
    assert_eq!(r.format_locale, "en-US");
}

#[test]
fn resolve_folio_lang_exact_overrides_setting() {
    // FOLIO_LANG=en schlägt Setting de
    let r = resolve_language("de", Some("en"), Some("de-DE"), &reg());
    assert_eq!(r.catalog_tag, "en");
    assert_eq!(r.format_locale, "en-US");
}

#[test]
fn resolve_folio_lang_subtag_keeps_full_format_locale() {
    // de-CH → Katalog de, formatLocale bleibt de-CH (Override-Wert)
    let r = resolve_language("en", Some("de-CH"), None, &reg());
    assert_eq!(r.catalog_tag, "de");
    assert_eq!(r.format_locale, "de-CH");
}

#[test]
fn resolve_invalid_folio_lang_falls_through() {
    // ungültig → warn + normaler Setting-Pfad
    let r = resolve_language("de", Some("not-a-lang-!!!"), None, &reg());
    assert_eq!(r.catalog_tag, "de");
    assert_eq!(r.format_locale, "de-DE");
}

#[test]
fn resolve_system_matches_os_exact_then_subtag() {
    let r = resolve_language("system", None, Some("de-CH"), &reg());
    assert_eq!(r.catalog_tag, "de");
    assert_eq!(r.format_locale, "de-CH");

    let r = resolve_language("system", None, Some("en-GB"), &reg());
    assert_eq!(r.catalog_tag, "en");
    assert_eq!(r.format_locale, "en-GB");
}

#[test]
fn resolve_system_unknown_os_falls_back_to_en() {
    let r = resolve_language("system", None, Some("sv-SE"), &reg());
    assert_eq!(r.catalog_tag, "en");
    assert_eq!(r.format_locale, "en-US");
}

#[test]
fn resolve_system_no_os_falls_back_to_en() {
    let r = resolve_language("system", None, None, &reg());
    assert_eq!(r.catalog_tag, "en");
    assert_eq!(r.format_locale, "en-US");
}

#[test]
fn resolve_unknown_stored_tag_falls_back_to_en_catalog() {
    // gespeicherter unbekannter Tag → catalog en, formatLocale en.@meta.locale
    // (Wert bleibt in settings erhalten — Resolver liefert nur Anzeige-Auflösung)
    let r = resolve_language("xx", None, None, &reg());
    assert_eq!(r.catalog_tag, "en");
    assert_eq!(r.format_locale, "en-US");
}

#[test]
fn resolve_folio_lang_wins_over_system_setting() {
    let r = resolve_language("system", Some("de"), Some("en-US"), &reg());
    assert_eq!(r.catalog_tag, "de");
    assert_eq!(r.format_locale, "de-DE");
}
