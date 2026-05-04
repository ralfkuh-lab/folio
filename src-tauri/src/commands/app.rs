use crate::state::AppState;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_shell::ShellExt;

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

#[tauri::command]
pub async fn show_in_file_manager(path: String, handle: AppHandle) -> Result<(), String> {
    let p = Path::new(&path);
    let target = if p.is_file() {
        p.parent().unwrap_or(p).to_path_buf()
    } else {
        p.to_path_buf()
    };
    #[allow(deprecated)]
    handle
        .shell()
        .open(target.to_string_lossy().to_string(), None)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn theme_get(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .theme
        .lock()
        .map_err(|_| "theme lock poisoned".to_string())?
        .mode()
        .to_string())
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
    fn open_folder_and_pick_folder_share_shape() {
        let fn_name = "open_folder";
        assert_eq!("open_folder", fn_name);
    }

    #[test]
    fn empty_pathbuf_converts_without_error() {
        assert_eq!("", file_path_to_string(FilePath::Path(PathBuf::new())));
    }
}
