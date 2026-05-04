use crate::persist;
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_RECENT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedItem {
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentItem {
    pub path: String,
    pub last_opened: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct WorkspaceData {
    pub pinned: Vec<PinnedItem>,
    pub recent: Vec<RecentItem>,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    data: WorkspaceData,
    path: PathBuf,
}

impl Default for Workspace {
    fn default() -> Self {
        Self::load()
    }
}

impl Workspace {
    pub fn load() -> Self {
        Self::load_from(persist::config_file("workspace.json"))
    }

    pub fn load_from(path: PathBuf) -> Self {
        let data = persist::load_json(&path);
        Self { data, path }
    }

    pub fn data(&self) -> WorkspaceData {
        self.data.clone()
    }

    pub fn pinned(&self) -> &[PinnedItem] {
        &self.data.pinned
    }

    pub fn recent(&self) -> &[RecentItem] {
        &self.data.recent
    }

    pub fn add_recent(&mut self, path: String) -> io::Result<()> {
        self.data.recent.retain(|item| item.path != path);
        self.data.recent.insert(
            0,
            RecentItem {
                path,
                last_opened: now_secs(),
            },
        );
        self.data.recent.truncate(MAX_RECENT);
        self.save()
    }

    pub fn remove_recent(&mut self, path: &str) -> io::Result<()> {
        self.data.recent.retain(|item| item.path != path);
        self.save()
    }

    pub fn pin(&mut self, path: String, is_directory: bool) -> io::Result<()> {
        if !self.is_pinned(&path) {
            self.data.pinned.push(PinnedItem { path, is_directory });
        }
        self.save()
    }

    pub fn unpin(&mut self, path: &str) -> io::Result<()> {
        self.data.pinned.retain(|item| item.path != path);
        self.save()
    }

    pub fn is_pinned(&self, path: &str) -> bool {
        self.data.pinned.iter().any(|item| item.path == path)
    }

    fn save(&self) -> io::Result<()> {
        persist::save_json_atomic(&self.path, &self.data)
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn pin_unpin_and_is_pinned_work() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/a".into(), true).unwrap();
        workspace.pin("/a".into(), true).unwrap();
        assert!(workspace.is_pinned("/a"));
        assert_eq!(1, workspace.pinned().len());
        workspace.unpin("/a").unwrap();
        assert!(!workspace.is_pinned("/a"));
    }

    #[test]
    fn recent_deduplicates_and_caps_at_twenty() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        for index in 0..25 {
            workspace.add_recent(format!("/{index}.md")).unwrap();
        }
        workspace.add_recent("/20.md".into()).unwrap();
        assert_eq!(20, workspace.recent().len());
        assert_eq!("/20.md", workspace.recent()[0].path);
    }

    #[test]
    fn persists_and_reloads() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("workspace.json");
        let mut workspace = Workspace::load_from(path.clone());
        workspace.pin("/a".into(), false).unwrap();
        workspace.add_recent("/b".into()).unwrap();
        let loaded = Workspace::load_from(path);
        assert_eq!(workspace.data(), loaded.data());
    }
}
