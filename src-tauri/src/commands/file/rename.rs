use crate::menu::strings as menu_strings;
use crate::state::AppState;
use crate::{i18n, i18n::t_args};
use std::{fs, io, path::Path};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use super::util::file_path_to_string;

/// Benennt eine Datei oder ein Verzeichnis um. Offene Tabs, History,
/// Workspace-Pfade und Vault-State wandern präfixweise mit.
#[tauri::command]
pub async fn rename_file(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<String, String> {
    let (old_path, new_path) = prepare_move_paths_msg(&old_path, &new_path)?;
    if old_path == new_path {
        return Ok(new_path);
    }
    perform_move(&old_path, &new_path, &state, &handle)?;
    Ok(new_path)
}

/// Save-Dialog für „Datei → Umbenennen…" — Default-Filename ist der
/// aktuelle Dateiname, Default-Verzeichnis das aktuelle Verzeichnis.
/// Cancel → `Ok(None)`. Bei Pick wird `perform_move` gerufen.
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
    let picked = file_path_to_string(target);
    if picked.is_empty() {
        return Ok(None);
    }
    let (old_path, new_path) = prepare_move_paths_msg(&current_path, &picked)?;
    if old_path == new_path {
        return Ok(None);
    }
    perform_move(&old_path, &new_path, state, handle)?;
    Ok(Some(new_path))
}

#[derive(Debug, PartialEq, Eq)]
enum MovePathError {
    InvalidName,
    MoveIntoSelf,
}

/// Normalisiert, lehnt `..` ab und prüft Selbst-Move. Gleichheit nach
/// Normalisierung ist ein gültiger No-op (Caller entscheidet).
fn prepare_move_paths(old_path: &str, new_path: &str) -> Result<(String, String), MovePathError> {
    let old_path = crate::path_migration::normalize(old_path);
    let new_path = crate::path_migration::normalize(new_path);
    if old_path.split('/').any(|component| component == "..")
        || new_path.split('/').any(|component| component == "..")
    {
        return Err(MovePathError::InvalidName);
    }
    if crate::path_migration::is_under(&new_path, &old_path) && new_path != old_path {
        return Err(MovePathError::MoveIntoSelf);
    }
    if new_path != old_path {
        if let Some(parent) = Path::new(&new_path).parent() {
            if crate::fs_copy::is_physically_under(parent, Path::new(&old_path)) {
                return Err(MovePathError::MoveIntoSelf);
            }
        }
    }
    Ok((old_path, new_path))
}

fn prepare_move_paths_msg(old_path: &str, new_path: &str) -> Result<(String, String), String> {
    prepare_move_paths(old_path, new_path).map_err(|error| match error {
        MovePathError::InvalidName => i18n::t("errors.file.invalidName"),
        MovePathError::MoveIntoSelf => i18n::t("errors.file.cannotMoveIntoSelf"),
    })
}

/// Validiert + verschiebt + synchronisiert State für Rename/Move.
///
/// Vorbedingung: Pfade sind bereits über [`prepare_move_paths`] gelaufen
/// und `old_path != new_path`. Wird auch von `move_entry` genutzt.
pub(crate) fn perform_move(
    old_path: &str,
    new_path: &str,
    state: &State<'_, AppState>,
    handle: &AppHandle,
) -> Result<(), String> {
    let target = Path::new(new_path);
    // Residual-TOCTOU zwischen exists() und fs::rename: einen portabel
    // atomaren No-Replace-Rename gibt es nicht (renameat2/RENAME_NOREPLACE
    // ist Linux-spezifisch und nicht auf jedem FS; macOS kennt ihn nicht).
    // Das Fenster ist mikroskopisch; der Nutzer ist im Vault der einzige
    // Akteur. Der Copy-Pfad nutzt create_new (siehe copy_file_exclusive).
    if destination_blocks_move(old_path, new_path) {
        let detail = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(new_path);
        return Err(t_args(
            "errors.file.targetAlreadyExists",
            &[("detail", detail)],
        ));
    }

    let src_is_dir = Path::new(old_path).is_dir();
    rename_or_copy(old_path, new_path)?;

    // Ab hier ist der Move auf der Platte unwiderruflich. Die gesamte
    // State-Choreografie läuft best-effort durch — Einzelfehler werden
    // gewarnt, nicht per `?` abgebrochen.
    apply_move_state(state, handle, old_path, new_path, src_is_dir);
    Ok(())
}

fn destination_blocks_move(old_path: &str, new_path: &str) -> bool {
    if !Path::new(new_path).exists() {
        return false;
    }
    !is_case_only_same_entry(old_path, new_path)
}

fn is_case_only_same_entry(old_path: &str, new_path: &str) -> bool {
    old_path != new_path
        && old_path.eq_ignore_ascii_case(new_path)
        && match (fs::canonicalize(old_path), fs::canonicalize(new_path)) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        }
}

