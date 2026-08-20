//! V2: Duplizieren, Kopieren, Verschieben im Vault.
//!
//! `move_entry` teilt sich [`super::rename::perform_move`] — kein zweiter
//! Migrationspfad. Nach erfolgreicher Platten-IO läuft State-Sync
//! best-effort (wie `apply_move_state`).

use crate::fs_copy::{copy_dir_contents, copy_recursively, is_physically_under, CopyReport};
use crate::state::AppState;
use crate::{i18n, i18n::t_args};
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(test)]
use std::cell::Cell;

#[cfg(test)]
thread_local! {
    static COLLIDE_AFTER_DIR_RESERVE: Cell<bool> = const { Cell::new(false) };
}
use tauri::{AppHandle, Emitter, State};

const DUPLICATE_CAP: u32 = 10_000;

#[derive(Debug, PartialEq, Eq)]
enum TransferError {
    InvalidName,
    MoveIntoSelf,
}

#[derive(Debug, PartialEq, Eq)]
enum PlannedMove {
    Noop(String),
    Relocate { src: String, dest: String },
}

/// `a.md` → `a copy.md` (n=1) → `a copy 2.md` (n=2).
/// Endung bleibt hinten (`a.tar.gz` → `a.tar copy.gz`).
pub fn duplicate_candidate_name(file_name: &str, n: u32) -> String {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let suffix = if n <= 1 {
        " copy".to_string()
    } else {
        format!(" copy {n}")
    };
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if !stem.is_empty() => format!("{stem}{suffix}.{ext}"),
        _ => format!("{file_name}{suffix}"),
    }
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => path[..index].to_string(),
        None => String::new(),
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn plan_dest(src: &str, dest_dir: &str) -> Result<(String, String, String), TransferError> {
    let src = crate::path_migration::normalize(src);
    let dest_dir = crate::path_migration::normalize(dest_dir);
    if src.split('/').any(|c| c == "..") || dest_dir.split('/').any(|c| c == "..") {
        return Err(TransferError::InvalidName);
    }
    if src.is_empty() || dest_dir.is_empty() || basename(&src).is_empty() {
        return Err(TransferError::InvalidName);
    }
    if dest_dir_conflicts(&src, &dest_dir) {
        return Err(TransferError::MoveIntoSelf);
    }
    let dest = join_dir_name(&dest_dir, basename(&src));
    Ok((src, dest, dest_dir))
}

fn join_dir_name(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn dest_dir_conflicts(src: &str, dest_dir: &str) -> bool {
    crate::path_migration::is_under(dest_dir, src)
        || is_physically_under(Path::new(dest_dir), Path::new(src))
}

fn plan_move(src: &str, dest_dir: &str) -> Result<PlannedMove, TransferError> {
    let (src, dest, dest_dir) = plan_dest(src, dest_dir)?;
    if parent_dir(&src) == dest_dir {
        return Ok(PlannedMove::Noop(src));
    }
    Ok(PlannedMove::Relocate { src, dest })
}

fn transfer_error_msg(error: TransferError) -> String {
    match error {
        TransferError::InvalidName => i18n::t("errors.file.invalidName"),
        TransferError::MoveIntoSelf => i18n::t("errors.file.cannotMoveIntoSelf"),
    }
}

fn require_directory(path: &str) -> Result<(), String> {
    if Path::new(path).is_dir() {
        Ok(())
    } else {
        Err(i18n::t_args(
            "errors.file.destNotDirectory",
            &[("detail", path)],
        ))
    }
}

fn copy_io_error(error: std::io::Error) -> String {
    let detail = error.to_string();
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        i18n::t_args("errors.file.alreadyExists", &[("detail", &detail)])
    } else if error.kind() == std::io::ErrorKind::NotFound {
        i18n::t_args("errors.file.sourceMissing", &[("detail", &detail)])
    } else {
        t_args("errors.file.copyTreeFailed", &[("detail", &detail)])
    }
}

