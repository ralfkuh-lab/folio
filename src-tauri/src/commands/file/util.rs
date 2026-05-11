use tauri_plugin_dialog::FilePath;

pub(super) fn file_path_to_string(path: FilePath) -> String {
    path.into_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}
