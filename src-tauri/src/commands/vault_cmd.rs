use crate::state::AppState;
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
// halten. Bulk-Ops: `vault_expand_roots` / `vault_collapse_all`.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExpandRootsResponse {
    pub html: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCollapseAllResponse {
    pub html: String,
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

/// Expandiert zugeklappte Pin-Wurzel-Ordner (erste Ebene). Watcher non-fatal.
#[tauri::command]
pub async fn vault_expand_roots(
    state: State<'_, AppState>,
) -> Result<VaultExpandRootsResponse, String> {
    let pin_dirs: Vec<String> = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .pinned()
        .iter()
        .filter(|p| p.is_directory)
        .map(|p| p.path.replace('\\', "/"))
        .collect();
    let markdown_only = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .vault_filter_markdown_only;
    let (paths, html) = {
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
        let paths = vault.expand_roots(&pin_dirs, markdown_only);
        vault.set_markdown_only(markdown_only);
        let html = vault.build_initial_tree_html_with(
            &workspace,
            panel.pinned_expanded,
            panel.recent_expanded,
        );
        (paths, html)
    };
    // Watcher non-fatal (wie expand-dir).
    if let Ok(mut watcher) = state.vault_watcher.lock() {
        for path in &paths {
            if let Err(err) = watcher.watch(path) {
                tracing::warn!(
                    target: "folio::vault",
                    path = %path,
                    error = %err,
                    "vault_expand_roots: vault_watcher.watch failed"
                );
            }
        }
    }
    Ok(VaultExpandRootsResponse { html })
}

/// Klappt alle Pin-Wurzeln zu, deregistriert Watches, rebuildet den Baum.
#[tauri::command]
pub async fn vault_collapse_all(
    state: State<'_, AppState>,
) -> Result<VaultCollapseAllResponse, String> {
    let html = {
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
        // on_collapse pro Pin-Wurzel (pruned expanded under each pin) + full clear.
        let pin_dirs: Vec<String> = workspace
            .pinned()
            .iter()
            .filter(|p| p.is_directory)
            .map(|p| p.path.replace('\\', "/"))
            .collect();
        for pin in &pin_dirs {
            vault.on_collapse(pin);
        }
        vault.collapse_all();
        vault.build_initial_tree_html_with(&workspace, panel.pinned_expanded, panel.recent_expanded)
    };
    if let Ok(mut watcher) = state.vault_watcher.lock() {
        watcher.unwatch_all();
    }
    Ok(VaultCollapseAllResponse { html })
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
    }))
}

#[tauri::command]
pub async fn vault_filter_options_set(
    markdown_only: bool,
    bar_visible: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_vault_filter_options(markdown_only, bar_visible)
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
