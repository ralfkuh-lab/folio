//! Internationalisierung (i18n) — Kataloge, Translator, Resolver, Migration.

mod catalog;
pub mod ready;

#[cfg(test)]
mod tests;

pub use catalog::{
    generate_registry, is_well_formed_bcp47, plural_rules, required_plural_categories, Catalog,
    CatalogMeta, CatalogRegistry, CatalogValue, GeneratedRegistry, PluralCategory, RegistryError,
    PLURAL_BATCH_TAGS,
};

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing::{error, warn};

// ─── Generated embedded locales (build.rs → OUT_DIR) ─────────────────────────

#[allow(clippy::all)]
#[allow(dead_code)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/i18n_registry.rs"));
}

static EMBEDDED_REGISTRY: OnceLock<CatalogRegistry> = OnceLock::new();

/// Geladene eingebettete Registry (gecacht, fail-open bei Parsefehler).
pub fn embedded_registry() -> &'static CatalogRegistry {
    EMBEDDED_REGISTRY.get_or_init(|| {
        match CatalogRegistry::from_embedded_json(generated::EMBEDDED_LOCALES) {
            Ok(reg) => reg,
            Err(e) => {
                error!(
                    target: "folio::i18n",
                    error = %e,
                    "failed to parse embedded i18n catalogs; using empty registry"
                );
                CatalogRegistry::new()
            }
        }
    })
}

/// Alias (Call-Sites / ältere Tests).
pub fn load_embedded_registry() -> CatalogRegistry {
    embedded_registry().clone()
}

// ─── Resolved language / Translator ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLanguage {
    pub catalog_tag: String,
    pub format_locale: String,
}

#[derive(Debug)]
pub struct Translator {
    registry: CatalogRegistry,
    catalog_tag: String,
    format_locale: String,
    warn_dedup: std::sync::Mutex<BTreeSet<(String, String, String)>>,
}

impl Translator {
    pub fn new(registry: CatalogRegistry, resolved: ResolvedLanguage) -> Self {
        Self {
            registry,
            catalog_tag: resolved.catalog_tag,
            format_locale: resolved.format_locale,
            warn_dedup: std::sync::Mutex::new(BTreeSet::new()),
        }
    }

    pub fn catalog_tag(&self) -> &str {
        &self.catalog_tag
    }

    pub fn format_locale(&self) -> &str {
        &self.format_locale
    }

    pub fn registry(&self) -> &CatalogRegistry {
        &self.registry
    }

    pub fn t(&self, key: &str) -> String {
        match self.lookup_value(key) {
            Some(CatalogValue::Text(s)) => s.clone(),
            Some(CatalogValue::Plural(_)) => {
                self.warn_once(key, "plural_as_text");
                key.to_string()
            }
            None => {
                self.warn_once(key, "missing");
                key.to_string()
            }
        }
    }

    pub fn t_args(&self, key: &str, args: &[(&str, &str)]) -> String {
        let template = self.t(key);
        interpolate(&template, args)
    }

    pub fn t_plural(
        &self,
        key: &str,
        count: u64,
        args: &[(&str, &str)],
    ) -> Result<String, TranslateError> {
        if args.iter().any(|(n, _)| *n == "count") {
            return Err(TranslateError::CountOverride);
        }
        let template = match self.lookup_value(key) {
            Some(CatalogValue::Plural(branches)) => {
                let cat = plural_rules(&self.catalog_tag, count)
                    .unwrap_or(PluralCategory::Other)
                    .as_str();
                if let Some(t) = branches.get(cat) {
                    t.clone()
                } else if let Some(t) = branches.get("other") {
                    self.warn_once(key, &format!("missing_branch_{cat}"));
                    t.clone()
                } else {
                    self.warn_once(key, "missing_other");
                    key.to_string()
                }
            }
            Some(CatalogValue::Text(s)) => s.clone(),
            None => {
                self.warn_once(key, "missing");
                key.to_string()
            }
        };
        let count_s = count.to_string();
        let mut merged: Vec<(&str, &str)> = Vec::with_capacity(args.len() + 1);
        merged.push(("count", count_s.as_str()));
        merged.extend_from_slice(args);
        Ok(interpolate(&template, &merged))
    }

