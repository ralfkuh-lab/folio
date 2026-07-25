use crate::{state::AppState, workspace::WorkspaceData};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn workspace_pin(
    path: String,
    is_directory: bool,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .pin(path, is_directory)
        .map_err(|error| error.to_string())?;
    // Pin-Aenderung verschiebt den Wikilink-Suchraum.
    state.invalidate_wikilink_index();
    sync_git_head_watcher(state.inner());
    emit_vault_refresh(state.inner(), &handle)
}

#[tauri::command]
pub async fn workspace_unpin(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .unpin(&path)
        .map_err(|error| error.to_string())?;
    // Pin-Aenderung verschiebt den Wikilink-Suchraum.
    state.invalidate_wikilink_index();
    sync_git_head_watcher(state.inner());
    emit_vault_refresh(state.inner(), &handle)
}

#[tauri::command]
pub async fn workspace_reorder_pinned(
    paths: Vec<String>,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .reorder_pinned(paths)
        .map_err(|error| error.to_string())?;
    // Pin-Aenderung verschiebt den Wikilink-Suchraum.
    state.invalidate_wikilink_index();
    emit_vault_refresh(state.inner(), &handle)
}

#[tauri::command]
pub async fn workspace_add_recent(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .add_recent(path)
        .map_err(|error| error.to_string())?;
    crate::menu::refresh_recent_from_workspace(&handle);
    emit_vault_refresh(state.inner(), &handle)
}

#[tauri::command]
pub async fn workspace_remove_recent(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .remove_recent(&path)
        .map_err(|error| error.to_string())?;
    crate::menu::refresh_recent_from_workspace(&handle);
    emit_vault_refresh(state.inner(), &handle)
}

#[tauri::command]
pub async fn workspace_get(state: State<'_, AppState>) -> Result<WorkspaceData, String> {
    Ok(state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .data())
}

/// Liefert das fuer `doc_path` zuletzt verwendete Image-Speicherverzeichnis,
/// falls eines gemerkt ist. Frontend nutzt das als Default beim Oeffnen
/// des Image-Dialogs.
#[tauri::command]
pub async fn workspace_get_image_dir(
    doc_path: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .image_dir(&doc_path)
        .map(str::to_string))
}

/// Merkt `dir` als zuletzt fuer `doc_path` gewaehltes Image-Verzeichnis.
/// Wird vom Image-Dialog nach erfolgreichem Einfuegen gerufen.
#[tauri::command]
pub async fn workspace_set_image_dir(
    doc_path: String,
    dir: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .set_image_dir(doc_path, dir)
        .map_err(|error| error.to_string())
}

pub(crate) fn sync_git_head_watcher(state: &AppState) {
    // Sammelt die Head-Dirs aller gepinnten Git-Roots und synct den
    // GitHeadWatcher. Der Watcher selbst ist bei disabled ein No-op,
    // Aufrufer duerfen also bedingungslos syncen (settings schaltet
    // vorher explizit set_enabled).
    let gitdirs: Vec<std::path::PathBuf> = state
        .workspace
        .lock()
        .map(|ws| {
            ws.pinned()
                .iter()
                .filter_map(|item| {
                    if item.is_directory {
                        crate::git_branch::head_dir(std::path::Path::new(&item.path))
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    if let Ok(mut w) = state.git_head_watcher.lock() {
        let _ = w.sync(gitdirs);
    }
}

pub(crate) fn emit_vault_refresh(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let delta = crate::commands::vault_cmd::compute_refresh_delta_synced(state, &workspace)?;
    handle
        .emit("vault:refresh", delta)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use crate::workspace::Workspace;
    use tempfile::TempDir;

    #[test]
    fn pin_command_logic_is_backed_by_workspace() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/a".into(), false).unwrap();
        assert!(workspace.is_pinned("/a"));
    }

    #[test]
    fn unpin_command_logic_is_backed_by_workspace() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/a".into(), false).unwrap();
        workspace.unpin("/a").unwrap();
        assert!(!workspace.is_pinned("/a"));
    }

    #[test]
    fn workspace_get_returns_cloneable_data() {
        let temp = TempDir::new().unwrap();
        let workspace = Workspace::load_from(temp.path().join("workspace.json"));
        assert!(workspace.data().pinned.is_empty());
    }

    #[test]
    fn reorder_command_logic_is_backed_by_workspace() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/a".into(), true).unwrap();
        workspace.pin("/b".into(), false).unwrap();
        workspace
            .reorder_pinned(vec!["/b".into(), "/a".into()])
            .unwrap();
        let pinned = workspace.pinned();
        assert_eq!(pinned[0].path, "/b");
        assert_eq!(pinned[1].path, "/a");
    }
}
