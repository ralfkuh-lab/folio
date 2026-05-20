use crate::persist;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
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
    /// Pro Dokument-Pfad das zuletzt verwendete Speicherverzeichnis fuers
    /// Image-Insert-Feature. Ohne `#[serde(default)]` wuerden alte
    /// workspace.json-Files ohne dieses Feld ablehnen.
    #[serde(default)]
    pub image_dirs: HashMap<String, String>,
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

/// Vereinheitlicht Pfade auf Forward-Slashes. Windows-APIs akzeptieren
/// beide Schreibweisen; intern arbeiten wir konsistent mit Forward-
/// Slashes, damit DOM-`data-path`-Attribute, CSS-Selektoren (im E2E),
/// `is_pinned`-Vergleiche und `vault_tree`-Render-Output ueberall die
/// gleiche Schreibweise nutzen. Sonst greift z.B. der CSS-Selektor
/// `[data-path="C:\Users\..."]` nicht, weil `\U` als Unicode-Escape
/// interpretiert wird.
fn normalize_path(input: &str) -> String {
    input.replace('\\', "/")
}

impl Workspace {
    pub fn load() -> Self {
        Self::load_from(persist::config_file("workspace.json"))
    }

    pub fn load_from(path: PathBuf) -> Self {
        let mut data: WorkspaceData = persist::load_json(&path);
        let mut dirty = false;
        // Migration: bestehende workspace.json-Eintraege auf Forward-
        // Slashes normalisieren, sonst koennen Backslash-Pins nicht mit
        // dem (jetzt normalisierten) Frontend-Pfad verglichen werden.
        for item in &mut data.pinned {
            let normalized = normalize_path(&item.path);
            if normalized != item.path {
                item.path = normalized;
                dirty = true;
            }
        }
        for item in &mut data.recent {
            let normalized = normalize_path(&item.path);
            if normalized != item.path {
                item.path = normalized;
                dirty = true;
            }
        }
        if data.image_dirs.keys().any(|k| k.contains('\\'))
            || data.image_dirs.values().any(|v| v.contains('\\'))
        {
            data.image_dirs = data
                .image_dirs
                .drain()
                .map(|(k, v)| (normalize_path(&k), normalize_path(&v)))
                .collect();
            dirty = true;
        }
        let workspace = Self { data, path };
        if dirty {
            let _ = workspace.save();
        }
        workspace
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
        let path = normalize_path(&path);
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
        let path = normalize_path(path);
        self.data.recent.retain(|item| item.path != path);
        self.save()
    }

    pub fn pin(&mut self, path: String, is_directory: bool) -> io::Result<()> {
        let path = normalize_path(&path);
        if !self.is_pinned(&path) {
            self.data.pinned.push(PinnedItem { path, is_directory });
        }
        self.save()
    }

    pub fn unpin(&mut self, path: &str) -> io::Result<()> {
        let path = normalize_path(path);
        self.data.pinned.retain(|item| item.path != path);
        self.save()
    }

    pub fn is_pinned(&self, path: &str) -> bool {
        let path = normalize_path(path);
        self.data.pinned.iter().any(|item| item.path == path)
    }

    /// Letztes Image-Speicherverzeichnis fuer das Dokument `doc_path`,
    /// falls vorhanden.
    pub fn image_dir(&self, doc_path: &str) -> Option<&str> {
        let key = normalize_path(doc_path);
        self.data.image_dirs.get(&key).map(String::as_str)
    }

    /// Merkt das zuletzt fuer ein Dokument gewaehlte Image-Speicher-
    /// verzeichnis. Persistiert sofort.
    pub fn set_image_dir(&mut self, doc_path: String, dir: String) -> io::Result<()> {
        self.data
            .image_dirs
            .insert(normalize_path(&doc_path), normalize_path(&dir));
        self.save()
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

    #[test]
    fn pin_normalizes_backslashes() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace
            .pin(r"C:\Users\rakul\file.md".into(), false)
            .unwrap();
        // is_pinned greift sowohl mit Backslashes als auch mit Slashes,
        // weil intern normalisiert wird.
        assert!(workspace.is_pinned(r"C:\Users\rakul\file.md"));
        assert!(workspace.is_pinned("C:/Users/rakul/file.md"));
        assert_eq!("C:/Users/rakul/file.md", workspace.pinned()[0].path);
    }

    #[test]
    fn load_migrates_legacy_backslash_paths() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("workspace.json");
        // Simuliere alte workspace.json mit Backslash-Pfaden.
        std::fs::write(
            &path,
            r#"{"pinned":[{"path":"C:\\Users\\a.md","is_directory":false}],
                "recent":[{"path":"C:\\Users\\b.md","last_opened":42}],
                "image_dirs":{}}"#,
        )
        .unwrap();
        let workspace = Workspace::load_from(path.clone());
        assert_eq!("C:/Users/a.md", workspace.pinned()[0].path);
        assert_eq!("C:/Users/b.md", workspace.recent()[0].path);
        // Migration persistiert: nach erneutem Load steht Forward-Slash drin.
        let reloaded = Workspace::load_from(path);
        assert_eq!("C:/Users/a.md", reloaded.pinned()[0].path);
    }
}
