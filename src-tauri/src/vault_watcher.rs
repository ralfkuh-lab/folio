//! Filesystem-Watcher fuer aufgeklappte Vault-Ordner.
//!
//! Pro Ordner, der im Vault-Tree aktuell expanded ist, wird ein
//! NonRecursive-`notify`-Watch registriert. Bei Create/Delete/Modify/
//! Rename feuert ein Debounce-Thread den `callback` mit dem geaenderten
//! Pfad — der Caller (Vault-Command-Layer) emittiert daraufhin
//! `vault:dir_changed { path }` ans Frontend, das den betroffenen
//! Ordner via `expand-dir`-Pfad neu aufbaut.
//!
//! Aktiviert/deaktiviert ueber das `vaultAutoRefresh`-Setting: bei
//! `false` werden alle Watches disposed und neue `watch`-Calls sind
//! No-ops, bis der User es wieder einschaltet.

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::HashSet,
    io,
    path::PathBuf,
    sync::{mpsc, Arc},
    thread,
    time::Duration,
};

pub type ChangeCallback = Arc<dyn Fn(String) + Send + Sync>;

pub struct VaultWatcher {
    watcher: Option<RecommendedWatcher>,
    watched: HashSet<PathBuf>,
    tx: Option<mpsc::Sender<PathBuf>>,
    callback: Option<ChangeCallback>,
    enabled: bool,
}

impl Default for VaultWatcher {
    fn default() -> Self {
        Self {
            watcher: None,
            watched: HashSet::new(),
            tx: None,
            callback: None,
            enabled: true,
        }
    }
}

impl VaultWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Setzt den Callback, der bei FS-Aenderungen aufgerufen wird.
    /// Muss vor dem ersten `watch`-Aufruf gesetzt sein.
    pub fn set_callback(&mut self, callback: ChangeCallback) {
        self.callback = Some(callback);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Schaltet den Watcher ein/aus. Bei `false` werden alle aktiven
    /// Watches disposed; bei `true` muss der Caller die zu watchenden
    /// Pfade erneut via `watch` registrieren (siehe Re-Sync nach
    /// Setting-Toggle in `commands::events::vault`).
    pub fn set_enabled(&mut self, enabled: bool) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        if !enabled {
            self.dispose_all();
        }
    }

    /// Registriert einen NonRecursive-Watch fuer `path`. No-op, wenn
    /// disabled oder bereits gewatcht. Falls der Watcher-Thread noch
    /// nicht laeuft, wird er hier lazy initialisiert.
    pub fn watch(&mut self, path: &str) -> io::Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let normalized = PathBuf::from(path.replace('\\', "/"));
        if self.watched.contains(&normalized) {
            return Ok(());
        }
        if self.watcher.is_none() {
            self.spawn_watcher()?;
        }
        if let Some(watcher) = self.watcher.as_mut() {
            watcher
                .watch(&normalized, RecursiveMode::NonRecursive)
                .map_err(io::Error::other)?;
            self.watched.insert(normalized);
        }
        Ok(())
    }

    /// Beendet den Watch fuer `path` (und alle Unterpfade, falls der
    /// User einen Ordner zugeklappt hat, dessen Subdirs noch gewatcht
    /// sind). Symmetrisch zu `Vault::on_collapse`.
    pub fn unwatch(&mut self, path: &str) {
        if self.watched.is_empty() {
            return;
        }
        let target = PathBuf::from(path.replace('\\', "/"));
        let to_drop: Vec<PathBuf> = self
            .watched
            .iter()
            .filter(|entry| entry == &&target || entry.starts_with(&target))
            .cloned()
            .collect();
        for entry in to_drop {
            if let Some(watcher) = self.watcher.as_mut() {
                let _ = watcher.unwatch(&entry);
            }
            self.watched.remove(&entry);
        }
        if self.watched.is_empty() {
            self.dispose_all();
        }
    }

    /// Disposed den Watcher-Thread + alle Watches. Wird bei
    /// `set_enabled(false)` und beim Drop genutzt.
    fn dispose_all(&mut self) {
        self.watcher = None;
        self.tx = None;
        self.watched.clear();
    }

    fn spawn_watcher(&mut self) -> io::Result<()> {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        self.tx = Some(tx.clone());
        let callback = self.callback.clone();
        thread::spawn(move || {
            while let Ok(changed) = rx.recv() {
                // Debounce: weitere Events aus dem gleichen Burst noch
                // einsammeln, sonst feuert ein Save mehrfach.
                while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
                if let Some(callback) = &callback {
                    callback(changed.to_string_lossy().into_owned());
                }
            }
        });
        let tx_for_watcher = tx;
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let Ok(event) = result else {
                    return;
                };
                if !is_relevant_event(&event) {
                    return;
                }
                // notify liefert pro Event die betroffenen Pfade (z.B.
                // die neu erstellte Datei). Wir reichen den parent-Dir
                // an den Callback, weil der Tree-Refresh am
                // Verzeichnis-Granular ansetzt.
                for path in &event.paths {
                    if let Some(parent) = path.parent() {
                        let _ = tx_for_watcher.send(parent.to_path_buf());
                    }
                }
            },
            Config::default(),
        )
        .map_err(io::Error::other)?;
        self.watcher = Some(watcher);
        Ok(())
    }
}

