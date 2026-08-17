//! Rekursives Kopieren ohne Symlink-Verfolgung.
//!
//! Geteilt von EXDEV-Fallback (`perform_move`) und V2 Duplizieren/Kopieren.
//! Dateiknoten werden mit `create_new` angelegt (kein Truncate, kein
//! Follow eines dangling Ziel-Symlinks).

use std::{
    fs::{self, FileType, OpenOptions},
    io::{self, Write},
    path::Path,
};

/// Ergebnis einer Kopie: innere Symlinks, die nicht als Symlink
/// angelegt werden konnten, stehen in `skipped_symlinks` (Pfad der Quelle).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CopyReport {
    pub skipped_symlinks: Vec<String>,
}

impl CopyReport {
    pub fn is_complete(&self) -> bool {
        self.skipped_symlinks.is_empty()
    }
}

/// `path` liegt physisch unter `root` (canonicalize, Komponentenvergleich).
/// Fehlschlagendes Auflösen → false (Caller hat das lexikalische Gate davor).
pub fn is_physically_under(path: &Path, root: &Path) -> bool {
    let Ok(path) = fs::canonicalize(path) else {
        return false;
    };
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    path == root || path.starts_with(&root)
}

/// Kopiert `src` nach `dst`. `dst` darf nicht existieren.
/// Symlinks werden als Symlink kopiert, nie aufgelöst. Schlägt das für
/// einen inneren Symlink fehl, wird er übersprungen und vermerkt;
/// am Wurzelknoten ist ein solcher Fehler fatal (sonst gäbe es kein Ziel).
pub fn copy_recursively(src: &Path, dst: &Path) -> io::Result<CopyReport> {
    let mut report = CopyReport::default();
    copy_recursively_inner(src, dst, true, &mut report)?;
    Ok(report)
}

/// Kopiert die Kinder von `src` nach bereits existierendem `dst`.
pub fn copy_dir_contents(src: &Path, dst: &Path) -> io::Result<CopyReport> {
    let mut report = CopyReport::default();
    copy_dir_contents_inner(src, dst, &mut report)?;
    copy_permissions(src, dst)?;
    Ok(report)
}

fn copy_recursively_inner(
    src: &Path,
    dst: &Path,
    is_root: bool,
    report: &mut CopyReport,
) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        match copy_symlink(src, dst, file_type) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(error),
            Err(error) if is_root => Err(error),
            Err(_) => {
                report
                    .skipped_symlinks
                    .push(src.to_string_lossy().replace('\\', "/"));
                Ok(())
            }
        }
    } else if meta.is_dir() {
        fs::create_dir(dst)?;
        copy_dir_contents_inner(src, dst, report)?;
        copy_permissions(src, dst)
    } else {
        copy_file_exclusive(src, dst)?;
        copy_permissions(src, dst)
    }
}

fn copy_dir_contents_inner(src: &Path, dst: &Path, report: &mut CopyReport) -> io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        copy_recursively_inner(&entry.path(), &dst.join(entry.file_name()), false, report)?;
    }
    Ok(())
}

fn copy_symlink(src: &Path, dst: &Path, file_type: FileType) -> io::Result<()> {
    let target = fs::read_link(src)?;
    #[cfg(unix)]
    {
        let _ = file_type;
        std::os::unix::fs::symlink(target, dst)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if file_type.is_symlink_dir() {
            std::os::windows::fs::symlink_dir(target, dst)
        } else {
            std::os::windows::fs::symlink_file(target, dst)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, file_type);
        Err(io::Error::other(
            "copying symbolic links is not supported on this platform",
        ))
    }
}

pub fn copy_file_exclusive(src: &Path, dst: &Path) -> io::Result<()> {
    let mut from = fs::File::open(src)?;
    let mut to = OpenOptions::new().write(true).create_new(true).open(dst)?;
    io::copy(&mut from, &mut to)?;
    to.flush()?;
    Ok(())
}

