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
use crate::navigation::{Entry as NavigationEntry, NavigationController};
use crate::state::AppState;
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
}

#[derive(Debug)]
pub struct OpenDocumentOutcome {
    /// `Some` wenn tatsaechlich von Disk geladen wurde, `None` beim
    /// Anker-only-Sprung (gleicher Pfad bei `ReloadPolicy::IfPathChanged`).
    pub loaded: Option<LoadedDocument>,
    pub nav_entry: NavigationEntry,
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
        &state.document_store,
        &state.navigation,
        &state.vault,
        path,
        options,
    )
}

fn open_inner(
    document_store: &Mutex<DocumentStore>,
    navigation: &Mutex<NavigationController>,
    vault: &Mutex<Vault>,
    path: String,
    options: OpenDocumentOptions,
) -> Result<OpenDocumentOutcome, OpenDocumentError> {
    let (needs_load, is_dirty) = {
        let store = document_store
            .lock()
            .map_err(|_| OpenDocumentError::LockPoisoned("document store"))?;
        let needs_load = match options.reload {
            ReloadPolicy::Always => true,
            ReloadPolicy::IfPathChanged => store.path.as_deref() != Some(path.as_str()),
        };
        (needs_load, store.is_dirty)
    };

    let loaded = if needs_load {
        if options.dirty == DirtyPolicy::Reject && is_dirty {
            return Err(OpenDocumentError::DirtyRejected);
        }
        let loaded = document_store
            .lock()
            .map_err(|_| OpenDocumentError::LockPoisoned("document store"))?
            .load(&path)
            .map_err(OpenDocumentError::Load)?;
        Some(loaded)
    } else {
        None
    };

    let nav_entry = navigation
        .lock()
        .map_err(|_| OpenDocumentError::LockPoisoned("navigation"))?
        .navigate(path.clone(), options.anchor)
        .clone();

    if needs_load {
        vault
            .lock()
            .map_err(|_| OpenDocumentError::LockPoisoned("vault"))?
            .set_active(Some(path));
    }

    Ok(OpenDocumentOutcome { loaded, nav_entry })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_components() -> (
        Mutex<DocumentStore>,
        Mutex<NavigationController>,
        Mutex<Vault>,
    ) {
        (
            Mutex::new(DocumentStore::new()),
            Mutex::new(NavigationController::new()),
            Mutex::new(Vault::new()),
        )
    }

    fn write_doc(temp: &TempDir, name: &str, body: &str) -> String {
        let path = temp.path().join(name);
        fs::write(&path, body).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn open_loads_and_navigates_on_first_open() {
        let temp = TempDir::new().unwrap();
        let path = write_doc(&temp, "a.md", "hello");
        let (store, nav, vault) = make_components();

        let outcome = open_inner(
            &store,
            &nav,
            &vault,
            path.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
            },
        )
        .unwrap();

        assert_eq!(
            Some(path.as_str()),
            outcome.loaded.as_ref().map(|l| l.path.as_str())
        );
        assert_eq!(path, outcome.nav_entry.absolute_path);
        assert_eq!(path, nav.lock().unwrap().current().unwrap().absolute_path);
    }

    #[test]
    fn open_skips_load_on_same_path_with_if_path_changed() {
        let temp = TempDir::new().unwrap();
        let path = write_doc(&temp, "a.md", "hello");
        let (store, nav, vault) = make_components();

        // erstes Mal: laedt
        let _ = open_inner(
            &store,
            &nav,
            &vault,
            path.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::IfPathChanged,
                dirty: DirtyPolicy::Discard,
            },
        )
        .unwrap();

        // zweites Mal mit Anchor, gleicher Pfad: kein Load
        let outcome = open_inner(
            &store,
            &nav,
            &vault,
            path.clone(),
            OpenDocumentOptions {
                anchor: Some("foo".into()),
                reload: ReloadPolicy::IfPathChanged,
                dirty: DirtyPolicy::Discard,
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
        let (store, nav, vault) = make_components();

        let _ = open_inner(
            &store,
            &nav,
            &vault,
            path.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
            },
        )
        .unwrap();

        fs::write(&path, "two").unwrap();
        let outcome = open_inner(
            &store,
            &nav,
            &vault,
            path.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
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
        let (store, nav, vault) = make_components();

        // a laden, dirty markieren
        store.lock().unwrap().load(&path_a).unwrap();
        store.lock().unwrap().update_text("a-modified".into());
        assert!(store.lock().unwrap().is_dirty);

        let result = open_inner(
            &store,
            &nav,
            &vault,
            path_b.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Reject,
            },
        );

        assert!(matches!(result, Err(OpenDocumentError::DirtyRejected)));
        // store soll unangetastet bleiben — keine History-Mutation
        assert_eq!(Some(path_a.as_str()), store.lock().unwrap().path.as_deref());
        assert!(nav.lock().unwrap().current().is_none());
    }

    #[test]
    fn open_discards_dirty_when_policy_is_discard() {
        let temp = TempDir::new().unwrap();
        let path_a = write_doc(&temp, "a.md", "a");
        let path_b = write_doc(&temp, "b.md", "b");
        let (store, nav, vault) = make_components();

        store.lock().unwrap().load(&path_a).unwrap();
        store.lock().unwrap().update_text("a-modified".into());

        let outcome = open_inner(
            &store,
            &nav,
            &vault,
            path_b.clone(),
            OpenDocumentOptions {
                anchor: None,
                reload: ReloadPolicy::Always,
                dirty: DirtyPolicy::Discard,
            },
        )
        .unwrap();

        assert_eq!(
            Some(path_b.as_str()),
            outcome.loaded.as_ref().map(|l| l.path.as_str())
        );
        assert!(!store.lock().unwrap().is_dirty);
    }
}
