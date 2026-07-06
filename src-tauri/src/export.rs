use crate::{persist, renderer, theme};
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

pub fn render_document(
    layout_id: &str,
    title: &str,
    path: Option<&str>,
    markdown: &str,
) -> Result<String, String> {
    render_document_in(layout_id, title, path, markdown, &persist::themes_dir())
}

pub fn render_theme_preview(
    markdown: &str,
    parts: &theme::store::ThemeParts,
    dark: bool,
    theme_id: Option<&str>,
) -> String {
    let content_css = match (dark, parts.dark_css.as_deref()) {
        (true, Some(dark_css)) => format!("{}\n{dark_css}", parts.content_css),
        _ => parts.content_css.clone(),
    };
    let page_css = parts.page_css.as_deref().unwrap_or(theme::DEFAULT_PAGE_CSS);

    let asset_pairs = load_preview_assets(
        theme_id,
        &content_css,
        page_css,
        [
            parts.cover_html.as_deref(),
            parts.header_html.as_deref(),
            parts.footer_html.as_deref(),
        ],
    );
    let content_css = theme::assets::rewrite_asset_urls(&content_css, &asset_pairs);
    let page_css = theme::assets::rewrite_asset_urls(page_css, &asset_pairs);
    let css = format!("{page_css}\n{content_css}");

    let body = strip_scroll_sync_attrs(&renderer::render_body_highlighted_in(
        markdown,
        dark,
        parts.manifest.hide_inline_frontmatter,
    ));

    let logo_uri = load_preview_logo(theme_id, parts.manifest.logo.as_deref(), &asset_pairs);
    let context = theme::template::TemplateContext::from_markdown(markdown, None, logo_uri);
    let cover = rewrite_rendered_template(
        render_optional_template(parts.cover_html.as_deref(), parts.manifest.cover, &context),
        &asset_pairs,
    );
    let header = rewrite_rendered_template(
        render_optional_template(
            parts.header_html.as_deref(),
            parts.manifest.header,
            &context,
        ),
        &asset_pairs,
    );
    let footer = rewrite_rendered_template(
        render_optional_template(
            parts.footer_html.as_deref(),
            parts.manifest.footer,
            &context,
        ),
        &asset_pairs,
    );

    let title = if parts.manifest.name.trim().is_empty() {
        "Theme-Vorschau"
    } else {
        &parts.manifest.name
    };
    wrap_html(&WrapContext {
        title,
        css: &css,
        body_html: &body,
        cover_html: cover.as_deref(),
        header_html: header.as_deref(),
        footer_html: footer.as_deref(),
    })
}

fn render_document_in(
    layout_id: &str,
    title: &str,
    path: Option<&str>,
    markdown: &str,
    dir: &Path,
) -> Result<String, String> {
    let package = theme::package_in(layout_id, dir)
        .ok_or_else(|| format!("Unbekanntes Layout: '{layout_id}'"))?;
    let content_css = theme::layout_css_in(layout_id, false, dir)
        .ok_or_else(|| format!("Unbekanntes Layout: '{layout_id}'"))?;
    let page_css = theme::page_css_in(layout_id, dir)
        .ok_or_else(|| format!("Unbekanntes Layout: '{layout_id}'"))?;

    let asset_pairs = match package.dir.as_deref() {
        Some(theme_dir) => load_export_assets(
            theme_dir,
            &content_css,
            &page_css,
            [
                package.cover_html.as_deref(),
                package.header_html.as_deref(),
                package.footer_html.as_deref(),
            ],
        )?,
        None => Vec::new(),
    };
    let content_css = theme::assets::rewrite_asset_urls(&content_css, &asset_pairs);
    let page_css = theme::assets::rewrite_asset_urls(&page_css, &asset_pairs);
    let css = format!("{page_css}\n{content_css}");

    let dark = theme::layout_code_dark_in(layout_id, dir);
    let hide_inline = package.manifest.hide_inline_frontmatter;
    let body = strip_scroll_sync_attrs(&renderer::render_body_highlighted_in(
        markdown,
        dark,
        hide_inline,
    ));

    let logo_uri = package.dir.as_deref().and_then(|theme_dir| {
        resolved_logo_uri(theme_dir, package.manifest.logo.as_deref(), &asset_pairs)
    });
    let context = theme::template::TemplateContext::from_markdown(markdown, path, logo_uri);
    let cover = rewrite_rendered_template(
        render_optional_template(
            package.cover_html.as_deref(),
            package.manifest.cover,
            &context,
        ),
        &asset_pairs,
    );
    let header = rewrite_rendered_template(
        render_optional_template(
            package.header_html.as_deref(),
            package.manifest.header,
            &context,
        ),
        &asset_pairs,
    );
    let footer = rewrite_rendered_template(
        render_optional_template(
            package.footer_html.as_deref(),
            package.manifest.footer,
            &context,
        ),
        &asset_pairs,
    );

    Ok(wrap_html(&WrapContext {
        title,
        css: &css,
        body_html: &body,
        cover_html: cover.as_deref(),
        header_html: header.as_deref(),
        footer_html: footer.as_deref(),
    }))
}

