use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchInfo {
    pub label: String,
    pub detached: bool,
}

/// Aktiver Branch des Repos, zu dem `dir` gehört, sonst None. Wie
/// `git rev-parse`: liegt in `dir` selbst kein `.git`, wird die
/// Verzeichniskette nach oben durchsucht (gepinnte Unterverzeichnisse
/// eines Repos zeigen so den Branch des umgebenden Repos).
/// detached = true nur bei purem Hex-SHA (Detached HEAD); Tags und andere
/// Refs zählen als nicht-detached.
pub fn branch_of(dir: &Path) -> Option<BranchInfo> {
    let gitdir = head_dir(dir)?;
    let head_path = gitdir.join("HEAD");
    read_head(&head_path)
}

/// Gibt das aufgelöste Git-Verzeichnis zurück, das die HEAD-Datei enthält
/// (für normale Repos: `<repo-root>/.git`; für Worktrees: der aus `gitdir:`
/// aufgelöste Pfad). Sucht ab `dir` aufwärts bis zum Dateisystem-Root;
/// None, wenn kein Ancestor ein Git-Root ist.
pub fn head_dir(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find_map(head_dir_at)
}

/// Wie `head_dir`, aber ohne Aufstieg: prüft nur `dir` selbst.
/// Ein `.git` ohne HEAD-Datei zählt nicht als Repo (wie bei git selbst) —
/// der Aufstieg in `head_dir` läuft dann weiter.
fn head_dir_at(dir: &Path) -> Option<PathBuf> {
    let git = dir.join(".git");
    if !git.exists() {
        return None;
    }
    let resolved = if git.is_dir() {
        git
    } else if git.is_file() {
        // Worktree oder Submodule: "gitdir: <pfad>"
        let content = fs::read_to_string(&git).ok()?;
        parse_gitdir(&content, dir)?
    } else {
        return None;
    };
    if resolved.join("HEAD").is_file() {
        Some(resolved)
    } else {
        None
    }
}

fn parse_gitdir(content: &str, base: &Path) -> Option<PathBuf> {
    let line = content.lines().next()?.trim();
    let p = line.strip_prefix("gitdir:")?.trim();
    if p.is_empty() {
        return None;
    }
    // Backslashes tolerieren (Windows gitdir)
    let p = p.replace('\\', "/");
    let pb = Path::new(&p);
    if pb.is_absolute() {
        Some(pb.to_path_buf())
    } else {
        Some(base.join(pb))
    }
}

