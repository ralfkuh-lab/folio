pub mod builtin;
pub mod package;

use crate::persist;
use package::{ThemePackage, ThemeSource};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

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
    let package = find_package_in(id, dir)?;
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
        return Err(format!("Unbekanntes View-Theme: '{theme_id}'"));
    }
    if theme_id == "standard" {
        return Ok(Cow::Borrowed(""));
    }
    layout_css_in(theme_id, dark, dir)
        .ok_or_else(|| format!("Unbekanntes View-Theme: '{theme_id}'"))
}

pub(crate) fn layout_code_dark_in(id: &str, dir: &Path) -> bool {
    find_package_in(id, dir).is_some_and(|package| package.manifest.code_is_dark())
}

pub(crate) fn page_css_in(id: &str, dir: &Path) -> Option<Cow<'static, str>> {
    if !valid_theme_id(id) || id == "standard" {
        return None;
    }
    let package = find_package_in(id, dir)?;
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
    match (dark, package.dark_css.as_deref()) {
        (true, Some(dark_css)) => format!("{}\n{dark_css}", package.content_css),
        _ => package.content_css.clone(),
    }
}

fn layout_info(package: &ThemePackage) -> LayoutInfo {
    LayoutInfo {
        id: package.id.clone(),
        name: package.manifest.name.clone(),
        description: package.manifest.description.clone(),
        has_dark: package.id == "standard" || package.dark_css.is_some(),
        custom: package.source != ThemeSource::Builtin,
    }
}

fn find_package_in(id: &str, dir: &Path) -> Option<ThemePackage> {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeData {
    pub mode: String,
}

impl Default for ThemeData {
    fn default() -> Self {
        Self {
            mode: "light".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ThemeService {
    data: ThemeData,
    path: PathBuf,
}

impl Default for ThemeService {
    fn default() -> Self {
        Self::load()
    }
}

impl ThemeService {
    pub fn load() -> Self {
        Self::load_from(persist::config_file("theme.json"))
    }

    pub fn load_from(path: PathBuf) -> Self {
        let data = persist::load_json(&path);
        Self { data, path }
    }

    pub fn mode(&self) -> &str {
        &self.data.mode
    }

    pub fn set_mode(&mut self, mode: &str) -> io::Result<()> {
        let normalized = match mode.to_ascii_lowercase().as_str() {
            "dark" => "dark".to_string(),
            _ => "light".to_string(),
        };
        if normalized == self.data.mode {
            return Ok(());
        }
        self.data.mode = normalized;
        persist::save_json_atomic(&self.path, &self.data)
    }

    pub fn toggle(&mut self) -> io::Result<&str> {
        let next = if self.data.mode == "dark" {
            "light"
        } else {
            "dark"
        };
        self.set_mode(next)?;
        Ok(self.mode())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn defaults_to_light() {
        let temp = TempDir::new().unwrap();
        let svc = ThemeService::load_from(temp.path().join("theme.json"));
        assert_eq!("light", svc.mode());
    }

    #[test]
    fn set_mode_persists_dark_normalized() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("theme.json");
        let mut svc = ThemeService::load_from(path.clone());
        svc.set_mode("DARK").unwrap();
        let reloaded = ThemeService::load_from(path);
        assert_eq!("dark", reloaded.mode());
    }

    #[test]
    fn toggle_flips_mode() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("theme.json");
        let mut svc = ThemeService::load_from(path);
        assert_eq!("dark", svc.toggle().unwrap());
        assert_eq!("light", svc.toggle().unwrap());
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
