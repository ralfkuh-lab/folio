//! Vault-Volltextsuche — Command-Layer (Spec-Entscheidung 5).
//!
//! `vault_search_start` löst den Scope gegen die angepinnten Einträge auf und
//! startet den Suchkern (`crate::search`) in einem `spawn_blocking`-Task.
//! Treffer werden gebündelt pro Datei als `search:hits`-Event gestreamt, der
//! Abschluss als `search:done` (mit `runId`-Korrelation). `vault_search_cancel`
//! setzt das kooperative Abbruch-Flag des Laufs.
//!
//! Die reine Suchlogik bleibt in `search.rs` (ohne Tauri-/State-Bezug); hier
//! liegt nur die Verdrahtung mit Workspace-Pins, State-Registry und Events.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::search::{
    self, BufferDoc, BufferSource, ExtendedSearchOptions, FileFilter, FileResult, SearchError,
    SearchOptions, SearchRoots, SearchScope, SearchScopeEx,
};
use crate::state::AppState;
use crate::tab_manager::Tab;

/// Löst den Such-Umfang aus den angepinnten Workspace-Einträgen auf.
/// `scope` = `Some(pfad)` → Ordner-Scope, `None` → gesamter Vault.
fn resolve_roots(state: &AppState, scope: Option<String>) -> Result<SearchRoots, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let scope = match scope {
        Some(path) => SearchScope::Folder(path),
        None => SearchScope::Vault,
    };
    Ok(search::resolve_search_scope(workspace.pinned(), &scope))
}

/// Snapshot der offenen Tabs für den OpenTabs-Scope. Lockt **nur** `state.tabs`,
/// klont pro Tab Pfad (+ ggf. Text) und gibt den Lock vor jeglichem IO/
/// `spawn_blocking` frei (keine zyklische Lock-Reihenfolge; der O(Puffergröße)-
/// Klon unter Lock ist bewusst akzeptiert). Geladener textueller Store →
/// [`BufferSource::InMemory`] (unabhängig von Textleere); opaque Stores →
/// [`BufferSource::OnDisk`] (via `is_opaque()`, kein Datei-Sniff);
/// `pending_path`-Tabs → [`BufferSource::OnDisk`]. Dedup über normalisierte
/// Pfade; leere Container-Tabs fallen raus. Wird von Tauri-Command **und**
/// Automation-Handler genutzt.
pub(crate) fn snapshot_open_tab_docs(state: &AppState) -> Result<Vec<BufferDoc>, String> {
    let tabs = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned".to_string())?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut docs: Vec<BufferDoc> = Vec::new();
    for tab in tabs.tabs() {
        let Some(doc) = buffer_doc_for_tab(tab) else {
            continue; // leerer Container-Tab
        };
        if seen.insert(doc.path.clone()) {
            docs.push(doc);
        }
    }
    Ok(docs)
}

/// Opaque-/pending-/Textleere-Auswahl für einen einzelnen Tab. Aus
/// [`snapshot_open_tab_docs`] ausgelagert, damit dieser Kern ohne `AppState`
/// (der im Unit-Test nicht konstruierbar ist) direkt testbar ist; der Helper
/// delegiert und ergänzt nur Lock + Pfad-Dedup. Geladener textueller Store →
/// [`BufferSource::InMemory`] **unabhängig von Textleere** (ein geleerter
/// Markdown-/Text-Puffer bleibt `InMemory("")` und fällt nicht auf den Disk-
/// Inhalt zurück); opaque Stores → [`BufferSource::OnDisk`] (via
/// `is_opaque()`, nicht über Disk-Inhalt oder Endung); `pending_path`-Tabs →
/// [`BufferSource::OnDisk`]; ein leerer Container-Tab liefert `None`.
fn buffer_doc_for_tab(tab: &Tab) -> Option<BufferDoc> {
    if let Some(p) = tab.document_store.path.as_deref() {
        let norm = p.replace('\\', "/");
        let store = &tab.document_store;
        let source = if store.is_opaque() {
            BufferSource::OnDisk
        } else {
            BufferSource::InMemory(store.text.clone())
        };
        return Some(BufferDoc { path: norm, source });
    }
    tab.pending_path().map(|p| BufferDoc {
        path: p.replace('\\', "/"),
        source: BufferSource::OnDisk,
    })
}

