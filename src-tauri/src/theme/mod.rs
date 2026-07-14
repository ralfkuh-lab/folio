pub mod archive;
pub mod assets;
pub mod author;
pub mod builtin;
pub mod package;
pub mod service;
pub mod store;
pub mod template;

use crate::persist;
use package::{validate_font_family, validate_font_size, ThemeManifest, ThemePackage, ThemeSource};
use serde::Serialize;
pub use service::{ThemeData, ThemeService};
use std::{borrow::Cow, collections::HashSet, fs, io, path::Path};

pub(crate) const DEFAULT_PAGE_CSS: &str = "html, body { background: #fff; }\nbody { margin: 0; }";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub has_dark: bool,
    pub custom: bool,
}

pub fn layouts() -> Vec<LayoutInfo> {
    layouts_in(&persist::themes_dir())
}

pub fn view_themes() -> Vec<LayoutInfo> {
    view_themes_in(&persist::themes_dir())
}

pub fn custom_themes() -> Vec<LayoutInfo> {
    custom_themes_in(&persist::themes_dir())
}

pub(crate) fn layouts_in(dir: &Path) -> Vec<LayoutInfo> {
    discover_in(dir)
        .into_iter()
        .filter(|package| package.id != "standard")
        .map(|package| layout_info(&package))
        .collect()
}

pub(crate) fn view_themes_in(dir: &Path) -> Vec<LayoutInfo> {
    discover_in(dir).iter().map(layout_info).collect::<Vec<_>>()
}

pub(crate) fn custom_themes_in(dir: &Path) -> Vec<LayoutInfo> {
    discover_in(dir)
        .into_iter()
        .filter(|package| package.source != ThemeSource::Builtin)
        .map(|package| layout_info(&package))
        .collect()
}

pub fn layout_css(id: &str, dark: bool) -> Option<Cow<'static, str>> {
    layout_css_in(id, dark, &persist::themes_dir())
}

pub(crate) fn layout_css_in(id: &str, dark: bool, dir: &Path) -> Option<Cow<'static, str>> {
    if !valid_theme_id(id) || id == "standard" {
        return None;
    }
    let package = package_in(id, dir)?;
    Some(Cow::Owned(content_css(&package, dark)))
}

pub fn view_theme_css(theme_id: &str, dark: bool) -> Result<Cow<'static, str>, String> {
    view_theme_css_in(theme_id, dark, &persist::themes_dir())
}

pub(crate) fn view_theme_css_in(
    theme_id: &str,
    dark: bool,
    dir: &Path,
) -> Result<Cow<'static, str>, String> {
    if !valid_theme_id(theme_id) {
        return Err(format!("unknown view theme: '{theme_id}'"));
    }
    if theme_id == "standard" {
        return Ok(Cow::Borrowed(""));
    }
    let package =
        package_in(theme_id, dir).ok_or_else(|| format!("unknown view theme: '{theme_id}'"))?;
    let css = content_css(&package, dark);
    let css = match package.dir.as_deref() {
        Some(theme_dir) => {
            let refs = assets::collect_references(&css, "", [None, None, None]);
            if refs.is_empty() {
                css
            } else {
                let asset_pairs = assets::load_assets(theme_dir, &refs)?;
                assets::rewrite_asset_urls(&css, &asset_pairs)
            }
        }
        None => css,
    };
    Ok(Cow::Owned(css))
}

pub(crate) fn layout_code_dark_in(id: &str, dir: &Path) -> bool {
    package_in(id, dir).is_some_and(|package| package.manifest.code_is_dark())
}

pub(crate) fn page_css_in(id: &str, dir: &Path) -> Option<Cow<'static, str>> {
    if !valid_theme_id(id) || id == "standard" {
        return None;
    }
    let package = package_in(id, dir)?;
    Some(Cow::Owned(
        package
            .page_css
            .unwrap_or_else(|| DEFAULT_PAGE_CSS.to_string()),
    ))
}

pub(crate) fn valid_theme_id(id: &str) -> bool {
    // `:` mit abfangen: auf Windows waere `C:evil` ein laufwerks-
    // relativer Pfad und `dir.join(..)` verliesse das Themes-Verzeichnis.
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains(':')
        && !id.contains("..")
        && !id.ends_with(".dark")
        && !id.ends_with(".page")
}

