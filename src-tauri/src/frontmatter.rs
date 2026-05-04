use std::fmt::Write;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractResult {
    pub entries: Vec<Entry>,
    pub body: String,
}

/// Simple YAML-subset parser for Folio frontmatter.
///
/// Supports only flat key:value pairs, quoted strings, and inline arrays.
/// Does NOT support nested objects, multiline strings (| >), or YAML anchors.
/// For Folio's use case this is sufficient; if complex frontmatter is needed,
/// migrate to `serde_yaml`.
pub fn extract(markdown: &str) -> ExtractResult {
    if markdown.is_empty() {
        return empty_result(markdown);
    }

    let Some(first_line_end) = markdown.find('\n') else {
        return empty_result(markdown);
    };

    if markdown[..first_line_end].trim_end_matches('\r') != "---" {
        return empty_result(markdown);
    }

    let rest = &markdown[first_line_end + 1..];
    let lines: Vec<&str> = rest.split('\n').collect();
    let Some(close_idx) = lines
        .iter()
        .position(|line| line.trim_end_matches('\r') == "---")
    else {
        return empty_result(markdown);
    };

    let entries = lines[..close_idx]
        .iter()
        .filter_map(|line| parse_entry(line.trim_end_matches('\r')))
        .collect();

    let mut consumed = 0;
    for line in &lines[..=close_idx] {
        consumed += line.len() + 1;
    }
    consumed = consumed.min(rest.len());

    ExtractResult {
        entries,
        body: rest[consumed..].to_string(),
    }
}

pub fn render_html(entries: &[Entry]) -> String {
    if entries.is_empty() {
        return String::new();
    }

    let mut html = String::from(r#"<aside class="frontmatter"><dl>"#);
    for entry in entries {
        html.push_str("<dt>");
        escape_html(&mut html, &entry.key);
        html.push_str("</dt><dd>");
        escape_html(&mut html, &entry.value);
        html.push_str("</dd>");
    }
    html.push_str("</dl></aside>");
    html
}

fn empty_result(markdown: &str) -> ExtractResult {
    ExtractResult {
        entries: Vec::new(),
        body: markdown.to_string(),
    }
}

fn parse_entry(line: &str) -> Option<Entry> {
    if line.trim().is_empty() {
        return None;
    }

    let first = line.chars().next()?;
    if first.is_whitespace() || line.trim_start().starts_with('#') {
        return None;
    }

    let colon = line.find(':')?;
    if colon == 0 {
        return None;
    }

    Some(Entry {
        key: line[..colon].trim().to_string(),
        value: normalize_value(line[colon + 1..].trim()),
    })
}

fn normalize_value(raw: &str) -> String {
    if raw.len() >= 2 {
        if is_quoted(raw) {
            return raw[1..raw.len() - 1].to_string();
        }

        if raw.starts_with('[') && raw.ends_with(']') {
            return raw[1..raw.len() - 1]
                .split(',')
                .filter_map(|part| {
                    let part = part.trim();
                    if part.is_empty() {
                        None
                    } else if is_quoted(part) {
                        Some(part[1..part.len() - 1].to_string())
                    } else {
                        Some(part.to_string())
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
        }
    }

    raw.to_string()
}

fn is_quoted(value: &str) -> bool {
    (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
}

fn escape_html(output: &mut String, value: &str) {
    for ch in value.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            _ => write!(output, "{ch}").expect("writing to String should not fail"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_frontmatter() {
        let result = extract("# Hello");

        assert!(result.entries.is_empty());
        assert_eq!("# Hello", result.body);
    }

    #[test]
    fn test_simple_frontmatter() {
        let result = extract("---\ntitle: Foo\n---\n# Hello");

        assert_eq!(
            vec![Entry {
                key: "title".to_string(),
                value: "Foo".to_string()
            }],
            result.entries
        );
        assert_eq!("# Hello", result.body);
    }

    #[test]
    fn test_quoted_value() {
        let result = extract("---\nfoo: \"bar\"\n---\nbody");

        assert_eq!("bar", result.entries[0].value);
    }

    #[test]
    fn test_array_value() {
        let result = extract("---\ntags: [\"a\", \"b\"]\n---\nbody");

        assert_eq!("a, b", result.entries[0].value);
    }

    #[test]
    fn test_render_html_empty() {
        assert_eq!("", render_html(&[]));
    }

    #[test]
    fn test_render_html_escapes() {
        let html = render_html(&[Entry {
            key: "<script>".to_string(),
            value: "\"x\" & y".to_string(),
        }]);

        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&quot;x&quot; &amp; y"));
    }
}
