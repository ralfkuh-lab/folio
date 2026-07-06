use super::{
    assets::{self, MAX_ASSET_BYTES},
    builtin,
    package::{ThemeManifest, ThemePackage, ThemeSource},
    store::{self, ThemeParts},
};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufReader, Read, Seek, Write},
    path::{Path, PathBuf},
};
use zip::{read::ZipFile, write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const CURRENT_FORMAT_VERSION: u32 = 1;
const MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

const MANIFEST_FILE: &str = "theme.json";
const CONTENT_CSS_FILE: &str = "content.css";
const DARK_CSS_FILE: &str = "content.dark.css";
const PAGE_CSS_FILE: &str = "page.css";
const COVER_FILE: &str = "cover.html";
const HEADER_FILE: &str = "header.html";
const FOOTER_FILE: &str = "footer.html";

#[derive(Debug)]
struct ImportedArchive {
    parts: ThemeParts,
    assets: Vec<(String, Vec<u8>)>,
}

pub fn export_theme(id: &str, target: &Path) -> Result<PathBuf, String> {
    export_theme_in(id, target, &crate::persist::themes_dir())
}

pub(crate) fn export_theme_in(
    id: &str,
    target: &Path,
    themes_dir: &Path,
) -> Result<PathBuf, String> {
    let package =
        super::package_in(id, themes_dir).ok_or_else(|| format!("Unbekanntes Theme: '{id}'"))?;
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| format!("Zielpfad '{}' hat kein Verzeichnis", target.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Export-Verzeichnis '{}' kann nicht angelegt werden: {error}",
            parent.display()
        )
    })?;

    let mut tmp = tempfile::Builder::new()
        .prefix(".folio-theme-export-")
        .suffix(".mdtheme.tmp")
        .tempfile_in(parent)
        .map_err(|error| {
            format!("Tempfile fuer Theme-Export kann nicht angelegt werden: {error}")
        })?;
    write_package_zip(&package, themes_dir, &mut tmp)?;
    tmp.flush()
        .map_err(|error| format!("Theme-Export kann nicht geschrieben werden: {error}"))?;
    tmp.persist(target)
        .map_err(|error| format!("Theme-Export kann nicht veroeffentlicht werden: {error}"))?;
    Ok(target.to_path_buf())
}

pub fn import_theme(path: &Path) -> Result<ThemePackage, String> {
    import_theme_in(path, &crate::persist::themes_dir())
}

pub(crate) fn import_theme_in(path: &Path, themes_dir: &Path) -> Result<ThemePackage, String> {
    let imported = read_archive(path)?;
    let id = available_id(path, themes_dir)?;
    let asset_stage = if imported.assets.is_empty() {
        None
    } else {
        let dir = tempfile::Builder::new()
            .prefix(".folio-theme-assets-")
            .tempdir_in(themes_dir)
            .map_err(|error| {
                format!("Temporäres Asset-Verzeichnis kann nicht angelegt werden: {error}")
            })?;
        for (filename, bytes) in &imported.assets {
            assets::data_uri(filename, bytes)?;
            fs::write(dir.path().join(filename), bytes).map_err(|error| {
                format!("Asset '{filename}' kann nicht zwischengespeichert werden: {error}")
            })?;
        }
        Some(dir)
    };
    store::write_parts_in(
        &id,
        &imported.parts,
        themes_dir,
        asset_stage.as_ref().map(|dir| dir.path()),
    )
}

