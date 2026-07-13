//! Katalog-Gate: Parität, Platzhalter, Werttypen, Pflicht-Branches, @meta.

use super::*;
use crate::i18n::{CatalogRegistry, CatalogValue, RegistryError};
use std::collections::BTreeSet;

fn load_prod() -> CatalogRegistry {
    CatalogRegistry::load_from_dir(&locales_dir()).expect("load production locales")
}

#[test]
fn catalog_key_sets_match_across_languages() {
    let reg = load_prod();
    let de = reg.get("de").expect("de");
    let en = reg.get("en").expect("en");
    let de_keys: BTreeSet<_> = de.strings.keys().cloned().collect();
    let en_keys: BTreeSet<_> = en.strings.keys().cloned().collect();
    assert_eq!(
        de_keys,
        en_keys,
        "key set mismatch de vs en: only_de={:?} only_en={:?}",
        de_keys.difference(&en_keys).collect::<Vec<_>>(),
        en_keys.difference(&de_keys).collect::<Vec<_>>()
    );
}

#[test]
fn catalog_contains_full_menu_namespace() {
    let reg = load_prod();
    let en = reg.get("en").expect("en");
    for key in expected_menu_keys() {
        assert!(
            en.strings.contains_key(*key),
            "missing menu key in en: {key}"
        );
    }
}

#[test]
fn catalog_meta_complete() {
    let reg = load_prod();
    for tag in ["de", "en"] {
        let cat = reg.get(tag).expect(tag);
        assert_eq!(cat.meta.tag, tag);
        assert!(!cat.meta.name.is_empty(), "{tag} name");
        assert!(
            cat.meta.locale.contains('-') || cat.meta.locale.len() >= 2,
            "{tag} locale={}",
            cat.meta.locale
        );
    }
    assert_eq!(reg.get("de").unwrap().meta.name, "Deutsch");
    assert_eq!(reg.get("en").unwrap().meta.name, "English");
    assert_eq!(reg.get("de").unwrap().meta.locale, "de-DE");
    assert_eq!(reg.get("en").unwrap().meta.locale, "en-US");
}

#[test]
fn catalog_value_type_parity() {
    let reg = load_prod();
    let de = reg.get("de").unwrap();
    let en = reg.get("en").unwrap();
    for key in de.strings.keys() {
        let de_v = &de.strings[key];
        let en_v = en.strings.get(key).expect(key);
        let de_is_plural = matches!(de_v, CatalogValue::Plural(_));
        let en_is_plural = matches!(en_v, CatalogValue::Plural(_));
        assert_eq!(
            de_is_plural, en_is_plural,
            "value type mismatch for {key}: de_plural={de_is_plural} en_plural={en_is_plural}"
        );
    }
}

#[test]
fn catalog_placeholder_parity_including_plural_branches() {
    let reg = load_prod();
    let de = reg.get("de").unwrap();
    let en = reg.get("en").unwrap();

    fn placeholders(s: &str) -> BTreeSet<String> {
        let mut set = BTreeSet::new();
        let mut rest = s;
        while let Some(start) = rest.find('{') {
            let after = &rest[start + 1..];
            if let Some(end) = after.find('}') {
                let name = &after[..end];
                if !name.is_empty() && !name.contains('{') {
                    set.insert(name.to_string());
                }
                rest = &after[end + 1..];
            } else {
                break;
            }
        }
        set
    }

    for key in de.strings.keys() {
        match (&de.strings[key], &en.strings[key]) {
            (CatalogValue::Text(a), CatalogValue::Text(b)) => {
                assert_eq!(
                    placeholders(a),
                    placeholders(b),
                    "placeholder mismatch on string key {key}"
                );
            }
            (CatalogValue::Plural(pa), CatalogValue::Plural(pb)) => {
                let cats_a: BTreeSet<_> = pa.keys().cloned().collect();
                let cats_b: BTreeSet<_> = pb.keys().cloned().collect();
                assert_eq!(cats_a, cats_b, "plural categories mismatch on {key}");
                for cat in &cats_a {
                    assert_eq!(
                        placeholders(&pa[cat]),
                        placeholders(&pb[cat]),
                        "placeholder mismatch on {key}/{cat}"
                    );
                }
            }
            _ => panic!("type parity should already hold for {key}"),
        }
    }
}

#[test]
fn catalog_plural_requires_other_and_reachable_categories() {
    let reg = load_prod();
    for tag in ["de", "en"] {
        let cat = reg.get(tag).unwrap();
        for (key, val) in &cat.strings {
            if let CatalogValue::Plural(branches) = val {
                assert!(branches.contains_key("other"), "{tag}/{key} missing other");
                // de/en: erreichbar one + other
                assert!(
                    branches.contains_key("one"),
                    "{tag}/{key} missing one (reachable for de/en)"
                );
            }
        }
    }
}

#[test]
fn generate_registry_rejects_missing_other_branch() {
    use crate::i18n::generate_registry;
    let tmp = tempfile::TempDir::new().unwrap();
    write_json(
        tmp.path(),
        "en.json",
        r#"{
  "@meta": { "tag": "en", "name": "English", "locale": "en-US" },
  "search.status.hitsPart": { "one": "1 hit" }
}"#,
    );
    write_json(
        tmp.path(),
        "de.json",
        r#"{
  "@meta": { "tag": "de", "name": "Deutsch", "locale": "de-DE" },
  "search.status.hitsPart": { "one": "1 Treffer" }
}"#,
    );
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::MissingPluralBranch { .. }),
        "got {err:?}"
    );
}
