use crate::document_store::{DocumentEvents, DocumentStore, LoadedDocument};
use crate::navigation::NavigationController;
use serde::Serialize;
use std::{io, path::Path, sync::Arc};

pub type DocumentEventFactory = Arc<dyn Fn(u64) -> DocumentEvents + Send + Sync>;

pub struct Tab {
    pub id: u64,
    pub document_store: DocumentStore,
    pub navigation: NavigationController,
    pub view_mode: String,
    /// Beim Session-Restore werden inaktive Dokumente nur als Pfad
    /// repraesentiert. Der DocumentStore bleibt bis zur ersten Aktivierung
    /// leer und erzeugt deshalb weder Datei-IO noch einen Watcher.
    pending_path: Option<String>,
}

impl Tab {
    fn new(id: u64) -> Self {
        Self {
            id,
            document_store: DocumentStore::new(),
            navigation: NavigationController::new(),
            view_mode: "view".to_string(),
            pending_path: None,
        }
    }

    pub fn document_path(&self) -> Option<&str> {
        self.document_store
            .path
            .as_deref()
            .or(self.pending_path.as_deref())
    }

    pub fn pending_path(&self) -> Option<&str> {
        self.pending_path.as_deref()
    }

    pub fn set_pending_path(&mut self, path: String) {
        self.document_store.close();
        self.pending_path = Some(path.replace('\\', "/"));
    }

