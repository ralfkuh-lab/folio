use crate::file_kind::{classify, FileKind};
use crate::menu::strings as menu_strings;
use crate::state::AppState;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::util::file_path_to_string;

/// Save-As: Dialog öffnen, Datei unter neuem Pfad ablegen, Workspace/
/// Vault/Navigation aktualisieren. Frontend erfährt vom neuen Dokument
/// über den `document:loaded`-Callback (von `DocumentStore::save_as`)
/// und übernimmt MD-Toolbar/TOC/Editor-Sprache automatisch. Cancel im
/// Dialog → `Ok(None)`, kein State-Drift.
pub fn run_save_as(
    state: &State<'_, AppState>,
    handle: &AppHandle,
) -> Result<Option<String>, String> {
    // 1) Aktuellen Pfad/Text aus dem Store ziehen — hier nur lesen,
    //    damit der Lock vor dem blockierenden Dialog wieder frei ist.
    let current_path = {
        let store = state
            .document_store
            .lock()
            .map_err(|_| "document store lock poisoned".to_string())?;
        if store.path.is_none() {
            return Err("Kein Dokument geöffnet.".into());
        }
        store.path.clone()
    };
    let current_path = current_path.expect("path checked above");

    // 2) Dialog mit Filter aus aktueller Endung + immer „Alle Dateien".
    let labels = menu_strings::labels("de");
    let kind = classify(&current_path);
    let mut builder = handle.dialog().file();
    let current_filename = Path::new(&current_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    builder = builder.set_file_name(current_filename);
    if let Some(parent) = Path::new(&current_path).parent() {
        builder = builder.set_directory(parent);
    }
    match kind {
        FileKind::Markdown => {
            builder = builder.add_filter(
                labels.save_as_filter_markdown,
                &["md", "markdown", "mdown", "mkd"],
            );
        }
        FileKind::Text => {
            // Endung des aktuellen Pfads als primären Filter
            if let Some(ext) = Path::new(&current_path)
                .extension()
                .and_then(|s| s.to_str())
            {
                let ext_lower = ext.to_ascii_lowercase();
                builder = builder.add_filter(labels.save_as_filter_text, &[ext_lower.as_str()]);
            }
        }
        FileKind::Binary => {}
    }
    builder = builder.add_filter(labels.save_as_filter_all, &["*"]);

    let Some(target) = builder.blocking_save_file() else {
        return Ok(None);
    };
    let target_path = file_path_to_string(target);
    if target_path.is_empty() {
        return Ok(None);
    }

    // 3) Persist via DocumentStore — kapselt Schreiben, Pfad-Update,
    //    Watcher-Refresh und loaded-Callback (→ document:loaded-Event).
    let mut store = state
        .document_store
        .lock()
        .map_err(|_| "document store lock poisoned".to_string())?;
    store
        .save_as(&target_path)
        .map_err(|error| error.to_string())?;
    drop(store);

    // 4) Workspace + Vault + Navigation nachziehen — Lock-Fehler werden
    //    propagiert, sonst driften die vier State-Komponenten bei
    //    Mutex-Poisoning unsichtbar auseinander.
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .add_recent(target_path.clone())
        .map_err(|error| error.to_string())?;
    crate::menu::refresh_recent_from_workspace(handle);
    state
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?
        .set_active(Some(target_path.clone()));
    state
        .navigation
        .lock()
        .map_err(|_| "navigation lock poisoned".to_string())?
        .navigate(target_path.clone(), None);

    // document:loaded wird bereits vom DocumentStore::save_as-Callback
    // emittiert (verdrahtet in state.rs); kein zusätzlicher emit nötig.
    Ok(Some(target_path))
}

#[tauri::command]
pub async fn save_as(
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<Option<String>, String> {
    run_save_as(&state, &handle)
}
