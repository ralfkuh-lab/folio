//! App-Settings (semantische Einstellungen, nicht Layout-Memo).
//!
//! Liegt bewusst getrennt von [`crate::panel_state::PanelState`]: panel_state
//! speichert Sitzungs-/Fenster-/Layout-Zustand (Rails, Minimap, Window-
//! Geometrie), hier liegen App-Praeferenzen (Sprache, Default-Mode pro
//! Datei-Kind, Auto-Format im View-Mode). Persistenz in
//! `settings.json` im App-Config-Verzeichnis. Theme bleibt in
//! [`crate::theme::ThemeService`] — der Settings-Dialog aggregiert auf
//! Frontend-Seite mehrere Quellen.

use crate::persist;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    io,
    path::PathBuf,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    De,
    En,
}

impl Language {
    pub fn code(self) -> &'static str {
        match self {
            Self::De => "de",
            Self::En => "en",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultViewMode {
    View,
    Edit,
    /// "Aktueller Modus" — beim Oeffnen einer Datei wird der View/Edit-
    /// Mode **nicht** umgeschaltet, sondern der aktuell aktive Modus
    /// bleibt erhalten. Das ist das App-Verhalten vor dem Settings-
    /// Panel und der Default fuer beide Kinds; "View"/"Edit" sind die
    /// strengeren Varianten ("immer view" / "immer edit").
    #[default]
    Current,
}

impl DefaultViewMode {
    pub fn code(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Edit => "edit",
            Self::Current => "current",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportDirMode {
    #[default]
    Document,
    Last,
}

/// Ziel fuer extern geoeffnete Dateien (Single-Instance-Reinvoke,
/// z. B. Explorer-Doppelklick): neuer Tab (Default) oder Ersetzen im
/// aktiven Tab (Verhalten vor dem Tabs-Feature). Betrifft NUR den
/// `cli:open`-Pfad der laufenden Instanz — der Boot-CLI-Pfad oeffnet
/// immer als eigener Tab (cli_pending_open).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenFileTarget {
    #[default]
    Newtab,
    Replace,
}

/// Log-Level fuer das `tracing`-Subscriber-Setup. `Off` schaltet die
/// Ausgabe stumm (Filter auf `"off"`) — der Subscriber und der
/// File-Appender bleiben registriert, sodass ein Live-Wechsel zurueck
/// nach `Info`/`Debug` ohne App-Restart funktioniert.
/// `tracing-appender` legt das Tagesfile erst beim ersten Schreiben
/// an, also entstehen bei `Off` keine leeren Logdateien.
///
/// Default ist `Info` — sparsam, aber Lifecycle- und Error-Ereignisse
/// werden mitgeschrieben. Override via `RUST_LOG`-ENV (sperrt dann
/// auch den Live-Reload aus dem Settings-UI, siehe `logging.rs`); im
/// Debug-Build ist der Default `Debug`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Off,
    Error,
    Warn,
    #[default]
    Info,
    Debug,
}

impl LogLevel {
    pub fn code(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }

    /// EnvFilter-Ausdruck, der nur Folio-eigene Targets beruecksichtigt
    /// (`folio`/`folio_lib`). Externe Crates (axum, tokio, notify ...)
    /// loggen nur ab `warn` mit — sonst wuerde z. B. axum jede
    /// Automation-Request mitlogen. Wird nur fuer `Off` nicht
    /// aufgerufen.
    pub fn env_filter(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Error => "folio=error,folio_lib=error,warn",
            Self::Warn => "folio=warn,folio_lib=warn,warn",
            Self::Info => "folio=info,folio_lib=info,warn",
            Self::Debug => "folio=debug,folio_lib=debug,warn",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsData {
    #[serde(default)]
    pub language: Language,
    #[serde(default = "default_mode_markdown")]
    pub default_mode_markdown: DefaultViewMode,
    #[serde(default = "default_mode_text")]
    pub default_mode_text: DefaultViewMode,
    #[serde(default = "default_true")]
    pub view_auto_format: bool,
    /// Content-Theme fuer die Markdown-Ansicht. Unbekannte gespeicherte
    /// IDs bleiben beim Laden erhalten; das Frontend faellt bei der
    /// CSS-Abfrage auf `standard` zurueck.
    #[serde(default = "default_view_theme")]
    pub view_theme: String,
    /// Fuer den Export priorisierte Theme-IDs. Unbekannte gespeicherte
    /// IDs bleiben beim Laden erhalten und werden im Frontend lediglich
    /// ausgeblendet.
    #[serde(default)]
    pub theme_favorites: Vec<String>,
    /// Favorisierte KI-Aktions-Template-IDs (Spec docs/spec-ki-actions.md).
    /// Bewusst OHNE Existenzvalidierung im Patch (anders als
    /// theme_favorites): verschwundene Custom-Template-IDs bleiben
    /// erhalten und werden in der UI nur ausgeblendet.
    #[serde(default)]
    pub ai_action_favorites: Vec<String>,
    /// Hash-Pinning fuer favorisierte Custom-Templates: beim Favorisieren
    /// bestaetigter Inhalts-Hash. Weicht das Template auf Disk beim
    /// Schnellzugriff ab, oeffnet das Frontend den Dialog statt direkt
    /// auszufuehren. Built-ins brauchen kein Pinning.
    #[serde(default)]
    pub ai_action_favorite_hashes: BTreeMap<String, String>,
    /// Steuert, ob File-System-Events fuer gepinnte/aufgeklappte
    /// Vault-Ordner einen Tree-Refresh ausloesen. Default an; aus
    /// wenn der User viele Ordner pinnt und FS-Watch-Limits drueckt.
    #[serde(default = "default_true")]
    pub vault_auto_refresh: bool,
    /// Steuert, ob extern geaenderte geoeffnete Dateien automatisch
    /// neugeladen werden (sofern nicht dirty). Default an; aus z.B.
    /// fuer Log-Dateien, wo staendige Reloads die Anzeige stoeren —
    /// stattdessen erscheint ein Reload-Button in der Toolbar.
    #[serde(default = "default_true")]
    pub document_auto_reload: bool,
    /// Startverzeichnis des Export-Dialogs: Verzeichnis des offenen
    /// Dokuments oder das zuletzt fuer einen Export gewaehlte Verzeichnis.
    #[serde(default)]
    pub export_dir_mode: ExportDirMode,
    /// Ziel fuer extern geoeffnete Dateien (siehe [`OpenFileTarget`]).
    #[serde(default)]
    pub open_file_target: OpenFileTarget,
    /// Log-Level fuer den `tracing`-Subscriber. `Off` schaltet die
    /// Ausgabe stumm (Subscriber bleibt registriert, Filter auf
    /// `"off"`). `RUST_LOG`-ENV uebersteuert dies beim Boot und sperrt
    /// den Live-Reload aus dem Settings-UI; Debug-Builds ignorieren
    /// die Einstellung und loggen immer `debug`.
    #[serde(default)]
    pub log_level: LogLevel,
}

fn default_mode_markdown() -> DefaultViewMode {
    DefaultViewMode::Current
}

fn default_mode_text() -> DefaultViewMode {
    DefaultViewMode::Current
}

fn default_true() -> bool {
    true
}

fn default_view_theme() -> String {
    "standard".to_string()
}

impl Default for SettingsData {
    fn default() -> Self {
        Self {
            language: Language::default(),
            default_mode_markdown: default_mode_markdown(),
            default_mode_text: default_mode_text(),
            view_auto_format: default_true(),
            view_theme: default_view_theme(),
            theme_favorites: Vec::new(),
            ai_action_favorites: Vec::new(),
            ai_action_favorite_hashes: BTreeMap::new(),
            vault_auto_refresh: default_true(),
            document_auto_reload: default_true(),
            export_dir_mode: ExportDirMode::default(),
            open_file_target: OpenFileTarget::default(),
            log_level: LogLevel::default(),
        }
    }
}

/// Partial-Update-Payload fuer [`SettingsService::apply_patch`]. Nur
/// gesetzte Felder werden uebernommen — alle anderen bleiben unangetastet.
/// Frontend schickt entsprechend nur die geaenderten Felder.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub language: Option<Language>,
    pub default_mode_markdown: Option<DefaultViewMode>,
    pub default_mode_text: Option<DefaultViewMode>,
    pub view_auto_format: Option<bool>,
    pub view_theme: Option<String>,
    pub theme_favorites: Option<Vec<String>>,
    #[serde(default)]
    pub ai_action_favorites: Option<Vec<String>>,
    #[serde(default)]
    pub ai_action_favorite_hashes: Option<BTreeMap<String, String>>,
    pub vault_auto_refresh: Option<bool>,
    pub document_auto_reload: Option<bool>,
    pub export_dir_mode: Option<ExportDirMode>,
    pub open_file_target: Option<OpenFileTarget>,
    pub log_level: Option<LogLevel>,
}

impl SettingsPatch {
    pub fn is_empty(&self) -> bool {
        self.language.is_none()
            && self.default_mode_markdown.is_none()
            && self.default_mode_text.is_none()
            && self.view_auto_format.is_none()
            && self.view_theme.is_none()
            && self.theme_favorites.is_none()
            && self.ai_action_favorites.is_none()
            && self.ai_action_favorite_hashes.is_none()
            && self.vault_auto_refresh.is_none()
            && self.document_auto_reload.is_none()
            && self.export_dir_mode.is_none()
            && self.open_file_target.is_none()
            && self.log_level.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct SettingsService {
    data: SettingsData,
    path: PathBuf,
}

impl Default for SettingsService {
    fn default() -> Self {
        Self::load()
    }
}

impl SettingsService {
    pub fn load() -> Self {
        Self::load_from(persist::config_file("settings.json"))
    }

    pub fn load_from(path: PathBuf) -> Self {
        let data = persist::load_json(&path);
        Self { data, path }
    }

    pub fn data(&self) -> SettingsData {
        self.data.clone()
    }

    /// Wendet einen Patch an und gibt die Liste der tatsaechlich
    /// geaenderten Feldnamen (camelCase, passend zum Frontend-JSON)
    /// zurueck. Wenn ein Feld auf den gleichen Wert gesetzt wird, wird
    /// es **nicht** in der `changed`-Liste auftauchen — so kann das
    /// Frontend Side-Effects wie Menue-Rebuild gezielt vermeiden.
    pub fn apply_patch(&mut self, patch: SettingsPatch) -> io::Result<Vec<&'static str>> {
        let themes = crate::export::view_themes();
        self.apply_patch_with_view_themes(patch, &themes)
    }

    fn apply_patch_with_view_themes(
        &mut self,
        mut patch: SettingsPatch,
        themes: &[crate::export::LayoutInfo],
    ) -> io::Result<Vec<&'static str>> {
        if let Some(value) = patch.view_theme.as_deref() {
            let valid = themes.iter().any(|theme| theme.id == value);
            if !valid {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("Unbekanntes View-Theme: '{value}'"),
                ));
            }
        }
        if let Some(values) = patch.theme_favorites.as_mut() {
            for value in values.iter() {
                if value == "standard" {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Das Standard-Theme kann kein Favorit sein",
                    ));
                }
                let valid = themes.iter().any(|theme| theme.id == *value);
                if !valid {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("Unbekanntes Theme-Favorit: '{value}'"),
                    ));
                }
            }
            let mut seen = HashSet::new();
            values.retain(|value| seen.insert(value.clone()));
        }
        if let Some(values) = patch.ai_action_favorites.as_mut() {
            // Nur Slug-Form pruefen + first-seen deduplizieren — bewusst
            // keine Existenzvalidierung (s. Feld-Doku).
            for value in values.iter() {
                crate::ai::actions::validate_slug(value, "KI-Aktions-Favorit")
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
            }
            let mut seen = HashSet::new();
            values.retain(|value| seen.insert(value.clone()));
        }
        if let Some(map) = patch.ai_action_favorite_hashes.as_ref() {
            for id in map.keys() {
                crate::ai::actions::validate_slug(id, "KI-Aktions-Favorit")
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
            }
        }
        let mut changed: Vec<&'static str> = Vec::new();
        if let Some(value) = patch.language {
            if self.data.language != value {
                self.data.language = value;
                changed.push("language");
            }
        }
        if let Some(value) = patch.default_mode_markdown {
            if self.data.default_mode_markdown != value {
                self.data.default_mode_markdown = value;
                changed.push("defaultModeMarkdown");
            }
        }
        if let Some(value) = patch.default_mode_text {
            if self.data.default_mode_text != value {
                self.data.default_mode_text = value;
                changed.push("defaultModeText");
            }
        }
        if let Some(value) = patch.view_auto_format {
            if self.data.view_auto_format != value {
                self.data.view_auto_format = value;
                changed.push("viewAutoFormat");
            }
        }
        if let Some(value) = patch.view_theme {
            if self.data.view_theme != value {
                self.data.view_theme = value;
                changed.push("viewTheme");
            }
        }
        if let Some(value) = patch.theme_favorites {
            if self.data.theme_favorites != value {
                self.data.theme_favorites = value;
                changed.push("themeFavorites");
            }
        }
        if let Some(value) = patch.ai_action_favorites {
            if self.data.ai_action_favorites != value {
                self.data.ai_action_favorites = value;
                changed.push("aiActionFavorites");
            }
        }
        if let Some(value) = patch.ai_action_favorite_hashes {
            if self.data.ai_action_favorite_hashes != value {
                self.data.ai_action_favorite_hashes = value;
                changed.push("aiActionFavoriteHashes");
            }
        }
        if let Some(value) = patch.vault_auto_refresh {
            if self.data.vault_auto_refresh != value {
                self.data.vault_auto_refresh = value;
                changed.push("vaultAutoRefresh");
            }
        }
        if let Some(value) = patch.document_auto_reload {
            if self.data.document_auto_reload != value {
                self.data.document_auto_reload = value;
                changed.push("documentAutoReload");
            }
        }
        if let Some(value) = patch.export_dir_mode {
            if self.data.export_dir_mode != value {
                self.data.export_dir_mode = value;
                changed.push("exportDirMode");
            }
        }
        if let Some(value) = patch.open_file_target {
            if self.data.open_file_target != value {
                self.data.open_file_target = value;
                changed.push("openFileTarget");
            }
        }
        if let Some(value) = patch.log_level {
            if self.data.log_level != value {
                self.data.log_level = value;
                changed.push("logLevel");
            }
        }
        if !changed.is_empty() {
            persist::save_json_atomic(&self.path, &self.data)?;
        }
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn defaults_match_expected() {
        let data = SettingsData::default();
        assert_eq!(Language::De, data.language);
        assert_eq!(DefaultViewMode::Current, data.default_mode_markdown);
        assert_eq!(DefaultViewMode::Current, data.default_mode_text);
        assert!(data.view_auto_format);
        assert_eq!("standard", data.view_theme);
        assert!(data.theme_favorites.is_empty());
        assert!(data.vault_auto_refresh);
        assert!(data.document_auto_reload);
        assert_eq!(ExportDirMode::Document, data.export_dir_mode);
        assert_eq!(OpenFileTarget::Newtab, data.open_file_target);
        assert_eq!(LogLevel::Info, data.log_level);
    }

    #[test]
    fn open_file_target_round_trips_and_rejects_unknown() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());
        let changed = svc
            .apply_patch(SettingsPatch {
                open_file_target: Some(OpenFileTarget::Replace),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(vec!["openFileTarget"], changed);
        assert_eq!(
            OpenFileTarget::Replace,
            SettingsService::load_from(path.clone())
                .data()
                .open_file_target
        );

        // Unbekannter Wert in settings.json -> Default statt Crash.
        std::fs::write(&path, r#"{"openFileTarget":"popup"}"#).unwrap();
        let svc = SettingsService::load_from(path);
        assert_eq!(OpenFileTarget::Newtab, svc.data().open_file_target);
    }

    #[test]
    fn export_dir_mode_patch_round_trips() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());
        let changed = svc
            .apply_patch(SettingsPatch {
                export_dir_mode: Some(ExportDirMode::Last),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(vec!["exportDirMode"], changed);
        let reloaded = SettingsService::load_from(path).data();
        assert_eq!(ExportDirMode::Last, reloaded.export_dir_mode);
    }

    #[test]
    fn view_theme_patch_round_trips_and_rejects_unknown_ids() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());
        let changed = svc
            .apply_patch(SettingsPatch {
                view_theme: Some("github".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(vec!["viewTheme"], changed);
        assert_eq!("github", SettingsService::load_from(path).data().view_theme);

        let error = svc
            .apply_patch(SettingsPatch {
                view_theme: Some("gibtsnicht".to_string()),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(io::ErrorKind::InvalidInput, error.kind());
        assert_eq!("github", svc.data().view_theme);
    }

    #[test]
    fn view_theme_patch_accepts_injected_custom_theme() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());
        let themes = vec![crate::export::LayoutInfo {
            id: "mein-theme".to_string(),
            name: "Mein Theme".to_string(),
            description: "Eigenes Theme".to_string(),
            has_dark: false,
            custom: true,
        }];
        let changed = svc
            .apply_patch_with_view_themes(
                SettingsPatch {
                    view_theme: Some("mein-theme".to_string()),
                    ..Default::default()
                },
                &themes,
            )
            .unwrap();

        assert_eq!(vec!["viewTheme"], changed);
        assert_eq!(
            "mein-theme",
            SettingsService::load_from(path).data().view_theme
        );
    }

    #[test]
    fn unknown_view_theme_is_preserved_on_load() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, r#"{"viewTheme":"alt-theme"}"#).unwrap();
        let svc = SettingsService::load_from(path);
        assert_eq!("alt-theme", svc.data().view_theme);
    }

    #[test]
    fn ai_action_favorites_accept_unknown_ids_dedupe_and_reject_bad_slugs() {
        let temp = TempDir::new().unwrap();
        let mut service = SettingsService::load_from(temp.path().join("settings.json"));

        // Unbekannte (aber wohlgeformte) IDs sind erlaubt — bewusst keine
        // Existenzvalidierung; first-seen-Dedupe.
        let changed = service
            .apply_patch(SettingsPatch {
                ai_action_favorites: Some(vec![
                    "summarize".to_string(),
                    "verschwunden".to_string(),
                    "summarize".to_string(),
                ]),
                ..SettingsPatch::default()
            })
            .unwrap();
        assert_eq!(vec!["aiActionFavorites"], changed);
        assert_eq!(
            vec!["summarize".to_string(), "verschwunden".to_string()],
            service.data().ai_action_favorites
        );

        // Slug-Form wird geprueft.
        assert!(service
            .apply_patch(SettingsPatch {
                ai_action_favorites: Some(vec!["../boese".to_string()]),
                ..SettingsPatch::default()
            })
            .is_err());

        // Hash-Pinning-Map: Keys werden slug-validiert, Werte frei.
        let mut hashes = std::collections::BTreeMap::new();
        hashes.insert("eigenes".to_string(), "abc123".to_string());
        let changed = service
            .apply_patch(SettingsPatch {
                ai_action_favorite_hashes: Some(hashes.clone()),
                ..SettingsPatch::default()
            })
            .unwrap();
        assert_eq!(vec!["aiActionFavoriteHashes"], changed);
        assert_eq!(hashes, service.data().ai_action_favorite_hashes);
    }

    #[test]
    fn theme_favorites_patch_sets_replaces_and_clears_list() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());

        let changed = svc
            .apply_patch(SettingsPatch {
                theme_favorites: Some(vec!["github".to_string(), "clean".to_string()]),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(vec!["themeFavorites"], changed);
        assert_eq!(
            vec!["github".to_string(), "clean".to_string()],
            SettingsService::load_from(path.clone())
                .data()
                .theme_favorites
        );

        svc.apply_patch(SettingsPatch {
            theme_favorites: Some(vec!["classic".to_string()]),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            vec!["classic".to_string()],
            SettingsService::load_from(path.clone())
                .data()
                .theme_favorites
        );

        svc.apply_patch(SettingsPatch {
            theme_favorites: Some(Vec::new()),
            ..Default::default()
        })
        .unwrap();
        assert!(SettingsService::load_from(path)
            .data()
            .theme_favorites
            .is_empty());
    }

    #[test]
    fn theme_favorites_patch_rejects_unknown_and_standard_ids() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path);

        for invalid in ["gibtsnicht", "standard"] {
            let error = svc
                .apply_patch(SettingsPatch {
                    theme_favorites: Some(vec![invalid.to_string()]),
                    ..Default::default()
                })
                .unwrap_err();
            assert_eq!(io::ErrorKind::InvalidInput, error.kind());
            assert!(svc.data().theme_favorites.is_empty());
        }
    }

    #[test]
    fn theme_favorites_patch_deduplicates_in_first_seen_order() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path);

        svc.apply_patch(SettingsPatch {
            theme_favorites: Some(vec![
                "github".to_string(),
                "clean".to_string(),
                "github".to_string(),
                "classic".to_string(),
                "clean".to_string(),
            ]),
            ..Default::default()
        })
        .unwrap();

        assert_eq!(
            vec![
                "github".to_string(),
                "clean".to_string(),
                "classic".to_string()
            ],
            svc.data().theme_favorites
        );
    }

    #[test]
    fn unknown_theme_favorite_is_preserved_on_load() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, r#"{"themeFavorites":["alt-theme","github"]}"#).unwrap();
        let svc = SettingsService::load_from(path);
        assert_eq!(
            vec!["alt-theme".to_string(), "github".to_string()],
            svc.data().theme_favorites
        );
    }

    #[test]
    fn export_dir_mode_deserializes_from_camel_case_patch() {
        let patch: SettingsPatch = serde_json::from_str(r#"{"exportDirMode":"last"}"#).unwrap();
        assert_eq!(Some(ExportDirMode::Last), patch.export_dir_mode);
    }

    #[test]
    fn unknown_export_dir_mode_falls_back_to_default_on_load() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, r#"{"exportDirMode":"unknown"}"#).unwrap();
        let svc = SettingsService::load_from(path);
        assert_eq!(ExportDirMode::Document, svc.data().export_dir_mode);
    }

    #[test]
    fn log_level_round_trips() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());
        let changed = svc
            .apply_patch(SettingsPatch {
                log_level: Some(LogLevel::Debug),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(vec!["logLevel"], changed);
        let reloaded = SettingsService::load_from(path).data();
        assert_eq!(LogLevel::Debug, reloaded.log_level);
    }

    #[test]
    fn all_log_levels_round_trip_through_json() {
        // Jede Variante muss persistierbar + reloadbar sein.
        for level in [
            LogLevel::Off,
            LogLevel::Error,
            LogLevel::Warn,
            LogLevel::Info,
            LogLevel::Debug,
        ] {
            let temp = TempDir::new().unwrap();
            let path = temp.path().join("settings.json");
            let mut svc = SettingsService::load_from(path.clone());
            svc.apply_patch(SettingsPatch {
                log_level: Some(level),
                ..Default::default()
            })
            .unwrap();
            let reloaded = SettingsService::load_from(path).data();
            assert_eq!(level, reloaded.log_level, "Roundtrip {level:?}");
        }
    }

    #[test]
    fn unknown_log_level_falls_back_to_default() {
        // Wenn `settings.json` einen unbekannten Wert enthaelt (manuelle
        // Edits, alter Build), soll das Laden die Defaults benutzen und
        // nicht crashen.
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, r#"{"logLevel":"silly"}"#).unwrap();
        let svc = SettingsService::load_from(path);
        assert_eq!(LogLevel::Info, svc.data().log_level);
    }

    #[test]
    fn log_levels_serialize_lowercase() {
        // Frontend erwartet lowercase-Strings ('off', 'error', ...);
        // der TS-Type-Guard `isLogLevel` matcht nur dagegen.
        for (level, expected) in [
            (LogLevel::Off, "off"),
            (LogLevel::Error, "error"),
            (LogLevel::Warn, "warn"),
            (LogLevel::Info, "info"),
            (LogLevel::Debug, "debug"),
        ] {
            let json = serde_json::to_string(&level).unwrap();
            assert_eq!(format!("\"{expected}\""), json);
        }
    }

    #[test]
    fn enums_serialize_lowercase() {
        let data = SettingsData::default();
        let json = serde_json::to_string(&data).unwrap();
        assert!(json.contains("\"language\":\"de\""), "got: {json}");
        assert!(
            json.contains("\"defaultModeMarkdown\":\"current\""),
            "got: {json}"
        );
        assert!(
            json.contains("\"defaultModeText\":\"current\""),
            "got: {json}"
        );
        assert!(
            json.contains("\"exportDirMode\":\"document\""),
            "got: {json}"
        );
    }

    #[test]
    fn explicit_modes_round_trip() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());
        svc.apply_patch(SettingsPatch {
            default_mode_markdown: Some(DefaultViewMode::View),
            default_mode_text: Some(DefaultViewMode::Edit),
            ..Default::default()
        })
        .unwrap();
        let reloaded = SettingsService::load_from(path).data();
        assert_eq!(DefaultViewMode::View, reloaded.default_mode_markdown);
        assert_eq!(DefaultViewMode::Edit, reloaded.default_mode_text);
    }

    #[test]
    fn missing_file_yields_defaults() {
        let temp = TempDir::new().unwrap();
        let svc = SettingsService::load_from(temp.path().join("settings.json"));
        assert_eq!(SettingsData::default(), svc.data());
    }

    #[test]
    fn patch_records_only_real_changes() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());

        let changed = svc
            .apply_patch(SettingsPatch {
                language: Some(Language::De), // gleicher Wert wie default
                view_auto_format: Some(false),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(vec!["viewAutoFormat"], changed);

        let reloaded = SettingsService::load_from(path).data();
        assert!(!reloaded.view_auto_format);
        assert_eq!(Language::De, reloaded.language);
    }

    #[test]
    fn patch_persists_all_set_fields() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());
        let changed = svc
            .apply_patch(SettingsPatch {
                language: Some(Language::En),
                default_mode_markdown: Some(DefaultViewMode::Edit),
                default_mode_text: Some(DefaultViewMode::View),
                view_auto_format: Some(false),
                view_theme: Some("clean".to_string()),
                theme_favorites: Some(vec!["github".to_string()]),
                ai_action_favorites: Some(vec!["summarize".to_string()]),
                ai_action_favorite_hashes: Some(std::collections::BTreeMap::from([(
                    "eigenes".to_string(),
                    "hash".to_string(),
                )])),
                vault_auto_refresh: Some(false),
                document_auto_reload: Some(false),
                export_dir_mode: Some(ExportDirMode::Last),
                open_file_target: Some(OpenFileTarget::Replace),
                log_level: Some(LogLevel::Debug),
            })
            .unwrap();
        assert_eq!(13, changed.len());

        let reloaded = SettingsService::load_from(path).data();
        assert_eq!(Language::En, reloaded.language);
        assert_eq!(DefaultViewMode::Edit, reloaded.default_mode_markdown);
        assert_eq!(DefaultViewMode::View, reloaded.default_mode_text);
        assert!(!reloaded.view_auto_format);
        assert_eq!("clean", reloaded.view_theme);
        assert_eq!(vec!["github".to_string()], reloaded.theme_favorites);
        assert_eq!(ExportDirMode::Last, reloaded.export_dir_mode);
        assert_eq!(OpenFileTarget::Replace, reloaded.open_file_target);
    }

    #[test]
    fn empty_patch_does_not_write_file() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let mut svc = SettingsService::load_from(path.clone());
        let changed = svc.apply_patch(SettingsPatch::default()).unwrap();
        assert!(changed.is_empty());
        assert!(!path.exists(), "no patch fields → no write");
    }

    #[test]
    fn invalid_enum_falls_back_to_default_on_load() {
        // Wenn das JSON kaputt ist (z. B. unbekannter Sprachcode),
        // soll der Service auf Defaults zurueckfallen statt zu crashen.
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, r#"{"language":"xx"}"#).unwrap();
        let svc = SettingsService::load_from(path);
        assert_eq!(SettingsData::default(), svc.data());
    }
}
