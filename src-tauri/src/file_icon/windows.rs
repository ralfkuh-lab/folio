use super::IconBytes;

pub(super) fn compute_icon(ext: &str) -> Option<IconBytes> {
    // Erst per AssocQueryString versuchen (respektiert User-Choice in HKCU,
    // z. B. Chrome statt legacy htmlfile/iexplore.exe). Fallback: SHGetFileInfo.
    if let Some(icon) = icon_via_assoc_query(ext) {
        return Some(icon);
    }
    icon_via_shgetfileinfo(ext)
}

fn icon_via_assoc_query(ext: &str) -> Option<IconBytes> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        AssocQueryStringW, ExtractIconExW, ASSOCF_NONE, ASSOCSTR_DEFAULTICON,
    };

    if ext.is_empty() {
        return None;
    }
    let dotted = format!(".{ext}");
    let assoc_wide: Vec<u16> = OsStr::new(&dotted)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut needed: u32 = 0;
        // Erste Anfrage ermittelt nur die Puffergröße.
        let _ = AssocQueryStringW(
            ASSOCF_NONE,
            ASSOCSTR_DEFAULTICON,
            PCWSTR(assoc_wide.as_ptr()),
            PCWSTR::null(),
            windows::core::PWSTR::null(),
            &mut needed,
        );
        if needed == 0 {
            return None;
        }

        let mut buf = vec![0u16; needed as usize];
        let result = AssocQueryStringW(
            ASSOCF_NONE,
            ASSOCSTR_DEFAULTICON,
            PCWSTR(assoc_wide.as_ptr()),
            PCWSTR::null(),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut needed,
        );
        if result.is_err() {
            return None;
        }

        let nul = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let icon_string = String::from_utf16_lossy(&buf[..nul]);
        // Format: "path,index". Index kann negativ sein (Resource-ID).
        let (path, index) = match icon_string.rsplit_once(',') {
            Some((p, i)) => (p.trim().trim_matches('"'), i.trim().parse::<i32>().ok()?),
            None => (icon_string.trim(), 0),
        };
        if path.is_empty() {
            return None;
        }

        let path_wide: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut large_icon = windows::Win32::UI::WindowsAndMessaging::HICON::default();
        let extracted = ExtractIconExW(
            PCWSTR(path_wide.as_ptr()),
            index,
            None,
            Some(&mut large_icon),
            1,
        );
        if extracted == 0 || large_icon.is_invalid() {
            return None;
        }

        let png = hicon_to_png(large_icon);
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyIcon(large_icon);
        png.map(|bytes| IconBytes {
            bytes,
            mime: "image/png",
        })
    }
}

fn icon_via_shgetfileinfo(ext: &str) -> Option<IconBytes> {
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

unsafe fn hicon_to_png(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
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
        biCompression: BI_RGB.0,
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
