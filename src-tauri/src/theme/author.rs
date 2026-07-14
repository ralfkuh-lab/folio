//! KI-Theme-Autor (Stufe 1): Prompt-Contract, JSON-Parse und das
//! Validierungs-Gate fuer LLM-generierte Theme-Pakete.
//!
//! Der Autor erzeugt einen [`ThemeDraft`], der NICHT persistiert wird —
//! das Frontend schreibt ihn in die Editor-Buffer, der User reviewt und
//! speichert selbst (Andockstelle fuer die spaetere Per-Export-Stufe).
//! Analog zum `mask::unmask`-Gate der Uebersetzung gilt: Verstoesse sind
//! Fehler, keine stille Uebernahme.

use super::{
    builtin,
    package::{validate_manifest_fonts, ThemeManifest},
    template, valid_theme_id,
};
use serde::{Deserialize, Serialize};

/// Nicht persistiertes Ergebnis des KI-Autors, geht als Command-Return
/// in die Editor-Buffer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDraft {
    pub manifest: Option<ThemeManifest>,
    pub content_css: String,
    pub dark_css: Option<String>,
    pub page_css: Option<String>,
    pub cover_html: Option<String>,
    pub header_html: Option<String>,
    pub footer_html: Option<String>,
}

/// Roh-Antwort des Modells (camelCase-JSON laut Format-Contract).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawDraft {
    pub manifest: Option<ThemeManifest>,
    pub content_css: String,
    pub dark_css: Option<String>,
    pub page_css: Option<String>,
    pub cover_html: Option<String>,
    pub header_html: Option<String>,
    pub footer_html: Option<String>,
}

/// Kontextdateien eines bestehenden Themes fuer den Verfeinerungs-Modus.
pub struct BaseContext {
    pub id: String,
    pub content_css: String,
    pub dark_css: Option<String>,
    pub page_css: Option<String>,
    pub cover_html: Option<String>,
    pub header_html: Option<String>,
    pub footer_html: Option<String>,
}

const DOCUMENT_EXCERPT_CHARS: usize = 12_000;

/// System-Prompt = Format-Contract. Die Regeln stehen im Prompt UND
/// werden nachgelagert vom Gate erzwungen — der Schutz haengt nicht an
/// der Prompt-Disziplin des Modells.
pub fn system_prompt(base: Option<&BaseContext>, document_context: Option<&str>) -> String {
    let mut prompt = String::from(
        "Du bist ein Theme-Autor fuer den Markdown-Viewer folio. \
         Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt, ohne \
         Erklaertext. Felder (alle optional ausser contentCss): \
         manifest {name, description, code: \"light\"|\"dark\", logo, \
         cover, header, footer, hideInlineFrontmatter, fontBody, fontMono, \
         fontSize}, contentCss, \
         darkCss, pageCss, coverHtml, headerHtml, footerHtml.\n\
         Regeln:\n\
         - Alle CSS-Selektoren sind strikt auf .markdown-body gescopt.\n\
         - Verwende die Custom-Property-Konvention --fg/--muted/--rule/\
           --rule-soft/--accent/--code-bg/--quote-bar; die Dark-Variante \
           (darkCss) ueberschreibt nur diese Properties.\n\
         - In coverHtml/headerHtml/footerHtml sind nur die Platzhalter \
           {{title}} {{subtitle}} {{author}} {{company}} {{date}} \
           {{logo}} erlaubt und nur einfache Tags (div, section, header, \
           footer, h1-h3, p, span, img, table, tr, td, br, strong, em).\n\
         - Kein <script>, keine on*-Attribute, keine externen URLs, kein \
           @import; img-src nur data:image/... oder asset:<datei>.\n\
         - fontBody/fontMono sind CSS-Font-Family-Strings ohne { } < > ; @ \
           und ohne url(...); fontSize ist Zahl plus px, pt, em, rem oder %.\n\
         - Du erzeugst keine Binaerassets; referenziere Logos nur ueber \
           {{logo}} oder url(asset:<vorhandene datei>).",
    );
    if let Some(document) = document_context.filter(|document| !document.trim().is_empty()) {
        prompt.push_str(
            "\n\nDokument-Kontext: Gestalte das Theme passend zu Struktur \
             und Inhalt dieses Dokuments; kopiere den Dokumentinhalt NICHT \
             in die Theme-Dateien. Beginnt das Dokument mit einem \
             Frontmatter-Block, setze bevorzugt hideInlineFrontmatter: true \
             und zeige die Titeldaten stattdessen ueber ein Cover \
             ({{title}}/{{author}}/{{date}}).\n\n=== Dokumentauszug ===\n",
        );
        prompt.push_str(document);
    }
    if let Some(base) = base {
        prompt.push_str(&format!(
            "\n\nVerfeinerungs-Modus: Basis ist das bestehende Theme \
             '{}'. Aktuelle Dateien folgen; aendere gezielt, behalte \
             Bewaehrtes.\n\n=== content.css ===\n{}",
            base.id, base.content_css
        ));
        for (label, part) in [
            ("content.dark.css", &base.dark_css),
            ("page.css", &base.page_css),
            ("cover.html", &base.cover_html),
            ("header.html", &base.header_html),
            ("footer.html", &base.footer_html),
        ] {
            if let Some(content) = part {
                prompt.push_str(&format!("\n=== {label} ===\n{content}"));
            }
        }
    }
    prompt
}

