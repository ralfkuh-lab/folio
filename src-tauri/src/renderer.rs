use crate::{frontmatter, heading_anchor};
use comrak::{
    adapters::{HeadingAdapter, HeadingMeta, SyntaxHighlighterAdapter},
    format_html_with_plugins,
    nodes::{AstNode, NodeValue, Sourcepos},
    parse_document, Arena, Options, Plugins,
};
use regex::Regex;
use std::{
    collections::{HashMap, VecDeque},
    io::{self, Write},
    sync::{Mutex, OnceLock},
};
use syntect::{
    easy::HighlightLines,
    highlighting::{Color, ThemeSet},
    html::{append_highlighted_html_for_styled_line, IncludeBackground},
    parsing::SyntaxSet,
    util::LinesWithEndings,
};

/// Entry fuer mermaid Export: paart die exakte Source (zum Index-Match via Literal)
/// mit dem (optionalen, vorgerenderten) SVG. Wird vom Frontend via
/// renderMermaidForExport erzeugt und als mermaidSvgs an die Export-Commands
/// uebergeben. Source-Identitaet verhindert falsche Zuordnung bei Dokument-Aenderungen.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MermaidSvgEntry {
    pub source: String,
    pub svg: Option<String>,
}

pub fn render_body(markdown: &str) -> String {
    render_body_with_highlighter(markdown, None, false, None)
}

pub fn render_body_highlighted(markdown: &str, dark: bool) -> String {
    render_body_with_highlighter(markdown, Some(syntect_adapter(dark)), false, None)
}

/// Wie [`render_body_highlighted`], unterstuetzt zusaetzlich das
/// Unterdruecken des inline Frontmatter-`<aside>` (Corporate-Design:
/// Metadaten erscheinen auf dem Deckblatt, nicht im Body).
pub fn render_body_highlighted_in(
    markdown: &str,
    dark: bool,
    hide_inline_frontmatter: bool,
    mermaid_svgs: Option<Vec<MermaidSvgEntry>>,
) -> String {
    render_body_with_highlighter(
        markdown,
        Some(syntect_adapter(dark)),
        hide_inline_frontmatter,
        mermaid_svgs,
    )
}

