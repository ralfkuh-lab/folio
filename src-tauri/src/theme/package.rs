use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const MANIFEST_FILE: &str = "theme.json";
const CONTENT_CSS_FILE: &str = "content.css";
const DARK_CSS_FILE: &str = "content.dark.css";
const PAGE_CSS_FILE: &str = "page.css";
const COVER_FILE: &str = "cover.html";
const HEADER_FILE: &str = "header.html";
const FOOTER_FILE: &str = "footer.html";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeManifest {
    pub name: String,
    pub description: String,
    pub code: String,
    pub logo: Option<String>,
    pub cover: bool,
    pub header: bool,
    pub footer: bool,
    pub hide_inline_frontmatter: bool,
    pub format_version: u32,
}

impl Default for ThemeManifest {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            code: "light".to_string(),
            logo: None,
            cover: false,
            header: false,
            footer: false,
            hide_inline_frontmatter: false,
            format_version: 1,
        }
    }
}

impl ThemeManifest {
    pub fn code_is_dark(&self) -> bool {
        self.code == "dark"
    }

    pub(crate) fn normalize(mut self, id: &str, path: &Path) -> Self {
        if self.name.trim().is_empty() {
            self.name = id.to_string();
        }
        if self.description.trim().is_empty() {
            self.description = "Eigenes Theme".to_string();
        }
        self.code = match self.code.trim().to_ascii_lowercase().as_str() {
            "dark" => "dark".to_string(),
            "light" | "" => "light".to_string(),
            value => {
                tracing::warn!(
                    target: "folio::settings",
                    theme_id = id,
                    path = %path.display(),
                    code = value,
                    "Unbekannter code-Wert im Theme-Manifest; Light wird verwendet"
                );
                "light".to_string()
            }
        };
        if self.format_version == 0 {
            tracing::warn!(
                target: "folio::settings",
                theme_id = id,
                path = %path.display(),
                "formatVersion 0 im Theme-Manifest; Version 1 wird verwendet"
            );
            self.format_version = 1;
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemeSource {
    Builtin,
    Directory,
    LegacyFlat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemePackage {
    pub id: String,
    pub content_css: String,
    pub dark_css: Option<String>,
    pub page_css: Option<String>,
    pub cover_html: Option<String>,
    pub header_html: Option<String>,
    pub footer_html: Option<String>,
    pub manifest: ThemeManifest,
    pub source: ThemeSource,
    pub dir: Option<PathBuf>,
}

pub fn load_package(id: &str, themes_dir: &Path) -> Option<ThemePackage> {
    if !super::valid_theme_id(id) {
        return None;
    }

    let package_dir = themes_dir.join(id);
    let manifest_path = package_dir.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        return None;
    }

    let manifest_json = read_required(&manifest_path, id, "Theme-Manifest")?;
    let manifest = match serde_json::from_str::<ThemeManifest>(&manifest_json) {
        Ok(manifest) => manifest.normalize(id, &manifest_path),
        Err(error) => {
            tracing::warn!(
                target: "folio::settings",
                theme_id = id,
                path = %manifest_path.display(),
                %error,
                "Theme-Manifest kann nicht geparst werden"
            );
            return None;
        }
    };

    let content_path = package_dir.join(CONTENT_CSS_FILE);
    if !content_path.is_file() {
        tracing::warn!(
            target: "folio::settings",
            theme_id = id,
            path = %content_path.display(),
            "Verzeichnis-Theme hat kein content.css und wird ignoriert"
        );
        return None;
    }
    let content_css = read_required(&content_path, id, "Content-CSS")?;

    Some(ThemePackage {
        id: id.to_string(),
        content_css,
        dark_css: read_optional(&package_dir.join(DARK_CSS_FILE), id, "Dark-CSS"),
        page_css: read_optional(&package_dir.join(PAGE_CSS_FILE), id, "Page-CSS"),
        cover_html: read_optional(&package_dir.join(COVER_FILE), id, "Cover-Template"),
        header_html: read_optional(&package_dir.join(HEADER_FILE), id, "Header-Template"),
        footer_html: read_optional(&package_dir.join(FOOTER_FILE), id, "Footer-Template"),
        manifest,
        source: ThemeSource::Directory,
        dir: Some(package_dir),
    })
}

pub(crate) fn load_legacy_package(id: &str, themes_dir: &Path) -> Option<ThemePackage> {
    if !super::valid_theme_id(id) {
        return None;
    }
    let content_path = themes_dir.join(format!("{id}.css"));
    let content_css = read_required(&content_path, id, "Legacy-Theme-CSS")?;
    let metadata = parse_legacy_metadata(&content_css);
    let manifest = ThemeManifest {
        name: metadata.name.unwrap_or_else(|| id.to_string()),
        description: metadata
            .description
            .unwrap_or_else(|| "Eigenes Theme".to_string()),
        code: if metadata.code_dark {
            "dark".to_string()
        } else {
            "light".to_string()
        },
        ..ThemeManifest::default()
    };

    Some(ThemePackage {
        id: id.to_string(),
        content_css,
        dark_css: read_optional(&themes_dir.join(format!("{id}.dark.css")), id, "Dark-CSS"),
        page_css: read_optional(&themes_dir.join(format!("{id}.page.css")), id, "Page-CSS"),
        cover_html: None,
        header_html: None,
        footer_html: None,
        manifest,
        source: ThemeSource::LegacyFlat,
        dir: Some(themes_dir.to_path_buf()),
    })
}

fn read_required(path: &Path, id: &str, kind: &str) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(content) => Some(content),
        Err(error) => {
            tracing::warn!(
                target: "folio::settings",
                theme_id = id,
                path = %path.display(),
                %error,
                "{kind} kann nicht gelesen werden"
            );
            None
        }
    }
}

fn read_optional(path: &Path, id: &str, kind: &str) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            tracing::warn!(
                target: "folio::settings",
                theme_id = id,
                path = %path.display(),
                %error,
                "{kind} kann nicht gelesen werden und wird ignoriert"
            );
            None
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct LegacyMetadata {
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) code_dark: bool,
}

