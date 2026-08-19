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

    /// Anzahl aktiver Watches (Tests / Diagnose).
    pub fn watched_count(&self) -> usize {
        self.watched.len()
    }

    /// Aktuell gewatchte Pfade unter `root` (inklusive `root` selbst,
    /// Segmentgrenze — `/a/x` darf `/a/x-alt` nicht mitziehen). Reine
    /// Abfrage: aendert weder Watches noch Vault-State. Gedacht fuer das
    /// Suspendieren offener Verzeichnis-Handles vor Shell-Operationen
    /// (Windows-Papierkorb, siehe `commands::file::delete`) — der Caller
    /// unwatcht die Liste und registriert sie im Fehlerfall erneut.
    pub fn watched_under(&self, root: &str) -> Vec<String> {
        self.watched
            .iter()
            .map(|entry| entry.to_string_lossy().into_owned())
            .filter(|path| crate::path_migration::is_under(path, root))
            .collect()
    }

    /// Beendet alle Watches (z. B. nach `Vault::collapse_all`).
    pub fn unwatch_all(&mut self) {
        self.dispose_all();
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

// ---------------------------------------------------------------------------
// GitHeadWatcher: NonRecursive-Watch auf aufgelöste .git/ (HEAD-Container)
// der gepinnten Git-Roots. Feuert bei Aenderungen an HEAD (Branch-Wechsel/
// Checkout) einen vault:refresh. Ignoriert index/refs-Geraeusche.
// ---------------------------------------------------------------------------

pub type GitHeadCallback = Arc<dyn Fn() + Send + Sync>;

pub struct GitHeadWatcher {
    watcher: Option<RecommendedWatcher>,
    watched: HashSet<PathBuf>,
    tx: Option<mpsc::Sender<()>>,
    callback: Option<GitHeadCallback>,
    enabled: bool,
}

impl Default for GitHeadWatcher {
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

impl GitHeadWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_callback(&mut self, callback: GitHeadCallback) {
        self.callback = Some(callback);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        if !enabled {
            self.dispose_all();
        }
    }

    /// Diff-basiertes Syncen der Watches auf genau die uebergebenen
    /// aufgeloesten Git-HEAD-Verzeichnisse (NonRecursive). Wird bei
    /// Boot, Pin/Unpin und vaultAutoRefresh-Toggle gerufen.
    pub fn sync(&mut self, gitdirs: Vec<PathBuf>) -> io::Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let new_set: HashSet<PathBuf> = gitdirs
            .into_iter()
            .map(|p| PathBuf::from(p.to_string_lossy().replace('\\', "/")))
            .collect();

        let to_unwatch: Vec<PathBuf> = self.watched.difference(&new_set).cloned().collect();
        for entry in to_unwatch {
            if let Some(watcher) = self.watcher.as_mut() {
                let _ = watcher.unwatch(&entry);
            }
            self.watched.remove(&entry);
        }

        let to_watch: Vec<PathBuf> = new_set.difference(&self.watched).cloned().collect();
        if !to_watch.is_empty() && self.watcher.is_none() {
            self.spawn_watcher()?;
        }
        for entry in to_watch {
            if let Some(watcher) = self.watcher.as_mut() {
                watcher
                    .watch(&entry, RecursiveMode::NonRecursive)
                    .map_err(io::Error::other)?;
                self.watched.insert(entry);
            }
        }
        if self.watched.is_empty() {
            self.dispose_all();
        }
        Ok(())
    }

    /// Beendet die Watches unter `root` (inklusive Gleichheit,
    /// Segmentgrenze) und liefert deren Anzahl. Wie bei [`VaultWatcher`]
    /// geht es um offene Verzeichnis-Handles vor einer Shell-Operation
    /// (Windows-Papierkorb): liegt ein aufgeloester `.git`-Ordner unter
    /// dem zu loeschenden Pfad, blockiert sein Handle den Move.
    /// Wiederhergestellt wird nicht hier, sondern ueber einen erneuten
    /// [`Self::sync`] mit der unveraenderten Pin-Liste — der diff-basierte
    /// Sync watcht alles wieder, was hier aus `watched` verschwunden ist.
    pub fn unwatch_under(&mut self, root: &str) -> usize {
        if self.watched.is_empty() {
            return 0;
        }
        let to_drop: Vec<PathBuf> = self
            .watched
            .iter()
            .filter(|entry| crate::path_migration::is_under(entry.to_string_lossy().as_ref(), root))
            .cloned()
            .collect();
        let count = to_drop.len();
        for entry in to_drop {
            if let Some(watcher) = self.watcher.as_mut() {
                let _ = watcher.unwatch(&entry);
            }
            self.watched.remove(&entry);
        }
        if self.watched.is_empty() {
            self.dispose_all();
        }
        count
    }

    fn dispose_all(&mut self) {
        self.watcher = None;
        self.tx = None;
        self.watched.clear();
    }

    fn spawn_watcher(&mut self) -> io::Result<()> {
        let (tx, rx) = mpsc::channel::<()>();
        self.tx = Some(tx.clone());
        let callback = self.callback.clone();
        thread::spawn(move || {
            while let Ok(()) = rx.recv() {
                // Debounce 200ms analog VaultWatcher
                while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
                if let Some(callback) = &callback {
                    callback();
                }
            }
        });
        let tx_for_watcher = tx;
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let Ok(event) = result else {
                    return;
                };
                if !has_head_path(&event) {
                    return;
                }
                let _ = tx_for_watcher.send(());
            },
            Config::default(),
        )
        .map_err(io::Error::other)?;
        self.watcher = Some(watcher);
        Ok(())
    }
}

