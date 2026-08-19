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

use std::path::Path;
use std::sync::Mutex;

use crate::document_store::{regular_file_size, DocumentStore, LoadedDocument};
use crate::file_kind::{classify, classify_deep, FileKind};
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

pub use crate::document_store::{MAX_ADDRESSABLE_BYTES, MAX_SAFE_INTEGER, MAX_WINDOW_BYTES};

#[derive(Debug)]
pub enum LoadError {
    Io(std::io::Error),
    TooLarge { size: u64 },
    UnsupportedType { path: String },
}

impl From<std::io::Error> for LoadError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::TooLarge { size } => write!(f, "file too large to address ({size} bytes)"),
            Self::UnsupportedType { path } => write!(f, "unsupported file type: {path}"),
        }
    }
}

impl std::error::Error for LoadError {}

fn map_load_error(error: LoadError) -> OpenDocumentError {
    match error {
        LoadError::Io(error) => OpenDocumentError::Load(error),
        LoadError::TooLarge { size } => OpenDocumentError::TooLarge { size },
        LoadError::UnsupportedType { path } => OpenDocumentError::UnsupportedType { path },
    }
}

fn file_name_detail(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
}

#[derive(Debug)]
pub enum OpenDocumentError {
    DirtyRejected,
    LockPoisoned(&'static str),
    Load(std::io::Error),
    TooLarge { size: u64 },
    UnsupportedType { path: String },
}

impl OpenDocumentError {
    pub fn user_message(&self) -> String {
        match self {
            Self::TooLarge { size } => crate::i18n::t_args(
                "errors.file.tooLargeToAddress",
                &[("detail", &size.to_string())],
            ),
            Self::UnsupportedType { path } => crate::i18n::t_args(
                "errors.file.unsupportedType",
                &[("detail", file_name_detail(path))],
            ),
            other => other.to_string(),
        }
    }
}

impl std::fmt::Display for OpenDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DirtyRejected => f.write_str("unsaved changes; dirty policy rejects open"),
            Self::LockPoisoned(name) => write!(f, "{name} lock poisoned"),
            Self::Load(error) => write!(f, "{error}"),
            Self::TooLarge { size } => write!(f, "file too large to address ({size} bytes)"),
            Self::UnsupportedType { path } => write!(f, "unsupported file type: {path}"),
        }
    }
}

impl std::error::Error for OpenDocumentError {}