pub(crate) fn parse_legacy_metadata(css: &str) -> LegacyMetadata {
    let mut metadata = LegacyMetadata::default();
    for line in css.lines().take(10) {
        let line = line.trim();
        let Some(comment) = line
            .strip_prefix("/*")
            .and_then(|line| line.strip_suffix("*/"))
        else {
            continue;
        };
        let Some((key, value)) = comment.trim().split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.eq_ignore_ascii_case("name") && !value.is_empty() {
            metadata.name = Some(value.to_string());
        } else if key.eq_ignore_ascii_case("description") && !value.is_empty() {
            metadata.description = Some(value.to_string());
        } else if key.eq_ignore_ascii_case("code") {
            metadata.code_dark = match value.to_ascii_lowercase().as_str() {
                "dark" => true,
                "light" => false,
                _ => {
                    tracing::warn!(
                        target: "folio::settings",
                        value,
                        "Unbekannter code-Metadatenwert im Custom-Theme; Light wird verwendet"
                    );
                    false
                }
            };
        }
    }
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_defaults_and_camel_case_fields_are_loaded() {
        let temp = tempfile::tempdir().unwrap();
        let theme_dir = temp.path().join("corp");
        fs::create_dir(&theme_dir).unwrap();
        fs::write(
            theme_dir.join("theme.json"),
            r#"{
                "name": "",
                "code": "DARK",
                "logo": "logo.svg",
                "cover": true,
                "header": true,
                "footer": true,
                "hideInlineFrontmatter": true,
                "formatVersion": 0
            }"#,
        )
        .unwrap();
        fs::write(theme_dir.join("content.css"), ".markdown-body {}").unwrap();

        let package = load_package("corp", temp.path()).unwrap();
        assert_eq!("corp", package.manifest.name);
        assert_eq!("Eigenes Theme", package.manifest.description);
        assert_eq!("dark", package.manifest.code);
        assert_eq!(Some("logo.svg"), package.manifest.logo.as_deref());
        assert!(package.manifest.cover);
        assert!(package.manifest.header);
        assert!(package.manifest.footer);
        assert!(package.manifest.hide_inline_frontmatter);
        assert_eq!(1, package.manifest.format_version);
    }

    #[test]
    fn malformed_manifest_and_missing_content_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let malformed = temp.path().join("malformed");
        fs::create_dir(&malformed).unwrap();
        fs::write(malformed.join("theme.json"), "{").unwrap();
        fs::write(malformed.join("content.css"), ".markdown-body {}").unwrap();
        assert!(load_package("malformed", temp.path()).is_none());

        let incomplete = temp.path().join("incomplete");
        fs::create_dir(&incomplete).unwrap();
        fs::write(incomplete.join("theme.json"), "{}").unwrap();
        assert!(load_package("incomplete", temp.path()).is_none());
    }

    #[test]
    fn legacy_metadata_is_case_insensitive_and_has_light_fallback() {
        let metadata = parse_legacy_metadata(
            "/* NAME: Mein Theme */\n/* Description: Ruhig */\n/* CODE: DARK */",
        );
        assert_eq!(Some("Mein Theme"), metadata.name.as_deref());
        assert_eq!(Some("Ruhig"), metadata.description.as_deref());
        assert!(metadata.code_dark);
        assert!(!parse_legacy_metadata("/* code: sepia */").code_dark);
    }
}
