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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::search::{
    self, ExtendedSearchOptions, FileFilter, FileResult, SearchError, SearchOptions, SearchRoots,
    SearchScope, SearchScopeEx,
};
use crate::state::AppState;

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
/// [`SearchError`] (Scope-Konflikt zwischen scope/files/limitToPaths/
/// limitUnderDirs, ungültige Dateiliste, relative Allowlist, unbekannter
/// Filter, leere Custom-Liste, verbotene Endungszeichen).
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_scope_and_options(
    scope: Option<String>,
    files: Option<Vec<String>>,
    limit_to_paths: Option<Vec<String>>,
    limit_under_dirs: Option<Vec<String>>,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    file_filter: &str,
    custom_extensions: &str,
    include_hidden: bool,
    include_ignored: bool,
) -> Result<(SearchScopeEx, ExtendedSearchOptions), SearchError> {
    // Der Dateilisten-Scope schneidet im Frontend selbst — zusammen mit einer
    // git-Allowlist (einem der beiden Felder) wäre die Grenze doppelt; das ist
    // ein Client-Fehler.
    if (limit_to_paths.is_some() || limit_under_dirs.is_some()) && files.is_some() {
        return Err(SearchError::ScopeConflict);
    }
    let limit_to = search::parse_limit(limit_to_paths, limit_under_dirs)?;
    let scope_ex = search::to_scope_ex(scope, files)?;
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
        limit_to,
    };
    Ok((scope_ex, options))
}

/// Zu durchsuchendes Ziel eines Laufs.
enum SearchWork {
    Roots(SearchRoots),
    /// Dateiliste („gefiltert“), läuft über [`search::run_search_files`].
    Files(Vec<String>),
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
    files: Option<Vec<String>>,
    limit_to_paths: Option<Vec<String>>,
    limit_under_dirs: Option<Vec<String>>,
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
    let regex = regex.unwrap_or(false);
    let file_filter = file_filter.unwrap_or_else(|| "allText".to_string());
    let custom_extensions = custom_extensions.unwrap_or_default();
    let include_hidden = include_hidden.unwrap_or(false);
    let include_ignored = resolve_include_ignored(include_hidden, include_ignored);

