use super::{
    builtin,
    package::{ThemeManifest, ThemePackage, ThemeSource},
};
use crate::persist;
use std::{fs, io, path::Path};

const CONTENT_CSS_FILE: &str = "content.css";
const DARK_CSS_FILE: &str = "content.dark.css";
const PAGE_CSS_FILE: &str = "page.css";
const COVER_FILE: &str = "cover.html";
const HEADER_FILE: &str = "header.html";
const FOOTER_FILE: &str = "footer.html";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeParts {
    pub manifest: ThemeManifest,
    pub content_css: String,
    pub dark_css: Option<String>,
    pub page_css: Option<String>,
    pub cover_html: Option<String>,
    pub header_html: Option<String>,
    pub footer_html: Option<String>,
}

impl From<&ThemePackage> for ThemeParts {
    fn from(package: &ThemePackage) -> Self {
        Self {
            manifest: package.manifest.clone(),
            content_css: package.content_css.clone(),
            dark_css: package.dark_css.clone(),
            page_css: package.page_css.clone(),
            cover_html: package.cover_html.clone(),
            header_html: package.header_html.clone(),
            footer_html: package.footer_html.clone(),
        }
    }
}

pub fn create(id: &str, parts: &ThemeParts) -> Result<ThemePackage, String> {
    create_in(id, parts, &persist::themes_dir())
}

pub fn write(id: &str, parts: &ThemeParts) -> Result<ThemePackage, String> {
    write_in(id, parts, &persist::themes_dir())
}

pub fn delete(id: &str) -> Result<(), String> {
    delete_in(id, &persist::themes_dir())
}

pub fn clone(source_id: &str, new_id: &str) -> Result<ThemePackage, String> {
    clone_in(source_id, new_id, &persist::themes_dir())
}

fn create_in(id: &str, parts: &ThemeParts, themes_dir: &Path) -> Result<ThemePackage, String> {
    validate_writable_id(id)?;
    if id_occupied(id, themes_dir) {
        return Err(format!("Theme-ID '{id}' ist bereits vergeben"));
    }
    write_parts_in(id, parts, themes_dir, None)
}

fn write_in(id: &str, parts: &ThemeParts, themes_dir: &Path) -> Result<ThemePackage, String> {
    validate_writable_id(id)?;
    let assets_source = themes_dir.join(id).join("assets");
    let assets_source = assets_source.is_dir().then_some(assets_source);
    write_parts_in(id, parts, themes_dir, assets_source.as_deref())
}

fn delete_in(id: &str, themes_dir: &Path) -> Result<(), String> {
    validate_id(id)?;
    let package =
        super::package_in(id, themes_dir).ok_or_else(|| format!("Unbekanntes Theme: '{id}'"))?;
    if package.source == ThemeSource::Builtin {
        return Err(format!(
            "Eingebautes Theme '{id}' kann nicht gelöscht werden"
        ));
    }

    let package_dir = themes_dir.join(id);
    if package_dir.is_dir() {
        fs::remove_dir_all(&package_dir).map_err(|error| {
            format!(
                "Theme-Verzeichnis '{}' kann nicht gelöscht werden: {error}",
                package_dir.display()
            )
        })?;
    }
    remove_legacy_files(id, themes_dir)?;
    Ok(())
}

fn clone_in(source_id: &str, new_id: &str, themes_dir: &Path) -> Result<ThemePackage, String> {
    validate_id(source_id)?;
    validate_writable_id(new_id)?;
    if id_occupied(new_id, themes_dir) {
        return Err(format!("Theme-ID '{new_id}' ist bereits vergeben"));
    }
    let source = super::package_in(source_id, themes_dir)
        .ok_or_else(|| format!("Unbekanntes Theme: '{source_id}'"))?;
    if source.content_css.is_empty() {
        return Err(format!("Theme '{source_id}' kann nicht dupliziert werden"));
    }
    let assets_source = if source.source == ThemeSource::Directory {
        source
            .dir
            .as_ref()
            .map(|dir| dir.join("assets"))
            .filter(|dir| dir.is_dir())
    } else {
        None
    };
    write_parts_in(
        new_id,
        &ThemeParts::from(&source),
        themes_dir,
        assets_source.as_deref(),
    )
}

