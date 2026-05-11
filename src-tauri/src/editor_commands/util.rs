use super::EditResult;

pub(super) fn line_start_of(text: &str, offset: usize) -> usize {
    let offset = clamp_to_char_boundary(text, offset.min(text.len()));
    text[..offset].rfind('\n').map_or(0, |index| index + 1)
}

pub(super) fn line_end_of(text: &str, offset: usize) -> usize {
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

pub(super) fn trim_eol(s: &str) -> &str {
    s.trim_end_matches(['\n', '\r'])
}

pub(super) fn split_keep_endings(s: &str) -> Vec<&str> {
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

pub(super) fn clamp_range(text: &str, start: &mut usize, length: &mut usize) {
    *start = clamp_to_char_boundary(text, (*start).min(text.len()));
    let requested_end = start.saturating_add(*length).min(text.len());
    let end = clamp_to_char_boundary(text, requested_end);
    *length = end.saturating_sub(*start);
}

pub(super) fn numbered_prefix_length(s: &str) -> usize {
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

pub(super) fn touched_line_range(text: &str, start: usize, length: usize) -> (usize, usize) {
    let range_start = line_start_of(text, start);
    let mut touched_end = start + length;
    if length > 0 && touched_end > start && text[..touched_end].ends_with('\n') {
        touched_end -= 1;
    }
    (range_start, line_end_of(text, touched_end))
}

pub(super) fn replace_lines(
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

pub(super) fn heading_hash_count(line: &str) -> usize {
    let count = line.bytes().take_while(|byte| *byte == b'#').count();
    if (1..=3).contains(&count) && line.as_bytes().get(count) == Some(&b' ') {
        count
    } else {
        0
    }
}

pub(super) fn insert_snippet(
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

pub(super) fn replace_selection(
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

pub(super) fn insertion_newline_prefix(text: &str, start: usize) -> &'static str {
    if start == 0 || text[..start].ends_with("\n\n") {
        ""
    } else if text[..start].ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    }
}

pub(super) fn insertion_newline_suffix(text: &str, end: usize) -> &'static str {
    if end == text.len() || text[end..].starts_with("\n\n") {
        ""
    } else if text[end..].starts_with('\n') {
        "\n"
    } else {
        "\n\n"
    }
}

pub(super) fn table_insertion_newline_suffix(text: &str, end: usize) -> &'static str {
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
