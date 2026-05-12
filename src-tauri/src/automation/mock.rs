#[derive(Debug, Clone, PartialEq)]
pub struct MockAutomationState {
    pub title: String,
    pub file: Option<String>,
    pub text: String,
    pub dirty: bool,
    pub view_mode: String,
    pub theme: String,
    pub editor_ready: bool,
    pub selection_start: usize,
    pub selection_length: usize,
    pub editor_scroll_y: f64,
    pub editor_cursor: usize,
    pub view_scroll_y: f64,
    pub view_anchor: Option<String>,
    pub pinned: Vec<MockPinned>,
    pub recent: Vec<MockRecent>,
    pub expanded_dirs: Vec<String>,
    pub quit_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockPinned {
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockRecent {
    pub path: String,
    pub last_opened: u64,
}

impl Default for MockAutomationState {
    fn default() -> Self {
        Self {
            title: "Folio".into(),
            file: None,
            text: String::new(),
            dirty: false,
            view_mode: "view".into(),
            theme: "light".into(),
            editor_ready: false,
            selection_start: 0,
            selection_length: 0,
            editor_scroll_y: 0.0,
            editor_cursor: 0,
            view_scroll_y: 0.0,
            view_anchor: None,
            pinned: Vec::new(),
            recent: Vec::new(),
            expanded_dirs: Vec::new(),
            quit_requested: false,
        }
    }
}
