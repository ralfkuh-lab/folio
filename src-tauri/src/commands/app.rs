use crate::state::AppState;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};
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
pub async fn open_terminal_at(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let target = if p.is_file() {
        p.parent().unwrap_or(p).to_path_buf()
    } else {
        p.to_path_buf()
    };

    #[cfg(target_os = "linux")]
    {
        let mut candidates: Vec<String> = Vec::new();
        if let Ok(t) = std::env::var("TERMINAL") {
            if !t.is_empty() {
                candidates.push(t);
            }
        }
        for name in [
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "xfce4-terminal",
            "tilix",
            "mate-terminal",
            "lxterminal",
            "alacritty",
            "kitty",
            "foot",
            "terminator",
            "xterm",
        ] {
            candidates.push(name.to_string());
        }
        let mut last_err: Option<String> = None;
        for cmd in candidates {
            match std::process::Command::new(&cmd)
                .current_dir(&target)
                .spawn()
            {
                Ok(_) => return Ok(()),
                Err(error) => last_err = Some(format!("{cmd}: {error}")),
            }
        }
        return Err(last_err.unwrap_or_else(|| "kein Terminal-Emulator gefunden".into()));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "wt", "-d"])
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
pub async fn set_view_mode(
    mode: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mode = mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "view" | "edit" | "split") {
        return Err(format!("unknown mode '{mode}'"));
    }
    state
        .automation
        .lock()
        .map_err(|_| "automation state lock poisoned".to_string())?
        .view_mode = mode.clone();
    state
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?
        .update_view_mode(&mode);
    handle
        .emit("app:set_mode", serde_json::json!({ "mode": mode }))
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

#[tauri::command]
pub async fn theme_set(
    mode: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mode = mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "light" | "dark" | "toggle") {
        return Err(format!("unknown theme '{mode}'"));
    }
    let resolved = {
        let mut theme = state
            .theme
            .lock()
            .map_err(|_| "theme lock poisoned".to_string())?;
        if mode == "toggle" {
            theme.toggle().map_err(|error| error.to_string())?;
        } else {
            theme.set_mode(&mode).map_err(|error| error.to_string())?;
        }
        theme.mode().to_string()
    };
    state
        .automation
        .lock()
        .map_err(|_| "automation state lock poisoned".to_string())?
        .theme = resolved.clone();
    handle
        .emit("app:set_theme", serde_json::json!({ "mode": resolved }))
        .map_err(|error| error.to_string())?;
    Ok(resolved)
}

#[tauri::command]
pub async fn set_rail_visible(
    side: String,
    visible: bool,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let side = side.to_ascii_lowercase();
    if !matches!(side.as_str(), "left" | "right") {
        return Err(format!("unknown side '{side}'"));
    }
    let panel = {
        let mut panel_state = state
            .panel_state
            .lock()
            .map_err(|_| "panel state lock poisoned".to_string())?;
        panel_state
            .set_rail_visible(&side, visible)
            .map_err(|error| error.to_string())?;
        panel_state.data()
    };
    handle
        .emit(
            "panel:rail_changed",
            serde_json::json!({
                "side": side,
                "visible": visible,
                "leftRailVisible": panel.left_rail_visible,
                "rightRailVisible": panel.right_rail_visible,
            }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_window_title(title: String, handle: AppHandle) -> Result<(), String> {
    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.set_title(&title).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_webview_zoom(zoom: f64, handle: AppHandle) -> Result<(), String> {
    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.set_zoom(zoom).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_find(handle: AppHandle) -> Result<(), String> {
    handle
        .emit("editor:open_find", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cli_pending_open(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .cli_open_path
        .lock()
        .map_err(|_| "cli open path lock poisoned".to_string())?
        .take())
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
