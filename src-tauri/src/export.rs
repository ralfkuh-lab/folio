use crate::renderer;
use regex::Regex;
use serde::Serialize;
use std::{path::Path, sync::OnceLock};

#[derive(Debug, Clone, Serialize)]
pub struct LayoutInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

const LAYOUTS: &[LayoutInfo] = &[
    LayoutInfo {
        id: "classic",
        name: "Classic",
        description: "Article-Look mit Serifen, A4-orientiert.",
    },
    LayoutInfo {
        id: "clean",
        name: "Clean",
        description: "Moderne, ruhige Sans-Serif-Optik.",
    },
    LayoutInfo {
        id: "github",
        name: "GitHub",
        description: "Stil angelehnt an die GitHub-Markdown-Vorschau.",
    },
];

const CLASSIC_CSS: &str = include_str!("layouts/classic.css");
const CLEAN_CSS: &str = include_str!("layouts/clean.css");
const GITHUB_CSS: &str = include_str!("layouts/github.css");
const BASE_CSS: &str = include_str!("layouts/base.css");

pub fn layouts() -> Vec<LayoutInfo> {
    LAYOUTS.to_vec()
}

pub fn layout_css(id: &str) -> Option<&'static str> {
    match id {
        "classic" => Some(CLASSIC_CSS),
        "clean" => Some(CLEAN_CSS),
        "github" => Some(GITHUB_CSS),
        _ => None,
    }
}

pub fn render_document(layout_id: &str, title: &str, markdown: &str) -> Result<String, String> {
    let css = layout_css(layout_id).ok_or_else(|| format!("Unbekanntes Layout: '{layout_id}'"))?;
    let body = strip_scroll_sync_attrs(&renderer::render_body(markdown));
    Ok(wrap_html(title, css, &body))
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
    // Layout-CSS zuerst, Base-CSS danach: Base liefert Print-Defaults für
    // alle Themes; Custom-Themes können konkurrierende Werte über ihre
    // eigene @media print-Regel setzen (gleiche Spezifität, gewinnt durch
    // spätere Position innerhalb des Layout-CSS).
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
        let l = layouts();
        assert_eq!(3, l.len());
        let ids: Vec<&str> = l.iter().map(|x| x.id).collect();
        assert!(ids.contains(&"classic"));
        assert!(ids.contains(&"clean"));
        assert!(ids.contains(&"github"));
    }

    #[test]
    fn render_document_includes_title_and_body() {
        let html = render_document("clean", "Hallo Welt", "# Hallo").unwrap();
        assert!(html.contains("<title>Hallo Welt</title>"));
        assert!(html.contains(r#"<h1 id="hallo">Hallo</h1>"#));
        assert!(html.contains("<style>"));
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
}