fn content_css(package: &ThemePackage, dark: bool) -> String {
    let css = match (dark, package.dark_css.as_deref()) {
        (true, Some(dark_css)) => format!("{}\n{dark_css}", package.content_css),
        _ => package.content_css.clone(),
    };
    match font_css(&package.manifest) {
        Some(font_css) => format!("{css}\n{font_css}"),
        None => css,
    }
}

pub fn font_css(manifest: &ThemeManifest) -> Option<String> {
    let mut body = Vec::new();
    if let Some(font_body) = manifest
        .font_body
        .as_deref()
        .and_then(|value| validate_font_family(value).ok())
    {
        body.push(format!("font-family: {font_body};"));
    }
    if let Some(font_size) = manifest
        .font_size
        .as_deref()
        .and_then(|value| validate_font_size(value).ok())
    {
        body.push(format!("font-size: {font_size};"));
    }
    let mut css = String::new();
    if !body.is_empty() {
        css.push_str(".markdown-body { ");
        css.push_str(&body.join(" "));
        css.push_str(" }\n");
    }
    if let Some(font_mono) = manifest
        .font_mono
        .as_deref()
        .and_then(|value| validate_font_family(value).ok())
    {
        css.push_str(".markdown-body code, .markdown-body pre, .markdown-body kbd,\n");
        css.push_str(".markdown-body samp, .markdown-body tt { font-family: ");
        css.push_str(&font_mono);
        css.push_str("; }\n");
    }
    if css.is_empty() {
        None
    } else {
        Some(css.trim_end().to_string())
    }
}

pub(crate) fn layout_info(package: &ThemePackage) -> LayoutInfo {
    LayoutInfo {
        id: package.id.clone(),
        name: package.manifest.name.clone(),
        description: package.manifest.description.clone(),
        has_dark: package.id == "standard" || package.dark_css.is_some(),
        custom: package.source != ThemeSource::Builtin,
    }
}

pub fn package(id: &str) -> Option<ThemePackage> {
    package_in(id, &persist::themes_dir())
}

pub(crate) fn package_in(id: &str, dir: &Path) -> Option<ThemePackage> {
    if !valid_theme_id(id) {
        return None;
    }
    discover_in(dir)
        .into_iter()
        .find(|package| package.id == id)
}

fn discover_in(dir: &Path) -> Vec<ThemePackage> {
    let builtins = builtin::packages();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return builtins,
        Err(error) => {
            tracing::warn!(
                target: "folio::settings",
                path = %dir.display(),
                %error,
                "Custom-Theme-Verzeichnis kann nicht gelesen werden"
            );
            return builtins;
        }
    };

    let mut paths = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => paths.push(entry.path()),
            Err(error) => {
                tracing::warn!(
                    target: "folio::settings",
                    path = %dir.display(),
                    %error,
                    "Eintrag im Custom-Theme-Verzeichnis kann nicht gelesen werden"
                );
            }
        }
    }

    let mut claimed: HashSet<String> = builtin::IDS.iter().map(|id| (*id).to_string()).collect();
    let mut custom = Vec::new();

    for path in paths.iter().filter(|path| path.is_dir()) {
        if !path.join("theme.json").is_file() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            warn_invalid_path(path, "Theme-Verzeichnisname ist kein gueltiges UTF-8");
            continue;
        };
        if !valid_theme_id(id) {
            warn_invalid_path(path, "Verzeichnis-Theme hat eine ungueltige ID");
            continue;
        }
        if claimed.contains(id) {
            warn_collision(id, path, "eingebauten Theme");
            continue;
        }
        if let Some(package) = package::load_package(id, dir) {
            claimed.insert(id.to_string());
            custom.push(package);
        }
    }

    for path in paths.iter().filter(|path| path.is_file()) {
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            warn_invalid_path(path, "Custom-Theme-Dateiname ist kein gueltiges UTF-8");
            continue;
        };
        if !file_name.ends_with(".css")
            || file_name.ends_with(".dark.css")
            || file_name.ends_with(".page.css")
        {
            continue;
        }
        let id = file_name.trim_end_matches(".css");
        if !valid_theme_id(id) {
            warn_invalid_path(path, "Legacy-Theme hat eine ungueltige ID");
            continue;
        }
        if claimed.contains(id) {
            let winner = if builtin::IDS.contains(&id) {
                "eingebauten Theme"
            } else {
                "Verzeichnis-Theme"
            };
            warn_collision(id, path, winner);
            continue;
        }
        if let Some(package) = package::load_legacy_package(id, dir) {
            claimed.insert(id.to_string());
            custom.push(package);
        }
    }

    custom.sort_by(|left, right| left.id.cmp(&right.id));
    let mut result = builtins;
    result.extend(custom);
    result
}