    pub fn retarget_pending_path(&mut self, path: String) {
        self.pending_path = Some(path.replace('\\', "/"));
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreReport {
    pub discarded_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSummary {
    pub id: u64,
    pub path: Option<String>,
    pub dirty: bool,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsPayload {
    pub tabs: Vec<TabSummary>,
    pub active_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
}

pub struct TabManager {
    tabs: Vec<Tab>,
    active: usize,
    next_id: u64,
    document_event_factory: Option<DocumentEventFactory>,
}

impl Default for TabManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TabManager {
    pub fn new() -> Self {
        Self {
            tabs: vec![Tab::new(1)],
            active: 0,
            next_id: 2,
            document_event_factory: None,
        }
    }

    pub fn active(&self) -> &Tab {
        &self.tabs[self.active]
    }

    pub fn active_mut(&mut self) -> &mut Tab {
        &mut self.tabs[self.active]
    }

    pub fn tabs(&self) -> &[Tab] {
        &self.tabs
    }

    pub fn active_index(&self) -> usize {
        self.active
    }

    pub fn is_active(&self, tab_id: u64) -> bool {
        self.active().id == tab_id
    }

    /// Mindestens ein Tab hat ungespeicherte Aenderungen (Quit-Gate).
    pub fn any_dirty(&self) -> bool {
        self.tabs.iter().any(|tab| tab.document_store.is_dirty)
    }

    pub fn tab(&self, id: u64) -> Option<&Tab> {
        self.tabs.iter().find(|tab| tab.id == id)
    }

    pub fn tab_mut(&mut self, id: u64) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|tab| tab.id == id)
    }

    pub fn find_by_path(&self, path: &str) -> Option<u64> {
        let path = path.replace('\\', "/");
        self.tabs
            .iter()
            .find(|tab| tab.document_path() == Some(path.as_str()))
            .map(|tab| tab.id)
    }

    pub fn summaries(&self) -> Vec<TabSummary> {
        let active_id = self.active().id;
        self.tabs
            .iter()
            .map(|tab| TabSummary {
                id: tab.id,
                path: tab.document_path().map(|path| path.replace('\\', "/")),
                dirty: tab.document_store.is_dirty,
                active: tab.id == active_id,
            })
            .collect()
    }

    /// Fuegt einen leeren Tab direkt hinter dem aktiven Tab ein und
    /// aktiviert ihn.
    pub fn add_tab(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).expect("tab ID space exhausted");
        let mut tab = Tab::new(id);
        if let Some(factory) = &self.document_event_factory {
            tab.document_store.set_events(factory(id));
        }
        let insert_at = self.active + 1;
        self.tabs.insert(insert_at, tab);
        self.active = insert_at;
        id
    }

    pub fn activate(&mut self, id: u64) -> bool {
        let Some(index) = self.tabs.iter().position(|tab| tab.id == id) else {
            return false;
        };
        self.active = index;
        true
    }

    /// Entfernt einen Tab. Der letzte Tab bleibt als leerer Container
    /// bestehen; dessen Dokumentzustand wird wie bei `close_document`
    /// geschlossen.
    pub fn close(&mut self, id: u64) -> bool {
        let Some(index) = self.tabs.iter().position(|tab| tab.id == id) else {
            return false;
        };
        if self.tabs.len() == 1 {
            self.tabs[0].document_store.close();
            self.tabs[0].pending_path = None;
            return true;
        }

        self.tabs.remove(index);
        if index < self.active {
            self.active -= 1;
        } else if index == self.active {
            self.active = index.min(self.tabs.len() - 1);
        }
        true
    }

    /// E2E-Isolation: verwirft alle anderen Tabs und setzt den aktiven
    /// Tab einschließlich History und View-Mode auf Boot-Zustand zurück.
    pub fn close_all(&mut self) {
        let mut tab = self.tabs.remove(self.active);
        tab.document_store.close();
        tab.pending_path = None;
        tab.navigation = NavigationController::new();
        tab.view_mode = "view".to_string();
        self.tabs.clear();
        self.tabs.push(tab);
        self.active = 0;
    }

    pub fn set_document_event_factory(&mut self, factory: DocumentEventFactory) {
        for tab in &mut self.tabs {
            tab.document_store.set_events(factory(tab.id));
        }
        self.document_event_factory = Some(factory);
    }

    /// Liefert nur dokumenttragende Tabs fuer workspace.json. Ein leerer
    /// Container-Tab wird nicht persistiert; `active_tab` ist ein Index in
    /// der gefilterten Pfadliste.
    pub fn session_state(&self) -> (Vec<String>, Option<usize>) {
        let active_id = self.active().id;
        let mut open_tabs = Vec::new();
        let mut active_tab = None;
        for tab in &self.tabs {
            let Some(path) = tab.document_path() else {
                continue;
            };
            if tab.id == active_id {
                active_tab = Some(open_tabs.len());
            }
            open_tabs.push(path.replace('\\', "/"));
        }
        (open_tabs, active_tab)
    }

    /// Baut die beim letzten Lauf dokumenttragenden Tabs in gespeicherter
    /// Reihenfolge wieder auf. Alle Pfade starten pending; der Aufrufer
    /// laedt danach ausschliesslich den aktiven Tab. Fehlende Dateien
    /// werden aus dem Ergebnis entfernt und fuer ein Warn-Log gemeldet.
    pub fn restore_session(
        &mut self,
        open_tabs: &[String],
        active_tab: Option<usize>,
    ) -> RestoreReport {
        let mut restored = Vec::new();
        let mut discarded_paths = Vec::new();
        for (original_index, path) in open_tabs.iter().enumerate() {
            let normalized = path.replace('\\', "/");
            if Path::new(&normalized).is_file() {
                restored.push((original_index, normalized));
            } else {
                discarded_paths.push(normalized);
            }
        }

        self.close_all();
        if restored.is_empty() {
            return RestoreReport { discarded_paths };
        }

        let first_path = restored[0].1.clone();
        self.tabs[0].set_pending_path(first_path);
        for (_, path) in restored.iter().skip(1) {
            let id = self.next_id;
            self.next_id = self.next_id.checked_add(1).expect("tab ID space exhausted");
            let mut tab = Tab::new(id);
            if let Some(factory) = &self.document_event_factory {
                tab.document_store.set_events(factory(id));
            }
            tab.set_pending_path(path.clone());
            self.tabs.push(tab);
        }
        self.active = active_tab
            .and_then(|wanted| {
                restored
                    .iter()
                    .position(|(original_index, _)| *original_index == wanted)
                    .or_else(|| Some(wanted.min(restored.len() - 1)))
            })
            .unwrap_or(0);

        RestoreReport { discarded_paths }
    }

    /// Laedt den pending Pfad des aktiven Tabs genau einmal. Der Loader
    /// wird injiziert, damit Restore/Aktivierung ohne AppHandle testbar
    /// bleiben und die FileKind-Auswahl im document_service wohnen kann.
    pub fn load_active_pending<F>(&mut self, loader: F) -> io::Result<Option<LoadedDocument>>
    where
        F: FnOnce(&mut DocumentStore, &str) -> io::Result<LoadedDocument>,
    {
        let Some(path) = self.active().pending_path.clone() else {
            return Ok(None);
        };
        let tab = self.active_mut();
        let loaded = loader(&mut tab.document_store, &path)?;
        tab.pending_path = None;
        tab.navigation.navigate(path, None);
        Ok(Some(loaded))
    }

    /// Reorders the tabs vec to exactly match the given id sequence.
    /// `ids` must be an exact permutation of the current tab IDs (same
    /// count, no foreign/missing/dup ids). Returns false on validation
    /// failure (state unchanged). On success the active tab (by ID)
    /// keeps its identity; its index is updated to the new position.
    /// Only used for document tabs (virtual tabs live only in frontend).
    pub fn reorder(&mut self, ids: &[u64]) -> bool {
        if ids.len() != self.tabs.len() {
            return false;
        }
        let id_to_idx: std::collections::HashMap<u64, usize> = self
            .tabs
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id, i))
            .collect();
        if id_to_idx.len() != ids.len() {
            return false; // dups in current (should not happen)
        }
        let mut seen = std::collections::HashSet::new();
        for &id in ids {
            if !id_to_idx.contains_key(&id) || !seen.insert(id) {
                return false;
            }
        }
        if seen.len() != id_to_idx.len() {
            return false;
        }

