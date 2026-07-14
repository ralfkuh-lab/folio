//! Tauri-Commands für i18n-Katalog und Frontend-Ready-Handshake.

use crate::i18n::{self, CatalogValue, Translator};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    pub tag: String,
    pub name: String,
    pub flag: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct I18nCatalogResponse {
    /// Aktiver Katalog-Tag (z. B. `"de"`).
    pub tag: String,
    /// Formatierungs-Locale (BCP-47, z. B. `"de-DE"` oder OS-Tag).
    pub locale: String,
    pub languages: Vec<LanguageInfo>,
    /// Gemergte Strings: aktive Sprache über en (Plural-Objekte atomar).
    pub strings: BTreeMap<String, serde_json::Value>,
}

/// Liefert den Boot-Katalog für das Frontend (ein Invoke pro Prozess).
#[tauri::command]
pub async fn i18n_catalog() -> Result<I18nCatalogResponse, String> {
    let tr =
        i18n::process_translator().ok_or_else(|| "i18n translator not initialized".to_string())?;
    Ok(build_catalog_response(tr))
}

/// Idempotenter Handshake: Frontend-UI ist bootstrapped und bereit.
#[tauri::command]
pub async fn frontend_ready() -> Result<(), String> {
    i18n::ready::mark_ready();
    Ok(())
}

pub(crate) fn build_catalog_response(tr: &Translator) -> I18nCatalogResponse {
    let registry = tr.registry();
    let languages: Vec<LanguageInfo> = registry
        .tags()
        .into_iter()
        .filter_map(|tag| {
            registry.get(&tag).map(|c| LanguageInfo {
                tag: c.meta.tag.clone(),
                name: c.meta.name.clone(),
                flag: c.meta.flag.clone(),
            })
        })
        .collect();

    I18nCatalogResponse {
        tag: tr.catalog_tag().to_string(),
        locale: tr.format_locale().to_string(),
        languages,
        strings: merged_strings(tr),
    }
}

/// Merge: en-Basis, aktive Sprache überschreibt Keys atomar (inkl. Plural).
fn merged_strings(tr: &Translator) -> BTreeMap<String, serde_json::Value> {
    let mut out = BTreeMap::new();
    let reg = tr.registry();
    if let Some(en) = reg.get("en") {
        for (k, v) in &en.strings {
            out.insert(k.clone(), catalog_value_json(v));
        }
    }
    let tag = tr.catalog_tag();
    if tag != "en" {
        if let Some(active) = reg.get(tag) {
            for (k, v) in &active.strings {
                out.insert(k.clone(), catalog_value_json(v));
            }
        }
    }
    out
}

fn catalog_value_json(v: &CatalogValue) -> serde_json::Value {
    match v {
        CatalogValue::Text(s) => serde_json::Value::String(s.clone()),
        CatalogValue::Plural(branches) => {
            let mut map = serde_json::Map::new();
            for (cat, text) in branches {
                map.insert(cat.clone(), serde_json::Value::String(text.clone()));
            }
            serde_json::Value::Object(map)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{
        Catalog, CatalogMeta, CatalogRegistry, CatalogValue, ResolvedLanguage, Translator,
    };
    use std::collections::BTreeMap;

    fn sample_translator() -> Translator {
        let mut en_strings = BTreeMap::new();
        en_strings.insert("menu.file".into(), CatalogValue::Text("File".into()));
        en_strings.insert(
            "search.status.hitsPart".into(),
            CatalogValue::Plural(BTreeMap::from([
                ("one".into(), "1 hit".into()),
                ("other".into(), "{count} hits".into()),
            ])),
        );
        let mut de_strings = BTreeMap::new();
        de_strings.insert("menu.file".into(), CatalogValue::Text("Datei".into()));
        de_strings.insert(
            "search.status.hitsPart".into(),
            CatalogValue::Plural(BTreeMap::from([
                ("one".into(), "1 Treffer".into()),
                ("other".into(), "{count} Treffer".into()),
            ])),
        );
        let reg = CatalogRegistry::from_catalogs(vec![
            Catalog {
                meta: CatalogMeta {
                    tag: "en".into(),
                    name: "English".into(),
                    locale: "en-US".into(),
                    flag: "🇺🇸".into(),
                },
                strings: en_strings,
            },
            Catalog {
                meta: CatalogMeta {
                    tag: "de".into(),
                    name: "Deutsch".into(),
                    locale: "de-DE".into(),
                    flag: "🇩🇪".into(),
                },
                strings: de_strings,
            },
        ]);
        Translator::new(
            reg,
            ResolvedLanguage {
                catalog_tag: "de".into(),
                format_locale: "de-DE".into(),
            },
        )
    }

    #[test]
    fn merged_catalog_prefers_active_over_en() {
        let tr = sample_translator();
        let resp = build_catalog_response(&tr);
        assert_eq!(resp.tag, "de");
        assert_eq!(resp.locale, "de-DE");
        assert_eq!(
            resp.strings.get("menu.file"),
            Some(&serde_json::json!("Datei"))
        );
        // Plural object is atomic (full de object, not mixed branches)
        assert_eq!(
            resp.strings.get("search.status.hitsPart"),
            Some(&serde_json::json!({"one": "1 Treffer", "other": "{count} Treffer"}))
        );
        assert!(resp
            .languages
            .iter()
            .any(|l| l.tag == "de" && l.name == "Deutsch" && l.flag == "🇩🇪"));
        assert!(resp.languages.iter().any(|l| l.tag == "en"));
    }
}
