//! Katalog-Gate: Parität, Platzhalter, Werttypen, Pflicht-Branches, @meta.

use super::*;
use crate::i18n::{CatalogRegistry, CatalogValue, RegistryError};
use serde::de::{self, MapAccess, Visitor};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::fmt;
use std::fs;

#[derive(Debug)]
struct OrderedStringMap(Vec<(String, String)>);

impl<'de> Deserialize<'de> for OrderedStringMap {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedStringMapVisitor;

        impl<'de> Visitor<'de> for OrderedStringMapVisitor {
            type Value = OrderedStringMap;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a flat JSON object with string values")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                let mut seen = BTreeSet::new();
                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom(format!("duplicate context key: {key}")));
                    }
                    entries.push((key, value));
                }
                Ok(OrderedStringMap(entries))
            }
        }

        deserializer.deserialize_map(OrderedStringMapVisitor)
    }
}

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
fn translation_context_matches_source_catalog() {
    let path = locales_dir().join("context").join("keys.json");
    assert!(
        path.is_file(),
        "translation context file missing: {}",
        path.display()
    );

    let text = fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("read translation context {}: {err}", path.display()));
    let OrderedStringMap(entries) = serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("invalid translation context {}: {err}", path.display()));

    for (key, value) in &entries {
        assert!(
            !value.trim().is_empty(),
            "translation context value is empty for key: {key}"
        );
    }

    let keys: Vec<_> = entries.iter().map(|(key, _)| key.clone()).collect();
    let mut sorted_keys = keys.clone();
    sorted_keys.sort();
    if let Some((index, (actual, expected))) = keys
        .iter()
        .zip(&sorted_keys)
        .enumerate()
        .find(|(_, (actual, expected))| actual != expected)
    {
        panic!(
            "translation context keys are not alphabetically sorted at position {index}: \
             found '{actual}', expected '{expected}'"
        );
    }

    let actual_keys: BTreeSet<_> = keys.into_iter().collect();
    let reg = load_prod();
    let expected_keys: BTreeSet<_> = reg
        .get("de")
        .expect("de catalog")
        .strings
        .keys()
        .cloned()
        .collect();
    let missing: Vec<_> = expected_keys.difference(&actual_keys).cloned().collect();
    let extra: Vec<_> = actual_keys.difference(&expected_keys).cloned().collect();
    let list = |keys: &[String]| {
        if keys.is_empty() {
            "  (none)".to_string()
        } else {
            keys.iter()
                .map(|key| format!("  - {key}"))
                .collect::<Vec<_>>()
                .join("\n")
        }
    };
    assert!(
        missing.is_empty() && extra.is_empty(),
        "translation context key set mismatch:\nmissing keys:\n{}\nextra keys:\n{}",
        list(&missing),
        list(&extra)
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
        assert!(!cat.meta.flag.is_empty(), "{tag} flag");
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
    assert_eq!(reg.get("de").unwrap().meta.flag, "🇩🇪");
    assert_eq!(reg.get("en").unwrap().meta.flag, "🇺🇸");
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
  "@meta": { "tag": "en", "name": "English", "locale": "en-US", "flag": "🇺🇸" },
  "search.status.hitsPart": { "one": "1 hit" }
}"#,
    );
    write_json(
        tmp.path(),
        "de.json",
        r#"{
  "@meta": { "tag": "de", "name": "Deutsch", "locale": "de-DE", "flag": "🇩🇪" },
  "search.status.hitsPart": { "one": "1 Treffer" }
}"#,
    );
    let err = generate_registry(tmp.path()).unwrap_err();
    assert!(
        matches!(err, RegistryError::MissingPluralBranch { .. }),
        "got {err:?}"
    );
}
