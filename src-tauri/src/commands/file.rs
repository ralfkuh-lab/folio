use crate::file_kind::{classify, editor_language, FileKind};
use crate::menu::strings as menu_strings;
use crate::state::AppState;
use serde::Serialize;
use std::{fs, path::Path};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileData {
    pub path: String,
    pub content: String,
    pub kind: FileKind,
    pub language: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
}

#[tauri::command]
pub async fn read_file(path: String, state: State<'_, AppState>) -> Result<FileData, String> {
    let kind = classify(&path);
    if kind == FileKind::Binary {
        return Err(format!(
            "Dateityp wird nicht unterstützt: {}",
            Path::new(&path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&path)
        ));
    }
    let loaded = state
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
    let language = editor_language(&loaded.path).to_string();
    Ok(FileData {
        path: loaded.path,
        content: loaded.text,
        kind,
        language,
    })
}

#[tauri::command]
pub async fn write_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    fs::write(&path, content.clone()).map_err(|error| error.to_string())?;
    let mut store = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?;
    if store.path.as_deref() == Some(path.as_str()) {
        store.text = content.replace("\r\n", "\n");
        store.set_dirty(false);
    }
    Ok(())
}

#[tauri::command]
pub async fn file_list(dir: String) -> Result<Vec<FileEntry>, String> {
    list_dir(&dir).map_err(|error| error.to_string())
}

/// Save-As: Dialog öffnen, Datei unter neuem Pfad ablegen, Workspace/
/// Vault/Navigation aktualisieren. Frontend erfährt vom neuen Dokument
/// über den `document:loaded`-Callback (von `DocumentStore::save_as`)
/// und übernimmt MD-Toolbar/TOC/Editor-Sprache automatisch. Cancel im
/// Dialog → `Ok(None)`, kein State-Drift.
pub fn run_save_as(
    state: &State<'_, AppState>,
    handle: &AppHandle,
) -> Result<Option<String>, String> {
    // 1) Aktuellen Pfad/Text aus dem Store ziehen — hier nur lesen,
    //    damit der Lock vor dem blockierenden Dialog wieder frei ist.
    let current_path = {
        let store = state
            .document_store
            .lock()
            .map_err(|_| "document store lock poisoned".to_string())?;
        if store.path.is_none() {
            return Err("Kein Dokument geöffnet.".into());
        }
        store.path.clone()
    };
    let current_path = current_path.expect("path checked above");

    // 2) Dialog mit Filter aus aktueller Endung + immer „Alle Dateien".
    let labels = menu_strings::labels("de");
    let kind = classify(&current_path);
    let mut builder = handle.dialog().file();
    let current_filename = Path::new(&current_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    builder = builder.set_file_name(current_filename);
    if let Some(parent) = Path::new(&current_path).parent() {
        builder = builder.set_directory(parent);
    }
    match kind {
        FileKind::Markdown => {
            builder = builder.add_filter(
                labels.save_as_filter_markdown,
                &["md", "markdown", "mdown", "mkd"],
            );
        }
        FileKind::Text => {
            // Endung des aktuellen Pfads als primären Filter
            if let Some(ext) = Path::new(&current_path)
                .extension()
                .and_then(|s| s.to_str())
            {
                let ext_lower = ext.to_ascii_lowercase();
                builder = builder.add_filter(labels.save_as_filter_text, &[ext_lower.as_str()]);
            }
        }
        FileKind::Binary => {}
    }
    builder = builder.add_filter(labels.save_as_filter_all, &["*"]);

    let Some(target) = builder.blocking_save_file() else {
        return Ok(None);
    };
    let target_path = file_path_to_string(target);
    if target_path.is_empty() {
        return Ok(None);
    }

    // 3) Persist via DocumentStore — kapselt Schreiben, Pfad-Update,
    //    Watcher-Refresh und loaded-Callback (→ document:loaded-Event).
    let mut store = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?;
    store
        .save_as(&target_path)
        .map_err(|error| error.to_string())?;
    drop(store);

    // 4) Workspace + Vault + Navigation nachziehen — alle Werte sind
    //    klein, also kein Bedarf an Cross-Lock-Choreografie.
    if let Ok(mut workspace) = state.workspace.lock() {
        let _ = workspace.add_recent(target_path.clone());
    }
    if let Ok(mut vault) = state.vault.lock() {
        vault.set_active(Some(target_path.clone()));
    }
    if let Ok(mut nav) = state.navigation.lock() {
        nav.navigate(target_path.clone(), None);
    }

    // document:loaded wird bereits vom DocumentStore::save_as-Callback
    // emittiert (verdrahtet in state.rs); kein zusätzlicher emit nötig.
    let _ = handle;
    Ok(Some(target_path))
}

#[tauri::command]
pub async fn save_as(
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<Option<String>, String> {
    run_save_as(&state, &handle)
}

fn file_path_to_string(path: FilePath) -> String {
    path.into_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn list_dir(dir: &str) -> std::io::Result<Vec<FileEntry>> {
    let mut entries = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            FileEntry {
                name: file_name(&path),
                is_directory: path.is_dir(),
                path: path.to_string_lossy().into_owned(),
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn list_dir_sorts_directories_first() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("b.md"), "").unwrap();
        fs::create_dir(temp.path().join("a")).unwrap();
        let entries = list_dir(temp.path().to_str().unwrap()).unwrap();
        assert_eq!("a", entries[0].name);
        assert!(entries[0].is_directory);
    }

    #[test]
    fn file_data_shape_holds_path_and_content() {
        let data = FileData {
            path: "a".into(),
            content: "b".into(),
            kind: FileKind::Markdown,
            language: "markdown".into(),
        };
        assert_eq!("a", data.path);
        assert_eq!("b", data.content);
    }

    #[test]
    fn missing_directory_returns_error() {
        assert!(list_dir("/definitely/missing/folio").is_err());
    }
}
