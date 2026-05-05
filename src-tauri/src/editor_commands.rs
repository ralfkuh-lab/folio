#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditResult {
    pub new_text: String,
    pub new_selection_start: usize,
    pub new_selection_length: usize,
}

pub fn toggle_wrap(text: &str, mut start: usize, mut length: usize, token: &str) -> EditResult {
    clamp_range(text, &mut start, &mut length);

    if length == 0 {
        let mut new_text = String::with_capacity(text.len() + token.len() * 2);
        new_text.push_str(&text[..start]);
        new_text.push_str(token);
        new_text.push_str(token);
        new_text.push_str(&text[start..]);
        return EditResult {
            new_text,
            new_selection_start: start + token.len(),
            new_selection_length: 0,
        };
    }

    let end = start + length;
    if start >= token.len() && text[..start].ends_with(token) && text[end..].starts_with(token) {
        let prefix_start = start - token.len();
        let suffix_end = end + token.len();
        let mut new_text = String::with_capacity(text.len() - token.len() * 2);
        new_text.push_str(&text[..prefix_start]);
        new_text.push_str(&text[start..end]);
        new_text.push_str(&text[suffix_end..]);
        EditResult {
            new_text,
            new_selection_start: prefix_start,
            new_selection_length: length,
        }
    } else {
        let mut new_text = String::with_capacity(text.len() + token.len() * 2);
        new_text.push_str(&text[..start]);
        new_text.push_str(token);
        new_text.push_str(&text[start..end]);
        new_text.push_str(token);
        new_text.push_str(&text[end..]);
        EditResult {
            new_text,
            new_selection_start: start + token.len(),
            new_selection_length: length,
        }
    }
}

pub fn toggle_line_prefix(
    text: &str,
    mut start: usize,
    mut length: usize,
    prefix: &str,
) -> EditResult {
    clamp_range(text, &mut start, &mut length);
    let (range_start, range_end) = touched_line_range(text, start, length);
    let segment = &text[range_start..range_end];
    let lines = split_keep_endings(segment);
    let remove = lines.iter().all(|line| {
        let body = trim_eol(line);
        body.trim().is_empty() || body.starts_with(prefix)
    });

    let replacement = lines
        .iter()
        .map(|line| {
            let body = trim_eol(line);
            let ending = &line[body.len()..];
            if body.trim().is_empty() {
                (*line).to_string()
            } else if remove {
                format!("{}{}", body.strip_prefix(prefix).unwrap_or(body), ending)
            } else {
                format!("{prefix}{body}{ending}")
            }
        })
        .collect::<String>();

    replace_lines(text, range_start, range_end, replacement)
}

pub fn toggle_numbered_list_prefix(text: &str, mut start: usize, mut length: usize) -> EditResult {
    clamp_range(text, &mut start, &mut length);
    let (range_start, range_end) = touched_line_range(text, start, length);
    let segment = &text[range_start..range_end];
    let lines = split_keep_endings(segment);
    let remove = lines.iter().all(|line| {
        let body = trim_eol(line);
        body.trim().is_empty() || numbered_prefix_length(body) > 0
    });

    let mut number = 1;
    let replacement = lines
        .iter()
        .map(|line| {
            let body = trim_eol(line);
            let ending = &line[body.len()..];
            if body.trim().is_empty() {
                (*line).to_string()
            } else if remove {
                let prefix_length = numbered_prefix_length(body);
                format!("{}{}", &body[prefix_length..], ending)
            } else {
                let line = format!("{number}. {body}{ending}");
                number += 1;
                line
            }
        })
        .collect::<String>();

    replace_lines(text, range_start, range_end, replacement)
}

