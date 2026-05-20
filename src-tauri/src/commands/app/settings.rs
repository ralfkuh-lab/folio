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
