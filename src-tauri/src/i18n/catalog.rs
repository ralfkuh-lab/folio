//! Katalog-Laden, Validierung und Registry-Codegen.
//!
//! Diese Datei wird auch von `build.rs` per `#[path]` eingebunden — daher
//! **keine** `crate::`-Imports und kein `tracing` (nur `std` + `serde`/`serde_json`).
//!
//! `dead_code` erlaubt: Build-Script nutzt nur `generate_registry`; die
//! Runtime-Bibliothek re-exportiert den Rest.

#![allow(dead_code)]

use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// CLDR-Pluralkategorie (cardinal).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PluralCategory {
    Zero,
    One,
    Two,
    Few,
    Many,
    Other,
}

impl PluralCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zero => "zero",
            Self::One => "one",
            Self::Two => "two",
            Self::Few => "few",
            Self::Many => "many",
            Self::Other => "other",
        }
    }
}

/// V1-Batch-Sprachen mit Pluralregeln.
pub const PLURAL_BATCH_TAGS: &[&str] = &[
    "de", "en", "es", "fr", "it", "pt", "ru", "pl", "ja", "zh", "ko",
];

/// Katalogwert: einfacher String oder Plural-Objekt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogValue {
    Text(String),
    Plural(BTreeMap<String, String>),
}

/// Metadaten aus `@meta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogMeta {
    pub tag: String,
    pub name: String,
    pub locale: String,
    pub flag: String,
}

/// Ein Sprachkatalog.
#[derive(Debug, Clone)]
pub struct Catalog {
    pub meta: CatalogMeta,
    pub strings: BTreeMap<String, CatalogValue>,
}

/// Registry aller Kataloge.
#[derive(Debug, Clone, Default)]
pub struct CatalogRegistry {
    catalogs: BTreeMap<String, Catalog>,
}

impl CatalogRegistry {
    pub fn new() -> Self {
        Self {
            catalogs: BTreeMap::new(),
        }
    }

    pub fn load_from_dir(dir: &Path) -> Result<Self, RegistryError> {
        let catalogs = load_catalogs_from_dir(dir)?;
        validate_catalog_set(&catalogs)?;
        let mut reg = Self::new();
        for c in catalogs {
            reg.catalogs.insert(c.meta.tag.clone(), c);
        }
        Ok(reg)
    }

    pub fn from_embedded_json(entries: &[(&str, &str)]) -> Result<Self, RegistryError> {
        let mut catalogs = Vec::new();
        for &(tag, text) in entries {
            let file = format!("{tag}.json");
            let cat = parse_catalog_file(&file, text)?;
            if cat.meta.tag != tag {
                return Err(RegistryError::MetaTagMismatch {
                    file,
                    meta_tag: cat.meta.tag,
                });
            }
            catalogs.push(cat);
        }
        validate_catalog_set(&catalogs)?;
        let mut reg = Self::new();
        for c in catalogs {
            reg.catalogs.insert(c.meta.tag.clone(), c);
        }
        Ok(reg)
    }

    pub fn tags(&self) -> Vec<String> {
        self.catalogs.keys().cloned().collect()
    }

    pub fn get(&self, tag: &str) -> Option<&Catalog> {
        self.catalogs.get(tag)
    }

    pub fn len(&self) -> usize {
        self.catalogs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.catalogs.is_empty()
    }

    /// Test-/lokale Konstruktion (lückenhafter Registry für Fallback-Tests).
    pub fn from_catalogs(catalogs: Vec<Catalog>) -> Self {
        let mut reg = Self::new();
        for c in catalogs {
            reg.catalogs.insert(c.meta.tag.clone(), c);
        }
        reg
    }
}

