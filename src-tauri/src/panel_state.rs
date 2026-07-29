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
    /// Tags-Sektion in der linken Rail (W5). Default eingeklappt.
    #[serde(default)]
    pub tags_expanded: bool,
    pub window_x: Option<f64>,
    pub window_y: Option<f64>,
    pub window_width: Option<f64>,
    pub window_height: Option<f64>,
    #[serde(default)]
    pub window_maximized: bool,
    pub cheat_sheet_offset_x: f64,
    pub cheat_sheet_offset_y: f64,
    // Monaco-Minimap-Toggle (Edit-Mode-Only). Default aus: Folio ist
    // schmal-fokussiert auf Markdown, fuer typische Dokumentenlaengen
    // bringt die Minimap wenig und nimmt Platz.
    #[serde(default)]
    pub editor_minimap_visible: bool,
    // Split-Mode: Breitenanteil der Editor-Pane in Prozent (Rest geht an
    // die View-Pane). Steuert den mittleren Draggable-Splitter. Clamp
    // 20–80, Default 50 (50/50). serde-default-Funktion statt
    // `#[serde(default)]`, weil f64s Default 0.0 waere.
    #[serde(default = "default_split_mid_percent")]
    pub split_mid_percent: f64,
    // Vault-Suche: Optionen-Toggles (Aa / W). Beide Default aus — konsistent
    // mit der Find-Bar. Persistiert nach UI-Toggle-Persistenz-Konvention.
    #[serde(default)]
    pub search_case_sensitive: bool,
    #[serde(default)]
    pub search_whole_word: bool,
    // Vault-Suche S4: Regex-Modus (Default aus). Dateityp-Filter als roher
    // UI-Wert (`markdown` | `allText` | `custom`, Default `allText` via
    // serde-default-Funktion, weil String-Default sonst leer wäre) und die
    // benutzerdefinierte Endungsliste als roher Feldtext (damit der Dialog das
    // Feld 1:1 vorbefüllen kann). Unbekannte/leere Filterwerte fallen beim
    // Lesen auf `allText` zurück (siehe `commands::app::search_options_get`).
    #[serde(default)]
    pub search_regex: bool,
    #[serde(default = "default_search_file_filter")]
    pub search_file_filter: String,
    #[serde(default)]
    pub search_custom_extensions: String,
    // Vault-Suche: auch versteckte und gitignorierte Dateien (Default aus).
    #[serde(default)]
    pub search_include_hidden: bool,
    // Vault-Suche S5: Verzeichnispfad-Anzeige neben dem Dateinamen (Default aus)
    // und Sortiermodus der Ergebnisgruppen als roher UI-Wert
    // (`none` | `name` | `path`, Default `none` via serde-default-Funktion, weil
    // der String-Default sonst leer wäre). Unbekannte/leere Sortierwerte fallen
    // beim Lesen auf `none` zurück (siehe `commands::app::search_options_get`).
    #[serde(default)]
    pub search_show_paths: bool,
    #[serde(default = "default_search_sort")]
    pub search_sort: String,
    // Vault-Tree-Filter (Spec vault-filter A6): „nur Markdown"-Toggle und
    // Sichtbarkeit der Filterzeile. Beide Default aus; Namensfilter-Text
    // ist flüchtig und liegt nicht hier.
    #[serde(default)]
    pub vault_filter_markdown_only: bool,
    #[serde(default)]
    pub vault_filter_bar_visible: bool,
}

fn default_split_mid_percent() -> f64 {
    50.0
}

fn default_search_file_filter() -> String {
    "allText".to_string()
}

