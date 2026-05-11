use super::util::{clamp_range, insert_snippet, replace_selection};
use super::EditResult;

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
}
