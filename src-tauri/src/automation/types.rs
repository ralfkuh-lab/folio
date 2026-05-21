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
    #[serde(default)]
    pub(super) discard: bool,
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
pub(super) struct RightClickRequest {
    pub(super) name: String,
    #[serde(default)]
    pub(super) coords: Option<ClickCoords>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ClickCoords {
    pub(super) x: f64,
    pub(super) y: f64,
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

#[derive(Debug, Deserialize)]
pub(super) struct MenuClickRequest {
    pub(super) id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EditorCommandRequest {
    pub(super) command: String,
    #[serde(default)]
    pub(super) args: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspacePinRequest {
    pub(super) path: String,
    #[serde(default)]
    pub(super) is_directory: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct WorkspaceUnpinRequest {
    pub(super) path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryMoveResponse {
    pub(super) ok: bool,
    pub(super) moved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) entry: Option<HistoryEntryResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryEntryResponse {
    pub(super) path: String,
    pub(super) anchor: Option<String>,
    pub(super) scroll_y: f64,
    pub(super) view_mode: String,
    pub(super) editor_scroll_y: f64,
    pub(super) editor_cursor: usize,
}

#[cfg(test)]
mod phase0_request_tests {
    use super::*;

    #[test]
    fn menu_click_request_deserializes() {
        let req: MenuClickRequest = serde_json::from_str(r#"{"id":"file.save"}"#).unwrap();
        assert_eq!("file.save", req.id);
    }

    #[test]
    fn editor_command_request_camel_case_args() {
        let req: EditorCommandRequest =
            serde_json::from_str(r#"{"command":"setLanguage","args":"markdown"}"#).unwrap();
        assert_eq!("setLanguage", req.command);
        assert_eq!(Some(serde_json::json!("markdown")), req.args);
    }

    #[test]
    fn editor_command_request_args_optional() {
        let req: EditorCommandRequest = serde_json::from_str(r#"{"command":"undo"}"#).unwrap();
        assert_eq!("undo", req.command);
        assert!(req.args.is_none());
    }

    #[test]
    fn workspace_pin_request_uses_camel_case_is_directory() {
        let req: WorkspacePinRequest =
            serde_json::from_str(r#"{"path":"/p","isDirectory":true}"#).unwrap();
        assert_eq!("/p", req.path);
        assert!(req.is_directory);
    }

    #[test]
    fn workspace_pin_request_defaults_is_directory_false() {
        let req: WorkspacePinRequest = serde_json::from_str(r#"{"path":"/p"}"#).unwrap();
        assert!(!req.is_directory);
    }

    #[test]
    fn workspace_unpin_request_deserializes() {
        let req: WorkspaceUnpinRequest = serde_json::from_str(r#"{"path":"/p"}"#).unwrap();
        assert_eq!("/p", req.path);
    }

    #[test]
    fn history_move_response_serializes_with_camel_case() {
        let resp = HistoryMoveResponse {
            ok: true,
            moved: true,
            entry: Some(HistoryEntryResponse {
                path: "/p.md".into(),
                anchor: Some("h2".into()),
                scroll_y: 1.0,
                view_mode: "view".into(),
                editor_scroll_y: 2.0,
                editor_cursor: 3,
            }),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(true, json["ok"]);
        assert_eq!(true, json["moved"]);
        assert_eq!("/p.md", json["entry"]["path"]);
        assert_eq!("h2", json["entry"]["anchor"]);
        assert_eq!(1.0, json["entry"]["scrollY"]);
        assert_eq!("view", json["entry"]["viewMode"]);
        assert_eq!(2.0, json["entry"]["editorScrollY"]);
        assert_eq!(3, json["entry"]["editorCursor"]);
    }

    #[test]
    fn history_move_response_omits_entry_when_at_end() {
        let resp = HistoryMoveResponse {
            ok: true,
            moved: false,
            entry: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json.get("entry").is_none(), "entry should be skipped");
    }
}
