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
        let mut html = String::new();
        html.push_str(r#"<section class="vault-section" data-section="pinned">"#);
        html.push_str(r#"<div class="vault-section-title">📌 Pinned</div>"#);
        for item in workspace.pinned() {
            html.push_str(&self.item_html(&item.path, item.is_directory));
        }
        html.push_str("</section>");
        html.push_str(r#"<section class="vault-section" data-section="recent">"#);
        html.push_str(r#"<div class="vault-section-title">🕘 Recent</div>"#);
        for item in workspace.recent() {
            html.push_str(&self.item_html(&item.path, false));
        }
        html.push_str("</section>");
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
            pinned: Some(self.build_initial_tree_html(workspace)),
            recent: None,
        }
    }

    pub fn on_expand(&mut self, path: String) -> io::Result<String> {
        self.expanded_dirs.insert(path.clone());
        self.build_dir_children_html(&path)
    }

    pub fn on_collapse(&mut self, path: &str) {
        self.expanded_dirs.remove(path);
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
        let class = if active {
            "vault-item active"
        } else {
            "vault-item"
        };
        let icon = match (is_directory, expanded) {
            (true, true) => "📂",
            (true, false) => "📁",
            (false, _) => "📄",
        };
        format!(
            r#"<div class="{class}" data-path="{path}" data-directory="{is_directory}"><span class="vault-icon">{icon}</span><span class="vault-name">{name}</span></div>"#,
            path = escape_attr(path),
            name = escape_html(&display_name(Path::new(path))),
        )
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
        assert!(html.contains("📌 Pinned"));
        assert!(html.contains("🕘 Recent"));
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
        assert!(html.contains("vault-item active"));
    }
}
