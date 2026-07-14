//! Asset-Einbettung fuer Corporate-Design-Exports.
//!
//! Assets (Logos, Wasserzeichen, ...) werden verpflichtend als data:-
//! URI eingebettet — der PDF-Pfad schreibt das Temp-HTML ins Dokument-
//! Source-Verzeichnis, relative Pfade ins Theme-Verzeichnis loesen dort
//! nicht auf. MIME per Extension-Map (cross-platform, kein xdg-mime),
//! unbekannte Endung -> harte Ablehnung. Harte Groessen-Limits schuetzen
//! vor MB-HTML/PDF-Explosion.

use base64::Engine;
use regex::{Captures, Regex};
use std::{fs, path::Path, sync::OnceLock};

pub const MAX_ASSET_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_TOTAL_ASSET_BYTES: usize = 15 * 1024 * 1024;

const ASSET_DIR: &str = "assets";

/// MIME pro Extension. Unbekannte Endung -> None -> Ablehnung.
pub(crate) fn mime_for_extension(filename: &str) -> Option<&'static str> {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "woff2" => Some("font/woff2"),
        "woff" => Some("font/woff"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        _ => None,
    }
}

/// Erlaubt ein Asset-Dateinamen nur dann, wenn er sicher innerhalb des
/// `assets/`-Unterordners liegt: kein Trenner, kein `..`, kein absoluter
/// Pfad, kein Laufwerksprefix (`:`), kein NUL-Byte, nicht leer.
pub(crate) fn validate_asset_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("asset filename is empty".to_string());
    }
    if filename.starts_with('.') {
        return Err(format!(
            "asset filename '{filename}' must not start with a dot"
        ));
    }
    if filename.contains('/') || filename.contains('\\') {
        return Err(format!(
            "asset filename '{filename}' must not contain path separators"
        ));
    }
    if filename.contains("..") {
        return Err(format!("asset filename '{filename}' must not contain '..'"));
    }
    if filename.contains(':') {
        return Err(format!("asset filename '{filename}' must not contain ':'"));
    }
    if filename.contains('\0') {
        return Err(format!("asset filename '{filename}' contains a NUL byte"));
    }
    Ok(())
}

/// Baut eine data:-URI aus Bytes. MIME via Extension, Ablehnung bei
/// unbekannter Endung oder Groessenueberschreitung.
pub(crate) fn data_uri(filename: &str, bytes: &[u8]) -> Result<String, String> {
    validate_asset_filename(filename)?;
    let mime = mime_for_extension(filename)
        .ok_or_else(|| format!("asset file '{filename}' has an unsupported extension"))?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "asset '{filename}' is {} bytes in size, maximum is {} bytes",
            bytes.len(),
            MAX_ASSET_BYTES
        ));
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Laedt ein Asset aus `<theme_dir>/assets/<filename>` und gibt dessen
/// data:-URI zurueck. Validiert Filename und Groesse; liest bytes und
/// leitet an [`data_uri`] weiter.
pub(crate) fn load_asset(theme_dir: &Path, filename: &str) -> Result<String, String> {
    validate_asset_filename(filename)?;
    let path = theme_dir.join(ASSET_DIR).join(filename);
    let bytes = fs::read(&path)
        .map_err(|error| format!("cannot read asset '{}': {error}", path.display()))?;
    data_uri(filename, &bytes)
}

/// Laedt mehrere Assets und kumuliert die Bytes gegen das Gesamtlimit.
/// Liefert `(filename, data_uri)`-Paare in der gleichen Reihenfolge.
pub(crate) fn load_assets(
    theme_dir: &Path,
    filenames: &[String],
) -> Result<Vec<(String, String)>, String> {
    let mut total: usize = 0;
    let mut out = Vec::with_capacity(filenames.len());
    for filename in filenames {
        validate_asset_filename(filename)?;
        let path = theme_dir.join(ASSET_DIR).join(filename);
        let bytes = fs::read(&path)
            .map_err(|error| format!("cannot read asset '{}': {error}", path.display()))?;
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| "total asset size overflowed".to_string())?;
        if total > MAX_TOTAL_ASSET_BYTES {
            return Err(format!(
                "total asset size ({total} bytes) exceeds the limit of {} bytes",
                MAX_TOTAL_ASSET_BYTES
            ));
        }
        let uri = data_uri(filename, &bytes)?;
        out.push((filename.to_string(), uri));
    }
    Ok(out)
}