fn render_body_with_highlighter(
    markdown: &str,
    syntax_highlighter: Option<&dyn SyntaxHighlighterAdapter>,
    hide_inline_frontmatter: bool,
    mermaid_svgs: Option<Vec<MermaidSvgEntry>>,
) -> String {
    let frontmatter = frontmatter::extract(markdown);
    let preprocessed = heading_anchor::convert_inline_anchors_in_headings(&frontmatter.body);

    let arena = Arena::new();
    let options = markdown_options();
    let root = parse_document(&arena, &preprocessed, &options);
    let heading_ids = collect_and_apply_explicit_heading_ids(root);

    // Beim eigenen Parse die Mermaid-Literale sammeln (gemeinsam mit
    // collect_mermaid_sources / find_mermaid_blocks). Wird fuer
    // source-basierte Identitaet im Ersetzungsschritt benoetigt.
    let mermaid_literals: Vec<String> = if mermaid_svgs.is_some() {
        find_mermaid_blocks(root)
            .into_iter()
            .map(|node| {
                if let NodeValue::CodeBlock(ref cb) = node.data.borrow().value {
                    cb.literal.clone()
                } else {
                    String::new()
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    let heading_adapter = FolioHeadingAdapter::new(heading_ids);
    let mut plugins = Plugins::default();
    plugins.render.heading_adapter = Some(&heading_adapter);
    plugins.render.codefence_syntax_highlighter = syntax_highlighter;

    let mut body_html = Vec::new();
    format_html_with_plugins(root, &options, &mut body_html, &plugins)
        .expect("rendering markdown to HTML should not fail");

    let body_html =
        normalize_tasklist_html(&String::from_utf8(body_html).expect("comrak emits UTF-8 HTML"));
    let body_html = add_data_line_attributes(&body_html, frontmatter.body_start_line);

    let body_html = if let Some(ref entries) = mermaid_svgs {
        replace_mermaid_blocks_in_html(&body_html, entries, &mermaid_literals)
    } else {
        body_html
    };

    let mut html = String::new();
    if !hide_inline_frontmatter {
        html.push_str(&frontmatter::render_html(&frontmatter.entries));
    }
    html.push_str(&body_html);
    if !body_html.is_empty() {
        html.push('\n');
    }
    html
}

fn syntect_adapter(dark: bool) -> &'static FolioSyntectAdapter {
    static LIGHT: OnceLock<FolioSyntectAdapter> = OnceLock::new();
    static DARK: OnceLock<FolioSyntectAdapter> = OnceLock::new();

    if dark {
        DARK.get_or_init(|| FolioSyntectAdapter::new("base16-ocean.dark"))
    } else {
        LIGHT.get_or_init(|| FolioSyntectAdapter::new("InspiredGitHub"))
    }
}

/// Entspricht comraks `SyntectAdapter` fuer Inline-Styles, verwendet aber
/// syntects pure-Rust-Regex-Backend. comrak 0.35 aktiviert fuer seinen
/// eingebauten Adapter auf nativen Targets sonst zwingend `regex-onig`.
#[derive(Debug)]
struct FolioSyntectAdapter {
    theme: &'static str,
    syntax_set: SyntaxSet,
    theme_set: ThemeSet,
}

impl FolioSyntectAdapter {
    fn new(theme: &'static str) -> Self {
        Self {
            theme,
            syntax_set: SyntaxSet::load_defaults_newlines(),
            theme_set: ThemeSet::load_defaults(),
        }
    }

    fn theme(&self) -> &syntect::highlighting::Theme {
        &self.theme_set.themes[self.theme]
    }
}

impl SyntaxHighlighterAdapter for FolioSyntectAdapter {
    fn write_highlighted(
        &self,
        output: &mut dyn Write,
        lang: Option<&str>,
        code: &str,
    ) -> io::Result<()> {
        let lang = lang.filter(|lang| !lang.is_empty()).unwrap_or("Plain Text");
        let syntax = self
            .syntax_set
            .find_syntax_by_token(lang)
            .unwrap_or_else(|| self.syntax_set.find_syntax_plain_text());
        if syntax.name == "Plain Text" {
            return write_html_escaped(output, code);
        }

        let mut highlighter = HighlightLines::new(syntax, self.theme());
        let background = self.theme().settings.background.unwrap_or(Color::WHITE);
        let mut highlighted = String::new();
        for line in LinesWithEndings::from(code) {
            let regions = match highlighter.highlight_line(line, &self.syntax_set) {
                Ok(regions) => regions,
                Err(_) => return write_html_escaped(output, code),
            };
            if append_highlighted_html_for_styled_line(
                &regions,
                IncludeBackground::IfDifferent(background),
                &mut highlighted,
            )
            .is_err()
            {
                return write_html_escaped(output, code);
            }
        }
        output.write_all(highlighted.as_bytes())
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn Write,
        mut attributes: HashMap<String, String>,
    ) -> io::Result<()> {
        let background = self.theme().settings.background.unwrap_or(Color::WHITE);
        let style = format!(
            "background-color:#{:02x}{:02x}{:02x};",
            background.r, background.g, background.b
        );
        attributes
            .entry("style".to_string())
            .and_modify(|existing| existing.insert_str(0, &style))
            .or_insert(style);
        write_opening_tag(output, "pre", &attributes)
    }

    fn write_code_tag(
        &self,
        output: &mut dyn Write,
        attributes: HashMap<String, String>,
    ) -> io::Result<()> {
        write_opening_tag(output, "code", &attributes)
    }
}

fn write_opening_tag(
    output: &mut dyn Write,
    name: &str,
    attributes: &HashMap<String, String>,
) -> io::Result<()> {
    write!(output, "<{name}")?;
    for (key, value) in attributes {
        write!(output, " {key}=\"")?;
        escape_html_attribute(output, value)?;
        write!(output, "\"")?;
    }
    write!(output, ">")
}

fn write_html_escaped(output: &mut dyn Write, value: &str) -> io::Result<()> {
    for ch in value.chars() {
        match ch {
            '&' => output.write_all(b"&amp;")?,
            '<' => output.write_all(b"&lt;")?,
            '>' => output.write_all(b"&gt;")?,
            '"' => output.write_all(b"&quot;")?,
            '\'' => output.write_all(b"&#39;")?,
            _ => write!(output, "{ch}")?,
        }
    }
    Ok(())
}

pub(crate) fn markdown_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.render.sourcepos = true;
    options.render.unsafe_ = false;
    options.render.escape = true;
    options
}

fn collect_and_apply_explicit_heading_ids<'a>(root: &'a AstNode<'a>) -> VecDeque<Option<String>> {
    let mut ids = VecDeque::new();

    for node in root.descendants().skip(1) {
        if matches!(node.data.borrow().value, NodeValue::Heading(_)) {
            ids.push_back(strip_explicit_heading_id(node));
        }
    }

    ids
}

fn strip_explicit_heading_id<'a>(heading: &'a AstNode<'a>) -> Option<String> {
    for child in heading.reverse_children() {
        let mut child_data = child.data.borrow_mut();
        let NodeValue::Text(text) = &mut child_data.value else {
            continue;
        };

        let Some((new_text, id)) = split_explicit_id(text) else {
            if text.trim().is_empty() {
                continue;
            }
            return None;
        };

        *text = new_text;
        if text.is_empty() {
            drop(child_data);
            child.detach();
        }
        return Some(id);
    }

    None
}