pub fn document_excerpt(markdown: &str) -> String {
    let (frontmatter, body) = split_frontmatter(markdown);
    let (prefix, truncated) = first_chars(body, DOCUMENT_EXCERPT_CHARS);
    if !truncated && frontmatter.is_none() {
        return markdown.to_string();
    }
    if !truncated {
        return match frontmatter {
            Some(frontmatter) => format!("{frontmatter}{body}"),
            None => body.to_string(),
        };
    }

    let mut out = String::new();
    if let Some(frontmatter) = frontmatter {
        out.push_str(frontmatter);
    }
    out.push_str(&prefix);
    out.push_str("\n\n[Dokument gekuerzt]\n");
    let headings = heading_skeleton(markdown);
    if !headings.is_empty() {
        out.push_str("\nHeading-Skelett:\n");
        out.push_str(&headings);
    }
    out
}

fn split_frontmatter(markdown: &str) -> (Option<&str>, &str) {
    let Some(rest) = markdown.strip_prefix("---\n") else {
        return (None, markdown);
    };
    let mut offset = 4;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return (Some(&markdown[..offset]), &markdown[offset..]);
        }
    }
    (None, markdown)
}

fn first_chars(input: &str, limit: usize) -> (String, bool) {
    let mut iter = input.char_indices();
    for _ in 0..limit {
        if iter.next().is_none() {
            return (input.to_string(), false);
        }
    }
    match iter.next() {
        Some((idx, _)) => (input[..idx].to_string(), true),
        None => (input.to_string(), false),
    }
}

