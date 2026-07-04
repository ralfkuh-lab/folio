//! Domain-Orchestrierung fuer das Oeffnen eines Dokuments — eine
//! Service-Funktion, die `DocumentStore::load`, `NavigationController::navigate`
//! und `Vault::set_active` kapselt. Vier Aufrufer (Tauri-Command, Vault-Event,
//! Link-Klick-Event, Automation-API) gingen vorher jeweils mit eigenen
//! Lock-Choreografien auf alle drei Komponenten — das Modul macht es zu
//! einer Stelle.
//!
//! Reihenfolge ist bewusst Load → Navigate → Vault: faellt der Load, bleibt
//! die History unveraendert. Der frueher in `link_click` vorhandene
//! "Navigate-vor-Load"-Pfad konnte bei IO-Fehlern einen History-Eintrag
//! auf einem nie geladenen Ziel hinterlassen.

use std::sync::Mutex;

use crate::document_store::{DocumentStore, LoadedDocument};
use crate::file_kind::{classify, FileKind};
use crate::navigation::Entry as NavigationEntry;
use crate::settings::{DefaultViewMode, SettingsService};
use crate::state::AppState;
use crate::tab_manager::{Tab, TabManager};
use crate::vault::Vault;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReloadPolicy {
    /// Pfad immer von Disk laden, auch wenn er bereits offen ist.
    Always,
    /// Disk-IO nur, wenn der angefragte Pfad sich vom aktuell offenen
    /// unterscheidet — Anker-only-Sprung im View-Modus.
    IfPathChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirtyPolicy {
    /// Bei `is_dirty == true` mit `OpenDocumentError::DirtyRejected`
    /// abbrechen. Aufrufer (Frontend) entscheidet ueber Prompt.
    Reject,
    /// Ungespeicherte Aenderungen kommentarlos verwerfen (entspricht dem
    /// historischen Verhalten von `DocumentStore::load`).
    Discard,
}

#[derive(Debug, Clone)]
pub struct OpenDocumentOptions {
    pub anchor: Option<String>,
    pub reload: ReloadPolicy,
    pub dirty: DirtyPolicy,
    /// Per-Typ-Default-Mode (`defaultModeMarkdown`/`defaultModeText`)
    /// anwenden? Wahr fuer "frische Opens" (CLI, Drag-Drop, Vault-Klick,
    /// Recents, Pin, read_file). Falsch fuer Link-Navigation aus einer
    /// laufenden View heraus: dort soll der aktuelle Mode erhalten
    /// bleiben (HTML-Preview-Link soll z.B. nicht in den Edit-Mode
    /// kippen, nur weil default_mode_text=edit gesetzt ist).
    pub apply_default_mode: bool,
}

#[derive(Debug)]
pub struct OpenDocumentOutcome {
    /// `Some` wenn tatsaechlich von Disk geladen wurde, `None` beim
    /// Anker-only-Sprung (gleicher Pfad bei `ReloadPolicy::IfPathChanged`).
    pub loaded: Option<LoadedDocument>,
    pub nav_entry: NavigationEntry,
    /// `Some(mode)` wenn der Per-Typ-Default-Mode aus den Settings
    /// (`defaultModeMarkdown` / `defaultModeText`) einen View-/Edit-
    /// Switch bewirkt hat. Der Aufrufer ist dafuer zustaendig,
    /// `app:set_mode` mit diesem Mode ans Frontend zu emittieren —
    /// Tab.view_mode/navigation sind hier bereits aktualisiert.
    ///
    /// `None` bedeutet entweder: Setting steht auf `current` (default),
    /// oder Mode war schon korrekt, oder Kind ist nicht switching-faehig
    /// (Binary/Unknown), oder es wurde gar nichts geladen (Anker-Sprung).
    pub mode_override: Option<String>,
}

#[derive(Debug)]
pub enum OpenDocumentError {
    DirtyRejected,
    LockPoisoned(&'static str),
    Load(std::io::Error),
}

impl std::fmt::Display for OpenDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DirtyRejected => f.write_str("unsaved changes; dirty policy rejects open"),
            Self::LockPoisoned(name) => write!(f, "{name} lock poisoned"),
            Self::Load(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for OpenDocumentError {}

impl From<OpenDocumentError> for String {
    fn from(error: OpenDocumentError) -> Self {
        error.to_string()
    }
}

pub fn open(
    state: &AppState,
    path: String,
    options: OpenDocumentOptions,
) -> Result<OpenDocumentOutcome, OpenDocumentError> {
    open_inner(
        &state.tabs,
        &state.vault,
        Some(&state.settings),
        path,
        options,
    )
}

fn open_inner(
    tabs: &Mutex<TabManager>,
    vault: &Mutex<Vault>,
    settings: Option<&Mutex<SettingsService>>,
    path: String,
    options: OpenDocumentOptions,
) -> Result<OpenDocumentOutcome, OpenDocumentError> {
    // Pfad einmal am Service-Eingang auf Forward-Slashes normalisieren
    // (Windows-Datei-Dialoge liefern Backslashes). Sonst fuehren Store
    // und History gemischte Separatoren: dieselbe Datei per Dialog und
    // per Vault/Recent geoeffnet wuerde das navigate-Dedupe und
    // ReloadPolicy::IfPathChanged verfehlen. Windows-APIs akzeptieren
    // beide Schreibweisen, Datei-IO bricht dadurch nicht.
    let path = path.replace('\\', "/");
    let mut tabs = tabs
        .lock()
        .map_err(|_| OpenDocumentError::LockPoisoned("tabs"))?;
    let tab = tabs.active_mut();
    let needs_load = {
        let store = &tab.document_store;
        let needs_load = match options.reload {
            ReloadPolicy::Always => true,
            ReloadPolicy::IfPathChanged => store.path.as_deref() != Some(path.as_str()),
        };
        needs_load
    };

    let loaded = if needs_load {
        if options.dirty == DirtyPolicy::Reject && tab.document_store.is_dirty {
            return Err(OpenDocumentError::DirtyRejected);
        }
        Some(load_by_kind(&mut tab.document_store, &path).map_err(OpenDocumentError::Load)?)
    } else {
        None
    };

    let nav_entry = tab
        .navigation
        .navigate(path.clone(), options.anchor)
        .clone();

    if needs_load {
        vault
            .lock()
            .map_err(|_| OpenDocumentError::LockPoisoned("vault"))?
            .set_active(Some(path.clone()));
    }

    // Per-Typ-Default-Mode aus den Settings nur auf frischem Open
    // anwenden (nicht beim Anker-Sprung mit IfPathChanged). History,
    // Reload und Save laufen ueber andere Pfade und sind unberuehrt.
    let mode_override = if needs_load && options.apply_default_mode {
        apply_default_mode(settings, tab, &path)
    } else {
        None
    };
    drop(tabs);

    Ok(OpenDocumentOutcome {
        loaded,
        nav_entry,
        mode_override,
    })
}

/// Laedt ein Dokument passend zu seinem FileKind in den Store. Bilder
/// werden nicht als Text geladen — das Frontend rendert sie ueber
/// `convertFileSrc` direkt von Disk; `load_opaque` setzt nur den Pfad,
/// damit Vault-Active, History und das `document:loaded`-Event mit dem
/// richtigen Pfad feuern. Alles andere laeuft als Text ueber `load`.
pub fn load_by_kind(store: &mut DocumentStore, path: &str) -> std::io::Result<LoadedDocument> {
    if matches!(classify(path), FileKind::Image) {
        store.load_opaque(path)
    } else {
        store.load(path)
    }
}

/// View-Mode fuer einen History-Restore: Markdown und HTML behalten den
/// im Entry gespeicherten Mode (echte Preview vorhanden). Bilder
/// erzwingen `view` — Edit ist fuer Images gesperrt, `load_opaque` legt
/// keinen Text ab. Alle uebrigen Text-/Binary-Pfade clampen auf `edit`,
/// damit ein zuvor gespeicherter `view`-Wert beim Restore nicht in einen
/// leeren Markdown-Body fuehrt.
pub fn history_view_mode(path: &str, stored: &str) -> String {
    match classify(path) {
        FileKind::Markdown => stored.to_string(),
        FileKind::Image => "view".to_string(),
        _ if crate::file_resolver::is_html(path) => stored.to_string(),
        _ => "edit".to_string(),
    }
}

/// Gemeinsamer Kern fuer History-Back/Forward (Tauri-Commands in
/// `commands::nav` und Automation-API `/history/*`): bewegt den
/// History-Index hinter dem `can_go_*`-Gate und laedt das Zieldokument
/// passend zu seinem FileKind. `Ok(None)` am Stack-Edge — dort wuerde
/// `go_back`/`go_forward` per Konvention `current()` liefern und wir
/// wuerden das aktive Dokument unnoetig neu laden.
///
/// Schlaegt der Load fehl, wird der bereits bewegte Index zurueckgerollt:
/// ohne Rollback zeigte die History auf das Ziel, waehrend die UI das
/// alte Dokument zeigt, und jede weitere Navigation arbeitete ab dem
/// falschen Index.
pub fn move_history(
    tabs: &Mutex<TabManager>,
    vault: &Mutex<Vault>,
    forward: bool,
) -> Result<Option<NavigationEntry>, OpenDocumentError> {
    let mut tabs = tabs
        .lock()
        .map_err(|_| OpenDocumentError::LockPoisoned("tabs"))?;
    let tab = tabs.active_mut();
    let entry = {
        let navigation = &mut tab.navigation;
        let can_move = if forward {
            navigation.can_go_forward()
        } else {
            navigation.can_go_back()
        };
        if !can_move {
            None
        } else if forward {
            navigation.go_forward().cloned()
        } else {
            navigation.go_back().cloned()
        }
    };
    let Some(entry) = entry else {
        return Ok(None);
    };

    let loaded = load_by_kind(&mut tab.document_store, &entry.absolute_path);
    if let Err(error) = loaded {
        if forward {
            tab.navigation.go_back();
        } else {
            tab.navigation.go_forward();
        }
        return Err(OpenDocumentError::Load(error));
    }
    drop(tabs);

    vault
        .lock()
        .map_err(|_| OpenDocumentError::LockPoisoned("vault"))?
        .set_active(Some(entry.absolute_path.clone()));
    Ok(Some(entry))
}

/// Liest das Per-Typ-Setting fuer den Kind der frisch geladenen Datei
/// und wechselt den View-/Edit-Mode, wenn das Setting ein konkretes
/// Target (`view`/`edit`) fordert und der aktuelle Mode davon abweicht.
/// `current` ist No-op. Bei fehlendem Settings-Argument (Tests, die ohne
/// AppState arbeiten) ebenfalls No-op.
fn apply_default_mode(
    settings: Option<&Mutex<SettingsService>>,
    tab: &mut Tab,
    path: &str,
) -> Option<String> {
    let kind = classify(path);
    if !matches!(kind, FileKind::Markdown | FileKind::Text | FileKind::Image) {
        return None;
    }
    // Bilder kennen keinen Edit-Mode (`document_store.load_opaque` legt
    // keinen Text ab) — beim Open immer auf View zwingen, ohne ueber
    // ein Setting zu gehen. Damit landet der User auch dann auf der
    // Bild-Vorschau, wenn er vorher im Edit-Mode auf einer .md-Datei war.
    if matches!(kind, FileKind::Image) {
        if tab.view_mode == "view" {
            return None;
        }
        tab.view_mode = "view".to_string();
        tab.navigation.update_view_mode("view");
        return Some("view".to_string());
    }
    let settings = settings?;
    let data = settings.lock().ok()?.data();
    let target = match kind {
        FileKind::Markdown => data.default_mode_markdown,
        FileKind::Text => data.default_mode_text,
        _ => return None,
    };
    let target_mode = match target {
        DefaultViewMode::View => "view",
        DefaultViewMode::Edit => "edit",
        DefaultViewMode::Current => return None,
    };
    if tab.view_mode == target_mode {
        return None;
    }
    tab.view_mode = target_mode.to_string();
    tab.navigation.update_view_mode(target_mode);
    Some(target_mode.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_components() -> (Mutex<TabManager>, Mutex<Vault>) {
        (Mutex::new(TabManager::new()), Mutex::new(Vault::new()))
    }

    fn write_doc(temp: &TempDir, name: &str, body: &str) -> String {
        let path = temp.path().join(name);
        fs::write(&path, body).unwrap();
        // Normalisiert wie der Service-Eingang — die Assertions unten
        // vergleichen gegen Store-/Nav-Pfade, die immer Forward-Slashes
        // tragen.
        path.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn open_loads_and_navigates_on_first_open() {
        let temp = TempDir::new().unwrap();
        let path = write_doc(&temp, "a.md", "hello");
        let (tabs, vault) = make_components();

        let outcome = open_inner(
            &tabs,
            &vault,
            None,
            path.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: true,
            },
        )
        .unwrap();

        assert_eq!(
            Some(path.as_str()),
            outcome.loaded.as_ref().map(|l| l.path.as_str())
        );
        assert_eq!(path, outcome.nav_entry.absolute_path);
        assert_eq!(
            path,
            tabs.lock()
                .unwrap()
                .active()
                .navigation
                .current()
                .unwrap()
                .absolute_path
        );
    }

    #[test]
    fn open_skips_load_on_same_path_with_if_path_changed() {
        let temp = TempDir::new().unwrap();
        let path = write_doc(&temp, "a.md", "hello");
        let (tabs, vault) = make_components();

        // erstes Mal: laedt
        let _ = open_inner(
            &tabs,
            &vault,
            None,
            path.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::IfPathChanged,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: true,
            },
        )
        .unwrap();

        // zweites Mal mit Anchor, gleicher Pfad: kein Load
        let outcome = open_inner(
            &tabs,
            &vault,
            None,
            path.clone(),
            OpenDocumentOptions {
                anchor: Some("foo".into()),
                reload: ReloadPolicy::IfPathChanged,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: true,
            },
        )
        .unwrap();

        assert!(
            outcome.loaded.is_none(),
            "anchor-only sprint should skip disk IO"
        );
        assert_eq!(Some("foo"), outcome.nav_entry.anchor.as_deref());
    }

    #[test]
    fn open_reloads_on_same_path_with_always_policy() {
        let temp = TempDir::new().unwrap();
        let path = write_doc(&temp, "a.md", "one");
        let (tabs, vault) = make_components();

        let _ = open_inner(
            &tabs,
            &vault,
            None,
            path.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: true,
            },
        )
        .unwrap();

        fs::write(&path, "two").unwrap();
        let outcome = open_inner(
            &tabs,
            &vault,
            None,
            path.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: true,
            },
        )
        .unwrap();

        assert_eq!(
            Some("two"),
            outcome.loaded.as_ref().map(|l| l.text.as_str())
        );
    }

    #[test]
    fn open_rejects_when_dirty_policy_is_reject_and_store_dirty() {
        let temp = TempDir::new().unwrap();
        let path_a = write_doc(&temp, "a.md", "a");
        let path_b = write_doc(&temp, "b.md", "b");
        let (tabs, vault) = make_components();

        // a laden, dirty markieren
        {
            let mut tabs = tabs.lock().unwrap();
            let store = &mut tabs.active_mut().document_store;
            store.load(&path_a).unwrap();
            store.update_text("a-modified".into());
            assert!(store.is_dirty);
        }

        let result = open_inner(
            &tabs,
            &vault,
            None,
            path_b.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Reject,
                apply_default_mode: true,
            },
        );

        assert!(matches!(result, Err(OpenDocumentError::DirtyRejected)));
        // store soll unangetastet bleiben — keine History-Mutation
        let tabs = tabs.lock().unwrap();
        assert_eq!(
            Some(path_a.as_str()),
            tabs.active().document_store.path.as_deref()
        );
        assert!(tabs.active().navigation.current().is_none());
    }

    #[test]
    fn open_discards_dirty_when_policy_is_discard() {
        let temp = TempDir::new().unwrap();
        let path_a = write_doc(&temp, "a.md", "a");
        let path_b = write_doc(&temp, "b.md", "b");
        let (tabs, vault) = make_components();

        {
            let mut tabs = tabs.lock().unwrap();
            let store = &mut tabs.active_mut().document_store;
            store.load(&path_a).unwrap();
            store.update_text("a-modified".into());
        }

        let outcome = open_inner(
            &tabs,
            &vault,
            None,
            path_b.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: true,
            },
        )
        .unwrap();

        assert_eq!(
            Some(path_b.as_str()),
            outcome.loaded.as_ref().map(|l| l.path.as_str())
        );
        assert!(!tabs.lock().unwrap().active().document_store.is_dirty);
    }

    fn write_image(temp: &TempDir, name: &str) -> String {
        // Bewusst invalides UTF-8 — ein Text-Load wuerde daran scheitern.
        let path = temp.path().join(name);
        fs::write(&path, b"\x89PNG\r\n\x1a\n\xff\xfe\x00binary").unwrap();
        path.to_string_lossy().replace('\\', "/")
    }

    #[cfg(windows)]
    #[test]
    fn open_normalizes_backslash_paths() {
        let temp = TempDir::new().unwrap();
        let normalized = write_doc(&temp, "a.md", "x");
        let backslashed = normalized.replace('/', "\\");
        let (tabs, vault) = make_components();

        let outcome = open_inner(
            &tabs,
            &vault,
            None,
            backslashed,
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: false,
            },
        )
        .unwrap();

        assert_eq!(normalized, outcome.nav_entry.absolute_path);
        assert_eq!(
            Some(normalized.as_str()),
            tabs.lock().unwrap().active().document_store.path.as_deref()
        );
    }

    #[test]
    fn load_by_kind_loads_images_opaque() {
        let temp = TempDir::new().unwrap();
        let path = write_image(&temp, "pic.png");
        let (tabs, _) = make_components();

        let loaded =
            load_by_kind(&mut tabs.lock().unwrap().active_mut().document_store, &path).unwrap();

        assert_eq!(path, loaded.path);
        assert_eq!("", loaded.text);
    }

    #[test]
    fn history_view_mode_keeps_markdown_and_html_clamps_rest() {
        assert_eq!("split", history_view_mode("/notes.md", "split"));
        assert_eq!("view", history_view_mode("/page.html", "view"));
        assert_eq!("view", history_view_mode("/pic.png", "edit"));
        assert_eq!("edit", history_view_mode("/data.json", "view"));
    }

    #[test]
    fn move_history_back_over_image_loads_opaque() {
        let temp = TempDir::new().unwrap();
        let doc = write_doc(&temp, "a.md", "hello");
        let img = write_image(&temp, "pic.png");
        let (tabs, vault) = make_components();

        {
            let mut tabs = tabs.lock().unwrap();
            let tab = tabs.active_mut();
            tab.document_store.load(&doc).unwrap();
            tab.navigation.navigate(doc.clone(), None);
            tab.document_store.load_opaque(&img).unwrap();
            tab.navigation.navigate(img.clone(), None);
        }

        let back = move_history(&tabs, &vault, false).unwrap().unwrap();
        assert_eq!(doc, back.absolute_path);
        assert_eq!("hello", tabs.lock().unwrap().active().document_store.text);

        // Forward zurueck aufs Bild: kein UTF-8-Fehler, Pfad gesetzt,
        // kein Text im Store.
        let fwd = move_history(&tabs, &vault, true).unwrap().unwrap();
        assert_eq!(img, fwd.absolute_path);
        let tabs = tabs.lock().unwrap();
        assert_eq!(
            Some(img.as_str()),
            tabs.active().document_store.path.as_deref()
        );
        assert_eq!("", tabs.active().document_store.text);
    }

    #[test]
    fn move_history_rolls_back_index_when_load_fails() {
        let temp = TempDir::new().unwrap();
        let doc = write_doc(&temp, "b.md", "current");
        let missing = temp.path().join("gone.md").to_string_lossy().into_owned();
        let (tabs, vault) = make_components();

        {
            let mut tabs = tabs.lock().unwrap();
            let tab = tabs.active_mut();
            tab.navigation.navigate(missing.clone(), None);
            tab.document_store.load(&doc).unwrap();
            tab.navigation.navigate(doc.clone(), None);
        }

        let result = move_history(&tabs, &vault, false);

        assert!(matches!(result, Err(OpenDocumentError::Load(_))));
        // Index ist zurueckgerollt: current zeigt weiter aufs geladene
        // Dokument, der Store ist unangetastet.
        let tabs = tabs.lock().unwrap();
        let tab = tabs.active();
        assert_eq!(doc, tab.navigation.current().unwrap().absolute_path);
        assert!(tab.navigation.can_go_back());
        assert_eq!(Some(doc.as_str()), tab.document_store.path.as_deref());
    }

    #[test]
    fn move_history_returns_none_at_stack_edge() {
        let temp = TempDir::new().unwrap();
        let doc = write_doc(&temp, "a.md", "hello");
        let (tabs, vault) = make_components();

        tabs.lock()
            .unwrap()
            .active_mut()
            .navigation
            .navigate(doc.clone(), None);

        assert!(move_history(&tabs, &vault, false).unwrap().is_none());
        assert!(move_history(&tabs, &vault, true).unwrap().is_none());
    }
}