/// Abwärtskompatibilität der beiden Such-Opt-ins: Ältere Aufrufer (Tauri-Command,
/// HTTP) kannten nur `includeHidden` — damals schaltete EIN Flag versteckte UND
/// ignorierte Dateien frei. Fehlt `includeIgnored`, erbt es daher dessen Wert;
/// ist es explizit gesetzt, gilt es unabhängig. Einzige Quelle für diese Regel.
pub(crate) fn resolve_include_ignored(include_hidden: bool, include_ignored: Option<bool>) -> bool {
    include_ignored.unwrap_or(include_hidden)
}

/// Baut aus den flachen Grenz-Argumenten das erweiterte Scope-Modell + die
/// erweiterten Optionen. Geteilt zwischen Tauri-Command und HTTP-Handler
/// (dort mit der eigenen Fehler-in-400-Abbildung). Fehler sind lokalisierte
/// [`SearchError`] (Scope-Konflikt zwischen openTabs/scope/files, ungültige
/// Dateiliste, unbekannter Filter, leere Custom-Liste, verbotene
/// Endungszeichen).
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_scope_and_options(
    scope: Option<String>,
    open_tabs: bool,
    files: Option<Vec<String>>,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    file_filter: &str,
    custom_extensions: &str,
    include_hidden: bool,
    include_ignored: bool,
) -> Result<(SearchScopeEx, ExtendedSearchOptions), SearchError> {
    let scope_ex = search::to_scope_ex(scope, open_tabs, files)?;
    let filter = FileFilter::from_raw(file_filter, custom_extensions)?;
    let options = ExtendedSearchOptions {
        base: SearchOptions {
            case_sensitive,
            whole_word,
            include_hidden,
            include_ignored,
        },
        regex,
        filter,
    };
    Ok((scope_ex, options))
}

/// Zu durchsuchendes Ziel eines Laufs.
enum SearchWork {
    Roots(SearchRoots),
    Buffers(Vec<BufferDoc>),
}

/// Dateilisten-Scope („Gefilterte Dateien“) → Puffer-Dokumente von Platte.
/// Läuft damit über [`search::run_search_buffers`] (Dateityp-Filter, Dedup,
/// Caps, Content-Gate); fehlende/unlesbare Dateien werden dort übersprungen.
pub(crate) fn file_list_docs(files: Vec<String>) -> Vec<BufferDoc> {
    files
        .into_iter()
        .map(|path| BufferDoc {
            path,
            source: BufferSource::OnDisk,
        })
        .collect()
}