fn rename_or_copy(old_path: &str, new_path: &str) -> Result<(), String> {
    match fs::rename(old_path, new_path) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device(&error) => {
            let report = crate::fs_copy::copy_recursively(Path::new(old_path), Path::new(new_path))
                .map_err(|error| {
                    let detail = error.to_string();
                    t_args("errors.file.renameFailed", &[("detail", &detail)])
                })?;
            finish_exdev_copy(old_path, new_path, &report)
        }
        Err(error) => {
            let detail = error.to_string();
            Err(t_args("errors.file.renameFailed", &[("detail", &detail)]))
        }
    }
}

fn is_cross_device(error: &io::Error) -> bool {
    match error.raw_os_error() {
        // EXDEV on Unix, ERROR_NOT_SAME_DEVICE on Windows.
        #[cfg(unix)]
        Some(18) => true,
        #[cfg(windows)]
        Some(17) => true,
        _ => false,
    }
}

/// Nach EXDEV-Kopie: nur bei vollständigem Report die Quelle löschen.
fn finish_exdev_copy(
    old_path: &str,
    new_path: &str,
    report: &crate::fs_copy::CopyReport,
) -> Result<(), String> {
    if !report.is_complete() {
        let detail = report.skipped_symlinks.join(", ");
        return Err(t_args(
            "errors.file.copySkippedSymlinks",
            &[("detail", &detail)],
        ));
    }
    if let Err(error) = crate::fs_copy::remove_entry(Path::new(old_path)) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            old_path,
            new_path,
            "perform_move: Quelle nach EXDEV-Kopie nicht entfernt"
        );
    }
    Ok(())
}

fn apply_move_state(
    state: &AppState,
    handle: &AppHandle,
    old_path: &str,
    new_path: &str,
    src_is_dir: bool,
) {
    // Workspace + Wikilink VOR den Tabs: rename_to des aktiven Tabs
    // emittiert synchron document:loaded, das den Index und die Pins liest.
    let file_is_open = if src_is_dir {
        false
    } else {
        match state.tabs.lock() {
            Ok(tabs) => tabs.find_by_path(old_path).is_some(),
            Err(error) => {
                tracing::warn!(
                    target: "folio::ipc",
                    %error,
                    "perform_move: tabs lock poisoned beim Open-Check"
                );
                false
            }
        }
    };
    match state.workspace.lock() {
        Ok(mut workspace) => {
            if let Err(error) = workspace.remap_prefix(old_path, new_path) {
                tracing::warn!(
                    target: "folio::ipc",
                    %error,
                    "perform_move: Workspace-Remap fehlgeschlagen"
                );
            } else if !src_is_dir
                && (file_is_open || workspace.recent().iter().any(|item| item.path == new_path))
            {
                if let Err(error) = workspace.add_recent(new_path.to_string()) {
                    tracing::warn!(
                        target: "folio::ipc",
                        %error,
                        "perform_move: add_recent fehlgeschlagen"
                    );
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "perform_move: workspace lock poisoned"
            );
        }
    }
    state.invalidate_wikilink_index();
    crate::menu::refresh_recent_from_workspace(handle);
    crate::commands::workspace_cmd::sync_git_head_watcher(state);

    remap_open_tabs(state, old_path, new_path);
    crate::git_status::refresh_for_paths(&state.git_status, [old_path, new_path], handle);
    remap_vault_and_watchers(state, old_path, new_path);

    match state.workspace.lock() {
        Ok(workspace) => {
            match crate::commands::vault_cmd::compute_refresh_delta_synced(state, &workspace) {
                Ok(delta) => {
                    if let Err(error) = handle.emit("vault:refresh", delta) {
                        tracing::warn!(
                            target: "folio::ipc",
                            %error,
                            "perform_move: vault:refresh emit fehlgeschlagen"
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        target: "folio::ipc",
                        %error,
                        "perform_move: compute_refresh_delta fehlgeschlagen"
                    );
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "perform_move: workspace lock poisoned beim vault:refresh"
            );
        }
    }
    if let Err(error) = AppState::emit_tabs_changed(handle) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            "perform_move: tabs:changed emit fehlgeschlagen"
        );
    }
}

fn remap_open_tabs(state: &AppState, old_path: &str, new_path: &str) {
    let mut tabs = match state.tabs.lock() {
        Ok(tabs) => tabs,
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "perform_move: tabs lock poisoned beim Remap"
            );
            return;
        }
    };
    let ids: Vec<u64> = tabs.tabs().iter().map(|tab| tab.id).collect();
    for id in ids {
        let is_active = tabs.is_active(id);
        let tab = tabs.tab_mut(id).expect("id came from the live tab list");
        tab.navigation.rewrite_prefix(old_path, new_path);
        if let Some(pending) = tab.pending_path() {
            if let Some(rewritten) = crate::path_migration::remap(pending, old_path, new_path) {
                tab.retarget_pending_path(rewritten);
            }
            continue;
        }
        let Some(current) = tab.document_store.path.clone() else {
            continue;
        };
        let Some(rewritten) = crate::path_migration::remap(&current, old_path, new_path) else {
            continue;
        };
        let result = if is_active {
            tab.document_store.rename_to(&rewritten)
        } else {
            tab.document_store.rename_to_silent(&rewritten)
        };
        if let Err(error) = result {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                tab_id = id,
                "perform_move: Tab-Pfad konnte nicht umgehängt werden"
            );
        }
    }
    tabs.remap_recently_closed(old_path, new_path);
}

