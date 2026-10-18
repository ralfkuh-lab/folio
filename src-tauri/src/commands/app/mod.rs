//! App-Lifecycle-Commands: View-Mode/Theme/Rail/Window/Zoom (Core-State),
//! `open_find`, `cli_pending_open`. Datei-/Ordner-Picker liegen in
//! `dialog`, OS-Integration (File-Manager, Terminal) in `shell_opener`.
//!
//! Tauri-Commands aus den Submodulen werden in `lib.rs::generate_handler!`
//! ueber explizite Pfade (`commands::app::dialog::pick_file` etc.)
//! registriert — `pub use` reicht hier nicht, weil das Macro die
//! `__cmd__*`-Companion-Funktionen ueber den Original-Modulpfad sucht.

pub mod dialog;
pub mod i18n_cmd;
#[cfg(target_os = "linux")]
pub mod icon_integration;
pub mod log_bridge;
pub mod settings;
pub mod shell_opener;

use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager, State};

/// Ursache eines `app:set_mode`-Events (Spec `docs/spec-vault-keyboard.md`).
/// Das Frontend fokussiert den Editor bei `Open` nicht, wenn gerade der
/// Vault-Baum den Tastaturfokus hat (Enter oeffnet, Fokus bleibt im Baum);
/// bei `User` (ausdruecklicher Moduswechsel) immer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeChangeCause {
    /// Modus folgt aus einem Dokumentwechsel (Oeffnen, Tab, History).
    Open,
    /// Nutzer wechselt den Modus ausdruecklich (Menue, Toolbar, Kuerzel, `/mode`).
    User,
}

impl ModeChangeCause {
    /// Optionales Argument von `set_view_mode`: nur `"open"` ist ein
    /// Dokumentwechsel (History-Restore im Frontend); alles andere, auch ein
    /// fehlendes Argument, ist ein ausdruecklicher Wechsel.
    pub fn from_arg(cause: Option<&str>) -> Self {
        if cause == Some("open") {
            Self::Open
        } else {
            Self::User
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::User => "user",
        }
    }
}

/// Payload fuer `app:set_mode`; `cause` ist additiv (Altpayload ohne Feld
/// gilt im Frontend als `user`).
pub fn set_mode_payload(mode: &str, cause: ModeChangeCause) -> serde_json::Value {
    serde_json::json!({ "mode": mode, "cause": cause.as_str() })
}

#[tauri::command]
pub async fn set_view_mode(
    mode: String,
    // Additiv: `"open"` nur fuer den History-Restore (main.ts), sonst fehlt
    // es — Menue, Toolbar, Strg+1/2/3 sind ausdrueckliche Wechsel.
    cause: Option<String>,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mode = mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "view" | "edit" | "split") {
        return Err(format!("unknown mode '{mode}'"));
    }
    let mut tabs = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?;
    let tab = tabs.active_mut();
    let mode = crate::document_service::clamp_view_mode(&tab.document_store, &mode);
    tab.view_mode = mode.clone();
    tab.navigation.update_view_mode(&mode);
    drop(tabs);
    handle
        .emit(
            "app:set_mode",
            set_mode_payload(&mode, ModeChangeCause::from_arg(cause.as_deref())),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn theme_get(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .theme
        .lock()
        .map_err(|_| "theme lock poisoned".to_string())?
        .mode()
        .to_string())
}

#[tauri::command]
pub async fn theme_set(
    mode: String,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mode = mode.to_ascii_lowercase();
    if !matches!(mode.as_str(), "light" | "dark" | "toggle") {
        return Err(format!("unknown theme '{mode}'"));
    }
    let resolved = {
        let mut theme = state
            .theme
            .lock()
            .map_err(|_| "theme lock poisoned".to_string())?;
        if mode == "toggle" {
            theme.toggle().map_err(|error| error.to_string())?;
        } else {
            theme.set_mode(&mode).map_err(|error| error.to_string())?;
        }
        theme.mode().to_string()
    };
    state
        .automation
        .lock()
        .map_err(|_| "automation state lock poisoned".to_string())?
        .theme = resolved.clone();
    handle
        .emit("app:set_theme", serde_json::json!({ "mode": resolved }))
        .map_err(|error| error.to_string())?;
    Ok(resolved)
}