/// Sammelt die Asset-Dateinamen, die im CSS via `url(asset:...)`
/// referenziert werden, in der Reihenfolge ihres ersten Auftretens.
/// Whitespaces und umschliessende Quotes am Namen werden beschnitten.
pub(crate) fn collect_asset_references(css: &str) -> Vec<String> {
    let re = asset_url_regex();
    let mut names: Vec<String> = Vec::new();
    for caps in re.captures_iter(css) {
        let raw = caps.get(1).unwrap().as_str();
        let name = raw.trim().trim_matches(|c| c == '\'' || c == '"');
        if name.is_empty() {
            continue;
        }
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// Sammelt Asset-Referenzen aus Content-CSS, Page-CSS und optionalen
/// Templates in stabiler Erstfund-Reihenfolge.
pub(crate) fn collect_references(
    content_css: &str,
    page_css: &str,
    templates: [Option<&str>; 3],
) -> Vec<String> {
    let mut refs = Vec::new();
    for name in collect_asset_references(content_css)
        .into_iter()
        .chain(collect_asset_references(page_css))
        .chain(
            templates
                .into_iter()
                .flatten()
                .flat_map(collect_template_asset_references),
        )
    {
        if !refs.iter().any(|known| known == &name) {
            refs.push(name);
        }
    }
    refs
}

/// Ersetzt `url(asset:name)` durch `url("data:...")`. Nur Namen, die in
/// der ubergebenen Asset-Map vorhanden sind (also im eigenen Theme-Ordner
/// gelegen), werden ersetzt — fremde/fehlende bleiben als `url(asset:...)`
/// stehen, damit der User den Bruch bemerkt.
pub(crate) fn rewrite_asset_urls(css: &str, assets: &[(String, String)]) -> String {
    let re = asset_url_regex();
    re.replace_all(css, |caps: &Captures| {
        let raw = caps.get(1).unwrap().as_str();
        let name = raw.trim().trim_matches(|c| c == '\'' || c == '"');
        if let Some((_, uri)) = assets.iter().find(|(n, _)| n == name) {
            format!("url(\"{uri}\")")
        } else {
            caps.get(0).unwrap().as_str().to_string()
        }
    })
    .into_owned()
}

/// Sammelt `asset:`-Referenzen aus `src`-Attributen eines Template-
/// Fragments. Quoted und unquoted Attribute werden akzeptiert.
pub(crate) fn collect_template_asset_references(html: &str) -> Vec<String> {
    let mut names = Vec::new();
    for caps in asset_src_regex().captures_iter(html) {
        let Some(name) = capture_asset_name(&caps) else {
            continue;
        };
        if !name.is_empty() && !names.iter().any(|known| known == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// Ersetzt `src="asset:name"` (einschliesslich Quote-Varianten) durch
/// die geladene data:-URI. Unbekannte Referenzen bleiben sichtbar
/// unveraendert.
pub(crate) fn rewrite_template_asset_sources(html: &str, assets: &[(String, String)]) -> String {
    asset_src_regex()
        .replace_all(html, |caps: &Captures| {
            let Some(name) = capture_asset_name(caps) else {
                return caps.get(0).unwrap().as_str().to_string();
            };
            if let Some((_, uri)) = assets.iter().find(|(known, _)| known == name) {
                let prefix = caps
                    .name("prefix")
                    .map(|value| value.as_str())
                    .unwrap_or("");
                format!("{prefix}src=\"{uri}\"")
            } else {
                caps.get(0).unwrap().as_str().to_string()
            }
        })
        .into_owned()
}

/// Liefert die data:-URI fuer das im Manifest genannte Logo-Asset oder
/// None, wenn kein Logo konfiguriert/verfuegbar ist. Fehler beim Laden
/// werden geloggt und als None quittiert (Export geschieht dann ohne
/// Logo), damit ein kaputtes Logo nicht den gesamten Export blockiert.
pub(crate) fn logo_data_uri(theme_dir: &Path, logo: Option<&str>) -> Option<String> {
    let filename = logo?.trim();
    if filename.is_empty() {
        return None;
    }
    match load_asset(theme_dir, filename) {
        Ok(uri) => Some(uri),
        Err(error) => {
            tracing::warn!(
                target: "folio::settings",
                logo = filename,
                %error,
                "Logo-Asset kann nicht geladen werden; Export ohne Logo"
            );
            None
        }
    }
}

fn asset_url_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"url\(\s*["']?asset:([^)"']+?)["']?\s*\)"#).expect("asset url regex")
    })
}

fn asset_src_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?i)(?P<prefix>^|[\s<])src\s*=\s*(?:"\s*asset:([^"]+?)\s*"|'\s*asset:([^']+?)\s*'|asset:([^\s>]+))"#,
        )
        .expect("asset src regex")
    })
}

