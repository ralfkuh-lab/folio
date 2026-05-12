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
    pub(super) view: ViewAutomationState,
    pub(super) workspace: WorkspaceAutomationState,
    pub(super) console_error_count: usize,
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
    pub(super) scroll_y: f64,
    pub(super) cursor_offset: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ViewAutomationState {
    pub(super) scroll_y: f64,
    pub(super) anchor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceAutomationState {
    pub(super) pinned: Vec<PinnedAutomationEntry>,
    pub(super) recent: Vec<RecentAutomationEntry>,
    pub(super) expanded_dirs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PinnedAutomationEntry {
    pub(super) path: String,
    pub(super) is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecentAutomationEntry {
    pub(super) path: String,
    pub(super) last_opened: u64,
}

#[derive(Debug, Serialize)]
pub(super) struct OkResponse {
    pub(super) ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AckedResponse {
    pub(super) ok: bool,
    pub(super) acked: bool,
    pub(super) request_id: u64,
}

#[derive(Debug, Deserialize)]
pub(super) struct AckOptions {
    #[serde(rename = "ackTimeoutMs", default)]
    pub(super) ack_timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WaitRequest {
    pub(super) event: String,
    pub(super) timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DomQuery {
    pub(super) selector: String,
    #[serde(default)]
    pub(super) timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DomResponse {
    pub(super) ok: bool,
    pub(super) timed_out: bool,
    #[serde(flatten)]
    pub(super) snapshot: crate::automation::dom::DomSnapshot,
}

#[derive(Debug, Serialize)]
pub(super) struct WaitResponse {
    pub(super) ok: bool,
    pub(super) fired: bool,
    pub(super) event: String,
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
