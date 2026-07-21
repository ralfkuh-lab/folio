//! Command-Palette Datei-Quelle: einmaliger rekursiver Walk über Pin-Wurzeln.
//! Spec: `docs/spec-command-palette.md` (P2).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::search::{resolve_scope, SearchScope};
use crate::vault::classify_entry;
use crate::workspace::PinnedItem;

/// Deckel für gerenderte Datei-Einträge (Spec).
pub const PALETTE_FILES_CAP: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteFileEntry {
    /// Absoluter Pfad, Forward-Slash-normalisiert.
    pub path: String,
    /// Dateiname (letzte Komponente).
    pub name: String,
    /// Relativ zur Pin-Wurzel (POSIX-Slashes); bei Datei-Pins = Dateiname.
    pub relative: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteFilesResponse {
    pub files: Vec<PaletteFileEntry>,
    pub truncated: bool,
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

fn relative_to(root: &Path, file: &Path) -> String {
    match file.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => file_name_of(file),
    }
}

/// Sammelt Dateien aus allen Pin-Wurzeln (Overlap-Dedup via [`resolve_scope`]).
///
/// - Ordner-Pins: rekursiver `read_dir`-Walk, hidden sichtbar, `.git` skip,
///   Link-Dirs nicht betreten.
/// - Datei-Pins: direkt als Eintrag (`relative` = Dateiname), sofern nicht
///   schon über einen Walk-Root gesehen.
/// - Deckel [`PALETTE_FILES_CAP`] → `truncated = true`, kein stilles Kappen
///   ohne Flag.
pub fn collect_palette_files(pinned: &[PinnedItem]) -> PaletteFilesResponse {
    collect_palette_files_capped(pinned, PALETTE_FILES_CAP)
}

/// Test-/interne Variante mit konfigurierbarem Deckel.
pub fn collect_palette_files_capped(pinned: &[PinnedItem], cap: usize) -> PaletteFilesResponse {
    let roots = resolve_scope(pinned, &SearchScope::Vault);
    let mut files: Vec<PaletteFileEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut truncated = false;

    for dir in &roots.dirs {
        if truncated {
            break;
        }
        walk_dir(dir, dir, &mut files, &mut seen, &mut truncated, cap);
    }

    for file in &roots.files {
        if truncated {
            break;
        }
        if files.len() >= cap {
            truncated = true;
            break;
        }
        if !file.is_file() {
            continue;
        }
        let norm = normalize_path(file);
        if !seen.insert(norm.clone()) {
            continue;
        }
        let name = file_name_of(file);
        files.push(PaletteFileEntry {
            path: norm,
            name: name.clone(),
            relative: name,
        });
    }

    PaletteFilesResponse { files, truncated }
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    out: &mut Vec<PaletteFileEntry>,
    seen: &mut HashSet<String>,
    truncated: &mut bool,
    cap: usize,
) {
    if *truncated {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    // Deterministische Reihenfolge für Tests und stabile UI.
    let mut paths: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
    paths.sort();

    for path in paths {
        if out.len() >= cap {
            *truncated = true;
            return;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == ".git" {
            continue;
        }
        let info = classify_entry(&path);
        if info.is_directory {
            if info.is_link {
                continue;
            }
            walk_dir(root, &path, out, seen, truncated, cap);
            if *truncated {
                return;
            }
            continue;
        }
        // Datei (inkl. Symlink-auf-Datei: is_directory=false)
        let norm = normalize_path(&path);
        if !seen.insert(norm.clone()) {
            continue;
        }
        out.push(PaletteFileEntry {
            path: norm,
            name: file_name_of(&path),
            relative: relative_to(root, &path),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn pin_dir(p: &Path) -> PinnedItem {
        PinnedItem {
            path: normalize_path(p),
            is_directory: true,
        }
    }

    fn pin_file(p: &Path) -> PinnedItem {
        PinnedItem {
            path: normalize_path(p),
            is_directory: false,
        }
    }

    #[test]
    fn relative_paths_posix_under_pin_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "a/b/note.md", "# n\n");
        write(root, "readme.md", "# r\n");

        let res = collect_palette_files(&[pin_dir(root)]);
        assert!(!res.truncated);
        let by_name: std::collections::HashMap<_, _> =
            res.files.iter().map(|f| (f.name.as_str(), f)).collect();
        assert_eq!(by_name["note.md"].relative, "a/b/note.md");
        assert_eq!(by_name["readme.md"].relative, "readme.md");
        assert!(by_name["note.md"]
            .path
            .replace('\\', "/")
            .ends_with("a/b/note.md"));
        assert!(!by_name["note.md"].path.contains('\\'));
    }

    #[test]
    fn file_pin_relative_is_basename() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("solo.md");
        fs::write(&file, "# s\n").unwrap();
        let res = collect_palette_files(&[pin_file(&file)]);
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].name, "solo.md");
        assert_eq!(res.files[0].relative, "solo.md");
        assert_eq!(res.files[0].path, normalize_path(&file));
    }

    #[test]
    fn skips_git_dir_contents() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "visible.md", "# v\n");
        write(root, ".git/hooks/hook.md", "# hidden\n");
        write(root, ".git/config", "x\n");

        let res = collect_palette_files(&[pin_dir(root)]);
        let names: Vec<_> = res.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"visible.md"));
        assert!(!names.contains(&"hook.md"));
        assert!(!names.contains(&"config"));
    }

    #[test]
    fn skips_symlink_directories() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // Ziel liegt AUSSERHALB der Pin-Wurzel — nur über den Symlink erreichbar.
        let outside = TempDir::new().unwrap();
        write(outside.path(), "inside.md", "# i\n");
        write(root, "top.md", "# t\n");
        let link = root.join("link_dir");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        }
        #[cfg(not(unix))]
        {
            let _ = (link, outside);
            return;
        }

        let res = collect_palette_files(&[pin_dir(root)]);
        let names: Vec<_> = res.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"top.md"));
        // Inhalt hinter dem Link-Dir darf nicht betreten werden
        assert!(!names.contains(&"inside.md"));
    }

    #[test]
    fn nested_dir_pins_dedup_via_resolve_scope() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let child = root.join("child");
        write(&child, "only.md", "# o\n");
        write(root, "root.md", "# r\n");

        // Parent + nested child pin — resolve_scope klappt child ein.
        let res = collect_palette_files(&[pin_dir(root), pin_dir(&child)]);
        let paths: Vec<_> = res.files.iter().map(|f| f.path.as_str()).collect();
        // each file once
        assert_eq!(paths.iter().filter(|p| p.ends_with("only.md")).count(), 1);
        assert_eq!(paths.iter().filter(|p| p.ends_with("root.md")).count(), 1);
        // relative of nested file is under parent root
        let only = res.files.iter().find(|f| f.name == "only.md").unwrap();
        assert_eq!(only.relative, "child/only.md");
    }

    #[test]
    fn file_pin_under_dir_pin_appears_once() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "both.md", "# b\n");
        let file = root.join("both.md");

        let res = collect_palette_files(&[pin_dir(root), pin_file(&file)]);
        assert_eq!(res.files.iter().filter(|f| f.name == "both.md").count(), 1);
        // Walk gewinnt für relative (unter Root)
        let entry = res.files.iter().find(|f| f.name == "both.md").unwrap();
        assert_eq!(entry.relative, "both.md");
    }

    #[test]
    fn cap_sets_truncated_and_limits_count() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        for i in 0..10 {
            write(root, &format!("f{i:02}.md"), "#\n");
        }
        let res = collect_palette_files_capped(&[pin_dir(root)], 5);
        assert!(res.truncated);
        assert_eq!(res.files.len(), 5);
    }

    #[test]
    fn exact_cap_without_extra_is_not_truncated() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        for i in 0..3 {
            write(root, &format!("f{i}.md"), "#\n");
        }
        let res = collect_palette_files_capped(&[pin_dir(root)], 3);
        assert!(!res.truncated);
        assert_eq!(res.files.len(), 3);
    }

    #[test]
    fn path_normalization_forward_slashes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "x/y.md", "#\n");
        let res = collect_palette_files(&[pin_dir(root)]);
        for f in &res.files {
            assert!(!f.path.contains('\\'), "path={}", f.path);
            assert!(!f.relative.contains('\\'), "relative={}", f.relative);
        }
    }

    #[test]
    fn dead_pins_are_silent() {
        let res = collect_palette_files(&[PinnedItem {
            path: "/nonexistent/path/for/palette".into(),
            is_directory: true,
        }]);
        assert!(res.files.is_empty());
        assert!(!res.truncated);
    }

    #[test]
    fn includes_hidden_files_outside_git() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, ".env", "x=1\n");
        write(root, "normal.md", "#\n");
        let res = collect_palette_files(&[pin_dir(root)]);
        let names: Vec<_> = res.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&".env"));
        assert!(names.contains(&"normal.md"));
    }
}