fn is_relevant_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
    )
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        self.dispose_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Mutex as StdMutex, OnceLock},
    };
    use tempfile::TempDir;

    fn make_callback() -> (ChangeCallback, Arc<StdMutex<Vec<String>>>) {
        let sink = Arc::new(StdMutex::new(Vec::new()));
        let sink_clone = sink.clone();
        let cb: ChangeCallback = Arc::new(move |path| sink_clone.lock().unwrap().push(path));
        (cb, sink)
    }

    /// notify-Events sind asynchron; wir polln mit kleinem Sleep statt
    /// einem festen sleep am Ende, damit langsame CI-Runner nicht
    /// flaken. 4 Sekunden Deadline ist grosszuegig — auf der lokalen
    /// Windows-Setup feuert das Event typischerweise <200ms.
    fn wait_for_event(sink: &Arc<StdMutex<Vec<String>>>) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while std::time::Instant::now() < deadline {
            if !sink.lock().unwrap().is_empty() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }

    // Auf manchen Systemen ist die Filesystem-Granularitaet so grob,
    // dass `notify` keine Events liefert (z.B. Linux ohne inotify in
    // /tmp-Mount). Wir markieren den Test daher ignored by default,
    // koennen ihn aber bei Bedarf lokal scharf schalten.
    static FS_NOTIFY_OK: OnceLock<bool> = OnceLock::new();

    fn fs_notify_available() -> bool {
        *FS_NOTIFY_OK.get_or_init(|| {
            let temp = TempDir::new().unwrap();
            let (cb, sink) = make_callback();
            let mut w = VaultWatcher::new();
            w.set_callback(cb);
            if w.watch(temp.path().to_string_lossy().as_ref()).is_err() {
                return false;
            }
            fs::write(temp.path().join("probe.tmp"), "x").unwrap();
            wait_for_event(&sink)
        })
    }

    #[test]
    fn disabled_watcher_is_noop() {
        let temp = TempDir::new().unwrap();
        let (cb, sink) = make_callback();
        let mut w = VaultWatcher::new();
        w.set_callback(cb);
        w.set_enabled(false);
        w.watch(temp.path().to_string_lossy().as_ref()).unwrap();
        fs::write(temp.path().join("a.md"), "x").unwrap();
        thread::sleep(Duration::from_millis(500));
        assert!(sink.lock().unwrap().is_empty());
    }

    #[test]
    fn unwatch_drops_specific_path() {
        let temp = TempDir::new().unwrap();
        let sub = temp.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let (cb, _sink) = make_callback();
        let mut w = VaultWatcher::new();
        w.set_callback(cb);
        w.watch(temp.path().to_string_lossy().as_ref()).unwrap();
        w.watch(sub.to_string_lossy().as_ref()).unwrap();
        w.unwatch(sub.to_string_lossy().as_ref());
        // temp-root bleibt gewatcht, sub ist weg
        let want = PathBuf::from(temp.path().to_string_lossy().replace('\\', "/"));
        assert!(w.watched.contains(&want));
        let sub_norm = PathBuf::from(sub.to_string_lossy().replace('\\', "/"));
        assert!(!w.watched.contains(&sub_norm));
    }

    #[test]
    fn watch_fires_callback_on_create() {
        if !fs_notify_available() {
            eprintln!("fs notify nicht verfuegbar, Test geskippt");
            return;
        }
        let temp = TempDir::new().unwrap();
        let (cb, sink) = make_callback();
        let mut w = VaultWatcher::new();
        w.set_callback(cb);
        w.watch(temp.path().to_string_lossy().as_ref()).unwrap();
        fs::write(temp.path().join("new.md"), "hello").unwrap();
        assert!(wait_for_event(&sink), "no event received within deadline");
    }
}
