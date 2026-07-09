use std::fs;
use std::path::{Path, PathBuf};

/// Aktiver Branch, wenn `dir` selbst ein Git-Repo-Root ist, sonst None.
pub fn branch_of(dir: &Path) -> Option<String> {
    let git = dir.join(".git");
    if !git.exists() {
        return None;
    }
    if git.is_dir() {
        read_head(&git.join("HEAD"))
    } else if git.is_file() {
        // Worktree oder Submodule: "gitdir: <pfad>"
        let content = fs::read_to_string(&git).ok()?;
        let gitdir = parse_gitdir(&content, dir)?;
        read_head(&gitdir.join("HEAD"))
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

fn read_head(head_path: &Path) -> Option<String> {
    let s = fs::read_to_string(head_path).ok()?;
    let s = s.trim();
    if let Some(branch) = s.strip_prefix("ref: refs/heads/") {
        if !branch.is_empty() {
            return Some(branch.to_string());
        }
    } else if let Some(rest) = s.strip_prefix("ref:") {
        let after = rest.trim();
        if !after.is_empty() {
            // letztes Segment oder ganzer Rest
            if let Some(last) = after.rsplit('/').next() {
                if !last.is_empty() {
                    return Some(last.to_string());
                }
            }
            return Some(after.to_string());
        }
    } else if s.len() >= 7 && s.chars().take(7).all(|c| c.is_ascii_hexdigit()) {
        // Detached HEAD: erste 7 Zeichen
        return Some(s[..7].to_string());
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
        assert_eq!(branch_of(tmp.path()), Some("main".to_string()));
    }

    #[test]
    fn branch_of_slash_branch() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        assert_eq!(branch_of(tmp.path()), Some("feature/x".to_string()));
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
        let b = branch_of(tmp.path()).unwrap();
        assert_eq!(b.len(), 7);
        assert!(b.chars().all(|c| c.is_ascii_hexdigit()));
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
        assert_eq!(branch_of(&work), Some("dev".to_string()));
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
        assert_eq!(branch_of(&work), Some("main".to_string()));
    }

    #[test]
    fn branch_of_no_git() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(branch_of(tmp.path()), None);
    }

    #[test]
    fn branch_of_bad_head() {
        let tmp = TempDir::new().unwrap();
        let gitdir = tmp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "").unwrap();
        assert_eq!(branch_of(tmp.path()), None);
        fs::write(gitdir.join("HEAD"), "ref: refs/tags/v1.0\n").unwrap();
        // other ref -> last segment
        assert_eq!(branch_of(tmp.path()), Some("v1.0".to_string()));
    }
}
