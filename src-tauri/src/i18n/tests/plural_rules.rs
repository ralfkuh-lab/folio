//! plural_rules: 11 Batch-Sprachen mit Kategorie-Stichproben.

use super::write_json;
use crate::i18n::{plural_rules, required_plural_categories, CatalogRegistry, PluralCategory};
use tempfile::TempDir;

fn cat(tag: &str, n: u64) -> PluralCategory {
    plural_rules(tag, n).unwrap_or_else(|| panic!("no rules for {tag}"))
}

#[test]
fn plural_rules_de_en_one_other() {
    for tag in ["de", "en"] {
        assert_eq!(cat(tag, 1), PluralCategory::One);
        assert_eq!(cat(tag, 0), PluralCategory::Other);
        assert_eq!(cat(tag, 2), PluralCategory::Other);
        assert_eq!(cat(tag, 21), PluralCategory::Other); // en: 21 is other (not one)
    }
}

#[test]
fn plural_rules_romance_sample() {
    // es, fr, it, pt: one/other (fr: 0 often one — CLDR fr: 0,1 → one)
    for tag in ["es", "it", "pt"] {
        assert_eq!(cat(tag, 1), PluralCategory::One, "{tag}");
        assert_eq!(cat(tag, 2), PluralCategory::Other, "{tag}");
    }
    // French: 0 and 1 are "one" in CLDR cardinal
    assert_eq!(cat("fr", 0), PluralCategory::One);
    assert_eq!(cat("fr", 1), PluralCategory::One);
    assert_eq!(cat("fr", 2), PluralCategory::Other);
}

#[test]
fn plural_rules_ru_has_few_and_many() {
    // Russian: 1 one, 2-4 few, 5-20 many, 21 one, 22 few, …
    assert_eq!(cat("ru", 1), PluralCategory::One);
    assert_eq!(cat("ru", 2), PluralCategory::Few);
    assert_eq!(cat("ru", 3), PluralCategory::Few);
    assert_eq!(cat("ru", 4), PluralCategory::Few);
    assert_eq!(cat("ru", 5), PluralCategory::Many);
    assert_eq!(cat("ru", 11), PluralCategory::Many);
    assert_eq!(cat("ru", 21), PluralCategory::One);
    assert_eq!(cat("ru", 22), PluralCategory::Few);
}

#[test]
fn plural_rules_pl_has_few_and_many() {
    // Polish: 1 one; 2-4 few (except 12-14); many otherwise
    assert_eq!(cat("pl", 1), PluralCategory::One);
    assert_eq!(cat("pl", 2), PluralCategory::Few);
    assert_eq!(cat("pl", 4), PluralCategory::Few);
    assert_eq!(cat("pl", 5), PluralCategory::Many);
    assert_eq!(cat("pl", 12), PluralCategory::Many);
    assert_eq!(cat("pl", 22), PluralCategory::Few);
}

#[test]
fn plural_rules_ja_zh_ko_only_other() {
    for tag in ["ja", "zh", "ko"] {
        for n in [0u64, 1, 2, 5, 100] {
            assert_eq!(cat(tag, n), PluralCategory::Other, "{tag} n={n}");
        }
    }
}

#[test]
fn plural_rules_all_eleven_tags_defined() {
    for tag in [
        "de", "en", "es", "fr", "it", "pt", "ru", "pl", "ja", "zh", "ko",
    ] {
        assert!(
            plural_rules(tag, 1).is_some(),
            "missing plural_rules for {tag}"
        );
    }
}

#[test]
fn plural_rules_unknown_tag_returns_none() {
    assert_eq!(plural_rules("xx", 1), None);
    assert_eq!(plural_rules("zz-ZZ", 2), None);
}

#[test]
fn required_plural_categories_normalize_primary_subtag() {
    assert_eq!(required_plural_categories("zh-Hans"), vec!["other"]);
    assert_eq!(
        required_plural_categories("pt-BR"),
        vec!["one", "many", "other"]
    );
    assert_eq!(
        required_plural_categories("ru-RU"),
        vec!["one", "few", "many", "other"]
    );
    assert_eq!(
        required_plural_categories("PT-br"),
        vec!["one", "many", "other"]
    );
    assert_eq!(
        required_plural_categories("pt_BR"),
        vec!["one", "many", "other"]
    );
}

#[test]
fn catalog_validation_accepts_supported_language_subtags() {
    let tmp = TempDir::new().unwrap();
    write_json(
        tmp.path(),
        "en.json",
        r#"{
  "@meta": { "tag": "en", "name": "English", "locale": "en-US", "flag": "🇺🇸" },
  "sample.items": { "one": "{count} item", "other": "{count} items" }
}"#,
    );
    write_json(
        tmp.path(),
        "pt-BR.json",
        r#"{
  "@meta": { "tag": "pt-BR", "name": "Português (Brasil)", "locale": "pt-BR", "flag": "🇧🇷" },
  "sample.items": {
    "many": "{count} itens",
    "one": "{count} item",
    "other": "{count} itens"
  }
}"#,
    );
    write_json(
        tmp.path(),
        "zh-Hans.json",
        r#"{
  "@meta": { "tag": "zh-Hans", "name": "简体中文", "locale": "zh-Hans", "flag": "🇨🇳" },
  "sample.items": { "other": "{count} 项" }
}"#,
    );

    let registry = CatalogRegistry::load_from_dir(tmp.path())
        .expect("supported primary subtags must pass catalog validation");
    assert!(registry.get("pt-BR").is_some());
    assert!(registry.get("zh-Hans").is_some());
    assert_eq!(
        required_plural_categories("pt-BR"),
        vec!["one", "many", "other"]
    );
    assert_eq!(required_plural_categories("zh-Hans"), vec!["other"]);
}
