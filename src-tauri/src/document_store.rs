use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    thread,
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoadedDocument {
    pub path: String,
    pub text: String,
}

#[derive(Clone, Default)]
pub struct DocumentEvents {
    pub loaded: Option<Arc<dyn Fn(LoadedDocument) + Send + Sync>>,
    pub dirty_changed: Option<Arc<dyn Fn(bool) + Send + Sync>>,
    pub saved: Option<Arc<dyn Fn(String, String) + Send + Sync>>,
    pub text_changed: Option<Arc<dyn Fn(String) + Send + Sync>>,
    pub external_changed: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

pub struct DocumentStore {
    pub path: Option<String>,
    pub text: String,
    pub is_dirty: bool,
    pub has_external_changes: bool,
    pub line_ending: LineEnding,
    pub had_bom: bool,
    watcher: Option<RecommendedWatcher>,
    watcher_tx: Option<mpsc::Sender<PathBuf>>,
    events: DocumentEvents,
}

impl Default for DocumentStore {
    fn default() -> Self {
        Self {
            path: None,
            text: String::new(),
            is_dirty: false,
            has_external_changes: false,
            line_ending: LineEnding::Lf,
            had_bom: false,
            watcher: None,
            watcher_tx: None,
            events: DocumentEvents::default(),
        }
    }
}

impl DocumentStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_events(&mut self, events: DocumentEvents) {
        self.events = events;
    }

    pub fn load(&mut self, path: &str) -> io::Result<LoadedDocument> {
        let bytes = fs::read(path)?;
        let had_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
        let content = if had_bom { &bytes[3..] } else { &bytes };
        let raw = String::from_utf8(content.to_vec())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let line_ending = if raw.contains("\r\n") {
            LineEnding::Crlf
        } else {
            LineEnding::Lf
        };
        let text = raw.replace("\r\n", "\n");

        self.path = Some(path.to_string());
        self.text = text.clone();
        self.is_dirty = false;
        self.has_external_changes = false;
        self.line_ending = line_ending;
        self.had_bom = had_bom;
        self.watch(path)?;

        let loaded = LoadedDocument {
            path: path.to_string(),
            text,
        };
        if let Some(callback) = &self.events.loaded {
            callback(loaded.clone());
        }
        if let Some(callback) = &self.events.dirty_changed {
            callback(false);
        }
        Ok(loaded)
    }

    /// Setzt den Store auf "kein Dokument geladen" zurück. Der Watcher
    /// wird beim Drop des `RecommendedWatcher`-Felds automatisch
    /// abgemeldet. Feuert `dirty_changed(false)`, damit das Frontend den
    /// Dirty-Indikator zurücksetzt.
    pub fn close(&mut self) {
        self.path = None;
        self.text = String::new();
        self.is_dirty = false;
        self.has_external_changes = false;
        self.line_ending = LineEnding::Lf;
        self.had_bom = false;
        self.watcher = None;
        self.watcher_tx = None;
        if let Some(callback) = &self.events.dirty_changed {
            callback(false);
        }
    }

    pub fn update_text(&mut self, text: String) {
        if self.text == text {
            return;
        }
        self.text = text.clone();
        if self.path.is_some() {
            self.set_dirty(true);
        }
        if let Some(callback) = &self.events.text_changed {
            callback(text);
        }
    }