        let active_id = self.active().id;
        let mut old_tabs = std::mem::take(&mut self.tabs);
        let mut new_tabs: Vec<Tab> = Vec::with_capacity(ids.len());
        for &id in ids {
            if let Some(pos) = old_tabs.iter().position(|t| t.id == id) {
                new_tabs.push(old_tabs.remove(pos));
            } else {
                // should not reach due to prior checks
                self.tabs = old_tabs; // restore to avoid broken state
                return false;
            }
        }
        self.tabs = new_tabs;

        if let Some(new_idx) = self.tabs.iter().position(|t| t.id == active_id) {
            self.active = new_idx;
        } else {
            self.active = 0;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_starts_with_exactly_one_active_tab() {
        let manager = TabManager::new();

        assert_eq!(1, manager.tabs().len());
        assert_eq!(0, manager.active_index());
        assert_eq!(1, manager.active().id);
        assert!(manager.active().document_store.path.is_none());
        assert!(manager.active().navigation.current().is_none());
        assert_eq!("view", manager.active().view_mode);
    }

    #[test]
    fn active_mut_updates_the_active_tab() {
        let mut manager = TabManager::new();

        manager.active_mut().view_mode = "edit".to_string();

        assert_eq!("edit", manager.active().view_mode);
    }

    #[test]
    fn tab_ids_are_monotonically_increasing() {
        let mut manager = TabManager::new();

        let second = manager.add_tab();
        let third = manager.add_tab();

        assert_eq!(2, second);
        assert_eq!(3, third);
        assert_eq!(
            vec![1, 2, 3],
            manager.tabs().iter().map(|tab| tab.id).collect::<Vec<_>>()
        );
        assert_eq!(3, manager.active().id);
    }

    #[test]
    fn event_factory_is_called_for_existing_and_new_tabs() {
        let mut manager = TabManager::new();
        let wired_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured_ids = Arc::clone(&wired_ids);

        manager.set_document_event_factory(Arc::new(move |id| {
            captured_ids.lock().unwrap().push(id);
            DocumentEvents::default()
        }));
        manager.add_tab();

        assert_eq!(*wired_ids.lock().unwrap(), vec![1, 2]);
    }

    #[test]
    fn add_inserts_behind_active_and_activates() {
        let mut manager = TabManager::new();
        let second = manager.add_tab();
        assert!(manager.activate(1));
        let third = manager.add_tab();

        assert_eq!(
            vec![1, 3, second],
            manager.tabs().iter().map(|tab| tab.id).collect::<Vec<_>>()
        );
        assert_eq!(third, manager.active().id);
    }

    #[test]
    fn close_active_selects_next_or_previous_neighbor() {
        let mut manager = TabManager::new();
        let second = manager.add_tab();
        let third = manager.add_tab();

        assert!(manager.close(third));
        assert_eq!(second, manager.active().id);
        assert!(manager.close(second));
        assert_eq!(1, manager.active().id);
    }

    #[test]
    fn close_inactive_preserves_active_tab() {
        let mut manager = TabManager::new();
        let second = manager.add_tab();

        assert!(manager.close(1));
        assert_eq!(second, manager.active().id);
        assert_eq!(1, manager.tabs().len());
    }

    #[test]
    fn close_last_keeps_empty_tab() {
        let mut manager = TabManager::new();
        manager.active_mut().document_store.path = Some("/a.md".into());
        manager.active_mut().document_store.is_dirty = true;

        assert!(manager.close(1));
        assert_eq!(1, manager.tabs().len());
        assert_eq!(1, manager.active().id);
        assert!(manager.active().document_store.path.is_none());
        assert!(!manager.active().document_store.is_dirty);
    }

    #[test]
    fn close_all_keeps_active_id_and_resets_history_and_mode() {
        let mut manager = TabManager::new();
        manager.active_mut().navigation.navigate("/a.md", None);
        manager.active_mut().view_mode = "edit".into();
        manager.add_tab();
        let active_id = manager.active().id;
        manager.active_mut().navigation.navigate("/b.md", None);
        manager.active_mut().document_store.path = Some("/b.md".into());

        manager.close_all();

        assert_eq!(1, manager.tabs().len());
        assert_eq!(active_id, manager.active().id);
        assert!(manager.active().document_store.path.is_none());
        assert!(manager.active().navigation.current().is_none());
        assert_eq!("view", manager.active().view_mode);
    }

    #[test]
    fn summaries_and_path_lookup_use_normalized_paths() {
        let mut manager = TabManager::new();
        manager.active_mut().document_store.path = Some("C:/notes/a.md".into());
        manager.active_mut().document_store.is_dirty = true;

        assert_eq!(Some(1), manager.find_by_path(r"C:\notes\a.md"));
        assert_eq!(
            vec![TabSummary {
                id: 1,
                path: Some("C:/notes/a.md".into()),
                dirty: true,
                active: true,
            }],
            manager.summaries()
        );
    }

    #[test]
    fn session_state_omits_empty_tabs_and_indexes_filtered_paths() {
        let mut manager = TabManager::new();
        manager.active_mut().document_store.path = Some("/a.md".into());
        let empty_id = manager.add_tab();

        assert_eq!(manager.session_state(), (vec!["/a.md".into()], None));

        assert!(manager.activate(1));
        assert_eq!(manager.session_state(), (vec!["/a.md".into()], Some(0)));
        assert!(manager.activate(empty_id));
    }

    #[test]
    fn restore_discards_dead_paths_and_preserves_active_document() {
        let temp = tempfile::TempDir::new().unwrap();
        let first = temp.path().join("first.md");
        let dead = temp.path().join("dead.md");
        let third = temp.path().join("third.md");
        std::fs::write(&first, "first").unwrap();
        std::fs::write(&third, "third").unwrap();
        let paths = vec![
            first.to_string_lossy().into_owned(),
            dead.to_string_lossy().into_owned(),
            third.to_string_lossy().into_owned(),
        ];
        let mut manager = TabManager::new();

        let report = manager.restore_session(&paths, Some(2));

        assert_eq!(
            report.discarded_paths,
            vec![dead.to_string_lossy().replace('\\', "/")]
        );
        assert_eq!(manager.tabs().len(), 2);
        assert_eq!(manager.active_index(), 1);
        assert_eq!(
            manager.active().document_path(),
            Some(third.to_string_lossy().replace('\\', "/").as_str())
        );
        assert!(manager
            .tabs()
            .iter()
            .all(|tab| tab.document_store.path.is_none()));
    }

    #[test]
    fn first_activation_loads_pending_document() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("lazy.md");
        std::fs::write(&path, "lazy body").unwrap();
        let normalized = path.to_string_lossy().replace('\\', "/");
        let mut manager = TabManager::new();
        manager.restore_session(std::slice::from_ref(&normalized), Some(0));

        assert_eq!(manager.active().pending_path(), Some(normalized.as_str()));
        assert!(manager.active().document_store.path.is_none());

        let loaded = manager
            .load_active_pending(|store, path| store.load(path))
            .unwrap()
            .expect("pending tab must load");

        assert_eq!(loaded.text, "lazy body");
        assert_eq!(
            manager.active().document_store.path.as_deref(),
            Some(normalized.as_str())
        );
        assert_eq!(manager.active().pending_path(), None);
        assert_eq!(
            manager
                .active()
                .navigation
                .current()
                .map(|entry| entry.absolute_path.as_str()),
            Some(normalized.as_str())
        );
    }

