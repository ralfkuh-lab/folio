use crate::menu::strings as menu_strings;
use crate::state::AppState;
use crate::{i18n, i18n::t_args};
use std::{fs, path::Path};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use super::util::file_path_to_string;

/// Benennt eine Datei um. Wenn die Datei aktuell geöffnet ist, wandert
/// der Pfad im DocumentStore mit (`rename_to`) und das Frontend bekommt
/// per `document:loaded` den neuen `kind`/`language` für die ggf. neue
/// Endung. Workspace.recent wird von `old_path` auf `new_path` umgehängt;
/// der Vault wird per `vault:refresh` zum Reload getriggert.
#[tauri::command]
pub async fn rename_file(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<String, String> {
    if old_path == new_path {
        return Ok(new_path);
    }
    perform_rename(&old_path, &new_path, &state, &handle)?;
    Ok(new_path)
}

/// Save-Dialog für „Datei → Umbenennen…" — Default-Filename ist der
/// aktuelle Dateiname, Default-Verzeichnis das aktuelle Verzeichnis.
/// Cancel → `Ok(None)`. Bei Pick wird `perform_rename` gerufen.
pub fn run_rename_dialog(
    state: &State<'_, AppState>,
    handle: &AppHandle,
) -> Result<Option<String>, String> {
    let current_path = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        tabs.active()
            .document_store
            .path
            .clone()
            .ok_or_else(|| i18n::t("errors.document.noneOpen"))?
    };

    let labels = menu_strings::labels();
    let mut builder = handle
        .dialog()
        .file()
        .set_title(labels.file_rename.as_str());
    let current_filename = Path::new(&current_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    builder = builder.set_file_name(current_filename);
    if let Some(parent) = Path::new(&current_path).parent() {
        builder = builder.set_directory(parent);
    }
    builder = builder.add_filter(labels.save_as_filter_all.as_str(), &["*"]);

    let Some(target) = builder.blocking_save_file() else {
        return Ok(None);
    };
    let new_path = file_path_to_string(target);
    if new_path.is_empty() {
        return Ok(None);
    }
    if new_path == current_path {
        return Ok(None);
    }
    perform_rename(&current_path, &new_path, state, handle)?;
    Ok(Some(new_path))
}

/// Validiert + verschiebt + synchronisiert State für eine Rename-Aktion.
/// Wird sowohl vom Tauri-Command `rename_file` (Inline-Rename im Vault)
/// als auch von `run_rename_dialog` (Datei-Menü, Save-As-artiger
/// Verzeichniswechsel) gerufen — beide brauchen den gleichen
/// State-Choreografie-Block (DocumentStore, Workspace.recent,
/// Recent-Submenü, Vault.active, `vault:refresh`).
///
/// Vorbedingung: `old_path != new_path`. Bei Gleichheit ist der Aufruf
/// ein No-op und sollte vom Caller abgefangen werden.
fn perform_rename(
    old_path: &str,
    new_path: &str,
    state: &State<'_, AppState>,
    handle: &AppHandle,
) -> Result<(), String> {
    // Auf Forward-Slashes normalisieren wie in document_service::open —
    // die Vergleiche unten (store.path, recent) laufen gegen
    // normalisierte Pfade.
    let old_path = old_path.replace('\\', "/");
    let new_path = new_path.replace('\\', "/");
    let (old_path, new_path) = (old_path.as_str(), new_path.as_str());
    let target = Path::new(new_path);
    if target.exists() {
        let detail = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(new_path);
        return Err(t_args(
            "errors.file.targetAlreadyExists",
            &[("detail", detail)],
        ));
    }
    fs::rename(old_path, new_path).map_err(|error| {
        let detail = error.to_string();
        t_args("errors.file.renameFailed", &[("detail", &detail)])
    })?;

    let (is_open, is_current) = {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        if let Some(tab_id) = tabs.find_by_path(old_path) {
            let is_active = tabs.is_active(tab_id);
            let tab = tabs
                .tab_mut(tab_id)
                .expect("find_by_path returned an existing tab");
            if tab.pending_path().is_some() {
                // Noch nie geladener Restore-Tab: nur den Pfad umhaengen,
                // weiterhin kein Watcher und kein Datei-Load.
                tab.retarget_pending_path(new_path.to_string());
            } else {
                if is_active {
                    tab.document_store.rename_to(new_path).map_err(|error| {
                        let detail = error.to_string();
                        t_args("errors.file.renameFailed", &[("detail", &detail)])
                    })?;
                } else {
                    tab.document_store
                        .rename_to_silent(new_path)
                        .map_err(|error| {
                            let detail = error.to_string();
                            t_args("errors.file.renameFailed", &[("detail", &detail)])
                        })?;
                }
                tab.navigation.navigate(new_path.to_string(), None);
            }
            (true, is_active)
        } else {
            (false, false)
        }
    };

    finish_rename(state, handle, old_path, new_path, is_open, is_current)
}

fn finish_rename(
    state: &State<'_, AppState>,
    handle: &AppHandle,
    old_path: &str,
    new_path: &str,
    is_open: bool,
    is_current: bool,
) -> Result<(), String> {
    // Recent-Liste in einem einzigen Lock-Take aktualisieren: was_in_recent
    // lesen → remove_recent → optional add_recent. Vorher hingen die drei
    // Schritte als separate `if let Ok(...)`-Blocks, was bei Lock-Poisoning
    // zwischen den Schritten Halb-Updates produziert haette.
    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        let was_in_recent = workspace.recent().iter().any(|r| r.path == old_path);
        workspace
            .remove_recent(old_path)
            .map_err(|error| error.to_string())?;
        if was_in_recent || is_open {
            workspace
                .add_recent(new_path.to_string())
                .map_err(|error| error.to_string())?;
        }
    }
    crate::menu::refresh_recent_from_workspace(handle);
    // Rename aendert den indizierten Dateinamen.
    state.invalidate_wikilink_index();
    crate::git_status::refresh_for_paths(&state.git_status, [old_path, new_path], handle);

    if is_current {
        state
            .vault
            .lock()
            .map_err(|_| "vault lock poisoned".to_string())?
            .set_active(Some(new_path.to_string()));
    }

    // Finaler Sync: vault:refresh-Event mit aktualisiertem Pinned/Recent-Delta.
    {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        let delta = crate::commands::vault_cmd::compute_refresh_delta_synced(state, &workspace)?;
        handle
            .emit("vault:refresh", delta)
            .map_err(|error| error.to_string())?;
    }
    AppState::emit_tabs_changed(handle)?;
    Ok(())
}