fn write_package_zip<W: Write + Seek>(
    package: &ThemePackage,
    themes_dir: &Path,
    writer: W,
) -> Result<(), String> {
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let manifest = serde_json::to_vec_pretty(&package.manifest)
        .map_err(|error| format!("Theme-Manifest kann nicht serialisiert werden: {error}"))?;
    write_zip_file(&mut zip, options, MANIFEST_FILE, &manifest)?;
    write_zip_file(
        &mut zip,
        options,
        CONTENT_CSS_FILE,
        package.content_css.as_bytes(),
    )?;
    write_optional(
        &mut zip,
        options,
        DARK_CSS_FILE,
        package.dark_css.as_deref(),
    )?;
    write_optional(
        &mut zip,
        options,
        PAGE_CSS_FILE,
        package.page_css.as_deref(),
    )?;
    write_optional(&mut zip, options, COVER_FILE, package.cover_html.as_deref())?;
    write_optional(
        &mut zip,
        options,
        HEADER_FILE,
        package.header_html.as_deref(),
    )?;
    write_optional(
        &mut zip,
        options,
        FOOTER_FILE,
        package.footer_html.as_deref(),
    )?;

    if package.source == ThemeSource::Directory {
        if let Some(dir) = package.dir.as_deref() {
            write_assets(&mut zip, options, &dir.join("assets"))?;
        }
    } else if package.source == ThemeSource::LegacyFlat {
        let assets_dir = themes_dir.join(&package.id).join("assets");
        write_assets(&mut zip, options, &assets_dir)?;
    }

    zip.finish()
        .map_err(|error| format!("Theme-Archiv kann nicht abgeschlossen werden: {error}"))?;
    Ok(())
}

fn write_optional<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    options: SimpleFileOptions,
    name: &str,
    content: Option<&str>,
) -> Result<(), String> {
    if let Some(content) = content {
        write_zip_file(zip, options, name, content.as_bytes())?;
    }
    Ok(())
}

fn write_assets<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    options: SimpleFileOptions,
    assets_dir: &Path,
) -> Result<(), String> {
    let entries = match fs::read_dir(assets_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Asset-Verzeichnis '{}' kann nicht gelesen werden: {error}",
                assets_dir.display()
            ));
        }
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Asset-Eintrag kann nicht gelesen werden: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Asset-Typ kann nicht gelesen werden: {error}"))?;
        if !file_type.is_file() {
            continue;
        }
        let filename = entry
            .file_name()
            .to_str()
            .ok_or_else(|| "Asset-Dateiname ist kein gueltiges UTF-8".to_string())?
            .to_string();
        assets::validate_asset_filename(&filename)?;
        let bytes = fs::read(entry.path()).map_err(|error| {
            format!(
                "Asset '{}' kann nicht gelesen werden: {error}",
                entry.path().display()
            )
        })?;
        assets::data_uri(&filename, &bytes)?;
        write_zip_file(zip, options, &format!("assets/{filename}"), &bytes)?;
    }
    Ok(())
}

fn write_zip_file<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    options: SimpleFileOptions,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    zip.start_file(name, options)
        .map_err(|error| format!("Archiv-Eintrag '{name}' kann nicht begonnen werden: {error}"))?;
    zip.write_all(bytes)
        .map_err(|error| format!("Archiv-Eintrag '{name}' kann nicht geschrieben werden: {error}"))
}