    let (scope_ex, options) = build_scope_and_options(
        scope,
        files,
        limit_to_paths,
        limit_under_dirs,
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
        SearchScopeEx::Files(files) => SearchWork::Files(files),
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
            SearchWork::Files(files) => {
                search::run_search_files(files, &query, &options, &cancel, &mut on_file)
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
        limit_to: None,
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
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

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
            None, None, None, None, false, false, false, "allText", "", true, false,
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
    fn search_filtered(
        root: &str,
        query: &str,
        scope: Option<&str>,
        markdown_only: bool,
        show_hidden: bool,
        file_filter: &str,
    ) -> Vec<String> {
        let pinned = vec![crate::workspace::PinnedItem {
            path: root.to_string(),
            is_directory: true,
        }];
        let opts = crate::vault::VaultListOptions {
            markdown_only,
            show_hidden,
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
            Some(files),
            None,
            None,
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
        search::run_search_files(&files, "TODO", &options, &cancel, &mut |f| out.push(f.path))?;
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
            search_filtered(&r, "spec", None, false, false, "allText")
        );
        // R2: `.*` an → zusätzlich `.herd/spec-b.md`.
        let mut r2 = vec![a.clone(), b.clone(), c.clone()];
        r2.sort();
        assert_eq!(
            r2,
            search_filtered(&r, "spec", None, false, true, "allText")
        );
        // R4: `.md` an → nur spec-a.md.
        assert_eq!(
            vec![a.clone()],
            search_filtered(&r, "spec", None, true, false, "allText")
        );
        // R5: Dialog-Dateityp „Nur Markdown“ → nur spec-a.md.
        assert_eq!(
            vec![a.clone()],
            search_filtered(&r, "spec", None, false, false, "markdown")
        );
        // R6: Bereich `R/deep` + Query `spec` → nur spec-c.txt.
        let deep = format!("{r}/deep");
        assert_eq!(
            vec![c.clone()],
            search_filtered(&r, "spec", Some(&deep), false, false, "allText")
        );
        // R7: Bereich `R/notes` + `.md` an, Query leer → spec-a.md + other.md.
        let notes = format!("{r}/notes");
        let mut r7 = vec![other.clone(), a.clone()];
        r7.sort();
        assert_eq!(
            r7,
            search_filtered(&r, "", Some(&notes), true, false, "allText")
        );
    }

    /// Walk-Zweig (kein Namensbegriff, kein git): Vault- bzw. Ordner-Scope
    /// über die Pins, `.md` → `markdown`, `.*` (= `vaultShowHidden`) →
    /// `include_hidden`. Spiegelt die Grenz-Argumente des Frontends.
    /// `include_ignored` ist hier an: geprüft wird die Hidden-Regel, und die
    /// Ignore-Gruppe würde sonst die Umgebung des Bauenden einlesen (liegt das
    /// Temp-Verzeichnis in einem Git-Repo, greift dessen bzw. die globale
    /// Ignore-Datei — dort steht z. B. `.herd/`).
    fn search_walk(
        root: &str,
        scope: Option<String>,
        file_filter: &str,
        hidden: bool,
    ) -> Vec<String> {
        let pinned = vec![crate::workspace::PinnedItem {
            path: root.to_string(),
            is_directory: true,
        }];
        let (scope_ex, options) = build_scope_and_options(
            scope,
            None,
            None,
            None,
            false,
            false,
            false,
            file_filter,
            "",
            hidden,
            true,
        )
        .unwrap();
        let scope = match scope_ex {
            SearchScopeEx::Vault => SearchScope::Vault,
            SearchScopeEx::Folder(path) => SearchScope::Folder(path),
            SearchScopeEx::Files(_) => panic!("Walk-Scope erwartet"),
        };
        let roots = search::resolve_search_scope(&pinned, &scope);
        let cancel = AtomicBool::new(false);
        let mut out: Vec<String> = Vec::new();
        search::run_search_parallel(&roots, "TODO", &options, &cancel, &mut |f| out.push(f.path))
            .unwrap();
        out.sort();
        out
    }

    #[test]
    fn walk_scope_reference_cases() {
        let (_tmp, r) = filtered_fixture();
        let a = format!("{r}/notes/spec-a.md");
        let b = format!("{r}/.herd/spec-b.md");
        let c = format!("{r}/deep/x/spec-c.txt");
        let other = format!("{r}/notes/other.md");
        let sorted = |mut v: Vec<String>| {
            v.sort();
            v
        };

        // F1: kein Filter, `.*` aus → alles außer `.herd/`.
        assert_eq!(
            sorted(vec![a.clone(), other.clone(), c.clone()]),
            search_walk(&r, None, "allText", false)
        );
        // F2: `.*` an → alle vier.
        assert_eq!(
            sorted(vec![a.clone(), b.clone(), other.clone(), c.clone()]),
            search_walk(&r, None, "allText", true)
        );
        // F3: `.md` an → Walk mit `markdown`.
        assert_eq!(
            sorted(vec![a.clone(), other.clone()]),
            search_walk(&r, None, "markdown", false)
        );
        // F4: Bereich `R/deep`, kein Name → Folder-Walk.
        assert_eq!(
            vec![c.clone()],
            search_walk(&r, Some(format!("{r}/deep")), "allText", false)
        );
        // F11: Bereich `R/notes` → spec-a.md + other.md.
        assert_eq!(
            sorted(vec![a.clone(), other.clone()]),
            search_walk(&r, Some(format!("{r}/notes")), "allText", false)
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
            Some(Vec::new()),
            None,
            None,
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
        let stats = search::run_search_files(&[], "TODO", &options, &cancel, &mut |_| {}).unwrap();
        assert_eq!(0, stats.files_scanned);

        // Relativer Pfad → InvalidScope.
        assert!(matches!(
            run_files(vec!["notes/other.md".to_string()], "allText"),
            Err(SearchError::InvalidScope(_))
        ));

        // files + scope → ScopeConflict.
        let build = |scope: Option<String>, files: Vec<String>| {
            build_scope_and_options(
                scope,
                Some(files),
                None,
                None,
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
            build(Some(r.clone()), vec![other.clone()]),
            Err(SearchError::ScopeConflict)
        ));

        // Deckel des Vault-Filters: 500 ok, 501 → Fehler.
        let many = |n: usize| (0..n).map(|i| format!("{r}/f{i}.md")).collect::<Vec<_>>();
        assert!(build(None, many(crate::vault_filter::FILTER_MAX_HITS)).is_ok());
        assert!(matches!(
            build(None, many(crate::vault_filter::FILTER_MAX_HITS + 1)),
            Err(SearchError::TooManyFiles)
        ));

        // Nicht existierende Datei wird übersprungen, kein Abbruch.
        assert_eq!(
            vec![other.clone()],
            run_files(vec![format!("{r}/fehlt.md"), other.clone()], "allText").unwrap()
        );
    }

    // --- git-Allowlist (`limitToPaths`/`limitUnderDirs`) — Fälle B1–B7 --------

    /// Fixture der Allowlist-Fälle: Pin-/Scope-Wurzel `R`, jede Datei mit `TODO`.
    fn limit_fixture() -> (tempfile::TempDir, String) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap().replace('\\', "/");
        for rel in [
            "a.md",
            "b.md",
            "sm/x.md",
            "neu/y.md",
            "sub/c.md",
            "sub-alt/d.md",
        ] {
            let path = tmp.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "TODO\n").unwrap();
        }
        (tmp, root)
    }

    fn pin_dir(path: &str) -> crate::workspace::PinnedItem {
        crate::workspace::PinnedItem {
            path: path.to_string(),
            is_directory: true,
        }
    }

    fn pin_file(path: &str) -> crate::workspace::PinnedItem {
        crate::workspace::PinnedItem {
            path: path.to_string(),
            is_directory: false,
        }
    }

    fn folder_roots(r: &str) -> SearchRoots {
        search::resolve_search_scope(&[], &SearchScope::Folder(r.to_string()))
    }

    /// Baut die Optionen aus den beiden Allowlist-Feldern (der Rest bleibt
    /// Default).
    fn build_limit(
        exact: Option<Vec<String>>,
        under: Option<Vec<String>>,
    ) -> ExtendedSearchOptions {
        let (_, options) = build_scope_and_options(
            None, None, exact, under, false, false, false, "allText", "", false, false,
        )
        .unwrap();
        options
    }

    fn run_limit(roots: &SearchRoots, opts: &ExtendedSearchOptions, parallel: bool) -> Vec<String> {
        let cancel = AtomicBool::new(false);
        let mut out: Vec<String> = Vec::new();
        if parallel {
            search::run_search_parallel(roots, "TODO", opts, &cancel, &mut |f| out.push(f.path))
                .unwrap();
        } else {
            search::run_search_ex(roots, "TODO", opts, &cancel, &mut |f| out.push(f.path)).unwrap();
        }
        out.sort();
        out
    }

    #[test]
    fn b1_exact_and_under_walk_sequential_parallel_folder_and_vault() {
        let (_tmp, r) = limit_fixture();
        // `R/sm` ist exakt drin (modifizierter Gitlink/Submodule-Ordner) —
        // darf seinen Inhalt aber NICHT freigeben. `R/neu` ist untrackter
        // Ordner → `under`.
        let opts = build_limit(
            Some(vec![
                format!("{r}/a.md"),
                format!("{r}/sm"),
                format!("{r}/neu"),
            ]),
            Some(vec![format!("{r}/neu")]),
        );
        let mut expected = vec![format!("{r}/a.md"), format!("{r}/neu/y.md")];
        expected.sort();

        // Ordner-Scope: sequenziell + parallel.
        let folder = folder_roots(&r);
        assert_eq!(expected, run_limit(&folder, &opts, false));
        assert_eq!(expected, run_limit(&folder, &opts, true));

        // Vault-Scope mit `R` als Ordner-Pin: sequenziell + parallel.
        let vault = search::resolve_search_scope(&[pin_dir(&r)], &SearchScope::Vault);
        assert_eq!(expected, run_limit(&vault, &opts, false));
        assert_eq!(expected, run_limit(&vault, &opts, true));
    }

    #[test]
    fn b2_under_dir_trailing_slash() {
        let (_tmp, r) = limit_fixture();
        let opts = build_limit(None, Some(vec![format!("{r}/neu/")]));
        assert_eq!(
            vec![format!("{r}/neu/y.md")],
            run_limit(&folder_roots(&r), &opts, true)
        );
    }

    #[test]
    fn b2b_exact_has_no_ancestor_effect() {
        // `R/a.md` exakt + veralteter Eintrag `R/a.md/old.md`: `a.md` bleibt
        // zulässig (exakter Treffer), `a.md` gibt als Präfix nichts frei.
        let (_tmp, r) = limit_fixture();
        let opts = build_limit(
            Some(vec![format!("{r}/a.md"), format!("{r}/a.md/old.md")]),
            None,
        );
        assert_eq!(
            vec![format!("{r}/a.md")],
            run_limit(&folder_roots(&r), &opts, true)
        );
    }

    #[test]
    fn b3_empty_limit_is_valid_zero_files() {
        let (_tmp, r) = limit_fixture();
        for opts in [
            build_limit(Some(Vec::new()), Some(Vec::new())),
            build_limit(Some(Vec::new()), None),
            build_limit(None, Some(Vec::new())),
        ] {
            let cancel = AtomicBool::new(false);
            let mut files: Vec<FileResult> = Vec::new();
            let stats =
                search::run_search_parallel(&folder_roots(&r), "TODO", &opts, &cancel, &mut |f| {
                    files.push(f)
                })
                .unwrap();
            assert!(files.is_empty());
            assert_eq!(0, stats.files_scanned);
            assert_eq!(0, stats.hits);
            assert!(!stats.truncated);
        }
    }

    #[test]
    fn b4_relative_entry_is_invalid_scope() {
        for (exact, under) in [
            (Some(vec!["relativ/a.md".to_string()]), None),
            (None, Some(vec!["relativ/ordner".to_string()])),
        ] {
            let err = build_scope_and_options(
                None, None, exact, under, false, false, false, "allText", "", false, false,
            )
            .unwrap_err();
            assert!(matches!(err, SearchError::InvalidScope(_)));
        }
    }

    #[test]
    fn b5_limit_with_files_conflicts() {
        let file = "/repo/a.md".to_string();
        for (exact, under) in [
            (Some(vec![file.clone()]), None),
            (None, Some(vec!["/repo/ordner".to_string()])),
        ] {
            let err = build_scope_and_options(
                None,
                Some(vec![file.clone()]),
                exact,
                under,
                false,
                false,
                false,
                "allText",
                "",
                false,
                false,
            )
            .unwrap_err();
            assert!(matches!(err, SearchError::ScopeConflict));
        }
    }

    #[test]
    fn b6_limit_deckels_only_allowed_files() {
        // Der eigentliche Bug: 600 nicht geänderte Dateien füllten den
        // globalen Deckel (500), bevor die eine geänderte Datei drankam.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap().replace('\\', "/");
        for i in 0..600 {
            std::fs::write(tmp.path().join(format!("n{i:03}.md")), "TODO\n").unwrap();
        }
        std::fs::write(tmp.path().join("z.md"), "TODO\n").unwrap();

        let opts = build_limit(Some(vec![format!("{root}/z.md")]), None);
        let cancel = AtomicBool::new(false);
        let mut files: Vec<FileResult> = Vec::new();
        let stats =
            search::run_search_parallel(&folder_roots(&root), "TODO", &opts, &cancel, &mut |f| {
                files.push(f)
            })
            .unwrap();
        let names: Vec<String> = files.iter().map(|f| f.file_name.clone()).collect();
        assert_eq!(vec!["z.md".to_string()], names);
        assert!(!stats.truncated, "kein stiller Wegfall");
    }

    #[test]
    fn b7_limit_excludes_file_pin() {
        let (_tmp, r) = limit_fixture();
        let opts = build_limit(None, Some(vec![format!("{r}/sub")]));
        let vault = search::resolve_search_scope(
            &[pin_file(&format!("{r}/b.md")), pin_dir(&format!("{r}/sub"))],
            &SearchScope::Vault,
        );
        assert_eq!(
            vec![format!("{r}/sub/c.md")],
            run_limit(&vault, &opts, true)
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
