use folio_rs::editor_commands::{
    cycle_heading, insert_link, insert_table, toggle_wrap, EditResult,
};

#[test]
fn formatting_sequence_updates_text_and_selection() {
    let bold = toggle_wrap("hello world", 0, "hello world".len(), "**");
    assert_edit(&bold, "**hello world**", 2, 11);

    let italic = toggle_wrap(&bold.new_text, 0, bold.new_text.len(), "*");
    assert_edit(&italic, "***hello world***", 1, 15);

    let heading = cycle_heading(
        &italic.new_text,
        italic.new_selection_start,
        italic.new_selection_length,
    );
    assert_edit(&heading, "# ***hello world***", 3, 15);

    let heading = cycle_heading(
        &heading.new_text,
        heading.new_selection_start,
        heading.new_selection_length,
    );
    assert_edit(&heading, "## ***hello world***", 4, 15);
}

#[test]
fn insert_link_uses_placeholder_and_selects_link_text() {
    let result = insert_link("## ***hello world***", "## ***hello world***".len(), 0);

    assert_eq!("## ***hello world***[text](url)", result.new_text);
    assert_eq!(21, result.new_selection_start);
    assert_eq!(4, result.new_selection_length);
}

#[test]
fn insert_link_preserves_selected_text_and_cursor_range() {
    let result = insert_link("open target", 5, 6);

    assert_eq!("open [target](url)", result.new_text);
    assert_eq!(6, result.new_selection_start);
    assert_eq!(6, result.new_selection_length);
}

#[test]
fn insert_table_adds_three_column_german_header_and_selects_first_header() {
    let result = insert_table("## ***hello world***", "## ***hello world***".len(), 0);

    assert!(result
        .new_text
        .contains("| Spalte 1 | Spalte 2 | Spalte 3 |"));
    assert!(result.new_text.contains("|---|---|---|"));
    assert_eq!(24, result.new_selection_start);
    assert_eq!(8, result.new_selection_length);
}

#[test]
fn table_insert_replaces_selection_with_block() {
    let result = insert_table("before\nreplace\nafter", 7, 7);

    assert_eq!(
        "before\n\n| Spalte 1 | Spalte 2 | Spalte 3 |\n|---|---|---|\n|   |   |   |\nafter",
        result.new_text
    );
    assert_eq!(10, result.new_selection_start);
    assert_eq!(8, result.new_selection_length);
}

fn assert_edit(result: &EditResult, text: &str, selection_start: usize, selection_length: usize) {
    assert_eq!(text, result.new_text);
    assert_eq!(selection_start, result.new_selection_start);
    assert_eq!(selection_length, result.new_selection_length);
}