fn read_archive(path: &Path) -> Result<ImportedArchive, String> {
    let file = File::open(path).map_err(|error| {
        format!(
            "Theme-Archiv '{}' kann nicht geoeffnet werden: {error}",
            path.display()
        )
    })?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|error| {
        format!(
            "Theme-Archiv '{}' ist kein gueltiges ZIP: {error}",
            path.display()
        )
    })?;
    let mut seen = HashSet::new();
    let mut total = 0usize;
    let mut manifest: Option<ThemeManifest> = None;
    let mut content_css: Option<String> = None;
    let mut dark_css = None;
    let mut page_css = None;
    let mut cover_html = None;
    let mut header_html = None;
    let mut footer_html = None;
    let mut imported_assets = Vec::new();

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| {
            format!("Archiv-Eintrag #{index} kann nicht gelesen werden: {error}")
        })?;
        let name = validate_entry(&file)?;
        if !seen.insert(name.clone()) {
            return Err(format!("Archiv-Eintrag '{name}' ist doppelt vorhanden"));
        }

        match name.as_str() {
            MANIFEST_FILE => {
                let text = read_text_entry(&mut file, &name, &mut total)?;
                let parsed: ThemeManifest = serde_json::from_str(&text)
                    .map_err(|error| format!("Theme-Manifest im Archiv ist ungueltig: {error}"))?;
                if parsed.format_version > CURRENT_FORMAT_VERSION {
                    return Err(format!(
                        "Theme-Archiv nutzt formatVersion {}, unterstuetzt wird {}",
                        parsed.format_version, CURRENT_FORMAT_VERSION
                    ));
                }
                manifest = Some(parsed.normalize("import", path));
            }
            CONTENT_CSS_FILE => content_css = Some(read_text_entry(&mut file, &name, &mut total)?),
            DARK_CSS_FILE => dark_css = Some(read_text_entry(&mut file, &name, &mut total)?),
            PAGE_CSS_FILE => page_css = Some(read_text_entry(&mut file, &name, &mut total)?),
            COVER_FILE => cover_html = Some(read_text_entry(&mut file, &name, &mut total)?),
            HEADER_FILE => header_html = Some(read_text_entry(&mut file, &name, &mut total)?),
            FOOTER_FILE => footer_html = Some(read_text_entry(&mut file, &name, &mut total)?),
            _ => {
                let filename = name
                    .strip_prefix("assets/")
                    .ok_or_else(|| format!("Archiv-Eintrag '{name}' ist nicht erlaubt"))?;
                assets::validate_asset_filename(filename)?;
                let bytes = read_binary_entry(&mut file, &name, MAX_ASSET_BYTES, &mut total)?;
                assets::data_uri(filename, &bytes)?;
                imported_assets.push((filename.to_string(), bytes));
            }
        }
    }

    let manifest = manifest.ok_or_else(|| "Theme-Archiv enthaelt kein theme.json".to_string())?;
    let content_css =
        content_css.ok_or_else(|| "Theme-Archiv enthaelt kein content.css".to_string())?;
    Ok(ImportedArchive {
        parts: ThemeParts {
            manifest,
            content_css,
            dark_css,
            page_css,
            cover_html,
            header_html,
            footer_html,
        },
        assets: imported_assets,
    })
}

fn validate_entry(file: &ZipFile<'_>) -> Result<String, String> {
    let name = file.name();
    if name.is_empty() {
        return Err("Archiv-Eintrag ohne Namen ist nicht erlaubt".to_string());
    }
    if name.starts_with('/') || name.starts_with('\\') || name.contains('\\') || name.contains('\0')
    {
        return Err(format!("Archiv-Eintrag '{name}' hat einen unsicheren Pfad"));
    }
    if name.contains("..") {
        return Err(format!("Archiv-Eintrag '{name}' darf kein '..' enthalten"));
    }
    if file.is_symlink() {
        return Err(format!("Archiv-Eintrag '{name}' ist ein Symlink"));
    }
    if file.is_dir() || !file.is_file() {
        return Err(format!("Archiv-Eintrag '{name}' ist keine regulaere Datei"));
    }
    if is_known_text_file(name) {
        return Ok(name.to_string());
    }
    if let Some(filename) = name.strip_prefix("assets/") {
        assets::validate_asset_filename(filename)?;
        return Ok(name.to_string());
    }
    Err(format!("Archiv-Eintrag '{name}' ist nicht erlaubt"))
}

fn is_known_text_file(name: &str) -> bool {
    matches!(
        name,
        MANIFEST_FILE
            | CONTENT_CSS_FILE
            | DARK_CSS_FILE
            | PAGE_CSS_FILE
            | COVER_FILE
            | HEADER_FILE
            | FOOTER_FILE
    )
}

fn read_text_entry(
    file: &mut ZipFile<'_>,
    name: &str,
    total: &mut usize,
) -> Result<String, String> {
    let bytes = read_binary_entry(file, name, MAX_TEXT_BYTES, total)?;
    String::from_utf8(bytes)
        .map_err(|error| format!("Archiv-Eintrag '{name}' ist kein UTF-8: {error}"))
}

