use std::sync::LazyLock;

use super::IconBytes;

static LINUX_ICON_THEME: LazyLock<Option<String>> = LazyLock::new(detect_linux_icon_theme);

fn detect_linux_icon_theme() -> Option<String> {
    if let Ok(name) = std::env::var("GTK_ICON_THEME") {
        if !name.trim().is_empty() {
            return Some(name);
        }
    }
    // gsettings respektiert die DE-spezifischen Schemas. Cinnamon, GNOME, MATE und
    // Budgie nutzen jeweils eigene, aber alle haben den Key `icon-theme`.
    let schemas = [
        "org.cinnamon.desktop.interface",
        "org.gnome.desktop.interface",
        "org.mate.interface",
        "org.x.apps.portal",
    ];
    for schema in schemas {
        if let Ok(out) = std::process::Command::new("gsettings")
            .args(["get", schema, "icon-theme"])
            .output()
        {
            if out.status.success() {
                let raw = String::from_utf8_lossy(&out.stdout);
                let trimmed = raw.trim().trim_matches('\'').trim_matches('"');
                if !trimmed.is_empty() && trimmed != "''" {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

pub(super) fn compute_icon(ext: &str) -> Option<IconBytes> {
    use xdg_mime::SharedMimeInfo;

    let mime_info = SharedMimeInfo::new();
    let synthetic = if ext.is_empty() {
        "file".to_string()
    } else {
        format!("file.{ext}")
    };
    let mimes = mime_info.get_mime_types_from_file_name(&synthetic);
    // Spezifisches Icon, generischer Typ, dann unverbindliche Fallbacks. Auch
    // wenn xdg-mime gar nichts zur Datei findet (z. B. extensionslose Binaries),
    // probieren wir die generischen Namen, damit nie ein leeres img zurückbleibt.
    let (icon_name, generic_type) = match mimes.first() {
        Some(mime) => (
            mime.essence_str().replace('/', "-"),
            format!("{}-x-generic", mime.type_().as_str()),
        ),
        None => (String::new(), String::new()),
    };
    let candidates = [
        icon_name.as_str(),
        generic_type.as_str(),
        "application-x-generic",
        "text-x-generic",
    ];

    let theme = LINUX_ICON_THEME.as_deref();
    for name in candidates.iter().copied().filter(|n| !n.is_empty()) {
        let path = match theme {
            Some(t) => freedesktop_icons::lookup(name)
                .with_size(32)
                .with_theme(t)
                .find()
                .or_else(|| freedesktop_icons::lookup(name).with_size(32).find()),
            None => freedesktop_icons::lookup(name).with_size(32).find(),
        };
        if let Some(path) = path {
            if let Ok(bytes) = std::fs::read(&path) {
                let mime_kind = match path.extension().and_then(|e| e.to_str()) {
                    Some("svg") => "image/svg+xml",
                    Some("png") => "image/png",
                    Some("xpm") => "image/x-xpixmap",
                    _ => "application/octet-stream",
                };
                return Some(IconBytes {
                    bytes,
                    mime: mime_kind,
                });
            }
        }
    }
    None
}