pub(crate) fn split_explicit_id(text: &str) -> Option<(String, String)> {
    let captures = explicit_id_regex().captures(text)?;
    let stripped = captures
        .name("text")
        .expect("text capture")
        .as_str()
        .trim_end()
        .to_string();
    let id = captures
        .name("id")
        .expect("id capture")
        .as_str()
        .to_string();

    Some((stripped, id))
}

fn explicit_id_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?s)^(?P<text>.*?)[ \t]*\{#(?P<id>[^}\s]+)\}[ \t]*$")
            .expect("explicit heading ID regex must compile")
    })
}

fn is_mermaid_info(info: &str) -> bool {
    // Exakt CASE-SENSITIVER First-Token-Vergleich (konsistent zu
    // Frontend classList.contains('language-mermaid') und comrak's
    // language- Klassenbildung). "Mermaid" oder "mermaid\tmeta" werden
    // korrekt behandelt; Tabs/Space als Separator via split_whitespace.
    info.split_whitespace().next() == Some("mermaid")
}

fn find_mermaid_blocks<'a>(root: &'a AstNode<'a>) -> Vec<&'a AstNode<'a>> {
    let mut blocks = Vec::new();
    for node in root.descendants() {
        if let NodeValue::CodeBlock(ref cb) = node.data.borrow().value {
            if cb.fenced && is_mermaid_info(&cb.info) {
                blocks.push(node);
            }
        }
    }
    blocks
}

/// Sammelt die Quelltexte aller ```mermaid / ~~~mermaid -Fences (Dokument-Reihenfolge).
/// Nutzt exakt dieselbe comrak-Parse-Logik + Erkennung wie der Ersetzungsschritt
/// im Export. Frontmatter wird abgeschnitten,
/// indented Code und Inline-Code ignoriert, ~~~-Varianten eingeschlossen.
pub fn collect_mermaid_sources(markdown: &str) -> Vec<String> {
    let frontmatter = frontmatter::extract(markdown);
    let preprocessed = heading_anchor::convert_inline_anchors_in_headings(&frontmatter.body);

    let arena = Arena::new();
    let options = markdown_options();
    let root = parse_document(&arena, &preprocessed, &options);

    find_mermaid_blocks(root)
        .into_iter()
        .map(|node| {
            if let NodeValue::CodeBlock(ref cb) = node.data.borrow().value {
                cb.literal.clone()
            } else {
                String::new()
            }
        })
        .collect()
}