fn capture_asset_name<'h>(caps: &Captures<'h>) -> Option<&'h str> {
    caps.get(2)
        .or_else(|| caps.get(3))
        .or_else(|| caps.get(4))
        .map(|value| value.as_str().trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_known_extensions() {
        for (name, expected) in [
            ("a.png", "image/png"),
            ("b.JPG", "image/jpeg"),
            ("c.JPEG", "image/jpeg"),
            ("d.svg", "image/svg+xml"),
            ("e.avif", "image/avif"),
            ("f.ico", "image/x-icon"),
            ("g.webp", "image/webp"),
            ("h.bmp", "image/bmp"),
            ("i.gif", "image/gif"),
            ("j.woff2", "font/woff2"),
            ("k.woff", "font/woff"),
            ("l.ttf", "font/ttf"),
            ("m.otf", "font/otf"),
        ] {
            assert_eq!(Some(expected), mime_for_extension(name), "{name}");
        }
    }

    #[test]
    fn mime_unknown_extension_rejected() {
        assert!(mime_for_extension("x.txt").is_none());
        assert!(mime_for_extension("noext").is_none());
    }

    #[test]
    fn data_uri_builds_complete_uri() {
        let uri = data_uri("logo.png", b"PNG").unwrap();
        assert_eq!("data:image/png;base64,UE5H", uri);
    }

    #[test]
    fn data_uri_rejects_unknown_extension() {
        let err = data_uri("logo.txt", b"x").unwrap_err();
        assert!(err.contains("unsupported"));
    }

    #[test]
    fn data_uri_rejects_filename_traversal() {
        for bad in [
            "../x.png",
            "a/b.png",
            r"a\b.png",
            "C:evil.png",
            ".hidden.png",
            "",
            "a..b.png",
        ] {
            let err = data_uri(bad, b"x").unwrap_err();
            assert!(!err.is_empty(), "{bad}");
        }
    }

    #[test]
    fn data_uri_enforces_per_asset_byte_limit() {
        let big = vec![0u8; MAX_ASSET_BYTES + 1];
        let err = data_uri("logo.png", &big).unwrap_err();
        assert!(err.contains("maximum"), "{err}");
    }

    #[test]
    fn load_asset_reads_from_assets_subdir() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("theme");
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/logo.png"), b"PNG").unwrap();
        let uri = load_asset(&dir, "logo.png").unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn load_assets_enforces_total_byte_limit() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("theme");
        fs::create_dir_all(dir.join("assets")).unwrap();
        // 4 x 4 MB = 16 MB > 15 MB Gesamtlimit, aber jede Datei unter dem
        // 5 MB Asset-Limit, sodass nur die kumulierte Prauefung schlaegt.
        let chunk = vec![0u8; 4 * 1024 * 1024];
        for n in 0..4u32 {
            fs::write(dir.join(format!("assets/big_{n}.png")), &chunk).unwrap();
        }
        let names: Vec<String> = (0..4u32).map(|n| format!("big_{n}.png")).collect();
        let err = load_assets(&dir, &names).unwrap_err();
        assert!(err.contains("total asset size"), "{err}");
    }

    #[test]
    fn load_assets_success_under_limits() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("theme");
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/a.png"), b"A").unwrap();
        fs::write(dir.join("assets/b.svg"), b"B").unwrap();
        let out = load_assets(&dir, &["a.png".into(), "b.svg".into()]).unwrap();
        assert_eq!(2, out.len());
        assert!(out[0].1.starts_with("data:image/png;base64,"));
        assert!(out[1].1.starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn rewrite_replaces_known_asset_urls() {
        let assets = vec![(
            "logo.png".to_string(),
            "data:image/png;base64,ZZ".to_string(),
        )];
        let css = ".x { background: url(asset:logo.png) center; }";
        assert_eq!(
            ".x { background: url(\"data:image/png;base64,ZZ\") center; }",
            rewrite_asset_urls(css, &assets)
        );
    }

    #[test]
    fn rewrite_leaves_unknown_asset_urls_untouched() {
        let css = ".x { background: url(asset:missing.png); }";
        assert_eq!(css, rewrite_asset_urls(css, &[]));
    }

    #[test]
    fn rewrite_tolerates_whitespace_and_quotes() {
        let assets = vec![(
            "watermark.svg".to_string(),
            "data:image/svg+xml;base64,W".to_string(),
        )];
        for css in [
            "a { b: url(  asset:watermark.svg  ) }",
            "a { b: url(\"asset:watermark.svg\") }",
            "a { b: url('asset:watermark.svg') }",
        ] {
            let refs = collect_asset_references(css);
            assert_eq!(vec!["watermark.svg"], refs, "{css}");
            let out = rewrite_asset_urls(css, &assets);
            assert_eq!("a { b: url(\"data:image/svg+xml;base64,W\") }", out);
        }
    }

    #[test]
    fn template_asset_sources_are_collected_and_rewritten() {
        let html = concat!(
            "<img src=\"asset:cover.png\">",
            "<img SRC='asset:mark.svg'>",
            "<img src=asset:cover.png>",
            "<img data-src=\"asset:ignored.png\">",
        );
        assert_eq!(
            vec!["cover.png", "mark.svg"],
            collect_template_asset_references(html)
        );
        let assets = vec![
            (
                "cover.png".to_string(),
                "data:image/png;base64,C".to_string(),
            ),
            (
                "mark.svg".to_string(),
                "data:image/svg+xml;base64,M".to_string(),
            ),
        ];
        let rewritten = rewrite_template_asset_sources(html, &assets);
        assert_eq!(2, rewritten.matches("data:image/png;base64,C").count());
        assert_eq!(1, rewritten.matches("data:image/svg+xml;base64,M").count());
        assert!(rewritten.contains("data-src=\"asset:ignored.png\""));
    }

    #[test]
    fn logo_data_uri_returns_none_without_logo() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(None, logo_data_uri(temp.path(), None));
        assert_eq!(None, logo_data_uri(temp.path(), Some("")));
        assert_eq!(None, logo_data_uri(temp.path(), Some("   ")));
    }

    #[test]
    fn logo_data_uri_loads_configured_logo() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("theme");
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/logo.png"), b"PNG").unwrap();
        let uri = logo_data_uri(&dir, Some("logo.png")).unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn logo_data_uri_logs_and_returns_none_when_missing() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("theme");
        assert_eq!(None, logo_data_uri(&dir, Some("missing.png")));
    }
}