fn default_search_sort() -> String {
    "none".to_string()
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
            tags_expanded: false,
            window_x: None,
            window_y: None,
            window_width: None,
            window_height: None,
            window_maximized: false,
            cheat_sheet_offset_x: 0.0,
            cheat_sheet_offset_y: 0.0,
            editor_minimap_visible: false,
            split_mid_percent: 50.0,
            search_case_sensitive: false,
            search_whole_word: false,
            search_regex: false,
            search_file_filter: default_search_file_filter(),
            search_custom_extensions: String::new(),
            search_include_hidden: false,
            search_show_paths: false,
            search_sort: default_search_sort(),
            vault_filter_markdown_only: false,
            vault_filter_bar_visible: false,
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

    pub fn set_editor_minimap_visible(&mut self, visible: bool) -> io::Result<()> {
        self.data.editor_minimap_visible = visible;
        self.save()
    }

    pub fn set_split_mid_percent(&mut self, percent: f64) -> io::Result<()> {
        self.data.split_mid_percent = percent.clamp(20.0, 80.0);
        self.save()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_search_options(
        &mut self,
        case_sensitive: bool,
        whole_word: bool,
        regex: bool,
        file_filter: String,
        custom_extensions: String,
        include_hidden: bool,
        show_paths: bool,
        sort: String,
    ) -> io::Result<()> {
        self.data.search_case_sensitive = case_sensitive;
        self.data.search_whole_word = whole_word;
        self.data.search_regex = regex;
        self.data.search_file_filter = file_filter;
        self.data.search_custom_extensions = custom_extensions;
        self.data.search_include_hidden = include_hidden;
        self.data.search_show_paths = show_paths;
        self.data.search_sort = sort;
        self.save()
    }

    pub fn set_section_expanded(&mut self, section: &str, expanded: bool) -> io::Result<()> {
        match section {
            "pinned" => self.data.pinned_expanded = expanded,
            "recent" => self.data.recent_expanded = expanded,
            "tags" => self.data.tags_expanded = expanded,
            _ => {}
        }
        self.save()
    }

    pub fn set_vault_filter_options(
        &mut self,
        markdown_only: bool,
        bar_visible: bool,
    ) -> io::Result<()> {
        self.data.vault_filter_markdown_only = markdown_only;
        self.data.vault_filter_bar_visible = bar_visible;
        self.save()
    }

    pub fn set_window_position(&mut self, x: f64, y: f64) -> io::Result<()> {
        if !self.set_window_position_in_memory(x, y) {
            return Ok(());
        }
        self.save()
    }

    /// In-Memory-Variante fuer den hochfrequenten Moved-Event-Pfad:
    /// waehrend eines Fenster-Drags feuert das Event dutzendfach pro
    /// Sekunde — die Persistenz laeuft debounced in
    /// `lib.rs::schedule_panel_geometry_save` statt pro Tick.
    ///
    /// Liefert `false` bei verworfenen, offensichtlich ungueltigen
    /// Parkpositionen (analog zum Verwerfen nicht-positiver Groessen in
    /// `set_window_size_in_memory`): Windows schiebt das Fenster beim
    /// Minimieren auf -32000/-32000; wird genau das gespeichert, waere das
    /// Fenster beim naechsten Start unsichtbar. Defense-in-depth zum
    /// is_minimized()-Guard im Moved-Handler. Bei einer verworfenen Position
    /// bleiben `prev_window_*`/`last_position_change_at` bewusst unveraendert,
    /// damit der Maximize-Revert nicht durcheinandergeraet.
    pub fn set_window_position_in_memory(&mut self, x: f64, y: f64) -> bool {
        if is_park_position(x, y) {
            return false;
        }
        self.prev_window_x = self.data.window_x;
        self.prev_window_y = self.data.window_y;
        self.last_position_change_at = Some(Instant::now());
        self.data.window_x = Some(x);
        self.data.window_y = Some(y);
        true
    }

    /// Siehe [`Self::set_window_position_in_memory`]. Liefert `false`
    /// bei verworfenen (nicht-positiven) Dimensionen.
    pub fn set_window_size_in_memory(&mut self, width: f64, height: f64) -> bool {
        if width <= 0.0 || height <= 0.0 {
            return false;
        }
        self.data.window_width = Some(width);
        self.data.window_height = Some(height);
        true
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

/// Erkennt die Windows-Parkposition (-32000/-32000 beim Minimieren). Die
/// numerische Heuristik ist Windows-spezifisch: auf Linux/macOS sind solche
/// stark negativen Koordinaten bei sehr grossen virtuellen Desktops legal und
/// duerfen nicht stillschweigend verworfen werden. Der plattformneutrale
/// is_minimized()-Guard im Moved-Handler bleibt davon unberuehrt.
#[cfg(target_os = "windows")]
fn is_park_position(x: f64, y: f64) -> bool {
    x <= -30000.0 || y <= -30000.0
}

#[cfg(not(target_os = "windows"))]
fn is_park_position(_x: f64, _y: f64) -> bool {
    false
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
        state.last_position_change_at = Some(Instant::now() - Duration::from_secs(5));
        state.set_window_maximized(true).unwrap();
        let reloaded = PanelState::load_from(path).data();
        assert_eq!(Some(250.0), reloaded.window_x);
        assert_eq!(Some(250.0), reloaded.window_y);
        assert!(reloaded.window_maximized);
    }

    #[test]
    fn valid_position_is_accepted_and_persisted() {
        // Plattformneutral: eine gewoehnliche Position wird angenommen.
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        let mut state = PanelState::load_from(path.clone());
        assert!(state.set_window_position_in_memory(120.0, 80.0));
        state.set_window_position(250.0, 160.0).unwrap();
        let reloaded = PanelState::load_from(path).data();
        assert_eq!(Some(250.0), reloaded.window_x);
        assert_eq!(Some(160.0), reloaded.window_y);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn in_memory_setter_discards_park_position() {
        // Minimaler Test fuer set_window_position_in_memory: die Parkposition
        // wird verworfen (false) und der bestehende In-Memory-Wert bleibt.
        let mut state = PanelState::load_from(TempDir::new().unwrap().path().join("panel.json"));
        assert!(state.set_window_position_in_memory(120.0, 80.0));
        assert!(!state.set_window_position_in_memory(-32000.0, -32000.0));
        assert_eq!(Some(120.0), state.data().window_x);
        assert_eq!(Some(80.0), state.data().window_y);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn set_window_position_does_not_persist_park_position() {
        // Minimaler Test fuer set_window_position: eine Parkposition wird nicht
        // in die Datei geschrieben (die zuvor gespeicherte bleibt erhalten).
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        let mut state = PanelState::load_from(path.clone());
        state.set_window_position(120.0, 80.0).unwrap();
        state.set_window_position(-32000.0, -32000.0).unwrap();
        let reloaded = PanelState::load_from(path).data();
        assert_eq!(Some(120.0), reloaded.window_x);
        assert_eq!(Some(80.0), reloaded.window_y);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn single_axis_park_position_is_discarded() {
        let mut state = PanelState::load_from(TempDir::new().unwrap().path().join("panel.json"));
        assert!(!state.set_window_position_in_memory(200.0, -30001.0));
        assert!(!state.set_window_position_in_memory(-30001.0, 200.0));
        // Knapp ueber der Grenze bleibt gueltig.
        assert!(state.set_window_position_in_memory(-29999.0, -29999.0));
        assert_eq!(Some(-29999.0), state.data().window_x);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn is_park_position_threshold_windows() {
        assert!(is_park_position(-32000.0, 100.0));
        assert!(is_park_position(100.0, -30000.0));
        assert!(!is_park_position(-29999.0, -29999.0));
        assert!(!is_park_position(100.0, 100.0));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn is_park_position_is_noop_off_windows() {
        // Auf Nicht-Windows wird nichts verworfen — stark negative
        // Koordinaten sind auf grossen virtuellen Desktops legal.
        assert!(!is_park_position(-32000.0, -32000.0));
        let mut state = PanelState::load_from(TempDir::new().unwrap().path().join("panel.json"));
        assert!(state.set_window_position_in_memory(-32000.0, -32000.0));
    }

    #[test]
    fn section_toggle_updates_matching_section() {
        let temp = TempDir::new().unwrap();
        let mut state = PanelState::load_from(temp.path().join("panel.json"));
        state.set_section_expanded("recent", false).unwrap();
        assert!(!state.data().recent_expanded);
        assert!(state.data().pinned_expanded);
    }

    #[test]
    fn editor_minimap_default_is_off_and_toggle_persists() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        let mut state = PanelState::load_from(path.clone());
        assert!(!state.data().editor_minimap_visible);
        state.set_editor_minimap_visible(true).unwrap();
        assert!(PanelState::load_from(path).data().editor_minimap_visible);
    }

    #[test]
    fn split_mid_percent_default_is_fifty() {
        assert_eq!(50.0, PanelStateData::default().split_mid_percent);
    }

    #[test]
    fn search_option_defaults_and_roundtrip() {
        let default = PanelStateData::default();
        assert!(!default.search_regex);
        assert_eq!("allText", default.search_file_filter);
        assert_eq!("", default.search_custom_extensions);
        assert!(!default.search_include_hidden);
        // S5-Defaults.
        assert!(!default.search_show_paths);
        assert_eq!("none", default.search_sort);

        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        let mut state = PanelState::load_from(path.clone());
        state
            .set_search_options(
                true,
                false,
                true,
                "custom".to_string(),
                "foobar,md".to_string(),
                true,
                true,
                "path".to_string(),
            )
            .unwrap();
        let reloaded = PanelState::load_from(path).data();
        assert!(reloaded.search_case_sensitive);
        assert!(!reloaded.search_whole_word);
        assert!(reloaded.search_regex);
        assert_eq!("custom", reloaded.search_file_filter);
        assert_eq!("foobar,md", reloaded.search_custom_extensions);
        assert!(reloaded.search_include_hidden);
        assert!(reloaded.search_show_paths);
        assert_eq!("path", reloaded.search_sort);
    }

    #[test]
    fn search_options_load_legacy_json_without_new_fields() {
        // Alt-Stand ohne die S4-Felder: serde-Defaults greifen (allText/false/"").
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        std::fs::write(
            &path,
            r#"{
                "left_rail_visible": true,
                "right_rail_visible": true,
                "left_rail_width": 280.0,
                "right_rail_width": 280.0,
                "pinned_expanded": true,
                "recent_expanded": true,
                "window_x": null,
                "window_y": null,
                "window_width": null,
                "window_height": null,
                "cheat_sheet_offset_x": 0.0,
                "cheat_sheet_offset_y": 0.0,
                "search_case_sensitive": true,
                "search_whole_word": true
            }"#,
        )
        .unwrap();
        let data = PanelState::load_from(path).data();
        assert!(data.search_case_sensitive);
        assert!(data.search_whole_word);
        assert!(!data.search_regex);
        assert_eq!("allText", data.search_file_filter);
        assert_eq!("", data.search_custom_extensions);
        assert!(!data.search_include_hidden);
        // S5-Felder fehlen im Alt-Stand → serde-Defaults.
        assert!(!data.search_show_paths);
        assert_eq!("none", data.search_sort);
    }

    #[test]
    fn search_options_unknown_stored_filter_loads_raw() {
        // Ein explizit gespeicherter, unbekannter Filterwert wird auf
        // PanelState-Ebene ROH geladen (kein serde-Default, da das Feld
        // vorhanden ist). Die Normalisierung auf `allText` passiert erst im
        // Command-Layer (`normalized_file_filter`, dort getestet) — so bleibt
        // hier sichtbar, wo der Fallback greift.
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        std::fs::write(
            &path,
            r#"{
                "left_rail_visible": true,
                "right_rail_visible": true,
                "left_rail_width": 280.0,
                "right_rail_width": 280.0,
                "pinned_expanded": true,
                "recent_expanded": true,
                "window_x": null,
                "window_y": null,
                "window_width": null,
                "window_height": null,
                "cheat_sheet_offset_x": 0.0,
                "cheat_sheet_offset_y": 0.0,
                "search_file_filter": "weird"
            }"#,
        )
        .unwrap();
        let data = PanelState::load_from(path).data();
        assert_eq!("weird", data.search_file_filter);
    }

    #[test]
    fn split_mid_percent_is_clamped_and_persisted() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("panel.json");
        let mut state = PanelState::load_from(path.clone());
        state.set_split_mid_percent(95.0).unwrap();
        assert_eq!(
            80.0,
            PanelState::load_from(path.clone()).data().split_mid_percent
        );
        state.set_split_mid_percent(5.0).unwrap();
        assert_eq!(
            20.0,
            PanelState::load_from(path.clone()).data().split_mid_percent
        );
        state.set_split_mid_percent(35.0).unwrap();
        assert_eq!(35.0, PanelState::load_from(path).data().split_mid_percent);
    }
}