/// Generator- / Katalog-Validierungsfehler (fail-closed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    Io(String),
    InvalidJson { file: String, detail: String },
    MissingEn,
    MetaTagMismatch { file: String, meta_tag: String },
    IncompleteMeta { file: String },
    DuplicateTag { tag: String },
    DuplicateKey { file: String, key: String },
    UnsortedKeys { file: String },
    KeySetMismatch { detail: String },
    PlaceholderMismatch { key: String, detail: String },
    ValueTypeMismatch { key: String },
    MissingPluralBranch { key: String, category: String },
    UnknownPluralTag { tag: String },
    UnsupportedFormat { key: String },
    InvalidLocale { file: String, locale: String },
    Other(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(s) => write!(f, "I/O error: {s}"),
            Self::InvalidJson { file, detail } => {
                write!(f, "invalid JSON in {file}: {detail}")
            }
            Self::MissingEn => write!(f, "missing required catalog 'en.json'"),
            Self::MetaTagMismatch { file, meta_tag } => {
                write!(
                    f,
                    "@meta.tag '{meta_tag}' does not match file name in {file}"
                )
            }
            Self::IncompleteMeta { file } => {
                write!(
                    f,
                    "incomplete @meta in {file} (need tag, name, locale, flag)"
                )
            }
            Self::DuplicateTag { tag } => write!(f, "duplicate catalog tag '{tag}'"),
            Self::DuplicateKey { file, key } => {
                write!(f, "duplicate key '{key}' in {file}")
            }
            Self::UnsortedKeys { file } => {
                write!(f, "keys not alphabetically sorted in {file}")
            }
            Self::KeySetMismatch { detail } => write!(f, "key set mismatch: {detail}"),
            Self::PlaceholderMismatch { key, detail } => {
                write!(f, "placeholder mismatch on '{key}': {detail}")
            }
            Self::ValueTypeMismatch { key } => {
                write!(f, "value type mismatch on '{key}' (string vs plural)")
            }
            Self::MissingPluralBranch { key, category } => {
                write!(f, "key '{key}' missing required plural branch '{category}'")
            }
            Self::UnknownPluralTag { tag } => {
                write!(f, "no plural rules registered for catalog tag '{tag}'")
            }
            Self::UnsupportedFormat { key } => {
                write!(f, "unsupported @format on key '{key}' (V1 rejects @format)")
            }
            Self::InvalidLocale { file, locale } => {
                write!(f, "invalid BCP-47 locale '{locale}' in {file}")
            }
            Self::Other(s) => write!(f, "{s}"),
        }
    }
}

impl std::error::Error for RegistryError {}

/// Ausgabe von [`generate_registry`].
#[derive(Debug, Clone)]
pub struct GeneratedRegistry {
    pub tags: Vec<String>,
    pub metas: Vec<CatalogMeta>,
    pub rust_source: String,
}

/// Scannt `dir`, validiert fail-closed, liefert Registry-Metadaten + generierten Code.
pub fn generate_registry(dir: &Path) -> Result<GeneratedRegistry, RegistryError> {
    let mut catalogs = load_catalogs_from_dir(dir)?;
    validate_catalog_set(&catalogs)?;
    catalogs.sort_by(|a, b| a.meta.tag.cmp(&b.meta.tag));

    let tags: Vec<String> = catalogs.iter().map(|c| c.meta.tag.clone()).collect();
    let metas: Vec<CatalogMeta> = catalogs.iter().map(|c| c.meta.clone()).collect();

    let mut rust = String::from(
        "// @generated by folio i18n build — do not edit\n\
         pub static EMBEDDED_LOCALES: &[(&str, &str)] = &[\n",
    );
    for tag in &tags {
        rust.push_str(&format!(
            "    ({tag:?}, include_str!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/locales/{tag}.json\"))),\n"
        ));
    }
    rust.push_str("];\n");

    Ok(GeneratedRegistry {
        tags,
        metas,
        rust_source: rust,
    })
}

fn load_catalogs_from_dir(dir: &Path) -> Result<Vec<Catalog>, RegistryError> {
    let entries = fs::read_dir(dir).map_err(|e| RegistryError::Io(format!("{dir:?}: {e}")))?;
    let mut files: Vec<PathBuf> = Vec::new();
    for ent in entries {
        let ent = ent.map_err(|e| RegistryError::Io(e.to_string()))?;
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            files.push(path);
        }
    }
    files.sort();

    let mut catalogs = Vec::new();
    for path in &files {
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("?.json")
            .to_string();
        let text =
            fs::read_to_string(path).map_err(|e| RegistryError::Io(format!("{file_name}: {e}")))?;
        let cat = parse_catalog_file(&file_name, &text)?;
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if cat.meta.tag != stem {
            return Err(RegistryError::MetaTagMismatch {
                file: file_name,
                meta_tag: cat.meta.tag,
            });
        }
        catalogs.push(cat);
    }
    Ok(catalogs)
}

