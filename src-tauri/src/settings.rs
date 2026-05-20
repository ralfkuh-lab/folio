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
use std::{io, path::PathBuf};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsData {
    #[serde(default)]
    pub language: Language,
    #[serde(default = "default_mode_markdown")]
    pub default_mode_markdown: DefaultViewMode,
    #[serde(default = "default_mode_text")]
    pub default_mode_text: DefaultViewMode,
    #[serde(default = "default_view_auto_format")]
    pub view_auto_format: bool,
}

fn default_mode_markdown() -> DefaultViewMode {
    DefaultViewMode::Current
}

fn default_mode_text() -> DefaultViewMode {
    DefaultViewMode::Current
}

fn default_view_auto_format() -> bool {
    true
}

impl Default for SettingsData {
    fn default() -> Self {
        Self {
            language: Language::default(),
            default_mode_markdown: default_mode_markdown(),
            default_mode_text: default_mode_text(),
            view_auto_format: default_view_auto_format(),
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
}

impl SettingsPatch {
    pub fn is_empty(&self) -> bool {
        self.language.is_none()
            && self.default_mode_markdown.is_none()
            && self.default_mode_text.is_none()
            && self.view_auto_format.is_none()
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
            })
            .unwrap();
        assert_eq!(4, changed.len());

        let reloaded = SettingsService::load_from(path).data();
        assert_eq!(Language::En, reloaded.language);
        assert_eq!(DefaultViewMode::Edit, reloaded.default_mode_markdown);
        assert_eq!(DefaultViewMode::View, reloaded.default_mode_text);
        assert!(!reloaded.view_auto_format);
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
