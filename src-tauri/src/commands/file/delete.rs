use crate::document_service::DirtyPolicy;
use crate::i18n;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// Verschiebt eine Datei oder einen Ordner in den Papierkorb
/// (wiederherstellbar). Analog zur Move-Choreografie: alle Tabs darunter
/// schließen (Discard — der Pfad ist weg), Recent/Pin/expanded_dirs
/// bereinigen, Recent-Submenü + Vault refreshen.
#[tauri::command]
pub async fn trash_path(
    path: String,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<(), String> {
    let path = crate::path_migration::normalize(&path);

    // trash-Crate ruft unter Windows Shell-APIs, die Forward-Slashes nicht
    // vertragen — dort mit nativem Pfad löschen. Die normalisierte Variante
    // bleibt für find_by_path/remove_recent/is_pinned/unpin.
    let native = if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.clone()
    };
    // Alle Watcher, die Verzeichnis-Handles unterhalb von `path` halten,
    // vor der Shell-Operation stilllegen (siehe suspend_watches_under).
    // Der Vault-/Workspace-/Tab-State bleibt dabei unberuehrt — er wird
    // wie bisher erst nach erfolgreichem Loeschen bereinigt.
    let suspended = suspend_watches_under(&state, &path);
    if let Err(error) = trash::delete(&native) {
        restore_watches(&state, &suspended);
        let detail = error.to_string();
        return Err(i18n::t_args(
            "errors.file.deleteFailed",
            &[("detail", &detail)],
        ));
    }

    // Der Pfad ist ab hier irreversibel im Papierkorb. Fehler beim
    // Aufräumen dürfen die restliche Bereinigung NICHT per `?`
    // abbrechen — nur warnen.
    close_tabs_under(&state, &handle, &path);
    prune_surviving_tab_history(&state, &path);
    if let Err(error) = AppState::emit_tabs_changed(&handle) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            "trash_path: tabs:changed nach History-/Closed-Stack-Bereinigung fehlgeschlagen"
        );
    }
    if let Err(error) = remove_workspace_under(&state, &path) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            path = %path,
            "trash_path: Workspace-Bereinigung nach Papierkorb fehlgeschlagen"
        );
    }
    crate::menu::refresh_recent_from_workspace(&handle);
    state.invalidate_wikilink_index();
    crate::git_status::refresh_for_path(&state.git_status, &path, &handle);
    crate::commands::workspace_cmd::sync_git_head_watcher(&state);
    prune_vault_under(&state, &path);
    if let Err(error) = emit_vault_refresh(&state, &handle) {
        tracing::warn!(
            target: "folio::ipc",
            %error,
            path = %path,
            "trash_path: vault:refresh nach Papierkorb fehlgeschlagen"
        );
    }
    Ok(())
}

/// Fuer die Dauer der Shell-Loeschung stillgelegte Watcher.
struct SuspendedWatches {
    /// Tabs, deren `DocumentStore`-Watcher gestoppt wurde. Enthaelt auch
    /// Tabs ohne Watcher (`pending_path`, fehlgeschlagener Watch) — das
    /// Wiederherstellen ist dort ein No-op.
    tab_ids: Vec<u64>,
    /// Zuvor gewatchte aufgeklappte Vault-Ordner unter dem Root.
    vault_dirs: Vec<String>,
    /// Es lagen `.git`-HEAD-Watches unter dem Root; Restore laeuft ueber
    /// einen erneuten `sync_git_head_watcher`.
    git_head_suspended: bool,
}

