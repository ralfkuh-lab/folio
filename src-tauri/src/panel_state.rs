use crate::persist;
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::PathBuf,
    time::{Duration, Instant},
};

const POSITION_REVERT_WINDOW: Duration = Duration::from_millis(250);

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
    #[serde(default)]
    pub window_maximized: bool,
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
            window_maximized: false,
            cheat_sheet_offset_x: 0.0,
            cheat_sheet_offset_y: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PanelState {
    data: PanelStateData,
    path: PathBuf,
    prev_window_x: Option<f64>,
    prev_window_y: Option<f64>,
    last_position_change_at: Option<Instant>,
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
        Self {
            data,
            path,
            prev_window_x: None,
            prev_window_y: None,
            last_position_change_at: None,
        }
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

    pub fn set_window_position(&mut self, x: f64, y: f64) -> io::Result<()> {
        self.prev_window_x = self.data.window_x;
        self.prev_window_y = self.data.window_y;
        self.last_position_change_at = Some(Instant::now());
        self.data.window_x = Some(x);
        self.data.window_y = Some(y);
        self.save()
    }

    pub fn set_window_size(&mut self, width: f64, height: f64) -> io::Result<()> {
        if width <= 0.0 || height <= 0.0 {
            return Ok(());
        }
        self.data.window_width = Some(width);
        self.data.window_height = Some(height);
        self.save()
    }

    pub fn set_window_maximized(&mut self, maximized: bool) -> io::Result<()> {
        let was_maximized = self.data.window_maximized;
        let mut dirty = false;
        if maximized && !was_maximized {
            // Maximize transition can fire a Moved event with the maximize-induced
            // position before is_maximized() reports true. If the most recent
            // position change happened within the revert window, treat it as
            // maximize fallout and restore the prior position.
            if let Some(at) = self.last_position_change_at {
                if at.elapsed() <= POSITION_REVERT_WINDOW {
                    self.data.window_x = self.prev_window_x;
                    self.data.window_y = self.prev_window_y;
                    dirty = true;
                }
            }
            self.last_position_change_at = None;
        }
        if self.data.window_maximized != maximized {
            self.data.window_maximized = maximized;
            dirty = true;
        }
        if dirty {
            self.save()
        } else {
            Ok(())
        }
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
    fn maximize_after_recent_move_reverts_to_prior_position() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        let mut state = PanelState::load_from(path.clone());
        state.set_window_position(100.0, 100.0).unwrap();
        // Simulate the maximize-induced Moved event.
        state.set_window_position(0.0, 0.0).unwrap();
        // Followed by Resized → maximized=true.
        state.set_window_maximized(true).unwrap();
        let reloaded = PanelState::load_from(path).data();
        assert_eq!(Some(100.0), reloaded.window_x);
        assert_eq!(Some(100.0), reloaded.window_y);
        assert!(reloaded.window_maximized);
    }

    #[test]
    fn maximize_long_after_move_keeps_user_position() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        let mut state = PanelState::load_from(path.clone());
        state.set_window_position(100.0, 100.0).unwrap();
        state.set_window_position(250.0, 250.0).unwrap();
        // Simulate enough time passing that this is clearly a deliberate maximize,
        // not maximize fallout from the last Moved event.
        state.last_position_change_at =
            Some(Instant::now() - Duration::from_secs(5));
        state.set_window_maximized(true).unwrap();
        let reloaded = PanelState::load_from(path).data();
        assert_eq!(Some(250.0), reloaded.window_x);
        assert_eq!(Some(250.0), reloaded.window_y);
        assert!(reloaded.window_maximized);
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
