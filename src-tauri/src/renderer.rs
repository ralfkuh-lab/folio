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

fn normalize_tasklist_html(html: &str) -> String {
    let html = tasklist_ul_regex()
        .replace_all(html, |captures: &regex::Captures<'_>| {
            let body = captures.name("body").expect("body capture").as_str();
            if body.contains(r#"<li><input type="checkbox""#) {
                format!(r#"<ul class="contains-task-list">{body}</ul>"#)
            } else {
                captures
                    .get(0)
                    .expect("full tasklist ul match")
                    .as_str()
                    .to_string()
            }
        })
        .into_owned();

    tasklist_item_regex()
        .replace_all(&html, |captures: &regex::Captures<'_>| {
            let attrs = captures.name("attrs").expect("attrs capture").as_str();
            let checked = if attrs.contains(r#"checked="""#)
                || attrs.contains(r#"checked="checked""#)
                || attrs.contains(" checked")
            {
                r#" checked="checked""#
            } else {
                ""
            };

            format!(
                r#"<li class="task-list-item"><input disabled="disabled" type="checkbox"{checked} />"#
            )
        })
        .into_owned()
}

fn tasklist_ul_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?s)<ul>(?P<body>.*?)</ul>").expect("tasklist ul regex"))
}

fn tasklist_item_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"<li><input type="checkbox"(?P<attrs>[^>]*) />"#).expect("tasklist item regex")
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
        if let Some(sourcepos) = sourcepos {
            write!(output, " data-sourcepos=\"{}\"", sourcepos)?;
        }
        write!(output, " id=\"")?;
        escape_html_attribute(output, &id)?;
        write!(output, "\">")
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
        assert!(render_body("# Hello World").contains(r#"<h1 id="hello-world">Hello World</h1>"#));
    }

    #[test]
    fn test_gfm_table() {
        let html = render_body("| A | B |\n|---|---|\n| 1 | 2 |");
        assert!(html.contains("<table>"));
    }

    #[test]
    fn test_no_html_passthrough() {
        let html = render_body("<script>alert(1)</script>");
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(!html.contains("<script>alert(1)</script>"));
    }

    #[test]
    fn test_explicit_id() {
        assert!(render_body("## Title {#custom-id}").contains(r#"<h2 id="custom-id">Title</h2>"#));
    }

    #[test]
    fn test_umlaut_slug() {
        assert!(render_body("## Hällo Wörld").contains(r#"<h2 id="hällo-wörld">Hällo Wörld</h2>"#));
    }

    #[test]
    fn test_inline_anchor() {
        let html = render_body(r#"## Title <a id="my-id"></a>"#);
        assert!(html.contains(r#"<h2 id="my-id">Title</h2>"#));
    }
}