fn heading_skeleton(markdown: &str) -> String {
    markdown
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let hashes = trimmed.chars().take_while(|c| *c == '#').count();
            if !(1..=6).contains(&hashes) {
                return None;
            }
            let rest = trimmed.get(hashes..)?;
            if !rest.starts_with(' ') {
                return None;
            }
            Some(trimmed.to_string())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parst die Modell-Antwort als JSON; tolerant gegenueber einem
/// umschliessenden ```json-Fence.
pub fn parse_draft(raw: &str) -> Result<RawDraft, String> {
    let trimmed = raw.trim();
    let body = strip_code_fence(trimmed);
    serde_json::from_str::<RawDraft>(body)
        .map_err(|error| format!("KI-Antwort ist kein gueltiges Theme-JSON: {error}"))
}

fn strip_code_fence(s: &str) -> &str {
    let Some(rest) = s.strip_prefix("```") else {
        return s;
    };
    // Sprach-Tag der ersten Zeile (```json) ueberspringen.
    let rest = rest.split_once('\n').map(|(_, tail)| tail).unwrap_or(rest);
    rest.rsplit_once("```")
        .map(|(body, _)| body)
        .unwrap_or(rest)
}

/// Validierungs-Gate vor jeder Uebernahme. `new_id` ist nur bei einer
/// Neuanlage gesetzt (Kollisions-/Traversal-Check); beim Verfeinern
/// eines geoeffneten Themes prueft der bestehende Write-Pfad die ID.
pub fn validate_draft(raw: RawDraft, new_id: Option<&str>) -> Result<ThemeDraft, String> {
    if let Some(id) = new_id {
        if !valid_theme_id(id) {
            return Err(format!("Ungueltige Theme-ID: '{id}'"));
        }
        if builtin::IDS.contains(&id) {
            return Err(format!("Theme-ID '{id}' kollidiert mit einem Built-in"));
        }
    }

    validate_css(&raw.content_css, "contentCss", true)?;
    if let Some(css) = raw.dark_css.as_deref() {
        validate_css(css, "darkCss", false)?;
    }
    if let Some(css) = raw.page_css.as_deref() {
        validate_css(css, "pageCss", false)?;
    }
    for (label, template) in [
        ("coverHtml", raw.cover_html.as_deref()),
        ("headerHtml", raw.header_html.as_deref()),
        ("footerHtml", raw.footer_html.as_deref()),
    ] {
        if let Some(template) = template {
            validate_template(template, label)?;
        }
    }

    let manifest = raw.manifest.map(|mut manifest| {
        // Feature-Flags an die tatsaechlich gelieferten Templates koppeln —
        // ein Flag ohne Datei waere im Export ohnehin wirkungslos.
        manifest.cover = manifest.cover && raw.cover_html.is_some();
        manifest.header = manifest.header && raw.header_html.is_some();
        manifest.footer = manifest.footer && raw.footer_html.is_some();
        manifest
    });
    if let Some(manifest) = manifest.as_ref() {
        validate_manifest_fonts(manifest)?;
    }

    Ok(ThemeDraft {
        manifest,
        content_css: raw.content_css,
        dark_css: raw.dark_css,
        page_css: raw.page_css,
        cover_html: raw.cover_html,
        header_html: raw.header_html,
        footer_html: raw.footer_html,
    })
}

fn validate_css(css: &str, label: &str, require_content: bool) -> Result<(), String> {
    if require_content && css.trim().is_empty() {
        return Err(format!("{label} ist leer"));
    }
    let mut depth: i64 = 0;
    for c in css.chars() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("{label}: unausgewogene geschweifte Klammern"));
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(format!("{label}: unausgewogene geschweifte Klammern"));
    }
    let lower = css.to_ascii_lowercase();
    // Das CSS wird in <style>…</style> des Export-HTML interpoliert —
    // ein '<' genuegt fuer den Ausbruch (</style><script>). KI-CSS
    // braucht kein Markup, daher pauschal ablehnen (Zweitreview-Fund).
    if lower.contains('<') {
        return Err(format!("{label}: '<' ist in KI-CSS nicht erlaubt"));
    }
    for needle in ["@import", "expression(", "javascript:"] {
        if lower.contains(needle) {
            return Err(format!("{label}: verbotenes Muster '{needle}'"));
        }
    }
    // url(...) als Whitelist statt Blacklist: url("http…), url( 'http…)
    // etc. umgehen sonst den simplen Substring-Check. Erlaubt sind nur
    // data:, asset: und Fragment-Referenzen.
    for caps in css_url_regex().captures_iter(&lower) {
        let target = caps
            .get(1)
            .unwrap()
            .as_str()
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .trim_start();
        if !(target.starts_with("data:") || target.starts_with("asset:") || target.starts_with('#'))
        {
            return Err(format!(
                "{label}: url() darf nur data:, asset: oder '#…' referenzieren"
            ));
        }
    }
    if !lower.contains(".markdown-body") {
        tracing::warn!(
            target: "folio::ai",
            part = label,
            "KI-CSS enthaelt keinen .markdown-body-Scope"
        );
    }
    Ok(())
}

const ALLOWED_TAGS: &[&str] = &[
    "div", "section", "header", "footer", "h1", "h2", "h3", "p", "span", "img", "table", "tr",
    "td", "br", "strong", "em",
];
const ALLOWED_ATTRS: &[&str] = &["class", "style", "src", "alt"];

