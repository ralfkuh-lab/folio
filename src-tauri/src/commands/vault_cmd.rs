use crate::state::AppState;
use crate::vault_filter::{run_vault_filter, VaultFilterOptions};
use crate::workspace::Workspace;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Liest `panel_state.vault_filter_markdown_only` und setzt den
/// Vault-Spiegel. Lock-Reihenfolge: panel_state lesen und fallen lassen,
/// DANN vault. Vor jedem `compute_refresh_delta` / Lazy-Render aufrufen.
#[allow(dead_code)] // public API for call sites; may be used without delta
pub(crate) fn sync_vault_markdown_only(state: &AppState) -> Result<(), String> {
    let markdown_only = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .vault_filter_markdown_only;
    let mut vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    vault.set_markdown_only(markdown_only);
    Ok(())
}

/// Sync + `compute_refresh_delta` unter einem Vault-Lock (nach freiem
/// Panel-Read). Workspace muss bereits gelockt/übergeben sein.
pub(crate) fn compute_refresh_delta_synced(
    state: &AppState,
    workspace: &Workspace,
) -> Result<crate::vault::VaultRefreshDelta, String> {
    let markdown_only = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .vault_filter_markdown_only;
    let mut vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    vault.set_markdown_only(markdown_only);
    Ok(vault.compute_refresh_delta(workspace))
}

// Hinweis: vault_expand_dir/vault_collapse_dir als Tauri-Commands sind
// entfernt — sie mutierten nur expanded_dirs OHNE VaultWatcher-Sync und
// hatten nur noch einen toten Frontend-Aufrufer. Expand/Collapse laeuft
// ausschliesslich ueber die shell-Events `expand-dir`/`collapse-dir`
// (commands/events/vault.rs), die Vault-State und Watcher symmetrisch
// halten.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFilterResponse {
    pub html: String,
    pub truncated: bool,
    pub node_count: usize,
    pub run_id: u64,
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
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vault_build_tree(state: State<'_, AppState>) -> Result<String, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let panel = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data();
    let mut vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    vault.set_markdown_only(panel.vault_filter_markdown_only);
    Ok(
        vault.build_initial_tree_html_with(
            &workspace,
            panel.pinned_expanded,
            panel.recent_expanded,
        ),
    )
}

/// Filter-Render-Modus: gestutzter, voll aufgeklappter Pin-Baum.
/// `runId` wird als Echo zurückgegeben (Frontend-Stale-Guard).
#[tauri::command]
pub async fn vault_filter(
    query: String,
    markdown_only: bool,
    match_files: bool,
    match_dirs: bool,
    run_id: u64,
    state: State<'_, AppState>,
) -> Result<VaultFilterResponse, String> {
    let pinned = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .pinned()
        .to_vec();
    let vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    let opts = VaultFilterOptions {
        query,
        markdown_only,
        match_files,
        match_dirs,
    };
    let result = run_vault_filter(&pinned, &vault, &opts);
    Ok(VaultFilterResponse {
        html: result.html,
        truncated: result.truncated,
        node_count: result.node_count,
        run_id,
    })
}

#[tauri::command]
pub async fn vault_filter_options_get(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data();
    Ok(serde_json::json!({
        "markdownOnly": data.vault_filter_markdown_only,
        "barVisible": data.vault_filter_bar_visible,
        "matchFiles": data.vault_filter_match_files,
        "matchDirs": data.vault_filter_match_dirs,
    }))
}

#[tauri::command]
pub async fn vault_filter_options_set(
    markdown_only: bool,
    bar_visible: bool,
    match_files: bool,
    match_dirs: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_vault_filter_options(markdown_only, bar_visible, match_files, match_dirs)
        .map_err(|error| error.to_string())?;
    // Lazy-Tree-Spiegel: poisoned Vault-Lock ist Fehler (FX4), nicht still.
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .set_markdown_only(markdown_only);
    Ok(())
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
        let _ = crate::i18n::set_process_translator(crate::i18n::Translator::new(
            crate::i18n::load_embedded_registry(),
            crate::i18n::ResolvedLanguage {
                catalog_tag: "de".into(),
                format_locale: "de-DE".into(),
            },
        ));
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/tmp/a.md".into(), false).unwrap();
        assert!(Vault::new()
            .build_initial_tree_html(&workspace)
            .contains("a.md"));
    }
}
