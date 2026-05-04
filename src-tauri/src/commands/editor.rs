use crate::{editor_commands, state::AppState};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EditResult {
    pub new_text: String,
    pub new_selection_start: usize,
    pub new_selection_length: usize,
}

impl From<editor_commands::EditResult> for EditResult {
    fn from(value: editor_commands::EditResult) -> Self {
        Self {
            new_text: value.new_text,
            new_selection_start: value.new_selection_start,
            new_selection_length: value.new_selection_length,
        }
    }
}

#[tauri::command]
pub async fn editor_text_changed(text: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .update_text(text);
    Ok(())
}

#[tauri::command]
pub async fn editor_save_requested(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .save()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn apply_editor_command(
    command: String,
    text: String,
    start: usize,
    length: usize,
    _state: State<'_, AppState>,
) -> Result<EditResult, String> {
    apply_command(&command, &text, start, length)
}

#[tauri::command]
pub async fn editor_ready(handle: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state
        .automation
        .lock()
        .map_err(|_| "automation state lock poisoned".to_string())?
        .editor_ready = true;
    handle
        .emit("editor:ready", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn editor_selection(
    start: usize,
    length: usize,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut automation = state
            .automation
            .lock()
            .map_err(|_| "automation state lock poisoned".to_string())?;
        automation.selection_start = start;
        automation.selection_length = length;
    }
    handle
        .emit(
            "editor:selection",
            serde_json::json!({ "start": start, "length": length }),
        )
        .map_err(|error| error.to_string())
}

pub fn apply_command(
    command: &str,
    text: &str,
    start: usize,
    length: usize,
) -> Result<EditResult, String> {
    let result = match command {
        "bold" => editor_commands::toggle_wrap(text, start, length, "**"),
        "italic" => editor_commands::toggle_wrap(text, start, length, "*"),
        "bullet" => editor_commands::toggle_line_prefix(text, start, length, "- "),
        "numbered" => editor_commands::toggle_numbered_list_prefix(text, start, length),
        "heading" => editor_commands::cycle_heading(text, start, length),
        "link" => editor_commands::insert_link(text, start, length),
        "image" => editor_commands::insert_image(text, start, length),
        "table" => editor_commands::insert_table(text, start, length),
        "code" => editor_commands::toggle_wrap(text, start, length, "`"),
        "codeblock" => editor_commands::insert_code_block(text, start, length),
        _ => return Err(format!("unknown editor command: {command}")),
    };
    Ok(result.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_bold_command() {
        assert_eq!(
            "**hi**",
            apply_command("bold", "hi", 0, 2).unwrap().new_text
        );
    }

    #[test]
    fn applies_heading_command() {
        assert_eq!(
            "# Title",
            apply_command("heading", "Title", 0, 0).unwrap().new_text
        );
    }

    #[test]
    fn unknown_command_returns_error() {
        assert!(apply_command("missing", "", 0, 0).is_err());
    }

    #[test]
    fn edit_result_converts_from_core_type() {
        let result: EditResult = editor_commands::EditResult {
            new_text: "x".into(),
            new_selection_start: 1,
            new_selection_length: 0,
        }
        .into();
        assert_eq!("x", result.new_text);
    }
}
