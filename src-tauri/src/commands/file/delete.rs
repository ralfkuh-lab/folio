use crate::document_service::DirtyPolicy;
use crate::i18n;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// Verschiebt eine Datei oder einen Ordner in den Papierkorb
/// (wiederherstellbar). Analog zur Move-Choreografie: alle Tabs darunter
/// schließen (Discard — der Pfad ist weg), Recent/Pin/expanded_dirs
/// bereinigen, Recent-Submenü + Vault refreshen.
#[tauri::command]
pub async fn trash_path(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    let path = crate::path_migration::normalize(&path);

    // trash-Crate ruft unter Windows Shell-APIs, die Forward-Slashes nicht
    // vertragen — dort mit nativem Pfad löschen. Die normalisierte Variante
    // bleibt für find_by_path/remove_recent/is_pinned/unpin.
    let native = if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.clone()
    };
    trash::delete(&native).map_err(|error| {
        let detail = error.to_string();
        i18n::t_args("errors.file.deleteFailed", &[("detail", &detail)])
    })?;

    // Der Pfad ist ab hier irreversibel im Papierkorb. Fehler beim
    // Aufräumen dürfen die restliche Bereinigung NICHT per `?`
    // abbrechen — nur warnen.
    close_tabs_under(&state, &handle, &path);
    prune_surviving_tab_history(&state, &path);
    if let Err(error) = AppState::emit_tabs_changed(&handle) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            "trash_path: tabs:changed nach History-/Closed-Stack-Bereinigung fehlgeschlagen"
        );
    }
    if let Err(error) = remove_workspace_under(&state, &path) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            path = %path,
            "trash_path: Workspace-Bereinigung nach Papierkorb fehlgeschlagen"
        );
    }
    crate::menu::refresh_recent_from_workspace(&handle);
    state.invalidate_wikilink_index();
    crate::git_status::refresh_for_path(&state.git_status, &path, &handle);
    crate::commands::workspace_cmd::sync_git_head_watcher(&state);
    prune_vault_under(&state, &path);
    if let Err(error) = emit_vault_refresh(&state, &handle) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            path = %path,
            "trash_path: vault:refresh nach Papierkorb fehlgeschlagen"
        );
    }
    Ok(())
}

fn close_tabs_under(state: &AppState, handle: &AppHandle, root: &str) {
    let tab_ids = match state.tabs.lock() {
        Ok(tabs) => tabs.ids_under(root),
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: tabs lock poisoned beim Sammeln"
            );
            return;
        }
    };
    for id in tab_ids {
        match crate::commands::tabs::close(state, handle, id, DirtyPolicy::Discard) {
            Ok(transition) => {
                if let Err(error) =
                    crate::commands::tabs::emit_navigation_changed(handle, &transition, None)
                {
                    tracing::warn!(
                        target: "folio::ipc",
                        error = %error,
                        "trash_path: emit_navigation_changed nach Tab-Close fehlgeschlagen"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(
                    target: "folio::ipc",
                    error = %error,
                    "trash_path: Tab-Close nach Papierkorb-Löschen fehlgeschlagen"
                );
            }
        }
    }
}

/// Nach dem Schließen: History der überlebenden Tabs und den Closed-Stack
/// von Pfaden unter `root` befreien. Muss NACH close_tabs_under laufen,
/// weil close frisch in recently_closed pusht.
fn prune_surviving_tab_history(state: &AppState, root: &str) {
    let mut tabs = match state.tabs.lock() {
        Ok(tabs) => tabs,
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: tabs lock poisoned beim History-Prune"
            );
            return;
        }
    };
    let ids: Vec<u64> = tabs.tabs().iter().map(|tab| tab.id).collect();
    for id in ids {
        if let Some(tab) = tabs.tab_mut(id) {
            tab.navigation.remove_under(root);
        }
    }
    tabs.remove_recently_closed_under(root);
}

fn remove_workspace_under(state: &AppState, root: &str) -> Result<(), String> {
    let mut workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    workspace
        .remove_under(root)
        .map_err(|error| error.to_string())
}

fn prune_vault_under(state: &AppState, root: &str) {
    let removed = match state.vault.lock() {
        Ok(mut vault) => vault.remove_under(root),
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: vault lock poisoned beim Prunen"
            );
            return;
        }
    };
    if removed.is_empty() {
        return;
    }
    match state.vault_watcher.lock() {
        Ok(mut watcher) => {
            for path in &removed {
                watcher.unwatch(path);
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: vault_watcher lock poisoned beim Unwatch"
            );
        }
    }
}

fn emit_vault_refresh(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let delta = crate::commands::vault_cmd::compute_refresh_delta_synced(state, &workspace)?;
    handle
        .emit("vault:refresh", delta)
        .map_err(|error| error.to_string())
}
