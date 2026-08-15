use crate::state::AppState;
use crate::vault::VaultListOptions;
use crate::workspace::Workspace;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Liest Listen-Optionen aus Panel-State + Settings (ohne Vault-Lock).
/// Lock-Reihenfolge: panel_state, dann settings.
pub(crate) fn read_vault_list_options(state: &AppState) -> Result<VaultListOptions, String> {
    let markdown_only = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .vault_filter_markdown_only;
    let show_hidden = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?
        .data()
        .vault_show_hidden;
    Ok(VaultListOptions {
        markdown_only,
        show_hidden,
    })
}

/// Liest `panel_state.vault_filter_markdown_only` und
/// `settings.vault_show_hidden` und setzt beide Vault-Spiegel.
/// Lock-Reihenfolge: panel_state, settings, DANN vault.
/// Vor jedem `compute_refresh_delta` / Lazy-Render aufrufen.
pub(crate) fn sync_vault_list_options(state: &AppState) -> Result<VaultListOptions, String> {
    let opts = read_vault_list_options(state)?;
    let mut vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    vault.set_list_options(opts);
    Ok(opts)
}

/// Pin-Verzeichnispfade (normalisiert) fuer Expand/Prune.
pub(crate) fn pin_directory_paths(workspace: &Workspace) -> Vec<String> {
    workspace
        .pinned()
        .iter()
        .filter(|item| item.is_directory)
        .map(|item| item.path.replace('\\', "/"))
        .collect()
}

/// Watcher-Abmeldung nach `prune_invisible_expanded`. Vault-Lock muss
/// bereits frei sein — nicht beide Locks gleichzeitig halten.
pub(crate) fn unwatch_pruned_paths(state: &AppState, paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut watcher) = state.vault_watcher.lock() {
        for path in paths {
            watcher.unwatch(path);
        }
    }
}

/// Sync + Prune + Unwatch + `compute_refresh_delta`. Workspace muss
/// bereits gelockt/übergeben sein. Unwatch erst nach Freigabe des
/// Vault-Locks, damit kein Aufrufer die zweite Hälfte vergessen kann.
pub(crate) fn compute_refresh_delta_synced(
    state: &AppState,
    workspace: &Workspace,
) -> Result<crate::vault::VaultRefreshDelta, String> {
    let pin_roots = pin_directory_paths(workspace);
    let (delta, pruned) = {
        let opts = read_vault_list_options(state)?;
        let mut vault = state
            .vault
            .lock()
            .map_err(|_| "vault lock poisoned".to_string())?;
        vault.set_list_options(opts);
        let pruned = vault.prune_invisible_expanded(&pin_roots);
        (vault.compute_refresh_delta(workspace), pruned)
    };
    unwatch_pruned_paths(state, &pruned);
    Ok(delta)
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
pub async fn vault_build_tree(
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<String, String> {
    let (html, paths, pruned) = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        let panel = state
            .panel_state
            .lock()
            .map_err(|_| "panel state lock poisoned".to_string())?
            .data();
        let pin_roots = pin_directory_paths(&workspace);
        let opts = read_vault_list_options(state.inner())?;
        let mut vault = state
            .vault
            .lock()
            .map_err(|_| "vault lock poisoned".to_string())?;
        vault.set_list_options(opts);
        let pruned = vault.prune_invisible_expanded(&pin_roots);
        let html = vault.build_initial_tree_html_with(
            &workspace,
            panel.pinned_expanded,
            panel.recent_expanded,
        );
        let paths = crate::git_status::workspace_scan_paths(&workspace);
        (html, paths, pruned)
    };
    unwatch_pruned_paths(state.inner(), &pruned);
    // Render bleibt frei von git status: Jobs starten erst nach dem HTML.
    crate::git_status::schedule_for_paths(&state.git_status, &paths, &handle);
    Ok(html)
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
        let opts = read_vault_list_options(state.inner())?;
        let mut vault = state
            .vault
            .lock()
            .map_err(|_| "vault lock poisoned".to_string())?;
        let paths = vault.expand_roots(&pin_dirs, opts);
        vault.set_list_options(opts);
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExpandPathsResponse {
    pub html: String,
    pub capped: bool,
    pub expanded: usize,
}

/// Expandiert eine explizite Verzeichnisliste ueber den bestehenden
/// `on_expand`-Pfad (Watcher inklusive). Soft-Cap 1000 wie das entfernte
/// `vault_expand_level` (R3.1).
#[tauri::command]
pub async fn vault_expand_paths(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<VaultExpandPathsResponse, String> {
    let (expanded, capped, html) = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        let panel = state
            .panel_state
            .lock()
            .map_err(|_| "panel state lock poisoned".to_string())?
            .data();
        let pin_roots = pin_directory_paths(&workspace);
        let opts = read_vault_list_options(state.inner())?;
        let mut vault = state
            .vault
            .lock()
            .map_err(|_| "vault lock poisoned".to_string())?;
        let result = vault.expand_paths(
            &paths,
            opts,
            crate::vault::Vault::EXPAND_PATHS_CAP,
            &pin_roots,
        );
        vault.set_list_options(opts);
        let html = vault.build_initial_tree_html_with(
            &workspace,
            panel.pinned_expanded,
            panel.recent_expanded,
        );
        (result.paths, result.capped, html)
    };
    if let Ok(mut watcher) = state.vault_watcher.lock() {
        for path in &expanded {
            if let Err(err) = watcher.watch(path) {
                tracing::warn!(
                    target: "folio::vault",
                    path = %path,
                    error = %err,
                    "vault_expand_paths: vault_watcher.watch failed"
                );
            }
        }
    }
    Ok(VaultExpandPathsResponse {
        html,
        capped,
        expanded: expanded.len(),
    })
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
        let opts = read_vault_list_options(state.inner())?;
        let mut vault = state
            .vault
            .lock()
            .map_err(|_| "vault lock poisoned".to_string())?;
        vault.set_list_options(opts);
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
        "gitChangedOnly": data.vault_filter_git_changed_only,
    }))
}

/// Collapse-State der Tags-Sektion (W5). Default: eingeklappt.
#[tauri::command]
pub async fn vault_tags_section_get(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data();
    Ok(serde_json::json!({ "expanded": data.tags_expanded }))
}

#[tauri::command]
pub async fn vault_filter_options_set(
    markdown_only: bool,
    bar_visible: bool,
    git_changed_only: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_vault_filter_options(markdown_only, bar_visible, git_changed_only)
        .map_err(|error| error.to_string())?;
    // Lazy-Tree-Spiegel: poisoned Vault-Lock ist Fehler (FX4), nicht still.
    // Nach dem Panel-Write beide Spiegel aus den Quellen lesen — sonst
    // bleibt show_hidden auf einem veralteten Vault-Wert, wenn jemand
    // nur den md-Toggle setzt.
    sync_vault_list_options(state.inner())?;
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

/// Datei-Quelle für die Command Palette: frischer Pin-Walk (kein Cache).
/// Siehe `crate::palette::collect_palette_files`.
#[tauri::command]
pub async fn palette_files(
    state: State<'_, AppState>,
) -> Result<crate::palette::PaletteFilesResponse, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    // Walk kann etwas dauern — Snapshot der Pins freigeben den Lock
    // nicht während des Walks halten: Liste klonen, Lock droppen.
    let pinned = workspace.pinned().to_vec();
    drop(workspace);
    Ok(crate::palette::collect_palette_files(&pinned))
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
