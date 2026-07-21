//! Vault-Tree-Filter — Lazy-Bausteine (nur Markdown-Probe).
//!
//! Der Namensfilter ist clientseitig (R3). Dieses Modul hält die
//! `dir_contains_markdown`-Probe für den Backend-Lazy-Typ-Filter.
//! Spec: [`docs/spec-vault-filter.md`].

use std::fs;
use std::path::Path;

use crate::file_kind::{classify, FileKind};
use crate::vault::classify_entry;

/// Kostendeckel für [`dir_contains_markdown`]: nach so vielen
/// besuchten Einträgen bricht die Probe ab und liefert `true`.
pub const DIR_CONTAINS_MD_VISIT_CAP: usize = 2_000;

/// Rekursive Probe „enthält irgendwo Markdown?" mit Early-Exit und
/// Kostendeckel. `.git` und Link-Verzeichnisse werden übersprungen
/// (Loop-sicher ohne visited-Set).
pub fn dir_contains_markdown(dir: &Path) -> bool {
    let mut visits = 0usize;
    dir_contains_markdown_walk(dir, &mut visits)
}

fn dir_contains_markdown_walk(dir: &Path, visits: &mut usize) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return false,
    };
    for entry in entries.filter_map(Result::ok) {
        *visits += 1;
        if *visits >= DIR_CONTAINS_MD_VISIT_CAP {
            return true;
        }
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == ".git" {
            continue;
        }
        let info = classify_entry(&path);
        if info.is_directory {
            // Nicht in Link-Verzeichnisse absteigen (Symlink-Loops).
            if info.is_link {
                continue;
            }
            if dir_contains_markdown_walk(&path, visits) {
                return true;
            }
        } else if classify(&path.to_string_lossy()) == FileKind::Markdown {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn init_git(root: &Path) {
        let git = root.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    fn data_path_attr(p: &Path) -> String {
        format!(r#"data-path="{}""#, p.to_string_lossy().replace('\\', "/"))
    }

    fn norm(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn dir_contains_markdown_early_exit_cost_cap_and_git_skip() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let with_md = root.join("with_md");
        write(&with_md, "a/b/c/note.md", "# n\n");
        write(&with_md, "a/b/other.txt", "t\n");
        assert!(
            dir_contains_markdown(&with_md),
            "verschachteltes MD muss true liefern"
        );

        let only_txt = root.join("only_txt");
        write(&only_txt, "a.txt", "x\n");
        write(&only_txt, "sub/b.txt", "y\n");
        assert!(!dir_contains_markdown(&only_txt), "ohne MD → false");

        let git_only = root.join("git_only");
        init_git(&git_only);
        write(&git_only, ".git/hooks/x.md", "# g\n");
        write(&git_only, "plain.txt", "p\n");
        assert!(
            !dir_contains_markdown(&git_only),
            ".git-Inhalt darf die Probe nicht true machen"
        );

        let huge = root.join("huge");
        fs::create_dir_all(&huge).unwrap();
        for i in 0..(DIR_CONTAINS_MD_VISIT_CAP + 10) {
            fs::write(huge.join(format!("n{i:04}.txt")), b"x").unwrap();
        }
        assert!(
            dir_contains_markdown(&huge),
            "Kostendeckel muss true liefern (falsches Anzeigen harmlos)"
        );
    }

    #[test]
    fn lazy_mode_type_filter_hides_non_md_and_mdless_dirs() {
        use crate::vault::Vault;

        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "note.md", "# n\n");
        write(root, "data.json", "{}\n");
        write(root, "empty_folder/.keep", "");
        fs::create_dir(root.join("truly_empty")).unwrap();
        write(root, "md_folder/a.md", "# a\n");
        write(root, "md_folder/b.txt", "b\n");

        let vault = Vault::new();
        let path = norm(root);
        let html = vault
            .build_dir_children_html(&path, true)
            .expect("read_dir ok");

        assert!(
            html.contains(&data_path_attr(&root.join("note.md"))),
            "MD-Datei muss sichtbar sein; html={html}"
        );
        assert!(
            !html.contains(&data_path_attr(&root.join("data.json"))),
            "Non-MD-Datei muss ausgeblendet sein"
        );
        assert!(
            !html.contains(&data_path_attr(&root.join("empty_folder")))
                && !html.contains(&data_path_attr(&root.join("truly_empty"))),
            "MD-lose Ordner müssen ausgeblendet sein"
        );
        assert!(
            html.contains(&data_path_attr(&root.join("md_folder"))),
            "Ordner mit MD muss sichtbar sein"
        );
        let all = vault
            .build_dir_children_html(&path, false)
            .expect("read_dir ok");
        assert!(all.contains(&data_path_attr(&root.join("data.json"))));
        assert!(all.contains(&data_path_attr(&root.join("note.md"))));
    }

    #[cfg(unix)]
    #[test]
    fn dir_contains_markdown_does_not_follow_symlink_loops() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        std::os::unix::fs::symlink(&b, a.join("loop")).unwrap();
        std::os::unix::fs::symlink(&a, b.join("loop")).unwrap();
        write(root, "plain.txt", "x\n");
        assert!(
            !dir_contains_markdown(root),
            "Symlink-Loops duerfen die Probe nicht true machen ohne MD"
        );
        write(root, "note.md", "# n\n");
        assert!(dir_contains_markdown(root));
    }
}
