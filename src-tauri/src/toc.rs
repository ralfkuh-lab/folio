use crate::{frontmatter, heading_anchor, renderer};
use comrak::{
    nodes::{AstNode, NodeValue},
    parse_document, Arena,
};
use regex::Regex;
use std::{collections::HashMap, sync::OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TocEntry {
    pub text: String,
    pub level: u8,
    pub slug: String,
    pub number: Option<String>,
    pub line: usize,
}

pub fn extract(markdown: &str) -> Vec<TocEntry> {
    if markdown.is_empty() {
        return Vec::new();
    }

    let frontmatter = frontmatter::extract(markdown);
    let preprocessed = heading_anchor::convert_inline_anchors_in_headings(&frontmatter.body);

    let arena = Arena::new();
    let options = renderer::markdown_options();
    let root = parse_document(&arena, &preprocessed, &options);

    let mut raw = Vec::new();
    let mut used_slugs = HashMap::new();

    for node in root.descendants().skip(1) {
        let NodeValue::Heading(heading) = &node.data.borrow().value else {
            continue;
        };

        let level = heading.level;
        let source_line = node.data.borrow().sourcepos.start.line;
        let line = if source_line == 0 {
            frontmatter.body_start_line
        } else {
            frontmatter.body_start_line + source_line.saturating_sub(1)
        };
        let raw_text = extract_text(node);
        let (text, explicit_id) =
            renderer::split_explicit_id(&raw_text).unwrap_or((raw_text, String::new()));
        let slug = if explicit_id.is_empty() {
            unique_slug(renderer::slugify_heading(&text), &mut used_slugs)
        } else {
            explicit_id
        };

        raw.push(TocEntry {
            text,
            level,
            slug,
            number: None,
            line,
        });
    }

    assign_numbers(raw)
}

pub fn render_html(entries: &[TocEntry]) -> String {
    entries
        .iter()
        .map(|entry| {
            let number = entry
                .number
                .as_ref()
                .map(|number| format!(r#"<span class="num">{}</span>"#, escape_html(number)))
                .unwrap_or_default();
            format!(
                r#"<li class="entry h{level}" data-level="{level}" data-slug="{slug}">{number}<span class="text">{text}</span></li>"#,
                level = entry.level,
                slug = escape_attr(&entry.slug),
                text = escape_html(&entry.text),
            )
        })
        .collect()
}

fn assign_numbers(entries: Vec<TocEntry>) -> Vec<TocEntry> {
    if entries.is_empty() {
        return entries;
    }

    let h2_count = entries.iter().filter(|entry| entry.level == 2).count();
    if h2_count == 0 {
        return entries;
    }

    let numbered_h2_count = entries
        .iter()
        .filter(|entry| entry.level == 2 && existing_number_regex().is_match(&entry.text))
        .count();

    if numbered_h2_count * 2 >= h2_count {
        extract_existing_numbers(entries)
    } else {
        apply_auto_numbering(entries)
    }
}

fn extract_existing_numbers(entries: Vec<TocEntry>) -> Vec<TocEntry> {
    entries
        .into_iter()
        .map(|mut entry| {
            if entry.level >= 2 {
                if let Some((number, text)) = split_existing_number(&entry.text) {
                    entry.number = Some(number);
                    entry.text = text;
                }
            }
            entry
        })
        .collect()
}

fn apply_auto_numbering(entries: Vec<TocEntry>) -> Vec<TocEntry> {
    let mut counters = [0_u32; 5];

    entries
        .into_iter()
        .map(|mut entry| {
            if !(2..=6).contains(&entry.level) {
                return entry;
            }

            let depth = usize::from(entry.level - 1);
            counters[depth - 1] += 1;
            for counter in &mut counters[depth..] {
                *counter = 0;
            }

            entry.number = Some(
                counters[..depth]
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join("."),
            );
            entry
        })
        .collect()
}

fn split_existing_number(text: &str) -> Option<(String, String)> {
    let number_match = existing_number_regex().find(text)?;
    let number = number_match
        .as_str()
        .trim_end()
        .trim_end_matches('.')
        .to_string();
    let remainder = text[number_match.end()..].to_string();

    Some((number, remainder))
}

fn existing_number_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\d+(\.\d+)*\.?\s").expect("existing heading number regex must compile")
    })
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(value: &str) -> String {
    escape_html(value).replace('"', "&quot;")
}

fn unique_slug(slug: String, used_slugs: &mut HashMap<String, usize>) -> String {
    let count = used_slugs.entry(slug.clone()).or_default();
    let unique = if *count == 0 {
        slug
    } else {
        format!("{slug}-{count}")
    };
    *count += 1;
    unique
}

fn extract_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut text = String::new();
    for child in node.children() {
        append_text(child, &mut text);
    }
    text
}

fn append_text<'a>(node: &'a AstNode<'a>, text: &mut String) {
    match &node.data.borrow().value {
        NodeValue::Text(value) => text.push_str(value),
        NodeValue::Code(code) => text.push_str(&code.literal),
        NodeValue::LineBreak | NodeValue::SoftBreak => text.push(' '),
        _ => {
            for child in node.children() {
                append_text(child, text);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_headings() {
        let entries = extract("# A\n## B\n### C");

        assert_eq!(vec![1, 2, 3], levels(&entries));
        assert_eq!(vec!["A", "B", "C"], texts(&entries));
        assert_eq!(vec![1, 2, 3], lines(&entries));
    }

    #[test]
    fn test_auto_numbers() {
        let entries = extract("## A\n## B\n### C");

        assert_eq!(Some("1"), entries[0].number.as_deref());
        assert_eq!(Some("2"), entries[1].number.as_deref());
        assert_eq!(Some("2.1"), entries[2].number.as_deref());
    }

    #[test]
    fn test_existing_numbers() {
        let entries = extract("## 1. Intro\n## 2. Outro");

        assert_eq!(Some("1"), entries[0].number.as_deref());
        assert_eq!("Intro", entries[0].text);
        assert_eq!(Some("2"), entries[1].number.as_deref());
        assert_eq!("Outro", entries[1].text);
    }

    #[test]
    fn test_explicit_id() {
        let entries = extract("## Title {#custom}");

        assert_eq!("custom", entries[0].slug);
        assert_eq!("Title", entries[0].text);
    }

    #[test]
    fn test_text_extraction() {
        let entries = extract("## `code`");

        assert_eq!("code", entries[0].text);
    }

    #[test]
    fn test_duplicate_slugs_get_numeric_suffixes() {
        let entries = extract("# Foo\n# Foo\n# Foo");

        assert_eq!("foo", entries[0].slug);
        assert_eq!("foo-1", entries[1].slug);
        assert_eq!("foo-2", entries[2].slug);
    }

    #[test]
    fn test_inline_anchor_is_slug_and_not_text() {
        let entries = extract(r#"## First <a id="first"></a>"#);

        assert_eq!("First", entries[0].text);
        assert_eq!("first", entries[0].slug);
    }

    #[test]
    fn test_heading_lines_include_frontmatter_offset() {
        let entries = extract("---\ntitle: x\n---\n# A\n\n## B");

        assert_eq!(vec![4, 6], lines(&entries));
    }

    fn levels(entries: &[TocEntry]) -> Vec<u8> {
        entries.iter().map(|entry| entry.level).collect()
    }

    fn texts(entries: &[TocEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.text.as_str()).collect()
    }

    fn lines(entries: &[TocEntry]) -> Vec<usize> {
        entries.iter().map(|entry| entry.line).collect()
    }
}
