//! Linux-only: richtet die Markdown-Icon-Integration im Datei-Manager
//! ein, indem das mitgelieferte `install-folio-icons.sh` ausgefuehrt wird
//! (Per-User-Theme-Override im `XDG_DATA_HOME`, ohne sudo). Der
//! system-weite Teil (hicolor-Icons + MIME-XML) steckt bereits im .deb;
//! der Theme-Override gehoert bewusst nicht ins Paket, weil er User-Dateien
//! im aktiven Icon-Theme anfasst. Hintergrund: docs/linux-md-icon.md.

use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const DIALOG_TITLE: &str = "Markdown-Icon-Integration";

/// Kandidatenpfade fuer das Installations-Skript: erst der ins .deb
/// gelegte System-Pfad, dann der Dev-Repo-Pfad (relativ zum Crate).
fn find_script() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("/usr/share/folio/install-folio-icons.sh")];
    // Dev: <repo>/scripts/install-folio-icons.sh — CARGO_MANIFEST_DIR ist
    // <repo>/src-tauri, also eine Ebene hoch.
    if let Some(repo) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(repo.join("scripts/install-folio-icons.sh"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn notify(handle: &AppHandle, body: impl Into<String>, kind: MessageDialogKind) {
    handle
        .dialog()
        .message(body)
        .title(DIALOG_TITLE)
        .kind(kind)
        .blocking_show();
}

/// Fuehrt `install-folio-icons.sh` aus und meldet Erfolg/Fehler per
/// Message-Dialog. Blockiert (das Skript startet u. a. `nemo-desktop`
/// neu) — der Aufrufer muss das in einen eigenen Thread auslagern, weil
/// der Menue-Dispatch auf dem Main-Thread laeuft.
pub fn run_icon_integration(handle: &AppHandle) {
    let Some(script) = find_script() else {
        tracing::error!(
            target: "folio::menu",
            "icon integration: install-folio-icons.sh not found"
        );
        notify(
            handle,
            "Das Installations-Skript wurde nicht gefunden.\n\n\
             Erwartet unter /usr/share/folio/install-folio-icons.sh \
             (installiertes Paket) oder scripts/install-folio-icons.sh \
             (Dev-Repo).",
            MessageDialogKind::Error,
        );
        return;
    };

    tracing::info!(
        target: "folio::menu",
        script = %script.display(),
        "icon integration: running install script"
    );

    match Command::new("bash").arg(&script).output() {
        Ok(output) if output.status.success() => {
            tracing::info!(target: "folio::menu", "icon integration: script succeeded");
            notify(
                handle,
                "Das Folio-Icon wurde fuer Markdown-Dateien eingerichtet.\n\n\
                 Falls der Datei-Manager das neue Icon noch nicht zeigt, \
                 kann ein Ab- und Anmelden noetig sein.",
                MessageDialogKind::Info,
            );
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let code = output.status.code();
            tracing::error!(
                target: "folio::menu",
                ?code,
                stderr = %stderr.trim(),
                "icon integration: script exited with error"
            );
            let detail = stderr.trim();
            let detail = if detail.is_empty() {
                "(keine Fehlerausgabe)"
            } else {
                detail
            };
            notify(
                handle,
                format!("Die Einrichtung ist fehlgeschlagen:\n\n{detail}"),
                MessageDialogKind::Error,
            );
        }
        Err(error) => {
            tracing::error!(
                target: "folio::menu",
                %error,
                "icon integration: failed to spawn script"
            );
            notify(
                handle,
                format!("Das Skript konnte nicht gestartet werden: {error}"),
                MessageDialogKind::Error,
            );
        }
    }
}