fn remap_vault_and_watchers(state: &AppState, old_path: &str, new_path: &str) {
    let (unwatch, watch) = match state.vault.lock() {
        Ok(mut vault) => vault.remap_prefix(old_path, new_path),
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "perform_move: vault lock poisoned"
            );
            return;
        }
    };
    match state.vault_watcher.lock() {
        Ok(mut watcher) => {
            for path in &unwatch {
                watcher.unwatch(path);
            }
            for path in &watch {
                if let Err(error) = watcher.watch(path) {
                    tracing::warn!(
                        target: "folio::vault",
                        %error,
                        path,
                        "perform_move: watch after remap failed"
                    );
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::vault",
                %error,
                "perform_move: vault_watcher lock poisoned — neue expanded_dirs ohne Watch"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        destination_blocks_move, is_case_only_same_entry, prepare_move_paths, MovePathError,
    };
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn prepare_rejects_parent_traversal() {
        assert_eq!(
            prepare_move_paths("/vault/a", "/vault/../outside").unwrap_err(),
            MovePathError::InvalidName
        );
        assert_eq!(
            prepare_move_paths("/vault/a/../b", "/vault/c").unwrap_err(),
            MovePathError::InvalidName
        );
    }

    #[test]
    fn prepare_normalizes_then_treats_slash_variants_as_equal() {
        let (old, new) = prepare_move_paths(r"C:\x", "C:/x").unwrap();
        assert_eq!(old, new);
        assert_eq!(old, "C:/x");
    }

    #[test]
    fn prepare_trims_trailing_slash_before_compare() {
        let (old, new) = prepare_move_paths("/vault/ordner/", "/vault/ordner2").unwrap();
        assert_eq!(old, "/vault/ordner");
        assert_eq!(new, "/vault/ordner2");
    }

    #[test]
    fn prepare_rejects_move_into_self() {
        assert_eq!(
            prepare_move_paths("/vault/a", "/vault/a/b").unwrap_err(),
            MovePathError::MoveIntoSelf
        );
    }

    #[test]
    fn destination_blocks_real_collision_but_not_missing_target() {
        let temp = TempDir::new().unwrap();
        let old = temp.path().join("Foo");
        let other = temp.path().join("Bar");
        fs::write(&old, "x").unwrap();
        fs::write(&other, "y").unwrap();
        let old_s = old.to_string_lossy().replace('\\', "/");
        let other_s = other.to_string_lossy().replace('\\', "/");
        let missing = temp.path().join("missing");
        let missing_s = missing.to_string_lossy().replace('\\', "/");
        assert!(destination_blocks_move(&old_s, &other_s));
        assert!(!destination_blocks_move(&old_s, &missing_s));
    }

    #[test]
    fn case_only_same_entry_matches_only_when_fs_agrees() {
        let temp = TempDir::new().unwrap();
        let old = temp.path().join("Foo");
        fs::write(&old, "x").unwrap();
        let old_s = old.to_string_lossy().replace('\\', "/");
        let mut new_s = old_s.clone();
        if let Some(pos) = new_s.rfind("Foo") {
            new_s.replace_range(pos..pos + 3, "foo");
        }
        let same = is_case_only_same_entry(&old_s, &new_s);
        if same {
            assert!(!destination_blocks_move(&old_s, &new_s));
        } else {
            let new_exists = Path::new(&new_s).exists();
            if new_exists {
                assert_ne!(fs::canonicalize(&old_s).ok(), fs::canonicalize(&new_s).ok());
            }
            assert!(!destination_blocks_move(&old_s, &new_s) || new_exists);
        }
        assert!(!is_case_only_same_entry(&old_s, &old_s));
    }

    #[test]
    fn finish_exdev_copy_keeps_source_when_symlinks_were_skipped() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("keep.txt"), "x").unwrap();
        let src_s = src.to_string_lossy().replace('\\', "/");
        let report = crate::fs_copy::CopyReport {
            skipped_symlinks: vec![src.join("link").to_string_lossy().into_owned()],
        };
        let result = std::panic::catch_unwind(|| {
            super::finish_exdev_copy(&src_s, "/tmp/folio-exdev-dst", &report)
        });
        assert!(
            src.join("keep.txt").exists(),
            "incomplete EXDEV copy must not delete the source"
        );
        if let Ok(Ok(())) = result {
            panic!("incomplete copy must not be treated as success");
        }
    }
}
