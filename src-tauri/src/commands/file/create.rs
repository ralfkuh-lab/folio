use crate::state::AppState;
use crate::{i18n, i18n::Translator};
use std::fs::OpenOptions;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

/// Reine, Tauri-freie Kernlogik: Pfad normalisieren, `..`-Komponenten
/// ablehnen (Defense-in-Depth gegen Pfad-Traversal) und die Datei atomar
/// per `create_new` anlegen. Gibt den normalisierten Pfad zurück.
fn create_file_at(raw_path: &str, tr: Option<&Translator>) -> Result<String, String> {
    let path = raw_path.replace('\\', "/");
    if path.split('/').any(|component| component == "..") {
        return Err(match tr {
            Some(tr) => tr.t("errors.file.invalidName"),
            None => i18n::t("errors.file.invalidName"),
        });
    }
    // Atomar: create_new schlägt fehl, falls das Ziel schon existiert —
    // kein TOCTOU-Race zwischen exists()-Check und write.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                let detail = Path::new(&path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&path);
                match tr {
                    Some(tr) => tr.t_args("errors.file.alreadyExists", &[("detail", detail)]),
                    None => i18n::t_args("errors.file.alreadyExists", &[("detail", detail)]),
                }
            } else {
                let detail = error.to_string();
                match tr {
                    Some(tr) => tr.t_args("errors.file.createFailed", &[("detail", &detail)]),
                    None => i18n::t_args("errors.file.createFailed", &[("detail", &detail)]),
                }
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
    let path = create_file_at(&path, None)?;
    // Neue Datei = neuer Wikilink-Kandidat.
    state.invalidate_wikilink_index();

    // Vault-Sync wie in `finish_rename` (gleiche Lock-Reihenfolge).
    {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        let delta = crate::commands::vault_cmd::compute_refresh_delta_synced(&state, &workspace)?;
        handle
            .emit("vault:refresh", delta)
            .map_err(|error| error.to_string())?;
    }

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::create_file_at;
    use crate::i18n::{CatalogRegistry, ResolvedLanguage, Translator};
    use tempfile::TempDir;

    #[test]
    fn creates_new_file_and_returns_normalized_path() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("neu.md");
        let raw = target.to_string_lossy().replace('\\', "/");

        let result = create_file_at(&raw, Some(&translator("en"))).unwrap();
        assert_eq!(result, raw);
        assert!(target.exists());
    }

    #[test]
    fn rejects_existing_file() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("da.md");
        std::fs::write(&target, "x").unwrap();
        let raw = target.to_string_lossy().replace('\\', "/");

        let error = create_file_at(&raw, Some(&translator("en"))).unwrap_err();
        assert!(error.contains("already exists"), "unexpected: {error}");
        assert!(error.contains("da.md"), "missing detail: {error}");
    }

    #[test]
    fn rejects_parent_traversal_component() {
        let temp = TempDir::new().unwrap();
        let raw = format!("{}/../evil.md", temp.path().to_string_lossy()).replace('\\', "/");

        let error = create_file_at(&raw, Some(&translator("en"))).unwrap_err();
        assert_eq!(error, "Invalid file name");
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
