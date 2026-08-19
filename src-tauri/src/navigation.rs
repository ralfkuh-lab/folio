#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub absolute_path: String,
    pub anchor: Option<String>,
    pub scroll_y: f64,
    pub view_mode: String,
    pub editor_scroll_y: f64,
    pub editor_cursor: usize,
}

fn default_view_mode() -> String {
    "view".to_string()
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
        // Dedup gegen den aktuellen Eintrag ueber die Datei-Identitaet:
        // dieselbe Datei ueber zwei Schreibweisen (Symlink-Verzeichnis,
        // Case) erzeugte sonst einen zweiten History-Eintrag, dessen
        // Back-Schritt optisch nichts tut.
        if self.current().is_some_and(|entry| {
            entry.anchor == anchor
                && crate::path_identity::same_file(&entry.absolute_path, &absolute_path)
        }) {
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
            view_mode: default_view_mode(),
            editor_scroll_y: 0.0,
            editor_cursor: 0,
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

    /// Setzt den Anker des AKTUELLEN Eintrags, ohne einen neuen zu pushen.
    /// Fuer Opens, bei denen der Ziel-Tab die Datei bereits zeigt
    /// (`tab_open` auf bestehenden Tab, `focus_existing_tab`): ein zweites
    /// `navigate` wuerde sonst einen History-Eintrag ohne Anker
    /// hinterlassen, der beim Zurueckgehen tot ist (Review codex #8).
    pub fn set_current_anchor(&mut self, anchor: Option<String>) {
        if let Some(index) = self.current_index {
            if let Some(entry) = self.history.get_mut(index) {
                entry.anchor = anchor;
            }
        }
    }

    pub fn update_scroll_position(&mut self, scroll_y: f64) {
        if let Some(index) = self.current_index {
            if let Some(entry) = self.history.get_mut(index) {
                entry.scroll_y = scroll_y;
            }
        }
    }

    pub fn update_view_mode(&mut self, mode: impl Into<String>) {
        if let Some(index) = self.current_index {
            if let Some(entry) = self.history.get_mut(index) {
                entry.view_mode = mode.into();
            }
        }
    }

    pub fn update_editor_scroll(&mut self, scroll_y: f64) {
        if let Some(index) = self.current_index {
            if let Some(entry) = self.history.get_mut(index) {
                entry.editor_scroll_y = scroll_y;
            }
        }
    }

    pub fn update_editor_cursor(&mut self, cursor: usize) {
        if let Some(index) = self.current_index {
            if let Some(entry) = self.history.get_mut(index) {
                entry.editor_cursor = cursor;
            }
        }
    }

    /// Schreibt History-Einträge unter `old_root` auf `new_root` um —
    /// in-place, ohne neuen Eintrag und ohne den Index zu verschieben.
    /// Für Ordner-Rename/Move, damit Zurück/Vor nicht auf tote Pfade zeigt.
    pub fn rewrite_prefix(&mut self, old_root: &str, new_root: &str) {
        for entry in &mut self.history {
            if let Some(rewritten) =
                crate::path_migration::remap(&entry.absolute_path, old_root, new_root)
            {
                entry.absolute_path = rewritten;
            }
        }
    }

    /// Entfernt History-Einträge unter `root`. Liegt der aktuelle Eintrag
    /// darunter, rückt der nächstältere verbleibende nach (sonst der
    /// nächstjüngere). Leere History → kein current.
    pub fn remove_under(&mut self, root: &str) {
        if self.history.is_empty() {
            return;
        }
        let current = self.current_index;
        let mut kept = Vec::with_capacity(self.history.len());
        let mut old_to_new: Vec<Option<usize>> = Vec::with_capacity(self.history.len());
        for entry in &self.history {
            if crate::path_migration::is_under(&entry.absolute_path, root) {
                old_to_new.push(None);
            } else {
                old_to_new.push(Some(kept.len()));
                kept.push(entry.clone());
            }
        }
        let new_index = current.and_then(|index| {
            if let Some(mapped) = old_to_new.get(index).copied().flatten() {
                return Some(mapped);
            }
            old_to_new[..index]
                .iter()
                .rev()
                .copied()
                .flatten()
                .next()
                .or_else(|| old_to_new[index + 1..].iter().copied().flatten().next())
        });
        self.history = kept;
        self.current_index = if self.history.is_empty() {
            None
        } else {
            new_index
        };
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

    #[test]
    fn navigate_creates_entry_with_default_session_state() {
        let mut controller = NavigationController::new();
        let entry = controller.navigate("/a.md", None).clone();

        assert_eq!("view", entry.view_mode);
        assert_eq!(0.0, entry.editor_scroll_y);
        assert_eq!(0, entry.editor_cursor);
    }

    #[test]
    fn update_view_mode_only_updates_current_entry() {
        let mut controller = NavigationController::new();
        controller.navigate("/a.md", None);
        controller.navigate("/b.md", None);
        controller.update_view_mode("edit");
        controller.go_back();
        controller.update_view_mode("split");

        assert_eq!("split", controller.history()[0].view_mode);
        assert_eq!("edit", controller.history()[1].view_mode);
    }

    #[test]
    fn update_editor_scroll_and_cursor_only_updates_current_entry() {
        let mut controller = NavigationController::new();
        controller.navigate("/a.md", None);
        controller.navigate("/b.md", None);
        controller.update_editor_scroll(120.0);
        controller.update_editor_cursor(42);
        controller.go_back();
        controller.update_editor_scroll(7.0);
        controller.update_editor_cursor(3);

        assert_eq!(7.0, controller.history()[0].editor_scroll_y);
        assert_eq!(3, controller.history()[0].editor_cursor);
        assert_eq!(120.0, controller.history()[1].editor_scroll_y);
        assert_eq!(42, controller.history()[1].editor_cursor);
    }

    fn paths(entries: &[Entry]) -> Vec<&str> {
        entries
            .iter()
            .map(|entry| entry.absolute_path.as_str())
            .collect()
    }

    #[test]
    fn set_current_anchor_updates_in_place_without_new_entry() {
        // focus_existing_tab-Pfad (Review codex #8): der Ziel-Tab zeigt die
        // Datei bereits — der Anker gehoert auf den aktuellen Eintrag,
        // nicht in einen zweiten.
        let mut nav = NavigationController::new();
        nav.navigate("/guide.md", None);

        nav.set_current_anchor(Some("install".into()));

        assert_eq!(1, nav.history().len());
        assert!(!nav.can_go_back());
        assert_eq!(Some("install"), nav.current().unwrap().anchor.as_deref());
    }

    #[test]
    fn navigate_with_anchor_after_anchorless_entry_would_add_a_second_entry() {
        // Gegenprobe zum Fix: genau dieses Verhalten erzeugte den toten
        // Zurueck-Schritt.
        let mut nav = NavigationController::new();
        nav.navigate("/guide.md", None);
        nav.navigate("/guide.md", Some("install".into()));

        assert_eq!(2, nav.history().len());
    }

    #[test]
    fn rewrite_prefix_rewrites_matching_entries_in_place() {
        let mut nav = NavigationController::new();
        nav.navigate("/a/notizen/one.md", None);
        nav.navigate("/a/other.md", None);
        nav.navigate("/a/notizen/two.md", Some("h".into()));
        nav.update_scroll_position(12.0);

        nav.rewrite_prefix("/a/notizen", "/a/notes");

        assert_eq!(3, nav.history().len());
        assert_eq!("/a/notes/one.md", nav.history()[0].absolute_path);
        assert_eq!("/a/other.md", nav.history()[1].absolute_path);
        assert_eq!("/a/notes/two.md", nav.history()[2].absolute_path);
        assert_eq!(Some("h"), nav.current().unwrap().anchor.as_deref());
        assert_eq!(12.0, nav.current().unwrap().scroll_y);
        assert_eq!(Some(2), nav.current_index());
    }

    #[test]
    fn rewrite_prefix_respects_segment_boundary() {
        let mut nav = NavigationController::new();
        nav.navigate("/a/notizen-alt/x.md", None);
        nav.rewrite_prefix("/a/notizen", "/a/notes");
        assert_eq!("/a/notizen-alt/x.md", nav.current().unwrap().absolute_path);
    }

    #[test]
    fn remove_under_drops_matching_entries_and_rewrites_index() {
        let mut nav = NavigationController::new();
        nav.navigate("/keep/a.md", None);
        nav.navigate("/drop/b.md", None);
        nav.navigate("/keep/c.md", None);
        nav.navigate("/drop/d.md", None);
        nav.navigate("/keep/e.md", None);

        nav.remove_under("/drop");

        assert_eq!(
            vec!["/keep/a.md", "/keep/c.md", "/keep/e.md"],
            paths(nav.history())
        );
        assert_eq!("/keep/e.md", nav.current().unwrap().absolute_path);
        assert_eq!(Some(2), nav.current_index());
        assert!(nav.can_go_back());
        assert!(!nav.can_go_forward());
    }

    #[test]
    fn remove_under_moves_current_to_older_survivor() {
        let mut nav = NavigationController::new();
        nav.navigate("/keep/a.md", None);
        nav.navigate("/drop/b.md", None);
        nav.navigate("/drop/c.md", None);

        nav.remove_under("/drop");

        assert_eq!(vec!["/keep/a.md"], paths(nav.history()));
        assert_eq!("/keep/a.md", nav.current().unwrap().absolute_path);
        assert!(!nav.can_go_back());
    }

    #[test]
    fn remove_under_clears_history_when_everything_matches() {
        let mut nav = NavigationController::new();
        nav.navigate("/drop/a.md", None);
        nav.navigate("/drop/b.md", None);
        nav.remove_under("/drop");
        assert!(nav.history().is_empty());
        assert_eq!(None, nav.current());
    }

    #[test]
    fn remove_under_respects_segment_boundary() {
        let mut nav = NavigationController::new();
        nav.navigate("/a/notizen-alt/x.md", None);
        nav.remove_under("/a/notizen");
        assert_eq!("/a/notizen-alt/x.md", nav.current().unwrap().absolute_path);
    }
}
