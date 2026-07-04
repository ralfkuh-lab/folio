use crate::renderer;
use regex::Regex;
use serde::Serialize;
use std::{
    borrow::Cow,
    fs, io,
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub has_dark: bool,
    pub custom: bool,
}

const CLASSIC_CSS: &str = include_str!("layouts/classic.css");
const CLEAN_CSS: &str = include_str!("layouts/clean.css");
const GITHUB_CSS: &str = include_str!("layouts/github.css");
const CLASSIC_PAGE_CSS: &str = include_str!("layouts/classic.page.css");
const CLEAN_PAGE_CSS: &str = include_str!("layouts/clean.page.css");
const GITHUB_PAGE_CSS: &str = include_str!("layouts/github.page.css");
const CLEAN_DARK_CSS: &str = include_str!("layouts/clean.dark.css");
const GITHUB_DARK_CSS: &str = include_str!("layouts/github.dark.css");
const BASE_CSS: &str = include_str!("layouts/base.css");
const DEFAULT_PAGE_CSS: &str = "html, body { background: #fff; }\nbody { margin: 0; }";
const BUILTIN_IDS: &[&str] = &["standard", "classic", "clean", "github"];

#[derive(Debug, Default, PartialEq, Eq)]
struct ThemeMetadata {
    name: Option<String>,
    description: Option<String>,
    code_dark: bool,
}

fn builtin_layouts() -> Vec<LayoutInfo> {
    vec![
        LayoutInfo {
            id: "classic".to_string(),
            name: "Classic".to_string(),
            description: "Article-Look mit Serifen, A4-orientiert.".to_string(),
            has_dark: false,
            custom: false,
        },
        LayoutInfo {
            id: "clean".to_string(),
            name: "Clean".to_string(),
            description: "Moderne, ruhige Sans-Serif-Optik.".to_string(),
            has_dark: true,
            custom: false,
        },
        LayoutInfo {
            id: "github".to_string(),
            name: "GitHub".to_string(),
            description: "Stil angelehnt an die GitHub-Markdown-Vorschau.".to_string(),
            has_dark: true,
            custom: false,
        },
    ]
}

pub fn layouts() -> Vec<LayoutInfo> {
    layouts_in(&crate::persist::themes_dir())
}

pub fn view_themes() -> Vec<LayoutInfo> {
    view_themes_in(&crate::persist::themes_dir())
}

pub fn custom_themes() -> Vec<LayoutInfo> {
    custom_themes_in(&crate::persist::themes_dir())
}

fn layouts_in(dir: &Path) -> Vec<LayoutInfo> {
    let mut layouts = builtin_layouts();
    layouts.extend(custom_themes_in(dir));
    layouts
}

fn view_themes_in(dir: &Path) -> Vec<LayoutInfo> {
    let mut themes = Vec::new();
    themes.push(standard_theme());
    themes.extend(builtin_layouts());
    themes.extend(custom_themes_in(dir));
    themes
}

fn standard_theme() -> LayoutInfo {
    LayoutInfo {
        id: "standard".to_string(),
        name: "Standard".to_string(),
        description: "Die eingebaute Folio-Ansicht, folgt dem App-Theme.".to_string(),
        has_dark: true,
        custom: false,
    }
}

fn custom_themes_in(dir: &Path) -> Vec<LayoutInfo> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::warn!(
                target: "folio::settings",
                path = %dir.display(),
                %error,
                "Custom-Theme-Verzeichnis kann nicht gelesen werden"
            );
            return Vec::new();
        }
    };
    let mut themes = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!(
                    target: "folio::settings",
                    path = %dir.display(),
                    %error,
                    "Eintrag im Custom-Theme-Verzeichnis kann nicht gelesen werden"
                );
                continue;
            }
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            tracing::warn!(
                target: "folio::settings",
                path = %path.display(),
                "Custom-Theme-Dateiname ist kein gueltiges UTF-8"
            );
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
            tracing::warn!(
                target: "folio::settings",
                path = %path.display(),
                "Custom-Theme hat eine ungueltige ID"
            );
            continue;
        }
        if BUILTIN_IDS.contains(&id) {
            tracing::warn!(
                target: "folio::settings",
                theme_id = id,
                path = %path.display(),
                "Custom-Theme kollidiert mit einem eingebauten Theme und wird ignoriert"
            );
            continue;
        }
        let css = match fs::read_to_string(&path) {
            Ok(css) => css,
            Err(error) => {
                tracing::warn!(
                    target: "folio::settings",
                    theme_id = id,
                    path = %path.display(),
                    %error,
                    "Custom-Theme kann nicht gelesen werden"
                );
                continue;
            }
        };
        let metadata = parse_theme_metadata(&css);
        themes.push(LayoutInfo {
            id: id.to_string(),
            name: metadata.name.unwrap_or_else(|| id.to_string()),
            description: metadata
                .description
                .unwrap_or_else(|| "Eigenes Theme".to_string()),
            has_dark: dir.join(format!("{id}.dark.css")).is_file(),
            custom: true,
        });
    }
    themes.sort_by(|left, right| left.id.cmp(&right.id));
    themes
}