    pub fn warn_dedup_len(&self) -> usize {
        self.warn_dedup.lock().map(|s| s.len()).unwrap_or(0)
    }

    fn lookup_value<'a>(&'a self, key: &str) -> Option<&'a CatalogValue> {
        if let Some(cat) = self.registry.get(&self.catalog_tag) {
            if let Some(v) = cat.strings.get(key) {
                return Some(v);
            }
        }
        if self.catalog_tag != "en" {
            if let Some(en) = self.registry.get("en") {
                if let Some(v) = en.strings.get(key) {
                    return Some(v);
                }
            }
        }
        None
    }

    fn warn_once(&self, key: &str, kind: &str) {
        let entry = (self.catalog_tag.clone(), key.to_string(), kind.to_string());
        if let Ok(mut set) = self.warn_dedup.lock() {
            if set.insert(entry) {
                warn!(
                    target: "folio::i18n",
                    catalog = %self.catalog_tag,
                    key,
                    failure_kind = kind,
                    "i18n lookup issue"
                );
            }
        }
    }
}

fn interpolate(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (name, value) in args {
        let pat = format!("{{{name}}}");
        out = out.replace(&pat, value);
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranslateError {
    CountOverride,
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/// Löst Setting + optionales FOLIO_LANG + OS-Locale gegen die Registry auf.
///
/// - Persistiertes Setting: **nur** case-sensitiv exakter Registry-Tag
///   (sonst en + en.@meta.locale).
/// - FOLIO_LANG / OS: zuerst well-formed BCP-47, dann exakt, dann Subtag;
///   bei Subtag-Match bleibt der volle Input als formatLocale.
pub fn resolve_language(
    setting: &str,
    folio_lang: Option<&str>,
    os_locale: Option<&str>,
    registry: &CatalogRegistry,
) -> ResolvedLanguage {
    let en_locale = registry
        .get("en")
        .map(|c| c.meta.locale.clone())
        .unwrap_or_else(|| "en-US".into());

    // 1) FOLIO_LANG override
    if let Some(raw) = folio_lang {
        if !is_well_formed_bcp47(raw) {
            warn!(
                target: "folio::i18n",
                value = raw,
                "invalid FOLIO_LANG (not well-formed BCP-47); ignoring"
            );
        } else if let Some(resolved) = match_override_or_os(raw, registry) {
            return resolved;
        } else {
            warn!(
                target: "folio::i18n",
                value = raw,
                "FOLIO_LANG not in registry; ignoring"
            );
        }
    }

    // 2) explicit stored setting — exact case-sensitive only
    if setting != "system" {
        if let Some(cat) = registry.get(setting) {
            return ResolvedLanguage {
                catalog_tag: cat.meta.tag.clone(),
                format_locale: cat.meta.locale.clone(),
            };
        }
        return ResolvedLanguage {
            catalog_tag: "en".into(),
            format_locale: en_locale,
        };
    }

    // 3) system → OS
    if let Some(os) = os_locale {
        if is_well_formed_bcp47(os) {
            if let Some(resolved) = match_override_or_os(os, registry) {
                return resolved;
            }
        }
    }

    ResolvedLanguage {
        catalog_tag: "en".into(),
        format_locale: en_locale,
    }
}

fn match_override_or_os(input: &str, registry: &CatalogRegistry) -> Option<ResolvedLanguage> {
    // exact
    if let Some(cat) = registry.get(input) {
        return Some(ResolvedLanguage {
            catalog_tag: cat.meta.tag.clone(),
            format_locale: cat.meta.locale.clone(),
        });
    }
    // primary subtag
    let primary = input
        .split(['-', '_'])
        .next()
        .unwrap_or(input)
        .to_ascii_lowercase();
    if let Some(cat) = registry.get(&primary) {
        return Some(ResolvedLanguage {
            catalog_tag: cat.meta.tag.clone(),
            format_locale: input.to_string(),
        });
    }
    None
}

/// Validiert einen language-Patch-Wert gegen die Registry.
pub fn is_valid_language_setting(value: &str, registry: &CatalogRegistry) -> bool {
    value == "system" || registry.get(value).is_some()
}

// ─── Settings language migration + boot load ─────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanguageMigrationResult {
    pub language: String,
    pub persisted: bool,
    /// Diagnosen, die NACH `logging::init` ausgegeben werden sollen.
    pub diagnostics: Vec<String>,
}

#[cfg(test)]
static RAW_READ_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub fn take_raw_read_count() -> usize {
    RAW_READ_COUNT.swap(0, std::sync::atomic::Ordering::SeqCst)
}

#[cfg(test)]
pub fn reset_raw_read_count() {
    RAW_READ_COUNT.store(0, std::sync::atomic::Ordering::SeqCst);
}

pub fn migrate_settings_language(config_dir: &Path) -> LanguageMigrationResult {
    use serde_json::{Map, Value};
    use std::fs;

    let settings_path = config_dir.join("settings.json");
    let mut diagnostics = Vec::new();

    match fs::read(&settings_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(test)]
            RAW_READ_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if is_fresh_install(config_dir) {
                return LanguageMigrationResult {
                    language: "system".into(),
                    persisted: false,
                    diagnostics,
                };
            }
            let mut obj = Map::new();
            obj.insert("language".into(), Value::String("de".into()));
            match atomic_write_json(&settings_path, &Value::Object(obj)) {
                Ok(()) => LanguageMigrationResult {
                    language: "de".into(),
                    persisted: true,
                    diagnostics,
                },
                Err(err) => {
                    diagnostics.push(format!("failed to pin language=de: {err}"));
                    LanguageMigrationResult {
                        language: "de".into(),
                        persisted: false,
                        diagnostics,
                    }
                }
            }
        }
        Err(e) => {
            #[cfg(test)]
            RAW_READ_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            diagnostics.push(format!(
                "settings.json unreadable ({e}); using language=de without overwrite"
            ));
            LanguageMigrationResult {
                language: "de".into(),
                persisted: false,
                diagnostics,
            }
        }
        Ok(bytes) => {
            #[cfg(test)]
            RAW_READ_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let text = String::from_utf8_lossy(&bytes);
            match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(mut map)) => match map.get("language") {
                    None => {
                        map.insert("language".into(), Value::String("de".into()));
                        match atomic_write_json(&settings_path, &Value::Object(map)) {
                            Ok(()) => LanguageMigrationResult {
                                language: "de".into(),
                                persisted: true,
                                diagnostics,
                            },
                            Err(err) => {
                                diagnostics.push(format!("failed to inject language=de: {err}"));
                                LanguageMigrationResult {
                                    language: "de".into(),
                                    persisted: false,
                                    diagnostics,
                                }
                            }
                        }
                    }
                    Some(Value::String(s)) => LanguageMigrationResult {
                        language: s.clone(),
                        persisted: false,
                        diagnostics,
                    },
                    Some(_) => {
                        diagnostics.push(
                            "settings.json language is not a string; using de without overwrite"
                                .into(),
                        );
                        LanguageMigrationResult {
                            language: "de".into(),
                            persisted: false,
                            diagnostics,
                        }
                    }
                },
                Ok(_) => {
                    diagnostics
                        .push("settings.json is not an object; using de without overwrite".into());
                    LanguageMigrationResult {
                        language: "de".into(),
                        persisted: false,
                        diagnostics,
                    }
                }
                Err(_) => {
                    diagnostics.push("settings.json corrupt; using de without overwrite".into());
                    LanguageMigrationResult {
                        language: "de".into(),
                        persisted: false,
                        diagnostics,
                    }
                }
            }
        }
    }
}