/// Startet einen Suchlauf. Liefert die `runId`, über die Events und Cancel
/// korrelieren. Vorab-Fehler (zu kurzer Begriff, ungültiges Regex, unbekannter
/// Filter, nicht existenter Ordner-Scope, …) kommen synchron als `Err(String)`
/// zurück. Die neuen S4-Parameter sind optional, damit die App zwischen
/// Backend- und Frontend-Etappe lauffähig bleibt (alter Aufrufer sendet nur
/// query/scope/caseSensitive/wholeWord → altes Verhalten: kein Regex, AllText,
/// Vault-Scope).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn vault_search_start(
    query: String,
    scope: Option<String>,
    open_tabs: Option<bool>,
    files: Option<Vec<String>>,
    case_sensitive: bool,
    whole_word: bool,
    regex: Option<bool>,
    file_filter: Option<String>,
    custom_extensions: Option<String>,
    include_hidden: Option<bool>,
    include_ignored: Option<bool>,
    state: State<'_, AppState>,
    handle: AppHandle,
) -> Result<u64, String> {
    let open_tabs = open_tabs.unwrap_or(false);
    let regex = regex.unwrap_or(false);
    let file_filter = file_filter.unwrap_or_else(|| "allText".to_string());
    let custom_extensions = custom_extensions.unwrap_or_default();
    let include_hidden = include_hidden.unwrap_or(false);
    let include_ignored = resolve_include_ignored(include_hidden, include_ignored);

    let (scope_ex, options) = build_scope_and_options(
        scope,
        open_tabs,
        files,
        case_sensitive,
        whole_word,
        regex,
        &file_filter,
        &custom_extensions,
        include_hidden,
        include_ignored,
    )
    .map_err(|error| error.to_string())?;

    // Query-Validierung roots-frei (QueryTooShort/InvalidPattern/RegexWholeWord)
    // synchron beim Aufrufer, ohne `scope:`-Präfix.
    search::validate_query_ex(&query, &options).map_err(|error| error.to_string())?;

    let work = match scope_ex {
        SearchScopeEx::OpenTabs => SearchWork::Buffers(snapshot_open_tab_docs(&state)?),
        SearchScopeEx::Files(files) => SearchWork::Buffers(file_list_docs(files)),
        SearchScopeEx::Vault => SearchWork::Roots(resolve_roots(&state, None)?),
        SearchScopeEx::Folder(path) => {
            let roots = resolve_roots(&state, Some(path))?;
            // Scope-Fehler (toter/relativer Ordner) bekommen ein stabiles
            // `scope:`-Präfix, das das Frontend parst, um NUR dann auf die
            // Vault-weite Suche zurückzufallen und den Chip zu entfernen.
            search::validate_roots(&roots).map_err(|error| match error {
                SearchError::RootNotFound(_) | SearchError::InvalidScope(_) => {
                    format!("scope:{error}")
                }
                other => other.to_string(),
            })?;
            SearchWork::Roots(roots)
        }
    };

    let run_id = state.search_run_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut cancels = state
            .search_cancels
            .lock()
            .map_err(|_| "search cancels lock poisoned".to_string())?;
        cancels.insert(run_id, cancel.clone());
    }

    tracing::debug!(
        target: "folio::search",
        run_id,
        open_tabs,
        case_sensitive,
        whole_word,
        regex,
        "vault search started"
    );

    let handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // RAII-Guard: räumt die Registry beim Verlassen des Tasks IMMER auf und
        // emittiert bei abnormalem Exit (Panic ohne reguläres `search:done`) ein
        // Error-`search:done`, damit das Frontend nie ewig auf den Lauf wartet.
        let mut guard = SearchRunGuard {
            handle: handle.clone(),
            run_id,
            completed: false,
        };
        let mut on_file = |file: FileResult| {
            let _ = handle.emit(
                "search:hits",
                serde_json::json!({ "runId": run_id, "files": [file] }),
            );
        };
        let result = match &work {
            SearchWork::Roots(roots) => {
                // S6: Verzeichnis-Scopes (Vault/Folder) laufen parallel.
                search::run_search_parallel(roots, &query, &options, &cancel, &mut on_file)
            }
            SearchWork::Buffers(docs) => {
                search::run_search_buffers(docs, &query, &options, &cancel, &mut on_file)
            }
        };
        match result {
            Ok(stats) => {
                let _ = handle.emit(
                    "search:done",
                    serde_json::json!({ "runId": run_id, "stats": stats }),
                );
            }
            Err(error) => {
                let _ = handle.emit(
                    "search:done",
                    serde_json::json!({ "runId": run_id, "error": error.to_string() }),
                );
            }
        }
        guard.completed = true;
    });

    Ok(run_id)
}

