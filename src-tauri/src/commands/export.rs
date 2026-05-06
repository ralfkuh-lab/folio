use crate::export::{self, LayoutInfo};
use crate::pdf_export;
use crate::state::AppState;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

#[tauri::command]
pub async fn export_layouts() -> Vec<LayoutInfo> {
    export::layouts()
}

#[tauri::command]
pub async fn export_render(
    layout_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (path, text) = current_document(&state)?;
    let title = export::derive_title(path.as_deref());
    export::render_document(&layout_id, &title, &text)
}

#[tauri::command]
pub async fn export_html(
    layout_id: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (path, text) = current_document(&state)?;
    let title = export::derive_title(path.as_deref());
    let html = export::render_document(&layout_id, &title, &text)?;
    fs::write(&target_path, html).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_pdf(
    layout_id: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (path, text) = current_document(&state)?;
    let title = export::derive_title(path.as_deref());
    let html = export::render_document(&layout_id, &title, &text)?;
    let source_dir = path
        .as_deref()
        .and_then(|p| Path::new(p).parent())
        .map(|p| p.to_path_buf());
    pdf_export::render_pdf(&html, source_dir.as_deref(), Path::new(&target_path))
}

#[tauri::command]
pub async fn pick_export_target(
    handle: AppHandle,
    default_name: String,
    format: String,
) -> Result<Option<String>, String> {
    let (filter_name, exts): (&str, &[&str]) = match format.as_str() {
        "pdf" => ("PDF", &["pdf"]),
        _ => ("HTML", &["html", "htm"]),
    };
    Ok(handle
        .dialog()
        .file()
        .add_filter(filter_name, exts)
        .set_file_name(&default_name)
        .blocking_save_file()
        .map(file_path_to_string))
}

fn current_document(
    state: &State<'_, AppState>,
) -> Result<(Option<String>, String), String> {
    let store = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?;
    if store.path.is_none() {
        return Err("Kein Dokument geöffnet.".into());
    }
    Ok((store.path.clone(), store.text.clone()))
}

fn file_path_to_string(path: FilePath) -> String {
    path.into_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}
