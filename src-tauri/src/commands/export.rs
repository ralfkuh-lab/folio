use crate::export::{self, LayoutInfo};
use crate::pdf_export;
use crate::settings::ExportDirMode;
use crate::state::AppState;
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

#[tauri::command]
pub async fn export_layouts() -> Vec<LayoutInfo> {
    export::layouts()
}

#[tauri::command]
pub async fn view_themes() -> Vec<LayoutInfo> {
    export::view_themes()
}

#[tauri::command]
pub async fn themes_dir_path() -> String {
    crate::persist::themes_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn view_theme_css(theme_id: String, dark: bool) -> Result<String, String> {
    export::view_theme_css(&theme_id, dark).map(Cow::into_owned)
}

#[tauri::command]
pub async fn export_render(
    layout_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (path, text) = current_document(&state)?;
    let title = export::derive_title(path.as_deref());
    export::render_document(&layout_id, &title, path.as_deref(), &text)
}

#[tauri::command]
pub async fn export_html(
    layout_id: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (path, text) = current_document(&state)?;
    let title = export::derive_title(path.as_deref());
    let html = export::render_document(&layout_id, &title, path.as_deref(), &text)?;
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
    let html = export::render_document(&layout_id, &title, path.as_deref(), &text)?;
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
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let (filter_name, exts): (&str, &[&str]) = match format.as_str() {
        "pdf" => ("PDF", &["pdf"]),
        _ => ("HTML", &["html", "htm"]),
    };
    let document_dir = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        tabs.active()
            .document_store
            .path
            .as_deref()
            .and_then(|path| Path::new(path).parent())
            .map(Path::to_path_buf)
    };
    let export_dir_mode = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?
        .data()
        .export_dir_mode;
    let start_dir = match export_dir_mode {
        ExportDirMode::Document => document_dir,
        ExportDirMode::Last => state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?
            .last_export_dir()
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .or(document_dir),
    };

    let mut builder = handle
        .dialog()
        .file()
        .add_filter(filter_name, exts)
        .set_file_name(&default_name);
    if let Some(dir) = start_dir {
        builder = builder.set_directory(dir);
    }
    let target_path = builder
        .blocking_save_file()
        .map(file_path_to_string)
        .filter(|path| !path.is_empty());
    let Some(target_path) = target_path else {
        return Ok(None);
    };
    if let Some(parent) = Path::new(&target_path).parent() {
        state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?
            .set_last_export_dir(parent.to_string_lossy().into_owned())
            .map_err(|error| error.to_string())?;
    }
    Ok(Some(target_path))
}

fn current_document(state: &State<'_, AppState>) -> Result<(Option<String>, String), String> {
    let tabs = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?;
    let store = &tabs.active().document_store;
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
