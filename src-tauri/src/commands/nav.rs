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
        Self::from_kind(entry, None)
    }
}

impl NavEntry {
    pub(crate) fn from_kind(entry: &Entry, kind: Option<crate::file_kind::FileKind>) -> Self {
        // Kind-abhaengiges Clamping liegt zentral in document_service.
        // Mit Deskriptor (nach Load) nicht erneut klassifizieren.
        let view_mode = match kind {
            Some(kind) => document_service::history_view_mode_for_kind(
                kind,
                &entry.absolute_path,
                &entry.view_mode,
            ),
            None => document_service::history_view_mode(&entry.absolute_path, &entry.view_mode),
        };
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
    let tab = tabs.active_mut();
    let entry = tab.navigation.navigate(path, anchor).clone();
    Ok(NavEntry::from_kind(&entry, tab.document_store.kind()))
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
        .map_err(|error| error.user_message())?;

    let Some(raw) = entry.as_ref() else {
        return Ok(None);
    };
    let kind = state
        .tabs
        .lock()
        .ok()
        .and_then(|tabs| tabs.active().document_store.kind());
    let entry = NavEntry::from_kind(raw, kind);

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
            absolute_path: "/a.md".into(),
            anchor: Some("x".into()),
            scroll_y: 1.5,
            view_mode: "edit".into(),
            editor_scroll_y: 12.0,
            editor_cursor: 7,
        };
        assert_eq!(
            NavEntry {
                path: "/a.md".into(),
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
    fn navigate_builds_entry_from_store_kind() {
        use crate::document_store::DocumentStore;
        use crate::file_kind::FileKind;
        use std::fs;
        use tempfile::TempDir;

        let temp = TempDir::new().unwrap();
        let path = temp.path().join("INSTALL");
        fs::write(&path, b"hello\n").unwrap();
        let path = path.to_string_lossy().replace('\\', "/");
        let mut store = DocumentStore::new();
        store.load(&path).unwrap();
        assert_eq!(Some(FileKind::Text), store.kind());

        let mut nav = NavigationController::new();
        let entry = nav.navigate(path, None).clone();
        let mapped = NavEntry::from_kind(&entry, store.kind());
        assert_eq!("edit", mapped.view_mode);
        assert_eq!(
            "view",
            NavEntry::from(&entry).view_mode,
            "path classify stays the pending-only fallback"
        );
    }

    #[test]
    fn back_returns_previous_entry() {
        let mut nav = NavigationController::new();
        nav.navigate("/a", None);
        nav.navigate("/b", None);
        assert_eq!("/a", NavEntry::from(nav.go_back().unwrap()).path);
    }
}
