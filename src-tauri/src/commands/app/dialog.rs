//! Datei-/Ordner-Picker-Dialoge (blocking_pick_*) und der Helper, der
//! `tauri_plugin_dialog::FilePath` in einen String konvertiert.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

#[tauri::command]
pub async fn open_folder(handle: AppHandle) -> Result<Option<String>, String> {
    pick_folder(handle).await
}

#[tauri::command]
pub async fn pick_folder(handle: AppHandle) -> Result<Option<String>, String> {
    Ok(handle
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(file_path_to_string))
}

#[tauri::command]
pub async fn pick_file(handle: AppHandle) -> Result<Option<String>, String> {
    Ok(handle
        .dialog()
        .file()
        .blocking_pick_file()
        .map(file_path_to_string))
}

fn file_path_to_string(path: FilePath) -> String {
    path.into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn path_file_path_converts_to_string() {
        assert_eq!(
            "/tmp/a",
            file_path_to_string(FilePath::Path(PathBuf::from("/tmp/a")))
        );
    }

    #[test]
    fn empty_pathbuf_converts_without_error() {
        assert_eq!("", file_path_to_string(FilePath::Path(PathBuf::new())));
    }
}
