use super::util::{
    clamp_range, insertion_newline_prefix, insertion_newline_suffix, replace_selection,
    table_insertion_newline_suffix,
};
use super::EditResult;

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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            "code",
            &unwrapped.new_text[unwrapped.new_selection_start
                ..unwrapped.new_selection_start + unwrapped.new_selection_length]
        );
    }
}