fn copy_permissions(src: &Path, dst: &Path) -> io::Result<()> {
    let permissions = fs::symlink_metadata(src)?.permissions();
    fs::set_permissions(dst, permissions)
}

/// Löscht Datei, Verzeichnis oder Symlink. Directory-Symlinks/Junctions
/// unter Windows über `remove_dir`, nicht `remove_file`.
pub fn remove_entry(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt;
            if file_type.is_symlink_dir() {
                return fs::remove_dir(path);
            }
        }
        return fs::remove_file(path);
    }
    if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        copy_dir_contents, copy_file_exclusive, copy_recursively, is_physically_under, CopyReport,
    };
    use std::fs;
    use tempfile::TempDir;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn exclusive_copy_refuses_existing_destination() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src.txt");
        let dst = temp.path().join("dst.txt");
        fs::write(&src, "new").unwrap();
        fs::write(&dst, "old").unwrap();
        let error = copy_file_exclusive(&src, &dst).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&dst).unwrap(), "old");
    }

    #[test]
    fn exclusive_copy_does_not_follow_dangling_symlink() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src.txt");
        let dst = temp.path().join("dst");
        let outside = temp.path().join("outside.txt");
        fs::write(&src, "payload").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &dst).unwrap();
            let error = copy_file_exclusive(&src, &dst).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
            assert!(!outside.exists());
        }
        #[cfg(not(unix))]
        {
            let _ = (dst, outside);
        }
    }

    #[test]
    fn recursive_copy_preserves_inner_symlink_and_does_not_follow() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src");
        let dst = temp.path().join("dst");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("file.txt"), "hello").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(src.join("file.txt"), src.join("link.txt")).unwrap();
            let report = copy_recursively(&src, &dst).unwrap();
            assert!(report.skipped_symlinks.is_empty());
            assert_eq!(fs::read_to_string(dst.join("file.txt")).unwrap(), "hello");
            let meta = fs::symlink_metadata(dst.join("link.txt")).unwrap();
            assert!(meta.file_type().is_symlink());
            assert_eq!(
                fs::read_link(dst.join("link.txt")).unwrap(),
                src.join("file.txt")
            );
        }
        #[cfg(not(unix))]
        {
            let report = copy_recursively(&src, &dst).unwrap();
            assert!(report.skipped_symlinks.is_empty());
            assert_eq!(fs::read_to_string(dst.join("file.txt")).unwrap(), "hello");
        }
    }

    #[test]
    fn copy_dir_contents_stops_on_child_collision_and_keeps_prior_files() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src");
        let dst = temp.path().join("dst");
        fs::create_dir(&src).unwrap();
        fs::create_dir(&dst).unwrap();
        fs::write(src.join("a.txt"), "A").unwrap();
        fs::write(src.join("b.txt"), "B").unwrap();
        fs::write(dst.join("b.txt"), "old").unwrap();
        let error = copy_dir_contents(&src, &dst).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(dst.join("b.txt")).unwrap(), "old");
        assert!(src.join("a.txt").exists());
    }

    #[test]
    fn report_is_complete_only_without_skipped_links() {
        assert!(CopyReport::default().is_complete());
        assert!(!CopyReport {
            skipped_symlinks: vec!["/a/link".into()],
        }
        .is_complete());
    }

    #[test]
    fn physically_under_follows_symlink_into_source() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src");
        let sub = src.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let alias = temp.path().join("alias");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&sub, &alias).unwrap();
            assert!(is_physically_under(&alias, &src));
            assert!(!is_physically_under(&alias, &temp.path().join("other")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn copy_preserves_file_and_dir_permissions() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("src");
        let dst = temp.path().join("dst");
        fs::create_dir(&src).unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o700)).unwrap();
        let file = src.join("run.sh");
        fs::write(&file, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        copy_recursively(&src, &dst).unwrap();
        let dir_mode = fs::metadata(&dst).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(dst.join("run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
        assert_eq!(file_mode, 0o755);
    }
}