/// Boot-Owner: Migration + typisierter Load + Re-Injection der effektiven Sprache.
///
/// Gibt den SettingsService und die Migration (inkl. Diagnosen) zurück.
pub fn boot_load_settings(
    config_dir: &Path,
) -> (crate::settings::SettingsService, LanguageMigrationResult) {
    let mig = migrate_settings_language(config_dir);
    let path = config_dir.join("settings.json");
    let mut svc = crate::settings::SettingsService::load_from(path);
    svc.set_language_for_boot(mig.language.clone());
    (svc, mig)
}

/// `read_dir`-Fehler = Bestandsinstallation (konservativ → de, nicht system).
fn is_fresh_install(config_dir: &Path) -> bool {
    use std::fs;
    if !config_dir.exists() {
        return true;
    }
    match fs::read_dir(config_dir) {
        Ok(mut rd) => !rd.any(|e| e.is_ok()),
        Err(_) => false, // F10: Fehler → nicht frisch
    }
}

fn atomic_write_json(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    use std::fs;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let write_result = fs::write(&tmp, &bytes);
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
        return write_result;
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

// ─── MenuLabels (owned) ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuLabels {
    pub file: String,
    pub file_open: String,
    pub file_save: String,
    pub file_save_as: String,
    pub file_recent: String,
    pub file_recent_empty: String,
    pub file_rename: String,
    pub file_export: String,
    pub file_close: String,
    pub file_quit: String,
    pub edit: String,
    pub edit_undo: String,
    pub edit_redo: String,
    pub edit_find: String,
    pub edit_search_vault: String,
    pub edit_ai_translate: String,
    pub edit_ai_actions: String,
    pub edit_settings: String,
    pub view: String,
    pub view_mode_view: String,
    pub view_mode_edit: String,
    pub view_mode_split: String,
    pub view_git_diff: String,
    pub view_theme: String,
    pub view_theme_light: String,
    pub view_theme_dark: String,
    pub view_rail_left: String,
    pub view_rail_right: String,
    pub view_minimap: String,
    pub help: String,
    pub help_cheatsheet: String,
    pub help_setup_md_icon: String,
    pub help_about: String,
    pub save_as_filter_markdown: String,
    pub save_as_filter_text: String,
    pub save_as_filter_all: String,
}

