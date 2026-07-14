use crate::{
    i18n,
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
        .ok_or_else(|| i18n::t_args("errors.theme.unknown", &[("detail", &id)]))?;
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
        let _guard = state.theme_write.lock().map_err(|_| {
            theme_command_error("theme write lock poisoned", ThemeOperation::Write, None)
        })?;
        let package = store::write(&id, &ThemeParts::from(files))
            .map_err(|detail| theme_command_error(&detail, ThemeOperation::Write, None))?;
        theme::layout_info(&package)
    };
    emit_changed(&handle, &id, "write")?;
    Ok(layout)
}

#[tauri::command]
pub async fn theme_create(
    id: String,
    files: ThemeWriteFiles,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<LayoutInfo, String> {
    let layout = {
        let _guard = state.theme_write.lock().map_err(|_| {
            theme_command_error("theme write lock poisoned", ThemeOperation::Create, None)
        })?;
        let package = store::create(&id, &ThemeParts::from(files))
            .map_err(|detail| theme_command_error(&detail, ThemeOperation::Create, None))?;
        theme::layout_info(&package)
    };
    emit_changed(&handle, &id, "create")?;
    Ok(layout)
}

#[tauri::command]
pub async fn theme_delete(
    id: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    {
        let _guard = state.theme_write.lock().map_err(|_| {
            theme_command_error("theme write lock poisoned", ThemeOperation::Delete, None)
        })?;
        store::delete(&id)
            .map_err(|detail| theme_command_error(&detail, ThemeOperation::Delete, None))?;
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
        let _guard = state.theme_write.lock().map_err(|_| {
            theme_command_error("theme write lock poisoned", ThemeOperation::Clone, None)
        })?;
        let package = store::clone(&source_id, &new_id)
            .map_err(|detail| theme_command_error(&detail, ThemeOperation::Clone, None))?;
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
    render_saved_theme_preview(&theme_id, dark, None)
}

fn render_saved_theme_preview(
    theme_id: &str,
    dark: bool,
    tr: Option<&i18n::Translator>,
) -> Result<String, String> {
    let package = theme::package(theme_id).ok_or_else(|| match tr {
        Some(tr) => tr.t_args("errors.theme.unknown", &[("detail", theme_id)]),
        None => i18n::t_args("errors.theme.unknown", &[("detail", theme_id)]),
    })?;
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
        let _guard = state.theme_write.lock().map_err(|_| {
            theme_command_error("theme write lock poisoned", ThemeOperation::Asset, None)
        })?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(bytes_base64.as_bytes())
            .map_err(|error| {
                let detail = error.to_string();
                i18n::t_args("errors.theme.assetDecodeFailed", &[("detail", &detail)])
            })?;
        store::asset_add(&id, &filename, &bytes)
            .map_err(|detail| theme_command_error(&detail, ThemeOperation::Asset, None))?
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
        let _guard = state.theme_write.lock().map_err(|_| {
            theme_command_error("theme write lock poisoned", ThemeOperation::Asset, None)
        })?;
        store::asset_remove(&id, &filename)
            .map_err(|detail| theme_command_error(&detail, ThemeOperation::Asset, None))?;
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
        let _guard = state.theme_write.lock().map_err(|_| {
            theme_command_error("theme write lock poisoned", ThemeOperation::Export, None)
        })?;
        theme::archive::export_theme(&id, Path::new(&target_path))
            .map_err(|detail| theme_command_error(&detail, ThemeOperation::Export, None))?;
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
        let _guard = state.theme_write.lock().map_err(|_| {
            theme_command_error("theme write lock poisoned", ThemeOperation::Import, None)
        })?;
        let package = theme::archive::import_theme(Path::new(&source_path))
            .map_err(|detail| theme_command_error(&detail, ThemeOperation::Import, None))?;
        theme::layout_info(&package)
    };
    emit_changed(&handle, &layout.id, "import")?;
    Ok(Some(layout))
}

fn quoted_detail<'a>(detail: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    detail.strip_prefix(prefix)?.strip_suffix(suffix)
}

#[derive(Clone, Copy)]
enum ThemeOperation {
    Write,
    Create,
    Delete,
    Clone,
    Asset,
    Export,
    Import,
}