fn refresh_after_copy(state: &AppState, handle: &AppHandle, path: &str) {
    state.invalidate_wikilink_index();
    crate::git_status::refresh_for_path(&state.git_status, path, handle);
    match state.workspace.lock() {
        Ok(workspace) => {
            match crate::commands::vault_cmd::compute_refresh_delta_synced(state, &workspace) {
                Ok(delta) => {
                    if let Err(error) = handle.emit("vault:refresh", delta) {
                        tracing::warn!(
                            target: "folio::ipc",
                            %error,
                            "copy/duplicate: vault:refresh emit fehlgeschlagen"
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        target: "folio::ipc",
                        %error,
                        "copy/duplicate: compute_refresh_delta fehlgeschlagen"
                    );
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "copy/duplicate: workspace lock poisoned"
            );
        }
    }
}

fn try_duplicate(src: &Path) -> std::io::Result<(PathBuf, CopyReport)> {
    let parent = src.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "source has no parent")
    })?;
    let name = src.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid file name")
    })?;
    let meta = fs::symlink_metadata(src)?;
    let is_real_dir = meta.is_dir() && !meta.file_type().is_symlink();
    for n in 1..=DUPLICATE_CAP {
        let dest = parent.join(duplicate_candidate_name(name, n));
        if is_real_dir {
            match fs::create_dir(&dest) {
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
                Ok(()) => {
                    #[cfg(test)]
                    if COLLIDE_AFTER_DIR_RESERVE.get() {
                        let _ = fs::write(dest.join("b.txt"), "planted");
                    }
                    match copy_dir_contents(src, &dest) {
                        Ok(report) => return Ok((dest, report)),
                        Err(error) => return Err(error),
                    }
                }
            }
        } else {
            match copy_recursively(src, &dest) {
                Ok(report) => return Ok((dest, report)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "duplicate name space exhausted",
    ))
}

fn skipped_links_message(report: &CopyReport) -> String {
    i18n::t_args(
        "errors.file.copySkippedSymlinks",
        &[("detail", &report.skipped_symlinks.join(", "))],
    )
}

fn source_must_exist(path: &str) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok() {
        Ok(())
    } else {
        Err(t_args("errors.file.sourceMissing", &[("detail", path)]))
    }
}