/// Deckblatt/Kopf-/Fuesser nur dann rendern, wenn Manifest-Flag UND
/// Template-Datei vorhanden sind. `flag=false` oder `template=None`
/// liefern `None`, sodass [`wrap_html`] das jeweilige Element weglasst.
fn render_optional_template(
    template: Option<&str>,
    flag: bool,
    context: &theme::template::TemplateContext,
) -> Option<String> {
    if flag {
        template.map(|t| context.render(t))
    } else {
        None
    }
}

/// Sammelt Asset-Referenzen (Cover-Header/Footer + url(asset:...))
/// und laedt die benoetigten Assets ueber [`theme::assets::load_assets`].
/// Liefert `(filename, data_uri)`-Paare fuer [`theme::assets::rewrite_asset_urls`].
fn load_export_assets(
    theme_dir: &Path,
    content_css: &str,
    page_css: &str,
    templates: [Option<&str>; 3],
) -> Result<Vec<(String, String)>, String> {
    let refs = collect_references(content_css, page_css, templates);
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    theme::assets::load_assets(theme_dir, &refs)
}

fn load_preview_assets(
    theme_id: Option<&str>,
    content_css: &str,
    page_css: &str,
    templates: [Option<&str>; 3],
) -> Vec<(String, String)> {
    let refs = collect_references(content_css, page_css, templates);
    if refs.is_empty() {
        return Vec::new();
    }
    let Some(id) = theme_id.filter(|id| theme::valid_theme_id(id)) else {
        return Vec::new();
    };
    let theme_dir = persist::themes_dir().join(id);
    if !theme_dir.is_dir() {
        return Vec::new();
    }
    theme::assets::load_assets(&theme_dir, &refs).unwrap_or_default()
}

fn collect_references(
    content_css: &str,
    page_css: &str,
    templates: [Option<&str>; 3],
) -> Vec<String> {
    let mut refs = Vec::new();
    for name in theme::assets::collect_asset_references(content_css)
        .into_iter()
        .chain(theme::assets::collect_asset_references(page_css))
        .chain(
            templates
                .into_iter()
                .flatten()
                .flat_map(theme::assets::collect_template_asset_references),
        )
    {
        if !refs.iter().any(|known| known == &name) {
            refs.push(name);
        }
    }
    refs
}

fn resolved_logo_uri(
    theme_dir: &Path,
    logo: Option<&str>,
    assets: &[(String, String)],
) -> Option<String> {
    let filename = logo?.trim();
    if filename.is_empty() {
        return None;
    }
    assets
        .iter()
        .find(|(name, _)| name == filename)
        .map(|(_, uri)| uri.clone())
        .or_else(|| theme::assets::logo_data_uri(theme_dir, Some(filename)))
}

fn load_preview_logo(
    theme_id: Option<&str>,
    logo: Option<&str>,
    assets: &[(String, String)],
) -> Option<String> {
    let id = theme_id.filter(|id| theme::valid_theme_id(id))?;
    let theme_dir = persist::themes_dir().join(id);
    if !theme_dir.is_dir() {
        return None;
    }
    resolved_logo_uri(&theme_dir, logo, assets)
}

fn rewrite_rendered_template(
    rendered: Option<String>,
    assets: &[(String, String)],
) -> Option<String> {
    rendered.map(|html| theme::assets::rewrite_template_asset_sources(&html, assets))
}

