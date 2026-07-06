use crate::{renderer, theme};
use regex::Regex;
use std::{borrow::Cow, path::Path, sync::OnceLock};

pub use crate::theme::LayoutInfo;

const BASE_CSS: &str = include_str!("layouts/base.css");

pub fn layouts() -> Vec<LayoutInfo> {
    theme::layouts()
}

pub fn view_themes() -> Vec<LayoutInfo> {
    theme::view_themes()
}

pub fn custom_themes() -> Vec<LayoutInfo> {
    theme::custom_themes()
}

pub fn layout_css(id: &str, dark: bool) -> Option<Cow<'static, str>> {
    theme::layout_css(id, dark)
}

pub fn view_theme_css(theme_id: &str, dark: bool) -> Result<Cow<'static, str>, String> {
    theme::view_theme_css(theme_id, dark)
}

pub fn render_document(layout_id: &str, title: &str, markdown: &str) -> Result<String, String> {
    render_document_in(layout_id, title, markdown, &crate::persist::themes_dir())
}

pub fn render_theme_preview(
    markdown: &str,
    parts: &theme::store::ThemeParts,
    dark: bool,
) -> String {
    let content_css = match (dark, parts.dark_css.as_deref()) {
        (true, Some(dark_css)) => format!("{}\n{dark_css}", parts.content_css),
        _ => parts.content_css.clone(),
    };
    let page_css = parts.page_css.as_deref().unwrap_or(theme::DEFAULT_PAGE_CSS);
    let css = format!("{page_css}\n{content_css}");
    let body = strip_scroll_sync_attrs(&renderer::render_body_highlighted(markdown, dark));
    let title = if parts.manifest.name.trim().is_empty() {
        "Theme-Vorschau"
    } else {
        &parts.manifest.name
    };
    wrap_html(title, &css, &body)
}

fn render_document_in(
    layout_id: &str,
    title: &str,
    markdown: &str,
    dir: &Path,
) -> Result<String, String> {
    let content_css = theme::layout_css_in(layout_id, false, dir)
        .ok_or_else(|| format!("Unbekanntes Layout: '{layout_id}'"))?;
    let page_css = theme::page_css_in(layout_id, dir)
        .ok_or_else(|| format!("Unbekanntes Layout: '{layout_id}'"))?;
    let css = format!("{page_css}\n{content_css}");
    let body = strip_scroll_sync_attrs(&renderer::render_body_highlighted(
        markdown,
        theme::layout_code_dark_in(layout_id, dir),
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
    use crate::theme::{
        custom_themes_in, layout_css_in, layouts_in,
        package::parse_legacy_metadata as parse_theme_metadata, view_theme_css_in, view_themes_in,
        DEFAULT_PAGE_CSS,
    };
    use std::fs;

    #[test]
    fn layouts_lists_all_builtin_exports() {
        let temp = tempfile::tempdir().unwrap();
        let l = layouts_in(temp.path());
        assert_eq!(11, l.len());
        let ids: Vec<&str> = l.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(
            &[
                "classic", "clean", "github", "business", "report", "minimal", "brand", "warm",
                "tech", "contrast", "pastel",
            ],
            ids.as_slice()
        );
        assert!(l.iter().all(|layout| !layout.custom));
    }

    #[test]
    fn view_themes_list_standard_and_layout_dark_flags() {
        let temp = tempfile::tempdir().unwrap();
        let themes = view_themes_in(temp.path());
        assert_eq!(12, themes.len());
        for (id, has_dark) in [
            ("standard", true),
            ("classic", false),
            ("clean", true),
            ("github", true),
            ("business", true),
            ("report", true),
            ("minimal", true),
            ("brand", true),
            ("warm", true),
            ("tech", true),
            ("contrast", true),
            ("pastel", true),
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
    fn theme_preview_uses_unsaved_parts_and_dark_override() {
        let parts = crate::theme::store::ThemeParts {
            manifest: crate::theme::package::ThemeManifest {
                name: "Vorschau".to_string(),
                ..crate::theme::package::ThemeManifest::default()
            },
            content_css: ".markdown-body { color: light-marker; }".to_string(),
            dark_css: Some(".markdown-body { color: dark-marker; }".to_string()),
            page_css: Some("body { margin: preview-marker; }".to_string()),
            cover_html: None,
            header_html: None,
            footer_html: None,
        };

        let light = render_theme_preview("# Titel", &parts, false);
        assert!(light.contains("light-marker"));
        assert!(!light.contains("dark-marker"));
        assert!(light.contains("preview-marker"));
        assert!(light.contains("<title>Vorschau</title>"));

        let dark = render_theme_preview("# Titel", &parts, true);
        assert!(dark.contains("light-marker"));
        assert!(dark.contains("dark-marker"));
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
            vec![
                "standard", "classic", "clean", "github", "business", "report", "minimal", "brand",
                "warm", "tech", "contrast", "pastel", "alpha", "zeta",
            ],
            view.iter()
                .map(|theme| theme.id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            vec![
                "classic", "clean", "github", "business", "report", "minimal", "brand", "warm",
                "tech", "contrast", "pastel", "alpha", "zeta",
            ],
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