fn write_parts_in(
    id: &str,
    parts: &ThemeParts,
    themes_dir: &Path,
    assets_source: Option<&Path>,
) -> Result<ThemePackage, String> {
    fs::create_dir_all(themes_dir).map_err(|error| {
        format!(
            "Theme-Verzeichnis '{}' kann nicht angelegt werden: {error}",
            themes_dir.display()
        )
    })?;
    let staged = tempfile::Builder::new()
        .prefix(&format!(".{id}.tmp-"))
        .tempdir_in(themes_dir)
        .map_err(|error| {
            format!("Temporäres Theme-Verzeichnis kann nicht angelegt werden: {error}")
        })?;
    write_staged(staged.path(), parts, assets_source)?;

    let staged_path = staged.keep();
    let target = themes_dir.join(id);
    if target.exists() {
        replace_directory(&target, &staged_path, themes_dir, id)?;
    } else if let Err(error) = fs::rename(&staged_path, &target) {
        let _ = fs::remove_dir_all(&staged_path);
        return Err(format!(
            "Theme-Verzeichnis '{}' kann nicht veröffentlicht werden: {error}",
            target.display()
        ));
    }

    super::package::load_package(id, themes_dir)
        .ok_or_else(|| format!("Geschriebenes Theme '{id}' kann nicht geladen werden"))
}

fn write_staged(
    staged: &Path,
    parts: &ThemeParts,
    assets_source: Option<&Path>,
) -> Result<(), String> {
    let manifest = serde_json::to_vec_pretty(&parts.manifest)
        .map_err(|error| format!("Theme-Manifest kann nicht serialisiert werden: {error}"))?;
    fs::write(staged.join("theme.json"), manifest)
        .map_err(|error| format!("Theme-Manifest kann nicht geschrieben werden: {error}"))?;
    fs::write(staged.join(CONTENT_CSS_FILE), &parts.content_css)
        .map_err(|error| format!("Theme-CSS kann nicht geschrieben werden: {error}"))?;
    write_optional(staged, DARK_CSS_FILE, parts.dark_css.as_deref())?;
    write_optional(staged, PAGE_CSS_FILE, parts.page_css.as_deref())?;
    write_optional(staged, COVER_FILE, parts.cover_html.as_deref())?;
    write_optional(staged, HEADER_FILE, parts.header_html.as_deref())?;
    write_optional(staged, FOOTER_FILE, parts.footer_html.as_deref())?;
    if let Some(source) = assets_source {
        copy_directory(source, &staged.join("assets"))?;
    }
    Ok(())
}

fn write_optional(dir: &Path, filename: &str, content: Option<&str>) -> Result<(), String> {
    let Some(content) = content else {
        return Ok(());
    };
    fs::write(dir.join(filename), content)
        .map_err(|error| format!("Theme-Datei '{filename}' kann nicht geschrieben werden: {error}"))
}

fn replace_directory(
    target: &Path,
    staged: &Path,
    themes_dir: &Path,
    id: &str,
) -> Result<(), String> {
    if !target.is_dir() {
        let _ = fs::remove_dir_all(staged);
        return Err(format!(
            "Theme-Ziel '{}' ist kein Verzeichnis",
            target.display()
        ));
    }
    let backup = tempfile::Builder::new()
        .prefix(&format!(".{id}.backup-"))
        .tempdir_in(themes_dir)
        .map_err(|error| {
            let _ = fs::remove_dir_all(staged);
            format!("Theme-Backup kann nicht angelegt werden: {error}")
        })?;
    let old = backup.path().join("old");
    if let Err(error) = fs::rename(target, &old) {
        let _ = fs::remove_dir_all(staged);
        return Err(format!(
            "Bestehendes Theme kann nicht gesichert werden: {error}"
        ));
    }
    if let Err(error) = fs::rename(staged, target) {
        let rollback = fs::rename(&old, target);
        let _ = fs::remove_dir_all(staged);
        return match rollback {
            Ok(()) => Err(format!(
                "Theme-Update kann nicht veröffentlicht werden: {error}"
            )),
            Err(rollback_error) => Err(format!(
                "Theme-Update fehlgeschlagen ({error}); Rollback fehlgeschlagen: {rollback_error}"
            )),
        };
    }
    Ok(())
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("Asset-Verzeichnis kann nicht angelegt werden: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Asset-Verzeichnis kann nicht gelesen werden: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Asset-Eintrag kann nicht gelesen werden: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Asset-Typ kann nicht gelesen werden: {error}"))?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), destination)
                .map_err(|error| format!("Asset kann nicht kopiert werden: {error}"))?;
        }
    }
    Ok(())
}