impl MenuLabels {
    #[cfg(not(test))]
    pub(crate) fn empty() -> Self {
        Self {
            file: String::new(),
            file_open: String::new(),
            file_save: String::new(),
            file_save_as: String::new(),
            file_recent: String::new(),
            file_recent_empty: String::new(),
            file_rename: String::new(),
            file_export: String::new(),
            file_close: String::new(),
            file_quit: String::new(),
            edit: String::new(),
            edit_undo: String::new(),
            edit_redo: String::new(),
            edit_find: String::new(),
            edit_search_vault: String::new(),
            edit_ai_translate: String::new(),
            edit_ai_actions: String::new(),
            edit_settings: String::new(),
            view: String::new(),
            view_mode_view: String::new(),
            view_mode_edit: String::new(),
            view_mode_split: String::new(),
            view_git_diff: String::new(),
            view_theme: String::new(),
            view_theme_light: String::new(),
            view_theme_dark: String::new(),
            view_rail_left: String::new(),
            view_rail_right: String::new(),
            view_minimap: String::new(),
            help: String::new(),
            help_cheatsheet: String::new(),
            help_setup_md_icon: String::new(),
            help_about: String::new(),
            save_as_filter_markdown: String::new(),
            save_as_filter_text: String::new(),
            save_as_filter_all: String::new(),
        }
    }
}

