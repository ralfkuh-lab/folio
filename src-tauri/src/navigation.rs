#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub absolute_path: String,
    pub anchor: Option<String>,
    pub scroll_y: f64,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct NavigationController {
    history: Vec<Entry>,
    current_index: Option<usize>,
}

impl NavigationController {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn can_go_back(&self) -> bool {
        self.current_index.is_some_and(|index| index > 0)
    }

    pub fn can_go_forward(&self) -> bool {
        self.current_index
            .is_some_and(|index| index + 1 < self.history.len())
    }

    pub fn current(&self) -> Option<&Entry> {
        self.current_index.and_then(|index| self.history.get(index))
    }

    pub fn history(&self) -> &[Entry] {
        &self.history
    }

    pub fn current_index(&self) -> Option<usize> {
        self.current_index
    }

    pub fn navigate(&mut self, absolute_path: impl Into<String>, anchor: Option<String>) -> &Entry {
        let absolute_path = absolute_path.into();
        if self
            .current()
            .is_some_and(|entry| entry.absolute_path == absolute_path && entry.anchor == anchor)
        {
            return self.current().expect("current entry exists");
        }

        if let Some(index) = self.current_index {
            self.history.truncate(index + 1);
        } else {
            self.history.clear();
        }

        self.history.push(Entry {
            absolute_path,
            anchor,
            scroll_y: 0.0,
        });
        self.current_index = Some(self.history.len() - 1);
        self.current().expect("newly pushed entry exists")
    }

    pub fn go_back(&mut self) -> Option<&Entry> {
        if self.can_go_back() {
            self.current_index = self.current_index.map(|index| index - 1);
        }
        self.current()
    }

    pub fn go_forward(&mut self) -> Option<&Entry> {
        if self.can_go_forward() {
            self.current_index = self.current_index.map(|index| index + 1);
        }
        self.current()
    }

    pub fn update_scroll_position(&mut self, scroll_y: f64) {
        if let Some(index) = self.current_index {
            if let Some(entry) = self.history.get_mut(index) {
                entry.scroll_y = scroll_y;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_controller_has_no_current_or_movement() {
        let controller = NavigationController::new();

        assert!(!controller.can_go_back());
        assert!(!controller.can_go_forward());
        assert_eq!(None, controller.current());
        assert_eq!(None, controller.current_index());
        assert!(controller.history().is_empty());
    }

    #[test]
    fn navigate_adds_entries_and_truncates_forward_history() {
        let mut controller = NavigationController::new();

        controller.navigate("/a.md", None);
        controller.navigate("/b.md", Some("x".to_string()));
        controller.navigate("/c.md", None);
        controller.go_back();
        controller.navigate("/d.md", None);

        assert_eq!(Some(2), controller.current_index());
        assert_eq!("/d.md", controller.current().unwrap().absolute_path);
        assert_eq!(vec!["/a.md", "/b.md", "/d.md"], paths(controller.history()));
        assert!(!controller.can_go_forward());
    }

    #[test]
    fn navigate_deduplicates_current_path_and_anchor() {
        let mut controller = NavigationController::new();

        controller.navigate("/a.md", Some("one".to_string()));
        controller.update_scroll_position(42.0);
        controller.navigate("/a.md", Some("one".to_string()));

        assert_eq!(1, controller.history().len());
        assert_eq!(42.0, controller.current().unwrap().scroll_y);
    }

    #[test]
    fn same_path_with_different_anchor_is_new_entry() {
        let mut controller = NavigationController::new();

        controller.navigate("/a.md", Some("one".to_string()));
        controller.navigate("/a.md", Some("two".to_string()));

        assert_eq!(2, controller.history().len());
        assert_eq!(Some("two"), controller.current().unwrap().anchor.as_deref());
    }

    #[test]
    fn back_and_forward_walk_history_and_stay_at_edges() {
        let mut controller = NavigationController::new();

        controller.navigate("/a.md", None);
        controller.navigate("/b.md", None);

        assert!(controller.can_go_back());
        assert_eq!("/a.md", controller.go_back().unwrap().absolute_path);
        assert!(!controller.can_go_back());
        assert_eq!("/a.md", controller.go_back().unwrap().absolute_path);
        assert!(controller.can_go_forward());
        assert_eq!("/b.md", controller.go_forward().unwrap().absolute_path);
        assert!(!controller.can_go_forward());
        assert_eq!("/b.md", controller.go_forward().unwrap().absolute_path);
    }

    #[test]
    fn movement_on_empty_history_returns_none() {
        let mut controller = NavigationController::new();

        assert_eq!(None, controller.go_back());
        assert_eq!(None, controller.go_forward());
    }

    #[test]
    fn update_scroll_position_only_updates_current_entry() {
        let mut controller = NavigationController::new();

        controller.update_scroll_position(12.0);
        controller.navigate("/a.md", None);
        controller.navigate("/b.md", None);
        controller.go_back();
        controller.update_scroll_position(99.0);

        assert_eq!(99.0, controller.history()[0].scroll_y);
        assert_eq!(0.0, controller.history()[1].scroll_y);
    }

    fn paths(entries: &[Entry]) -> Vec<&str> {
        entries
            .iter()
            .map(|entry| entry.absolute_path.as_str())
            .collect()
    }
}
