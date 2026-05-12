use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AutomationState {
    pub(super) title: String,
    pub(super) file: Option<String>,
    pub(super) dirty: bool,
    pub(super) view_mode: String,
    pub(super) theme: String,
    pub(super) left_rail_visible: bool,
    pub(super) right_rail_visible: bool,
    pub(super) toc: Vec<TocEntry>,
    pub(super) editor: EditorAutomationState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TocEntry {
    pub(super) level: u8,
    pub(super) text: String,
    pub(super) slug: String,
    pub(super) number: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EditorAutomationState {
    pub(super) ready: bool,
    pub(super) selection_start: usize,
    pub(super) selection_length: usize,
    pub(super) left_rail_width: f64,
    pub(super) right_rail_width: f64,
}

#[derive(Debug, Serialize)]
pub(super) struct OkResponse {
    pub(super) ok: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct ErrorResponse {
    pub(super) error: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct OpenRequest {
    pub(super) path: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct ModeRequest {
    pub(super) mode: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct ThemeRequest {
    pub(super) mode: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct RailRequest {
    pub(super) side: String,
    pub(super) visible: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct ClickRequest {
    pub(super) name: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct TocActivateRequest {
    pub(super) slug: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct FindTextRequest {
    pub(super) term: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct EditorTextRequest {
    pub(super) text: String,
}

#[derive(Debug, Serialize)]
pub(super) struct EditorTextResponse {
    pub(super) text: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct EditorSelectionRequest {
    pub(super) start: usize,
    pub(super) length: usize,
}

#[derive(Debug, Deserialize)]
pub(super) struct ResizeRequest {
    pub(super) width: f64,
    pub(super) height: f64,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct KeyModifiers {
    #[serde(default)]
    pub(super) ctrl: bool,
    #[serde(default)]
    pub(super) shift: bool,
    #[serde(default)]
    pub(super) alt: bool,
    #[serde(default)]
    pub(super) meta: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct KeyRequest {
    pub(super) key: String,
    #[serde(default)]
    pub(super) modifiers: KeyModifiers,
    #[serde(default)]
    pub(super) target: Option<String>,
}