#[tauri::command]
pub async fn set_rail_visible(
    side: String,
    visible: bool,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let side = side.to_ascii_lowercase();
    if !matches!(side.as_str(), "left" | "right") {
        return Err(format!("unknown side '{side}'"));
    }
    let panel = {
        let mut panel_state = state
            .panel_state
            .lock()
            .map_err(|_| "panel state lock poisoned".to_string())?;
        panel_state
            .set_rail_visible(&side, visible)
            .map_err(|error| error.to_string())?;
        panel_state.data()
    };
    handle
        .emit(
            "panel:rail_changed",
            serde_json::json!({
                "side": side,
                "visible": visible,
                "leftRailVisible": panel.left_rail_visible,
                "rightRailVisible": panel.right_rail_visible,
            }),
        )
        .map_err(|error| error.to_string())
}

/// Liefert die persistierten Rail-Visibility-Werte ans Frontend. Wird
/// beim Boot gerufen, damit die Toolbar-Buttons `tb-rail-left` /
/// `tb-rail-right` ihren `active`-State synchron zur tatsaechlichen
/// Body-CSS-Klasse setzen koennen. Ohne diesen Call zeigten die Buttons
/// auch dann „aktiv", wenn `panel-state.json` `false` persistierte.
#[tauri::command]
pub async fn panel_rails_get(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let data = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data();
    Ok(serde_json::json!({
        "leftRailVisible": data.left_rail_visible,
        "rightRailVisible": data.right_rail_visible,
    }))
}

#[tauri::command]
pub async fn editor_minimap_get(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .editor_minimap_visible)
}

#[tauri::command]
pub async fn set_editor_minimap_visible(
    visible: bool,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_editor_minimap_visible(visible)
        .map_err(|error| error.to_string())?;
    handle
        .emit(
            "panel:minimap_changed",
            serde_json::json!({ "visible": visible }),
        )
        .map_err(|error| error.to_string())
}

/// Liefert den persistierten „volle Breite"-Zustand der Markdown-View ans
/// Frontend. Beim Boot gerufen, damit die Body-Klasse `content-wide` und der
/// `active`-State von `tb-content-width` synchron zur Persistenz starten
/// (analog `editor_minimap_get`).
#[tauri::command]
pub async fn content_wide_get(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .content_wide)
}

#[tauri::command]
pub async fn set_content_wide(
    wide: bool,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_content_wide(wide)
        .map_err(|error| error.to_string())?;
    handle
        .emit(
            "panel:content_wide_changed",
            serde_json::json!({ "wide": wide }),
        )
        .map_err(|error| error.to_string())
}

/// Liefert den persistierten Split-Mode-Teiler (Editor-Pane-Anteil in
/// Prozent) ans Frontend. Beim Boot gerufen, damit `--split-mid` synchron
/// zum persistierten Wert steht (analog `editor_minimap_get`).
#[tauri::command]
pub async fn split_mid_get(state: State<'_, AppState>) -> Result<f64, String> {
    Ok(state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .split_mid_percent)
}

#[tauri::command]
pub async fn set_split_mid_percent(
    percent: f64,
    handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let clamped = {
        let mut guard = state
            .panel_state
            .lock()
            .map_err(|_| "panel state lock poisoned".to_string())?;
        guard
            .set_split_mid_percent(percent)
            .map_err(|error| error.to_string())?;
        guard.data().split_mid_percent
    };
    handle
        .emit(
            "panel:split_mid_changed",
            serde_json::json!({ "percent": clamped }),
        )
        .map_err(|error| error.to_string())
}

