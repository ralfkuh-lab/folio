//! Image-Insert-Pfad: Clipboard-RGBA → PNG, oder Datei-von-Platte
//! optional kopieren. Beide Pfade liefern einen relativen Pfad gegenueber
//! dem aktuellen Dokument zurueck, der direkt in den Markdown-Tag wandert.

use crate::{file_resolver, state::AppState};
use base64::Engine;
use image::{ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::BufWriter,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::util::file_path_to_string;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInsertResult {
    pub absolute_path: String,
    pub relative_path: String,
    pub final_filename: String,
    /// Hinweistext, falls kein relativer Pfad ermittelbar war (anderes
    /// Volume, kein Dokumentpfad o. ae.). Frontend zeigt das unter der
    /// Tag-Preview an.
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveClipboardImageArgs {
    /// RGBA-Bytes (`tauri-plugin-clipboard-manager::readImage().rgba()`)
    /// als Base64. Backend rekonstruiert ein `ImageBuffer` und encodet PNG.
    pub rgba_base64: String,
    pub width: u32,
    pub height: u32,
    pub target_dir: String,
    /// Gewuenschter Zielname (mit oder ohne `.png`-Endung).
    pub filename: String,
    /// Optional: aktueller Dokumentpfad. Wird genutzt, um den relativen
    /// Pfad zu berechnen.
    pub doc_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileImageArgs {
    pub source_path: String,
    pub target_dir: String,
    pub filename: String,
    pub doc_path: Option<String>,
    /// `true` → Datei wird in `target_dir` kopiert (mit Kollisions-Suffix);
    /// `false` → Quelle bleibt liegen, wir liefern nur den relativen Pfad
    /// zur Quelle zurueck.
    pub copy: bool,
}

/// Speichert ein Clipboard-Bild (RGBA-Bytes) als PNG in `target_dir` und
/// liefert absoluten + relativen Pfad zurueck. Atomar via Tempfile-Rename.
#[tauri::command]
pub async fn save_clipboard_image(
    args: SaveClipboardImageArgs,
) -> Result<ImageInsertResult, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(args.rgba_base64.as_bytes())
        .map_err(|error| format!("Clipboard-Bild dekodieren fehlgeschlagen: {error}"))?;

    let expected = (args.width as usize)
        .checked_mul(args.height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Bild-Dimensionen ueberlaufen".to_string())?;
    if bytes.len() != expected {
        return Err(format!(
            "RGBA-Bytes ({}) passen nicht zu {}x{}x4 = {expected}",
            bytes.len(),
            args.width,
            args.height
        ));
    }

    let img = ImageBuffer::<Rgba<u8>, _>::from_raw(args.width, args.height, bytes)
        .ok_or_else(|| "Bild konnte nicht aus RGBA-Bytes aufgebaut werden".to_string())?;

    let target_dir = PathBuf::from(&args.target_dir);
    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("Zielverzeichnis kann nicht angelegt werden: {error}"))?;

    let final_path = resolve_unique(&target_dir, &args.filename, "png");
    let final_filename = path_filename(&final_path);

    let tmp = tempfile::Builder::new()
        .prefix(".folio-img-")
        .suffix(".tmp")
        .tempfile_in(&target_dir)
        .map_err(|error| format!("Tempfile anlegen fehlgeschlagen: {error}"))?;
    {
        let mut writer = BufWriter::new(tmp.as_file());
        img.write_to(&mut writer, image::ImageFormat::Png)
            .map_err(|error| format!("PNG-Encoding fehlgeschlagen: {error}"))?;
    }
    tmp.persist(&final_path)
        .map_err(|error| format!("Rename fehlgeschlagen: {error}"))?;

    let (relative_path, warning) = compute_relative(&final_path, args.doc_path.as_deref());
    Ok(ImageInsertResult {
        absolute_path: final_path.to_string_lossy().into_owned(),
        relative_path,
        final_filename,
        warning,
    })
}

/// Kopiert (oder referenziert) eine Datei und liefert absoluten +
/// relativen Pfad zurueck. Wird vom Image-Dialog gerufen, wenn der User
/// im File-Picker eine Datei ausgewaehlt hat.
#[tauri::command]
pub async fn save_file_image(args: SaveFileImageArgs) -> Result<ImageInsertResult, String> {
    let source = PathBuf::from(&args.source_path);
    if !source.exists() {
        return Err(format!("Quelldatei existiert nicht: {}", args.source_path));
    }

    let final_path = if args.copy {
        let target_dir = PathBuf::from(&args.target_dir);
        fs::create_dir_all(&target_dir)
            .map_err(|error| format!("Zielverzeichnis kann nicht angelegt werden: {error}"))?;
        let fallback_ext = source
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("png");
        let path = resolve_unique(&target_dir, &args.filename, fallback_ext);
        fs::copy(&source, &path)
            .map_err(|error| format!("Bild kopieren fehlgeschlagen: {error}"))?;
        path
    } else {
        source
    };

    let final_filename = path_filename(&final_path);
    let (relative_path, warning) = compute_relative(&final_path, args.doc_path.as_deref());
    Ok(ImageInsertResult {
        absolute_path: final_path.to_string_lossy().into_owned(),
        relative_path,
        final_filename,
        warning,
    })
}

/// File-Picker mit Bild-Filter. Default-Verzeichnis ist das letzte
/// gemerkte Image-Dir bzw. das Dokument-Dir, vom Frontend mitgegeben.
#[tauri::command]
pub async fn pick_image_file(
    handle: AppHandle,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = handle
        .dialog()
        .file()
        .add_filter("Bilder", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
        .add_filter("Alle Dateien", &["*"]);
    if let Some(dir) = default_dir {
        builder = builder.set_directory(dir);
    }
    Ok(builder
        .blocking_pick_file()
        .map(file_path_to_string)
        .filter(|path| !path.is_empty()))
}

/// Verzeichnis-Picker fuer den "Durchsuchen…"-Button im Image-Dialog.
#[tauri::command]
pub async fn pick_image_target_dir(
    handle: AppHandle,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = handle.dialog().file();
    if let Some(dir) = default_dir {
        builder = builder.set_directory(dir);
    }
    Ok(builder
        .blocking_pick_folder()
        .map(file_path_to_string)
        .filter(|path| !path.is_empty()))
}

/// Frontend-Helper: liefert das Verzeichnis des aktuell geoeffneten
/// Dokuments. Wird beim Initialisieren des Image-Dialogs gebraucht,
/// um den Default-Speicherort vorzubelegen.
#[tauri::command]
pub async fn current_document_dir(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let store = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?;
    Ok(store.path.as_deref().and_then(|doc_path| {
        Path::new(doc_path)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
    }))
}

fn path_filename(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string()
}

fn resolve_unique(dir: &Path, filename: &str, default_ext: &str) -> PathBuf {
    let mut name = filename.trim().to_string();
    if name.is_empty() {
        name = format!("image.{default_ext}");
    }
    if Path::new(&name).extension().is_none() {
        name.push('.');
        name.push_str(default_ext);
    }

    let candidate = dir.join(&name);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&name)
        .to_string();
    let ext = Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or(default_ext)
        .to_string();
    for n in 2..1000 {
        let suffixed = dir.join(format!("{stem} ({n}).{ext}"));
        if !suffixed.exists() {
            return suffixed;
        }
    }
    dir.join(name)
}

fn compute_relative(final_path: &Path, doc_path: Option<&str>) -> (String, Option<String>) {
    let absolute = fs::canonicalize(final_path).unwrap_or_else(|_| final_path.to_path_buf());
    let Some(doc) = doc_path.filter(|p| !p.is_empty()) else {
        return (
            absolute.to_string_lossy().replace('\\', "/"),
            Some("Kein Dokument geoeffnet — absoluter Pfad eingefuegt.".to_string()),
        );
    };
    let doc_path = Path::new(doc);
    let Some(doc_dir) = doc_path.parent() else {
        return (
            absolute.to_string_lossy().replace('\\', "/"),
            Some("Dokumentpfad ohne Verzeichnis — absoluter Pfad eingefuegt.".to_string()),
        );
    };
    let doc_dir_canon = fs::canonicalize(doc_dir).unwrap_or_else(|_| doc_dir.to_path_buf());
    let rel = file_resolver::make_relative(&doc_dir_canon, &absolute);
    if Path::new(&rel).is_absolute() {
        (
            rel,
            Some(
                "Bild liegt ausserhalb des Dokumentbaums — absoluter Pfad eingefuegt.".to_string(),
            ),
        )
    } else {
        (rel, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn resolve_unique_appends_default_extension() {
        let temp = TempDir::new().unwrap();
        let path = resolve_unique(temp.path(), "screenshot", "png");
        assert_eq!(
            "screenshot.png",
            path.file_name().unwrap().to_str().unwrap()
        );
    }

    #[test]
    fn resolve_unique_suffixes_on_collision() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("foo.png"), []).unwrap();
        let path = resolve_unique(temp.path(), "foo.png", "png");
        assert_eq!("foo (2).png", path.file_name().unwrap().to_str().unwrap());

        fs::write(&path, []).unwrap();
        let path3 = resolve_unique(temp.path(), "foo.png", "png");
        assert_eq!("foo (3).png", path3.file_name().unwrap().to_str().unwrap());
    }

    #[test]
    fn resolve_unique_keeps_existing_extension() {
        let temp = TempDir::new().unwrap();
        let path = resolve_unique(temp.path(), "data.jpg", "png");
        assert_eq!("data.jpg", path.file_name().unwrap().to_str().unwrap());
    }

    #[test]
    fn compute_relative_for_image_inside_doc_dir() {
        let temp = TempDir::new().unwrap();
        let doc = temp.path().join("note.md");
        let img = temp.path().join("img.png");
        fs::write(&doc, "").unwrap();
        fs::write(&img, []).unwrap();
        let (rel, warn) = compute_relative(&img, Some(doc.to_str().unwrap()));
        assert_eq!("img.png", rel);
        assert!(warn.is_none());
    }

    #[test]
    fn compute_relative_without_doc_path_falls_back_to_absolute() {
        let temp = TempDir::new().unwrap();
        let img = temp.path().join("img.png");
        fs::write(&img, []).unwrap();
        let (rel, warn) = compute_relative(&img, None);
        assert!(rel.contains("img.png"));
        assert!(warn.is_some());
    }
}
