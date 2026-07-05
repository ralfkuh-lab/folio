//! Deterministic protection of non-translatable Markdown fragments.

use crate::renderer;
use comrak::{
    nodes::{LineColumn, NodeValue, Sourcepos},
    parse_document, Arena,
};
use regex::Regex;
use std::{fmt, ops::Range};

/// Masked Markdown plus the original fragments required to restore it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Masked {
    pub text: String,
    pub fragments: Vec<String>,
    pub nonce: String,
}

/// Returned when a model response no longer contains every protected fragment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmaskError {
    missing: Vec<usize>,
}

impl fmt::Display for UnmaskError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let indices = self
            .missing
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        write!(
            formatter,
            "Das Modell hat geschützte Platzhalter entfernt (fehlende Fragmente: {indices}; \
             insgesamt {}). Bitte versuchen Sie ein anderes Modell.",
            self.missing.len()
        )
    }
}

impl std::error::Error for UnmaskError {}

/// Replaces frontmatter, code, and HTML nodes with opaque placeholder tokens.
pub fn mask(source: &str) -> Masked {
    let nonce = available_nonce(source);
    if has_lone_carriage_return(source) {
        return Masked {
            text: source.to_string(),
            fragments: Vec::new(),
            nonce,
        };
    }
    let line_starts = line_starts(source);
    let mut options = renderer::markdown_options();
    options.extension.front_matter_delimiter = Some("---".into());

    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    let mut ranges = root
        .descendants()
        .filter_map(|node| {
            let data = node.data.borrow();
            protected_range(source, &line_starts, &data.value, data.sourcepos)
        })
        .collect::<Vec<_>>();

    // Outer nodes sort before contained nodes. Keeping only non-overlapping
    // ranges prevents a child (if comrak exposes one) from being masked twice.
    ranges.sort_unstable_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| right.end.cmp(&left.end))
    });
    let mut non_overlapping = Vec::with_capacity(ranges.len());
    for range in ranges {
        if non_overlapping
            .last()
            .map_or(true, |previous: &Range<usize>| range.start >= previous.end)
        {
            non_overlapping.push(range);
        }
    }

    let fragments = non_overlapping
        .iter()
        .map(|range| source[range.clone()].to_string())
        .collect::<Vec<_>>();
    let mut text = source.to_string();
    for (index, range) in non_overlapping.iter().enumerate().rev() {
        text.replace_range(range.clone(), &token(&nonce, index));
    }

    Masked {
        text,
        fragments,
        nonce,
    }
}

/// Restores protected fragments in a translated model response.
pub fn unmask(translated: &str, masked: &Masked) -> Result<String, UnmaskError> {
    if masked.fragments.is_empty() {
        return Ok(translated.to_string());
    }

    let token_regex = token_regex(masked);
    let mut occurrences = vec![0_usize; masked.fragments.len()];
    for captures in token_regex.captures_iter(translated) {
        let Some(index) = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<usize>().ok())
        else {
            continue;
        };
        if let Some(count) = occurrences.get_mut(index) {
            *count += 1;
        }
    }

    let missing = occurrences
        .iter()
        .enumerate()
        .filter_map(|(index, count)| (*count == 0).then_some(index))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(UnmaskError { missing });
    }

    for (index, count) in occurrences.iter().enumerate() {
        if *count > 1 {
            tracing::warn!(
                target: "folio::ai",
                fragment = index,
                occurrences = count,
                "AI response duplicated a protected placeholder"
            );
        }
    }

    Ok(token_regex
        .replace_all(translated, |captures: &regex::Captures<'_>| {
            let index = captures[1]
                .parse::<usize>()
                .expect("placeholder index consists only of digits");
            masked
                .fragments
                .get(index)
                .cloned()
                .unwrap_or_else(|| captures[0].to_string())
        })
        .into_owned())
}

/// Restores every complete placeholder received so far. Missing or partial
/// placeholders remain untouched so streaming previews can be rendered safely.
pub fn unmask_partial(translated: &str, masked: &Masked) -> String {
    if masked.fragments.is_empty() {
        return translated.to_string();
    }
    token_regex(masked)
        .replace_all(translated, |captures: &regex::Captures<'_>| {
            let index = captures[1]
                .parse::<usize>()
                .expect("placeholder index consists only of digits");
            masked
                .fragments
                .get(index)
                .cloned()
                .unwrap_or_else(|| captures[0].to_string())
        })
        .into_owned()
}

