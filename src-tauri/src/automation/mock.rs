#[derive(Debug, Clone, PartialEq, Eq)]
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
    pub quit_requested: bool,
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
            quit_requested: false,
        }
    }
}