/// Roots-freie Dialog-Vorabprüfung (Query + Optionen + Filter) vor dem Submit.
/// Synchron; liefert `Err(String)` mit lokalisiertem Fehler für die Fehlerzeile
/// im Dialog. Die neuen Parameter sind optional (alte Aufrufer-Kompatibilität).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn vault_search_validate(
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: Option<bool>,
    file_filter: Option<String>,
    custom_extensions: Option<String>,
    include_hidden: Option<bool>,
    include_ignored: Option<bool>,
) -> Result<(), String> {
    let regex = regex.unwrap_or(false);
    let file_filter = file_filter.unwrap_or_else(|| "allText".to_string());
    let custom_extensions = custom_extensions.unwrap_or_default();
    // include_hidden/include_ignored steuern nur den Walk-Filter, nicht die
    // Query-Validierung.
    let include_hidden = include_hidden.unwrap_or(false);
    let include_ignored = resolve_include_ignored(include_hidden, include_ignored);
    let filter = FileFilter::from_raw(&file_filter, &custom_extensions)
        .map_err(|error| error.to_string())?;
    let options = ExtendedSearchOptions {
        base: SearchOptions {
            case_sensitive,
            whole_word,
            include_hidden,
            include_ignored,
        },
        regex,
        filter,
    };
    search::validate_query_ex(&query, &options).map_err(|error| error.to_string())
}

struct SearchRunGuard<R: tauri::Runtime = tauri::Wry> {
    handle: tauri::AppHandle<R>,
    run_id: u64,
    completed: bool,
}

impl<R: tauri::Runtime> Drop for SearchRunGuard<R> {
    fn drop(&mut self) {
        if let Some(state) = self.handle.try_state::<AppState>() {
            if let Ok(mut cancels) = state.search_cancels.lock() {
                cancels.remove(&self.run_id);
            }
        }
        if !self.completed {
            let _ = self.handle.emit(
                "search:done",
                serde_json::json!({ "runId": self.run_id, "error": "internal error" }),
            );
            tracing::error!(
                target: "folio::search",
                run_id = self.run_id,
                "vault search task ended abnormally (panic?)"
            );
        }
    }
}

