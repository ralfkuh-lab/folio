use crate::persist;
use serde::{Deserialize, Serialize};
use std::{io, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PanelStateData {
    pub left_rail_visible: bool,
    pub right_rail_visible: bool,
    pub left_rail_width: f64,
    pub right_rail_width: f64,
    pub pinned_expanded: bool,
    pub recent_expanded: bool,
    pub window_x: Option<f64>,
    pub window_y: Option<f64>,
    pub window_width: Option<f64>,
    pub window_height: Option<f64>,
    pub cheat_sheet_offset_x: f64,
    pub cheat_sheet_offset_y: f64,
}

impl Default for PanelStateData {
    fn default() -> Self {
        Self {
            left_rail_visible: true,
            right_rail_visible: true,
            left_rail_width: 280.0,
            right_rail_width: 280.0,
            pinned_expanded: true,
            recent_expanded: true,
            window_x: None,
            window_y: None,
            window_width: None,
            window_height: None,
            cheat_sheet_offset_x: 0.0,
            cheat_sheet_offset_y: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PanelState {
    data: PanelStateData,
    path: PathBuf,
}

impl Default for PanelState {
    fn default() -> Self {
        Self::load()
    }
}

impl PanelState {
    pub fn load() -> Self {
        Self::load_from(crate::persist::config_file("panel-state.json"))
    }

    pub fn load_from(path: PathBuf) -> Self {
        let data = persist::load_json(&path);
        Self { data, path }
    }

    pub fn data(&self) -> PanelStateData {
        self.data.clone()
    }

    pub fn set_rail_width(&mut self, side: &str, width: f64) -> io::Result<()> {
        let width = width.clamp(160.0, 800.0);
        match side {
            "left" => self.data.left_rail_width = width,
            "right" => self.data.right_rail_width = width,
            _ => {}
        }
        self.save()
    }

    pub fn set_rail_visible(&mut self, side: &str, visible: bool) -> io::Result<()> {
        match side {
            "left" => self.data.left_rail_visible = visible,
            "right" => self.data.right_rail_visible = visible,
            _ => {}
        }
        self.save()
    }

    pub fn set_section_expanded(&mut self, section: &str, expanded: bool) -> io::Result<()> {
        match section {
            "pinned" => self.data.pinned_expanded = expanded,
            "recent" => self.data.recent_expanded = expanded,
            _ => {}
        }
        self.save()
    }

    pub fn save(&self) -> io::Result<()> {
        persist::save_json_atomic(&self.path, &self.data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn default_state_matches_expected_rails() {
        let state = PanelStateData::default();
        assert!(state.left_rail_visible);
        assert!(state.right_rail_visible);
        assert_eq!(280.0, state.left_rail_width);
    }

    #[test]
    fn rail_width_is_clamped_and_persisted() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        let mut state = PanelState::load_from(path.clone());
        state.set_rail_width("left", 99.0).unwrap();
        assert_eq!(160.0, PanelState::load_from(path).data().left_rail_width);
    }

    #[test]
    fn section_toggle_updates_matching_section() {
        let temp = TempDir::new().unwrap();
        let mut state = PanelState::load_from(temp.path().join("panel.json"));
        state.set_section_expanded("recent", false).unwrap();
        assert!(!state.data().recent_expanded);
        assert!(state.data().pinned_expanded);
    }
}