pub fn menu_labels_from_translator(tr: &Translator) -> MenuLabels {
    let t = |key: &str| tr.t(key);
    MenuLabels {
        file: t("menu.file"),
        file_open: t("menu.file.open"),
        file_save: t("menu.file.save"),
        file_save_as: t("menu.file.saveAs"),
        file_recent: t("menu.file.recent"),
        file_recent_empty: t("menu.file.recentEmpty"),
        file_rename: t("menu.file.rename"),
        file_export: t("menu.file.export"),
        file_close: t("menu.file.closeTab"),
        file_quit: t("menu.file.quit"),
        edit: t("menu.edit"),
        edit_undo: t("menu.edit.undo"),
        edit_redo: t("menu.edit.redo"),
        edit_find: t("menu.edit.find"),
        edit_search_vault: t("menu.edit.searchVault"),
        edit_ai_translate: t("menu.edit.aiTranslate"),
        edit_ai_actions: t("menu.edit.aiActions"),
        edit_settings: t("menu.edit.settings"),
        view: t("menu.view"),
        view_mode_view: t("menu.view.modeView"),
        view_mode_edit: t("menu.view.modeEdit"),
        view_mode_split: t("menu.view.modeSplit"),
        view_git_diff: t("menu.view.gitDiff"),
        view_theme: t("menu.view.theme"),
        view_theme_light: t("menu.view.themeLight"),
        view_theme_dark: t("menu.view.themeDark"),
        view_rail_left: t("menu.view.railLeft"),
        view_rail_right: t("menu.view.railRight"),
        view_minimap: t("menu.view.minimap"),
        help: t("menu.help"),
        help_cheatsheet: t("menu.help.cheatsheet"),
        help_setup_md_icon: t("menu.help.setupMdIcon"),
        help_about: t("menu.help.about"),
        save_as_filter_markdown: t("menu.filter.markdown"),
        save_as_filter_text: t("menu.filter.text"),
        save_as_filter_all: t("menu.filter.all"),
    }
}

// ─── Process-global façade ───────────────────────────────────────────────────

static PROCESS_TRANSLATOR: OnceLock<Translator> = OnceLock::new();

pub fn set_process_translator(tr: Translator) -> Result<(), Translator> {
    PROCESS_TRANSLATOR.set(tr)
}

/// Boot-Translator (nach `set_process_translator`); `None` vor Init.
pub fn process_translator() -> Option<&'static Translator> {
    PROCESS_TRANSLATOR.get()
}

pub fn t(key: &str) -> String {
    match PROCESS_TRANSLATOR.get() {
        Some(tr) => tr.t(key),
        None => {
            debug_assert!(false, "i18n::t called before set_process_translator");
            key.to_string()
        }
    }
}

pub fn t_args(key: &str, args: &[(&str, &str)]) -> String {
    match PROCESS_TRANSLATOR.get() {
        Some(tr) => tr.t_args(key, args),
        None => {
            debug_assert!(false, "i18n::t_args called before set_process_translator");
            key.to_string()
        }
    }
}

pub fn t_plural(key: &str, count: u64, args: &[(&str, &str)]) -> Result<String, TranslateError> {
    match PROCESS_TRANSLATOR.get() {
        Some(tr) => tr.t_plural(key, count, args),
        None => {
            debug_assert!(false, "i18n::t_plural called before set_process_translator");
            Ok(key.to_string())
        }
    }
}

// ─── Declarative built-in catalog (ID → name/description keys) ───────────────
//
// Keys are string literals so the i18n reference gate sees them without
// allowlist prefixes. Lookups never `format!` keys from IDs.

/// One built-in entity whose display name/description live in the locale catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinCatalogEntry {
    pub id: &'static str,
    pub name_key: &'static str,
    pub description_key: &'static str,
}

/// Built-in themes: stable id + catalog keys (order matches `theme::builtin::IDS`).
pub const THEME_BUILTIN_CATALOG: &[BuiltinCatalogEntry] = &[
    BuiltinCatalogEntry {
        id: "standard",
        name_key: "theme.builtin.standard.name",
        description_key: "theme.builtin.standard.description",
    },
    BuiltinCatalogEntry {
        id: "classic",
        name_key: "theme.builtin.classic.name",
        description_key: "theme.builtin.classic.description",
    },
    BuiltinCatalogEntry {
        id: "clean",
        name_key: "theme.builtin.clean.name",
        description_key: "theme.builtin.clean.description",
    },
    BuiltinCatalogEntry {
        id: "github",
        name_key: "theme.builtin.github.name",
        description_key: "theme.builtin.github.description",
    },
    BuiltinCatalogEntry {
        id: "business",
        name_key: "theme.builtin.business.name",
        description_key: "theme.builtin.business.description",
    },
    BuiltinCatalogEntry {
        id: "report",
        name_key: "theme.builtin.report.name",
        description_key: "theme.builtin.report.description",
    },
    BuiltinCatalogEntry {
        id: "minimal",
        name_key: "theme.builtin.minimal.name",
        description_key: "theme.builtin.minimal.description",
    },
    BuiltinCatalogEntry {
        id: "brand",
        name_key: "theme.builtin.brand.name",
        description_key: "theme.builtin.brand.description",
    },
    BuiltinCatalogEntry {
        id: "warm",
        name_key: "theme.builtin.warm.name",
        description_key: "theme.builtin.warm.description",
    },
    BuiltinCatalogEntry {
        id: "tech",
        name_key: "theme.builtin.tech.name",
        description_key: "theme.builtin.tech.description",
    },
    BuiltinCatalogEntry {
        id: "contrast",
        name_key: "theme.builtin.contrast.name",
        description_key: "theme.builtin.contrast.description",
    },
    BuiltinCatalogEntry {
        id: "pastel",
        name_key: "theme.builtin.pastel.name",
        description_key: "theme.builtin.pastel.description",
    },
];