/// Dupliziert Datei oder Ordner neben der Quelle. Gibt den neuen Pfad zurück.
#[tauri::command]
pub async fn duplicate_entry(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<String, String> {
    let src = crate::path_migration::normalize(&path);
    if src.split('/').any(|c| c == "..") || src.is_empty() {
        return Err(i18n::t("errors.file.invalidName"));
    }
    source_must_exist(&src)?;
    let (dest, report) = try_duplicate(Path::new(&src)).map_err(copy_io_error)?;
    let dest = crate::path_migration::normalize(&dest.to_string_lossy());
    refresh_after_copy(&state, &handle, &dest);
    if !report.is_complete() {
        return Err(skipped_links_message(&report));
    }
    Ok(dest)
}

/// Kopiert `src` nach `dest_dir/<basename>`. Ziel darf nicht existieren.
#[tauri::command]
pub async fn copy_entry(
    src: String,
    dest_dir: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<String, String> {
    let (src, dest, dest_dir) = plan_dest(&src, &dest_dir).map_err(transfer_error_msg)?;
    source_must_exist(&src)?;
    require_directory(&dest_dir)?;
    if dest_dir_conflicts(&src, &dest_dir) {
        return Err(i18n::t("errors.file.cannotMoveIntoSelf"));
    }
    let report = copy_recursively(Path::new(&src), Path::new(&dest)).map_err(copy_io_error)?;
    refresh_after_copy(&state, &handle, &dest);
    if !report.is_complete() {
        return Err(skipped_links_message(&report));
    }
    Ok(dest)
}

/// Verschiebt `src` nach `dest_dir/<basename>` über [`super::rename::perform_move`].
/// Elternordner == dest_dir → No-op.
#[tauri::command]
pub async fn move_entry(
    src: String,
    dest_dir: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<String, String> {
    let planned = plan_move(&src, &dest_dir).map_err(transfer_error_msg)?;
    match planned {
        PlannedMove::Noop(src) => Ok(src),
        PlannedMove::Relocate { src, dest } => {
            source_must_exist(&src)?;
            require_directory(parent_dir(&dest).as_str())?;
            if dest_dir_conflicts(&src, parent_dir(&dest).as_str()) {
                return Err(i18n::t("errors.file.cannotMoveIntoSelf"));
            }
            super::rename::perform_move(&src, &dest, &state, &handle)?;
            Ok(dest)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        duplicate_candidate_name, plan_dest, plan_move, try_duplicate, PlannedMove, TransferError,
    };
    #[cfg(unix)]
    use crate::fs_copy::copy_recursively;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn duplicate_names_keep_extension_at_the_end() {
        assert_eq!(duplicate_candidate_name("a.md", 1), "a copy.md");
        assert_eq!(duplicate_candidate_name("a.md", 2), "a copy 2.md");
        assert_eq!(duplicate_candidate_name("a.tar.gz", 1), "a.tar copy.gz");
        assert_eq!(duplicate_candidate_name("notes", 1), "notes copy");
        assert_eq!(duplicate_candidate_name("notes", 3), "notes copy 3");
    }

    #[test]
    fn try_duplicate_skips_taken_names() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("a.md");
        fs::write(&src, "one").unwrap();
        fs::write(temp.path().join("a copy.md"), "taken").unwrap();

        let (dest, report) = try_duplicate(&src).unwrap();
        assert!(report.is_complete());
        assert_eq!(dest.file_name().unwrap(), "a copy 2.md");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "one");
        assert_eq!(
            fs::read_to_string(temp.path().join("a copy.md")).unwrap(),
            "taken"
        );
    }

    #[test]
    fn plan_rejects_folder_into_own_descendant() {
        assert_eq!(
            plan_dest("/vault/notes", "/vault/notes/sub").unwrap_err(),
            TransferError::MoveIntoSelf
        );
        assert_eq!(
            plan_dest("/vault/notes", "/vault/notes").unwrap_err(),
            TransferError::MoveIntoSelf
        );
        assert!(plan_dest("/vault/notes/a.md", "/vault/other").is_ok());
        assert!(plan_dest("/vault/notes-alt", "/vault/notes").is_ok());
    }

    #[test]
    fn plan_move_same_parent_is_noop() {
        match plan_move("/vault/notes/a.md", "/vault/notes").unwrap() {
            PlannedMove::Noop(src) => assert_eq!(src, "/vault/notes/a.md"),
            other => panic!("expected noop, got {other:?}"),
        }
    }

    #[test]
    fn plan_move_other_parent_is_relocate() {
        match plan_move("/vault/notes/a.md", "/vault/other").unwrap() {
            PlannedMove::Relocate { src, dest } => {
                assert_eq!(src, "/vault/notes/a.md");
                assert_eq!(dest, "/vault/other/a.md");
            }
            PlannedMove::Noop(_) => panic!("expected relocate"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn recursive_copy_does_not_follow_directory_symlink() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src");
        let other = temp.path().join("other");
        let dst = temp.path().join("dst");
        fs::create_dir(&src).unwrap();
        fs::create_dir(&other).unwrap();
        fs::write(other.join("secret.txt"), "nope").unwrap();
        std::os::unix::fs::symlink(&other, src.join("linkdir")).unwrap();
        copy_recursively(&src, &dst).unwrap();
        let meta = fs::symlink_metadata(dst.join("linkdir")).unwrap();
        assert!(meta.file_type().is_symlink());
        assert_eq!(fs::read_link(dst.join("linkdir")).unwrap(), other);
        assert!(!dst.join("secret.txt").is_file());
    }

    #[test]
    fn join_dir_name_does_not_double_slash_at_root() {
        assert_eq!(super::join_dir_name("/", "notes.md"), "/notes.md");
        assert_eq!(
            plan_dest("/notes.md", "/").unwrap(),
            ("/notes.md".into(), "/notes.md".into(), "/".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn dest_dir_via_symlink_into_source_is_rejected() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src");
        let sub = src.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&sub, &alias).unwrap();
        let src_s = src.to_string_lossy().replace('\\', "/");
        let alias_s = alias.to_string_lossy().replace('\\', "/");
        assert_eq!(
            plan_dest(&src_s, &alias_s).unwrap_err(),
            TransferError::MoveIntoSelf
        );
    }

    #[cfg(unix)]
    #[test]
    fn duplicate_dangling_symlink() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("gone.link");
        std::os::unix::fs::symlink(temp.path().join("missing"), &src).unwrap();
        assert!(!src.exists());
        assert!(fs::symlink_metadata(&src).is_ok());
        let (dest, report) = try_duplicate(&src).unwrap();
        assert!(report.is_complete());
        let meta = fs::symlink_metadata(&dest).unwrap();
        assert!(meta.file_type().is_symlink());
        assert_eq!(dest.file_name().unwrap(), "gone copy.link");
    }

    #[test]
    fn reserved_dir_child_collision_does_not_allocate_next_name() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("notes");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join("b.txt"), "b").unwrap();
        super::COLLIDE_AFTER_DIR_RESERVE.set(true);
        let error = try_duplicate(&src).unwrap_err();
        super::COLLIDE_AFTER_DIR_RESERVE.set(false);
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(temp.path().join("notes copy").is_dir());
        assert!(!temp.path().join("notes copy 2").exists());
    }

    #[test]
    fn incomplete_copy_report_must_not_delete_source() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("keep.txt"), "x").unwrap();
        let report = crate::fs_copy::CopyReport {
            skipped_symlinks: vec![src.join("link").to_string_lossy().into_owned()],
        };
        assert!(!report.is_complete());
        if report.is_complete() {
            crate::fs_copy::remove_entry(&src).unwrap();
        }
        assert!(src.join("keep.txt").exists());
    }
}
