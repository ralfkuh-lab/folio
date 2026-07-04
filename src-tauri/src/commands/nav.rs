use crate::{document_service, navigation::Entry, state::AppState};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavEntry {
    pub path: String,
    pub anchor: Option<String>,
    pub scroll_y: f64,
    pub view_mode: String,
    pub editor_scroll_y: f64,
    pub editor_cursor: usize,
}

impl From<&Entry> for NavEntry {
    fn from(entry: &Entry) -> Self {
        // Kind-abhaengiges Clamping (Markdown/HTML behalten, Image ->
        // "view", Rest -> "edit") liegt zentral in document_service.
        let view_mode = document_service::history_view_mode(&entry.absolute_path, &entry.view_mode);
        Self {
            path: entry.absolute_path.clone(),
            anchor: entry.anchor.clone(),
            scroll_y: entry.scroll_y,
            view_mode,
            editor_scroll_y: entry.editor_scroll_y,
            editor_cursor: entry.editor_cursor,
        }
    }
}

#[tauri::command]
pub async fn navigate(
    path: String,
    anchor: Option<String>,
    state: State<'_, AppState>,
) -> Result<NavEntry, String> {
    let mut tabs = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?;
    Ok(NavEntry::from(
        tabs.active_mut().navigation.navigate(path, anchor),
    ))
}

#[tauri::command]
pub async fn go_back(state: State<'_, AppState>) -> Result<Option<NavEntry>, String> {
    move_history(false, &state, None)
}

#[tauri::command]
pub async fn go_forward(state: State<'_, AppState>) -> Result<Option<NavEntry>, String> {
    move_history(true, &state, None)
}

#[tauri::command]
pub async fn go_back_and_emit(
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<NavEntry>, String> {
    move_history(false, &state, Some(handle))
}

#[tauri::command]
pub async fn go_forward_and_emit(
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<NavEntry>, String> {
    move_history(true, &state, Some(handle))
}

#[tauri::command]
pub async fn update_scroll(y: f64, state: State<'_, AppState>) -> Result<(), String> {
    state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?
        .active_mut()
        .navigation
        .update_scroll_position(y);
    Ok(())
}

#[tauri::command]
pub async fn update_history_view_mode(
    mode: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?
        .active_mut()
        .navigation
        .update_view_mode(mode);
    Ok(())
}

#[tauri::command]
pub async fn update_history_editor_scroll(
    y: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?
        .active_mut()
        .navigation
        .update_editor_scroll(y);
    Ok(())
}

#[tauri::command]
pub async fn update_history_editor_cursor(
    cursor: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?
        .active_mut()
        .navigation
        .update_editor_cursor(cursor);
    Ok(())
}

fn move_history(
    forward: bool,
    state: &AppState,
    handle: Option<AppHandle>,
) -> Result<Option<NavEntry>, String> {
    let entry = document_service::move_history(&state.tabs, &state.vault, forward)
        .map_err(|error| error.to_string())?;

    let Some(entry) = entry.as_ref().map(NavEntry::from) else {
        return Ok(None);
    };

    if let Some(handle) = handle {
        handle
            .emit("navigation:changed", &entry)
            .map_err(|error| error.to_string())?;
    }

    Ok(Some(entry))
}

#[tauri::command]
pub async fn visible_heading(anchor: String, handle: AppHandle) -> Result<(), String> {
    handle
        .emit(
            "navigation:heading_changed",
            serde_json::json!({ "anchor": anchor }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn scroll_position(y: f64, state: State<'_, AppState>) -> Result<(), String> {
    update_scroll(y, state).await
}

#[tauri::command]
pub async fn toc_click(anchor: String, handle: AppHandle) -> Result<(), String> {
    handle
        .emit(
            "navigation:toc_click",
            serde_json::json!({ "anchor": anchor }),
        )
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::navigation::NavigationController;

    #[test]
    fn nav_entry_maps_from_navigation_entry() {
        let entry = Entry {
            absolute_path: "/a".into(),
            anchor: Some("x".into()),
            scroll_y: 1.5,
            view_mode: "edit".into(),
            editor_scroll_y: 12.0,
            editor_cursor: 7,
        };
        assert_eq!(
            NavEntry {
                path: "/a".into(),
                anchor: Some("x".into()),
                scroll_y: 1.5,
                view_mode: "edit".into(),
                editor_scroll_y: 12.0,
                editor_cursor: 7,
            },
            NavEntry::from(&entry)
        );
    }

    #[test]
    fn nav_entry_clamps_view_mode_to_edit_for_non_markdown() {
        let entry = Entry {
            absolute_path: "/notes.txt".into(),
            anchor: None,
            scroll_y: 0.0,
            view_mode: "view".into(),
            editor_scroll_y: 0.0,
            editor_cursor: 0,
        };
        assert_eq!("edit", NavEntry::from(&entry).view_mode);
    }

    #[test]
    fn nav_entry_forces_view_mode_for_images() {
        let entry = Entry {
            absolute_path: "/pic.png".into(),
            anchor: None,
            scroll_y: 0.0,
            view_mode: "edit".into(),
            editor_scroll_y: 0.0,
            editor_cursor: 0,
        };
        assert_eq!("view", NavEntry::from(&entry).view_mode);
    }

    #[test]
    fn nav_entry_preserves_view_mode_for_html() {
        let entry = Entry {
            absolute_path: "/page.html".into(),
            anchor: None,
            scroll_y: 0.0,
            view_mode: "view".into(),
            editor_scroll_y: 0.0,
            editor_cursor: 0,
        };
        assert_eq!("view", NavEntry::from(&entry).view_mode);
    }

    #[test]
    fn nav_entry_preserves_view_mode_for_markdown() {
        let entry = Entry {
            absolute_path: "/notes.md".into(),
            anchor: None,
            scroll_y: 0.0,
            view_mode: "split".into(),
            editor_scroll_y: 0.0,
            editor_cursor: 0,
        };
        assert_eq!("split", NavEntry::from(&entry).view_mode);
    }

    #[test]
    fn navigation_controller_updates_scroll_for_current() {
        let mut nav = NavigationController::new();
        nav.navigate("/a", None);
        nav.update_scroll_position(10.0);
        assert_eq!(10.0, NavEntry::from(nav.current().unwrap()).scroll_y);
    }

    #[test]
    fn back_returns_previous_entry() {
        let mut nav = NavigationController::new();
        nav.navigate("/a", None);
        nav.navigate("/b", None);
        assert_eq!("/a", NavEntry::from(nav.go_back().unwrap()).path);
    }
}