    pub fn save(&mut self) -> io::Result<bool> {
        let Some(path) = self.path.clone() else {
            return Ok(false);
        };
        let disk_text = match self.line_ending {
            LineEnding::Lf => self.text.clone(),
            LineEnding::Crlf => self.text.replace('\n', "\r\n"),
        };
        let mut bytes = Vec::with_capacity(disk_text.len() + 3);
        if self.had_bom {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        bytes.extend_from_slice(disk_text.as_bytes());
        fs::write(&path, bytes)?;
        self.has_external_changes = false;
        self.set_dirty(false);
        if let Some(callback) = &self.events.saved {
            callback(path, self.text.clone());
        }
        Ok(true)
    }

    /// Speichert den aktuellen Inhalt unter einem neuen Pfad. Behält
    /// `line_ending`/`had_bom` des Originals (User-Intent: „selbe Datei,
    /// nur woanders/anders benannt"). Hängt den Watcher um, ruft den
    /// `loaded`-Callback (damit das Frontend mit neuem Pfad/Kind/
    /// Sprache re-rendert) und triggert `dirty_changed(false)`.
    pub fn save_as(&mut self, new_path: &str) -> io::Result<LoadedDocument> {
        let disk_text = match self.line_ending {
            LineEnding::Lf => self.text.clone(),
            LineEnding::Crlf => self.text.replace('\n', "\r\n"),
        };
        let mut bytes = Vec::with_capacity(disk_text.len() + 3);
        if self.had_bom {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        bytes.extend_from_slice(disk_text.as_bytes());
        fs::write(new_path, bytes)?;

        self.path = Some(new_path.to_string());
        self.has_external_changes = false;
        self.set_dirty(false);
        self.watch(new_path)?;

        let loaded = LoadedDocument {
            path: new_path.to_string(),
            text: self.text.clone(),
        };
        if let Some(callback) = &self.events.loaded {
            callback(loaded.clone());
        }
        Ok(loaded)
    }

    /// Aktualisiert den Pfad, ohne den Inhalt neu zu lesen — die Datei
    /// liegt bereits unter `new_path` (per `fs::rename` durch den
    /// Aufrufer). Ersetzt den Watcher und feuert den `loaded`-Callback,
    /// damit das Frontend `kind`/`language` für die ggf. neue Endung
    /// nachzieht. `is_dirty` bleibt erhalten — der ungespeicherte
    /// Editor-Inhalt wandert mit der Datei mit.
    pub fn rename_to(&mut self, new_path: &str) -> io::Result<LoadedDocument> {
        self.path = Some(new_path.to_string());
        self.has_external_changes = false;
        self.watch(new_path)?;

        let loaded = LoadedDocument {
            path: new_path.to_string(),
            text: self.text.clone(),
        };
        if let Some(callback) = &self.events.loaded {
            callback(loaded.clone());
        }
        Ok(loaded)
    }

    pub fn mark_external_changed(&mut self, path: String) {
        if self.path.as_deref() != Some(path.as_str()) {
            return;
        }
        self.has_external_changes = true;
        if let Some(callback) = &self.events.external_changed {
            callback(path);
        }
    }

    pub(crate) fn set_dirty(&mut self, dirty: bool) {
        if self.is_dirty == dirty {
            return;
        }
        self.is_dirty = dirty;
        if let Some(callback) = &self.events.dirty_changed {
            callback(dirty);
        }
    }

    fn watch(&mut self, path: &str) -> io::Result<()> {
        // Stop any previous watcher thread by dropping its sender.
        self.watcher = None;
        self.watcher_tx = None;

        let path_buf = PathBuf::from(path);
        let watched_path = path_buf.clone();
        let callback = self.events.external_changed.clone();
        let (tx, rx) = mpsc::channel::<PathBuf>();
        self.watcher_tx = Some(tx.clone());

        thread::spawn(move || {
            while let Ok(changed) = rx.recv() {
                while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
                if let Some(callback) = &callback {
                    callback(changed.to_string_lossy().into_owned());
                }
            }
        });

        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                if let Ok(event) = result {
                    if is_write_event(&event)
                        && event
                            .paths
                            .iter()
                            .any(|path| same_path(path, &watched_path))
                    {
                        let _ = tx.send(watched_path.clone());
                    }
                }
            },
            Config::default(),
        )
        .map_err(io::Error::other)?;

        watcher
            .watch(Path::new(path), RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;
        self.watcher = Some(watcher);
        Ok(())
    }
}

fn is_write_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
    )
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || fs::canonicalize(a).ok() == fs::canonicalize(b).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_detects_bom_and_normalizes_crlf() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"\xEF\xBB\xBFone\r\ntwo\r\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        assert_eq!("one\ntwo\n", store.text);
        assert_eq!(LineEnding::Crlf, store.line_ending);
        assert!(store.had_bom);
    }

    #[test]
    fn update_text_sets_dirty_when_file_loaded() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, "one").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        store.update_text("two".into());
        assert!(store.is_dirty);
    }

    #[test]
    fn save_as_writes_target_and_updates_path() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("alt.md");
        let dst = temp.path().join("neu.md");
        fs::write(&src, b"hello\r\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(src.to_str().unwrap()).unwrap();
        store.update_text("world\n".into());
        assert!(store.is_dirty);
        let loaded = store.save_as(dst.to_str().unwrap()).unwrap();
        assert_eq!(dst.to_string_lossy().to_string(), loaded.path);
        // Pfad umgehängt, dirty zurückgesetzt
        assert_eq!(Some(dst.to_string_lossy().to_string()), store.path);
        assert!(!store.is_dirty);
        // Inhalt am neuen Pfad mit Original-Line-Endings (CRLF)
        assert_eq!(b"world\r\n".to_vec(), fs::read(&dst).unwrap());
        // Original bleibt unangetastet
        assert_eq!(b"hello\r\n".to_vec(), fs::read(&src).unwrap());
    }

    #[test]
    fn save_restores_original_line_endings_and_bom() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("doc.md");
        fs::write(&path, b"\xEF\xBB\xBFone\r\n").unwrap();
        let mut store = DocumentStore::new();
        store.load(path.to_str().unwrap()).unwrap();
        store.update_text("a\nb\n".into());
        assert!(store.save().unwrap());
        assert_eq!(b"\xEF\xBB\xBFa\r\nb\r\n".to_vec(), fs::read(path).unwrap());
        assert!(!store.is_dirty);
    }
}
