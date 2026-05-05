use crate::{link_interceptor::LinkAction, navigation::Entry, state::AppState};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NavEntry {
    pub path: String,
    pub anchor: Option<String>,
    pub scroll_y: f64,
}

impl From<&Entry> for NavEntry {
    fn from(entry: &Entry) -> Self {
        Self {
            path: entry.absolute_path.clone(),
            anchor: entry.anchor.clone(),
            scroll_y: entry.scroll_y,
        }
    }
}

#[tauri::command]
pub async fn navigate(
    path: String,
    anchor: Option<String>,
    state: State<'_, AppState>,
) -> Result<NavEntry, String> {
    let mut navigation = state
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?;
    Ok(NavEntry::from(navigation.navigate(path, anchor)))
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
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?
        .update_scroll_position(y);
    Ok(())
}

fn move_history(
    forward: bool,
    state: &AppState,
    handle: Option<AppHandle>,
) -> Result<Option<NavEntry>, String> {
    let entry = {
        let mut navigation = state
            .navigation
            .lock()
            .map_err(|_| "navigation lock poisoned".to_string())?;
        if forward {
            navigation.go_forward().map(NavEntry::from)
        } else {
            navigation.go_back().map(NavEntry::from)
        }
    };

    let Some(entry) = entry else {
        return Ok(None);
    };

    state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .load(&entry.path)
        .map_err(|error| error.to_string())?;
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .set_active(Some(entry.path.clone()));

    if let Some(handle) = handle {
        handle
            .emit("navigation:changed", &entry)
            .map_err(|error| error.to_string())?;
    }

    Ok(Some(entry))
}

#[tauri::command]
pub async fn link_click(
    href: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<NavEntry>, String> {
    let current_file = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .path
        .clone();
    match state
        .link_interceptor
        .handle(&href, current_file.as_deref())
    {
        LinkAction::OpenExternal(target) => {
            #[allow(deprecated)]
            handle
                .shell()
                .open(target, None)
                .map_err(|error| error.to_string())?;
            Ok(None)
        }
        LinkAction::Navigate { path, anchor } => {
            let mut navigation = state
                .navigation
                .lock()
                .map_err(|_| "navigation lock poisoned".to_string())?;
            let entry = NavEntry::from(navigation.navigate(path, anchor));
            handle
                .emit("navigation:changed", &entry)
                .map_err(|error| error.to_string())?;
            Ok(Some(entry))
        }
        LinkAction::Missing => Ok(None),
    }
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
        };
        assert_eq!(
            NavEntry {
                path: "/a".into(),
                anchor: Some("x".into()),
                scroll_y: 1.5
            },
            NavEntry::from(&entry)
        );
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