fn remove_legacy_files(id: &str, themes_dir: &Path) -> Result<(), String> {
    for suffix in [".css", ".dark.css", ".page.css"] {
        let path = themes_dir.join(format!("{id}{suffix}"));
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Legacy-Theme-Datei '{}' kann nicht gelöscht werden: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn id_occupied(id: &str, themes_dir: &Path) -> bool {
    builtin::IDS.contains(&id)
        || themes_dir.join(id).exists()
        || themes_dir.join(format!("{id}.css")).exists()
}

fn validate_id(id: &str) -> Result<(), String> {
    if super::valid_theme_id(id) {
        Ok(())
    } else {
        Err(format!("Ungültige Theme-ID: '{id}'"))
    }
}

fn validate_writable_id(id: &str) -> Result<(), String> {
    validate_id(id)?;
    if builtin::IDS.contains(&id) {
        Err(format!(
            "Eingebautes Theme '{id}' kann nicht geändert werden"
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(name: &str, css: &str) -> ThemeParts {
        ThemeParts {
            manifest: ThemeManifest {
                name: name.to_string(),
                ..ThemeManifest::default()
            },
            content_css: css.to_string(),
            dark_css: None,
            page_css: None,
            cover_html: None,
            header_html: None,
            footer_html: None,
        }
    }

    #[test]
    fn create_write_and_delete_directory_theme() {
        let temp = tempfile::tempdir().unwrap();
        let created = create_in("mine", &parts("Mine", "light"), temp.path()).unwrap();
        assert_eq!("Mine", created.manifest.name);
        assert_eq!(
            "light",
            fs::read_to_string(temp.path().join("mine/content.css")).unwrap()
        );

        let mut updated = parts("Mine 2", "updated");
        updated.dark_css = Some("dark".to_string());
        let written = write_in("mine", &updated, temp.path()).unwrap();
        assert_eq!("Mine 2", written.manifest.name);
        assert_eq!(Some("dark"), written.dark_css.as_deref());

        delete_in("mine", temp.path()).unwrap();
        assert!(!temp.path().join("mine").exists());
    }

    #[test]
    fn write_preserves_assets_and_clone_materializes_builtin_templates() {
        let temp = tempfile::tempdir().unwrap();
        create_in("mine", &parts("Mine", "one"), temp.path()).unwrap();
        fs::create_dir(temp.path().join("mine/assets")).unwrap();
        fs::write(temp.path().join("mine/assets/logo.txt"), "logo").unwrap();
        write_in("mine", &parts("Mine", "two"), temp.path()).unwrap();
        assert_eq!(
            "logo",
            fs::read_to_string(temp.path().join("mine/assets/logo.txt")).unwrap()
        );

        let cloned = clone_in("business", "business-copy", temp.path()).unwrap();
        assert_eq!(ThemeSource::Directory, cloned.source);
        assert!(cloned.dark_css.is_some());
        assert!(cloned.page_css.is_some());
        assert!(cloned.cover_html.is_some());
        assert!(cloned.header_html.is_some());
        assert!(cloned.footer_html.is_some());
        assert!(temp.path().join("business-copy/theme.json").is_file());
    }

    #[test]
    fn builtins_existing_ids_and_traversal_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        assert!(write_in("clean", &parts("No", "css"), temp.path()).is_err());
        assert!(delete_in("clean", temp.path()).is_err());
        assert!(clone_in("clean", "../bad", temp.path()).is_err());
        create_in("mine", &parts("Mine", "css"), temp.path()).unwrap();
        assert!(create_in("mine", &parts("Mine", "css"), temp.path()).is_err());
        assert!(clone_in("clean", "mine", temp.path()).is_err());
    }

    #[test]
    fn delete_removes_legacy_variants_and_shadowing_directory() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("legacy.css"), "legacy").unwrap();
        fs::write(temp.path().join("legacy.dark.css"), "dark").unwrap();
        delete_in("legacy", temp.path()).unwrap();
        assert!(!temp.path().join("legacy.css").exists());
        assert!(!temp.path().join("legacy.dark.css").exists());

        fs::write(temp.path().join("mixed.css"), "legacy").unwrap();
        write_in("mixed", &parts("Mixed", "directory"), temp.path()).unwrap();
        delete_in("mixed", temp.path()).unwrap();
        assert!(!temp.path().join("mixed").exists());
        assert!(!temp.path().join("mixed.css").exists());
    }
}