fn theme_command_error(
    detail: &str,
    operation: ThemeOperation,
    tr: Option<&i18n::Translator>,
) -> String {
    if let Some(id) = quoted_detail(detail, "Ungültige Theme-ID: '", "'") {
        return match tr {
            Some(tr) => tr.t_args("errors.theme.invalidId", &[("id", id)]),
            None => i18n::t_args("errors.theme.invalidId", &[("id", id)]),
        };
    }
    if let Some(id) = quoted_detail(
        detail,
        "Eingebautes Theme '",
        "' kann nicht geändert werden",
    ) {
        return match tr {
            Some(tr) => tr.t_args("errors.theme.builtinReadOnly", &[("id", id)]),
            None => i18n::t_args("errors.theme.builtinReadOnly", &[("id", id)]),
        };
    }
    if let Some(id) = quoted_detail(
        detail,
        "Eingebautes Theme '",
        "' kann nicht gelöscht werden",
    ) {
        return match tr {
            Some(tr) => tr.t_args("errors.theme.builtinDelete", &[("id", id)]),
            None => i18n::t_args("errors.theme.builtinDelete", &[("id", id)]),
        };
    }
    if let Some(id) = quoted_detail(detail, "Theme-ID '", "' ist bereits vergeben") {
        return match tr {
            Some(tr) => tr.t_args("errors.theme.idTaken", &[("id", id)]),
            None => i18n::t_args("errors.theme.idTaken", &[("id", id)]),
        };
    }
    if let Some(id) = quoted_detail(detail, "Unbekanntes Theme: '", "'")
        .or_else(|| quoted_detail(detail, "unknown theme: '", "'"))
    {
        let quoted = format!("'{id}'");
        return match tr {
            Some(tr) => tr.t_args("errors.theme.unknown", &[("detail", &quoted)]),
            None => i18n::t_args("errors.theme.unknown", &[("detail", &quoted)]),
        };
    }
    if let Some(id) = quoted_detail(detail, "Theme '", "' kann nicht dupliziert werden") {
        return match tr {
            Some(tr) => tr.t_args("errors.theme.cloneUnsupported", &[("id", id)]),
            None => i18n::t_args("errors.theme.cloneUnsupported", &[("id", id)]),
        };
    }
    if let Some(id) = quoted_detail(
        detail,
        "Verzeichnis-Theme '",
        "' existiert nicht; Assets koennen nur an Verzeichnis-Themes angehaengt werden",
    ) {
        return match tr {
            Some(tr) => tr.t_args("errors.theme.assetDirectoryRequired", &[("id", id)]),
            None => i18n::t_args("errors.theme.assetDirectoryRequired", &[("id", id)]),
        };
    }

    match (operation, tr) {
        (ThemeOperation::Write, Some(tr)) => {
            tr.t_args("errors.theme.writeFailed", &[("detail", detail)])
        }
        (ThemeOperation::Write, None) => {
            i18n::t_args("errors.theme.writeFailed", &[("detail", detail)])
        }
        (ThemeOperation::Create, Some(tr)) => {
            tr.t_args("errors.theme.createFailed", &[("detail", detail)])
        }
        (ThemeOperation::Create, None) => {
            i18n::t_args("errors.theme.createFailed", &[("detail", detail)])
        }
        (ThemeOperation::Delete, Some(tr)) => {
            tr.t_args("errors.theme.deleteFailed", &[("detail", detail)])
        }
        (ThemeOperation::Delete, None) => {
            i18n::t_args("errors.theme.deleteFailed", &[("detail", detail)])
        }
        (ThemeOperation::Clone, Some(tr)) => {
            tr.t_args("errors.theme.cloneFailed", &[("detail", detail)])
        }
        (ThemeOperation::Clone, None) => {
            i18n::t_args("errors.theme.cloneFailed", &[("detail", detail)])
        }
        (ThemeOperation::Asset, Some(tr)) => {
            tr.t_args("errors.theme.assetFailed", &[("detail", detail)])
        }
        (ThemeOperation::Asset, None) => {
            i18n::t_args("errors.theme.assetFailed", &[("detail", detail)])
        }
        (ThemeOperation::Export, Some(tr)) => {
            tr.t_args("errors.theme.exportFailed", &[("detail", detail)])
        }
        (ThemeOperation::Export, None) => {
            i18n::t_args("errors.theme.exportFailed", &[("detail", detail)])
        }
        (ThemeOperation::Import, Some(tr)) => {
            tr.t_args("errors.theme.importFailed", &[("detail", detail)])
        }
        (ThemeOperation::Import, None) => {
            i18n::t_args("errors.theme.importFailed", &[("detail", detail)])
        }
    }
}

fn emit_changed(handle: &AppHandle, id: &str, action: &str) -> Result<(), String> {
    handle
        .emit(
            "themes:changed",
            serde_json::json!({ "id": id, "action": action }),
        )
        .map_err(|error| {
            let detail = error.to_string();
            i18n::t_args("errors.theme.eventFailed", &[("detail", &detail)])
        })
}

fn file_path_to_string(path: FilePath) -> String {
    path.into_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{render_saved_theme_preview, theme_command_error, ThemeOperation};
    use crate::i18n::{CatalogRegistry, ResolvedLanguage, Translator};

    #[test]
    fn saved_preview_renders_builtin_theme() {
        let html = render_saved_theme_preview("clean", true, Some(&translator("en"))).unwrap();
        assert!(html.contains("Theme-Vorschau"));
        assert!(html.contains("Überschrift 1"));
        assert!(html.contains("<style>"));
    }

    #[test]
    fn saved_preview_rejects_unknown_theme() {
        let error =
            render_saved_theme_preview("gibtsnicht", false, Some(&translator("en"))).unwrap_err();
        assert!(error.contains("Unknown theme"));
        assert!(error.contains("gibtsnicht"));
    }

    #[test]
    fn domain_theme_errors_are_not_wrapped_in_operation_frames() {
        let de = translator("de");
        assert_eq!(
            "Theme-ID 'mine' ist bereits vergeben",
            theme_command_error(
                "Theme-ID 'mine' ist bereits vergeben",
                ThemeOperation::Create,
                Some(&de),
            )
        );

        let en = translator("en");
        assert_eq!(
            "Theme ID 'mine' is already taken",
            theme_command_error(
                "Theme-ID 'mine' ist bereits vergeben",
                ThemeOperation::Create,
                Some(&en),
            )
        );
        assert_eq!(
            "Could not create theme: disk full",
            theme_command_error("disk full", ThemeOperation::Create, Some(&en))
        );
    }

    #[test]
    fn saved_preview_renders_standard_neutrally() {
        let html = render_saved_theme_preview("standard", false, Some(&translator("en"))).unwrap();
        assert!(html.contains("Folio-Export"));
        assert!(html.contains("Theme-Vorschau"));
    }

    fn translator(tag: &str) -> Translator {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("locales");
        let registry = CatalogRegistry::load_from_dir(&dir).expect("load locales");
        Translator::new(
            registry,
            ResolvedLanguage {
                catalog_tag: tag.to_string(),
                format_locale: "en-US".to_string(),
            },
        )
    }
}
