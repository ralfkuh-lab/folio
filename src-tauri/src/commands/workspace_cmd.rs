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

/// Schaltet eine Pin-Wurzel als Wikilink-/Tag-Wurzel ein oder aus
/// (Opt-in-Modell, Spec W8). `path` ist der Pin-Pfad aus dem Vault-Baum.
#[tauri::command]
pub async fn workspace_wikilink_root_set(
    path: String,
    enabled: bool,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    let changed = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .set_wikilink_root(&path, enabled)
        .map_err(|error| error.to_string())?;
    if changed {
        // Der Suchraum ist `pinned ∩ wikilink_roots` — die Wurzel-Aenderung
        // wechselt ihn genauso wie ein Pin.
        state.invalidate_wikilink_index();
    }
    // Immer neu rendern: das `data-wikilink-root`-Attribut steuert den
    // Kontextmenue-Zustand.
    emit_vault_refresh(state.inner(), &handle)?;
    if changed {
        // Der Vault-Baum allein reicht nicht: eine bereits sichtbare
        // Markdown-View wuerde ohne Signal weder neu rendern noch ueberhaupt
        // einen Build anstossen (der Cold-Build startet erst beim naechsten
        // `get()`). Die Wurzel waere bis zum naechsten Tipp-/Mode-/Dokument-
        // Ereignis wirkungslos, beim Deaktivieren blieben aufgeloeste Links
        // stehen (Review sol, MAJOR #2). Bewusst ein **eigenes** Event:
        // `wikilink:index_ready` bleibt den beendeten Builds vorbehalten.
        // Der erste Render nach diesem Signal startet den Build,
        // `index_ready` zieht nach dessen Abschluss final nach.
        handle
            .emit("wikilink:roots_changed", serde_json::json!({}))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
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
    match state.git_head_watcher.lock() {
        Ok(mut w) => {
            let _ = w.sync(gitdirs);
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::git",
                %error,
                "git_head_watcher lock poisoned during sync"
            );
        }
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
