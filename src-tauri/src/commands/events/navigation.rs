//! Handler für Navigations-Events aus dem Frontend
//! (Link-Klicks, sichtbare Headings, Scroll, TOC-Klicks, Rail-Resize).

use crate::document_service::{self, DirtyPolicy, OpenDocumentOptions, ReloadPolicy};
use crate::link_interceptor::LinkAction;
use crate::state::AppState;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

pub(super) fn link_click(
    href: String,
    new_tab: bool,
    state: &AppState,
    handle: &AppHandle,
) -> Result<(), String> {
    let current_file = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?
        .active()
        .document_store
        .path
        .clone();
    match state
        .link_interceptor
        .handle(&href, current_file.as_deref())
    {
        LinkAction::OpenExternal(target) =>
        {
            #[allow(deprecated)]
            handle
                .shell()
                .open(target, None)
                .map_err(|error| error.to_string())
        }
        LinkAction::Navigate { path, anchor } => {
            if new_tab {
                // tab_open-Pfad. Der Anker geht direkt in
                // `OpenDocumentOptions`, damit EIN History-Eintrag
                // `(path, anchor)` entsteht — ein Nachtrag per zweitem
                // `navigate` hinterliess sonst einen toten Zurueck-Schritt
                // auf dieselbe Datei ohne Anker (Review codex #8/kimi #3).
                let transition =
                    crate::commands::tabs::open_with_anchor(state, handle, path, anchor)
                        .map_err(String::from)?;
                return crate::commands::tabs::emit_navigation_changed(handle, &transition, None)
                    .map_err(String::from);
            }

            if crate::commands::tabs::focus_existing_tab_with_anchor(
                state,
                handle,
                &path,
                anchor.clone(),
            )
            .map_err(String::from)?
            .is_some()
            {
                // Anderer Tab hatte die Datei schon offen: der Anker sitzt
                // auf dessen aktuellem History-Eintrag, `focus_existing_tab`
                // hat bereits genau ein navigation:changed emittiert.
                return Ok(());
            }

            // Anker-only-Links (gleicher Pfad) ueberspringen Disk-IO und
            // Vault-Set-Active; sonst rauschen Scroll/Editor-State weg.
            let outcome = document_service::open(
                state,
                path,
                OpenDocumentOptions {
                    anchor,
                    reload: ReloadPolicy::IfPathChanged,
                    dirty: DirtyPolicy::Discard,
                    // Link-Navigation aus laufender View: aktuellen Mode
                    // behalten, kein Per-Typ-Default-Switch.
                    apply_default_mode: false,
                },
            )
            .map_err(|error| error.user_message())?;
            if let Some(mode) = outcome.mode_override.as_deref() {
                let _ = handle.emit("app:set_mode", serde_json::json!({ "mode": mode }));
            }
            let kind = state
                .tabs
                .lock()
                .ok()
                .and_then(|tabs| tabs.active().document_store.kind());
            let entry = crate::commands::nav::NavEntry::from_kind(&outcome.nav_entry, kind);
            handle
                .emit("navigation:changed", &entry)
                .map_err(|error| error.to_string())
        }
        LinkAction::Missing => Ok(()),
    }
}

pub(super) fn visible_heading(anchor: String, handle: &AppHandle) -> Result<(), String> {
    handle
        .emit(
            "navigation:heading_changed",
            serde_json::json!({ "anchor": anchor }),
        )
        .map_err(|error| error.to_string())
}

pub(super) fn scroll_position(y: f64, state: &AppState) -> Result<(), String> {
    state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?
        .active_mut()
        .navigation
        .update_scroll_position(y);
    Ok(())
}

pub(super) fn toc_click(anchor: String, handle: &AppHandle) -> Result<(), String> {
    handle
        .emit(
            "navigation:toc_click",
            serde_json::json!({ "anchor": anchor }),
        )
        .map_err(|error| error.to_string())
}

pub(super) fn rail_resize(side: String, width: f64, state: &AppState) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_rail_width(&side, width)
        .map_err(|error| error.to_string())
}
