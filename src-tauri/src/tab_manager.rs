use crate::document_store::{DocumentEvents, DocumentStore};
use crate::navigation::NavigationController;
use serde::Serialize;
use std::sync::Arc;

pub type DocumentEventFactory = Arc<dyn Fn(u64) -> DocumentEvents + Send + Sync>;

pub struct Tab {
    pub id: u64,
    pub document_store: DocumentStore,
    pub navigation: NavigationController,
    pub view_mode: String,
}

impl Tab {
    fn new(id: u64) -> Self {
        Self {
            id,
            document_store: DocumentStore::new(),
            navigation: NavigationController::new(),
            view_mode: "view".to_string(),
        }
    }
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
            .find(|tab| tab.document_store.path.as_deref() == Some(path.as_str()))
            .map(|tab| tab.id)
    }

    pub fn summaries(&self) -> Vec<TabSummary> {
        let active_id = self.active().id;
        self.tabs
            .iter()
            .map(|tab| TabSummary {
                id: tab.id,
                path: tab
                    .document_store
                    .path
                    .as_ref()
                    .map(|path| path.replace('\\', "/")),
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
}
