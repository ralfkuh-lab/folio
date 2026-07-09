//! Gitignore-Matching für das Dimmen von Einträgen im Vault-Baum.
//!
//! Verwendet ausschließlich die `ignore`-Crate (ripgrep), speziell
//! `GitignoreBuilder` + `matched_path_or_any_parents`. Kein `WalkBuilder`,
//! kein git-Binary.
//!
//! Aufbau:
//! - Matcher wird pro Verzeichnis-Listing / pro Pin einmal gebaut (billig).
//! - Kein Caching in v1.
//! - Kein eigener Watcher: Änderungen an .gitignore werden durch bestehende
//!   Refresh-Pfade (expand, vault:dir_changed via VaultWatcher) sichtbar.
//!   Ein editiertes .gitignore in einem aufgeklappten Ordner triggert
//!   ohnehin ein Re-Render der Kinder.
//!
//! Bewusst weggelassen (wie in Spec):
//! - globales core.excludesFile (würde git-config-Parsing brauchen)
//! - Index-Status (getrackte Dateien trotz Ignore-Regel): wir matchen rein
//!   auf Patterns; für Vault-Darstellung akzeptabel.

use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

#[derive(Debug)]
pub struct IgnoreMatcher {
    root: PathBuf,
    gi: Gitignore,
}

/// Baut den Matcher für das Repo, zu dem `dir` gehört.
/// None, wenn `dir` in keinem Repo liegt.
pub fn matcher_for(dir: &Path) -> Option<IgnoreMatcher> {
    let root = crate::git_branch::repo_root(dir)?;

    let mut builder = GitignoreBuilder::new(&root);

    // .gitignore-Dateien vom Root abwärts bis `dir` hinzufügen (nur
    // existierende; Reihenfolge Root → tiefer, damit tiefere Regeln
    // später gewinnen — git-Semantik).
    let mut gis: Vec<PathBuf> = vec![];
    for anc in dir.ancestors() {
        if !anc.starts_with(&root) {
            break;
        }
        let gi_path = anc.join(".gitignore");
        if gi_path.is_file() {
            gis.push(gi_path);
        }
        if anc == root {
            break;
        }
    }
    gis.reverse();
    for gi_path in gis {
        let _ = builder.add(&gi_path);
    }

    // Zusätzlich <head_dir>/info/exclude (deckt Worktrees ab).
    if let Some(hd) = crate::git_branch::head_dir(&root) {
        let exclude = hd.join("info").join("exclude");
        if exclude.is_file() {
            let _ = builder.add(&exclude);
        }
    }

    let gi = builder.build().ok()?;
    Some(IgnoreMatcher { root, gi })
}

impl IgnoreMatcher {
    /// true, wenn `path` (unterhalb des Repo-Roots) gitignored ist.
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        if !path.starts_with(&self.root) {
            return false;
        }
        match self.gi.matched_path_or_any_parents(path, is_dir) {
            ignore::Match::Ignore(_) => true,
            ignore::Match::Whitelist(_) => false,
            ignore::Match::None => false,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn no_repo_returns_none() {
        let tmp = TempDir::new().unwrap();
        assert!(matcher_for(tmp.path()).is_none());
    }

    #[test]
    fn basic_patterns() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // init fake repo
        let git = root.join(".git");
        fs::create_dir(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("foo.log"), "").unwrap();
        fs::write(root.join("keep.txt"), "").unwrap();

        let m = matcher_for(root).unwrap();
        assert!(m.is_ignored(&root.join("target"), true));
        assert!(m.is_ignored(&root.join("target").join("foo.o"), false));
        assert!(m.is_ignored(&root.join("foo.log"), false));
        assert!(!m.is_ignored(&root.join("keep.txt"), false));
        assert!(!m.is_ignored(&root.join("other.txt"), false));
        assert_eq!(m.root(), root);
    }

    #[test]
    fn negation() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let git = root.join(".git");
        fs::create_dir(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        fs::write(root.join(".gitignore"), "*.log\n!keep.log\n").unwrap();
        fs::write(root.join("foo.log"), "").unwrap();
        fs::write(root.join("keep.log"), "").unwrap();

        let m = matcher_for(root).unwrap();
        assert!(m.is_ignored(&root.join("foo.log"), false));
        assert!(!m.is_ignored(&root.join("keep.log"), false));
    }

    #[test]
    fn nested_gitignore() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let git = root.join(".git");
        fs::create_dir(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        fs::write(root.join(".gitignore"), "root.log\n").unwrap();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join(".gitignore"), "sub.log\n").unwrap();
        fs::write(root.join("root.log"), "").unwrap();
        fs::write(sub.join("sub.log"), "").unwrap();
        fs::write(sub.join("other.log"), "").unwrap();

        let m = matcher_for(&sub).unwrap();
        assert!(m.is_ignored(&root.join("root.log"), false));
        // sub rule only for inside sub
        assert!(m.is_ignored(&sub.join("sub.log"), false));
        assert!(!m.is_ignored(&sub.join("other.log"), false)); // not matched by sub, nor root
                                                               // root rule (unanchored) applies recursively to same-named file deeper
        assert!(m.is_ignored(&sub.join("root.log"), false));
    }

    #[test]
    fn ignored_parent_dir_covers_children() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let git = root.join(".git");
        fs::create_dir(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        fs::write(root.join(".gitignore"), "ign/\n").unwrap();
        let ign = root.join("ign");
        fs::create_dir(&ign).unwrap();
        fs::write(ign.join("child.txt"), "").unwrap();

        let m = matcher_for(root).unwrap();
        assert!(m.is_ignored(&ign, true));
        assert!(m.is_ignored(&ign.join("child.txt"), false));
    }

    #[test]
    fn info_exclude_is_considered() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let git = root.join(".git");
        fs::create_dir(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let info = git.join("info");
        fs::create_dir(&info).unwrap();
        fs::write(info.join("exclude"), "excluded.md\n").unwrap();

        fs::write(root.join("excluded.md"), "").unwrap();
        fs::write(root.join("normal.md"), "").unwrap();

        let m = matcher_for(root).unwrap();
        assert!(m.is_ignored(&root.join("excluded.md"), false));
        assert!(!m.is_ignored(&root.join("normal.md"), false));
    }

    #[test]
    fn outside_root_is_not_ignored() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let git = root.join(".git");
        fs::create_dir(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(root.join(".gitignore"), "x\n").unwrap();

        let outside = tmp.path().parent().unwrap().join("outside.txt");
        // ensure not under root
        let m = matcher_for(root).unwrap();
        assert!(!m.is_ignored(&outside, false));
    }
}