pub fn cycle_heading(text: &str, mut start: usize, mut length: usize) -> EditResult {
    clamp_range(text, &mut start, &mut length);
    let line_start = line_start_of(text, start);
    let line_end = line_end_of(text, start);
    let line = &text[line_start..line_end];
    let hashes = heading_hash_count(line);
    let content_start = if hashes > 0 { hashes + 1 } else { 0 };
    let content = &line[content_start..];
    let (new_line, prefix_delta) = match hashes {
        0 => (format!("# {line}"), 2isize),
        1 => (format!("## {content}"), 1),
        2 => (format!("### {content}"), 1),
        _ => (content.to_string(), -4),
    };

    let mut new_text =
        String::with_capacity(text.len() + new_line.len().saturating_sub(line.len()));
    new_text.push_str(&text[..line_start]);
    new_text.push_str(&new_line);
    new_text.push_str(&text[line_end..]);

    let new_start = (start as isize + prefix_delta).max(line_start as isize) as usize;
    EditResult {
        new_text,
        new_selection_start: new_start,
        new_selection_length: length,
    }
}

pub fn insert_image(text: &str, mut start: usize, mut length: usize) -> EditResult {
    clamp_range(text, &mut start, &mut length);
    const PATH_PLACEHOLDER: &str = "pfad";
    const ALT_PLACEHOLDER: &str = "alt";
    if length == 0 {
        insert_snippet(
            text,
            start,
            &format!("![{ALT_PLACEHOLDER}]({PATH_PLACEHOLDER})"),
            start + 2,
            ALT_PLACEHOLDER.len(),
        )
    } else {
        let end = start + length;
        let selection = &text[start..end];
        replace_selection(
            text,
            start,
            end,
            &format!("![{selection}]({PATH_PLACEHOLDER})"),
            start + 2,
            length,
        )
    }
}

pub fn insert_table(text: &str, mut start: usize, mut length: usize) -> EditResult {
    clamp_range(text, &mut start, &mut length);
    const FIRST_CELL: &str = "Spalte 1";
    let snippet = format!("| {FIRST_CELL} | Spalte 2 | Spalte 3 |\n|---|---|---|\n|   |   |   |");
    let prefix = insertion_newline_prefix(text, start);
    let suffix = table_insertion_newline_suffix(text, start + length);
    let insertion = format!("{prefix}{snippet}{suffix}");
    replace_selection(
        text,
        start,
        start + length,
        &insertion,
        start + prefix.len() + 2,
        FIRST_CELL.len(),
    )
}

pub fn insert_link(text: &str, mut start: usize, mut length: usize) -> EditResult {
    clamp_range(text, &mut start, &mut length);
    const URL_PLACEHOLDER: &str = "url";
    const TEXT_PLACEHOLDER: &str = "text";
    if length == 0 {
        insert_snippet(
            text,
            start,
            &format!("[{TEXT_PLACEHOLDER}]({URL_PLACEHOLDER})"),
            start + 1,
            TEXT_PLACEHOLDER.len(),
        )
    } else {
        let end = start + length;
        let selection = &text[start..end];
        replace_selection(
            text,
            start,
            end,
            &format!("[{selection}]({URL_PLACEHOLDER})"),
            start + 1,
            length,
        )
    }
}

pub fn insert_code_block(text: &str, mut start: usize, mut length: usize) -> EditResult {
    clamp_range(text, &mut start, &mut length);

    if length > 0 {
        let end = start + length;
        let opening = "```\n";
        let closing = "\n```";
        if text[..start].ends_with(opening) && text[end..].starts_with(closing) {
            let opening_start = start - opening.len();
            let opening_alone =
                opening_start == 0 || text.as_bytes().get(opening_start - 1) == Some(&b'\n');
            let closing_end = end + closing.len();
            let closing_alone =
                closing_end == text.len() || text.as_bytes().get(closing_end) == Some(&b'\n');
            if opening_alone && closing_alone {
                let content_len = length;
                let mut new_text =
                    String::with_capacity(text.len() - opening.len() - closing.len());
                new_text.push_str(&text[..opening_start]);
                new_text.push_str(&text[start..end]);
                new_text.push_str(&text[closing_end..]);
                return EditResult {
                    new_text,
                    new_selection_start: opening_start,
                    new_selection_length: content_len,
                };
            }
        }
    }

    let prefix = insertion_newline_prefix(text, start);
    let suffix = insertion_newline_suffix(text, start + length);
    if length == 0 {
        let insertion = format!("{prefix}```\n\n```{suffix}");
        let cursor = start + prefix.len() + 4; // after ```\n
        replace_selection(text, start, start, &insertion, cursor, 0)
    } else {
        let content = &text[start..start + length];
        let insertion = format!("{prefix}```\n{content}\n```{suffix}");
        replace_selection(
            text,
            start,
            start + length,
            &insertion,
            start + prefix.len() + 4,
            content.len(),
        )
    }
}

