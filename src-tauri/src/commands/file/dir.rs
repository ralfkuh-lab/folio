use crate::state::AppState;
use crate::{i18n, i18n::Translator};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

/// Reine, Tauri-freie Kernlogik: Pfad normalisieren, `..`-Komponenten
/// ablehnen und das Verzeichnis per `create_dir` (nicht `create_dir_all`)
/// anlegen. Gibt den normalisierten Pfad zurück.
fn create_directory_at(raw_path: &str, tr: Option<&Translator>) -> Result<String, String> {
    let path = raw_path.replace('\\', "/");
    if path.split('/').any(|component| component == "..") {
        return Err(match tr {
            Some(tr) => tr.t("errors.file.invalidName"),
            None => i18n::t("errors.file.invalidName"),
        });
    }
    match fs::create_dir(&path) {
        Ok(()) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let detail = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&path);
            Err(match tr {
                Some(tr) => tr.t_args("errors.file.alreadyExists", &[("detail", detail)]),
                None => i18n::t_args("errors.file.alreadyExists", &[("detail", detail)]),
            })
        }
        Err(error) => {
            let detail = error.to_string();
            Err(match tr {
                Some(tr) => tr.t_args("errors.file.mkdirFailed", &[("detail", &detail)]),
                None => i18n::t_args("errors.file.mkdirFailed", &[("detail", &detail)]),
            })
        }
    }
}

/// Legt ein neues, leeres Verzeichnis an und triggert einen Vault-Refresh,
/// damit es sofort im Baum erscheint. Gibt den normalisierten Pfad zurück.
#[tauri::command]
pub async fn create_directory(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<String, String> {
    let path = create_directory_at(&path, None)?;
    // Verzeichnis existiert. Vault-Refresh ist best-effort: ein Lock-/
    // Emit-Fehler darf nicht als "nicht angelegt" zurückkommen, sonst
    // kollidiert der Wiederholungsversuch.
    if let Err(error) = emit_vault_refresh(&state, &handle) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            path = %path,
            "create_directory: vault:refresh nach erfolgreichem Anlegen fehlgeschlagen"
        );
    }
    Ok(path)
}

fn emit_vault_refresh(state: &AppState, handle: &AppHandle) -> Result<(), String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let delta = crate::commands::vault_cmd::compute_refresh_delta_synced(state, &workspace)?;
    handle
        .emit("vault:refresh", delta)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::create_directory_at;
    use crate::i18n::{CatalogRegistry, ResolvedLanguage, Translator};
    use tempfile::TempDir;

    #[test]
    fn creates_new_directory_and_returns_normalized_path() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("neu");
        let raw = target.to_string_lossy().replace('\\', "/");

        let result = create_directory_at(&raw, Some(&translator("en"))).unwrap();
        assert_eq!(result, raw);
        assert!(target.is_dir());
    }

    #[test]
    fn rejects_existing_directory() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("da");
        std::fs::create_dir(&target).unwrap();
        let raw = target.to_string_lossy().replace('\\', "/");

        let error = create_directory_at(&raw, Some(&translator("en"))).unwrap_err();
        assert!(error.contains("already exists"), "unexpected: {error}");
        assert!(error.contains("da"), "missing detail: {error}");
    }

    #[test]
    fn rejects_existing_file_at_same_path() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("da");
        std::fs::write(&target, "x").unwrap();
        let raw = target.to_string_lossy().replace('\\', "/");

        let error = create_directory_at(&raw, Some(&translator("en"))).unwrap_err();
        assert!(error.contains("already exists"), "unexpected: {error}");
    }

    #[test]
    fn rejects_parent_traversal_component() {
        let temp = TempDir::new().unwrap();
        let raw = format!("{}/../evil", temp.path().to_string_lossy()).replace('\\', "/");

        let error = create_directory_at(&raw, Some(&translator("en"))).unwrap_err();
        assert_eq!(error, "Invalid file name");
    }

    #[test]
    fn does_not_create_missing_parents() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("missing").join("child");
        let raw = target.to_string_lossy().replace('\\', "/");

        let error = create_directory_at(&raw, Some(&translator("en"))).unwrap_err();
        assert!(
            !target.exists(),
            "create_dir_all behaviour is forbidden: {error}"
        );
        assert!(!target.parent().unwrap().exists());
        assert!(
            error.contains("Could not create target directory") || error.contains("mkdir"),
            "unexpected: {error}"
        );
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