fn parse_theme_metadata(css: &str) -> ThemeMetadata {
    let mut metadata = ThemeMetadata::default();
    for line in css.lines().take(10) {
        let line = line.trim();
        let Some(comment) = line
            .strip_prefix("/*")
            .and_then(|line| line.strip_suffix("*/"))
        else {
            continue;
        };
        let Some((key, value)) = comment.trim().split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.eq_ignore_ascii_case("name") && !value.is_empty() {
            metadata.name = Some(value.to_string());
        } else if key.eq_ignore_ascii_case("description") && !value.is_empty() {
            metadata.description = Some(value.to_string());
        } else if key.eq_ignore_ascii_case("code") {
            metadata.code_dark = match value.to_ascii_lowercase().as_str() {
                "dark" => true,
                "light" => false,
                _ => {
                    tracing::warn!(
                        target: "folio::settings",
                        value,
                        "Unbekannter code-Metadatenwert im Custom-Theme; Light wird verwendet"
                    );
                    false
                }
            };
        }
    }
    metadata
}

fn valid_theme_id(id: &str) -> bool {
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

pub fn layout_css(id: &str, dark: bool) -> Option<Cow<'static, str>> {
    layout_css_in(id, dark, &crate::persist::themes_dir())
}

fn layout_css_in(id: &str, dark: bool, dir: &Path) -> Option<Cow<'static, str>> {
    if !valid_theme_id(id) {
        return None;
    }
    let (light, dark_override) = match id {
        "classic" => (CLASSIC_CSS, None),
        "clean" => (CLEAN_CSS, Some(CLEAN_DARK_CSS)),
        "github" => (GITHUB_CSS, Some(GITHUB_DARK_CSS)),
        "standard" => return None,
        _ => return custom_layout_css_in(id, dark, dir).map(Cow::Owned),
    };
    match (dark, dark_override) {
        (true, Some(override_css)) => Some(Cow::Owned(format!("{light}\n{override_css}"))),
        _ => Some(Cow::Borrowed(light)),
    }
}

pub fn view_theme_css(theme_id: &str, dark: bool) -> Result<Cow<'static, str>, String> {
    view_theme_css_in(theme_id, dark, &crate::persist::themes_dir())
}

fn view_theme_css_in(theme_id: &str, dark: bool, dir: &Path) -> Result<Cow<'static, str>, String> {
    if !valid_theme_id(theme_id) {
        return Err(format!("Unbekanntes View-Theme: '{theme_id}'"));
    }
    if theme_id == "standard" {
        return Ok(Cow::Borrowed(""));
    }
    layout_css_in(theme_id, dark, dir)
        .ok_or_else(|| format!("Unbekanntes View-Theme: '{theme_id}'"))
}

fn custom_layout_css_in(id: &str, dark: bool, dir: &Path) -> Option<String> {
    if !is_custom_theme_in(id, dir) {
        return None;
    }
    let light_path = theme_path(dir, id, ".css")?;
    let light = read_custom_css(&light_path, id)?;
    if !dark {
        return Some(light);
    }
    let dark_path = theme_path(dir, id, ".dark.css")?;
    match fs::read_to_string(&dark_path) {
        Ok(dark_override) => Some(format!("{light}\n{dark_override}")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Some(light),
        Err(error) => {
            tracing::warn!(
                target: "folio::settings",
                theme_id = id,
                path = %dark_path.display(),
                %error,
                "Dark-CSS eines Custom-Themes kann nicht gelesen werden"
            );
            None
        }
    }
}

fn read_custom_css(path: &Path, id: &str) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(css) => Some(css),
        Err(error) => {
            tracing::warn!(
                target: "folio::settings",
                theme_id = id,
                path = %path.display(),
                %error,
                "CSS eines Custom-Themes kann nicht gelesen werden"
            );
            None
        }
    }
}