/// Prueft ob ein SVG fuer den Mermaid-Export akzeptiert wird (Security-Gate).
/// Muss mit "<svg" (trimmed) beginnen und darf kein "<script" (ci) enthalten.
/// Defense-in-Depth: Automation-Caller sind auf demselben Trust-Level wie
/// /eval (koennen beliebiges JS ausfuehren); das Gate schuetzt das
/// exportierte Artefakt (kein vollstaendiger Sanitizer, XML-Parse waere Overkill).
fn is_valid_mermaid_svg(svg: &str) -> bool {
    let t = svg.trim_start();
    t.starts_with("<svg") && !t.to_ascii_lowercase().contains("<script")
}

fn mermaid_code_open_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Anker auf Tag-Sequenz <pre...><code...class="language-mermaid"...>
        // statt nacktem class-String + rfind. Robust gegen Attrs/Quotes.
        Regex::new(r#"<pre[^>]*>\s*<code[^>]*class="language-mermaid"[^>]*>"#)
            .expect("mermaid code open regex must compile")
    })
}

/// Ersetzt Mermaid-Bloecke im Export-HTML. Nutzt source-Identitaet (nicht
/// blinden Index): ersetzt nur wenn literals[i] == entry.source UND svg
/// vorhanden UND valid (security gate). Sonst Fallback auf Code-Block.
/// Verwendet Regex fuer robustes Ankern der <pre><code class=...> Sequenz.
fn replace_mermaid_blocks_in_html(
    html: &str,
    entries: &[MermaidSvgEntry],
    literals: &[String],
) -> String {
    let mut result = String::with_capacity(html.len());
    let mut pos = 0usize;
    let mut i = 0usize;

    let re = mermaid_code_open_regex();

    while let Some(mat) = re.find(&html[pos..]) {
        let match_start = pos + mat.start();
        let after_open = pos + mat.end();

        // Schliesse bis </code></pre> (robust, auch bei Whitespace/Attrs)
        let code_end = match html[after_open..].find("</code>") {
            Some(c) => after_open + c + 7,
            None => {
                pos = after_open;
                continue;
            }
        };
        let pre_close = match html[code_end..].find("</pre>") {
            Some(e) => code_end + e + 6,
            None => {
                pos = code_end;
                continue;
            }
        };

        result.push_str(&html[pos..match_start]);

        let lit = literals.get(i).map(|s| s.as_str()).unwrap_or("");
        let entry = entries.get(i);

        let do_replace = if let Some(e) = entry {
            e.source == lit && e.svg.as_ref().is_some_and(|s| is_valid_mermaid_svg(s))
        } else {
            false
        };

        if do_replace {
            if let Some(svg) = entry.and_then(|e| e.svg.as_ref()) {
                result.push_str(r#"<div class="mermaid-diagram">"#);
                result.push_str(svg);
                result.push_str("</div>");
            } else {
                result.push_str(&html[match_start..pre_close]);
            }
        } else {
            if let Some(e) = entry {
                if e.source != lit {
                    // Source-Identitaet mismatch (Stale/Shift) -> bewusst Fallback, nie falsches SVG
                    tracing::warn!(
                        target: "folio::ipc",
                        index = i,
                        "mermaid svg source mismatch; falling back to code block"
                    );
                } else if let Some(s) = &e.svg {
                    if !is_valid_mermaid_svg(s) {
                        tracing::warn!(
                            target: "folio::ipc",
                            index = i,
                            "invalid mermaid svg rejected (missing <svg or contains <script); falling back"
                        );
                    }
                }
            }
            result.push_str(&html[match_start..pre_close]);
        }

        pos = pre_close;
        i += 1;
    }

    result.push_str(&html[pos..]);
    result
}

/// Markdig-compatible tasklist HTML normalisation.
///
/// comrak emits bare `<ul><li><input type="checkbox" …>` for tasklists;
/// Markdig wraps them in `<ul class="contains-task-list">` with
/// `<li class="task-list-item">` and reorders attributes.
/// This post-process string-rewrites the HTML to match the reference output.
fn normalize_tasklist_html(html: &str) -> String {
    // Nesting-aware statt Lazy-Regex: das fruehere
    // `<ul[^>]*>(?s:.*?)</ul>`-Matching endete am ERSTEN inneren
    // `</ul>` — eine normale aeussere Liste mit Task-Subliste bekam
    // dadurch faelschlich `contains-task-list` (Bullet-Unterdrueckung
    // auf der aeusseren Liste). Der Scanner markiert nur `<ul>`-Tags,
    // die DIREKT (nicht ueber eine verschachtelte Liste) ein Task-Item
    // enthalten.
    let task_uls = find_direct_task_uls(html);
    let html = if task_uls.is_empty() {
        html.to_string()
    } else {
        let mut out = String::with_capacity(html.len() + task_uls.len() * 32);
        let mut last = 0;
        for &(start, gt) in &task_uls {
            out.push_str(&html[last..start]);
            let attrs = &html[start + 3..gt];
            out.push_str("<ul");
            out.push_str(&add_class_to_attrs(attrs, "contains-task-list"));
            out.push('>');
            last = gt + 1;
        }
        out.push_str(&html[last..]);
        out
    };

    tasklist_item_regex()
        .replace_all(&html, |captures: &regex::Captures<'_>| {
            let li_attrs = captures
                .name("li_attrs")
                .expect("li attrs capture")
                .as_str();
            let input_attrs = captures
                .name("input_attrs")
                .expect("input attrs capture")
                .as_str();
            let checked = if input_attrs.contains(r#"checked="""#)
                || input_attrs.contains(r#"checked="checked""#)
                || input_attrs.contains(" checked")
            {
                r#" checked="checked""#
            } else {
                ""
            };

            format!(
                r#"<li{}><input disabled="disabled" type="checkbox"{checked} />"#,
                add_class_to_attrs(li_attrs, "task-list-item")
            )
        })
        .into_owned()
}

/// Liefert `(tag_start, '>'-Offset)` aller `<ul`-Tags, die direkt —
/// also nicht erst in einer verschachtelten `<ul>`/`<ol>` — ein
/// Task-Item (`<li…><input type="checkbox"`) enthalten. comrak emittiert
/// lowercase-Tags, daher reicht der case-sensitive Vergleich.
fn find_direct_task_uls(html: &str) -> Vec<(usize, usize)> {
    // Stack-Eintrag: (is_ul, tag_start, '>'-Offset, has_direct_task)
    let mut stack: Vec<(bool, usize, usize, bool)> = Vec::new();
    let mut found = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let rest = &html[i..];
        let is_list_open = (rest.starts_with("<ul") || rest.starts_with("<ol"))
            && matches!(
                bytes.get(i + 3),
                Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n')
            );
        if is_list_open {
            if let Some(gt) = rest.find('>') {
                stack.push((rest.starts_with("<ul"), i, i + gt, false));
                i += gt + 1;
                continue;
            }
        } else if rest.starts_with("</ul>") || rest.starts_with("</ol>") {
            if let Some((is_ul, tag_start, gt, has_task)) = stack.pop() {
                if is_ul && has_task {
                    found.push((tag_start, gt));
                }
            }
            i += 5;
            continue;
        } else if rest.starts_with("<li")
            && matches!(bytes.get(i + 3), Some(b'>') | Some(b' ') | Some(b'\t'))
        {
            if let Some(gt) = rest.find('>') {
                if rest[gt + 1..].starts_with(r#"<input type="checkbox""#) {
                    if let Some(top) = stack.last_mut() {
                        if top.0 {
                            top.3 = true;
                        }
                    }
                }
                i += gt + 1;
                continue;
            }
        }
        i += 1;
    }
    found.sort_unstable();
    found
}

fn tasklist_item_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"<li(?P<li_attrs>[^>]*)><input type="checkbox"(?P<input_attrs>[^>]*) />"#)
            .expect("tasklist item regex")
    })
}

