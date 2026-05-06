//! Datei-Typ-Icons für die Vault-Liste.
//!
//! Liefert pro Extension das System-/Theme-Icon und cached es in-memory.
//! Markdown-Dateien (`md`, `markdown`, …) bekommen das App-Icon.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

#[derive(Clone)]
pub struct IconBytes {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

const APP_ICON_PNG: &[u8] = include_bytes!("../icons/32x32.png");

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

#[cfg(target_os = "linux")]
fn compute_icon(ext: &str) -> Option<IconBytes> {
    use xdg_mime::SharedMimeInfo;

    let mime_info = SharedMimeInfo::new();
    let synthetic = if ext.is_empty() {
        "file".to_string()
    } else {
        format!("file.{ext}")
    };
    let mimes = mime_info.get_mime_types_from_file_name(&synthetic);
    let mime = mimes.first()?;
    let icon_name = mime.essence_str().replace('/', "-");

    // Fallback-Kette: spezifischer Name → generischer Typ → text-x-generic
    let generic_type = mime.type_().as_str().to_string() + "-x-generic";
    let candidates = [
        icon_name.as_str(),
        generic_type.as_str(),
        "text-x-generic",
    ];

    for name in candidates {
        if let Some(path) = freedesktop_icons::lookup(name).with_size(32).find() {
            if let Ok(bytes) = std::fs::read(&path) {
                let mime_kind = match path.extension().and_then(|e| e.to_str()) {
                    Some("svg") => "image/svg+xml",
                    Some("png") => "image/png",
                    Some("xpm") => "image/x-xpixmap",
                    _ => "application/octet-stream",
                };
                return Some(IconBytes { bytes, mime: mime_kind });
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn compute_icon(ext: &str) -> Option<IconBytes> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
    };

    unsafe {
        let path_str = if ext.is_empty() {
            "dummy".to_string()
        } else {
            format!("dummy.{ext}")
        };
        let wide: Vec<u16> = OsStr::new(&path_str)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut info = SHFILEINFOW::default();
        let result = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_USEFILEATTRIBUTES | SHGFI_ICON | SHGFI_SMALLICON,
        );
        if result == 0 || info.hIcon.is_invalid() {
            return None;
        }

        let png = hicon_to_png(info.hIcon);
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyIcon(info.hIcon);
        png.map(|bytes| IconBytes {
            bytes,
            mime: "image/png",
        })
    }
}

#[cfg(target_os = "windows")]
unsafe fn hicon_to_png(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut icon_info: ICONINFO = std::mem::zeroed();
    GetIconInfo(hicon, &mut icon_info).ok()?;

    let mut bm: BITMAP = std::mem::zeroed();
    let written = GetObjectW(
        HGDIOBJ(icon_info.hbmColor.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut _),
    );
    if written == 0 {
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
        return None;
    }

    let width = bm.bmWidth as u32;
    let height = bm.bmHeight as u32;
    if width == 0 || height == 0 {
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
        return None;
    }

    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width as i32,
        biHeight: -(height as i32), // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0 as u32,
        ..std::mem::zeroed()
    };

    let stride = (width as usize) * 4;
    let mut pixels = vec![0u8; stride * height as usize];

    let hdc = GetDC(None);
    let lines = GetDIBits(
        hdc,
        icon_info.hbmColor,
        0,
        height,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
    let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));

    if lines == 0 {
        return None;
    }

    // Windows liefert BGRA, wir brauchen RGBA für PNG.
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }

    let img = image::RgbaImage::from_raw(width, height, pixels)?;
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).ok()?;
    Some(buf.into_inner())
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn compute_icon(_ext: &str) -> Option<IconBytes> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_returns_app_icon() {
        let icon = icon_for_extension("md").expect("markdown should always resolve");
        assert_eq!(icon.mime, "image/png");
        assert!(icon.bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]), "PNG-Header");
    }

    #[test]
    fn markdown_extensions_are_case_insensitive() {
        assert!(icon_for_extension("MD").is_some());
        assert!(icon_for_extension("Markdown").is_some());
    }

    #[test]
    fn cache_hit_on_second_lookup() {
        // Erste Anfrage berechnet, zweite muss gecached sein (sollte schnell sein).
        let _ = icon_for_extension("xyzunknown");
        let _ = icon_for_extension("xyzunknown");
    }
}