/// Allowlist-Gate fuer KI-Templates: unbekannte Tags/Attribute,
/// on*-Handler, externe URLs und fremde Platzhalter sind Fehler.
/// Bewusst konservativ (Ablehnung im Zweifel), kein Umschreiben.
fn validate_template(template: &str, label: &str) -> Result<(), String> {
    for caps in template_placeholder_captures(template) {
        if !template::WHITELIST.contains(&caps.to_ascii_lowercase().as_str()) {
            return Err(format!("{label}: unbekannter Platzhalter '{{{{{caps}}}}}'"));
        }
    }

    let tag_re = tag_regex();
    for caps in tag_re.captures_iter(template) {
        let tag = caps.get(1).unwrap().as_str().to_ascii_lowercase();
        if !ALLOWED_TAGS.contains(&tag.as_str()) {
            return Err(format!("{label}: Tag <{tag}> ist nicht erlaubt"));
        }
        let attrs = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        validate_attrs(attrs, &tag, label)?;
    }
    Ok(())
}

fn validate_attrs(attrs: &str, tag: &str, label: &str) -> Result<(), String> {
    let attr_re = attr_regex();
    for caps in attr_re.captures_iter(attrs) {
        let name = caps.get(1).unwrap().as_str().to_ascii_lowercase();
        if name.starts_with("on") {
            return Err(format!(
                "{label}: Event-Attribut '{name}' ist nicht erlaubt"
            ));
        }
        if !ALLOWED_ATTRS.contains(&name.as_str()) {
            return Err(format!(
                "{label}: Attribut '{name}' an <{tag}> ist nicht erlaubt"
            ));
        }
        let value = caps
            .get(2)
            .or_else(|| caps.get(3))
            .or_else(|| caps.get(4))
            .map(|m| m.as_str())
            .unwrap_or("");
        let lower = value.trim().to_ascii_lowercase();
        match name.as_str() {
            "src" if !(lower.starts_with("data:image/") || lower.starts_with("asset:")) => {
                return Err(format!(
                    "{label}: src an <{tag}> muss data:image/... oder asset:... sein"
                ));
            }
            "style" => {
                for needle in ["expression(", "javascript:", "@import"] {
                    if lower.contains(needle) {
                        return Err(format!("{label}: verbotenes Muster '{needle}' in style"));
                    }
                }
                // Gleiche url()-Whitelist wie in validate_css.
                for caps in css_url_regex().captures_iter(&lower) {
                    let target = caps
                        .get(1)
                        .unwrap()
                        .as_str()
                        .trim()
                        .trim_matches(|c| c == '"' || c == '\'')
                        .trim_start();
                    if !(target.starts_with("data:")
                        || target.starts_with("asset:")
                        || target.starts_with('#'))
                    {
                        return Err(format!(
                            "{label}: url() in style darf nur data:, asset: oder '#…' referenzieren"
                        ));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn template_placeholder_captures(template: &str) -> Vec<String> {
    placeholder_regex()
        .captures_iter(template)
        .map(|caps| caps.get(1).unwrap().as_str().to_string())
        .collect()
}

fn placeholder_regex() -> &'static regex::Regex {
    static REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    REGEX.get_or_init(|| regex::Regex::new(r"\{\{\s*([a-zA-Z]+)\s*\}\}").expect("placeholder"))
}

fn css_url_regex() -> &'static regex::Regex {
    static REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    REGEX.get_or_init(|| regex::Regex::new(r"url\(([^)]*)").expect("css url"))
}

fn tag_regex() -> &'static regex::Regex {
    static REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    // Matcht oeffnende UND schliessende Tags; fuer schliessende ist die
    // Attribut-Gruppe leer. `[^>]*` haelt den Scan konservativ — auch
    // Tags in HTML-Kommentaren werden geprueft (False-Positive ist safe).
    REGEX.get_or_init(|| {
        regex::Regex::new(r"(?s)</?\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>").expect("tag")
    })
}

fn attr_regex() -> &'static regex::Regex {
    static REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    // name="wert" | name='wert' | name=wert | name (boolesch)
    REGEX.get_or_init(|| {
        regex::Regex::new(
            r#"([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?"#,
        )
        .expect("attr")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(content_css: &str) -> RawDraft {
        RawDraft {
            content_css: content_css.to_string(),
            ..RawDraft::default()
        }
    }

    #[test]
    fn parse_accepts_plain_json_and_fenced_json() {
        let json = r#"{"contentCss": ".markdown-body { color: red; }"}"#;
        assert!(parse_draft(json).is_ok());
        let fenced = format!("```json\n{json}\n```");
        assert!(parse_draft(&fenced).is_ok());
        let fenced_bare = format!("```\n{json}\n```");
        assert!(parse_draft(&fenced_bare).is_ok());
    }

    #[test]
    fn parse_rejects_non_json() {
        assert!(parse_draft("Hier ist dein Theme: bunt!").is_err());
    }

    #[test]
    fn missing_manifest_stays_absent_in_validated_draft() {
        let validated = validate_draft(raw(".markdown-body {}"), None).unwrap();
        assert_eq!(None, validated.manifest);
    }

    #[test]
    fn gate_rejects_invalid_or_builtin_id() {
        assert!(validate_draft(raw(".markdown-body{}"), Some("../x")).is_err());
        assert!(validate_draft(raw(".markdown-body{}"), Some("clean")).is_err());
        assert!(validate_draft(raw(".markdown-body{}"), Some("meins")).is_ok());
    }

    #[test]
    fn gate_rejects_empty_or_unbalanced_or_forbidden_css() {
        assert!(validate_draft(raw("  "), None).is_err());
        assert!(validate_draft(raw(".markdown-body { color: red;"), None).is_err());
        assert!(validate_draft(raw(".markdown-body } {"), None).is_err());
        for bad in [
            "@import url(x); .markdown-body {}",
            ".markdown-body { background: url(http://evil/x.png); }",
            ".markdown-body { width: expression(alert(1)); }",
            ".markdown-body { background: url(javascript:alert(1)); }",
            // Zweitreview-Funde: Style-Block-Ausbruch + Quote-/Whitespace-
            // Varianten am alten Substring-Check vorbei.
            ".markdown-body {} </style><script>alert(1)</script><style>",
            ".markdown-body { background: url(\"https://evil/x\"); }",
            ".markdown-body { background: url( 'http://evil/x' ); }",
            ".markdown-body { background: url(//evil/x); }",
        ] {
            assert!(validate_draft(raw(bad), None).is_err(), "{bad}");
        }
        // Erlaubte url()-Formen bleiben erlaubt.
        for ok in [
            ".markdown-body { background: url(data:image/png;base64,AA); }",
            ".markdown-body { background: url(\"asset:logo.png\"); }",
            ".markdown-body { clip-path: url(#clip); }",
        ] {
            assert!(validate_draft(raw(ok), None).is_ok(), "{ok}");
        }
    }

    #[test]
    fn gate_checks_optional_css_parts_too() {
        let mut draft = raw(".markdown-body {}");
        draft.dark_css = Some("@import url(x);".to_string());
        assert!(validate_draft(draft, None).is_err());
        let mut draft = raw(".markdown-body {}");
        draft.page_css = Some("body {".to_string());
        assert!(validate_draft(draft, None).is_err());
    }

    #[test]
    fn gate_rejects_invalid_manifest_font_fields() {
        for (field, value) in [
            ("fontBody", "Inter; body { color: red }"),
            ("fontMono", "url(asset:mono.woff2)"),
            ("fontSize", "calc(1rem + 1px)"),
        ] {
            let mut draft = raw(".markdown-body {}");
            let mut manifest = ThemeManifest::default();
            match field {
                "fontBody" => manifest.font_body = Some(value.to_string()),
                "fontMono" => manifest.font_mono = Some(value.to_string()),
                "fontSize" => manifest.font_size = Some(value.to_string()),
                _ => unreachable!(),
            }
            draft.manifest = Some(manifest);
            let err = validate_draft(draft, None).unwrap_err();
            assert!(err.contains(field), "{field}: {err}");
        }
    }

    #[test]
    fn gate_rejects_bad_templates() {
        for (bad, msg) in [
            ("<script>alert(1)</script>", "script"),
            ("<div onclick=\"x()\">a</div>", "onclick"),
            ("<img src=\"https://evil/x.png\">", "src"),
            ("<img src=\"data:text/html,x\">", "src"),
            ("<div>{{evil}}</div>", "Platzhalter"),
            (
                "<iframe src=\"data:image/png;base64,x\"></iframe>",
                "iframe",
            ),
            ("<div style=\"background:url(http://x)\">a</div>", "style"),
            ("<a href=\"x\">l</a>", "a"),
        ] {
            let mut draft = raw(".markdown-body {}");
            draft.cover_html = Some(bad.to_string());
            let err = validate_draft(draft, None).unwrap_err();
            assert!(!err.is_empty(), "{bad} → {msg}: {err}");
        }
    }

    #[test]
    fn gate_accepts_wellformed_template() {
        let mut draft = raw(".markdown-body { color: var(--fg); }");
        draft.cover_html = Some(
            "<section class=\"cover\"><h1>{{title}}</h1>\
             <p>{{author}} – {{company}}</p>{{logo}}\
             <img src=\"asset:logo.png\" alt=\"Logo\">\
             <img src=\"data:image/png;base64,AAAA\" alt=\"x\"><br>\
             <div style=\"color: red\">{{date}}</div></section>"
                .to_string(),
        );
        draft.manifest = Some(ThemeManifest {
            cover: true,
            ..ThemeManifest::default()
        });
        let validated = validate_draft(draft, Some("corp-neu")).unwrap();
        assert!(validated.manifest.unwrap().cover);
    }

    #[test]
    fn gate_accepts_created_by_and_prepared_by_cover_placeholders() {
        // Regression: WHITELIST must be lowercase so author validate_draft
        // (to_ascii_lowercase) accepts camelCase template syntax.
        let mut draft = raw(".markdown-body { color: var(--fg); }");
        draft.cover_html = Some(
            "<section class=\"cover\">\
             <span>{{createdBy}}</span>\
             <span>{{preparedBy}}</span>\
             <h1>{{title}}</h1></section>"
                .to_string(),
        );
        draft.manifest = Some(ThemeManifest {
            cover: true,
            ..ThemeManifest::default()
        });
        let validated = validate_draft(draft, Some("cover-labels")).unwrap();
        assert!(validated.manifest.unwrap().cover);
    }

    #[test]
    fn gate_unsets_flags_without_templates() {
        let mut draft = raw(".markdown-body {}");
        draft.manifest = Some(ThemeManifest {
            cover: true,
            header: true,
            footer: true,
            ..ThemeManifest::default()
        });
        let validated = validate_draft(draft, None).unwrap();
        let manifest = validated.manifest.unwrap();
        assert!(!manifest.cover);
        assert!(!manifest.header);
        assert!(!manifest.footer);
    }

    #[test]
    fn system_prompt_includes_base_files_in_refine_mode() {
        let base = BaseContext {
            id: "corp".to_string(),
            content_css: ".markdown-body { --accent: #123; }".to_string(),
            dark_css: None,
            page_css: Some("html { background: #fff; }".to_string()),
            cover_html: None,
            header_html: None,
            footer_html: None,
        };
        let prompt = system_prompt(Some(&base), None);
        assert!(prompt.contains("Verfeinerungs-Modus"));
        assert!(prompt.contains("--accent: #123"));
        assert!(prompt.contains("=== page.css ==="));
        assert!(!prompt.contains("=== cover.html ==="));
    }

    #[test]
    fn document_excerpt_keeps_frontmatter_and_adds_heading_skeleton_when_truncated() {
        let markdown = format!(
            "---\ntitle: Export Pitch\nauthor: Ada\n---\n\n# Start\n{}\n## Details\n{}",
            "a".repeat(12_050),
            "b".repeat(100)
        );

        let excerpt = document_excerpt(&markdown);

        assert!(excerpt.starts_with("---\ntitle: Export Pitch\nauthor: Ada\n---"));
        assert!(excerpt.contains("[Dokument gekuerzt]"));
        assert!(excerpt.contains("Heading-Skelett:\n# Start\n## Details"));
        assert!(excerpt.len() < markdown.len());
    }

    #[test]
    fn system_prompt_includes_document_context_instruction() {
        let prompt = system_prompt(None, Some("# Bericht\n\nInhalt"));

        assert!(prompt.contains("Dokument-Kontext"));
        assert!(prompt.contains("kopiere den Dokumentinhalt NICHT"));
        assert!(prompt.contains("hideInlineFrontmatter: true"));
        assert!(prompt.contains("# Bericht"));
    }
}
