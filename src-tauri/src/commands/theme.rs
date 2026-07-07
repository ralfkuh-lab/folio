use crate::{
    state::AppState,
    theme::{
        self,
        package::{ThemeManifest, ThemePackage, ThemeSource},
        store::{self, AssetInfo, ThemeParts},
        LayoutInfo,
    },
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

const THEME_PREVIEW_SAMPLE: &str = r#"---
title: Theme-Vorschau
author: Folio
---

# Überschrift 1

## Überschrift 2

Ein Absatz mit **Fettdruck**, *Kursivschrift* und `Inline-Code`.

> Ein Blockzitat für typografische Details.

| Spalte A | Spalte B |
| --- | --- |
| Alpha | Beta |

```rust
fn main() {
    println!("Theme-Vorschau");
}
```
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFiles {
    pub manifest: ThemeManifest,
    pub content_css: String,
    pub dark_css: Option<String>,
    pub page_css: Option<String>,
    pub cover_html: Option<String>,
    pub header_html: Option<String>,
    pub footer_html: Option<String>,
    pub assets: Vec<AssetInfo>,
    pub source: ThemeSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeWriteFiles {
    pub manifest: ThemeManifest,
    pub content_css: String,
    pub dark_css: Option<String>,
    pub page_css: Option<String>,
    pub cover_html: Option<String>,
    pub header_html: Option<String>,
    pub footer_html: Option<String>,
}

impl From<ThemeWriteFiles> for ThemeParts {
    fn from(files: ThemeWriteFiles) -> Self {
        Self {
            manifest: files.manifest,
            content_css: files.content_css,
            dark_css: files.dark_css,
            page_css: files.page_css,
            cover_html: files.cover_html,
            header_html: files.header_html,
            footer_html: files.footer_html,
        }
    }
}

impl From<ThemePackage> for ThemeFiles {
    fn from(package: ThemePackage) -> Self {
        Self {
            manifest: package.manifest,
            content_css: package.content_css,
            dark_css: package.dark_css,
            page_css: package.page_css,
            cover_html: package.cover_html,
            header_html: package.header_html,
            footer_html: package.footer_html,
            assets: Vec::new(),
            source: package.source,
        }
    }
}

#[tauri::command]
pub async fn theme_read(id: String, state: State<'_, AppState>) -> Result<ThemeFiles, String> {
    let _guard = state
        .theme_write
        .lock()
        .map_err(|_| "theme write lock poisoned".to_string())?;
    let mut files = theme::package(&id)
        .map(ThemeFiles::from)
        .ok_or_else(|| format!("Unbekanntes Theme: '{id}'"))?;
    files.assets = store::list_assets(&id);
    Ok(files)
}

#[tauri::command]
pub async fn theme_write(
    id: String,
    files: ThemeWriteFiles,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<LayoutInfo, String> {
    let layout = {
        let _guard = state
            .theme_write
            .lock()
            .map_err(|_| "theme write lock poisoned".to_string())?;
        let package = store::write(&id, &ThemeParts::from(files))?;
        theme::layout_info(&package)
    };
    emit_changed(&handle, &id, "write")?;
    Ok(layout)
}

#[tauri::command]
pub async fn theme_delete(
    id: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    {
        let _guard = state
            .theme_write
            .lock()
            .map_err(|_| "theme write lock poisoned".to_string())?;
        store::delete(&id)?;
    }
    emit_changed(&handle, &id, "delete")
}

#[tauri::command]
pub async fn theme_clone(
    source_id: String,
    new_id: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<LayoutInfo, String> {
    let layout = {
        let _guard = state
            .theme_write
            .lock()
            .map_err(|_| "theme write lock poisoned".to_string())?;
        let package = store::clone(&source_id, &new_id)?;
        theme::layout_info(&package)
    };
    emit_changed(&handle, &new_id, "clone")?;
    Ok(layout)
}

#[tauri::command]
pub async fn theme_preview_render(
    markdown: Option<String>,
    parts: ThemeWriteFiles,
    dark: bool,
    theme_id: Option<String>,
) -> Result<String, String> {
    let markdown = markdown.as_deref().unwrap_or(THEME_PREVIEW_SAMPLE);
    Ok(crate::export::render_theme_preview(
        markdown,
        &ThemeParts::from(parts),
        dark,
        theme_id.as_deref(),
    ))
}

#[tauri::command]
pub async fn theme_preview_saved(theme_id: String, dark: bool) -> Result<String, String> {
    render_saved_theme_preview(&theme_id, dark)
}

fn render_saved_theme_preview(theme_id: &str, dark: bool) -> Result<String, String> {
    let package =
        theme::package(theme_id).ok_or_else(|| format!("Unbekanntes Theme: '{theme_id}'"))?;
    Ok(crate::export::render_theme_preview(
        THEME_PREVIEW_SAMPLE,
        &ThemeParts::from(&package),
        dark,
        Some(theme_id),
    ))
}

#[tauri::command]
pub async fn theme_asset_add(
    id: String,
    filename: String,
    bytes_base64: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<AssetInfo, String> {
    let info = {
        let _guard = state
            .theme_write
            .lock()
            .map_err(|_| "theme write lock poisoned".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(bytes_base64.as_bytes())
            .map_err(|error| format!("Asset-Bytes konnten nicht dekodiert werden: {error}"))?;
        store::asset_add(&id, &filename, &bytes)?
    };
    emit_changed(&handle, &id, "asset-add")?;
    Ok(info)
}

#[tauri::command]
pub async fn theme_asset_remove(
    id: String,
    filename: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    {
        let _guard = state
            .theme_write
            .lock()
            .map_err(|_| "theme write lock poisoned".to_string())?;
        store::asset_remove(&id, &filename)?;
    }
    emit_changed(&handle, &id, "asset-remove")
}

#[tauri::command]
pub async fn theme_export(
    id: String,
    path: Option<String>,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<Option<String>, String> {
    let target_path = match path {
        Some(path) if !path.trim().is_empty() => path,
        _ => {
            let selected = handle
                .dialog()
                .file()
                .add_filter("Markdown Theme", &["mdtheme"])
                .set_file_name(format!("{id}.mdtheme"))
                .blocking_save_file()
                .map(file_path_to_string)
                .filter(|path| !path.is_empty());
            let Some(selected) = selected else {
                return Ok(None);
            };
            selected
        }
    };
    {
        let _guard = state
            .theme_write
            .lock()
            .map_err(|_| "theme write lock poisoned".to_string())?;
        theme::archive::export_theme(&id, Path::new(&target_path))?;
    }
    Ok(Some(target_path))
}

#[tauri::command]
pub async fn theme_import(
    path: Option<String>,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<Option<LayoutInfo>, String> {
    let source_path = match path {
        Some(path) if !path.trim().is_empty() => path,
        _ => {
            let selected = handle
                .dialog()
                .file()
                .add_filter("Markdown Theme", &["mdtheme"])
                .blocking_pick_file()
                .map(file_path_to_string)
                .filter(|path| !path.is_empty());
            let Some(selected) = selected else {
                return Ok(None);
            };
            selected
        }
    };
    let layout = {
        let _guard = state
            .theme_write
            .lock()
            .map_err(|_| "theme write lock poisoned".to_string())?;
        let package = theme::archive::import_theme(Path::new(&source_path))?;
        theme::layout_info(&package)
    };
    emit_changed(&handle, &layout.id, "import")?;
    Ok(Some(layout))
}

fn emit_changed(handle: &AppHandle, id: &str, action: &str) -> Result<(), String> {
    handle
        .emit(
            "themes:changed",
            serde_json::json!({ "id": id, "action": action }),
        )
        .map_err(|error| error.to_string())
}

fn file_path_to_string(path: FilePath) -> String {
    path.into_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::render_saved_theme_preview;

    #[test]
    fn saved_preview_renders_builtin_theme() {
        let html = render_saved_theme_preview("clean", true).unwrap();
        assert!(html.contains("Theme-Vorschau"));
        assert!(html.contains("Überschrift 1"));
        assert!(html.contains("<style>"));
    }

    #[test]
    fn saved_preview_rejects_unknown_theme() {
        let error = render_saved_theme_preview("gibtsnicht", false).unwrap_err();
        assert!(error.contains("Unbekanntes Theme"));
    }

    #[test]
    fn saved_preview_renders_standard_neutrally() {
        let html = render_saved_theme_preview("standard", false).unwrap();
        assert!(html.contains("Folio-Export"));
        assert!(html.contains("Theme-Vorschau"));
    }
}