    #[test]
    fn reorder_valid_permutation_updates_vec_and_preserves_active_by_id() {
        let mut manager = TabManager::new();
        manager.active_mut().document_store.path = Some("/a.md".into());
        let id_b = manager.add_tab();
        manager.active_mut().document_store.path = Some("/b.md".into());
        let _c = manager.add_tab();
        manager.active_mut().document_store.path = Some("/c.md".into());
        let _d = manager.add_tab();
        manager.active_mut().document_store.path = Some("/d.md".into());
        // active is d=4
        assert!(manager.activate(id_b)); // activate b=2

        let ids: Vec<u64> = manager.tabs().iter().map(|t| t.id).collect();
        assert_eq!(vec![1u64, 2, 3, 4], ids);

        // reorder to c, a, d, b  (ids 3,1,4,2)
        let new_order = vec![3, 1, 4, 2];
        assert!(manager.reorder(&new_order));
        let after: Vec<u64> = manager.tabs().iter().map(|t| t.id).collect();
        assert_eq!(vec![3u64, 1, 4, 2], after);
        assert_eq!(manager.active().id, 2); // still b
        assert_eq!(manager.active_index(), 3);

        // session payload reflects new doc order + active index in filtered (all docs)
        let (paths, act_idx) = manager.session_state();
        assert_eq!(paths, vec!["/c.md", "/a.md", "/d.md", "/b.md"]);
        assert_eq!(act_idx, Some(3));
    }

