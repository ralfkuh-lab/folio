//! Wikilink-/Tag-Commands (Backlinks, Autocomplete, Tag-Browser).
//!
//! Kernlogik lebt in `crate::wikilink` / `crate::tags`; hier nur State-
//! Verdrahtung.
//!
//! **Suchraum ist ueberall `Workspace::wikilink_pins()`** (Opt-in-Wurzeln,
//! Spec W8) — nie `pinned()`. Der Tag-Browser haengt am selben Walk und
//! haette sonst dasselbe Kostenproblem.

use crate::state::AppState;
use crate::tags::{self, VaultTagsResult};
use crate::wikilink::{self, BacklinksResult, WikilinkCandidate, WikilinkHeading};
use tauri::State;

/// Vault-Scan: welche MD-Dateien verlinken per `[[…]]` auf `path`?
///
/// Läuft in `spawn_blocking`, weil der Walk über den Vault I/O-lastig ist.
#[tauri::command]
pub async fn backlinks_for(
    path: String,
    state: State<'_, AppState>,
) -> Result<BacklinksResult, String> {
    let path = path.replace('\\', "/");
    let pinned = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        workspace.wikilink_pins()
    };
    // Index-Zugriff bewusst IM Blocking-Task: `find_backlinks` selbst walkt
    // den Suchraum, und der Cache-Zugriff gehoert an dieselbe Stelle
    // (Review codex #2 / kimi #1). Seit W8 baut auch ein Cache-Miss nicht
    // mehr synchron — der Walk hier ist der teure Teil.
    let cache = state.wikilink_index.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let index = cache.get(&pinned);
        wikilink::find_backlinks(&pinned, &path, &index)
    })
    .await
    .map_err(|error| error.to_string())
}

/// Überschriften des aufgelösten Wikilink-Ziels für `[[Name#`-Complete.
///
/// - `name` leer → Überschriften von `current_path` (`[[#…]]`)
/// - sonst Index-Auflösung wie beim Renderer
#[tauri::command]
pub async fn wikilink_headings(
    name: String,
    current_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<WikilinkHeading>, String> {
    let pinned = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        workspace.wikilink_pins()
    };
    let cache = state.wikilink_index.clone();
    let current = current_path.map(|p| p.replace('\\', "/"));

    tauri::async_runtime::spawn_blocking(move || {
        let index = cache.get(&pinned);
        wikilink::headings_for_wikilink_name(&index, &name, current.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Vault-weiter Tag-Scan (Text + Frontmatter). Lazy vom Frontend beim
/// Aufklappen der Tags-Sektion / Refresh-Button.
#[tauri::command]
pub async fn vault_tags(state: State<'_, AppState>) -> Result<VaultTagsResult, String> {
    let pinned = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        workspace.wikilink_pins()
    };
    tauri::async_runtime::spawn_blocking(move || tags::collect_vault_tags(&pinned))
        .await
        .map_err(|error| error.to_string())
}

/// Autocomplete-Kandidaten aus dem Wikilink-Index (gitignore/hidden wie
/// der Resolver). `insert` ist backend-seitig disambiguiert (F7); mit
/// `currentPath` lokalitätsbewusst verkürzt (W7).
#[tauri::command]
pub async fn wikilink_candidates(
    current_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<WikilinkCandidate>, String> {
    let pinned = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        workspace.wikilink_pins()
    };
    let cache = state.wikilink_index.clone();
    let context = current_path
        .map(|p| p.replace('\\', "/"))
        .filter(|p| !p.is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        let index = cache.get(&pinned);
        let ctx = context.as_deref().map(std::path::Path::new);
        wikilink::collect_wikilink_candidates(&index, ctx)
    })
    .await
    .map_err(|error| error.to_string())
}
