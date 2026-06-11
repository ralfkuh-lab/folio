use crate::{frontmatter, heading_anchor};
use comrak::{
    adapters::{HeadingAdapter, HeadingMeta},
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

pub fn render_body(markdown: &str) -> String {
    let frontmatter = frontmatter::extract(markdown);
    let preprocessed = heading_anchor::convert_inline_anchors_in_headings(&frontmatter.body);

    let arena = Arena::new();
    let options = markdown_options();
    let root = parse_document(&arena, &preprocessed, &options);
    let heading_ids = collect_and_apply_explicit_heading_ids(root);

    let heading_adapter = FolioHeadingAdapter::new(heading_ids);
    let mut plugins = Plugins::default();
    plugins.render.heading_adapter = Some(&heading_adapter);

    let mut body_html = Vec::new();
    format_html_with_plugins(root, &options, &mut body_html, &plugins)
        .expect("rendering markdown to HTML should not fail");

    let body_html =
        normalize_tasklist_html(&String::from_utf8(body_html).expect("comrak emits UTF-8 HTML"));
    let body_html = add_data_line_attributes(&body_html, frontmatter.body_start_line);

    let mut html = frontmatter::render_html(&frontmatter.entries);
    html.push_str(&body_html);
    if !body_html.is_empty() {
        html.push('\n');
    }
    html
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
}