impl From<OpenDocumentError> for String {
    fn from(error: OpenDocumentError) -> Self {
        error.user_message()
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

/// Laedt den beim Session-Restore nur als Pfad angelegten aktiven Tab.
/// `None` bedeutet, dass der Tab bereits geladen oder leer ist. Bis zu
/// diesem Aufruf bleibt sein DocumentStore watcher-frei.
pub fn load_active_pending(
    state: &AppState,
) -> Result<Option<OpenDocumentOutcome>, OpenDocumentError> {
    load_active_pending_inner(&state.tabs, &state.vault, Some(&state.settings))
}

fn load_active_pending_inner(
    tabs: &Mutex<TabManager>,
    vault: &Mutex<Vault>,
    settings: Option<&Mutex<SettingsService>>,
) -> Result<Option<OpenDocumentOutcome>, OpenDocumentError> {
    let mut tabs = tabs
        .lock()
        .map_err(|_| OpenDocumentError::LockPoisoned("tabs"))?;
    let loaded = tabs
        .load_active_pending(load_by_kind)
        .map_err(map_load_error)?;
    let Some(loaded) = loaded else {
        return Ok(None);
    };
    let tab = tabs.active_mut();
    let mode_override = apply_default_mode(settings, tab, &loaded.path);
    let nav_entry = tab
        .navigation
        .current()
        .expect("loading a pending tab creates its navigation entry")
        .clone();
    drop(tabs);

    vault
        .lock()
        .map_err(|_| OpenDocumentError::LockPoisoned("vault"))?
        .set_active(Some(loaded.path.clone()));

    Ok(Some(OpenDocumentOutcome {
        loaded: Some(loaded),
        nav_entry,
        mode_override,
    }))
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
        Some(load_by_kind(&mut tab.document_store, &path).map_err(map_load_error)?)
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

/// Laedt ein Dokument passend zu seinem einmal aufgeloesten FileKind.
/// `classify_deep` — nicht `classify` — damit endungslose Textdateien
/// (`INSTALL`) Text bleiben. Image und Binary gehen opaque.
pub fn load_by_kind(store: &mut DocumentStore, path: &str) -> Result<LoadedDocument, LoadError> {
    load_by_kind_limited(store, path, MAX_ADDRESSABLE_BYTES)
}

pub fn load_by_kind_limited(
    store: &mut DocumentStore,
    path: &str,
    max_bytes: u64,
) -> Result<LoadedDocument, LoadError> {
    let file_size = regular_file_size(path)?;
    if file_size > max_bytes {
        return Err(LoadError::TooLarge { size: file_size });
    }
    let same_path = store.path.as_deref() == Some(path);
    let kind = if same_path {
        store.kind().unwrap_or_else(|| classify_deep(path))
    } else {
        classify_deep(path)
    };
    match kind {
        FileKind::Image | FileKind::Binary => Ok(store.load_opaque_as(path, kind, file_size)?),
        _ => Ok(store.load_as(path, kind, true, file_size)?),
    }
}

/// View-Mode fuer einen History-Restore: Markdown und HTML behalten den
/// im Entry gespeicherten Mode (echte Preview vorhanden). Bilder und
/// Binary erzwingen `view` — Edit ist gesperrt, `load_opaque` legt
/// keinen Text ab. Alle uebrigen Text-Pfade clampen auf `edit`,
/// damit ein zuvor gespeicherter `view`-Wert beim Restore nicht in einen
/// leeren Markdown-Body fuehrt.
pub fn history_view_mode(path: &str, stored: &str) -> String {
    history_view_mode_for_kind(classify(path), path, stored)
}

pub fn history_view_mode_for_kind(kind: FileKind, path: &str, stored: &str) -> String {
    match kind {
        FileKind::Markdown => stored.to_string(),
        FileKind::Image | FileKind::Binary => "view".to_string(),
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
        return Err(map_load_error(error));
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
    let kind = tab
        .document_store
        .kind()
        .unwrap_or_else(|| classify_deep(path));
    if !matches!(
        kind,
        FileKind::Markdown | FileKind::Text | FileKind::Image | FileKind::Binary
    ) {
        return None;
    }
    // Opaque-Kinds kennen keinen Edit-Mode (`load_opaque` legt keinen
    // Text ab) — beim Open immer auf View zwingen.
    if matches!(kind, FileKind::Image | FileKind::Binary) {
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

/// Opaque-Dokumente kennen keinen Edit-/Split-Mode. Toolbar und Menü
/// bleiben die zweite Verteidigung — das Backend clampt hier.
pub fn clamp_view_mode(store: &DocumentStore, requested: &str) -> String {
    if store.is_opaque() {
        "view".to_string()
    } else {
        requested.to_string()
    }
}

/// Verwirft ungespeicherte Änderungen. Saubere opaque Dokumente sind
/// No-op (kein `load`, das das Bild in Text verwandeln würde); sonst
/// läuft der kind-bewusste Pfad [`load_by_kind`].
pub fn discard_editor_changes(store: &mut DocumentStore) -> std::io::Result<bool> {
    let Some(path) = store.path.clone() else {
        return Ok(false);
    };
    if store.is_opaque() && !store.is_dirty {
        return Ok(true);
    }
    load_by_kind(store, &path).map_err(|error| match error {
        LoadError::Io(error) => error,
        LoadError::TooLarge { size } => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("too large: {size}"),
        ),
        LoadError::UnsupportedType { path } => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unsupported file type: {path}"),
        ),
    })?;
    Ok(true)
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
    fn open_with_anchor_creates_exactly_one_history_entry() {
        // Review codex #8 / kimi #3: der new-tab-Pfad
        // (`tabs::open_with_anchor`) reicht den Anker direkt in die
        // Options durch. Frueher entstand erst `(path, None)` und danach
        // per zweitem `navigate` `(path, Some(anchor))` — ein toter
        // Zurueck-Schritt auf dieselbe Datei.
        let temp = TempDir::new().unwrap();
        let path = write_doc(&temp, "guide.md", "# Install\n");
        let (tabs, vault) = make_components();

        let outcome = open_inner(
            &tabs,
            &vault,
            None,
            path.clone(),
            OpenDocumentOptions {
                anchor: Some("install".into()),
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: true,
            },
        )
        .unwrap();

        assert_eq!(Some("install"), outcome.nav_entry.anchor.as_deref());
        let tabs = tabs.lock().unwrap();
        let nav = &tabs.active().navigation;
        assert_eq!(1, nav.history().len(), "{:?}", nav.history());
        assert!(!nav.can_go_back(), "kein Phantom-Eintrag davor");
        assert_eq!(Some("install"), nav.current().unwrap().anchor.as_deref());
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
            store.update_text("a-modified".into()).unwrap();
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
            store.update_text("a-modified".into()).unwrap();
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
        assert_eq!(FileKind::Image, loaded.kind);
    }

    #[test]
    fn load_by_kind_loads_binary_opaque() {
        let temp = TempDir::new().unwrap();
        let path = write_extensionless(&temp, "blob.bin", b"pre\0post");
        let (tabs, _) = make_components();

        let loaded =
            load_by_kind(&mut tabs.lock().unwrap().active_mut().document_store, &path).unwrap();

        assert_eq!(path, loaded.path);
        assert_eq!("", loaded.text);
        assert_eq!(FileKind::Binary, loaded.kind);
        assert!(tabs.lock().unwrap().active().document_store.is_opaque());
    }

    #[test]
    fn history_view_mode_keeps_markdown_and_html_clamps_rest() {
        assert_eq!("split", history_view_mode("/notes.md", "split"));
        assert_eq!("view", history_view_mode("/page.html", "view"));
        assert_eq!("view", history_view_mode("/pic.png", "edit"));
        assert_eq!("edit", history_view_mode("/data.json", "view"));
        assert_eq!(
            "view",
            history_view_mode_for_kind(FileKind::Binary, "/x.bin", "edit")
        );
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

    #[test]
    fn discard_on_text_reloads_from_disk() {
        let temp = TempDir::new().unwrap();
        let path = write_doc(&temp, "a.md", "hello");
        let mut store = DocumentStore::new();
        store.load(&path).unwrap();
        store.update_text("dirty".into()).unwrap();
        assert!(discard_editor_changes(&mut store).unwrap());
        assert_eq!("hello", store.text);
        assert!(!store.is_dirty);
        assert!(!store.is_opaque());
    }

    #[test]
    fn discard_on_opaque_keeps_flag_and_does_not_load_text() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("photo.png");
        fs::write(&path, b"\x89PNG\r\nnot-utf8").unwrap();
        let mut store = DocumentStore::new();
        store.load_opaque(path.to_str().unwrap()).unwrap();
        assert!(store.is_opaque());

        assert!(discard_editor_changes(&mut store).unwrap());
        assert!(store.is_opaque());
        assert_eq!("", store.text);
        assert!(!store.is_dirty);
    }

    #[test]
    fn clamp_view_mode_forces_view_for_opaque() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("photo.png");
        fs::write(&path, b"\x89PNG").unwrap();
        let mut store = DocumentStore::new();
        store.load_opaque(path.to_str().unwrap()).unwrap();
        assert_eq!("view", clamp_view_mode(&store, "edit"));
        assert_eq!("view", clamp_view_mode(&store, "split"));
        assert_eq!("view", clamp_view_mode(&store, "view"));
    }

    #[test]
    fn clamp_view_mode_leaves_text_documents_alone() {
        let temp = TempDir::new().unwrap();
        let path = write_doc(&temp, "a.md", "hello");
        let mut store = DocumentStore::new();
        store.load(&path).unwrap();
        assert_eq!("edit", clamp_view_mode(&store, "edit"));
        assert_eq!("split", clamp_view_mode(&store, "split"));
    }

    fn write_extensionless(temp: &TempDir, name: &str, bytes: &[u8]) -> String {
        let path = temp.path().join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().replace('\\', "/")
    }

    fn open_path(tabs: &Mutex<TabManager>, vault: &Mutex<Vault>, path: &str) {
        open_inner(
            tabs,
            vault,
            None,
            path.to_string(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn open_loads_extensionless_text_into_store() {
        let temp = TempDir::new().unwrap();
        let path = write_extensionless(&temp, "INSTALL", b"hello\n");
        let (tabs, vault) = make_components();
        open_path(&tabs, &vault, &path);
        let tabs = tabs.lock().unwrap();
        let store = &tabs.active().document_store;
        assert_eq!("hello\n", store.text);
        assert!(!store.is_opaque());
        assert_eq!(Some(FileKind::Text), store.kind());
    }

    fn assert_store_and_history_untouched(tabs: &Mutex<TabManager>, expected_path: Option<&str>) {
        let guard = tabs.lock().unwrap();
        let tab = guard.active();
        assert_eq!(expected_path, tab.document_store.path.as_deref());
        match expected_path {
            None => assert!(tab.navigation.current().is_none()),
            Some(path) => {
                assert_eq!(path, tab.navigation.current().unwrap().absolute_path)
            }
        }
    }

    #[test]
    fn open_loads_nul_binary_opaque() {
        let temp = TempDir::new().unwrap();
        let path = write_extensionless(&temp, "blob", b"pre\0post");
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
                apply_default_mode: false,
            },
        )
        .unwrap();
        let loaded = outcome.loaded.unwrap();
        assert_eq!(path, loaded.path);
        assert_eq!("", loaded.text);
        assert_eq!(FileKind::Binary, loaded.kind);
        let tabs = tabs.lock().unwrap();
        let store = &tabs.active().document_store;
        assert!(store.is_opaque());
        assert_eq!(Some(FileKind::Binary), store.kind());
    }

    #[test]
    fn pending_restore_loads_extensionless_text_and_binary() {
        let temp = TempDir::new().unwrap();
        let text_path = write_extensionless(&temp, "INSTALL", b"hello\n");
        let bin_path = write_extensionless(&temp, "blob", b"x\0y");
        let (tabs, vault) = make_components();
        tabs.lock()
            .unwrap()
            .active_mut()
            .set_pending_path(text_path.clone());
        let loaded = load_active_pending_inner(&tabs, &vault, None)
            .unwrap()
            .unwrap();
        assert_eq!("hello\n", loaded.loaded.as_ref().unwrap().text);
        assert_eq!(
            Some(FileKind::Text),
            tabs.lock().unwrap().active().document_store.kind()
        );

        {
            let mut guard = tabs.lock().unwrap();
            let tab = guard.active_mut();
            tab.document_store.close();
            tab.set_pending_path(bin_path.clone());
        }
        let loaded = load_active_pending_inner(&tabs, &vault, None)
            .unwrap()
            .unwrap();
        assert_eq!(bin_path, loaded.loaded.as_ref().unwrap().path);
        assert_eq!("", loaded.loaded.as_ref().unwrap().text);
        let guard = tabs.lock().unwrap();
        let tab = guard.active();
        assert_eq!(Some(bin_path.as_str()), tab.document_store.path.as_deref());
        assert!(tab.document_store.is_opaque());
        assert_eq!(Some(FileKind::Binary), tab.document_store.kind());
    }

    #[test]
    fn move_history_loads_extensionless_text_and_binary() {
        let temp = TempDir::new().unwrap();
        let text_path = write_extensionless(&temp, "INSTALL", b"hello\n");
        let bin_path = write_extensionless(&temp, "blob", b"x\0y");
        let (tabs, vault) = make_components();
        open_path(&tabs, &vault, &text_path);
        {
            let mut guard = tabs.lock().unwrap();
            let tab = guard.active_mut();
            tab.navigation.navigate(bin_path.clone(), None);
            tab.navigation.go_back();
        }

        let entry = move_history(&tabs, &vault, true).unwrap().unwrap();
        assert_eq!(bin_path, entry.absolute_path);
        let guard = tabs.lock().unwrap();
        let tab = guard.active();
        assert_eq!(bin_path, tab.navigation.current().unwrap().absolute_path);
        assert_eq!(Some(bin_path.as_str()), tab.document_store.path.as_deref());
        assert_eq!("", tab.document_store.text);
        assert!(tab.document_store.is_opaque());
        assert_eq!(Some(FileKind::Binary), tab.document_store.kind());
    }

    #[test]
    fn open_sniffs_extensionless_text_exactly_once() {
        crate::file_kind::reset_sniff_io_count();
        let temp = TempDir::new().unwrap();
        let path = write_extensionless(&temp, "INSTALL", b"hello\n");
        let (tabs, vault) = make_components();
        open_path(&tabs, &vault, &path);
        assert_eq!(1, crate::file_kind::sniff_io_count());
        open_path(&tabs, &vault, &path);
        assert_eq!(
            1,
            crate::file_kind::sniff_io_count(),
            "same-path reload must reuse the descriptor"
        );
    }

    #[test]
    fn existing_tab_stays_focusable_after_disk_becomes_binary() {
        crate::file_kind::reset_sniff_io_count();
        let temp = TempDir::new().unwrap();
        let path = write_extensionless(&temp, "INSTALL", b"hello\n");
        let other = write_doc(&temp, "b.md", "other");
        let (tabs, vault) = make_components();
        open_path(&tabs, &vault, &path);
        let first_id = tabs.lock().unwrap().active().id;
        tabs.lock().unwrap().add_tab();
        open_path(&tabs, &vault, &other);
        assert_eq!(1, crate::file_kind::sniff_io_count());
        fs::write(&path, b"pre\0post").unwrap();
        let found = tabs.lock().unwrap().find_by_path(&path);
        assert_eq!(Some(first_id), found);
        assert_eq!(
            Some(FileKind::Text),
            tabs.lock()
                .unwrap()
                .tab(first_id)
                .unwrap()
                .document_store
                .kind()
        );
        assert!(tabs.lock().unwrap().activate(first_id));
        open_path(&tabs, &vault, &path);
        let guard = tabs.lock().unwrap();
        let store = &guard.active().document_store;
        assert_eq!(Some(FileKind::Text), store.kind());
        assert!(!store.is_opaque());
        assert_eq!(1, crate::file_kind::sniff_io_count());
    }

    #[test]
    fn open_rejects_missing_path_without_mutating_state() {
        let temp = TempDir::new().unwrap();
        let missing = temp
            .path()
            .join("gone.md")
            .to_string_lossy()
            .replace('\\', "/");
        let (tabs, vault) = make_components();
        let err = open_inner(
            &tabs,
            &vault,
            None,
            missing,
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: false,
            },
        )
        .unwrap_err();
        assert!(matches!(err, OpenDocumentError::Load(_)));
        assert_store_and_history_untouched(&tabs, None);
    }

    #[test]
    fn open_rejects_directory_without_mutating_state() {
        let temp = TempDir::new().unwrap();
        let dir = temp.path().to_string_lossy().replace('\\', "/");
        let (tabs, vault) = make_components();
        let err = open_inner(
            &tabs,
            &vault,
            None,
            dir,
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
                apply_default_mode: false,
            },
        )
        .unwrap_err();
        assert!(matches!(err, OpenDocumentError::Load(_)));
        assert_store_and_history_untouched(&tabs, None);
    }

    #[cfg(unix)]
    #[test]
    fn open_follows_symlink_to_regular_file() {
        let temp = TempDir::new().unwrap();
        let target = write_doc(&temp, "real.md", "via-link");
        let link = temp.path().join("alias.md");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let link_path = link.to_string_lossy().replace('\\', "/");
        let (tabs, vault) = make_components();
        open_path(&tabs, &vault, &link_path);
        let guard = tabs.lock().unwrap();
        let store = &guard.active().document_store;
        assert_eq!("via-link", store.text);
        assert_eq!(Some(FileKind::Markdown), store.kind());
    }

    #[test]
    fn inactive_tab_records_grow_shrink_and_delete_before_activate() {
        let temp = TempDir::new().unwrap();
        let img = write_image(&temp, "pic.png");
        let md = write_doc(&temp, "a.md", "hello");
        let (tabs, vault) = make_components();
        open_path(&tabs, &vault, &img);
        let img_id = tabs.lock().unwrap().active().id;
        tabs.lock().unwrap().add_tab();
        open_path(&tabs, &vault, &md);
        assert!(!tabs.lock().unwrap().is_active(img_id));

        fs::write(&img, b"\x89PNG\r\n\x1a\nGROW").unwrap();
        {
            let mut guard = tabs.lock().unwrap();
            guard
                .tab_mut(img_id)
                .unwrap()
                .document_store
                .note_external_change(&img);
        }
        fs::write(&img, b"\x89").unwrap();
        {
            let mut guard = tabs.lock().unwrap();
            guard
                .tab_mut(img_id)
                .unwrap()
                .document_store
                .note_external_change(&img);
        }
        fs::remove_file(&img).unwrap();
        {
            let mut guard = tabs.lock().unwrap();
            guard
                .tab_mut(img_id)
                .unwrap()
                .document_store
                .note_external_change(&img);
        }

        assert!(tabs.lock().unwrap().activate(img_id));
        let snap = tabs.lock().unwrap().active().document_store.snapshot();
        assert_eq!(1, snap.file_size, "last addressable size before delete");
        assert!(!snap.too_large);
        assert!(snap.revision >= 3);
    }

    #[test]
    fn nav_mode_for_loaded_extensionless_text_uses_descriptor() {
        let temp = TempDir::new().unwrap();
        let path = write_extensionless(&temp, "INSTALL", b"hello\n");
        let (tabs, vault) = make_components();
        open_path(&tabs, &vault, &path);
        let guard = tabs.lock().unwrap();
        let tab = guard.active();
        let stored = tab.navigation.current().unwrap().view_mode.clone();
        assert_eq!(Some(FileKind::Text), tab.document_store.kind());
        assert_eq!(
            "edit",
            history_view_mode_for_kind(FileKind::Text, &path, &stored)
        );
        assert_eq!(
            "view",
            history_view_mode(&path, &stored),
            "path classify must stay the pending-only fallback"
        );
    }

    #[test]
    fn oversized_file_is_rejected_via_limit() {
        let temp = TempDir::new().unwrap();
        let path = write_extensionless(&temp, "big", b"0123456789");
        let mut store = DocumentStore::new();
        let err = load_by_kind_limited(&mut store, &path, 9).unwrap_err();
        assert!(matches!(err, LoadError::TooLarge { size: 10 }));
        assert!(store.path.is_none());
    }
}
