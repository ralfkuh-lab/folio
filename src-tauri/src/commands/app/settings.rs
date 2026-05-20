//! Tauri-Commands fuer den Settings-Dialog (siehe `ui/settings-dialog.ts`).
//!
//! `settings_get` liefert dem Frontend das komplette SettingsData-JSON
//! beim Dialog-Open. `settings_update` nimmt einen Patch entgegen, wendet
//! ihn ueber [`crate::settings::SettingsService::apply_patch`] an und
//! emittiert `settings:changed` mit `{ settings, changed }` — Frontend
//! reagiert nur auf die Felder in `changed`, vermeidet unnoetige
//! Side-Effects (Menue-Rebuild u.a.).

use crate::settings::{SettingsData, SettingsPatch};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<SettingsData, String> {
    Ok(state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?
        .data())
}

#[tauri::command]
pub async fn settings_update(
    patch: SettingsPatch,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<SettingsData, String> {
    if patch.is_empty() {
        return state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned".to_string())
            .map(|svc| svc.data());
    }
    let (data, changed) = {
        let mut svc = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned".to_string())?;
        let changed = svc.apply_patch(patch).map_err(|e| e.to_string())?;
        (svc.data(), changed)
    };
    // Side-Effect: VaultAutoRefresh-Toggle muss den Watcher live ein-/
    // ausschalten — sonst greift die Aenderung erst beim naechsten
    // Boot. Bei `true` werden alle aktuell aufgeklappten Ordner aus
    // dem Vault-State erneut registriert, damit der Re-Enable nicht
    // erst beim naechsten Expand wirksam wird.
    if changed.contains(&"vaultAutoRefresh") {
        sync_vault_watcher(&state, data.vault_auto_refresh);
    }
    if !changed.is_empty() {
        handle
            .emit(
                "settings:changed",
                serde_json::json!({ "settings": data, "changed": changed }),
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(data)
}

fn sync_vault_watcher(state: &State<'_, AppState>, enabled: bool) {
    let expanded: Vec<String> = state
        .vault
        .lock()
        .map(|v| v.expanded_paths())
        .unwrap_or_default();
    if let Ok(mut watcher) = state.vault_watcher.lock() {
        watcher.set_enabled(enabled);
        if enabled {
            for path in &expanded {
                if let Err(err) = watcher.watch(path) {
                    eprintln!("vault_watcher.watch on re-enable failed for {path}: {err}");
                }
            }
        }
    }
}
