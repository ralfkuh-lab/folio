use crate::document_store::{DocumentEvents, DocumentStore};
use crate::navigation::NavigationController;
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

    /// Fuegt einen leeren Tab hinzu, ohne ihn zu aktivieren. T1 nutzt
    /// weiterhin exakt einen Tab; die Methode kapselt bereits die
    /// monotone ID-Vergabe fuer die folgenden Etappen.
    pub fn add_tab(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).expect("tab ID space exhausted");
        let mut tab = Tab::new(id);
        if let Some(factory) = &self.document_event_factory {
            tab.document_store.set_events(factory(id));
        }
        self.tabs.push(tab);
        id
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
        assert_eq!(1, manager.active().id);
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
}