fn add_class_to_attrs(attrs: &str, class_name: &str) -> String {
    if attrs.contains(&format!(r#"class="{class_name}""#))
        || attrs.contains(&format!(r#" {class_name} "#))
        || attrs.contains(&format!(r#" {class_name}""#))
        || attrs.contains(&format!(r#""{class_name} "#))
    {
        return attrs.to_string();
    }

    if let Some(start) = attrs.find(r#"class=""#) {
        let value_start = start + r#"class=""#.len();
        let mut updated = attrs.to_string();
        updated.insert_str(value_start, &format!("{class_name} "));
        updated
    } else {
        format!(r#" class="{class_name}"{attrs}"#)
    }
}

fn add_data_line_attributes(html: &str, body_start_line: usize) -> String {
    sourcepos_attr_regex()
        .replace_all(html, |captures: &regex::Captures<'_>| {
            let tag = captures.get(0).expect("sourcepos tag match").as_str();
            if tag.contains(" data-line=") {
                return tag.to_string();
            }

            let source_line = captures
                .name("line")
                .and_then(|line| line.as_str().parse::<usize>().ok())
                .unwrap_or(0);
            if source_line == 0 {
                return tag.to_string();
            }

            let line = body_start_line + source_line.saturating_sub(1);
            if tag.ends_with("/>") {
                format!(
                    "{} data-line=\"{}\" />",
                    tag.trim_end_matches("/>").trim_end(),
                    line
                )
            } else {
                format!("{} data-line=\"{}\">", tag.trim_end_matches('>'), line)
            }
        })
        .into_owned()
}

fn sourcepos_attr_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"<[A-Za-z][^>]*\sdata-sourcepos="(?P<line>\d+):[^"]*"[^>]*>"#)
            .expect("sourcepos attr regex")
    })
}

pub fn slugify_heading(text: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in text.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if !slug.is_empty() && !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    if last_was_dash {
        slug.pop();
    }

    slug
}

/// comrak's `HeadingAdapter` trait requires `&self` on both `enter` and `exit`.
/// Because the adapter must mutate state (consuming explicit IDs and tracking
/// used slugs) we wrap both fields in `Mutex`. This is safe because comrak
/// calls the adapter sequentially during single-threaded HTML formatting.
struct FolioHeadingAdapter {
    explicit_ids: Mutex<VecDeque<Option<String>>>,
    used_slugs: Mutex<HashMap<String, usize>>,
}

impl FolioHeadingAdapter {
    fn new(explicit_ids: VecDeque<Option<String>>) -> Self {
        Self {
            explicit_ids: Mutex::new(explicit_ids),
            used_slugs: Mutex::new(HashMap::new()),
        }
    }

    fn unique_slug(&self, slug: String) -> String {
        let mut used_slugs = self
            .used_slugs
            .lock()
            .expect("heading slug map must not be poisoned");
        let count = used_slugs.entry(slug.clone()).or_default();
        let unique = if *count == 0 {
            slug
        } else {
            format!("{slug}-{count}")
        };
        *count += 1;
        unique
    }
}

impl HeadingAdapter for FolioHeadingAdapter {
    fn enter(
        &self,
        output: &mut dyn Write,
        heading: &HeadingMeta,
        sourcepos: Option<Sourcepos>,
    ) -> io::Result<()> {
        let id = self.unique_slug(
            self.explicit_ids
                .lock()
                .expect("heading ID queue must not be poisoned")
                .pop_front()
                .flatten()
                .unwrap_or_else(|| slugify_heading(&heading.content)),
        );

        write!(output, "<h{}", heading.level)?;
        write!(output, " id=\"")?;
        escape_html_attribute(output, &id)?;
        write!(output, "\"")?;
        if let Some(sourcepos) = sourcepos {
            write!(output, " data-sourcepos=\"{}\"", sourcepos)?;
        }
        write!(output, ">")
    }

    fn exit(&self, output: &mut dyn Write, heading: &HeadingMeta) -> io::Result<()> {
        writeln!(output, "</h{}>", heading.level)
    }
}

fn escape_html_attribute(output: &mut dyn Write, value: &str) -> io::Result<()> {
    for ch in value.chars() {
        match ch {
            '&' => output.write_all(b"&amp;")?,
            '"' => output.write_all(b"&quot;")?,
            '<' => output.write_all(b"&lt;")?,
            '>' => output.write_all(b"&gt;")?,
            _ => write!(output, "{ch}")?,
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUST_FENCE: &str = "```rust\nfn main() {}\n```";

    #[test]
    fn highlighted_body_colours_rust_but_view_body_does_not() {
        let export = render_body_highlighted(RUST_FENCE, false);
        assert!(export.contains(r#"<span style="#), "{export}");
        assert!(export.contains(r#"class="language-rust""#), "{export}");

        let view = render_body(RUST_FENCE);
        assert!(!view.contains(r#"<span style="#), "{view}");
        assert!(view.contains(r#"class="language-rust""#), "{view}");
    }

    #[test]
    fn highlighted_body_handles_plain_and_unknown_fences_without_colour() {
        for markdown in [
            "```\neinfacher Text\n```",
            "```text\neinfacher Text\n```",
            "```definitely-unknown\neinfacher Text\n```",
        ] {
            let html = render_body_highlighted(markdown, false);
            assert!(!html.contains(r#"<span style="#), "{html}");
        }
    }

    #[test]
    fn test_simple_heading() {
        let html = render_body("# Hello World");
        assert!(
            html.contains(
                r#"<h1 id="hello-world" data-sourcepos="1:1-1:13" data-line="1">Hello World</h1>"#
            ),
            "{html}"
        );
    }

    #[test]
    fn test_gfm_table() {
        let html = render_body("| A | B |\n|---|---|\n| 1 | 2 |");
        assert!(html.contains(r#"<table data-sourcepos=""#));
        assert!(html.contains(r#"data-line="1">"#));
    }

    #[test]
    fn test_no_html_passthrough() {
        let html = render_body("<script>alert(1)</script>");
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(!html.contains("<script>alert(1)</script>"));
    }

    #[test]
    fn test_explicit_id() {
        let html = render_body("## Title {#custom-id}");
        assert!(html
            .contains(r#"<h2 id="custom-id" data-sourcepos="1:1-1:21" data-line="1">Title</h2>"#));
    }

    #[test]
    fn test_umlaut_slug() {
        let html = render_body("## Hällo Wörld");
        assert!(html.contains(r#"<h2 id="hällo-wörld" data-sourcepos=""#));
        assert!(html.contains(r#"data-line="1">Hällo Wörld</h2>"#));
    }

    #[test]
    fn test_inline_anchor() {
        let html = render_body(r#"## Title <a id="my-id"></a>"#);
        assert!(html.contains(r#"<h2 id="my-id" data-sourcepos=""#));
        assert!(html.contains(r#"data-line="1">Title</h2>"#));
    }

    #[test]
    fn test_data_line_uses_original_line_after_frontmatter() {
        let html = render_body("---\ntitle: Note\n---\n# Title\n\nBody");
        assert!(
            html.contains(r#"<h1 id="title" data-sourcepos="1:1-1:7" data-line="4">Title</h1>"#)
        );
        assert!(html.contains(r#"<p data-sourcepos="3:1-3:4" data-line="6">Body</p>"#));
    }

    #[test]
    fn test_tasklist_normalization_checked() {
        let html = normalize_tasklist_html(
            "<ul><li><input type=\"checkbox\" checked=\"\" disabled=\"\" /> Done</li></ul>",
        );
        assert!(html.contains(r#"<ul class="contains-task-list">"#));
        assert!(html.contains(r#"<li class="task-list-item">"#));
        assert!(html.contains(r#"<input disabled="disabled" type="checkbox" checked="checked" />"#));
    }

    #[test]
    fn test_tasklist_normalization_unchecked() {
        let html = normalize_tasklist_html(
            "<ul><li><input type=\"checkbox\" disabled=\"\" /> Todo</li></ul>",
        );
        assert!(html.contains(r#"<ul class="contains-task-list">"#));
        assert!(html.contains(r#"<li class="task-list-item">"#));
        assert!(html.contains(r#"<input disabled="disabled" type="checkbox" />"#));
        assert!(!html.contains(r#"checked="checked""#));
    }

    #[test]
    fn test_tasklist_normalization_preserves_regular_ul() {
        let html = normalize_tasklist_html("<ul><li>Plain item</li></ul>");
        assert!(!html.contains("contains-task-list"));
        assert_eq!("<ul><li>Plain item</li></ul>", html);
    }

    #[test]
    fn test_nested_tasklist_marks_only_inner_ul() {
        // Aeussere normale Liste mit Task-SUBliste: nur die innere <ul>
        // bekommt contains-task-list (das fruehere Lazy-Regex-Matching
        // markierte die aeussere, weil ihr Body bis zum ersten inneren
        // </ul> die Checkbox enthielt).
        let html = normalize_tasklist_html(
            "<ul><li>Outer<ul><li><input type=\"checkbox\" disabled=\"\" /> Task</li></ul></li><li>Second</li></ul>",
        );
        assert!(html.starts_with("<ul><li>Outer<ul class=\"contains-task-list\">"));
        assert_eq!(1, html.matches("contains-task-list").count());
    }

    #[test]
    fn test_task_in_nested_ol_does_not_mark_outer_ul() {
        let html = normalize_tasklist_html(
            "<ul><li>Outer<ol><li><input type=\"checkbox\" disabled=\"\" /> Task</li></ol></li></ul>",
        );
        assert!(!html.contains("contains-task-list"));
    }

    #[test]
    fn collect_mermaid_sources_finds_fences_and_ignores_indented_and_non_mermaid() {
        let md = "# Doc\n\n```mermaid\nflow A-->B\n```\n\n~~~mermaid\nC-->D\n~~~\n\n    indented\n\n```rust\nfn x(){}\n```\n\nText `inline mermaid` here.";
        let srcs = collect_mermaid_sources(md);
        assert_eq!(srcs.len(), 2);
        assert!(srcs[0].contains("flow A-->B"));
        assert!(srcs[1].contains("C-->D"));
    }

    #[test]
    fn collect_and_replace_is_case_sensitive_and_first_token_only() {
        // Divergenz-Fix: nur exakt "mermaid" als first token (case sens)
        let md = "```Mermaid\nbad\n```\n\n```mermaid\nok\n```\n\n```mermaid\tmeta\nwithmeta\n```";
        let srcs = collect_mermaid_sources(md);
        assert_eq!(
            srcs.len(),
            2,
            "only lowercase mermaid and mermaid+meta count"
        );
        assert!(srcs[0].contains("ok"));
        assert!(srcs[1].contains("withmeta"));

        // Render mit passendem Entry fuer zweiten (case mismatch erster bleibt code)
        let entry_ok = MermaidSvgEntry {
            source: srcs[0].clone(),
            svg: Some("<svg id=\"ok\"/>".to_string()),
        };
        let entry_meta = MermaidSvgEntry {
            source: srcs[1].clone(),
            svg: Some("<svg id=\"meta\"/>".to_string()),
        };
        let html = crate::export::render_document(
            "clean",
            "T",
            None,
            md,
            Some(vec![entry_ok, entry_meta]),
        )
        .unwrap();
        // korrekte (lowercase + meta) erhalten svg; wrong-case "Mermaid" blieb Code (nicht in entries)
        assert!(html.contains(r#"<div class="mermaid-diagram"><svg id="ok"/></div>"#));
        assert!(html.contains(r#"<div class="mermaid-diagram"><svg id="meta"/></div>"#));
        // wrong-case block source appears (as code fallback), not replaced
        assert!(html.contains("bad"));
    }

    #[test]
    fn collect_mermaid_sources_strips_frontmatter() {
        let md = "---\ntitle: X\n---\n\n```mermaid\ngraph\n```\n";
        let srcs = collect_mermaid_sources(md);
        assert_eq!(srcs.len(), 1);
    }
}
