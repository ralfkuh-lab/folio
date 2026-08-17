//! Tauri-freie Pfad-Migration: Präfix-Rewrite auf Segmentgrenze.
//!
//! Ein nacktes `starts_with(root)` würde `/a/notizen-alt` mitziehen, wenn
//! `/a/notizen` verschoben wird. Derselbe Fehler steckt beim Git-Filter
//! (CLAUDE.md) — hier gilt dieselbe Segment-Regel.

/// Gemeinsame lexikalische Normalform: Backslashes → `/`, Trailing-Slashes
/// entfernt (Root `"/"` bleibt erhalten).
pub fn normalize(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

/// `path` liegt unter `root` (inklusive Gleichheit), Segmentgrenze.
pub fn is_under(path: &str, root: &str) -> bool {
    let path = normalize(path);
    let root = normalize(root);
    if root.is_empty() {
        return path.is_empty();
    }
    path == root || path.starts_with(&format!("{root}/"))
}

/// Liefert den migrierten Pfad, falls `path` unter `old_root` liegt.
pub fn remap(path: &str, old_root: &str, new_root: &str) -> Option<String> {
    let path = normalize(path);
    let old_root = normalize(old_root);
    let new_root = normalize(new_root);
    if old_root.is_empty() {
        return if path.is_empty() {
            Some(new_root)
        } else {
            None
        };
    }
    if path == old_root {
        Some(new_root)
    } else if path.starts_with(&format!("{old_root}/")) {
        Some(format!("{new_root}{}", &path[old_root.len()..]))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{is_under, normalize, remap};

    #[test]
    fn remap_identity_when_path_equals_root() {
        assert_eq!(
            remap("/a/notizen", "/a/notizen", "/a/notes").as_deref(),
            Some("/a/notes")
        );
    }

    #[test]
    fn remap_rewrites_descendant_on_segment_boundary() {
        assert_eq!(
            remap("/a/notizen/x.md", "/a/notizen", "/a/notes").as_deref(),
            Some("/a/notes/x.md")
        );
        assert_eq!(
            remap("/a/notizen/sub/y.md", "/a/notizen", "/b").as_deref(),
            Some("/b/sub/y.md")
        );
    }

    #[test]
    fn remap_does_not_pull_sibling_with_shared_prefix() {
        assert_eq!(remap("/a/notizen-alt", "/a/notizen", "/a/notes"), None);
        assert_eq!(remap("/a/notizen-alt/x.md", "/a/notizen", "/a/notes"), None);
        assert!(!is_under("/a/notizen-alt", "/a/notizen"));
    }

    #[test]
    fn remap_returns_none_for_unrelated_path() {
        assert_eq!(remap("/other/file.md", "/a/notizen", "/a/notes"), None);
        assert_eq!(remap("/a", "/a/notizen", "/a/notes"), None);
    }

    #[test]
    fn remap_normalizes_backslash_input() {
        assert_eq!(
            remap(r"C:\vault\notes\a.md", r"C:\vault\notes", r"C:\vault\n").as_deref(),
            Some("C:/vault/n/a.md")
        );
        assert_eq!(
            remap(r"C:\vault\notes-alt", r"C:\vault\notes", r"C:\vault\n"),
            None
        );
        assert!(is_under(r"C:\vault\notes\a.md", r"C:\vault\notes"));
    }

    #[test]
    fn is_under_includes_the_root_itself() {
        assert!(is_under("/a/notizen", "/a/notizen"));
        assert!(!is_under("/a/notizen", "/a/notizen/sub"));
    }

    #[test]
    fn normalize_trims_trailing_slashes_but_keeps_root() {
        assert_eq!(normalize("/vault/ordner/"), "/vault/ordner");
        assert_eq!(normalize("/vault/ordner///"), "/vault/ordner");
        assert_eq!(normalize("/"), "/");
        assert_eq!(normalize("///"), "/");
        assert_eq!(normalize(""), "");
        assert_eq!(normalize(r"C:\vault\ordner\"), "C:/vault/ordner");
    }

    #[test]
    fn remap_matches_after_trailing_slash_on_root() {
        assert_eq!(
            remap("/vault/ordner/x.md", "/vault/ordner/", "/vault/neu").as_deref(),
            Some("/vault/neu/x.md")
        );
        assert_eq!(
            remap("/vault/ordner/", "/vault/ordner", "/vault/neu").as_deref(),
            Some("/vault/neu")
        );
        assert!(is_under("/vault/ordner/", "/vault/ordner"));
        assert!(is_under("/vault/ordner/x.md", "/vault/ordner/"));
    }

    #[test]
    fn normalize_makes_backslash_and_slash_forms_equal() {
        assert_eq!(normalize(r"C:\x"), normalize("C:/x"));
    }
}