/// Built-in KI actions: stable template id + catalog keys.
pub const AI_ACTION_BUILTIN_CATALOG: &[BuiltinCatalogEntry] = &[
    BuiltinCatalogEntry {
        id: "summarize",
        name_key: "ai.actions.summarize.name",
        description_key: "ai.actions.summarize.description",
    },
    BuiltinCatalogEntry {
        id: "reformat",
        name_key: "ai.actions.reformat.name",
        description_key: "ai.actions.reformat.description",
    },
    BuiltinCatalogEntry {
        id: "proofread",
        name_key: "ai.actions.proofread.name",
        description_key: "ai.actions.proofread.description",
    },
    BuiltinCatalogEntry {
        id: "to-table",
        name_key: "ai.actions.toTable.name",
        description_key: "ai.actions.toTable.description",
    },
    BuiltinCatalogEntry {
        id: "extract-actions",
        name_key: "ai.actions.extractActions.name",
        description_key: "ai.actions.extractActions.description",
    },
];

fn find_catalog_entry<'a>(
    table: &'a [BuiltinCatalogEntry],
    id: &str,
) -> Option<&'a BuiltinCatalogEntry> {
    table.iter().find(|e| e.id == id)
}

/// Theme display name for `id` via declarative catalog + translator.
pub fn theme_builtin_name(tr: &Translator, id: &str) -> String {
    match find_catalog_entry(THEME_BUILTIN_CATALOG, id) {
        Some(e) => tr.t(e.name_key),
        None => id.to_string(),
    }
}

pub fn theme_builtin_description(tr: &Translator, id: &str) -> String {
    match find_catalog_entry(THEME_BUILTIN_CATALOG, id) {
        Some(e) => tr.t(e.description_key),
        None => id.to_string(),
    }
}

/// Process translator, or embedded-de for unit/integration tests and rare
/// pre-boot package discovery (`packages()` / `builtin_templates()` /
/// `render_document` smoke tests). Production always sets the process façade
/// before UI/export; `t()` / `ExportStrings::current` stay strict.
pub fn translator_for_builtins() -> &'static Translator {
    if let Some(tr) = process_translator() {
        return tr;
    }
    static DE: OnceLock<Translator> = OnceLock::new();
    DE.get_or_init(|| {
        Translator::new(
            embedded_registry().clone(),
            ResolvedLanguage {
                catalog_tag: "de".into(),
                format_locale: "de-DE".into(),
            },
        )
    })
}

pub fn theme_builtin_name_active(id: &str) -> String {
    theme_builtin_name(translator_for_builtins(), id)
}

pub fn theme_builtin_description_active(id: &str) -> String {
    theme_builtin_description(translator_for_builtins(), id)
}

/// AI action display name/description via declarative catalog + translator.
pub fn ai_action_name(tr: &Translator, id: &str) -> String {
    match find_catalog_entry(AI_ACTION_BUILTIN_CATALOG, id) {
        Some(e) => tr.t(e.name_key),
        None => id.to_string(),
    }
}

pub fn ai_action_description(tr: &Translator, id: &str) -> String {
    match find_catalog_entry(AI_ACTION_BUILTIN_CATALOG, id) {
        Some(e) => tr.t(e.description_key),
        None => id.to_string(),
    }
}