fn has_head_path(event: &Event) -> bool {
    // Nur schreibende Aenderungen zaehlen: notify mappt auch reine
    // Lese-Zugriffe (IN_OPEN/IN_ACCESS/IN_CLOSE_NOWRITE) auf
    // EventKind::Access. Externe Tools (Shell-Prompts, herdr, IDEs)
    // pollen .git/HEAD lesend im Sekundentakt — ohne diesen Filter
    // wird jeder Read zum vault:refresh-Full-Rebuild (5-Hz-Sturm:
    // Dauer-CPU proportional zur Baumgroesse + verschluckte Klicks,
    // weil innerHTML-Replace mitten in der Pointer-Sequenz landet).
    // Git selbst ersetzt HEAD via write/rename → Modify/Create decken
    // echte Branch-Wechsel ab.
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
    ) {
        return false;
    }
    event
        .paths
        .iter()
        .any(|p| p.file_name() == Some(std::ffi::OsStr::new("HEAD")))
}

impl Drop for GitHeadWatcher {
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
    fn unwatch_all_clears_watches() {
        let mut w = VaultWatcher::new();
        w.set_callback(Arc::new(|_| {}));
        // watch may fail without real FS notify in some envs — still test clear.
        let _ = w.watch("/tmp/folio-vw-a");
        let _ = w.watch("/tmp/folio-vw-b");
        // Even if watch failed (no path), unwatch_all must not panic.
        w.unwatch_all();
        assert_eq!(w.watched_count(), 0);
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
    fn watched_under_respects_segment_boundary_and_includes_root() {
        // Grundlage des Watcher-Suspends vor der Shell-Loeschung:
        // `/a/x` darf `/a/x-alt` nicht mitziehen, der Root selbst zaehlt.
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("x");
        let child = root.join("sub");
        let sibling = temp.path().join("x-alt");
        fs::create_dir_all(&child).unwrap();
        fs::create_dir(&sibling).unwrap();

        let (cb, _sink) = make_callback();
        let mut w = VaultWatcher::new();
        w.set_callback(cb);
        w.watch(root.to_string_lossy().as_ref()).unwrap();
        w.watch(child.to_string_lossy().as_ref()).unwrap();
        w.watch(sibling.to_string_lossy().as_ref()).unwrap();

        let norm = |p: &std::path::Path| p.to_string_lossy().replace('\\', "/");
        let mut found = w.watched_under(root.to_string_lossy().as_ref());
        found.sort();
        let mut expected = vec![norm(&root), norm(&child)];
        expected.sort();
        assert_eq!(expected, found);

        // Unwatch der gemeldeten Pfade laesst das Geschwister-Verzeichnis
        // stehen; ein zweiter Unwatch ist ein No-op (Idempotenz — nach dem
        // Loeschen unwatcht `prune_vault_under` erneut).
        for path in &found {
            w.unwatch(path);
        }
        assert_eq!(1, w.watched_count());
        for path in &found {
            w.unwatch(path);
        }
        assert_eq!(1, w.watched_count());
        assert!(w
            .watched_under(temp.path().to_string_lossy().as_ref())
            .contains(&norm(&sibling)));
    }

    #[test]
    fn watched_under_is_empty_without_watches() {
        let w = VaultWatcher::new();
        assert!(w.watched_under("/a/x").is_empty());
    }

    #[test]
    fn git_head_unwatch_under_drops_only_matching_paths() {
        let temp = TempDir::new().unwrap();
        let inside = temp.path().join("repo").join(".git");
        let outside = temp.path().join("repo-alt").join(".git");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(inside.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(outside.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let (cb, _f) = make_git_callback();
        let mut w = GitHeadWatcher::new();
        w.set_callback(cb);
        w.sync(vec![inside.clone(), outside.clone()]).unwrap();
        assert_eq!(2, w.watched.len());

        let dropped = w.unwatch_under(temp.path().join("repo").to_string_lossy().as_ref());
        assert_eq!(1, dropped);
        assert_eq!(1, w.watched.len());
        let outside_norm = PathBuf::from(outside.to_string_lossy().replace('\\', "/"));
        assert!(
            w.watched.contains(&outside_norm),
            "repo-alt bleibt gewatcht"
        );

        // Restore laeuft ueber einen erneuten sync mit unveraenderter Liste.
        w.sync(vec![inside.clone(), outside]).unwrap();
        assert_eq!(2, w.watched.len());
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

    // --- GitHeadWatcher tests (analog zu VaultWatcher, mit fs_notify guard) ---

    fn make_git_callback() -> (GitHeadCallback, Arc<StdMutex<bool>>) {
        let fired = Arc::new(StdMutex::new(false));
        let fired_clone = fired.clone();
        let cb: GitHeadCallback = Arc::new(move || {
            *fired_clone.lock().unwrap() = true;
        });
        (cb, fired)
    }

    fn wait_for_git_fire(fired: &Arc<StdMutex<bool>>) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while std::time::Instant::now() < deadline {
            if *fired.lock().unwrap() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }

    #[test]
    fn git_head_disabled_is_noop() {
        let temp = TempDir::new().unwrap();
        let gitdir = temp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let (cb, fired) = make_git_callback();
        let mut w = GitHeadWatcher::new();
        w.set_callback(cb);
        w.set_enabled(false);
        w.sync(vec![gitdir.clone()]).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/other\n").unwrap();
        thread::sleep(Duration::from_millis(500));
        assert!(!*fired.lock().unwrap());
    }

    #[test]
    fn git_head_sync_empty_disposes() {
        let temp = TempDir::new().unwrap();
        let gitdir = temp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let (cb, _f) = make_git_callback();
        let mut w = GitHeadWatcher::new();
        w.set_callback(cb);
        w.sync(vec![gitdir.clone()]).unwrap();
        assert!(!w.watched.is_empty());
        w.sync(vec![]).unwrap();
        assert!(w.watched.is_empty());
    }

    #[test]
    fn git_head_read_does_not_fire() {
        // Regression: notify mappt Lese-Zugriffe (IN_ACCESS/IN_OPEN/
        // IN_CLOSE_NOWRITE) auf EventKind::Access. Externe HEAD-Poller
        // (Shell-Prompt, herdr) duerfen keinen vault:refresh ausloesen.
        if !fs_notify_available() {
            eprintln!("fs notify nicht verfuegbar, Test geskippt");
            return;
        }
        let temp = TempDir::new().unwrap();
        let gitdir = temp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let (cb, fired) = make_git_callback();
        let mut w = GitHeadWatcher::new();
        w.set_callback(cb);
        w.sync(vec![gitdir.clone()]).unwrap();

        for _ in 0..5 {
            let _ = fs::read_to_string(gitdir.join("HEAD")).unwrap();
            thread::sleep(Duration::from_millis(50));
        }
        thread::sleep(Duration::from_millis(500));
        assert!(
            !*fired.lock().unwrap(),
            "HEAD read fired GitHeadWatcher callback (Access-Events nicht gefiltert)"
        );
    }

    #[test]
    fn git_head_write_fires_but_index_does_not() {
        if !fs_notify_available() {
            eprintln!("fs notify nicht verfuegbar, Test geskippt");
            return;
        }
        let temp = TempDir::new().unwrap();
        let gitdir = temp.path().join(".git");
        fs::create_dir(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let (cb, fired) = make_git_callback();
        let mut w = GitHeadWatcher::new();
        w.set_callback(cb);
        w.sync(vec![gitdir.clone()]).unwrap();

        // HEAD change must fire
        *fired.lock().unwrap() = false;
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        assert!(
            wait_for_git_fire(&fired),
            "HEAD write did not fire GitHeadWatcher callback"
        );

        // index write must NOT fire (reset flag and write)
        *fired.lock().unwrap() = false;
        fs::write(gitdir.join("index"), "dummy").unwrap();
        // give it a moment; should stay false
        thread::sleep(Duration::from_millis(300));
        assert!(
            !*fired.lock().unwrap(),
            "index write must not fire GitHeadWatcher"
        );
    }
}
