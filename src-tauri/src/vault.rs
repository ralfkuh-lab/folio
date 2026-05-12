use crate::workspace::Workspace;
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultRefreshDelta {
    pub pinned: Option<String>,
    pub recent: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Vault {
    expanded_dirs: BTreeSet<String>,
    active_path: Option<String>,
}

impl Vault {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn build_initial_tree_html(&self, workspace: &Workspace) -> String {
        self.build_initial_tree_html_with(workspace, true, true)
    }

    pub fn build_initial_tree_html_with(
        &self,
        workspace: &Workspace,
        pinned_expanded: bool,
        recent_expanded: bool,
    ) -> String {
        let mut html = String::new();
        html.push_str(&self.section_html(
            "pinned",
            "📌",
            "Angepinnt",
            self.pinned_children_html(workspace),
            pinned_expanded,
        ));
        html.push_str(&self.section_html(
            "recent",
            "🕘",
            "Zuletzt geöffnet",
            self.recent_children_html(workspace),
            recent_expanded,
        ));
        html
    }

    pub fn build_dir_children_html(&self, path: &str) -> io::Result<String> {
        let mut entries = fs::read_dir(path)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| {
            b.is_dir()
                .cmp(&a.is_dir())
                .then_with(|| display_name(a).cmp(&display_name(b)))
        });
        Ok(entries
            .iter()
            .map(|entry| self.item_html(&entry.to_string_lossy(), entry.is_dir()))
            .collect())
    }

    pub fn compute_refresh_delta(&self, workspace: &Workspace) -> VaultRefreshDelta {
        VaultRefreshDelta {
            pinned: Some(self.pinned_children_html(workspace)),
            recent: Some(self.recent_children_html(workspace)),
        }
    }

    pub fn on_expand(&mut self, path: String) -> io::Result<String> {
        self.expanded_dirs.insert(path.clone());
        self.build_dir_children_html(&path)
    }

    /// Beim Zuklappen eines Ordners auch alle bisher aufgeklappten
    /// Unterordner aus `expanded_dirs` werfen. Damit startet ein
    /// erneutes Aufklappen mit komplett kollabiertem Subtree —
    /// kombiniert mit dem "expand-dir immer neu lesen"-Pfad im
    /// Frontend ist das ein konsequenter Auto-Refresh.
    pub fn on_collapse(&mut self, path: &str) {
        let target = Path::new(path);
        self.expanded_dirs
            .retain(|entry| !Path::new(entry).starts_with(target));
    }

    pub fn on_section_toggle(&self, _section: &str, _expanded: bool) {}

    pub fn set_active(&mut self, path: Option<String>) {
        self.active_path = path;
    }

    pub fn is_expanded(&self, path: &str) -> bool {
        self.expanded_dirs.contains(path)
    }

    fn item_html(&self, path: &str, is_directory: bool) -> String {
        let expanded = is_directory && self.is_expanded(path);
        let active = self.active_path.as_deref() == Some(path);
        let class = if active { "node active" } else { "node" };
        let kind = if is_directory { "dir" } else { "file" };
        let loaded = if expanded { "1" } else { "0" };
        let caret_class = if is_directory {
            if expanded {
                "caret open"
            } else {
                "caret"
            }
        } else {
            "caret hidden"
        };
        let icon_html = if is_directory {
            let emoji = if expanded { "📂" } else { "📁" };
            format!(r#"<span class="icon">{emoji}</span>"#)
        } else {
            let ext = Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            format!(
                r#"<span class="icon"><img class="ftype-icon" data-ext="{ext}" alt=""></span>"#,
                ext = escape_attr(&ext),
            )
        };
        let children_class = if expanded {
            "children"
        } else {
            "children collapsed"
        };
        let children = if expanded {
            self.build_dir_children_html(path).unwrap_or_default()
        } else {
            String::new()
        };
        format!(
            r#"<li class="{class}" data-kind="{kind}" data-path="{path}" data-loaded="{loaded}"><div class="row"><span class="{caret_class}">▾</span>{icon_html}<span class="label">{name}</span></div><ul class="{children_class}">{children}</ul></li>"#,
            path = escape_attr(path),
            name = escape_html(&display_name(Path::new(path))),
        )
    }

    fn section_html(
        &self,
        key: &str,
        icon: &str,
        title: &str,
        children: String,
        expanded: bool,
    ) -> String {
        let caret_class = if expanded { "caret open" } else { "caret" };
        let children_class = if expanded {
            "children"
        } else {
            "children collapsed"
        };
        format!(
            r#"<li class="section" data-section="{key}"><div class="row"><span class="{caret_class}">▾</span><span class="icon">{icon}</span><span class="label">{title}</span></div><ul class="{children_class}">{children}</ul></li>"#,
            key = escape_attr(key),
            icon = escape_html(icon),
            title = escape_html(title),
        )
    }

    fn pinned_children_html(&self, workspace: &Workspace) -> String {
        let html = workspace
            .pinned()
            .iter()
            .map(|item| self.item_html(&item.path, item.is_directory))
            .collect::<String>();
        empty_placeholder(html)
    }

    fn recent_children_html(&self, workspace: &Workspace) -> String {
        let html = workspace
            .recent()
            .iter()
            .map(|item| self.item_html(&item.path, false))
            .collect::<String>();
        empty_placeholder(html)
    }
}

fn empty_placeholder(html: String) -> String {
    if html.is_empty() {
        r#"<li class="empty">Keine Einträge</li>"#.to_string()
    } else {
        html
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(value: &str) -> String {
    escape_html(value).replace('"', "&quot;")
}

#[allow(dead_code)]
fn normalize_path(path: PathBuf) -> String {
    fs::canonicalize(&path)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Workspace;
    use tempfile::TempDir;

    #[test]
    fn initial_tree_contains_pinned_and_recent_sections() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/tmp/a.md".into(), false).unwrap();
        workspace.add_recent("/tmp/b.md".into()).unwrap();
        let html = Vault::new().build_initial_tree_html(&workspace);
        assert!(html.contains("Angepinnt"));
        assert!(html.contains("Zuletzt geöffnet"));
        assert!(html.contains(r#"class="section" data-section="pinned""#));
        assert!(html.contains("a.md"));
    }

    #[test]
    fn expand_builds_children_with_directories_first() {
        let temp = TempDir::new().unwrap();
        fs::create_dir(temp.path().join("dir")).unwrap();
        fs::write(temp.path().join("file.md"), "").unwrap();
        let mut vault = Vault::new();
        let html = vault
            .on_expand(temp.path().to_str().unwrap().to_string())
            .unwrap();
        assert!(vault.is_expanded(temp.path().to_str().unwrap()));
        assert!(html.find("dir").unwrap() < html.find("file.md").unwrap());
    }

    #[test]
    fn active_item_gets_active_class() {
        let mut vault = Vault::new();
        vault.set_active(Some("/tmp/a.md".into()));
        let html = vault.item_html("/tmp/a.md", false);
        assert!(html.contains("node active"));
    }

    #[test]
    fn collapse_recursively_prunes_nested_expanded_dirs() {
        let temp = TempDir::new().unwrap();
        let outer = temp.path().join("outer");
        let inner = outer.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let sibling = temp.path().join("other");
        fs::create_dir(&sibling).unwrap();

        let mut vault = Vault::new();
        vault
            .on_expand(outer.to_string_lossy().into_owned())
            .unwrap();
        vault
            .on_expand(inner.to_string_lossy().into_owned())
            .unwrap();
        vault
            .on_expand(sibling.to_string_lossy().into_owned())
            .unwrap();

        vault.on_collapse(outer.to_str().unwrap());

        assert!(!vault.is_expanded(outer.to_str().unwrap()));
        assert!(!vault.is_expanded(inner.to_str().unwrap()));
        assert!(vault.is_expanded(sibling.to_str().unwrap()));
    }

    #[test]
    fn directories_render_caret_and_child_container() {
        let html = Vault::new().item_html("/tmp/dir", true);
        assert!(html.contains(r#"data-kind="dir""#));
        assert!(html.contains(r#"class="caret""#));
        assert!(html.contains(r#"class="children collapsed""#));
    }
}
