use crate::{
    state::AppState,
    theme::{
        self,
        package::{ThemeManifest, ThemePackage, ThemeSource},
        store::{self, ThemeParts},
        LayoutInfo,
    },
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

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
pub struct AssetInfo {
    pub filename: String,
    pub size: u64,
    pub mime: String,
}

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
    theme::package(&id)
        .map(ThemeFiles::from)
        .ok_or_else(|| format!("Unbekanntes Theme: '{id}'"))
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
) -> Result<String, String> {
    let markdown = markdown.as_deref().unwrap_or(THEME_PREVIEW_SAMPLE);
    Ok(crate::export::render_theme_preview(
        markdown,
        &ThemeParts::from(parts),
        dark,
    ))
}

fn emit_changed(handle: &AppHandle, id: &str, action: &str) -> Result<(), String> {
    handle
        .emit(
            "themes:changed",
            serde_json::json!({ "id": id, "action": action }),
        )
        .map_err(|error| error.to_string())
}