fn line_start_of(text: &str, offset: usize) -> usize {
    let offset = clamp_to_char_boundary(text, offset.min(text.len()));
    text[..offset].rfind('\n').map_or(0, |index| index + 1)
}

fn line_end_of(text: &str, offset: usize) -> usize {
    let offset = clamp_to_char_boundary(text, offset.min(text.len()));
    text[offset..].find('\n').map_or(text.len(), |index| {
        let line_end = offset + index;
        if line_end > 0 && text.as_bytes()[line_end - 1] == b'\r' {
            line_end - 1
        } else {
            line_end
        }
    })
}

fn trim_eol(s: &str) -> &str {
    s.trim_end_matches(['\n', '\r'])
}

fn split_keep_endings(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return vec![""];
    }

    let mut lines = Vec::new();
    let mut start = 0;
    for (index, ch) in s.char_indices() {
        if ch == '\n' {
            lines.push(&s[start..index + 1]);
            start = index + 1;
        }
    }
    if start < s.len() {
        lines.push(&s[start..]);
    }
    lines
}

fn clamp_range(text: &str, start: &mut usize, length: &mut usize) {
    *start = clamp_to_char_boundary(text, (*start).min(text.len()));
    let requested_end = start.saturating_add(*length).min(text.len());
    let end = clamp_to_char_boundary(text, requested_end);
    *length = end.saturating_sub(*start);
}

fn numbered_prefix_length(s: &str) -> usize {
    let bytes = s.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }

    if index == 0 || bytes.get(index) != Some(&b'.') || bytes.get(index + 1) != Some(&b' ') {
        0
    } else {
        index + 2
    }
}

fn touched_line_range(text: &str, start: usize, length: usize) -> (usize, usize) {
    let range_start = line_start_of(text, start);
    let mut touched_end = start + length;
    if length > 0 && touched_end > start && text[..touched_end].ends_with('\n') {
        touched_end -= 1;
    }
    (range_start, line_end_of(text, touched_end))
}

fn replace_lines(
    text: &str,
    range_start: usize,
    range_end: usize,
    replacement: String,
) -> EditResult {
    let mut new_text = String::with_capacity(text.len() + replacement.len());
    new_text.push_str(&text[..range_start]);
    new_text.push_str(&replacement);
    new_text.push_str(&text[range_end..]);
    EditResult {
        new_text,
        new_selection_start: range_start,
        new_selection_length: replacement.len(),
    }
}

fn heading_hash_count(line: &str) -> usize {
    let count = line.bytes().take_while(|byte| *byte == b'#').count();
    if (1..=3).contains(&count) && line.as_bytes().get(count) == Some(&b' ') {
        count
    } else {
        0
    }
}

fn insert_snippet(
    text: &str,
    start: usize,
    snippet: &str,
    selection_start: usize,
    selection_length: usize,
) -> EditResult {
    replace_selection(
        text,
        start,
        start,
        snippet,
        selection_start,
        selection_length,
    )
}

fn replace_selection(
    text: &str,
    start: usize,
    end: usize,
    replacement: &str,
    selection_start: usize,
    selection_length: usize,
) -> EditResult {
    let mut new_text = String::with_capacity(text.len() - (end - start) + replacement.len());
    new_text.push_str(&text[..start]);
    new_text.push_str(replacement);
    new_text.push_str(&text[end..]);
    EditResult {
        new_text,
        new_selection_start: selection_start,
        new_selection_length: selection_length,
    }
}

