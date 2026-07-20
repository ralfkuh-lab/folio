//! Vault-Tree-Filter (Namensfilter + „nur Markdown").
//!
//! DOM-frei testbar. Spec: [`docs/spec-vault-filter.md`], Etappe F1.
//! Tests in `mod tests` sind unantastbar (TDD-Abnahme); neue Tests additiv.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::file_kind::{classify, FileKind};
use crate::search::{resolve_scope, SearchScope};
use crate::vault::{classify_entry, EntryInfo, Vault};
use crate::workspace::PinnedItem;

/// Node-Cap im gerenderten Filterbaum (Spec A5). Darüber: `truncated: true`.
pub const MAX_FILTER_NODES: usize = 2_000;

/// Sicherheits-Deckel für Phase-1-Walk (besuchte Einträge, Spec A5).
pub const MAX_FILTER_WALK_VISITS: usize = 50_000;

/// Kostendeckel für [`dir_contains_markdown`] (Spec A4): nach so vielen
/// besuchten Einträgen bricht die Probe ab und liefert `true`.
pub const DIR_CONTAINS_MD_VISIT_CAP: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultFilterOptions {
    /// Roher Filtertext; leer = Match-all (kein Namensfilter, Spec A2).
    /// Namensmatch: case-insensitive Substring via `to_lowercase` (kein
    /// volles Unicode-Case-Folding, keine NFC-Normalisierung).
    pub query: String,
    pub markdown_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultFilterResult {
    /// children-HTML der Pinned-Section (gestutzt, voll aufgeklappt).
    pub html: String,
    pub truncated: bool,
    pub node_count: usize,
}

/// Zwischenknoten der Phase-1-Struktur (vor HTML-Render).
enum FilterNode {
    File {
        path: PathBuf,
        info: EntryInfo,
        ignored: bool,
    },
    /// Ordner (force_open) oder Link-Dir als Blatt (!force_open, leere Kinder).
    Dir {
        path: PathBuf,
        info: EntryInfo,
        ignored: bool,
        children: Vec<FilterNode>,
        force_open: bool,
        /// Pin-Wurzeln bekommen Branch-Badge.
        with_branch: bool,
    },
}

struct WalkCtx {
    query_lower: String,
    markdown_only: bool,
    walk_visits: usize,
    walk_truncated: bool,
    /// Memo nur innerhalb eines `run_vault_filter` (FX7); Lazy bleibt ungecacht.
    md_memo: HashMap<PathBuf, bool>,
}

impl WalkCtx {
    fn note_visit(&mut self) -> bool {
        if self.walk_truncated {
            return false;
        }
        self.walk_visits += 1;
        if self.walk_visits >= MAX_FILTER_WALK_VISITS {
            self.walk_truncated = true;
            return false;
        }
        true
    }

    fn contains_md(&mut self, dir: &Path) -> bool {
        if let Some(&v) = self.md_memo.get(dir) {
            return v;
        }
        let v = dir_contains_markdown(dir);
        self.md_memo.insert(dir.to_path_buf(), v);
        v
    }
}

/// Filter-Render-Modus: walkt Pins rekursiv, liefert gestutzten Baum.
/// `expanded_dirs` am `vault` bleibt unverändert (Spec A1/A2).
///
/// Zweiphasig (FX6): (1) gestutzte Zwischenstruktur ohne Render-Cap,
/// Walk-Deckel `MAX_FILTER_WALK_VISITS`; (2) HTML-Render mit Node-Cap
/// `MAX_FILTER_NODES`.
pub fn run_vault_filter(
    pinned: &[PinnedItem],
    vault: &Vault,
    opts: &VaultFilterOptions,
) -> VaultFilterResult {
    let roots = resolve_scope(pinned, &SearchScope::Vault);
    let dir_roots: HashSet<String> = roots.dirs.iter().map(|p| normalize_path(p)).collect();
    let file_roots: HashSet<String> = roots.files.iter().map(|p| normalize_path(p)).collect();

    let mut walk = WalkCtx {
        query_lower: opts.query.to_lowercase(),
        markdown_only: opts.markdown_only,
        walk_visits: 0,
        walk_truncated: false,
        md_memo: HashMap::new(),
    };

    let mut roots_nodes: Vec<FilterNode> = Vec::new();
    for pin in pinned {
        if walk.walk_truncated {
            break;
        }
        let path = PathBuf::from(normalize_str(&pin.path));
        if pin.is_directory {
            let key = normalize_path(&path);
            if !dir_roots.contains(&key) {
                continue;
            }
            if let Some(node) = collect_pin_dir(&path, &mut walk) {
                roots_nodes.push(node);
            }
        } else {
            let key = normalize_path(&path);
            if !file_roots.contains(&key) {
                continue;
            }
            if let Some(node) = collect_pin_file(&path, &mut walk) {
                roots_nodes.push(node);
            }
        }
    }

    let mut node_count = 0usize;
    let mut render_truncated = false;
    let html = render_nodes(&roots_nodes, vault, &mut node_count, &mut render_truncated);

    VaultFilterResult {
        html,
        truncated: walk.walk_truncated || render_truncated,
        node_count,
    }
}

/// Rekursive Probe „enthält irgendwo Markdown?" mit Early-Exit und
/// Kostendeckel (Spec A4). `.git` und Link-Verzeichnisse werden übersprungen
/// (FX5 — Loop-sicher ohne visited-Set).
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
            // FX5: nicht in Link-Verzeichnisse absteigen (Symlink-Loops).
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

fn collect_pin_file(path: &Path, walk: &mut WalkCtx) -> Option<FilterNode> {
    if !path.is_file() {
        return None;
    }
    if !walk.note_visit() {
        return None;
    }
    let name = entry_name(path);
    if !name_matches(&name, &walk.query_lower) {
        return None;
    }
    if walk.markdown_only && classify(&path.to_string_lossy()) != FileKind::Markdown {
        return None;
    }
    let info = classify_entry(path);
    let parent = path.parent().unwrap_or(path);
    let matcher = crate::git_ignore::matcher_for(parent);
    let ignored = matcher.as_ref().is_some_and(|m| m.is_ignored(path, false));
    Some(FilterNode::File {
        path: path.to_path_buf(),
        info,
        ignored,
    })
}

fn collect_pin_dir(path: &Path, walk: &mut WalkCtx) -> Option<FilterNode> {
    if !path.is_dir() {
        return None;
    }
    if !walk.note_visit() {
        return None;
    }
    let info = classify_entry(path);
    let name = entry_name(path);
    let name_match = name_matches(&name, &walk.query_lower);
    let parent = path.parent().unwrap_or(path);
    let matcher = crate::git_ignore::matcher_for(parent);
    let ignored = matcher.as_ref().is_some_and(|m| m.is_ignored(path, true));

    // FX5: als Ordner gepinnte Link-Wurzel = Blatt (nicht rekursiv walken).
    if info.is_link {
        if !name_match {
            return None;
        }
        if walk.markdown_only && !walk.contains_md(path) {
            return None;
        }
        return Some(FilterNode::Dir {
            path: path.to_path_buf(),
            info,
            ignored,
            children: Vec::new(),
            force_open: false,
            with_branch: true,
        });
    }

    if name_match {
        if walk.markdown_only && !walk.contains_md(path) {
            return None;
        }
        let children = collect_children(path, walk, false);
        Some(FilterNode::Dir {
            path: path.to_path_buf(),
            info,
            ignored,
            children,
            force_open: true,
            with_branch: true,
        })
    } else {
        let children = collect_children(path, walk, true);
        if children.is_empty() {
            return None;
        }
        Some(FilterNode::Dir {
            path: path.to_path_buf(),
            info,
            ignored,
            children,
            force_open: true,
            with_branch: true,
        })
    }
}

/// Phase-1: Kinder-Struktur (kein Render-Cap).
fn collect_children(dir: &Path, walk: &mut WalkCtx, apply_name_filter: bool) -> Vec<FilterNode> {
    let mut out = Vec::new();
    let entries = list_dir_sorted(dir);
    let matcher = crate::git_ignore::matcher_for(dir);

    for (path, info) in entries {
        if walk.walk_truncated {
            break;
        }
        if !walk.note_visit() {
            break;
        }
        let ignored = matcher
            .as_ref()
            .is_some_and(|m| m.is_ignored(&path, info.is_directory));

        if info.is_directory {
            let name = entry_name(&path);
            let name_match = !apply_name_filter || name_matches(&name, &walk.query_lower);

            if info.is_link {
                // Ordner-Links: Blatt-Knoten (Spec A3 / FX5).
                if !name_match {
                    continue;
                }
                if walk.markdown_only && !walk.contains_md(&path) {
                    continue;
                }
                out.push(FilterNode::Dir {
                    path,
                    info,
                    ignored,
                    children: Vec::new(),
                    force_open: false,
                    with_branch: false,
                });
                continue;
            }

            if name_match {
                if walk.markdown_only && !walk.contains_md(&path) {
                    continue;
                }
                let children = collect_children(&path, walk, false);
                out.push(FilterNode::Dir {
                    path,
                    info,
                    ignored,
                    children,
                    force_open: true,
                    with_branch: false,
                });
            } else {
                let children = collect_children(&path, walk, true);
                if children.is_empty() {
                    continue;
                }
                out.push(FilterNode::Dir {
                    path,
                    info,
                    ignored,
                    children,
                    force_open: true,
                    with_branch: false,
                });
            }
        } else {
            let name = entry_name(&path);
            if apply_name_filter && !name_matches(&name, &walk.query_lower) {
                continue;
            }
            if walk.markdown_only && classify(&path.to_string_lossy()) != FileKind::Markdown {
                continue;
            }
            out.push(FilterNode::File {
                path,
                info,
                ignored,
            });
        }
    }
    out
}

/// Phase-2: HTML-Render mit Node-Cap.
fn render_nodes(
    nodes: &[FilterNode],
    vault: &Vault,
    node_count: &mut usize,
    truncated: &mut bool,
) -> String {
    let mut html = String::new();
    for node in nodes {
        if *truncated {
            break;
        }
        if *node_count >= MAX_FILTER_NODES {
            *truncated = true;
            break;
        }
        *node_count += 1;
        match node {
            FilterNode::File {
                path,
                info,
                ignored,
            } => {
                html.push_str(&vault.item_html(
                    &path.to_string_lossy(),
                    info,
                    None,
                    *ignored,
                    None,
                ));
            }
            FilterNode::Dir {
                path,
                info,
                ignored,
                children,
                force_open,
                with_branch,
            } => {
                let child_html = if *force_open {
                    render_nodes(children, vault, node_count, truncated)
                } else {
                    String::new()
                };
                let branch = if *with_branch && info.is_directory && path.exists() {
                    crate::git_branch::branch_of(path)
                } else {
                    None
                };
                let force = if *force_open {
                    Some(child_html.as_str())
                } else {
                    None
                };
                html.push_str(&vault.item_html(
                    &path.to_string_lossy(),
                    info,
                    branch.as_ref(),
                    *ignored,
                    force,
                ));
            }
        }
    }
    html
}

fn list_dir_sorted(dir: &Path) -> Vec<(PathBuf, EntryInfo)> {
    let mut entries = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .map(|e| {
                let path = e.path();
                let info = classify_entry(&path);
                (path, info)
            })
            .filter(|(path, _)| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n != ".git")
                    .unwrap_or(true)
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    entries.sort_by(|(pa, ia), (pb, ib)| {
        ib.is_directory
            .cmp(&ia.is_directory)
            .then_with(|| entry_name(pa).cmp(&entry_name(pb)))
    });
    entries
}

fn name_matches(name: &str, query_lower: &str) -> bool {
    if query_lower.is_empty() {
        return true;
    }
    name.to_lowercase().contains(query_lower)
}

fn entry_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn normalize_str(s: &str) -> String {
    s.replace('\\', "/")
}

fn normalize_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use crate::workspace::PinnedItem;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    // --- Fixture-Helfer ------------------------------------------------------

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

    fn pin_dir(p: &Path) -> PinnedItem {
        PinnedItem {
            path: p.to_string_lossy().replace('\\', "/"),
            is_directory: true,
        }
    }

    fn pin_file(p: &Path) -> PinnedItem {
        PinnedItem {
            path: p.to_string_lossy().replace('\\', "/"),
            is_directory: false,
        }
    }

    fn norm(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    fn data_path_attr(p: &Path) -> String {
        format!(r#"data-path="{}""#, norm(p))
    }

    fn opts(query: &str, markdown_only: bool) -> VaultFilterOptions {
        VaultFilterOptions {
            query: query.to_string(),
            markdown_only,
        }
    }

    fn run(pinned: &[PinnedItem], vault: &Vault, query: &str, md_only: bool) -> VaultFilterResult {
        run_vault_filter(pinned, vault, &opts(query, md_only))
    }

    // --- 1: Namensmatch case-insensitive; Nicht-Treffer gestutzt -------------

    #[test]
    fn name_match_case_insensitive_prunes_non_hits() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "Alpha.md", "# A\n");
        write(root, "Beta.md", "# B\n");
        write(root, "gamma.txt", "g\n");

        let pinned = vec![pin_dir(root)];
        let vault = Vault::new();
        let result = run(&pinned, &vault, "alp", false);

        assert!(
            result
                .html
                .contains(&data_path_attr(&root.join("Alpha.md"))),
            "Alpha.md muss case-insensitive matchen; html={}",
            result.html
        );
        assert!(
            !result.html.contains(&data_path_attr(&root.join("Beta.md"))),
            "Beta.md ist kein Treffer"
        );
        assert!(
            !result
                .html
                .contains(&data_path_attr(&root.join("gamma.txt"))),
            "gamma.txt ist kein Treffer"
        );
        // Pin-Wurzel bleibt, weil sie Treffer enthält.
        assert!(
            result.html.contains(&data_path_attr(root)),
            "Pin-Wurzel mit Treffer muss sichtbar sein"
        );
    }

    // --- 2: Ordner-Name-Match → kompletter Subtree; Typ-Filter greift --------

    #[test]
    fn folder_name_match_includes_full_subtree_type_filter_still_applies() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // Ordner "Notes" matcht die Query; darin MD + Nicht-MD.
        write(root, "Notes/deep/file.md", "# f\n");
        write(root, "Notes/deep/skip.txt", "x\n");
        write(root, "Notes/other.md", "# o\n");
        write(root, "sibling.md", "# s\n");

        let notes = root.join("Notes");
        let pinned = vec![pin_dir(root)];
        let vault = Vault::new();

        // Query matcht Ordnernamen "Notes" — Subtree komplett, aber
        // markdown_only blendet skip.txt aus.
        let result = run(&pinned, &vault, "notes", true);

        assert!(
            result.html.contains(&data_path_attr(&notes)),
            "Notes-Ordner muss drin sein"
        );
        assert!(
            result
                .html
                .contains(&data_path_attr(&notes.join("deep/file.md"))),
            "Subtree-MD muss drin sein (Namensfilter greift im Subtree nicht)"
        );
        assert!(
            result
                .html
                .contains(&data_path_attr(&notes.join("other.md"))),
            "anderes MD im gematchten Ordner muss drin sein"
        );
        assert!(
            !result
                .html
                .contains(&data_path_attr(&notes.join("deep/skip.txt"))),
            "Typ-Filter blendet Non-MD im Subtree aus"
        );
        assert!(
            !result
                .html
                .contains(&data_path_attr(&root.join("sibling.md"))),
            "sibling.md matcht weder Ordner- noch Dateiname 'notes'"
        );
        // Im Filtermodus sind Ordner aufgeklappt (caret open).
        assert!(
            result.html.contains(r#"class="caret open""#),
            "Filtermodus: Ordner voll aufgeklappt"
        );
    }

    // --- 3: Ordner ohne Treffer weg; verschachtelte Treffer halten Ahnenkette -

    #[test]
    fn nested_hit_keeps_ancestor_chain_prunes_empty_branches() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "a/b/c/hit.md", "# hit\n");
        write(root, "a/empty/nothing.txt", "x\n");
        write(root, "orphan/x.txt", "y\n");

        let pinned = vec![pin_dir(root)];
        let vault = Vault::new();
        let result = run(&pinned, &vault, "hit", false);

        let hit = root.join("a/b/c/hit.md");
        assert!(result.html.contains(&data_path_attr(&hit)));
        assert!(result.html.contains(&data_path_attr(&root.join("a"))));
        assert!(result.html.contains(&data_path_attr(&root.join("a/b"))));
        assert!(result.html.contains(&data_path_attr(&root.join("a/b/c"))));
        assert!(
            !result.html.contains(&data_path_attr(&root.join("a/empty"))),
            "Zweig ohne Treffer muss gestutzt werden"
        );
        assert!(
            !result.html.contains(&data_path_attr(&root.join("orphan"))),
            "orphan ohne Treffer muss weg"
        );
    }

    // --- 4: markdown_only filtert Non-MD; Ordner ohne MD verschwindet ---------

    #[test]
    fn markdown_only_filters_files_and_mdless_dirs_with_and_without_query() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "keep.md", "# k\n");
        write(root, "drop.txt", "t\n");
        write(root, "mdless/only.txt", "x\n");
        write(root, "has_md/nested.md", "# n\n");
        write(root, "has_md/also.txt", "y\n");

        let pinned = vec![pin_dir(root)];
        let vault = Vault::new();

        // Leere Query = Match-all (Spec A2): es filtert ausschließlich
        // der Typ-Filter — jede Ausblendung unten ist damit ein echter
        // Typ-Filter-Beweis, kein Namensfilter-Nebeneffekt.
        let result = run(&pinned, &vault, "", true);

        assert!(result.html.contains(&data_path_attr(&root.join("keep.md"))));
        assert!(
            !result
                .html
                .contains(&data_path_attr(&root.join("drop.txt"))),
            "Non-MD muss raus"
        );
        assert!(
            !result.html.contains(&data_path_attr(&root.join("mdless"))),
            "Ordner ohne MD muss raus"
        );
        assert!(result.html.contains(&data_path_attr(&root.join("has_md"))));
        assert!(result
            .html
            .contains(&data_path_attr(&root.join("has_md/nested.md"))));
        assert!(
            !result
                .html
                .contains(&data_path_attr(&root.join("has_md/also.txt"))),
            "Non-MD unter has_md muss raus"
        );

        // Kombiniert: Query matcht nur drop.txt-Namen, markdown_only →
        // Pin ohne Treffer ausgeblendet (oder leeres HTML).
        let only_txt = run(&pinned, &vault, "drop", true);
        assert!(
            !only_txt
                .html
                .contains(&data_path_attr(&root.join("drop.txt"))),
            "markdown_only + Query auf Non-MD → Datei weg"
        );
        assert!(
            !only_txt.html.contains(&data_path_attr(root))
                || only_txt.node_count == 0
                || !only_txt.html.contains("drop.txt"),
            "Pin-Wurzel ohne MD-Treffer wird ausgeblendet oder ohne den Treffer"
        );
    }

    // --- 5: Pin-Einzeldateien Match/Nicht-Match; Pin-Reihenfolge bleibt ------

    #[test]
    fn pinned_files_match_and_preserve_pin_order() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let file_b = root.join("file_b.md");
        let file_a = root.join("file_a.md");
        let file_c = root.join("file_c.txt");
        let folder = root.join("folder");
        fs::write(&file_b, "# b\n").unwrap();
        fs::write(&file_a, "# a\n").unwrap();
        fs::write(&file_c, "c\n").unwrap();
        fs::create_dir(&folder).unwrap();
        write(&folder, "inside.md", "# i\n");

        // Pin-Reihenfolge: B, A, folder, C (nicht alphabetisch).
        let pinned = vec![
            pin_file(&file_b),
            pin_file(&file_a),
            pin_dir(&folder),
            pin_file(&file_c),
        ];
        let vault = Vault::new();

        // Query "file" matcht file_b, file_a, file_c — folder/inside.md nicht.
        let result = run(&pinned, &vault, "file", false);

        assert!(result.html.contains(&data_path_attr(&file_b)));
        assert!(result.html.contains(&data_path_attr(&file_a)));
        assert!(result.html.contains(&data_path_attr(&file_c)));
        assert!(
            !result.html.contains(&data_path_attr(&folder)),
            "folder ohne Namensmatch und ohne Kind-Match auf 'file' weg"
        );

        let pos_b = result.html.find(&data_path_attr(&file_b)).unwrap();
        let pos_a = result.html.find(&data_path_attr(&file_a)).unwrap();
        let pos_c = result.html.find(&data_path_attr(&file_c)).unwrap();
        assert!(
            pos_b < pos_a && pos_a < pos_c,
            "Pin-Reihenfolge B → A → C muss erhalten bleiben"
        );

        // Nicht-Match-Pin verschwindet.
        let no_match = run(&pinned, &vault, "zzzz", false);
        assert!(
            !no_match.html.contains(&data_path_attr(&file_b)),
            "Nicht-matchende Datei-Pins weg"
        );
        assert!(
            no_match.html.is_empty() || no_match.node_count == 0,
            "kein Treffer → leeres Ergebnis"
        );
    }

    // --- 6: Hidden/gitignored erscheinen; .git nie ---------------------------

    #[test]
    fn hidden_and_gitignored_appear_dot_git_never() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_git(root);
        write(root, ".gitignore", "secret.md\n");
        write(root, "visible.md", "# v\n");
        write(root, "secret.md", "# s\n");
        write(root, ".hidden.md", "# h\n");
        // Datei unter .git — darf nie im Filterbaum landen.
        write(root, ".git/hooks/pre-commit.md", "# git\n");
        write(root, ".git/COMMIT_EDITMSG.md", "# msg\n");

        let pinned = vec![pin_dir(root)];
        let vault = Vault::new();
        // Query matcht alle .md-Namen (Substring "md" bzw. "secret"/"hidden"/"visible").
        // "e" trifft visible, secret, hidden, pre-commit, COMMIT_EDITMSG.
        let result = run(&pinned, &vault, "e", false);

        assert!(
            result
                .html
                .contains(&data_path_attr(&root.join("visible.md"))),
            "sichtbare Datei muss drin sein"
        );
        assert!(
            result
                .html
                .contains(&data_path_attr(&root.join("secret.md"))),
            "gitignorierte Datei erscheint im Filter (A3, wie Baum)"
        );
        assert!(
            result
                .html
                .contains(&data_path_attr(&root.join(".hidden.md"))),
            "Hidden-Datei erscheint im Filter (A3)"
        );
        // Gitignore-Dimming bleibt erhalten (Spec A3, item_html-Pfad):
        // secret.md ist die einzige ignorierte Datei im Fixture.
        assert!(
            result.html.contains(r#"class="node ignored""#),
            "gitignorierte Datei muss die ignored-Klasse tragen; html={}",
            result.html
        );
        assert!(
            !result.html.contains("pre-commit.md"),
            ".git-Inhalt darf nie erscheinen"
        );
        assert!(
            !result.html.contains("COMMIT_EDITMSG"),
            ".git-Inhalt darf nie erscheinen"
        );
        assert!(
            !result.html.contains(r#"data-path=""#) || !result.html.contains("/.git\""),
            ".git-Verzeichnis selbst nicht als Knoten"
        );
        // Strenger: kein data-path der auf /.git endet oder /.git/ enthält.
        assert!(
            !result.html.contains("/.git/"),
            "kein data-path unter .git; html={}",
            result.html
        );
    }

    // --- 7: Node-Cap > 2000 → truncated, HTML endet sauber -------------------

    #[test]
    fn node_cap_sets_truncated_and_html_stays_well_formed() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // > MAX_FILTER_NODES Dateien mit gemeinsamem Namenspräfix.
        let n = MAX_FILTER_NODES + 50;
        for i in 0..n {
            write(root, &format!("f{i:04}.md"), "#\n");
        }

        let pinned = vec![pin_dir(root)];
        let vault = Vault::new();
        // "f" matcht alle Dateinamen.
        let result = run(&pinned, &vault, "f", false);

        assert!(result.truncated, "über Cap → truncated");
        assert!(
            result.node_count <= MAX_FILTER_NODES,
            "node_count darf Cap nicht überschreiten: {}",
            result.node_count
        );
        // HTML endet sauber: keine offenen Tags-Fragmente am Ende —
        // mindestens balancierte li-Schließung bzw. endet mit </li> oder </ul>.
        let trimmed = result.html.trim_end();
        assert!(
            trimmed.ends_with("</li>") || trimmed.ends_with("</ul>") || trimmed.is_empty(),
            "HTML soll sauber enden, got tail: {:?}",
            trimmed
                .char_indices()
                .rev()
                .take(40)
                .map(|(_, c)| c)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        );
        // Mindestens ein gerenderter Knoten (Pin oder Datei).
        assert!(
            result.html.contains("data-path=") || result.node_count > 0,
            "trotz Truncation soll etwas gerendert sein"
        );
    }

    // --- 8: dir_contains_markdown Early-Exit, Kostendeckel, .git-Skip --------

    #[test]
    fn dir_contains_markdown_early_exit_cost_cap_and_git_skip() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Early-Exit-Fund: MD tief verschachtelt → true.
        let with_md = root.join("with_md");
        write(&with_md, "a/b/c/note.md", "# n\n");
        write(&with_md, "a/b/other.txt", "t\n");
        assert!(
            dir_contains_markdown(&with_md),
            "verschachteltes MD muss true liefern"
        );

        // Nur Nicht-MD → false.
        let only_txt = root.join("only_txt");
        write(&only_txt, "a.txt", "x\n");
        write(&only_txt, "sub/b.txt", "y\n");
        assert!(!dir_contains_markdown(&only_txt), "ohne MD → false");

        // .git mit MD darin zählt nicht; Ordner sonst ohne MD → false.
        let git_only = root.join("git_only");
        init_git(&git_only);
        write(&git_only, ".git/hooks/x.md", "# g\n");
        write(&git_only, "plain.txt", "p\n");
        assert!(
            !dir_contains_markdown(&git_only),
            ".git-Inhalt darf die Probe nicht true machen"
        );

        // Kostendeckel: viele Nicht-MD-Einträge, kein MD → true (fail-open).
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

    // --- 9: Lazy-Modus build_dir_children_html mit Typ-Filter -----------------

    #[test]
    fn lazy_mode_type_filter_hides_non_md_and_mdless_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "note.md", "# n\n");
        write(root, "data.json", "{}\n");
        write(root, "empty_folder/.keep", ""); // Ordner ohne MD
                                               // leerer Ordner ohne Dateien
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
        // Ohne Typ-Filter: alles sichtbar (Default-Verhalten unverändert).
        let all = vault
            .build_dir_children_html(&path, false)
            .expect("read_dir ok");
        assert!(all.contains(&data_path_attr(&root.join("data.json"))));
        assert!(all.contains(&data_path_attr(&root.join("note.md"))));
    }

    // --- 10: expanded_dirs bleibt durch Filterlauf unverändert ---------------

    #[test]
    fn filter_run_does_not_mutate_expanded_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "sub/a.md", "# a\n");
        write(root, "other.md", "# o\n");
        let sub = root.join("sub");

        let mut vault = Vault::new();
        vault.on_expand(norm(root)).expect("expand root");
        vault.on_expand(norm(&sub)).expect("expand sub");
        let before: Vec<String> = vault.expanded_paths();
        assert!(before.len() >= 2, "Setup: mindestens root+sub expanded");

        let pinned = vec![pin_dir(root)];
        let _result = run(&pinned, &vault, "a", false);

        let after: Vec<String> = vault.expanded_paths();
        assert_eq!(
            before, after,
            "Filterlauf darf expanded_dirs nicht verändern"
        );
        // Zusätzlich: Filter-HTML soll trotzdem aufgeklappte Ordner zeigen
        // (caret open), ohne den Vault-State anzufassen.
        let result = run(&pinned, &vault, "a", false);
        if result.html.contains("data-kind=\"dir\"") {
            assert!(
                result.html.contains(r#"class="caret open""#) || result.html.contains("caret open"),
                "Filter-HTML zeigt Ordner aufgeklappt, State unberührt"
            );
        }
    }

    // Compile-time smoke: Typen sind Send-freundlich und Defaults sinnvoll.
    #[test]
    fn options_and_result_are_constructible() {
        let o = VaultFilterOptions {
            query: String::new(),
            markdown_only: false,
        };
        assert!(o.query.is_empty());
        assert!(!o.markdown_only);
        let r = VaultFilterResult {
            html: String::new(),
            truncated: false,
            node_count: 0,
        };
        assert_eq!(0, r.node_count);
        assert_eq!(2_000, MAX_FILTER_NODES);
        assert_eq!(2_000, DIR_CONTAINS_MD_VISIT_CAP);
    }

    // --- Additive Tests (FX1/FX5/FX6; abgenommene 1–10 unantastbar) ---------

    #[test]
    fn deep_no_hit_is_empty_and_not_truncated() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // Tiefer trefferloser Zweig: Query matcht nichts.
        write(root, "a/b/c/d/e/nope.txt", "x\n");
        write(root, "a/b/other.md", "# o\n");
        let pinned = vec![pin_dir(root)];
        let vault = Vault::new();
        let result = run(&pinned, &vault, "zzzz_no_match", false);
        assert!(
            result.html.is_empty() || result.node_count == 0,
            "kein Treffer → leer; html={}",
            result.html
        );
        assert!(
            !result.truncated,
            "trefferlose Tiefe darf truncated nicht sticky setzen"
        );
    }

    #[test]
    fn exact_node_cap_is_not_truncated() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // Genau MAX_FILTER_NODES Dateien (+ Pin-Wurzel = MAX+1 potentielle).
        // Pin-Wurzel + (MAX-1) Dateien = MAX gerenderte Knoten → nicht truncated.
        let n = MAX_FILTER_NODES - 1;
        for i in 0..n {
            write(root, &format!("f{i:04}.md"), "#\n");
        }
        let pinned = vec![pin_dir(root)];
        let vault = Vault::new();
        let result = run(&pinned, &vault, "f", false);
        assert_eq!(
            MAX_FILTER_NODES, result.node_count,
            "exakt am Cap: node_count == MAX"
        );
        assert!(
            !result.truncated,
            "exakt am Cap darf truncated nicht gesetzt sein"
        );
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
        // a/loop → b, b/loop → a
        std::os::unix::fs::symlink(&b, a.join("loop")).unwrap();
        std::os::unix::fs::symlink(&a, b.join("loop")).unwrap();
        write(root, "plain.txt", "x\n");
        // Ohne MD und ohne Link-Abstieg: false (nicht Endlosschleife / Cap-true).
        assert!(
            !dir_contains_markdown(root),
            "Symlink-Loops duerfen die Probe nicht true machen ohne MD"
        );
        // Mit MD neben dem Loop: true via Early-Exit, nicht via Loop.
        write(root, "note.md", "# n\n");
        assert!(dir_contains_markdown(root));
    }

    #[cfg(unix)]
    #[test]
    fn filter_render_treats_pinned_dir_symlink_as_leaf() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let real = root.join("real");
        fs::create_dir_all(real.join("deep")).unwrap();
        write(&real, "deep/inside.md", "# i\n");
        let link = root.join("NotesLink");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let pinned = vec![pin_dir(&link)];
        let vault = Vault::new();
        // Name matcht die Link-Wurzel → Blatt, kein deep/inside.md.
        let result = run(&pinned, &vault, "notes", false);
        assert!(
            result.html.contains(&data_path_attr(&link)),
            "Link-Pin muss sichtbar sein; html={}",
            result.html
        );
        assert!(
            !result.html.contains("inside.md"),
            "Link-Pin darf Subtree nicht expandieren; html={}",
            result.html
        );
    }
}