fn token_regex(masked: &Masked) -> Regex {
    let pattern = format!(r"`*⟦\s*F{}:(\d+)\s*⟧`*", regex::escape(&masked.nonce));
    Regex::new(&pattern).expect("placeholder regex must compile")
}

fn available_nonce(source: &str) -> String {
    for candidate in 0_u64.. {
        let candidate = candidate.to_string();
        if !source.contains(&format!("⟦F{candidate}:")) {
            return candidate;
        }
    }
    unreachable!("u64 candidates cannot all occur in one document")
}

fn token(nonce: &str, index: usize) -> String {
    format!("⟦F{nonce}:{index}⟧")
}

fn line_starts(source: &str) -> Vec<usize> {
    let mut starts = vec![0];
    starts.extend(
        source
            .bytes()
            .enumerate()
            .filter_map(|(index, byte)| (byte == b'\n').then_some(index + 1)),
    );
    starts
}

fn has_lone_carriage_return(source: &str) -> bool {
    let bytes = source.as_bytes();
    bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| *byte == b'\r' && bytes.get(index + 1) != Some(&b'\n'))
}

fn protected_range(
    source: &str,
    line_starts: &[usize],
    value: &NodeValue,
    sourcepos: Sourcepos,
) -> Option<Range<usize>> {
    let range = match value {
        NodeValue::FrontMatter(_)
        | NodeValue::CodeBlock(_)
        | NodeValue::HtmlBlock(_)
        | NodeValue::HtmlInline(_) => source_range(source, line_starts, sourcepos)?,
        NodeValue::Code(code) => {
            let mut range = source_range(source, line_starts, sourcepos)?;
            // comrak's inline-code sourcepos covers the contents but not the
            // delimiter. Include it so the model sees only the opaque token.
            range.start = range.start.checked_sub(code.num_backticks)?;
            range.end = range.end.checked_add(code.num_backticks)?;
            range
        }
        _ => return None,
    };

    if range.start >= range.end
        || range.end > source.len()
        || !source.is_char_boundary(range.start)
        || !source.is_char_boundary(range.end)
    {
        return None;
    }
    Some(range)
}

fn source_range(source: &str, line_starts: &[usize], sourcepos: Sourcepos) -> Option<Range<usize>> {
    // comrak columns are 1-based, byte-based, and inclusive at the end.
    let start = byte_offset(line_starts, sourcepos.start, false)?;
    let end = byte_offset(line_starts, sourcepos.end, true)?;
    (end <= source.len()).then_some(start..end)
}

