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
    emit_vault_refresh(&state, &handle)
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
    emit_vault_refresh(&state, &handle)
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
    emit_vault_refresh(&state, &handle)
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
    emit_vault_refresh(&state, &handle)
}

#[tauri::command]
pub async fn workspace_get(state: State<'_, AppState>) -> Result<WorkspaceData, String> {
    Ok(state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .data())
}

fn emit_vault_refresh(state: &State<'_, AppState>, handle: &AppHandle) -> Result<(), String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    let delta = vault.compute_refresh_delta(&workspace);
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
}
