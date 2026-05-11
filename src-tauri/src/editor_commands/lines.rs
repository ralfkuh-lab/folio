use super::util::{
    clamp_range, heading_hash_count, line_end_of, line_start_of, numbered_prefix_length,
    replace_lines, split_keep_endings, touched_line_range, trim_eol,
};
use super::EditResult;

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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(4, result.new_selection_start);
        assert_eq!(0, result.new_selection_length);
    }
}