fn read_head(head_path: &Path) -> Option<BranchInfo> {
    let s = fs::read_to_string(head_path).ok()?;
    let s = s.trim();
    if let Some(branch) = s.strip_prefix("ref: refs/heads/") {
        if !branch.is_empty() {
            return Some(BranchInfo {
                label: branch.to_string(),
                detached: false,
            });
        }
    } else if let Some(rest) = s.strip_prefix("ref:") {
        let after = rest.trim();
        if !after.is_empty() {
            // letztes Segment oder ganzer Rest (z.B. Tags)
            if let Some(last) = after.rsplit('/').next() {
                if !last.is_empty() {
                    return Some(BranchInfo {
                        label: last.to_string(),
                        detached: false,
                    });
                }
            }
            return Some(BranchInfo {
                label: after.to_string(),
                detached: false,
            });
        }
    } else if s.len() >= 7 && s.chars().take(7).all(|c| c.is_ascii_hexdigit()) {
        // Detached HEAD: erste 7 Zeichen
        return Some(BranchInfo {
            label: s[..7].to_string(),
            detached: true,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn branch_of_normal_repo() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_eq!(
            branch_of(tmp.path()),
            Some(BranchInfo {
                label: "main".to_string(),
                detached: false
            })
        );
    }

    #[test]
    fn branch_of_slash_branch() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        assert_eq!(
            branch_of(tmp.path()),
            Some(BranchInfo {
                label: "feature/x".to_string(),
                detached: false
            })
        );
    }

    #[test]
    fn branch_of_detached_head() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(
            gitdir.join("HEAD"),
            "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n",
        )
        .unwrap();
        let bi = branch_of(tmp.path()).unwrap();
        assert_eq!(bi.label.len(), 7);
        assert!(bi.label.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(bi.detached);
    }

    #[test]
    fn branch_of_gitdir_file_relative() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path().join("work");
        fs::create_dir(&work).unwrap();
        let real_git = tmp.path().join("real.git");
        fs::create_dir(&real_git).unwrap();
        fs::write(real_git.join("HEAD"), "ref: refs/heads/dev\n").unwrap();
        // .git as file with relative gitdir
        fs::write(work.join(".git"), "gitdir: ../real.git\n").unwrap();
        assert_eq!(
            branch_of(&work),
            Some(BranchInfo {
                label: "dev".to_string(),
                detached: false
            })
        );
    }

    #[test]
    fn branch_of_gitdir_file_absolute() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path().join("work");
        fs::create_dir(&work).unwrap();
        let real_git = tmp.path().join("real.git");
        fs::create_dir(&real_git).unwrap();
        fs::write(real_git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let abs = real_git.to_string_lossy().replace('\\', "/");
        fs::write(work.join(".git"), format!("gitdir: {}\n", abs)).unwrap();
        assert_eq!(
            branch_of(&work),
            Some(BranchInfo {
                label: "main".to_string(),
                detached: false
            })
        );
    }

    #[test]
    fn branch_of_no_git() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(branch_of(tmp.path()), None);
    }

    #[test]
    fn branch_of_subdirectory_walks_up() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let sub = tmp.path().join("docs").join("notes");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(
            branch_of(&sub),
            Some(BranchInfo {
                label: "main".to_string(),
                detached: false
            })
        );
        assert_eq!(head_dir(&sub), Some(gitdir));
    }

    #[test]
    fn head_dir_prefers_nearest_ancestor() {
        // Verschachtelte Repos: das innere .git gewinnt (wie git rev-parse).
        let tmp = TempDir::new().unwrap();
        let outer_git = tmp.path().join(".git");
        fs::create_dir(&outer_git).unwrap();
        fs::write(outer_git.join("HEAD"), "ref: refs/heads/outer\n").unwrap();
        let inner = tmp.path().join("inner");
        let inner_git = inner.join(".git");
        fs::create_dir_all(&inner_git).unwrap();
        fs::write(inner_git.join("HEAD"), "ref: refs/heads/inner\n").unwrap();
        let sub = inner.join("src");
        fs::create_dir(&sub).unwrap();
        assert_eq!(head_dir(&sub), Some(inner_git));
        assert_eq!(branch_of(&sub).unwrap().label, "inner");
    }

    #[test]
    fn branch_of_bad_head() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "").unwrap();
        assert_eq!(branch_of(tmp.path()), None);
        fs::write(gitdir.join("HEAD"), "ref: refs/tags/v1.0\n").unwrap();
        // other ref -> last segment, not detached
        assert_eq!(
            branch_of(tmp.path()),
            Some(BranchInfo {
                label: "v1.0".to_string(),
                detached: false
            })
        );
    }

    #[test]
    fn head_dir_normal_and_detached() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_eq!(head_dir(tmp.path()), Some(gitdir.clone()));

        // detached still returns the gitdir
        fs::write(
            gitdir.join("HEAD"),
            "deadbeef1234567890abcdef1234567890abcdef\n",
        )
        .unwrap();
        assert_eq!(head_dir(tmp.path()), Some(gitdir));
    }

    #[test]
    fn head_dir_gitdir_file() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path().join("work");
        fs::create_dir(&work).unwrap();
        let real_git = tmp.path().join("real.git");
        fs::create_dir(&real_git).unwrap();
        fs::write(real_git.join("HEAD"), "ref: refs/heads/dev\n").unwrap();
        fs::write(work.join(".git"), "gitdir: ../real.git\n").unwrap();
        // parse_gitdir keeps lexical join for relatives (no clean); match that
        let expected = work.join("../real.git");
        assert_eq!(head_dir(&work), Some(expected));
    }

    #[test]
    fn head_dir_no_git() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(head_dir(tmp.path()), None);
    }

    #[test]
    fn detached_flag_only_for_hex() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();

        // ref heads -> not detached
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let bi = branch_of(tmp.path()).unwrap();
        assert!(!bi.detached);
        assert_eq!(bi.label, "main");

        // tag ref -> not detached
        fs::write(gitdir.join("HEAD"), "ref: refs/tags/v1.2.3\n").unwrap();
        let bi = branch_of(tmp.path()).unwrap();
        assert!(!bi.detached);
        assert_eq!(bi.label, "v1.2.3");

        // hex -> detached
        fs::write(
            gitdir.join("HEAD"),
            "1234567890abcdef1234567890abcdef12345678\n",
        )
        .unwrap();
        let bi = branch_of(tmp.path()).unwrap();
        assert!(bi.detached);
        assert_eq!(bi.label.len(), 7);
    }
}