fn byte_offset(line_starts: &[usize], position: LineColumn, inclusive_end: bool) -> Option<usize> {
    let line_start = *line_starts.get(position.line.checked_sub(1)?)?;
    let column = position.column.checked_sub(usize::from(!inclusive_end))?;
    line_start.checked_add(column)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(source: &str) -> Masked {
        let masked = mask(source);
        assert_eq!(source, unmask(&masked.text, &masked).unwrap());
        masked
    }

    #[test]
    fn roundtrip_preserves_all_phase_one_constructs() {
        let source = "\
---
title: Nicht übersetzen
draft: true
---

# Überschrift

Text mit `inline_call(\"ä\")` und <span data-x=\"1\">Inhalt</span><br>.

```rust
fn main() {
    println!(\"Hallo\");
}
```

    indented_code();

<div class=\"raw\">
`inside_html_block`
</div>
";
        let masked = roundtrip(source);

        assert_eq!(8, masked.fragments.len());
        assert!(!masked.text.contains("draft: true"));
        assert!(!masked.text.contains("inline_call"));
        assert!(!masked.text.contains("println!"));
        assert!(!masked.text.contains("indented_code"));
        assert!(!masked.text.contains("inside_html_block"));
        assert!(masked.text.contains("Inhalt"));
    }

    #[test]
    fn translated_prose_and_unchanged_tokens_restore_correctly() {
        let source = "Hello `secret()` world.\n";
        let masked = mask(source);
        let translated = masked
            .text
            .replace("Hello", "Bonjour")
            .replace("world", "monde");

        assert_eq!(
            "Bonjour `secret()` monde.\n",
            unmask(&translated, &masked).unwrap()
        );
    }

    #[test]
    fn partial_unmask_restores_complete_tokens_and_leaves_half_token() {
        let masked = mask("Before `secret()` after.");
        let partial = format!("Avant {} puis ⟦F", token(&masked.nonce, 0));
        assert_eq!(
            "Avant `secret()` puis ⟦F",
            unmask_partial(&partial, &masked)
        );
    }

    #[test]
    fn partial_unmask_allows_missing_tokens() {
        let masked = mask("Before `secret()` after.");
        assert_eq!("Avant", unmask_partial("Avant", &masked));
    }

    #[test]
    fn partial_unmask_without_fragments_returns_input() {
        let masked = mask("Plain prose.");
        assert!(masked.fragments.is_empty());
        assert_eq!("", unmask_partial("", &masked));
        assert_eq!("Préfixe", unmask_partial("Préfixe", &masked));
    }

    #[test]
    fn unmask_tolerates_token_whitespace_and_backticks() {
        let source = "Before `secret()` after.";
        let masked = mask(source);
        let token = token(&masked.nonce, 0);

        let spaced = masked
            .text
            .replace(&token, &format!("⟦ F{}:0 ⟧", masked.nonce));
        assert_eq!(source, unmask(&spaced, &masked).unwrap());

        let backticked = masked.text.replace(&token, &format!("`{token}`"));
        assert_eq!(source, unmask(&backticked, &masked).unwrap());
    }

    #[test]
    fn missing_token_is_an_error() {
        let masked = mask("Before `secret()` after.");
        let translated = masked.text.replace(&token(&masked.nonce, 0), "");
        let error = unmask(&translated, &masked).unwrap_err();

        assert_eq!(vec![0], error.missing);
        assert!(error.to_string().contains("Platzhalter entfernt"));
        assert!(error.to_string().contains("0"));
    }

    #[test]
    fn duplicated_token_restores_every_occurrence() {
        let masked = mask("Before `secret()` after.");
        let placeholder = token(&masked.nonce, 0);
        let translated = masked
            .text
            .replace(&placeholder, &format!("{placeholder} + {placeholder}"));

        assert_eq!(
            "Before `secret()` + `secret()` after.",
            unmask(&translated, &masked).unwrap()
        );
    }

    #[test]
    fn prose_without_protected_content_is_unchanged() {
        let source = "# Nur Prosa\n\nEin ganz normaler Absatz.\n";
        let masked = mask(source);

        assert!(masked.fragments.is_empty());
        assert_eq!(source, masked.text);
        assert_eq!(source, unmask(&masked.text, &masked).unwrap());
    }

    #[test]
    fn multibyte_text_and_tab_indented_code_have_correct_byte_ranges() {
        let source = "\
Äpfel 😀 vor `let grüße = \"👋\";` und danach.

	fn_with_tab(\"ö\");

Schluss 😀 <br>.
";
        let masked = roundtrip(source);

        assert_eq!(3, masked.fragments.len());
        assert!(masked
            .fragments
            .contains(&"`let grüße = \"👋\";`".to_string()));
        assert!(masked
            .fragments
            .contains(&"fn_with_tab(\"ö\");\n".to_string()));
        assert!(masked
            .text
            .contains(&format!("\t{}", token(&masked.nonce, 1))));
        assert!(masked.fragments.contains(&"<br>".to_string()));
    }

    #[test]
    fn lone_carriage_returns_do_not_corrupt_the_roundtrip() {
        roundtrip("Vorher\rmit `code()`\rDanach\n\n```\rraw\r```\n");
    }

    #[test]
    fn html_block_with_inline_code_is_masked_only_once() {
        let source = "<div>\nText with `code()`.\n</div>\n";
        let masked = roundtrip(source);

        assert_eq!(vec![source.trim_end().to_string()], masked.fragments);
        assert_eq!(format!("{}\n", token(&masked.nonce, 0)), masked.text);
    }

    #[test]
    fn nonce_skips_tokens_already_present_in_source() {
        let source = "Existing ⟦F0:999⟧ text and `code()`.\n";
        let masked = roundtrip(source);

        assert_eq!("1", masked.nonce);
        assert!(masked.text.contains("⟦F0:999⟧"));
        assert!(masked.text.contains("⟦F1:0⟧"));
    }
}