fn validate_catalog_set(catalogs: &[Catalog]) -> Result<(), RegistryError> {
    let mut seen_lower = BTreeSet::new();
    for c in catalogs {
        let lower = c.meta.tag.to_ascii_lowercase();
        if !seen_lower.insert(lower) {
            return Err(RegistryError::DuplicateTag {
                tag: c.meta.tag.clone(),
            });
        }
        if !PLURAL_BATCH_TAGS.contains(&c.meta.tag.as_str()) {
            return Err(RegistryError::UnknownPluralTag {
                tag: c.meta.tag.clone(),
            });
        }
    }

    if !catalogs.iter().any(|c| c.meta.tag == "en") {
        return Err(RegistryError::MissingEn);
    }

    let en = catalogs
        .iter()
        .find(|c| c.meta.tag == "en")
        .expect("en checked");
    let en_keys: BTreeSet<_> = en.strings.keys().cloned().collect();

    for c in catalogs {
        if c.meta.tag == "en" {
            continue;
        }
        let keys: BTreeSet<_> = c.strings.keys().cloned().collect();
        if keys != en_keys {
            return Err(RegistryError::KeySetMismatch {
                detail: format!("{} vs en", c.meta.tag),
            });
        }
        for key in &en_keys {
            let a = &c.strings[key];
            let b = &en.strings[key];
            let a_plural = matches!(a, CatalogValue::Plural(_));
            let b_plural = matches!(b, CatalogValue::Plural(_));
            if a_plural != b_plural {
                return Err(RegistryError::ValueTypeMismatch { key: key.clone() });
            }
            // Platzhalter-Parität: Union aller Branch-Texte (bzw. String-Wert)
            let ph_a = value_placeholders(a);
            let ph_b = value_placeholders(b);
            if ph_a != ph_b {
                return Err(RegistryError::PlaceholderMismatch {
                    key: key.clone(),
                    detail: format!("{} vs en ({ph_a:?} vs {ph_b:?})", c.meta.tag),
                });
            }
        }
    }

    // Pflicht-Branches pro Sprache gegen DEREN erreichbare Kategorien
    for c in catalogs {
        let required = required_plural_categories(&c.meta.tag);
        for (key, val) in &c.strings {
            if let CatalogValue::Plural(branches) = val {
                for req in &required {
                    if !branches.contains_key(*req) {
                        return Err(RegistryError::MissingPluralBranch {
                            key: key.clone(),
                            category: (*req).to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(())
}

fn value_placeholders(v: &CatalogValue) -> BTreeSet<String> {
    match v {
        CatalogValue::Text(s) => placeholders(s),
        CatalogValue::Plural(map) => {
            let mut set = BTreeSet::new();
            for t in map.values() {
                set.extend(placeholders(t));
            }
            set
        }
    }
}

/// Pflicht-Branches pro Sprache (other + alle für n≥0 erreichbaren Kategorien).
/// Belegt gegen Intl.PluralRules (Node) für 0/1/2/5/1e6.
pub fn required_plural_categories(tag: &str) -> Vec<&'static str> {
    match tag {
        "ja" | "zh" | "ko" => vec!["other"],
        "ru" | "pl" => vec!["one", "few", "many", "other"],
        // es/fr/it/pt: many bei 1_000_000 (CLDR cardinal integer)
        "es" | "fr" | "it" | "pt" => vec!["one", "many", "other"],
        // de, en
        _ => vec!["one", "other"],
    }
}

pub fn placeholders(s: &str) -> BTreeSet<String> {
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

/// Well-formed BCP-47 (vereinfacht, V1): language[-script][-region][-variant]*
pub fn is_well_formed_bcp47(tag: &str) -> bool {
    if tag.is_empty() || tag.len() > 35 {
        return false;
    }
    let mut parts = tag.split('-');
    let Some(lang) = parts.next() else {
        return false;
    };
    // language: 2-3 alpha or 4+ alpha (extlang simplified: 2-8 alpha)
    if !(2..=8).contains(&lang.len()) || !lang.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for part in parts {
        if part.is_empty() || part.len() > 8 {
            return false;
        }
        if !part.chars().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
    }
    true
}

// ─── recursive strict JSON (duplicate-preserving) ────────────────────────────

#[derive(Debug)]
enum StrictValue {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<StrictValue>),
    Object(Vec<(String, StrictValue)>),
}

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = StrictValue;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "any JSON value")
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(StrictValue::Bool(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(StrictValue::Number(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(StrictValue::Number(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(StrictValue::Number(
                    serde_json::Number::from_f64(v).ok_or_else(|| E::custom("invalid f64"))?,
                ))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(StrictValue::String(v.to_string()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(StrictValue::String(v))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue::Null)
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue::Null)
            }
            fn visit_some<D2: Deserializer<'de>>(
                self,
                deserializer: D2,
            ) -> Result<Self::Value, D2::Error> {
                StrictValue::deserialize(deserializer)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::new();
                while let Some(v) = seq.next_element::<StrictValue>()? {
                    items.push(v);
                }
                Ok(StrictValue::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                let mut seen = BTreeSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom(format!("duplicate key: {key}")));
                    }
                    let val: StrictValue = map.next_value()?;
                    entries.push((key, val));
                }
                Ok(StrictValue::Object(entries))
            }
        }
        deserializer.deserialize_any(V)
    }
}

fn parse_catalog_file(file: &str, text: &str) -> Result<Catalog, RegistryError> {
    let mut de = serde_json::Deserializer::from_str(text);
    let root = StrictValue::deserialize(&mut de).map_err(|e| map_de_error(file, e))?;
    // EOF erzwingen
    de.end().map_err(|e| RegistryError::InvalidJson {
        file: file.to_string(),
        detail: format!("trailing content after root value: {e}"),
    })?;

    let StrictValue::Object(entries) = root else {
        return Err(RegistryError::InvalidJson {
            file: file.to_string(),
            detail: "root must be an object".into(),
        });
    };

    let mut meta: Option<CatalogMeta> = None;
    let mut strings = BTreeMap::new();
    let mut key_order: Vec<String> = Vec::new();

    for (key, val) in entries {
        if key == "@meta" {
            meta = Some(parse_meta(file, &val)?);
            continue;
        }
        key_order.push(key.clone());
        strings.insert(key.clone(), parse_value(file, &key, val)?);
    }

    let meta = meta.ok_or_else(|| RegistryError::IncompleteMeta {
        file: file.to_string(),
    })?;

    let mut sorted = key_order.clone();
    sorted.sort();
    if key_order != sorted {
        return Err(RegistryError::UnsortedKeys {
            file: file.to_string(),
        });
    }

    Ok(Catalog { meta, strings })
}

fn map_de_error(file: &str, e: serde_json::Error) -> RegistryError {
    let msg = e.to_string();
    if msg.contains("duplicate key:") {
        let key = msg
            .split("duplicate key:")
            .nth(1)
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        RegistryError::DuplicateKey {
            file: file.to_string(),
            key,
        }
    } else {
        RegistryError::InvalidJson {
            file: file.to_string(),
            detail: msg,
        }
    }
}

fn parse_meta(file: &str, val: &StrictValue) -> Result<CatalogMeta, RegistryError> {
    let StrictValue::Object(entries) = val else {
        return Err(RegistryError::IncompleteMeta {
            file: file.to_string(),
        });
    };
    let mut tag = None;
    let mut name = None;
    let mut locale = None;
    let mut flag = None;
    for (k, v) in entries {
        match (k.as_str(), v) {
            ("tag", StrictValue::String(s)) => tag = Some(s.clone()),
            ("name", StrictValue::String(s)) => name = Some(s.clone()),
            ("locale", StrictValue::String(s)) => locale = Some(s.clone()),
            ("flag", StrictValue::String(s)) => flag = Some(s.clone()),
            _ => {}
        }
    }
    let (Some(tag), Some(name), Some(locale), Some(flag)) = (tag, name, locale, flag) else {
        return Err(RegistryError::IncompleteMeta {
            file: file.to_string(),
        });
    };
    if tag.is_empty() || name.is_empty() || locale.is_empty() || flag.is_empty() {
        return Err(RegistryError::IncompleteMeta {
            file: file.to_string(),
        });
    }
    if !is_well_formed_bcp47(&locale) {
        return Err(RegistryError::InvalidLocale {
            file: file.to_string(),
            locale,
        });
    }
    // tag should also be a simple language subtag from the batch
    if !is_well_formed_bcp47(&tag) {
        return Err(RegistryError::InvalidLocale {
            file: file.to_string(),
            locale: tag,
        });
    }
    Ok(CatalogMeta {
        tag,
        name,
        locale,
        flag,
    })
}

fn parse_value(file: &str, key: &str, val: StrictValue) -> Result<CatalogValue, RegistryError> {
    match val {
        StrictValue::String(s) => Ok(CatalogValue::Text(s)),
        StrictValue::Object(entries) => {
            let mut plural = BTreeMap::new();
            for (k, v) in entries {
                if k == "@format" {
                    return Err(RegistryError::UnsupportedFormat {
                        key: key.to_string(),
                    });
                }
                let StrictValue::String(s) = v else {
                    return Err(RegistryError::Other(format!(
                        "{file}: plural branch '{k}' of '{key}' must be a string"
                    )));
                };
                if !matches!(
                    k.as_str(),
                    "zero" | "one" | "two" | "few" | "many" | "other"
                ) {
                    return Err(RegistryError::Other(format!(
                        "{file}: unknown plural category '{k}' on '{key}'"
                    )));
                }
                plural.insert(k, s);
            }
            if !plural.contains_key("other") {
                return Err(RegistryError::MissingPluralBranch {
                    key: key.to_string(),
                    category: "other".into(),
                });
            }
            Ok(CatalogValue::Plural(plural))
        }
        _ => Err(RegistryError::Other(format!(
            "{file}: key '{key}' must be string or plural object"
        ))),
    }
}

/// CLDR-Pluralregeln (cardinal, Integer) für den V1-Batch.
/// Abgestimmt auf `Intl.PluralRules` (Node-Referenz 2026-07-13).
pub fn plural_rules(tag: &str, count: u64) -> Option<PluralCategory> {
    let primary = tag.split(['-', '_']).next().unwrap_or(tag);
    let primary = primary.to_ascii_lowercase();
    match primary.as_str() {
        "de" | "en" => Some(if count == 1 {
            PluralCategory::One
        } else {
            PluralCategory::Other
        }),
        // es/it: one=1; many=1e6,2e6,…; other sonst (inkl. 0)
        "es" | "it" => Some(if count == 1 {
            PluralCategory::One
        } else if is_cldr_many_million(count) {
            PluralCategory::Many
        } else {
            PluralCategory::Other
        }),
        // fr/pt: one=0,1; many=1e6…; other sonst
        "fr" | "pt" => Some(if count == 0 || count == 1 {
            PluralCategory::One
        } else if is_cldr_many_million(count) {
            PluralCategory::Many
        } else {
            PluralCategory::Other
        }),
        "ja" | "zh" | "ko" => Some(PluralCategory::Other),
        "ru" => Some(plural_ru(count)),
        "pl" => Some(plural_pl(count)),
        _ => None,
    }
}

/// CLDR: e=0, i != 0, i % 1000000 == 0, v=0 → many (es/fr/it/pt).
fn is_cldr_many_million(n: u64) -> bool {
    n != 0 && n % 1_000_000 == 0
}

fn plural_ru(n: u64) -> PluralCategory {
    let mod10 = n % 10;
    let mod100 = n % 100;
    if mod10 == 1 && mod100 != 11 {
        PluralCategory::One
    } else if (2..=4).contains(&mod10) && !(12..=14).contains(&mod100) {
        PluralCategory::Few
    } else {
        PluralCategory::Many
    }
}

fn plural_pl(n: u64) -> PluralCategory {
    let mod10 = n % 10;
    let mod100 = n % 100;
    if n == 1 {
        PluralCategory::One
    } else if (2..=4).contains(&mod10) && !(12..=14).contains(&mod100) {
        PluralCategory::Few
    } else {
        PluralCategory::Many
    }
}