/// Stoppt alle Watcher, die ein Verzeichnis-Handle unterhalb von `root`
/// halten. Hintergrund: `notify` nutzt auf Windows
/// `ReadDirectoryChangesW` und haelt damit ein offenes Handle auf das
/// beobachtete Verzeichnis (bei Datei-Watches auf dessen Elternordner).
/// Die Windows-Shell (`IFileOperation`, vom `trash`-Crate benutzt) bricht
/// das Verschieben eines ORDNERS in den Papierkorb bei einem solchen
/// Handle mit „Some operations were aborted" ab — reproduzierbar fuer
/// „Ordner loeschen, waehrend ein Tab auf eine Datei darunter offen ist".
/// Bewusst ohne `cfg(windows)`: ein Codepfad, auf Linux harmlos.
///
/// **Bekanntes Restfenster**: `trash::delete` laeuft lockfrei, also kann
/// zwischen Suspend und Shell-Operation ein paralleler Command (Tab-Open
/// unter dem Pfad, Ordner-Expand) ein neues notify-Handle anlegen — bei
/// konkurrierender Bedienung bleibt der Windows-Fehler damit moeglich.
/// Bewusst KEINE globale Dateioperations-Sperre: dieselbe akzeptierte
/// Restluecken-Klasse wie das Residual-TOCTOU in
/// `rename.rs::perform_move` — der Nutzer ist im Vault der einzige Akteur,
/// und eine App-weite Sperre waere teurer als der Fehlerfall, der sich mit
/// einer sichtbaren Meldung und einem zweiten Klick heilt.
fn suspend_watches_under(state: &AppState, root: &str) -> SuspendedWatches {
    let mut tab_ids = Vec::new();
    match state.tabs.lock() {
        Ok(mut tabs) => {
            tab_ids = tabs.ids_under(root);
            for id in &tab_ids {
                if let Some(tab) = tabs.tab_mut(*id) {
                    tab.document_store.unwatch();
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: tabs lock poisoned beim Watcher-Suspend"
            );
        }
    }

    let mut vault_dirs = Vec::new();
    match state.vault_watcher.lock() {
        Ok(mut watcher) => {
            vault_dirs = watcher.watched_under(root);
            for dir in &vault_dirs {
                watcher.unwatch(dir);
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: vault_watcher lock poisoned beim Watcher-Suspend"
            );
        }
    }

    let mut git_head_suspended = false;
    match state.git_head_watcher.lock() {
        Ok(mut watcher) => {
            git_head_suspended = watcher.unwatch_under(root) > 0;
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: git_head_watcher lock poisoned beim Watcher-Suspend"
            );
        }
    }

    SuspendedWatches {
        tab_ids,
        vault_dirs,
        git_head_suspended,
    }
}

/// Nur fuer den Fehlerfall: der Pfad existiert noch, also muessen die
/// Watcher wieder laufen. Im Erfolgsfall bleibt es beim Suspend — die
/// betroffenen Tabs werden gleich geschlossen, die Vault-Pfade aus
/// `expanded_dirs` gepruned und der GitHeadWatcher ohnehin neu gesynct.
/// Filtert Watch-Kandidaten auf die Pfade, die der Vault-State JETZT noch
/// als aufgeklappt fuehrt. Haelt den `vault`-Lock nur fuer die Abfrage —
/// der Caller nimmt den `vault_watcher`-Lock erst danach. Bei poisoned
/// Lock wird nichts re-gewatcht (lieber ein fehlender Watch als einer, den
/// der State nicht kennt; identische Wahl wie in
/// `rename.rs::remap_vault_and_watchers`).
fn still_expanded(state: &AppState, candidates: &[String]) -> Vec<String> {
    match state.vault.lock() {
        Ok(vault) => candidates
            .iter()
            .filter(|path| vault.is_expanded(path))
            .cloned()
            .collect(),
        Err(error) => {
            tracing::warn!(
                target: "folio::vault",
                %error,
                "trash_path: vault lock poisoned beim Watcher-Restore — keine Vault-Watches wiederhergestellt"
            );
            Vec::new()
        }
    }
}

