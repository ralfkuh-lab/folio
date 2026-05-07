//! PDF-Export via Headless-Chromium-Subprocess.
//!
//! Sucht eine Chromium-Familie (Chrome/Edge/Chromium) auf dem System und
//! rendert die fertige Layout-HTML per `--headless=new --print-to-pdf` ohne
//! Druckdialog. Temp-HTML liegt im Source-Verzeichnis, damit relative
//! Bildpfade aus dem Markdown weiterhin auflösen.

use std::path::{Path, PathBuf};
use std::process::Command;

pub fn find_chromium() -> Option<PathBuf> {
    chromium_candidates().into_iter().find(|p| p.exists())
}

#[cfg(target_os = "windows")]
fn chromium_candidates() -> Vec<PathBuf> {
    use std::env;
    let mut paths = Vec::new();
    let env_keys = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"];
    let suffixes = [
        r"Google\Chrome\Application\chrome.exe",
        r"Microsoft\Edge\Application\msedge.exe",
        r"Chromium\Application\chrome.exe",
    ];
    for key in env_keys {
        if let Ok(base) = env::var(key) {
            for suffix in suffixes {
                paths.push(PathBuf::from(format!("{base}\\{suffix}")));
            }
        }
    }
    paths
}

#[cfg(target_os = "linux")]
fn chromium_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr/bin/google-chrome"),
        PathBuf::from("/usr/bin/google-chrome-stable"),
        PathBuf::from("/usr/bin/chromium"),
        PathBuf::from("/usr/bin/chromium-browser"),
        PathBuf::from("/usr/bin/microsoft-edge"),
        PathBuf::from("/usr/bin/microsoft-edge-stable"),
        PathBuf::from("/snap/bin/chromium"),
        PathBuf::from("/var/lib/flatpak/exports/bin/com.google.Chrome"),
    ]
}

#[cfg(target_os = "macos")]
fn chromium_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        PathBuf::from("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
    ]
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn chromium_candidates() -> Vec<PathBuf> {
    Vec::new()
}

pub fn render_pdf(html: &str, source_dir: Option<&Path>, target_path: &Path) -> Result<(), String> {
    let chromium = find_chromium().ok_or_else(|| {
        "Chromium-Browser nicht gefunden. Bitte Chrome, Edge oder Chromium installieren."
            .to_string()
    })?;

    // Temp-HTML bevorzugt im Source-Verzeichnis (relative Bilder funktionieren),
    // sonst neben dem Ziel-PDF.
    let temp_dir = source_dir
        .filter(|d| d.exists())
        .map(|d| d.to_path_buf())
        .or_else(|| target_path.parent().map(|p| p.to_path_buf()))
        .ok_or_else(|| "Kein Verzeichnis für Temp-Datei verfügbar.".to_string())?;

    let temp_html = temp_dir.join(format!(
        ".folio-export-{}-{}.html",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    ));
    std::fs::write(&temp_html, html).map_err(|e| format!("Temp-HTML schreiben: {e}"))?;

    let url = format!("file:///{}", temp_html.to_string_lossy().replace('\\', "/"));

    let result = Command::new(&chromium)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--no-sandbox",
            "--allow-file-access-from-files",
            "--virtual-time-budget=15000",
            "--run-all-compositor-stages-before-draw",
        ])
        .arg(format!(
            "--print-to-pdf={}",
            target_path.to_string_lossy().replace('\\', "/")
        ))
        .arg(&url)
        .output();

    let _ = std::fs::remove_file(&temp_html);

    let output = result.map_err(|e| format!("Browser-Aufruf fehlgeschlagen: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "PDF-Erzeugung fehlgeschlagen (Exit {:?}): {stderr}",
            output.status.code()
        ));
    }
    if !target_path.exists() {
        return Err("PDF wurde nicht erzeugt (Browser-Output prüfen).".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_list_is_non_empty_on_supported_platforms() {
        let cands = chromium_candidates();
        if cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        )) {
            assert!(!cands.is_empty(), "candidates should not be empty");
        }
    }

    #[test]
    fn find_returns_existing_path_or_none() {
        // Kein Assert auf Some/None — abhängig vom Test-System.
        // Stellt nur sicher, dass die Funktion nicht panic't.
        let _ = find_chromium();
    }
}
