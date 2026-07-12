use crate::state::AppState;
use std::fs::OpenOptions;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

/// Reine, Tauri-freie Kernlogik: Pfad normalisieren, `..`-Komponenten
/// ablehnen (Defense-in-Depth gegen Pfad-Traversal) und die Datei atomar
/// per `create_new` anlegen. Gibt den normalisierten Pfad zurück.
fn create_file_at(raw_path: &str) -> Result<String, String> {
    let path = raw_path.replace('\\', "/");
    if path.split('/').any(|component| component == "..") {
        return Err("Ungültiger Dateiname".into());
    }
    // Atomar: create_new schlägt fehl, falls das Ziel schon existiert —
    // kein TOCTOU-Race zwischen exists()-Check und write.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!(
                    "Datei existiert bereits: {}",
                    Path::new(&path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or(&path)
                )
            } else {
                error.to_string()
            }
        })?;
    Ok(path)
}

/// Legt eine neue, leere Datei an und triggert einen Vault-Refresh, damit
/// sie sofort im Baum erscheint. Gibt den normalisierten Pfad zurück, den
/// das Frontend anschließend über `tab_open` öffnet.
#[tauri::command]
pub async fn create_file(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<String, String> {
    let path = create_file_at(&path)?;

    // Vault-Sync wie in `finish_rename` (gleiche Lock-Reihenfolge).
    {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        let vault = state
            .vault
            .lock()
            .map_err(|_| "vault lock poisoned".to_string())?;
        handle
            .emit("vault:refresh", vault.compute_refresh_delta(&workspace))
            .map_err(|error| error.to_string())?;
    }

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::create_file_at;
    use tempfile::TempDir;

    #[test]
    fn creates_new_file_and_returns_normalized_path() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("neu.md");
        let raw = target.to_string_lossy().replace('\\', "/");

        let result = create_file_at(&raw).unwrap();
        assert_eq!(result, raw);
        assert!(target.exists());
    }

    #[test]
    fn rejects_existing_file() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("da.md");
        std::fs::write(&target, "x").unwrap();
        let raw = target.to_string_lossy().replace('\\', "/");

        let error = create_file_at(&raw).unwrap_err();
        assert!(error.contains("existiert bereits"), "unerwartet: {error}");
    }

    #[test]
    fn rejects_parent_traversal_component() {
        let temp = TempDir::new().unwrap();
        let raw = format!("{}/../evil.md", temp.path().to_string_lossy()).replace('\\', "/");

        let error = create_file_at(&raw).unwrap_err();
        assert_eq!(error, "Ungültiger Dateiname");
    }
}
