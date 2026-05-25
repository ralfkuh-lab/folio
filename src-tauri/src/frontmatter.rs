use std::fmt::Write;

use saphyr::{LoadableYamlNode, Yaml};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractResult {
    pub entries: Vec<Entry>,
    pub body: String,
    pub body_start_line: usize,
}

/// Frontmatter aus einem Markdown-Dokument lösen.
///
/// Die Delimiter-Detektion (öffnendes/schliessendes `---`) ist bewusst
/// **eigene Logik** — sie ist deterministisch und liefert den Body auch
/// dann sauber zurück, wenn der innere YAML-Block kaputt ist.
///
/// Den inneren Block parst `saphyr` (YAML 1.2). Bei Parse-Fehlern oder
/// Strukturen, die wir nicht flach darstellen können (z. B. ein Top-
/// Level-Scalar statt einer Mapping), fällt die Anzeige auf einen
/// einzelnen Fallback-Eintrag mit dem Rohblock zurück — der Renderer
/// (`white-space: pre-line` im CSS) zeigt ihn lesbar an.
///
/// Multi-Line-Werte (Block-Scalars `|`/`>`, Block-Sequenzen) kommen mit
/// `\n` zwischen den Segmenten zurück und werden im CSS umgebrochen.
pub fn extract(markdown: &str) -> ExtractResult {
    let Some((yaml_block, body)) = split_frontmatter(markdown) else {
        return ExtractResult {
            entries: Vec::new(),
            body: markdown.to_string(),
            body_start_line: 1,
        };
    };
    let entries = parse_yaml(yaml_block).unwrap_or_else(|| fallback_entries(yaml_block));
    ExtractResult {
        entries,
        body: body.to_string(),
        body_start_line: body_start_line(markdown, body),
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

fn split_frontmatter(markdown: &str) -> Option<(&str, &str)> {
    let first_nl = markdown.find('\n')?;
    if markdown[..first_nl].trim_end_matches('\r') != "---" {
        return None;
    }
    let rest = &markdown[first_nl + 1..];

    let mut offset = 0;
    let close_start;
    let close_end;
    loop {
        let line_end = rest[offset..]
            .find('\n')
            .map(|n| offset + n)
            .unwrap_or(rest.len());
        let line = &rest[offset..line_end];
        if line.trim_end_matches('\r') == "---" {
            close_start = offset;
            close_end = line_end;
            break;
        }
        if line_end >= rest.len() {
            return None;
        }
        offset = line_end + 1;
    }

    let yaml_block = rest[..close_start].trim_end_matches(['\r', '\n']);
    let body_start = (close_end + 1).min(rest.len());
    Some((yaml_block, &rest[body_start..]))
}

fn body_start_line(markdown: &str, body: &str) -> usize {
    let body_start = markdown.len().saturating_sub(body.len());
    markdown[..body_start]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1
}

/// `None` signalisiert: nicht als Mapping darstellbar — Fallback nutzen.
/// `Some(Vec::new())` bedeutet: leere Frontmatter, kein Fallback nötig.
fn parse_yaml(yaml: &str) -> Option<Vec<Entry>> {
    if yaml.trim().is_empty() {
        return Some(Vec::new());
    }
    let docs = Yaml::load_from_str(yaml).ok()?;
    let doc = docs.into_iter().next()?;
    if doc.is_null() {
        return Some(Vec::new());
    }
    let mapping = doc.as_mapping()?;
    Some(
        mapping
            .iter()
            .filter_map(|(k, v)| {
                yaml_to_key(k).map(|key| Entry {
                    key,
                    value: yaml_to_value(v),
                })
            })
            .collect(),
    )
}

fn fallback_entries(yaml: &str) -> Vec<Entry> {
    if yaml.trim().is_empty() {
        return Vec::new();
    }
    vec![Entry {
        key: "frontmatter".to_string(),
        value: yaml.to_string(),
    }]
}

fn yaml_to_key(node: &Yaml<'_>) -> Option<String> {
    if let Some(s) = node.as_str() {
        return Some(s.to_string());
    }
    if let Some(i) = node.as_integer() {
        return Some(i.to_string());
    }
    if let Some(b) = node.as_bool() {
        return Some(b.to_string());
    }
    match node {
        Yaml::Tagged(_, inner) => yaml_to_key(inner),
        Yaml::Representation(text, _, _) => Some(text.to_string()),
        _ => None,
    }
}

fn yaml_to_value(node: &Yaml<'_>) -> String {
    if node.is_null() {
        return String::new();
    }
    if let Some(s) = node.as_str() {
        // YAML clip indicator (`|` / `>` ohne `-`) lässt einen Trailing-
        // Newline stehen — für die <dd>-Anzeige stört der.
        return s.trim_end_matches('\n').to_string();
    }
    if let Some(i) = node.as_integer() {
        return i.to_string();
    }
    if let Some(b) = node.as_bool() {
        return b.to_string();
    }
    if let Some(seq) = node.as_vec() {
        return seq.iter().map(yaml_to_value).collect::<Vec<_>>().join("\n");
    }
    if let Some(map) = node.as_mapping() {
        return map
            .iter()
            .filter_map(|(k, v)| {
                yaml_to_key(k).map(|kk| {
                    let val = yaml_to_value(v);
                    if val.contains('\n') {
                        let indented = val
                            .lines()
                            .map(|l| format!("  {l}"))
                            .collect::<Vec<_>>()
                            .join("\n");
                        format!("{kk}:\n{indented}")
                    } else {
                        format!("{kk}: {val}")
                    }
                })
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    match node {
        Yaml::Tagged(_, inner) => yaml_to_value(inner),
        Yaml::Representation(text, _, _) => text.to_string(),
        _ => String::new(),
    }
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
    fn no_frontmatter_returns_body_unchanged() {
        let result = extract("# Hello");
        assert!(result.entries.is_empty());
        assert_eq!("# Hello", result.body);
    }

    #[test]
    fn simple_key_value() {
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
    fn quoted_value() {
        let result = extract("---\nfoo: \"bar\"\n---\nbody");
        assert_eq!("bar", result.entries[0].value);
    }

    #[test]
    fn inline_array_joined_with_newline() {
        let result = extract("---\ntags: [\"a\", \"b\"]\n---\nbody");
        assert_eq!("a\nb", result.entries[0].value);
    }

    #[test]
    fn block_literal_scalar_preserves_newlines() {
        let input = "---\ndescription: |\n  line one\n  line two\n  line three\nname: x\n---\nbody";
        let result = extract(input);
        let desc = result
            .entries
            .iter()
            .find(|e| e.key == "description")
            .unwrap();
        assert_eq!("line one\nline two\nline three", desc.value);
        let name = result.entries.iter().find(|e| e.key == "name").unwrap();
        assert_eq!("x", name.value);
    }

    #[test]
    fn block_folded_scalar_collapses_newlines() {
        let input = "---\ndescription: >\n  line one\n  line two\n\n  paragraph two\n---\nbody";
        let result = extract(input);
        assert_eq!("line one line two\nparagraph two", result.entries[0].value);
    }

    #[test]
    fn block_sequence_joined_with_newline() {
        let input =
            "---\ntriggers:\n  - first item\n  - second item\n  - third item\nname: x\n---\nbody";
        let result = extract(input);
        let triggers = result.entries.iter().find(|e| e.key == "triggers").unwrap();
        assert_eq!("first item\nsecond item\nthird item", triggers.value);
    }

    #[test]
    fn order_is_preserved() {
        let input = "---\nzeta: 1\nalpha: 2\nmiddle: 3\n---\nbody";
        let result = extract(input);
        let keys: Vec<_> = result.entries.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(vec!["zeta", "alpha", "middle"], keys);
    }

    #[test]
    fn body_preserved_with_crlf() {
        let input = "---\r\nfoo: bar\r\n---\r\nbody\r\nmore";
        let result = extract(input);
        assert_eq!("bar", result.entries[0].value);
        assert_eq!("body\r\nmore", result.body);
    }

    #[test]
    fn invalid_yaml_falls_back_to_raw_block() {
        // Tab als Indent ist im YAML-Spec verboten — saphyr lehnt ab.
        let input = "---\nfoo:\n\tbar: baz\n---\nbody";
        let result = extract(input);
        assert_eq!(1, result.entries.len());
        assert_eq!("frontmatter", result.entries[0].key);
        assert!(result.entries[0].value.contains("foo:"));
        assert_eq!("body", result.body);
    }

    #[test]
    fn top_level_scalar_falls_back_to_raw_block() {
        let input = "---\njust a string\n---\nbody";
        let result = extract(input);
        assert_eq!("frontmatter", result.entries[0].key);
        assert!(result.entries[0].value.contains("just a string"));
        assert_eq!("body", result.body);
    }

    #[test]
    fn empty_frontmatter_is_empty_entries() {
        let result = extract("---\n---\nbody");
        assert!(result.entries.is_empty());
        assert_eq!("body", result.body);
    }

    #[test]
    fn unterminated_frontmatter_keeps_full_markdown_as_body() {
        let input = "---\nfoo: bar\n# Heading";
        let result = extract(input);
        assert!(result.entries.is_empty());
        assert_eq!(input, result.body);
    }

    #[test]
    fn nested_mapping_value_renders_indented() {
        let input = "---\nauthor:\n  name: Foo\n  email: foo@bar\n---\nbody";
        let result = extract(input);
        let value = &result.entries[0].value;
        assert!(value.contains("name: Foo"));
        assert!(value.contains("email: foo@bar"));
    }

    #[test]
    fn render_html_empty() {
        assert_eq!("", render_html(&[]));
    }

    #[test]
    fn render_html_escapes() {
        let html = render_html(&[Entry {
            key: "<script>".to_string(),
            value: "\"x\" & y".to_string(),
        }]);
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&quot;x&quot; &amp; y"));
    }

    #[test]
    fn render_html_preserves_newlines() {
        let html = render_html(&[Entry {
            key: "triggers".to_string(),
            value: "a\nb".to_string(),
        }]);
        assert!(html.contains("<dd>a\nb</dd>"));
    }
}