fn is_custom_theme_in(id: &str, dir: &Path) -> bool {
    valid_theme_id(id)
        && !BUILTIN_IDS.contains(&id)
        && theme_path(dir, id, ".css").is_some_and(|path| path.is_file())
}

fn theme_path(dir: &Path, id: &str, suffix: &str) -> Option<PathBuf> {
    valid_theme_id(id).then(|| dir.join(format!("{id}{suffix}")))
}

fn layout_code_dark_in(id: &str, dir: &Path) -> bool {
    if !valid_theme_id(id) || BUILTIN_IDS.contains(&id) || !is_custom_theme_in(id, dir) {
        return false;
    }
    let Some(path) = theme_path(dir, id, ".css") else {
        return false;
    };
    read_custom_css(&path, id)
        .map(|css| parse_theme_metadata(&css).code_dark)
        .unwrap_or(false)
}

fn page_css_in(id: &str, dir: &Path) -> Option<Cow<'static, str>> {
    if !valid_theme_id(id) {
        return None;
    }
    match id {
        "classic" => Some(Cow::Borrowed(CLASSIC_PAGE_CSS)),
        "clean" => Some(Cow::Borrowed(CLEAN_PAGE_CSS)),
        "github" => Some(Cow::Borrowed(GITHUB_PAGE_CSS)),
        "standard" => None,
        _ if is_custom_theme_in(id, dir) => {
            let path = theme_path(dir, id, ".page.css")?;
            match fs::read_to_string(&path) {
                Ok(css) => Some(Cow::Owned(css)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    Some(Cow::Borrowed(DEFAULT_PAGE_CSS))
                }
                Err(error) => {
                    tracing::warn!(
                        target: "folio::settings",
                        theme_id = id,
                        path = %path.display(),
                        %error,
                        "Page-CSS eines Custom-Themes kann nicht gelesen werden"
                    );
                    None
                }
            }
        }
        _ => None,
    }
}

pub fn render_document(layout_id: &str, title: &str, markdown: &str) -> Result<String, String> {
    render_document_in(layout_id, title, markdown, &crate::persist::themes_dir())
}

fn render_document_in(
    layout_id: &str,
    title: &str,
    markdown: &str,
    dir: &Path,
) -> Result<String, String> {
    let content_css = layout_css_in(layout_id, false, dir)
        .ok_or_else(|| format!("Unbekanntes Layout: '{layout_id}'"))?;
    let page_css =
        page_css_in(layout_id, dir).ok_or_else(|| format!("Unbekanntes Layout: '{layout_id}'"))?;
    let css = format!("{page_css}\n{content_css}");
    let body = strip_scroll_sync_attrs(&renderer::render_body_highlighted(
        markdown,
        layout_code_dark_in(layout_id, dir),
    ));
    Ok(wrap_html(title, &css, &body))
}

pub fn derive_title(path: Option<&str>) -> String {
    path.and_then(|p| Path::new(p).file_stem())
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Dokument".to_string())
}

pub fn derive_default_filename(path: Option<&str>) -> String {
    format!("{}.html", derive_title(path))
}

fn wrap_html(title: &str, css: &str, body_html: &str) -> String {
    let title_escaped = escape_html(title);
    // Seiten- und Content-CSS zuerst, Base-CSS danach: Base liefert
    // Print-Defaults fuer alle Export-Layouts.
    let base = BASE_CSS;
    format!(
        "<!doctype html>\n\
<html lang=\"de\">\n\
<head>\n\
<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{title_escaped}</title>\n\
<style>\n{css}\n{base}\n</style>\n\
</head>\n\
<body>\n\
<article class=\"markdown-body\">\n\
{body_html}\
</article>\n\
</body>\n\
</html>\n"
    )
}

fn strip_scroll_sync_attrs(html: &str) -> String {
    scroll_sync_attr_regex().replace_all(html, "").into_owned()
}