fn read_binary_entry(
    file: &mut ZipFile<'_>,
    name: &str,
    limit: usize,
    total: &mut usize,
) -> Result<Vec<u8>, String> {
    let declared_size = usize::try_from(file.size())
        .map_err(|_| format!("Archiv-Eintrag '{name}' ist zu gross"))?;
    if declared_size > limit {
        return Err(format!(
            "Archiv-Eintrag '{name}' ist {declared_size} Bytes gross, Maximum sind {limit} Bytes"
        ));
    }
    if total.saturating_add(declared_size) > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "Theme-Archiv ueberschreitet das Limit von {MAX_ARCHIVE_BYTES} Bytes"
        ));
    }
    let mut bytes = Vec::with_capacity(declared_size);
    file.take((limit as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Archiv-Eintrag '{name}' kann nicht gelesen werden: {error}"))?;
    if bytes.len() > limit {
        return Err(format!(
            "Archiv-Eintrag '{name}' ist groesser als das Limit von {limit} Bytes"
        ));
    }
    *total = total
        .checked_add(bytes.len())
        .ok_or_else(|| "Theme-Archiv-Groesse ueberlaeuft".to_string())?;
    if *total > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "Theme-Archiv ueberschreitet das Limit von {MAX_ARCHIVE_BYTES} Bytes"
        ));
    }
    Ok(bytes)
}

fn available_id(path: &Path, themes_dir: &Path) -> Result<String, String> {
    let base = slug_from_path(path);
    for suffix in 1.. {
        let candidate = if suffix == 1 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        if !super::valid_theme_id(&candidate) {
            continue;
        }
        if !id_occupied(&candidate, themes_dir) {
            return Ok(candidate);
        }
    }
    Err("Keine freie Theme-ID gefunden".to_string())
}

fn slug_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("theme");
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in stem.chars() {
        let next = if ch.is_ascii_alphanumeric() || ch == '_' {
            Some(ch.to_ascii_lowercase())
        } else if ch == '-' || ch.is_whitespace() {
            Some('-')
        } else {
            None
        };
        if let Some(next) = next {
            if next == '-' {
                if slug.is_empty() || last_dash {
                    continue;
                }
                last_dash = true;
            } else {
                last_dash = false;
            }
            slug.push(next);
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "theme".to_string()
    } else {
        slug
    }
}