pub fn ai_action_name_active(id: &str) -> String {
    ai_action_name(translator_for_builtins(), id)
}

pub fn ai_action_description_active(id: &str) -> String {
    ai_action_description(translator_for_builtins(), id)
}

/// Export-related strings from a translator (tests inject local instances).
#[derive(Debug, Clone)]
pub struct ExportStrings {
    pub catalog_tag: String,
    pub format_locale: String,
    pub default_title: String,
    pub preview_title: String,
    pub created_by: String,
    pub prepared_by: String,
}

impl ExportStrings {
    pub fn from_translator(tr: &Translator) -> Self {
        Self {
            catalog_tag: tr.catalog_tag().to_string(),
            format_locale: tr.format_locale().to_string(),
            default_title: tr.t("export.defaultTitle"),
            preview_title: tr.t("export.preview.title"),
            created_by: tr.t("export.cover.createdBy"),
            prepared_by: tr.t("export.cover.preparedBy"),
        }
    }

    /// Boot process translator. Requires `set_process_translator` (same as `t()`).
    pub fn current() -> Self {
        match process_translator() {
            Some(tr) => Self::from_translator(tr),
            None => {
                debug_assert!(
                    false,
                    "ExportStrings::current before set_process_translator"
                );
                Self {
                    catalog_tag: "en".into(),
                    format_locale: "en-US".into(),
                    default_title: "export.defaultTitle".into(),
                    preview_title: "export.preview.title".into(),
                    created_by: "export.cover.createdBy".into(),
                    prepared_by: "export.cover.preparedBy".into(),
                }
            }
        }
    }
}

/// Format a civil date for export fallbacks from the **full** `format_locale`
/// (BCP-47), not only the primary language subtag.
///
/// Region map (V1; `_` normalized to `-`, case-insensitive):
/// - `en-US` → `MM/DD/YYYY`
/// - `en-GB` → `DD/MM/YYYY`
/// - `en-CA` → `YYYY-MM-DD`
/// - `fr-FR` → `DD/MM/YYYY`
/// - `fr-CA` → `YYYY-MM-DD`
/// - `de-DE` / `de-CH` / `de-AT` → `DD.MM.YYYY`
///
/// Language defaults when no region match:
/// - `de` → `DD.MM.YYYY`
/// - `en` → `MM/DD/YYYY` (product default matches `@meta.locale` `en-US`)
/// - `fr` → `DD/MM/YYYY`
/// - other → `YYYY-MM-DD` (ISO)
pub fn format_export_date(y: i64, m: u32, d: u32, format_locale: &str) -> String {
    let tag = normalize_format_locale(format_locale);
    match tag.as_str() {
        "en-us" => format!("{m:02}/{d:02}/{y:04}"),
        "en-gb" => format!("{d:02}/{m:02}/{y:04}"),
        "en-ca" => format!("{y:04}-{m:02}-{d:02}"),
        "fr-fr" => format!("{d:02}/{m:02}/{y:04}"),
        "fr-ca" => format!("{y:04}-{m:02}-{d:02}"),
        "de-de" | "de-ch" | "de-at" => format!("{d:02}.{m:02}.{y:04}"),
        other => match other.split('-').next().unwrap_or(other) {
            "de" => format!("{d:02}.{m:02}.{y:04}"),
            "en" => format!("{m:02}/{d:02}/{y:04}"),
            "fr" => format!("{d:02}/{m:02}/{y:04}"),
            _ => format!("{y:04}-{m:02}-{d:02}"),
        },
    }
}

fn normalize_format_locale(format_locale: &str) -> String {
    format_locale.trim().replace('_', "-").to_ascii_lowercase()
}

#[cfg(test)]
pub(crate) fn production_locales_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("locales")
}

#[cfg(test)]
pub(crate) fn fr_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/locales/fr.json")
}

/// Config-Verzeichnis (Eltern von settings.json).
pub fn config_dir() -> PathBuf {
    crate::persist::config_file("settings.json")
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}
