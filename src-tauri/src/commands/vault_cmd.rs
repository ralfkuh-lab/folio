use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn vault_expand_dir(path: String, state: State<'_, AppState>) -> Result<String, String> {
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .on_expand(path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vault_collapse_dir(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .on_collapse(&path);
    Ok(())
}

#[tauri::command]
pub async fn vault_toggle_section(
    section: String,
    expanded: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_section_expanded(&section, expanded)
        .map_err(|error| error.to_string())?;
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .on_section_toggle(&section, expanded);
    Ok(())
}

#[tauri::command]
pub async fn vault_build_tree(state: State<'_, AppState>) -> Result<String, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    let panel = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data();
    Ok(
        vault.build_initial_tree_html_with(
            &workspace,
            panel.pinned_expanded,
            panel.recent_expanded,
        ),
    )
}

#[tauri::command]
pub async fn rail_resize(
    side: String,
    width: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_rail_width(&side, width)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn context(path: String, x: f64, y: f64, handle: AppHandle) -> Result<(), String> {
    handle
        .emit(
            "vault:context",
            serde_json::json!({ "path": path, "x": x, "y": y }),
        )
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use crate::{vault::Vault, workspace::Workspace};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn expand_returns_child_html() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("a.md"), "").unwrap();
        let mut vault = Vault::new();
        let html = vault
            .on_expand(temp.path().to_str().unwrap().to_string())
            .unwrap();
        assert!(html.contains("a.md"));
    }

    #[test]
    fn collapse_removes_expanded_state() {
        let temp = TempDir::new().unwrap();
        let mut vault = Vault::new();
        vault
            .on_expand(temp.path().to_str().unwrap().to_string())
            .unwrap();
        vault.on_collapse(temp.path().to_str().unwrap());
        assert!(!vault.is_expanded(temp.path().to_str().unwrap()));
    }

    #[test]
    fn build_tree_uses_workspace() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/tmp/a.md".into(), false).unwrap();
        assert!(Vault::new()
            .build_initial_tree_html(&workspace)
            .contains("a.md"));
    }
}