fn id_occupied(id: &str, themes_dir: &Path) -> bool {
    builtin::IDS.contains(&id)
        || themes_dir.join(id).exists()
        || themes_dir.join(format!("{id}.css")).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn parts() -> ThemeParts {
        ThemeParts {
            manifest: ThemeManifest {
                name: "Roundtrip".to_string(),
                description: "Test".to_string(),
                logo: Some("logo.png".to_string()),
                ..ThemeManifest::default()
            },
            content_css: ".markdown-body { color: red; }".to_string(),
            dark_css: Some(".markdown-body { color: white; }".to_string()),
            page_css: Some("@page { margin: 1cm; }".to_string()),
            cover_html: None,
            header_html: Some("<header>Test</header>".to_string()),
            footer_html: None,
        }
    }

    fn write_test_zip(path: &Path, entries: &[(&str, &[u8], Option<u32>)]) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        for (name, bytes, mode) in entries {
            let mut options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            if let Some(mode) = mode {
                options = options.unix_permissions(*mode);
            }
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn manifest(version: u32) -> String {
        serde_json::json!({
            "name": "Import",
            "description": "Aus ZIP",
            "code": "light",
            "formatVersion": version
        })
        .to_string()
    }

    #[test]
    fn export_import_roundtrip_includes_assets() {
        let temp = tempfile::tempdir().unwrap();
        let source = store::write_parts_in("source", &parts(), temp.path(), None).unwrap();
        assert_eq!(ThemeSource::Directory, source.source);
        store::asset_add_in("source", "logo.png", b"png-bytes", temp.path()).unwrap();

        let archive = temp.path().join("imported-theme.mdtheme");
        export_theme_in("source", &archive, temp.path()).unwrap();
        let imported = import_theme_in(&archive, temp.path()).unwrap();

        assert_eq!("imported-theme", imported.id);
        assert_eq!("Roundtrip", imported.manifest.name);
        assert_eq!(
            Some(".markdown-body { color: white; }"),
            imported.dark_css.as_deref()
        );
        assert_eq!(
            b"png-bytes",
            fs::read(temp.path().join("imported-theme/assets/logo.png"))
                .unwrap()
                .as_slice()
        );
    }

    #[test]
    fn import_rejects_zip_slip_unknown_file_and_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let manifest_json = manifest(1);
        for (filename, bad_entry, mode) in [
            ("slip.mdtheme", "../theme.json", None),
            ("unknown.mdtheme", "notes.txt", None),
        ] {
            let path = temp.path().join(filename);
            write_test_zip(
                &path,
                &[
                    (MANIFEST_FILE, manifest_json.as_bytes(), None),
                    (CONTENT_CSS_FILE, b".markdown-body {}", None),
                    (bad_entry, b"x", mode),
                ],
            );
            assert!(import_theme_in(&path, temp.path()).is_err(), "{filename}");
        }

        let symlink_path = temp.path().join("symlink.mdtheme");
        let file = File::create(&symlink_path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file(MANIFEST_FILE, options).unwrap();
        zip.write_all(manifest_json.as_bytes()).unwrap();
        zip.start_file(CONTENT_CSS_FILE, options).unwrap();
        zip.write_all(b".markdown-body {}").unwrap();
        zip.add_symlink("assets/logo.png", "target.png", options)
            .unwrap();
        zip.finish().unwrap();
        assert!(import_theme_in(&symlink_path, temp.path()).is_err());
    }

    #[test]
    fn import_rejects_oversized_entries_and_future_format() {
        let temp = tempfile::tempdir().unwrap();
        let manifest_json = manifest(1);
        let oversized_text = vec![b'a'; MAX_TEXT_BYTES + 1];
        let oversized_asset = vec![b'a'; MAX_ASSET_BYTES + 1];

        let text_path = temp.path().join("large-text.mdtheme");
        write_test_zip(
            &text_path,
            &[
                (MANIFEST_FILE, manifest_json.as_bytes(), None),
                (CONTENT_CSS_FILE, oversized_text.as_slice(), None),
            ],
        );
        assert!(import_theme_in(&text_path, temp.path()).is_err());

        let asset_path = temp.path().join("large-asset.mdtheme");
        write_test_zip(
            &asset_path,
            &[
                (MANIFEST_FILE, manifest_json.as_bytes(), None),
                (CONTENT_CSS_FILE, b".markdown-body {}", None),
                ("assets/logo.png", oversized_asset.as_slice(), None),
            ],
        );
        assert!(import_theme_in(&asset_path, temp.path()).is_err());

        let future_path = temp.path().join("future.mdtheme");
        let future = manifest(CURRENT_FORMAT_VERSION + 1);
        write_test_zip(
            &future_path,
            &[
                (MANIFEST_FILE, future.as_bytes(), None),
                (CONTENT_CSS_FILE, b".markdown-body {}", None),
            ],
        );
        assert!(import_theme_in(&future_path, temp.path()).is_err());
    }

    #[test]
    fn import_uses_collision_suffix() {
        let temp = tempfile::tempdir().unwrap();
        store::write_parts_in("collision", &parts(), temp.path(), None).unwrap();
        let manifest_json = manifest(1);
        let archive = temp.path().join("collision.mdtheme");
        write_test_zip(
            &archive,
            &[
                (MANIFEST_FILE, manifest_json.as_bytes(), None),
                (CONTENT_CSS_FILE, b".markdown-body {}", None),
            ],
        );

        let imported = import_theme_in(&archive, temp.path()).unwrap();
        assert_eq!("collision-2", imported.id);
    }
}