struct WrapContext<'a> {
    title: &'a str,
    css: &'a str,
    body_html: &'a str,
    cover_html: Option<&'a str>,
    header_html: Option<&'a str>,
    footer_html: Option<&'a str>,
}

fn wrap_html(ctx: &WrapContext) -> String {
    let title_escaped = escape_html(ctx.title);
    // `@page :first { margin: 0 }` nur, wenn ein Deckblatt existiert;
    // ohne Deckblatt wuerde die Regel sonst auf jeder ersten Druckseite
    // die Raender wegnehmen.
    let page_first = ctx
        .cover_html
        .map(|_| "@page :first { margin: 0; }\n")
        .unwrap_or("");
    // Seiten- und Content-CSS zuerst, Base-CSS danach: Base liefert
    // Print-Defaults fuer alle Export-Layouts.
    let base = BASE_CSS;
    let mut body = String::new();
    if let Some(header) = ctx.header_html {
        body.push_str("<div class=\"folio-running-header\">");
        body.push_str(header);
        body.push_str("</div>\n");
    }
    if let Some(footer) = ctx.footer_html {
        body.push_str("<div class=\"folio-running-footer\">");
        body.push_str(footer);
        body.push_str("</div>\n");
    }
    if let Some(cover) = ctx.cover_html {
        body.push_str("<section class=\"folio-cover\">");
        body.push_str(cover);
        body.push_str("</section>\n");
    }
    body.push_str("<article class=\"markdown-body\">");
    body.push_str(ctx.body_html);
    body.push_str("</article>\n");
    format!(
        "<!doctype html>\n\
<html lang=\"de\">\n\
<head>\n\
<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{title_escaped}</title>\n\
<style>\n{page_first}{css}\n{base}\n</style>\n\
</head>\n\
<body>\n\
{body}\
</body>\n\
</html>\n",
        css = ctx.css,
    )
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
        let html = render_document("clean", "Hallo Welt", None, "# Hallo").unwrap();
        assert!(html.contains("<title>Hallo Welt</title>"));
        assert!(html.contains(r#"<h1 id="hallo">Hallo</h1>"#));
        assert!(html.contains("<style>"));
        assert!(html.contains("html, body"));
        assert!(html.contains(".markdown-body h1"));
    }

    #[test]
    fn base_css_shows_running_elements_on_screen_and_fixes_them_for_print() {
        assert!(BASE_CSS.contains(
            ".folio-running-header,\n.folio-running-footer {\n  display: block;\n  position: static;"
        ));
        let (_, print) = BASE_CSS.rsplit_once("@media print").unwrap();
        assert!(print.contains(".folio-running-header,"));
        assert!(print.contains(".folio-running-footer"));
        assert!(print.contains("position: fixed;"));
    }

    #[test]
    fn render_document_highlights_builtin_code_and_strips_scroll_sync_attributes() {
        let html = render_document(
            "github",
            "Code",
            None,
            "```rust\nfn main() {}\n```\n\nDanach",
        )
        .unwrap();
        assert!(html.contains(r#"class="language-rust""#), "{html}");
        assert!(html.contains(r#"<span style="#), "{html}");
        assert!(html.contains("#a71d5d"), "{html}");
        assert!(!html.contains("data-sourcepos"), "{html}");
        assert!(!html.contains("data-line"), "{html}");
    }

    #[test]
    fn render_document_each_layout_loads_distinct_css() {
        let classic = render_document("classic", "T", None, "x").unwrap();
        let clean = render_document("clean", "T", None, "x").unwrap();
        let github = render_document("github", "T", None, "x").unwrap();
        assert_ne!(classic, clean);
        assert_ne!(clean, github);
        assert_ne!(classic, github);
    }

    #[test]
    fn render_unknown_layout_errors() {
        assert!(render_document("bogus", "Test", None, "# Hello").is_err());
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

        let light = render_theme_preview("# Titel", &parts, false, None);
        assert!(light.contains("light-marker"));
        assert!(!light.contains("dark-marker"));
        assert!(light.contains("preview-marker"));
        assert!(light.contains("<title>Vorschau</title>"));

        let dark = render_theme_preview("# Titel", &parts, true, None);
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
        let html = render_document("clean", "<bad>", None, "x").unwrap();
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

        let html = render_document_in("mine", "Custom", None, "# Hallo", temp.path()).unwrap();
        assert!(html.contains(DEFAULT_PAGE_CSS));
        assert!(html.contains("#123456"));

        fs::write(
            temp.path().join("mine.page.css"),
            "html, body { background: papayawhip; }",
        )
        .unwrap();
        let html = render_document_in("mine", "Custom", None, "# Hallo", temp.path()).unwrap();
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

        let dark = render_document_in("dark-code", "Dark", None, markdown, temp.path()).unwrap();
        assert!(dark.contains("#b48ead"), "{dark}");
        assert!(!dark.contains("#a71d5d"), "{dark}");

        let light = render_document_in("light-code", "Light", None, markdown, temp.path()).unwrap();
        assert!(light.contains("#a71d5d"), "{light}");
        assert!(!light.contains("#b48ead"), "{light}");
    }

    /// Schreibt ein minimales Verzeichnis-Theme inkl. Manifest, Cover-, Header-,
    /// Footer-Template und Logo-Asset.
    fn write_corporate_theme(temp: &tempfile::TempDir, hide_inline_frontmatter: bool) {
        let dir = temp.path().join("corp");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(dir.join("assets")).unwrap();
        let manifest = if hide_inline_frontmatter {
            r#"{"name":"Corporate","cover":true,"header":true,"footer":true,"logo":"logo.png","hideInlineFrontmatter":true}"#
        } else {
            r#"{"name":"Corporate","cover":true,"header":true,"footer":true,"logo":"logo.png"}"#
        };
        fs::write(dir.join("theme.json"), manifest).unwrap();
        fs::write(
            dir.join("content.css"),
            ".markdown-body .marker { background: url(asset:logo.png); }\n:has(x) { }",
        )
        .unwrap();
        fs::write(
            dir.join("page.css"),
            ".page { marker: url(asset:logo.png); }",
        )
        .unwrap();
        fs::write(
            dir.join("cover.html"),
            "<h1>{{title}}</h1><p>{{date}} · {{author}} · {{company}} · {{subtitle}}</p><div>{{logo}}</div>",
        )
        .unwrap();
        fs::write(
            dir.join("header.html"),
            "<span>{{company}}</span><img src=\"asset:header.png\">",
        )
        .unwrap();
        fs::write(dir.join("footer.html"), "<span>{{author}}</span>").unwrap();
        fs::write(dir.join("assets/logo.png"), b"\x89PNG\r\n\x1a\nFAKELONG").unwrap();
        fs::write(dir.join("assets/header.png"), b"HEADER").unwrap();
    }

    #[test]
    fn render_document_emits_cover_header_footer_with_resolved_placeholders() {
        let temp = tempfile::tempdir().unwrap();
        write_corporate_theme(&temp, false);
        let markdown = "---\ntitle: Bericht\ndate: 01.01.2024\nauthor: Anna\ncompany: Acme\nsubtitle: Ui\n---\n# Inhalt\n\nText\n";

        let html = render_document_in(
            "corp",
            "Bericht",
            Some("/p/bericht.md"),
            markdown,
            temp.path(),
        )
        .unwrap();

        assert!(
            html.contains("<section class=\"folio-cover\">"),
            "cover wrapper fehlt: {html}"
        );
        assert!(
            html.contains("<h1>Bericht</h1>"),
            "titel im cover nicht substituiert"
        );
        assert!(
            html.contains("01.01.2024 · Anna · Acme · Ui"),
            "platzhalterwerte fehlen"
        );
        assert!(
            html.contains("<div class=\"folio-running-header\">"),
            "header wrapper fehlt"
        );
        assert!(
            html.contains("<span>Acme</span>"),
            "company im header fehlt"
        );
        assert!(
            html.contains("<img src=\"data:image/png;base64,SEVBREVS\">"),
            "Template-Asset im Header wurde nicht eingebettet"
        );
        assert!(
            html.contains("<div class=\"folio-running-footer\">"),
            "footer wrapper fehlt"
        );
        assert!(html.contains("<span>Anna</span>"), "author im footer fehlt");
        // {{logo}} expandiert zu <img src="data:..."> — nie escapet.
        assert!(
            html.contains("<img src=\"data:image/png;base64,"),
            "logo-data-uri fehlt"
        );
        assert!(html.contains("alt=\"logo\">"), "logo alt fehlt");
        // @page :first wird nur injiziert, weil ein Deckblatt existiert.
        assert!(
            html.contains("@page :first { margin: 0; }"),
            "@page :first fehlt"
        );
        // Frontmatter-<aside> im Body nur ohne hideInlineFrontmatter.
        assert!(
            html.contains("<aside class=\"frontmatter\">"),
            "frontmatter aside fehlt (no-hide)"
        );
    }

    #[test]
    fn render_document_hide_inline_frontmatter_drops_side_and_keeps_placeholders() {
        let temp = tempfile::tempdir().unwrap();
        write_corporate_theme(&temp, true);
        let markdown = "---\ntitle: Bericht\ndate: 01.01.2024\nauthor: Anna\ncompany: Acme\n---\n# Inhalt\n\nText\n";

        let html = render_document_in(
            "corp",
            "Bericht",
            Some("/p/bericht.md"),
            markdown,
            temp.path(),
        )
        .unwrap();
        assert!(
            !html.contains("<aside class=\"frontmatter\">"),
            "frontmatter-duplikat nicht unterdrueckt"
        );
        assert!(
            html.contains("<h1>Bericht</h1>"),
            "titel im cover fehlt trotz hide-inline"
        );
    }

    #[test]
    fn render_document_rewrites_asset_urls_in_content_and_page_css() {
        let temp = tempfile::tempdir().unwrap();
        write_corporate_theme(&temp, true);
        let html = render_document_in("corp", "Bericht", None, "# Hai", temp.path()).unwrap();
        // Beide css-vorkommen von `url(asset:logo.png)` muessen zu data:-URIs rewrites
        // geworden sein; `url(asset:...)` darf nirgends mehr vorkommen.
        assert!(
            !html.contains("asset:logo.png"),
            "asset:url wurde nicht rewrites: {html}"
        );
        assert!(
            html.matches("data:image/png;base64,").count() >= 2,
            "data:-URI fehlt in css"
        );
    }

    #[test]
    fn collect_references_deduplicates_across_css_and_templates() {
        let refs = collect_references(
            ".a { background: url(asset:shared.png) }",
            ".b { content: url(\"asset:shared.png\") }",
            [
                Some("<img src=\"asset:shared.png\">"),
                Some("<img src='asset:other.svg'>"),
                Some("<img src=asset:shared.png>"),
            ],
        );
        assert_eq!(vec!["shared.png", "other.svg"], refs);
    }

    #[test]
    fn render_document_soft_fails_missing_or_invalid_manifest_logo() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("corp");
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("content.css"), ".markdown-body {}").unwrap();
        fs::write(dir.join("cover.html"), "<div>{{logo}}</div>").unwrap();

        for logo in ["missing.png", "broken.txt"] {
            fs::write(
                dir.join("theme.json"),
                format!(r#"{{"name":"Corp","cover":true,"logo":"{logo}"}}"#),
            )
            .unwrap();
            if logo == "broken.txt" {
                fs::write(dir.join("assets/broken.txt"), b"not an image").unwrap();
            }
            let html =
                render_document_in("corp", "Bericht", None, "# Inhalt", temp.path()).unwrap();
            assert!(html.contains("<section class=\"folio-cover\"><div></div></section>"));
            assert!(!html.contains("alt=\"logo\""));
        }
    }

    #[test]
    fn render_document_keeps_css_asset_failures_hard() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("corp");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("theme.json"), r#"{"name":"Corp"}"#).unwrap();
        fs::write(
            dir.join("content.css"),
            ".markdown-body { background: url(asset:missing.png); }",
        )
        .unwrap();

        let error =
            render_document_in("corp", "Bericht", None, "# Inhalt", temp.path()).unwrap_err();
        assert!(error.contains("missing.png"), "{error}");
    }

    #[test]
    fn render_document_without_cover_template_omits_first_page_rule() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("corp");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("theme.json"), r#"{"name":"Corp"}"#).unwrap();
        fs::write(dir.join("content.css"), ".markdown-body { color: x; }").unwrap();
        fs::write(dir.join("page.css"), "body { margin: 0; }").unwrap();
        // cover.html existiert NICHT — flag false implizit.
        let html = render_document_in("corp", "B", None, "# x", temp.path()).unwrap();
        assert!(
            !html.contains("@page :first { margin: 0; }"),
            "@page :first sollte nicht injiziert werden"
        );
        assert!(
            !html.contains("<section class=\"folio-cover\">"),
            "cover sollte ohne template fehlen"
        );
        assert!(
            !html.contains("<div class=\"folio-running-header\">"),
            "header sollte ohne template fehlen"
        );
    }

    #[test]
    fn render_document_manifest_flag_false_skips_cover_even_with_file_present() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("corp");
        fs::create_dir_all(&dir).unwrap();
        // cover.html vorhanden, Flag aber false — Frontmatter陶醉 duerfen nicht raus.
        fs::write(
            dir.join("theme.json"),
            r#"{"name":"Corp","cover":false,"hideInlineFrontmatter":false}"#,
        )
        .unwrap();
        fs::write(dir.join("content.css"), ".markdown-body { color: x; }").unwrap();
        fs::write(dir.join("cover.html"), "<h1>{{title}}</h1>").unwrap();
        let html = render_document_in("corp", "B", None, "# x", temp.path()).unwrap();
        assert!(
            !html.contains("<section class=\"folio-cover\">"),
            "cover trotz Flag=false emittiert"
        );
        assert!(
            !html.contains("@page :first { margin: 0; }"),
            "@page :first trotz Flag=false emittiert"
        );
    }
}

#[cfg(test)]
mod asset_tests {
    use crate::theme::store;
    use std::fs;

    fn write_minimal_theme(temp: &tempfile::TempDir) {
        let dir = temp.path().join("mine");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("theme.json"), "{}").unwrap();
        fs::write(dir.join("content.css"), ".markdown-body {}").unwrap();
    }

    #[test]
    fn asset_add_writes_directory_lists_and_removes() {
        let temp = tempfile::tempdir().unwrap();
        write_minimal_theme(&temp);

        let info = store::asset_add_in("mine", "logo.png", b"PNG", temp.path()).unwrap();
        assert_eq!(
            info,
            store::AssetInfo {
                filename: "logo.png".to_string(),
                size: 3,
                mime: "image/png".to_string(),
            }
        );
        let listed = store::list_assets_in("mine", temp.path());
        assert_eq!(1, listed.len());
        assert_eq!("logo.png", listed[0].filename);
        assert!(temp.path().join("mine/assets/logo.png").is_file());

        store::asset_remove_in("mine", "logo.png", temp.path()).unwrap();
        assert!(store::list_assets_in("mine", temp.path()).is_empty());
        // Remove missing ist idempotent.
        store::asset_remove_in("mine", "logo.png", temp.path()).unwrap();
    }

    #[test]
    fn asset_add_rejects_unknown_extension() {
        let temp = tempfile::tempdir().unwrap();
        write_minimal_theme(&temp);
        assert!(store::asset_add_in("mine", "logo.txt", b"x", temp.path()).is_err());
        assert!(store::list_assets_in("mine", temp.path()).is_empty());
    }

    #[test]
    fn asset_add_rejects_filename_traversal_and_absolute_paths() {
        let temp = tempfile::tempdir().unwrap();
        write_minimal_theme(&temp);
        for bad in [
            "../escape.png",
            "a/b.png",
            r"a\b.png",
            "C:evil.png",
            ".hidden.png",
            "a..b.png",
        ] {
            let err = store::asset_add_in("mine", bad, b"x", temp.path()).unwrap_err();
            assert!(!err.is_empty(), "{bad} sollte abgelehnt werden");
        }
    }

    #[test]
    fn asset_add_rejects_builtin_ids_and_missing_theme_dir() {
        let temp = tempfile::tempdir().unwrap();
        assert!(store::asset_add_in("clean", "logo.png", b"x", temp.path()).is_err());
        // Theme "ghost-theme" ist nicht gegen waering, es wird abgelehnt\ (gueltig kann aber) — hier exists it nicht:
        assert!(store::asset_add_in("ghost-theme", "logo.png", b"x", temp.path()).is_err());
    }

    #[test]
    fn asset_add_enforces_per_asset_byte_limit() {
        let temp = tempfile::tempdir().unwrap();
        write_minimal_theme(&temp);
        let big = vec![0u8; crate::theme::assets::MAX_ASSET_BYTES + 1];
        let err = store::asset_add_in("mine", "big.png", &big, temp.path()).unwrap_err();
        assert!(err.contains("Maximum"), "{err}");
    }
}