fn warn_invalid_path(path: &Path, message: &str) {
    tracing::warn!(
        target: "folio::settings",
        path = %path.display(),
        "{message}"
    );
}

fn warn_collision(id: &str, path: &Path, winner: &str) {
    tracing::warn!(
        target: "folio::settings",
        theme_id = id,
        path = %path.display(),
        "Theme kollidiert mit einem {winner} und wird ignoriert"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_css_handles_partial_and_full_manifest_fields() {
        assert_eq!(None, font_css(&ThemeManifest::default()));

        let body = ThemeManifest {
            font_body: Some("Georgia, serif".to_string()),
            font_size: Some("16px".to_string()),
            ..ThemeManifest::default()
        };
        let css = font_css(&body).unwrap();
        assert!(css.contains(".markdown-body { font-family: Georgia, serif; font-size: 16px; }"));
        assert!(!css.contains("code,"));

        let mono = ThemeManifest {
            font_mono: Some("ui-monospace, monospace".to_string()),
            ..ThemeManifest::default()
        };
        let css = font_css(&mono).unwrap();
        assert!(css.contains(
            ".markdown-body samp, .markdown-body tt { font-family: ui-monospace, monospace; }"
        ));
    }

    #[test]
    fn font_manifest_sanitizer_accepts_and_rejects_expected_values() {
        let manifest = ThemeManifest {
            font_body: Some("Inter, system-ui, sans-serif".to_string()),
            font_mono: Some("\"JetBrains Mono\", ui-monospace".to_string()),
            font_size: Some("1.05rem".to_string()),
            ..ThemeManifest::default()
        };
        assert!(package::validate_manifest_fonts(&manifest).is_ok());

        for (field, value) in [
            ("font_body", "Inter; body { color: red }"),
            ("font_body", "url(asset:font.woff2)"),
            ("font_mono", "@font-face"),
            ("font_mono", "Mono <script>"),
            ("font_body", r"ur\6c(asset:font.woff2)"),
            ("font_body", r"url\28 http://evil"),
            ("font_mono", r"Mono\7d body"),
            ("font_size", "calc(1rem + 1px)"),
            ("font_size", "12 px"),
        ] {
            let mut manifest = ThemeManifest::default();
            match field {
                "font_body" => manifest.font_body = Some(value.to_string()),
                "font_mono" => manifest.font_mono = Some(value.to_string()),
                "font_size" => manifest.font_size = Some(value.to_string()),
                _ => unreachable!(),
            }
            assert!(
                package::validate_manifest_fonts(&manifest).is_err(),
                "{field}={value}"
            );
        }
    }

    #[test]
    fn invalid_font_manifest_fields_are_dropped_on_load() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("badfonts");
        fs::create_dir(&directory).unwrap();
        fs::write(
            directory.join("theme.json"),
            r#"{
                "name": "Bad Fonts",
                "description": "Invalid",
                "fontBody": "Inter; body { color: red }",
                "fontMono": "url(asset:mono.woff2)",
                "fontSize": "calc(1rem + 1px)"
            }"#,
        )
        .unwrap();
        fs::write(directory.join("content.css"), ".markdown-body {}").unwrap();

        let package = package_in("badfonts", temp.path()).unwrap();
        assert_eq!(None, package.manifest.font_body);
        assert_eq!(None, package.manifest.font_mono);
        assert_eq!(None, package.manifest.font_size);
    }

    #[test]
    fn view_theme_css_rewrites_font_face_asset_urls() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("fonty");
        fs::create_dir(&directory).unwrap();
        fs::create_dir(directory.join("assets")).unwrap();
        fs::write(
            directory.join("theme.json"),
            r#"{"name":"Fonty","description":"Fonts"}"#,
        )
        .unwrap();
        fs::write(
            directory.join("content.css"),
            r#"@font-face { font-family: "Inter"; src: url(asset:inter.woff2); }
.markdown-body { font-family: "Inter"; }"#,
        )
        .unwrap();
        fs::write(directory.join("assets/inter.woff2"), b"font-bytes").unwrap();

        let css = view_theme_css_in("fonty", false, temp.path()).unwrap();
        assert!(css.contains("data:font/woff2;base64,"));
        assert!(!css.contains("asset:inter.woff2"));
    }

    #[test]
    fn directory_themes_are_discovered_and_override_legacy() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("corp");
        fs::create_dir(&directory).unwrap();
        fs::write(
            directory.join("theme.json"),
            r#"{"name":"Corporate","description":"Dir","code":"dark"}"#,
        )
        .unwrap();
        fs::write(
            directory.join("content.css"),
            ".markdown-body { color: dir; }",
        )
        .unwrap();
        fs::write(
            directory.join("content.dark.css"),
            ".markdown-body { background: dark; }",
        )
        .unwrap();
        fs::write(
            temp.path().join("corp.css"),
            "/* name: Legacy */\n.markdown-body { color: legacy; }",
        )
        .unwrap();

        let themes = custom_themes_in(temp.path());
        assert_eq!(1, themes.len());
        assert_eq!("corp", themes[0].id);
        assert_eq!("Corporate", themes[0].name);
        assert!(themes[0].has_dark);
        let css = view_theme_css_in("corp", true, temp.path()).unwrap();
        assert!(css.contains("color: dir"));
        assert!(css.contains("background: dark"));
        assert!(!css.contains("legacy"));
        assert!(layout_code_dark_in("corp", temp.path()));
    }

    #[test]
    fn builtins_override_directory_and_legacy_themes() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("clean");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("theme.json"), r#"{"name":"Fake Clean"}"#).unwrap();
        fs::write(
            directory.join("content.css"),
            ".markdown-body { color: fake-dir; }",
        )
        .unwrap();
        fs::write(
            temp.path().join("clean.css"),
            ".markdown-body { color: fake-legacy; }",
        )
        .unwrap();

        let themes = view_themes_in(temp.path());
        assert_eq!(1, themes.iter().filter(|theme| theme.id == "clean").count());
        let clean = themes.iter().find(|theme| theme.id == "clean").unwrap();
        assert!(!clean.custom);
        let css = view_theme_css_in("clean", false, temp.path()).unwrap();
        assert!(!css.contains("fake-dir"));
        assert!(!css.contains("fake-legacy"));
    }

    #[test]
    fn all_builtins_are_discovered_and_corporate_packages_have_templates() {
        let temp = tempfile::tempdir().unwrap();
        let themes = view_themes_in(temp.path());
        let ids = themes
            .iter()
            .map(|theme| theme.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(builtin::IDS, ids);

        let packages = discover_in(temp.path());
        for id in ["business", "brand"] {
            let package = packages.iter().find(|package| package.id == id).unwrap();
            assert!(package.dark_css.is_some(), "dark_css fehlt fuer {id}");
            assert!(package.page_css.is_some(), "page_css fehlt fuer {id}");
            assert!(package.cover_html.is_some(), "cover_html fehlt fuer {id}");
            assert!(package.header_html.is_some(), "header_html fehlt fuer {id}");
            assert!(package.footer_html.is_some(), "footer_html fehlt fuer {id}");
            assert!(package.manifest.cover, "cover-Flag fehlt fuer {id}");
            assert!(package.manifest.header, "header-Flag fehlt fuer {id}");
            assert!(package.manifest.footer, "footer-Flag fehlt fuer {id}");
        }
    }

    #[test]
    fn invalid_directory_theme_does_not_hide_valid_legacy_theme() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("mine");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("theme.json"), "{}").unwrap();
        fs::write(
            temp.path().join("mine.css"),
            ".markdown-body { color: legacy; }",
        )
        .unwrap();

        let themes = custom_themes_in(temp.path());
        assert_eq!(
            vec!["mine"],
            themes
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>()
        );
        assert!(view_theme_css_in("mine", false, temp.path())
            .unwrap()
            .contains("legacy"));
    }
}
