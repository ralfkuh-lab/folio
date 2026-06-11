use regex::Regex;
use std::sync::OnceLock;

pub fn convert_inline_anchors_in_headings(markdown: &str) -> String {
    if markdown.is_empty() || !markdown.to_ascii_lowercase().contains("<a") {
        return markdown.to_string();
    }

    // Zeilenweiser Scan mit Fence-Tracker: Innerhalb von ```/~~~-Bloecken
    // wird nichts umgeschrieben — eine Heading+Anchor-Zeile in einem
    // Codeblock (z. B. Doku, die genau dieses Feature beschreibt) wuerde
    // sonst zu `# Title {#id}` verfaelscht. Der Store normalisiert
    // Zeilenenden auf \n, daher reicht split('\n').
    let mut out = String::with_capacity(markdown.len());
    let mut fence: Option<(char, usize)> = None;
    for (i, line) in markdown.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        match fence {
            Some((ch, len)) => {
                if is_closing_fence(line, ch, len) {
                    fence = None;
                }
                out.push_str(line);
            }
            None => {
                if let Some(open) = opening_fence(line) {
                    fence = Some(open);
                    out.push_str(line);
                } else {
                    out.push_str(&convert_heading_line(line));
                }
            }
        }
    }
    out
}

fn convert_heading_line(line: &str) -> String {
    heading_line_regex()
        .replace(line, |captures: &regex::Captures<'_>| {
            let rest = captures.name("rest").expect("rest capture").as_str();
            let mut last_id = None;
            let stripped = inline_anchor_regex()
                .replace_all(rest, |anchor: &regex::Captures<'_>| {
                    last_id = Some(anchor[1].to_string());
                    ""
                })
                .trim_end()
                .to_string();

            match last_id {
                Some(id) => format!("{} {} {{#{}}}", &captures["hashes"], stripped, id),
                None => captures[0].to_string(),
            }
        })
        .to_string()
}

/// CommonMark-Fence-Start: max. 3 Spaces Einrueckung, dann >= 3 Backticks
/// oder Tilden. Info-String-Feinheiten (Backticks im Info-String) werden
/// bewusst ignoriert — fuer den Skip-Zweck reicht die einfache Form.
fn opening_fence(line: &str) -> Option<(char, usize)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = rest.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let len = rest.chars().take_while(|&c| c == ch).count();
    if len < 3 {
        return None;
    }
    Some((ch, len))
}

/// Schliessender Fence: gleiches Zeichen, mindestens so lang wie der
/// oeffnende, danach nur Whitespace.
fn is_closing_fence(line: &str, ch: char, open_len: usize) -> bool {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return false;
    }
    let rest = &line[indent..];
    let len = rest.chars().take_while(|&c| c == ch).count();
    len >= open_len && rest[len..].trim().is_empty()
}

fn inline_anchor_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"<a\s+id\s*=\s*["']([^"']+)["']\s*>\s*</a>"#)
            .expect("inline anchor regex must compile")
    })
}

fn heading_line_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?m)^(?P<hashes>#{1,6})[ \t]+(?P<rest>.+?)[ \t]*$")
            .expect("heading line regex must compile")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_anchor_in_heading() {
        let input = "## Title <a id=\"custom\"></a>\nBody\n";
        assert_eq!(
            "## Title {#custom}\nBody\n",
            convert_inline_anchors_in_headings(input)
        );
    }

    #[test]
    fn leaves_heading_anchor_inside_backtick_fence_untouched() {
        let input = "```markdown\n# Title <a id=\"x\"></a>\n```\n";
        assert_eq!(input, convert_inline_anchors_in_headings(input));
    }

    #[test]
    fn leaves_heading_anchor_inside_tilde_fence_untouched() {
        let input = "~~~\n## Doc <a id='y'></a>\n~~~\n";
        assert_eq!(input, convert_inline_anchors_in_headings(input));
    }

    #[test]
    fn converts_again_after_fence_closes() {
        let input = "```\n# In Fence <a id=\"a\"></a>\n```\n# Out <a id=\"b\"></a>\n";
        assert_eq!(
            "```\n# In Fence <a id=\"a\"></a>\n```\n# Out {#b}\n",
            convert_inline_anchors_in_headings(input)
        );
    }

    #[test]
    fn shorter_fence_run_does_not_close_longer_fence() {
        // ```` oeffnet; ``` schliesst NICHT (CommonMark: Closing-Fence
        // muss mindestens so lang sein wie der oeffnende).
        let input = "````\n```\n# Inner <a id=\"z\"></a>\n````\n";
        assert_eq!(input, convert_inline_anchors_in_headings(input));
    }

    #[test]
    fn unclosed_fence_skips_rest_of_document() {
        let input = "```\n# Never <a id=\"n\"></a>\n";
        assert_eq!(input, convert_inline_anchors_in_headings(input));
    }

    #[test]
    fn indented_fence_up_to_three_spaces_counts() {
        let input = "   ```\n# Hidden <a id=\"h\"></a>\n   ```\n";
        assert_eq!(input, convert_inline_anchors_in_headings(input));
    }
}
