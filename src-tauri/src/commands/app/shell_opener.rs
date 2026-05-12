//! OS-Integration: Datei im File-Manager zeigen, Terminal am Pfad oeffnen.
//! Plattformspezifische Pfade fuer Linux/macOS/Windows hardcoded —
//! Linux probiert eine Kandidatenliste durch (TERMINAL-Env zuerst,
//! dann gaengige Emulatoren), macOS oeffnet Terminal.app via `open -a`,
//! Windows startet Windows Terminal (`wt`) ueber `cmd /C start`.

use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

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
