//! Datei-Typ-Icons für die Vault-Liste.
//!
//! Liefert pro Extension das System-/Theme-Icon und cached es in-memory.
//! Markdown-Dateien (`md`, `markdown`, …) bekommen das App-Icon.
//!
//! Platform-spezifische Implementierungen leben in eigenen Submodulen, die
//! via `#[cfg(target_os = …)]` an die Modul-Deklaration gebunden sind — der
//! Aufrufer ruft schlicht [`icon_for_extension`].

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::compute_icon;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows::compute_icon;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod fallback;
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
use fallback::compute_icon;

#[derive(Clone)]
pub struct IconBytes {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

const APP_ICON_PNG: &[u8] = include_bytes!("../../icons/32x32.png");

const MARKDOWN_EXT: &[&str] = &["md", "markdown", "mdown", "mkd"];

static CACHE: LazyLock<Mutex<HashMap<String, Option<IconBytes>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Liefert das Icon für die gegebene Extension (lowercase, ohne Punkt).
/// Bei leerer Extension oder unbekanntem Typ wird ein generisches Text-Icon
/// versucht; gelingt das nicht, wird `None` zurückgegeben (Frontend zeigt dann
/// einen Fallback).
pub fn icon_for_extension(ext: &str) -> Option<IconBytes> {
    let key = ext.to_ascii_lowercase();

    if MARKDOWN_EXT.contains(&key.as_str()) {
        return Some(IconBytes {
            bytes: APP_ICON_PNG.to_vec(),
            mime: "image/png",
        });
    }

    if let Ok(cache) = CACHE.lock() {
        if let Some(cached) = cache.get(&key) {
            return cached.clone();
        }
    }

    let computed = compute_icon(&key);

    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(key, computed.clone());
    }
    computed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_returns_app_icon() {
        let icon = icon_for_extension("md").expect("markdown should always resolve");
        assert_eq!(icon.mime, "image/png");
        assert!(
            icon.bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]),
            "PNG-Header"
        );
    }

    #[test]
    fn markdown_extensions_are_case_insensitive() {
        assert!(icon_for_extension("MD").is_some());
        assert!(icon_for_extension("Markdown").is_some());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_extensionless_falls_back_to_generic() {
        // Binaries ohne Extension dürfen nicht ohne Icon bleiben — mindestens
        // application-x-generic oder text-x-generic muss greifen.
        assert!(icon_for_extension("").is_some(), "kein Fallback-Icon");
        assert!(
            icon_for_extension("xyzunknownnope").is_some(),
            "unbekannte Extension ohne Fallback"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_resolves_common_extensions() {
        // Erwartet auf einem Standard-Linux-Desktop mit installiertem Icon-Theme,
        // dass mindestens diese gängigen Typen ein Icon liefern.
        for ext in ["pdf", "html", "json", "sh"] {
            assert!(
                icon_for_extension(ext).is_some(),
                "kein Icon für .{ext} gefunden — Theme-Detection fehlgeschlagen?"
            );
        }
    }

    #[test]
    fn cache_hit_on_second_lookup() {
        // Erste Anfrage berechnet, zweite muss gecached sein (sollte schnell sein).
        let _ = icon_for_extension("xyzunknown");
        let _ = icon_for_extension("xyzunknown");
    }
}
