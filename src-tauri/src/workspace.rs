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
    /// Dokumentpfade der beim letzten Lauf offenen Tabs. Serde-Default
    /// migriert bestehende workspace.json-Dateien ohne Session-State.
    #[serde(default)]
    pub open_tabs: Vec<String>,
    /// Index des aktiven dokumenttragenden Tabs in `open_tabs`.
    #[serde(default)]
    pub active_tab: Option<usize>,
    /// Pro Dokument-Pfad das zuletzt verwendete Speicherverzeichnis fuers
    /// Image-Insert-Feature. Ohne `#[serde(default)]` wuerden alte
    /// workspace.json-Files ohne dieses Feld ablehnen.
    #[serde(default)]
    pub image_dirs: HashMap<String, String>,
    /// Zuletzt gewaehltes Export-Zielverzeichnis. Global statt pro
    /// Dokument, damit `exportDirMode=last` dokumentuebergreifend wirkt.
    #[serde(default)]
    pub last_export_dir: Option<String>,
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
        for path in &mut data.open_tabs {
            let normalized = normalize_path(path);
            if normalized != *path {
                *path = normalized;
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
        if let Some(dir) = &mut data.last_export_dir {
            let normalized = normalize_path(dir);
            if normalized != *dir {
                *dir = normalized;
                dirty = true;
            }
        }
        let workspace = Self { data, path };
        if dirty {
            if let Err(error) = workspace.save() {
                // Verhalten bleibt: Migration laeuft beim naechsten Boot
                // erneut — aber nicht mehr stumm.
                tracing::warn!(
                    target: "folio::settings",
                    %error,
                    "workspace path migration could not be persisted"
                );
            }
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

    pub fn open_tabs(&self) -> &[String] {
        &self.data.open_tabs
    }

    pub fn active_tab(&self) -> Option<usize> {
        self.data.active_tab
    }

    /// Ersetzt den persistierten Tab-Session-State atomar mit den
    /// uebrigen Workspace-Daten. Pfade folgen derselben Forward-Slash-
    /// Konvention wie Pins, Recents und Image-Verzeichnisse.
    pub fn set_open_tabs(
        &mut self,
        open_tabs: Vec<String>,
        active_tab: Option<usize>,
    ) -> io::Result<()> {
        self.data.open_tabs = open_tabs
            .into_iter()
            .map(|path| normalize_path(&path))
            .collect();
        self.data.active_tab = active_tab.filter(|index| *index < self.data.open_tabs.len());
        self.save()
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

    /// Leert die gesamte Recent-Liste (E2E-Reset auf kanonischen Zustand).
    pub fn clear_recent(&mut self) -> io::Result<()> {
        self.data.recent.clear();
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

    pub fn reorder_pinned(&mut self, paths: Vec<String>) -> io::Result<()> {
        let mut new_pinned = Vec::new();
        let mut remaining_pins = self.data.pinned.clone();

        for path in paths {
            let normalized = normalize_path(&path);
            if let Some(pos) = remaining_pins
                .iter()
                .position(|item| item.path == normalized)
            {
                let item = remaining_pins.remove(pos);
                new_pinned.push(item);
            }
        }

        new_pinned.extend(remaining_pins);
        self.data.pinned = new_pinned;
        self.save()
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

    pub fn last_export_dir(&self) -> Option<&str> {
        self.data.last_export_dir.as_deref()
    }

    /// Merkt das zuletzt gewaehlte Export-Zielverzeichnis und
    /// persistiert es sofort.
    pub fn set_last_export_dir(&mut self, dir: String) -> io::Result<()> {
        self.data.last_export_dir = Some(normalize_path(&dir));
        self.save()
    }

    /// Schreibt alle gehaltenen Pfade unter `old_root` auf `new_root` um
    /// (Pins, Recents, `image_dirs` Key *und* Value, `last_export_dir`).
    /// Präfix-Match auf Segmentgrenze.
    pub fn remap_prefix(&mut self, old_root: &str, new_root: &str) -> io::Result<()> {
        let old_root = crate::path_migration::normalize(old_root);
        let new_root = crate::path_migration::normalize(new_root);
        let mut dirty = false;

        for item in &mut self.data.pinned {
            if let Some(rewritten) = crate::path_migration::remap(&item.path, &old_root, &new_root)
            {
                item.path = rewritten;
                dirty = true;
            }
        }
        for item in &mut self.data.recent {
            if let Some(rewritten) = crate::path_migration::remap(&item.path, &old_root, &new_root)
            {
                item.path = rewritten;
                dirty = true;
            }
        }

        let mut next_dirs = HashMap::new();
        let mut dirs_changed = false;
        for (key, value) in &self.data.image_dirs {
            let new_key = crate::path_migration::remap(key, &old_root, &new_root)
                .unwrap_or_else(|| key.clone());
            let new_value = crate::path_migration::remap(value, &old_root, &new_root)
                .unwrap_or_else(|| value.clone());
            if new_key != *key || new_value != *value {
                dirs_changed = true;
            }
            next_dirs.insert(new_key, new_value);
        }
        if dirs_changed {
            self.data.image_dirs = next_dirs;
            dirty = true;
        }

        if let Some(dir) = &self.data.last_export_dir {
            if let Some(rewritten) = crate::path_migration::remap(dir, &old_root, &new_root) {
                self.data.last_export_dir = Some(rewritten);
                dirty = true;
            }
        }

        if dirty {
            self.save()
        } else {
            Ok(())
        }
    }

    /// Entfernt Pins, Recents und Image-Dir-Einträge unter `root`
    /// (inklusive `root` selbst). `last_export_dir` wird geleert, wenn
    /// es darunter liegt.
    pub fn remove_under(&mut self, root: &str) -> io::Result<()> {
        let root = crate::path_migration::normalize(root);
        let pinned_before = self.data.pinned.len();
        let recent_before = self.data.recent.len();
        self.data
            .pinned
            .retain(|item| !crate::path_migration::is_under(&item.path, &root));
        self.data
            .recent
            .retain(|item| !crate::path_migration::is_under(&item.path, &root));
        let dirs_before = self.data.image_dirs.len();
        self.data.image_dirs.retain(|key, value| {
            !crate::path_migration::is_under(key, &root)
                && !crate::path_migration::is_under(value, &root)
        });
        let mut export_cleared = false;
        if self
            .data
            .last_export_dir
            .as_deref()
            .is_some_and(|dir| crate::path_migration::is_under(dir, &root))
        {
            self.data.last_export_dir = None;
            export_cleared = true;
        }
        if pinned_before != self.data.pinned.len()
            || recent_before != self.data.recent.len()
            || dirs_before != self.data.image_dirs.len()
            || export_cleared
        {
            self.save()
        } else {
            Ok(())
        }
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
    fn clear_recent_empties_and_persists() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("workspace.json");
        let mut workspace = Workspace::load_from(path.clone());
        workspace.add_recent("/a.md".into()).unwrap();
        workspace.add_recent("/b.md".into()).unwrap();
        workspace.clear_recent().unwrap();
        assert!(workspace.recent().is_empty());
        // Persistiert: nach erneutem Load bleibt die Liste leer.
        let reloaded = Workspace::load_from(path);
        assert!(reloaded.recent().is_empty());
    }

    #[test]
    fn persists_and_reloads() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("workspace.json");
        let mut workspace = Workspace::load_from(path.clone());
        workspace.pin("/a".into(), false).unwrap();
        workspace.add_recent("/b".into()).unwrap();
        workspace
            .set_open_tabs(
                vec![r"C:\notes\a.md".into(), r"D:\docs\b.md".into()],
                Some(1),
            )
            .unwrap();
        let loaded = Workspace::load_from(path);
        assert_eq!(workspace.data(), loaded.data());
        assert_eq!(workspace.open_tabs(), ["C:/notes/a.md", "D:/docs/b.md"]);
        assert_eq!(workspace.active_tab(), Some(1));
    }

    #[test]
    fn legacy_workspace_without_tab_fields_uses_migration_defaults() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("workspace.json");
        std::fs::write(&path, r#"{"pinned":[],"recent":[]}"#).unwrap();

        let workspace = Workspace::load_from(path);

        assert!(workspace.open_tabs().is_empty());
        assert_eq!(workspace.active_tab(), None);
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
                "open_tabs":["C:\\Users\\tab.md"],
                "active_tab":0,
                "image_dirs":{},
                "last_export_dir":"C:\\Exports"}"#,
        )
        .unwrap();
        let workspace = Workspace::load_from(path.clone());
        assert_eq!("C:/Users/a.md", workspace.pinned()[0].path);
        assert_eq!("C:/Users/b.md", workspace.recent()[0].path);
        assert_eq!(workspace.open_tabs(), ["C:/Users/tab.md"]);
        assert_eq!(workspace.active_tab(), Some(0));
        assert_eq!(Some("C:/Exports"), workspace.last_export_dir());
        // Migration persistiert: nach erneutem Load steht Forward-Slash drin.
        let reloaded = Workspace::load_from(path);
        assert_eq!("C:/Users/a.md", reloaded.pinned()[0].path);
        assert_eq!(reloaded.open_tabs(), ["C:/Users/tab.md"]);
        assert_eq!(Some("C:/Exports"), reloaded.last_export_dir());
    }

    #[test]
    fn last_export_dir_normalizes_persists_and_reloads() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("workspace.json");
        let mut workspace = Workspace::load_from(path.clone());
        workspace
            .set_last_export_dir(r"C:\Users\rakul\Exports".into())
            .unwrap();
        assert_eq!(Some("C:/Users/rakul/Exports"), workspace.last_export_dir());

        let reloaded = Workspace::load_from(path);
        assert_eq!(Some("C:/Users/rakul/Exports"), reloaded.last_export_dir());
    }

    #[test]
    fn reorder_pinned_works() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/a".into(), true).unwrap();
        workspace.pin("/b".into(), false).unwrap();
        workspace.pin("/c".into(), true).unwrap();
        workspace.pin("/d".into(), false).unwrap();

        // Reorder sub-list: /c, then /b.
        // /a and /d should be appended in original order because they are omitted.
        workspace
            .reorder_pinned(vec!["/c".into(), "/b".into(), "/unknown".into()])
            .unwrap();

        let pinned = workspace.pinned();
        assert_eq!(pinned.len(), 4);
        assert_eq!(pinned[0].path, "/c");
        assert!(pinned[0].is_directory);
        assert_eq!(pinned[1].path, "/b");
        assert!(!pinned[1].is_directory);
        assert_eq!(pinned[2].path, "/a");
        assert!(pinned[2].is_directory);
        assert_eq!(pinned[3].path, "/d");
        assert!(!pinned[3].is_directory);
    }

    #[test]
    fn remap_prefix_migrates_pins_recents_and_image_dirs() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/a/notizen".into(), true).unwrap();
        workspace.pin("/a/notizen-alt".into(), true).unwrap();
        workspace.pin("/a/notizen/sub".into(), true).unwrap();
        workspace.add_recent("/a/notizen/x.md".into()).unwrap();
        workspace.add_recent("/a/other.md".into()).unwrap();
        workspace
            .set_image_dir("/a/notizen/doc.md".into(), "/a/notizen/imgs".into())
            .unwrap();
        workspace
            .set_image_dir("/a/other.md".into(), "/a/notizen/imgs".into())
            .unwrap();
        workspace
            .set_last_export_dir("/a/notizen/out".into())
            .unwrap();

        workspace.remap_prefix("/a/notizen", "/a/notes").unwrap();

        let pins: Vec<&str> = workspace.pinned().iter().map(|p| p.path.as_str()).collect();
        assert_eq!(pins, ["/a/notes", "/a/notizen-alt", "/a/notes/sub"]);

        let recents: Vec<&str> = workspace.recent().iter().map(|r| r.path.as_str()).collect();
        assert_eq!(recents, ["/a/other.md", "/a/notes/x.md"]);

        assert_eq!(
            workspace.image_dir("/a/notes/doc.md"),
            Some("/a/notes/imgs")
        );
        assert_eq!(workspace.image_dir("/a/notizen/doc.md"), None);
        assert_eq!(workspace.image_dir("/a/other.md"), Some("/a/notes/imgs"));
        assert_eq!(Some("/a/notes/out"), workspace.last_export_dir());
    }

    #[test]
    fn remove_under_drops_pins_recents_image_dirs_and_export() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/a/notizen".into(), true).unwrap();
        workspace.pin("/a/notizen-alt".into(), true).unwrap();
        workspace.pin("/a/notizen/sub".into(), true).unwrap();
        workspace.add_recent("/a/notizen/x.md".into()).unwrap();
        workspace.add_recent("/a/other.md".into()).unwrap();
        workspace
            .set_image_dir("/a/notizen/doc.md".into(), "/tmp/imgs".into())
            .unwrap();
        workspace
            .set_image_dir("/a/other.md".into(), "/a/notizen/imgs".into())
            .unwrap();
        workspace
            .set_last_export_dir("/a/notizen/out".into())
            .unwrap();

        workspace.remove_under("/a/notizen").unwrap();

        let pins: Vec<&str> = workspace.pinned().iter().map(|p| p.path.as_str()).collect();
        assert_eq!(pins, ["/a/notizen-alt"]);
        let recents: Vec<&str> = workspace.recent().iter().map(|r| r.path.as_str()).collect();
        assert_eq!(recents, ["/a/other.md"]);
        assert_eq!(workspace.image_dir("/a/notizen/doc.md"), None);
        assert_eq!(workspace.image_dir("/a/other.md"), None);
        assert_eq!(workspace.last_export_dir(), None);
    }
}