/// Liefert die persistierten Vault-Such-Optionen (Aa/W) ans Frontend.
/// Beim Boot des Such-Panels gerufen, damit die Toggle-Buttons synchron
/// zum persistierten Zustand starten.
/// Normalisiert den persistierten `fileFilter`-Wert. Unbekannte/leere Werte
/// fallen auf `allText` zurück, damit die Radio-Gruppe im Dialog nie einen
/// undefinierten Zustand bekommt.
fn normalized_file_filter(raw: &str) -> &'static str {
    match raw {
        "markdown" => "markdown",
        "custom" => "custom",
        _ => "allText",
    }
}

/// Normalisiert den persistierten Sortiermodus (S5). Unbekannte/leere Werte
/// fallen auf `none` (Fundreihenfolge) zurück, damit das Sort-Control im
/// Ergebnis-Header nie einen undefinierten Zustand bekommt.
fn normalized_sort(raw: &str) -> &'static str {
    match raw {
        "name" => "name",
        "path" => "path",
        _ => "none",
    }
}

#[tauri::command]
pub async fn search_options_get(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let data = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data();
    Ok(serde_json::json!({
        "caseSensitive": data.search_case_sensitive,
        "wholeWord": data.search_whole_word,
        "regex": data.search_regex,
        "fileFilter": normalized_file_filter(&data.search_file_filter),
        "customExtensions": data.search_custom_extensions,
        "includeHidden": data.search_include_hidden,
        "includeIgnored": data.search_include_ignored,
        "showPaths": data.search_show_paths,
        "sort": normalized_sort(&data.search_sort),
    }))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn set_search_options(
    case_sensitive: bool,
    whole_word: bool,
    regex: Option<bool>,
    file_filter: Option<String>,
    custom_extensions: Option<String>,
    include_hidden: Option<bool>,
    include_ignored: Option<bool>,
    show_paths: Option<bool>,
    sort: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Neue Felder sind optional, damit die App zwischen Backend- und
    // Frontend-Etappe lauffähig bleibt (alter Aufrufer sendet nur Aa/W). Fehlt
    // ein Feld, bleibt der bisher persistierte Wert erhalten.
    let mut guard = state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?;
    let current = guard.data();
    let file_filter = file_filter.unwrap_or(current.search_file_filter);
    let custom_extensions = custom_extensions.unwrap_or(current.search_custom_extensions.clone());
    // Persistenz prüft denselben Vertrag wie Suchstart/Submit: die finalen
    // Werte werden über FileFilter::from_raw validiert. Custom-Rohtext wird nur
    // bei aktivem `custom`-Filter geparst/abgelehnt (verbotene Zeichen bzw.
    // leere aktive Liste → Err); ein unbekannter Filterwert → Err. Inaktiver
    // Custom-Rohtext wird unverändert roh persistiert, damit der Dialog das Feld
    // 1:1 vorbefüllen kann.
    crate::search::FileFilter::from_raw(&file_filter, &custom_extensions)
        .map_err(|error| error.to_string())?;
    // S5: Sortiermodus wird roh persistiert, aber vor dem Speichern normalisiert
    // (unbekannt → none), damit ein defekter Client-Wert nie in die Datei leckt.
    let sort = normalized_sort(&sort.unwrap_or(current.search_sort)).to_string();
    guard
        .set_search_options(
            case_sensitive,
            whole_word,
            regex.unwrap_or(current.search_regex),
            file_filter,
            custom_extensions,
            include_hidden.unwrap_or(current.search_include_hidden),
            include_ignored.unwrap_or(current.search_include_ignored),
            show_paths.unwrap_or(current.search_show_paths),
            sort,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_window_title(title: String, handle: AppHandle) -> Result<(), String> {
    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.set_title(&title).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_webview_zoom(zoom: f64, handle: AppHandle) -> Result<(), String> {
    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.set_zoom(zoom).map_err(|e| e.to_string())
}

fn main_window(handle: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    handle
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

/// OS-Vollbild des Hauptfensters. Getrennt vom Zen-Layer: F11 allein
/// laesst Rails und Toolbar stehen.
#[tauri::command]
pub async fn set_fullscreen(enabled: bool, handle: AppHandle) -> Result<bool, String> {
    let window = main_window(&handle)?;
    window.set_fullscreen(enabled).map_err(|e| e.to_string())?;
    window.is_fullscreen().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_fullscreen(handle: AppHandle) -> Result<bool, String> {
    let window = main_window(&handle)?;
    let current = window.is_fullscreen().unwrap_or(false);
    window.set_fullscreen(!current).map_err(|e| e.to_string())?;
    window.is_fullscreen().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_fullscreen(handle: AppHandle) -> Result<bool, String> {
    let window = main_window(&handle)?;
    window.is_fullscreen().map_err(|e| e.to_string())
}

/// Transienter Frontend-Zen-State fuer `GET /state`. Keine Persistenz —
/// wer im Zen beendet, startet normal.
#[tauri::command]
pub async fn set_zen_active(active: bool, state: State<'_, AppState>) -> Result<(), String> {
    state
        .automation
        .lock()
        .map_err(|_| "automation state lock poisoned".to_string())?
        .zen = active;
    Ok(())
}

#[tauri::command]
pub async fn zen_hint_seen_get(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .data()
        .zen_hint_seen)
}

#[tauri::command]
pub async fn set_zen_hint_seen(seen: bool, state: State<'_, AppState>) -> Result<(), String> {
    state
        .panel_state
        .lock()
        .map_err(|_| "panel state lock poisoned".to_string())?
        .set_zen_hint_seen(seen)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn open_find(handle: AppHandle) -> Result<(), String> {
    handle
        .emit("editor:open_find", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cli_pending_open(
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<Option<String>, String> {
    let cli_path = state
        .cli_open_path
        .lock()
        .map_err(|_| "cli open path lock poisoned".to_string())?
        .take();

    // Dieser Command ist zugleich der Frontend-ready-Hook fuer den
    // Session-Restore. Ein Boot-CLI-Pfad wird bewusst backendseitig als
    // zusaetzlicher Tab geoeffnet (oder dedupliziert aktiviert), waehrend
    // der laufende `cli:open`-Frontend-Handler bis T5 Replace-Semantik hat.
    let transition = if let Some(path) = cli_path {
        match crate::commands::tabs::open(&state, &handle, path) {
            Ok(transition) => transition,
            Err(error) => {
                tracing::warn!(
                    target: "folio::tabs",
                    %error,
                    "boot CLI path could not be opened; keeping restored active tab"
                );
                let active_id = state
                    .tabs
                    .lock()
                    .map_err(|_| "tabs lock poisoned".to_string())?
                    .active()
                    .id;
                crate::commands::tabs::activate(&state, &handle, active_id).map_err(String::from)?
            }
        }
    } else {
        let active_id = state
            .tabs
            .lock()
            .map_err(|_| "tabs lock poisoned".to_string())?
            .active()
            .id;
        crate::commands::tabs::activate(&state, &handle, active_id).map_err(String::from)?
    };
    crate::commands::tabs::emit_navigation_changed(&handle, &transition, None)
        .map_err(String::from)?;

    // Das Frontend darf den Pfad nicht noch einmal ueber openDocument
    // ersetzen; die Boot-Operation ist oben vollstaendig abgeschlossen.
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_view_mode_cause_argument() {
        // Nur der History-Restore schickt "open"; fehlend/unbekannt = User.
        assert_eq!(
            ModeChangeCause::from_arg(Some("open")),
            ModeChangeCause::Open
        );
        assert_eq!(ModeChangeCause::from_arg(None), ModeChangeCause::User);
        assert_eq!(
            ModeChangeCause::from_arg(Some("user")),
            ModeChangeCause::User
        );
        assert_eq!(ModeChangeCause::from_arg(Some("x")), ModeChangeCause::User);
    }

    #[test]
    fn set_mode_payload_carries_cause() {
        assert_eq!(
            set_mode_payload("edit", ModeChangeCause::Open),
            serde_json::json!({ "mode": "edit", "cause": "open" })
        );
        assert_eq!(
            set_mode_payload("view", ModeChangeCause::User),
            serde_json::json!({ "mode": "view", "cause": "user" })
        );
    }

    /// Jede `app:set_mode`-Emit-Stelle traegt die zugeordnete Ursache
    /// (Spec vault-keyboard, Korrekturrunde 2): Dokumentwechsel = `Open`,
    /// ausdruecklicher Moduswechsel = `User`. Neue Emit-Stellen muessen hier
    /// eingetragen werden, sonst schlaegt der Test fehl.
    #[test]
    fn set_mode_emit_sites_carry_expected_cause() {
        // (Datei relativ zu src/, erwartete Ursache, Anzahl Emit-Stellen)
        let expected: &[(&str, &str, usize)] = &[
            // set_view_mode: Ursache aus dem Argument (from_arg, eigener Test).
            ("commands/app/mod.rs", "Arg", 1),
            ("commands/tabs.rs", "Open", 2),
            ("commands/events/vault.rs", "Open", 1),
            ("commands/file/read.rs", "Open", 1),
            ("commands/events/navigation.rs", "Open", 1),
            ("automation/handlers/document.rs", "Open", 1),
            ("automation/handlers/ui.rs", "User", 1),
        ];
        let needle = concat!("\"app:", "set_mode\"");
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found: Vec<(String, usize)> = Vec::new();
        let mut stack = vec![src.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("read src") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).expect("read file");
                    // Nur Code vor einem Testmodul zaehlen (dieser Test
                    // selbst nennt den Eventnamen nicht woertlich).
                    let code = text.split("#[cfg(test)]").next().unwrap_or("");
                    let n = code.matches(needle).count();
                    if n > 0 {
                        let rel = path
                            .strip_prefix(&src)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        found.push((rel, n));
                    }
                }
            }
        }
        found.sort();
        let mut want: Vec<(String, usize)> = expected
            .iter()
            .map(|(f, _, n)| (f.to_string(), *n))
            .collect();
        want.sort();
        assert_eq!(
            found, want,
            "app:set_mode-Emit-Stellen weichen von der Zuordnung ab"
        );
        for (file, cause, n) in expected {
            if *cause == "Arg" {
                continue;
            }
            let text = std::fs::read_to_string(src.join(file)).expect("read file");
            let code = text.split("#[cfg(test)]").next().unwrap_or("");
            let with_cause = code.matches(&format!("ModeChangeCause::{cause}")).count();
            let other = if *cause == "Open" { "User" } else { "Open" };
            let wrong = code.matches(&format!("ModeChangeCause::{other}")).count();
            assert_eq!(
                with_cause, *n,
                "{file}: erwartet {n}x ModeChangeCause::{cause}"
            );
            assert_eq!(wrong, 0, "{file}: ModeChangeCause::{other} unerwartet");
        }
    }

    // `search_options_get` reicht `normalized_file_filter(&data.search_file_filter)`
    // ans Frontend. Ein unbekannter/leerer gespeicherter Filterwert fällt hier
    // auf `allText` zurück, damit die Radio-Gruppe im Dialog nie einen
    // undefinierten Zustand bekommt.
    #[test]
    fn normalized_file_filter_falls_back_to_all_text() {
        assert_eq!("markdown", normalized_file_filter("markdown"));
        assert_eq!("custom", normalized_file_filter("custom"));
        assert_eq!("allText", normalized_file_filter("allText"));
        // Unbekannt bzw. leer → allText.
        assert_eq!("allText", normalized_file_filter("bogus"));
        assert_eq!("allText", normalized_file_filter(""));
    }

    // S5: `search_options_get` reicht `normalized_sort(&data.search_sort)` ans
    // Frontend. Ein unbekannter/leerer gespeicherter Wert fällt auf `none`
    // (Fundreihenfolge) zurück.
    #[test]
    fn normalized_sort_falls_back_to_none() {
        assert_eq!("name", normalized_sort("name"));
        assert_eq!("path", normalized_sort("path"));
        assert_eq!("none", normalized_sort("none"));
        // Unbekannt bzw. leer → none.
        assert_eq!("none", normalized_sort("bogus"));
        assert_eq!("none", normalized_sort(""));
    }
}
