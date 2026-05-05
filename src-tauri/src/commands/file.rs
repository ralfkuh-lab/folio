use crate::state::AppState;
use serde::Serialize;
use std::{fs, path::Path};
use tauri::State;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileData {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
}

#[tauri::command]
pub async fn read_file(path: String, state: State<'_, AppState>) -> Result<FileData, String> {
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
        .navigate(path, None);
    Ok(FileData {
        path: loaded.path,
        content: loaded.text,
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
        };
        assert_eq!("a", data.path);
        assert_eq!("b", data.content);
    }

    #[test]
    fn missing_directory_returns_error() {
        assert!(list_dir("/definitely/missing/folio-rs").is_err());
    }
}