fn insertion_newline_prefix(text: &str, start: usize) -> &'static str {
    if start == 0 || text[..start].ends_with("\n\n") {
        ""
    } else if text[..start].ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    }
}

fn insertion_newline_suffix(text: &str, end: usize) -> &'static str {
    if end == text.len() || text[end..].starts_with("\n\n") {
        ""
    } else if text[end..].starts_with('\n') {
        "\n"
    } else {
        "\n\n"
    }
}

fn table_insertion_newline_suffix(text: &str, end: usize) -> &'static str {
    if end == text.len() || text[end..].starts_with('\n') {
        ""
    } else {
        "\n"
    }
}

fn clamp_to_char_boundary(text: &str, mut offset: usize) -> usize {
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_wrap_inserts_empty_pair_without_selection() {
        assert_eq!(
            EditResult {
                new_text: "a****b".to_string(),
                new_selection_start: 3,
                new_selection_length: 0
            },
            toggle_wrap("ab", 1, 0, "**")
        );
    }

    #[test]
    fn toggle_wrap_wraps_and_unwraps_selection() {
        let wrapped = toggle_wrap("hello", 0, 5, "**");
        assert_eq!("**hello**", wrapped.new_text);
        assert_eq!(2, wrapped.new_selection_start);
        assert_eq!(5, wrapped.new_selection_length);

        let unwrapped = toggle_wrap(&wrapped.new_text, 2, 5, "**");
        assert_eq!("hello", unwrapped.new_text);
        assert_eq!(0, unwrapped.new_selection_start);
        assert_eq!(5, unwrapped.new_selection_length);
    }

    #[test]
    fn toggle_wrap_clamps_boundaries() {
        assert_eq!("hi****", toggle_wrap("hi", 99, 10, "**").new_text);
        assert_eq!("****é", toggle_wrap("é", 1, 0, "**").new_text);
    }

    #[test]
    fn toggle_line_prefix_adds_to_touched_non_blank_lines() {
        let result = toggle_line_prefix("a\n\nb", 0, 4, "- ");

        assert_eq!("- a\n\n- b", result.new_text);
        assert_eq!(0, result.new_selection_start);
        assert_eq!(8, result.new_selection_length);
    }

    #[test]
    fn toggle_line_prefix_removes_when_all_non_blank_lines_have_prefix() {
        let result = toggle_line_prefix("- a\n\n- b", 0, 8, "- ");

        assert_eq!("a\n\nb", result.new_text);
        assert_eq!(0, result.new_selection_start);
        assert_eq!(4, result.new_selection_length);
    }

    #[test]
    fn toggle_line_prefix_preserves_crlf() {
        let result = toggle_line_prefix("a\r\nb\r\n", 0, 4, "> ");

        assert_eq!("> a\r\n> b\r\n", result.new_text);
    }

    #[test]
    fn toggle_line_prefix_at_empty_text() {
        let result = toggle_line_prefix("", 0, 0, "- ");

        assert_eq!("", result.new_text);
        assert_eq!(0, result.new_selection_start);
    }

    #[test]
    fn toggle_numbered_list_prefix_adds_auto_numbers() {
        let result = toggle_numbered_list_prefix("a\nb", 0, 3);

        assert_eq!("1. a\n2. b", result.new_text);
    }

    #[test]
    fn toggle_numbered_list_prefix_removes_any_numbers() {
        let result = toggle_numbered_list_prefix("12. a\n3. b", 0, 10);

        assert_eq!("a\nb", result.new_text);
    }

    #[test]
    fn toggle_numbered_list_prefix_preserves_blank_lines_and_crlf() {
        let result = toggle_numbered_list_prefix("a\r\n\r\nb", 0, 6);

        assert_eq!("1. a\r\n\r\n2. b", result.new_text);
    }

    #[test]
    fn cycle_heading_cycles_current_line() {
        assert_eq!("# Title", cycle_heading("Title", 0, 0).new_text);
        assert_eq!("## Title", cycle_heading("# Title", 0, 0).new_text);
        assert_eq!("### Title", cycle_heading("## Title", 0, 0).new_text);
        assert_eq!("Title", cycle_heading("### Title", 0, 0).new_text);
    }

    #[test]
    fn cycle_heading_only_changes_current_line() {
        let result = cycle_heading("A\nB\nC", 2, 0);

        assert_eq!("A\n# B\nC", result.new_text);
        assert_eq!(4, result.new_selection_start); // cursor moved by # + space
        assert_eq!(0, result.new_selection_length);
    }

    #[test]
    fn insert_image_without_selection_selects_alt_text() {
        let result = insert_image("", 0, 0);

        assert_eq!("![alt](pfad)", result.new_text);
        assert_eq!(2, result.new_selection_start);
        assert_eq!(3, result.new_selection_length);
    }

    #[test]
    fn insert_image_with_selection_uses_selection_as_alt_text() {
        let result = insert_image("cat", 0, 3);

        assert_eq!("![cat](pfad)", result.new_text);
        assert_eq!(2, result.new_selection_start);
        assert_eq!(3, result.new_selection_length);
    }

    #[test]
    fn insert_table_adds_block_and_selects_first_header() {
        let result = insert_table("before", 6, 0);

        assert_eq!(
            "before\n\n| Spalte 1 | Spalte 2 | Spalte 3 |\n|---|---|---|\n|   |   |   |",
            result.new_text
        );
        assert_eq!(10, result.new_selection_start);
        assert_eq!(8, result.new_selection_length);
    }

    #[test]
    fn insert_table_replaces_selection() {
        let result = insert_table("before\nselected\nafter", 7, 8);
        let expected =
            "before\n\n| Spalte 1 | Spalte 2 | Spalte 3 |\n|---|---|---|\n|   |   |   |\nafter";
        assert_eq!(expected, result.new_text);
    }

    #[test]
    fn insert_link_without_selection_selects_text_placeholder() {
        let result = insert_link("", 0, 0);

        assert_eq!("[text](url)", result.new_text);
        assert_eq!(1, result.new_selection_start);
        assert_eq!(4, result.new_selection_length);
    }

    #[test]
    fn insert_link_with_selection_uses_text() {
        let result = insert_link("site", 0, 4);

        assert_eq!("[site](url)", result.new_text);
        assert_eq!(1, result.new_selection_start);
        assert_eq!(4, result.new_selection_length);
    }

    #[test]
    fn insert_code_block_without_selection_cursor_in_empty_line() {
        let result = insert_code_block("", 0, 0);

        assert_eq!("```\n\n```", result.new_text);
        assert_eq!(4, result.new_selection_start);
        assert_eq!(0, result.new_selection_length);
    }

    #[test]
    fn insert_code_block_wraps_selection_and_adds_spacing() {
        let result = insert_code_block("before\ncode\nafter", 7, 4);

        assert_eq!("before\n\n```\ncode\n```\n\nafter", result.new_text);
        assert_eq!(12, result.new_selection_start);
        assert_eq!(4, result.new_selection_length);
    }

    #[test]
    fn insert_code_block_toggles_off_existing_fences() {
        let wrapped = insert_code_block("before\ncode\nafter", 7, 4);
        let unwrapped = insert_code_block(
            &wrapped.new_text,
            wrapped.new_selection_start,
            wrapped.new_selection_length,
        );
        assert_eq!("before\n\ncode\n\nafter", unwrapped.new_text);
        assert_eq!("code", &unwrapped.new_text[unwrapped.new_selection_start
            ..unwrapped.new_selection_start + unwrapped.new_selection_length]);
    }

    #[test]
    fn helper_line_bounds_handle_crlf_and_boundaries() {
        let text = "a\r\nb";

        assert_eq!(3, line_start_of(text, 4));
        assert_eq!(1, line_end_of(text, 0));
        assert_eq!("a", trim_eol("a\r\n"));
        assert_eq!(vec!["a\r\n", "b"], split_keep_endings(text));
        assert_eq!(4, numbered_prefix_length("12. item"));
        assert_eq!(0, numbered_prefix_length("12.item"));
    }
}
