use crate::document_service::DirtyPolicy;
use crate::i18n;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// Verschiebt eine Datei in den Papierkorb (wiederherstellbar). Analog zur
/// Rename-Choreografie: offenen Tab schließen (Discard — die Datei ist weg),
/// Recent/Pin bereinigen, Recent-Submenü + Vault refreshen.
#[tauri::command]
pub async fn trash_file(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    let path = path.replace('\\', "/");

    // trash-Crate ruft unter Windows Shell-APIs, die Forward-Slashes nicht
    // vertragen — dort mit nativem Pfad löschen. Die normalisierte Variante
    // bleibt für find_by_path/remove_recent/is_pinned/unpin.
    let native = if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.clone()
    };
    trash::delete(&native).map_err(|error| {
        let detail = error.to_string();
        i18n::t_args("errors.file.deleteFailed", &[("detail", &detail)])
    })?;

    // Die Datei ist ab hier irreversibel im Papierkorb. Fehler beim
    // Tab-Close dürfen deshalb die folgende Recent/Pin/Vault-Bereinigung
    // NICHT per `?` abbrechen (sonst inkonsistente UI) — nur warnen.
    let tab_id = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?;
        tabs.find_by_path(&path)
    };
    if let Some(id) = tab_id {
        match crate::commands::tabs::close(&state, &handle, id, DirtyPolicy::Discard) {
            Ok(transition) => {
                if let Err(e) =
                    crate::commands::tabs::emit_navigation_changed(&handle, &transition, None)
                {
                    tracing::warn!(target: "folio::ipc", error = %e, "trash_file: emit_navigation_changed nach Tab-Close fehlgeschlagen");
                }
            }
            Err(e) => {
                tracing::warn!(target: "folio::ipc", error = %e, "trash_file: Tab-Close nach Papierkorb-Löschen fehlgeschlagen");
            }
        }
    }

    // Recent/Pin bereinigen (No-op, wenn nicht enthalten).
    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        workspace
            .remove_recent(&path)
            .map_err(|error| error.to_string())?;
        if workspace.is_pinned(&path) {
            workspace.unpin(&path).map_err(|error| error.to_string())?;
        }
    }
    crate::menu::refresh_recent_from_workspace(&handle);
    // Geloeschte Datei aus dem Wikilink-Index werfen.
    state.invalidate_wikilink_index();

    // Vault-Sync mit aktualisiertem Pinned/Recent-Delta (gleiche
    // Lock-Reihenfolge wie `finish_rename`).
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
    // Kein abschließendes emit_tabs_changed: tabs::close hat es bei
    // geschlossenem Tab bereits emittiert; ohne offenen Tab ändert sich der
    // Tab-State nicht. Der vault:refresh oben deckt Pin/Recent im Baum ab.
    Ok(())
}