fn restore_watches(state: &AppState, suspended: &SuspendedWatches) {
    match state.tabs.lock() {
        Ok(mut tabs) => {
            for id in &suspended.tab_ids {
                if let Some(tab) = tabs.tab_mut(*id) {
                    tab.document_store.rewatch();
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: tabs lock poisoned beim Watcher-Restore"
            );
        }
    }

    // Der Snapshot darf NICHT blind zurueckgespielt werden: `trash::delete`
    // laeuft lockfrei, in der Zeit kann der User einen Ordner zuklappen
    // oder ein Refresh `expanded_dirs` aendern. Dessen `unwatch` war wegen
    // des Suspends ein No-op — ein blindes Re-Watch hinterliesse also einen
    // Watch, den der Vault-State nicht kennt (Leak, den niemand mehr
    // deregistriert). Deshalb gegen den aktuellen Vault-State filtern.
    // Lock-Reihenfolge wie in `rename.rs::remap_vault_and_watchers`: erst
    // `vault`, freigeben, DANN `vault_watcher` — nie beide gleichzeitig.
    // Das Mikrofenster zwischen Pruefung und `vault_watcher`-Lock (paralleles
    // Collapse genau dazwischen) bleibt bewusst offen: dasselbe Fenster hat
    // by design jeder Pfad, der Watch-Listen unter dem `vault`-Lock berechnet
    // und erst danach anwendet (siehe `remap_vault_and_watchers`). Der
    // Schaden ist ein einzelner Zombie-Watch, der sich beim naechsten
    // Expand/Collapse des Ordners selbst heilt — Atomik ueber beide Locks
    // waere ein neues Lock-Ordering-Regime fuer einen Fehlerpfad-Sonderfall.
    let vault_dirs = still_expanded(state, &suspended.vault_dirs);
    match state.vault_watcher.lock() {
        Ok(mut watcher) => {
            for dir in &vault_dirs {
                if let Err(error) = watcher.watch(dir) {
                    tracing::warn!(
                        target: "folio::vault",
                        %error,
                        path = %dir,
                        "trash_path: Vault-Watch nach fehlgeschlagenem Papierkorb nicht wiederhergestellt"
                    );
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: vault_watcher lock poisoned beim Watcher-Restore"
            );
        }
    }

    if suspended.git_head_suspended {
        crate::commands::workspace_cmd::sync_git_head_watcher(state);
    }
}

fn close_tabs_under(state: &AppState, handle: &AppHandle, root: &str) {
    let tab_ids = match state.tabs.lock() {
        Ok(tabs) => tabs.ids_under(root),
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: tabs lock poisoned beim Sammeln"
            );
            return;
        }
    };
    for id in tab_ids {
        match crate::commands::tabs::close(state, handle, id, DirtyPolicy::Discard) {
            Ok(transition) => {
                if let Err(error) =
                    crate::commands::tabs::emit_navigation_changed(handle, &transition, None)
                {
                    tracing::warn!(
                        target: "folio::ipc",
                        error = %error,
                        "trash_path: emit_navigation_changed nach Tab-Close fehlgeschlagen"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(
                    target: "folio::ipc",
                    error = %error,
                    "trash_path: Tab-Close nach Papierkorb-Löschen fehlgeschlagen"
                );
            }
        }
    }
}

/// Nach dem Schließen: History der überlebenden Tabs und den Closed-Stack
/// von Pfaden unter `root` befreien. Muss NACH close_tabs_under laufen,
/// weil close frisch in recently_closed pusht.
fn prune_surviving_tab_history(state: &AppState, root: &str) {
    let mut tabs = match state.tabs.lock() {
        Ok(tabs) => tabs,
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: tabs lock poisoned beim History-Prune"
            );
            return;
        }
    };
    let ids: Vec<u64> = tabs.tabs().iter().map(|tab| tab.id).collect();
    for id in ids {
        if let Some(tab) = tabs.tab_mut(id) {
            tab.navigation.remove_under(root);
        }
    }
    tabs.remove_recently_closed_under(root);
}

fn remove_workspace_under(state: &AppState, root: &str) -> Result<(), String> {
    let mut workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    workspace
        .remove_under(root)
        .map_err(|error| error.to_string())
}

fn prune_vault_under(state: &AppState, root: &str) {
    let removed = match state.vault.lock() {
        Ok(mut vault) => vault.remove_under(root),
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: vault lock poisoned beim Prunen"
            );
            return;
        }
    };
    if removed.is_empty() {
        return;
    }
    match state.vault_watcher.lock() {
        Ok(mut watcher) => {
            for path in &removed {
                watcher.unwatch(path);
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "folio::ipc",
                %error,
                "trash_path: vault_watcher lock poisoned beim Unwatch"
            );
        }
    }
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