fn scroll_sync_attr_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"\sdata-(?:sourcepos|line)="[^"]*""#).expect("scroll sync attr regex")
    })
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_lists_three_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let l = layouts_in(temp.path());
        assert_eq!(3, l.len());
        let ids: Vec<&str> = l.iter().map(|x| x.id.as_str()).collect();
        assert!(ids.contains(&"classic"));
        assert!(ids.contains(&"clean"));
        assert!(ids.contains(&"github"));
        assert!(l.iter().all(|layout| !layout.custom));
    }

    #[test]
    fn view_themes_list_standard_and_layout_dark_flags() {
        let temp = tempfile::tempdir().unwrap();
        let themes = view_themes_in(temp.path());
        assert_eq!(4, themes.len());
        for (id, has_dark) in [
            ("standard", true),
            ("classic", false),
            ("clean", true),
            ("github", true),
        ] {
            let theme = themes.iter().find(|theme| theme.id == id).unwrap();
            assert_eq!(has_dark, theme.has_dark, "has_dark fuer {id}");
        }
    }

    #[test]
    fn view_theme_css_handles_known_unknown_and_dark_fallback() {
        assert!(view_theme_css("standard", false).unwrap().is_empty());
        for id in ["classic", "clean", "github"] {
            assert!(!view_theme_css(id, false).unwrap().is_empty(), "{id}");
        }
        assert!(view_theme_css("bogus", false).is_err());
        assert_eq!(
            view_theme_css("classic", false).unwrap(),
            view_theme_css("classic", true).unwrap()
        );
        assert!(view_theme_css("github", true).unwrap().contains("#0d1117"));
    }

    #[test]
    fn render_document_includes_title_and_body() {
        let html = render_document("clean", "Hallo Welt", "# Hallo").unwrap();
        assert!(html.contains("<title>Hallo Welt</title>"));
        assert!(html.contains(r#"<h1 id="hallo">Hallo</h1>"#));
        assert!(html.contains("<style>"));
        assert!(html.contains("html, body"));
        assert!(html.contains(".markdown-body h1"));
    }

    #[test]
    fn render_document_highlights_builtin_code_and_strips_scroll_sync_attributes() {
        let html =
            render_document("github", "Code", "```rust\nfn main() {}\n```\n\nDanach").unwrap();
        assert!(html.contains(r#"class="language-rust""#), "{html}");
        assert!(html.contains(r#"<span style="#), "{html}");
        assert!(html.contains("#a71d5d"), "{html}");
        assert!(!html.contains("data-sourcepos"), "{html}");
        assert!(!html.contains("data-line"), "{html}");
    }

    #[test]
    fn render_document_each_layout_loads_distinct_css() {
        let classic = render_document("classic", "T", "x").unwrap();
        let clean = render_document("clean", "T", "x").unwrap();
        let github = render_document("github", "T", "x").unwrap();
        assert_ne!(classic, clean);
        assert_ne!(clean, github);
        assert_ne!(classic, github);
    }

    #[test]
    fn render_unknown_layout_errors() {
        assert!(render_document("bogus", "Test", "# Hello").is_err());
    }

    #[test]
    fn derive_title_uses_file_stem() {
        assert_eq!("notes", derive_title(Some("/path/to/notes.md")));
        assert_eq!("Dokument", derive_title(None));
        assert_eq!("Dokument", derive_title(Some("")));
    }

    #[test]
    fn derive_default_filename_appends_html_extension() {
        assert_eq!("notes.html", derive_default_filename(Some("/p/notes.md")));
        assert_eq!("Dokument.html", derive_default_filename(None));
    }

    #[test]
    fn escape_html_handles_entities() {
        assert_eq!(
            "a&amp;b&lt;c&gt;d&quot;e&#39;f",
            escape_html("a&b<c>d\"e'f")
        );
    }

    #[test]
    fn render_document_escapes_title() {
        let html = render_document("clean", "<bad>", "x").unwrap();
        assert!(html.contains("<title>&lt;bad&gt;</title>"));
    }

    #[test]
    fn custom_themes_are_listed_for_view_and_export_and_sorted() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("zeta.css"),
            ".markdown-body { color: red; }",
        )
        .unwrap();
        fs::write(
            temp.path().join("alpha.css"),
            ".markdown-body { color: blue; }",
        )
        .unwrap();
        fs::write(
            temp.path().join("alpha.dark.css"),
            ".markdown-body { color: cyan; }",
        )
        .unwrap();

        let view = view_themes_in(temp.path());
        let export = layouts_in(temp.path());
        assert_eq!(
            vec!["standard", "classic", "clean", "github", "alpha", "zeta"],
            view.iter()
                .map(|theme| theme.id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            vec!["classic", "clean", "github", "alpha", "zeta"],
            export
                .iter()
                .map(|theme| theme.id.as_str())
                .collect::<Vec<_>>()
        );
        let alpha = view.iter().find(|theme| theme.id == "alpha").unwrap();
        assert!(alpha.custom);
        assert!(alpha.has_dark);
        let zeta = view.iter().find(|theme| theme.id == "zeta").unwrap();
        assert!(zeta.custom);
        assert!(!zeta.has_dark);
    }

    #[test]
    fn custom_theme_metadata_is_parsed_case_insensitively_with_fallbacks() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("meta.css"),
            "/* NAME: Mein Theme */\n/* Description: Ruhige Farben */\n.markdown-body {}",
        )
        .unwrap();
        fs::write(temp.path().join("plain.css"), ".markdown-body {}").unwrap();

        let themes = custom_themes_in(temp.path());
        let meta = themes.iter().find(|theme| theme.id == "meta").unwrap();
        assert_eq!("Mein Theme", meta.name);
        assert_eq!("Ruhige Farben", meta.description);
        let plain = themes.iter().find(|theme| theme.id == "plain").unwrap();
        assert_eq!("plain", plain.name);
        assert_eq!("Eigenes Theme", plain.description);
    }

    #[test]
    fn custom_theme_code_metadata_handles_light_dark_and_unknown_values() {
        assert!(!parse_theme_metadata("/* code: light */").code_dark);
        assert!(parse_theme_metadata("/* CODE: DARK */").code_dark);
        assert!(!parse_theme_metadata("/* code: sepia */").code_dark);
        assert!(!parse_theme_metadata(".markdown-body {}").code_dark);
    }

    #[test]
    fn custom_theme_collisions_and_variant_files_are_not_listed() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("clean.css"), ".markdown-body {}").unwrap();
        fs::write(temp.path().join("orphan.dark.css"), ".markdown-body {}").unwrap();
        fs::write(temp.path().join("orphan.page.css"), "body {}").unwrap();

        let themes = custom_themes_in(temp.path());
        assert!(themes.is_empty());
        let clean = view_themes_in(temp.path())
            .into_iter()
            .find(|theme| theme.id == "clean")
            .unwrap();
        assert!(!clean.custom);
    }

    #[test]
    fn custom_view_theme_css_handles_light_dark_fallback_deletion_and_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let light_path = temp.path().join("mine.css");
        fs::write(&light_path, ".markdown-body { color: #112233; }").unwrap();

        let light = view_theme_css_in("mine", false, temp.path()).unwrap();
        assert!(light.contains("#112233"));
        let dark_fallback = view_theme_css_in("mine", true, temp.path()).unwrap();
        assert_eq!(light, dark_fallback);

        fs::write(
            temp.path().join("mine.dark.css"),
            ".markdown-body { color: #abcdef; }",
        )
        .unwrap();
        let dark = view_theme_css_in("mine", true, temp.path()).unwrap();
        assert!(dark.contains("#112233"));
        assert!(dark.contains("#abcdef"));

        fs::remove_file(light_path).unwrap();
        assert!(view_theme_css_in("mine", false, temp.path()).is_err());
        for id in ["../x", "a/b", r"a\b", "", "a..b", "C:evil"] {
            assert!(view_theme_css_in(id, false, temp.path()).is_err(), "{id}");
            assert!(layout_css_in(id, false, temp.path()).is_none(), "{id}");
        }
    }

    #[test]
    fn custom_render_uses_default_or_explicit_page_css() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("mine.css"),
            ".markdown-body { color: #123456; }",
        )
        .unwrap();

        let html = render_document_in("mine", "Custom", "# Hallo", temp.path()).unwrap();
        assert!(html.contains(DEFAULT_PAGE_CSS));
        assert!(html.contains("#123456"));

        fs::write(
            temp.path().join("mine.page.css"),
            "html, body { background: papayawhip; }",
        )
        .unwrap();
        let html = render_document_in("mine", "Custom", "# Hallo", temp.path()).unwrap();
        assert!(html.contains("background: papayawhip"));
        assert!(!html.contains(DEFAULT_PAGE_CSS));
    }

    #[test]
    fn custom_render_selects_code_palette_from_metadata() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("dark-code.css"),
            "/* code: dark */\n.markdown-body { color: white; }",
        )
        .unwrap();
        fs::write(
            temp.path().join("light-code.css"),
            ".markdown-body { color: black; }",
        )
        .unwrap();
        let markdown = "```rust\nfn main() {}\n```";

        let dark = render_document_in("dark-code", "Dark", markdown, temp.path()).unwrap();
        assert!(dark.contains("#b48ead"), "{dark}");
        assert!(!dark.contains("#a71d5d"), "{dark}");

        let light = render_document_in("light-code", "Light", markdown, temp.path()).unwrap();
        assert!(light.contains("#a71d5d"), "{light}");
        assert!(!light.contains("#b48ead"), "{light}");
    }
}