/// Bricht den Lauf mit `run_id` ab (kooperatives Flag). Unbekannte IDs sind
/// ein No-op — ein verspäteter Cancel eines längst beendeten Laufs schadet
/// nicht.
#[tauri::command]
pub async fn vault_search_cancel(run_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    let cancels = state
        .search_cancels
        .lock()
        .map_err(|_| "search cancels lock poisoned".to_string())?;
    if let Some(flag) = cancels.get(&run_id) {
        flag.store(true, Ordering::Release);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab_manager::TabManager;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    // Exerciert den echten Auswahlkern von `snapshot_open_tab_docs` (der Helper
    // delegiert an `buffer_doc_for_tab`). AppState ist im Unit-Test nicht
    // konstruierbar; die Tabs werden über die öffentliche TabManager-API gebaut.
    #[test]
    fn test_buffer_doc_for_tab_selection_by_filekind_and_pending() {
        let mut tm = TabManager::new();
        // Der beim Boot vorhandene erste Tab (id 1) ist ein leerer Container.
        let empty_id = tm.active().id;

        // Geladener, bewusst geleerter Markdown-Puffer → InMemory("") (darf
        // NICHT auf den alten Disk-Inhalt zurückfallen).
        let md_id = tm.add_tab();
        {
            let tab = tm.tab_mut(md_id).unwrap();
            tab.document_store.path = Some("/vault/a.md".to_string());
            tab.document_store.text = String::new();
        }

        // Geladener Text-Puffer mit Inhalt → InMemory(text).
        let txt_id = tm.add_tab();
        {
            let tab = tm.tab_mut(txt_id).unwrap();
            tab.document_store.path = Some("/vault/b.txt".to_string());
            tab.document_store.text = "hello".to_string();
        }

        // Session-Restore-Tab (nur pending_path, kein geladener Store) → OnDisk.
        let pending_id = tm.add_tab();
        tm.tab_mut(pending_id)
            .unwrap()
            .set_pending_path("/vault/c.md".to_string());

        // Opaque/Image-Store → OnDisk via is_opaque(), nicht über Textleere.
        let img_tmp = tempfile::TempDir::new().unwrap();
        let img_path = img_tmp.path().join("d.png");
        std::fs::write(&img_path, b"").unwrap();
        let img_path = img_path.to_str().unwrap().replace('\\', "/");
        let img_id = tm.add_tab();
        {
            let tab = tm.tab_mut(img_id).unwrap();
            tab.document_store.load_opaque(&img_path).unwrap();
        }

        assert_eq!(buffer_doc_for_tab(tm.tab(empty_id).unwrap()), None);

        let md = buffer_doc_for_tab(tm.tab(md_id).unwrap()).unwrap();
        assert_eq!(md.path, "/vault/a.md");
        assert_eq!(md.source, BufferSource::InMemory(String::new()));

        let txt = buffer_doc_for_tab(tm.tab(txt_id).unwrap()).unwrap();
        assert_eq!(txt.path, "/vault/b.txt");
        assert_eq!(txt.source, BufferSource::InMemory("hello".to_string()));

        let pending = buffer_doc_for_tab(tm.tab(pending_id).unwrap()).unwrap();
        assert_eq!(pending.path, "/vault/c.md");
        assert_eq!(pending.source, BufferSource::OnDisk);

        let img = buffer_doc_for_tab(tm.tab(img_id).unwrap()).unwrap();
        assert_eq!(img.path, img_path);
        assert_eq!(img.source, BufferSource::OnDisk);
    }

    #[test]
    fn test_buffer_doc_for_tab_keeps_dirty_inmemory_when_disk_gone_or_binary() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("untitled");
        std::fs::write(&path, b"original on disk\n").unwrap();
        let path_str = path.to_str().unwrap().replace('\\', "/");

        let mut tm = TabManager::new();
        let id = tm.add_tab();
        {
            let tab = tm.tab_mut(id).unwrap();
            tab.document_store.path = Some(path_str.clone());
            tab.document_store.text = "dirty buffer content".to_string();
            tab.document_store.is_dirty = true;
        }

        std::fs::remove_file(&path).unwrap();
        let gone = buffer_doc_for_tab(tm.tab(id).unwrap()).unwrap();
        assert_eq!(gone.path, path_str);
        assert_eq!(
            gone.source,
            BufferSource::InMemory("dirty buffer content".to_string())
        );

        std::fs::write(&path, b"\0\0\0").unwrap();
        let replaced = buffer_doc_for_tab(tm.tab(id).unwrap()).unwrap();
        assert_eq!(
            replaced.source,
            BufferSource::InMemory("dirty buffer content".to_string())
        );
    }

    // Der Persistenz-Command (`set_search_options`) prüft denselben Vertrag wie
    // Suchstart/Submit über `FileFilter::from_raw`. Hier der Kern dieses
    // Vertrags direkt: Custom-Rohtext wird nur bei aktivem `custom`-Filter
    // geparst/abgelehnt; inaktiver Rohtext (bei markdown/allText) ist folgenlos.
    #[test]
    fn test_persistence_filter_contract_matches_search() {
        // `*.md` als Custom-Rohtext bei aktivem allText → Ok (Rohtext ignoriert;
        // wird vom Command unverändert roh persistiert).
        assert!(FileFilter::from_raw("allText", "*.md").is_ok());
        // Derselbe Rohtext bei aktivem custom → Err (`*` ist verboten).
        assert!(FileFilter::from_raw("custom", "*.md").is_err());
        // Unbekannter Filterwert → Err.
        assert!(FileFilter::from_raw("bogus", "").is_err());
        // Aktiver custom-Filter mit leerer Liste → Err.
        assert!(FileFilter::from_raw("custom", "   ").is_err());
    }

    #[test]
    fn include_ignored_inherits_include_hidden_when_absent() {
        // Alter Vertrag: nur `includeHidden: true` → versteckt UND ignoriert.
        assert!(resolve_include_ignored(true, None));
        // Neuer Vertrag: explizit gesetzter Wert gewinnt.
        assert!(!resolve_include_ignored(true, Some(false)));
        assert!(resolve_include_ignored(false, Some(true)));
        // Default (beide fehlen) → beide aus.
        assert!(!resolve_include_ignored(false, None));
    }

    #[test]
    fn build_scope_and_options_forwards_both_flags() {
        let (_, options) = build_scope_and_options(
            None, false, None, false, false, false, "allText", "", true, false,
        )
        .unwrap();
        assert!(options.base.include_hidden);
        assert!(!options.base.include_ignored);
    }

    // --- Scope „Gefilterte Dateien“ (Dateiliste) ------------------------------

    /// Fixture der vorgegebenen Referenzfälle: Pin-Ordner `R`.
    fn filtered_fixture() -> (tempfile::TempDir, String) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap().replace('\\', "/");
        for (rel, text) in [
            ("notes/spec-a.md", "TODO alpha"),
            ("notes/other.md", "TODO beta"),
            (".herd/spec-b.md", "TODO gamma"),
            ("deep/x/spec-c.txt", "TODO delta"),
        ] {
            let path = tmp.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        (tmp, root)
    }

    /// Volle Kette wie im Frontend: Filtermenge über `find_by_name` (wirksames
    /// `show_hidden` wie im Command), dann Suche über die Dateilisten-Grenze.
    #[allow(clippy::too_many_arguments)]
    fn search_filtered(
        root: &str,
        query: &str,
        scope: Option<&str>,
        markdown_only: bool,
        chip_hidden: bool,
        vault_show_hidden: bool,
        file_filter: &str,
    ) -> Vec<String> {
        let pinned = vec![crate::workspace::PinnedItem {
            path: root.to_string(),
            is_directory: true,
        }];
        let opts = crate::vault::VaultListOptions {
            markdown_only,
            show_hidden: crate::vault_filter::filter_show_hidden(chip_hidden, vault_show_hidden),
        };
        let found = crate::vault_filter::find_by_name(
            &pinned,
            scope,
            query,
            opts,
            crate::vault_filter::FILTER_MAX_HITS,
            crate::vault_filter::FILTER_TIME_BUDGET,
        )
        .unwrap();
        run_files(found.files, file_filter).unwrap()
    }

    fn run_files(files: Vec<String>, file_filter: &str) -> Result<Vec<String>, SearchError> {
        let (scope_ex, options) = build_scope_and_options(
            None,
            false,
            Some(files),
            false,
            false,
            false,
            file_filter,
            "",
            false,
            false,
        )?;
        let SearchScopeEx::Files(files) = scope_ex else {
            panic!("Dateilisten-Scope erwartet");
        };
        let cancel = AtomicBool::new(false);
        let mut out: Vec<String> = Vec::new();
        search::run_search_buffers(
            &file_list_docs(files),
            "TODO",
            &options,
            &cancel,
            &mut |f| out.push(f.path),
        )?;
        out.sort();
        Ok(out)
    }

    #[test]
    fn filtered_scope_reference_cases() {
        let (_tmp, r) = filtered_fixture();
        let a = format!("{r}/notes/spec-a.md");
        let b = format!("{r}/.herd/spec-b.md");
        let c = format!("{r}/deep/x/spec-c.txt");
        let other = format!("{r}/notes/other.md");
        let mut ab_c = vec![a.clone(), c.clone()];
        ab_c.sort();

        // R1: Query `spec`, `.*` aus, `.md` aus.
        assert_eq!(
            ab_c,
            search_filtered(&r, "spec", None, false, false, true, "allText")
        );
        // R2: `.*` an → zusätzlich `.herd/spec-b.md`.
        let mut r2 = vec![a.clone(), b.clone(), c.clone()];
        r2.sort();
        assert_eq!(
            r2,
            search_filtered(&r, "spec", None, false, true, true, "allText")
        );
        // R3: `.*` an, `vaultShowHidden` aus → wie R1.
        assert_eq!(
            ab_c,
            search_filtered(&r, "spec", None, false, true, false, "allText")
        );
        // R4: `.md` an → nur spec-a.md.
        assert_eq!(
            vec![a.clone()],
            search_filtered(&r, "spec", None, true, false, true, "allText")
        );
        // R5: Dialog-Dateityp „Nur Markdown“ → nur spec-a.md.
        assert_eq!(
            vec![a.clone()],
            search_filtered(&r, "spec", None, false, false, true, "markdown")
        );
        // R6: Bereich `R/deep` + Query `spec` → nur spec-c.txt.
        let deep = format!("{r}/deep");
        assert_eq!(
            vec![c.clone()],
            search_filtered(&r, "spec", Some(&deep), false, false, true, "allText")
        );
        // R7: Bereich `R/notes` + `.md` an, Query leer → spec-a.md + other.md.
        let notes = format!("{r}/notes");
        let mut r7 = vec![other.clone(), a.clone()];
        r7.sort();
        assert_eq!(
            r7,
            search_filtered(&r, "", Some(&notes), true, false, true, "allText")
        );
    }

    #[test]
    fn filtered_scope_boundary_validation() {
        let (_tmp, r) = filtered_fixture();
        let other = format!("{r}/notes/other.md");
        let c = format!("{r}/deep/x/spec-c.txt");

        // R10: genau die übergebenen Dateien.
        let mut expected = vec![other.clone(), c.clone()];
        expected.sort();
        assert_eq!(
            expected,
            run_files(vec![other.clone(), c.clone()], "allText").unwrap()
        );

        // Leere Liste: gültig, 0 Dateien.
        let (scope_ex, options) = build_scope_and_options(
            None,
            false,
            Some(Vec::new()),
            false,
            false,
            false,
            "allText",
            "",
            false,
            false,
        )
        .unwrap();
        assert_eq!(SearchScopeEx::Files(Vec::new()), scope_ex);
        let cancel = AtomicBool::new(false);
        let stats =
            search::run_search_buffers(&[], "TODO", &options, &cancel, &mut |_| {}).unwrap();
        assert_eq!(0, stats.files_scanned);

        // Relativer Pfad → InvalidScope.
        assert!(matches!(
            run_files(vec!["notes/other.md".to_string()], "allText"),
            Err(SearchError::InvalidScope(_))
        ));

        // files + scope / files + openTabs → ScopeConflict.
        let build = |scope: Option<String>, open_tabs: bool, files: Vec<String>| {
            build_scope_and_options(
                scope,
                open_tabs,
                Some(files),
                false,
                false,
                false,
                "allText",
                "",
                false,
                false,
            )
        };
        assert!(matches!(
            build(Some(r.clone()), false, vec![other.clone()]),
            Err(SearchError::ScopeConflict)
        ));
        assert!(matches!(
            build(None, true, vec![other.clone()]),
            Err(SearchError::ScopeConflict)
        ));

        // Deckel des Vault-Filters: 500 ok, 501 → Fehler.
        let many = |n: usize| (0..n).map(|i| format!("{r}/f{i}.md")).collect::<Vec<_>>();
        assert!(build(None, false, many(crate::vault_filter::FILTER_MAX_HITS)).is_ok());
        assert!(matches!(
            build(None, false, many(crate::vault_filter::FILTER_MAX_HITS + 1)),
            Err(SearchError::TooManyFiles)
        ));

        // Nicht existierende Datei wird übersprungen, kein Abbruch.
        assert_eq!(
            vec![other.clone()],
            run_files(vec![format!("{r}/fehlt.md"), other.clone()], "allText").unwrap()
        );
    }

    #[test]
    fn test_search_run_guard_emits_internal_error_on_abnormal_drop() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let received = Arc::new(Mutex::new(None));
        let received_clone = received.clone();

        handle.listen("search:done", move |event| {
            let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            *received_clone.lock().unwrap() = Some(payload);
        });

        let guard = SearchRunGuard {
            handle: handle.clone(),
            run_id: 12345,
            completed: false,
        };

        drop(guard);

        let result = received.lock().unwrap().clone().unwrap();
        assert_eq!(result["runId"], 12345);
        assert_eq!(result["error"], "internal error");
    }
}