    #[test]
    fn reorder_rejects_non_permutations() {
        let mut manager = TabManager::new();
        manager.active_mut().document_store.path = Some("/x.md".into());
        manager.add_tab();
        manager.active_mut().document_store.path = Some("/y.md".into());

        assert!(!manager.reorder(&[1, 2, 3])); // too long
        assert!(!manager.reorder(&[1])); // too short
        assert!(!manager.reorder(&[99, 2])); // foreign
        assert!(!manager.reorder(&[1, 1])); // dup
        assert!(!manager.reorder(&[2, 1, 1])); // len mismatch + dup
                                               // state unchanged
        assert_eq!(manager.tabs().len(), 2);
        assert_eq!(manager.active().id, 2);
    }

    #[test]
    fn reorder_active_remains_after_reorder_and_session_index_is_correct() {
        let mut manager = TabManager::new();
        manager.active_mut().document_store.path = Some("/p1.md".into());
        let id2 = manager.add_tab();
        manager.active_mut().document_store.path = Some("/p2.md".into());
        let id3 = manager.add_tab();
        manager.active_mut().document_store.path = Some("/p3.md".into());
        assert!(manager.activate(id2));

        assert!(manager.reorder(&[id3, id2, 1]));
        assert_eq!(manager.active().id, id2);
        let (paths, act) = manager.session_state();
        assert_eq!(paths, vec!["/p3.md", "/p2.md", "/p1.md"]);
        assert_eq!(act, Some(1));
    }
}
