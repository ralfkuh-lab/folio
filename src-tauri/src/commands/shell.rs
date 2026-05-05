use crate::{link_interceptor::LinkAction, renderer, state::AppState, toc};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
pub async fn shell_event(
    payload: Value,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    route_shell_event(&payload, &state, &handle)
}

#[tauri::command]
pub async fn editor_event(
    payload: Value,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    route_editor_event(&payload, &state, &handle)
}

pub fn route_shell_event(
    payload: &Value,
    state: &AppState,
    handle: &AppHandle,
) -> Result<(), String> {
    let event_type = payload_type(payload)?;
    match event_type {
        "linkClick" => link_click(string_field(payload, "href")?, state, handle),
        "visibleHeading" => visible_heading(
            payload
                .get("id")
                .or_else(|| payload.get("anchor"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            handle,
        ),
        "scrollPosition" => scroll_position(number_field(payload, "y")?, state),
        "tocClick" => toc_click(string_field(payload, "slug")?, handle),
        "railResize" => rail_resize(
            string_field(payload, "side")?,
            number_field(payload, "width")?,
            state,
        ),
        "toggle-section" => vault_toggle_section(
            string_field(payload, "section")?,
            bool_field(payload, "expanded")?,
            state,
        ),
        "expand-dir" => vault_expand_dir(string_field(payload, "path")?, state, handle),
        "collapse-dir" => vault_collapse_dir(string_field(payload, "path")?, state),
        "open" => open_document(string_field(payload, "path")?, state),
        "context" => vault_context(payload, handle),
        "addFile" => add_file(state, handle),
        "addFolder" => add_folder(state, handle),
        "editorFindState" => handle
            .emit("editor:find_state", payload.clone())
            .map_err(|error| error.to_string()),
        "cheatsheetClosed" => handle
            .emit("cheatsheet:closed", payload.clone())
            .map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}

pub fn route_editor_event(
    payload: &Value,
    state: &AppState,
    handle: &AppHandle,
) -> Result<(), String> {
    let event_type = payload_type(payload)?;
    match event_type {
        "editorReady" => handle
            .emit("editor:ready", serde_json::json!({}))
            .map_err(|error| error.to_string())
            .and_then(|_| {
                state
                    .automation
                    .lock()
                    .map_err(|_| "automation state lock poisoned".to_string())?
                    .editor_ready = true;
                Ok(())
            }),
        "editorTextChanged" => {
            state
                .document_store
                .lock()
                .map_err(|_| "document store lock poisoned".to_string())?
                .update_text(string_field(payload, "text")?);
            Ok(())
        }
        "editorSelection" => {
            let start = usize_field(payload, "start")?;
            let length = usize_field(payload, "length")?;
            {
                let mut automation = state
                    .automation
                    .lock()
                    .map_err(|_| "automation state lock poisoned".to_string())?;
                automation.selection_start = start;
                automation.selection_length = length;
            }
            handle
                .emit(
                    "editor:selection",
                    serde_json::json!({ "start": start, "length": length }),
                )
                .map_err(|error| error.to_string())
        }
        "editorSaveRequested" => {
            state
                .document_store
                .lock()
                .map_err(|_| "document store lock poisoned".to_string())?
                .save()
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        "editorFindState" => handle
            .emit("editor:find_state", payload.clone())
            .map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}

fn link_click(href: String, state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let current_file = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .path
        .clone();
    match state
        .link_interceptor
        .handle(&href, current_file.as_deref())
    {
        LinkAction::OpenExternal(target) =>
        {
            #[allow(deprecated)]
            handle
                .shell()
                .open(target, None)
                .map_err(|error| error.to_string())
        }
        LinkAction::Navigate { path, anchor } => {
            let entry = {
                let mut navigation = state
                    .navigation
                    .lock()
                    .map_err(|_| "navigation lock poisoned".to_string())?;
                super::nav::NavEntry::from(navigation.navigate(path, anchor))
            };
            handle
                .emit("navigation:changed", &entry)
                .map_err(|error| error.to_string())
        }
        LinkAction::Missing => Ok(()),
    }
}

fn visible_heading(anchor: String, handle: &AppHandle) -> Result<(), String> {
    handle
        .emit(
            "navigation:heading_changed",
            serde_json::json!({ "anchor": anchor }),
        )
        .map_err(|error| error.to_string())
}

fn scroll_position(y: f64, state: &AppState) -> Result<(), String> {
    state
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?
        .update_scroll_position(y);
    Ok(())
}

fn toc_click(anchor: String, handle: &AppHandle) -> Result<(), String> {
    handle
        .emit(
            "navigation:toc_click",
            serde_json::json!({ "anchor": anchor }),
        )
        .map_err(|error| error.to_string())
}

fn rail_resize(side: String, width: f64, state: &AppState) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_rail_width(&side, width)
        .map_err(|error| error.to_string())
}

fn vault_toggle_section(section: String, expanded: bool, state: &AppState) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_section_expanded(&section, expanded)
        .map_err(|error| error.to_string())?;
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .on_section_toggle(&section, expanded);
    Ok(())
}

fn vault_expand_dir(path: String, state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let html = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .on_expand(path.clone())
        .map_err(|error| error.to_string())?;
    handle
        .emit(
            "shell:command",
            serde_json::json!({ "type": "insertVaultChildren", "path": path, "html": html }),
        )
        .map_err(|error| error.to_string())
}

fn vault_collapse_dir(path: String, state: &AppState) -> Result<(), String> {
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .on_collapse(&path);
    Ok(())
}

fn open_document(path: String, state: &AppState) -> Result<(), String> {
    state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?
        .load(&path)
        .map_err(|error| error.to_string())?;
    state
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?
        .navigate(path.clone(), None);
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .set_active(Some(path));
    Ok(())
}

fn vault_context(payload: &Value, handle: &AppHandle) -> Result<(), String> {
    handle
        .emit(
            "vault:context",
            serde_json::json!({
                "path": payload.get("path").and_then(Value::as_str),
                "kind": payload.get("kind").and_then(Value::as_str),
                "isPinned": payload.get("isPinned").and_then(Value::as_bool).unwrap_or(false),
                "isInRecent": payload.get("isInRecent").and_then(Value::as_bool).unwrap_or(false),
                "x": payload.get("x").and_then(Value::as_f64).unwrap_or_default(),
                "y": payload.get("y").and_then(Value::as_f64).unwrap_or_default(),
            }),
        )
        .map_err(|error| error.to_string())
}

fn add_file(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let Some(path) = handle
        .dialog()
        .file()
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok())
    else {
        return Ok(());
    };
    open_document(path.to_string_lossy().into_owned(), state)
}

fn add_folder(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let Some(path) = handle
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
    else {
        return Ok(());
    };
    let path = path.to_string_lossy().into_owned();
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .pin(path, true)
        .map_err(|error| error.to_string())?;
    emit_vault_refresh(state, handle)
}

fn emit_vault_refresh(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let vault = state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    handle
        .emit("vault:refresh", vault.compute_refresh_delta(&workspace))
        .map_err(|error| error.to_string())
}

fn payload_type(payload: &Value) -> Result<&str, String> {
    payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "event payload missing string field: type".to_string())
}

fn string_field(payload: &Value, field: &str) -> Result<String, String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("event payload missing string field: {field}"))
}

fn number_field(payload: &Value, field: &str) -> Result<f64, String> {
    payload
        .get(field)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("event payload missing number field: {field}"))
}

fn bool_field(payload: &Value, field: &str) -> Result<bool, String> {
    payload
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("event payload missing bool field: {field}"))
}

fn usize_field(payload: &Value, field: &str) -> Result<usize, String> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("event payload missing unsigned integer field: {field}"))
}

pub fn document_payload(path: String, text: String) -> Value {
    serde_json::json!({
        "path": path,
        "text": text,
        "content": renderer::render_body(&text),
        "tocHtml": toc::render_html(&toc::extract(&text)),
    })
}
