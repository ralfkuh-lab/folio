//! Vault-Tree-Filter — Lazy-Bausteine und R4-Tiefenfilter.
//!
//! Der Namensfilter ist clientseitig (R3). Dieses Modul hält die
//! `dir_contains_markdown`-Probe für den Backend-Lazy-Typ-Filter sowie
//! seit R4 den opt-in Tiefenfilter (`find_by_name`): ein paralleler
//! Namens-Walk über die Pin-Wurzeln bzw. einen Ordnerbereich.
//! Spec: [`docs/spec-vault-filter.md`].

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use crate::file_kind::{classify, FileKind};
use crate::search::{resolve_scope, SearchScope};
use crate::vault::{classify_entry, VaultListOptions};
use crate::workspace::PinnedItem;

/// Treffer-Deckel des Tiefenfilters (R4): nach so vielen Datei-Treffern
/// bricht der Walk ab. `truncated` wird erst gesetzt, wenn ein WEITERER
/// Treffer ansteht — genau am Deckel ohne Extra bleibt es `false`
/// (R2-Fehler war ein Deckel auf besuchte Einträge VOR dem ersten Treffer).
pub const FILTER_MAX_HITS: usize = 500;

/// Zeitbudget des Tiefenfilters (R4).
pub const FILTER_TIME_BUDGET: Duration = Duration::from_millis(3_000);

/// Antwort von `vault_filter_find`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterFindResponse {
    /// Treffer-Dateien, Forward-Slash-normalisiert, sortiert.
    pub files: Vec<String>,
    /// Vorfahren-Ordner der Treffer, dedupliziert, flach nach Tiefe sortiert.
    pub dirs: Vec<String>,
    /// `true`, wenn Deckel oder Zeitbudget den Walk beendet haben.
    pub truncated: bool,
    /// `"cap"`, `"time"` oder `null`.
    pub reason: Option<&'static str>,
}

/// Fehler der Bereich-Validierung (`scope`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterScopeError {
    /// Der Bereich existiert nicht.
    NotFound(String),
    /// Der Bereich ist relativ oder kein Verzeichnis.
    Invalid(String),
}

impl FilterScopeError {
    /// Lokalisierte UI-Darstellung mit expliziter Translator-Instanz.
    pub fn localized(&self, tr: &crate::i18n::Translator) -> String {
        match self {
            Self::NotFound(detail) => {
                tr.t_args("errors.vault.filterScopeNotFound", &[("detail", detail)])
            }
            Self::Invalid(detail) => {
                tr.t_args("errors.vault.filterScopeInvalid", &[("detail", detail)])
            }
        }
    }

    fn key_fallback(&self) -> String {
        match self {
            Self::NotFound(detail) => format!("errors.vault.filterScopeNotFound: {detail}"),
            Self::Invalid(detail) => format!("errors.vault.filterScopeInvalid: {detail}"),
        }
    }
}

impl std::fmt::Display for FilterScopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match crate::i18n::process_translator() {
            Some(tr) => self.localized(tr),
            None => self.key_fallback(),
        };
        f.write_str(&message)
    }
}

impl std::error::Error for FilterScopeError {}

fn normalize_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// `true`, wenn `path` selbst ein Symlink ist (kein Folgen).
fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Konfiguriert den Walk fuer den Tiefenfilter: **kein** Gitignore
/// (der Baum zeigt ignorierte Dateien gedimmt — der Filter darf nichts
/// verschweigen) und `.git` immer draussen. Versteckte Eintraege werden
/// bewusst NICHT ueber `.hidden()` verworfen, sondern im Visitor (K5): nur
/// so sieht die Zeitpruefung jeden Eintrag. Symlink-Verzeichnisse werden
/// nicht betreten (`follow_links` bleibt der Crate-Default `false`).
fn configure_filter_builder(builder: &mut WalkBuilder) {
    builder
        .standard_filters(false)
        .filter_entry(|entry| entry.file_name() != OsStr::new(".git"));
}

enum FindEvent {
    Hit(PathBuf, PathBuf),
    TimedOut,
}

#[allow(clippy::too_many_arguments)]
fn visit_entry(
    result: Result<ignore::DirEntry, ignore::Error>,
    query_lower: &str,
    markdown_only: bool,
    show_hidden: bool,
    stop: &AtomicBool,
    tx: &mpsc::Sender<FindEvent>,
    anchor: &Path,
    start: Instant,
    time_budget: Duration,
) -> WalkState {
    if stop.load(Ordering::Relaxed) {
        return WalkState::Quit;
    }
    if start.elapsed() >= time_budget {
        let _ = tx.send(FindEvent::TimedOut);
        stop.store(true, Ordering::Relaxed);
        return WalkState::Quit;
    }
    let entry = match result {
        Ok(entry) => entry,
        Err(_) => return WalkState::Continue,
    };
    let file_type = match entry.file_type() {
        Some(ft) => ft,
        None => return WalkState::Continue,
    };
    // Hidden-Filter erst hier: die Deadline oben muss jeden Eintrag sehen.
    // Die Walk-Wurzel (depth 0) bleibt ausgenommen, damit versteckte Pin-/
    // Bereichs-Wurzeln wie im Baum sichtbar bleiben.
    if !show_hidden
        && entry.depth() > 0
        && crate::vault::is_vault_hidden_name(&entry.file_name().to_string_lossy())
    {
        return if file_type.is_dir() {
            WalkState::Skip
        } else {
            WalkState::Continue
        };
    }
    if file_type.is_symlink() {
        // Symlink-Verzeichnisse werden nicht betreten; nur ein Symlink auf
        // eine echte Datei zaehlt als Treffer.
        if !entry.path().is_file() {
            return WalkState::Continue;
        }
    } else if !file_type.is_file() {
        return WalkState::Continue;
    }
    if markdown_only && classify(&entry.path().to_string_lossy()) != FileKind::Markdown {
        return WalkState::Continue;
    }
    let name = entry.file_name().to_string_lossy().to_lowercase();
    if !name.contains(query_lower) {
        return WalkState::Continue;
    }
    let _ = tx.send(FindEvent::Hit(
        entry.path().to_path_buf(),
        anchor.to_path_buf(),
    ));
    WalkState::Continue
}

/// Paralleler Namens-Walk ueber `walk_roots` (`(root, anchor)`). Der
/// Consumer-Thread (dieser) fuehrt Trefferliste und Deckel exakt — nur so
/// ist `truncated` deterministisch (erst bei einem echten Extra-Treffer).
/// Rueckgabe: (Treffer inkl. Anker, truncated, reason).
fn collect_hits(
    walk_roots: &[(PathBuf, PathBuf)],
    query_lower: &str,
    markdown_only: bool,
    show_hidden: bool,
    cap: usize,
    time_budget: Duration,
    start: Instant,
) -> (Vec<(PathBuf, PathBuf)>, bool, Option<&'static str>) {
    let (tx, rx) = mpsc::channel::<FindEvent>();
    let stop = AtomicBool::new(false);

    let mut hits: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut truncated = false;
    let mut reason: Option<&'static str> = None;

    std::thread::scope(|scope| {
        let stop_ref = &stop;
        // `tx` wandert in den Producer-Thread: ohne das bliebe im
        // Consumer-`for event in rx` eine Sender-Instanz am Leben und der
        // Kanal schloesse nie (Deadlock bei normaler Vollstaendigkeit).
        scope.spawn(move || {
            for (root, anchor) in walk_roots {
                if stop_ref.load(Ordering::Relaxed) {
                    break;
                }
                let mut builder = WalkBuilder::new(root);
                configure_filter_builder(&mut builder);
                let root_tx = tx.clone();
                let anchor = anchor.clone();
                builder.build_parallel().run(|| {
                    let wtx = root_tx.clone();
                    let wanchor = anchor.clone();
                    Box::new(move |result| {
                        visit_entry(
                            result,
                            query_lower,
                            markdown_only,
                            show_hidden,
                            stop_ref,
                            &wtx,
                            &wanchor,
                            start,
                            time_budget,
                        )
                    })
                });
            }
        });

        for event in rx {
            match event {
                FindEvent::TimedOut => {
                    truncated = true;
                    reason = Some("time");
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
                FindEvent::Hit(path, anchor) => {
                    let norm = normalize_path(&path);
                    if !seen.insert(norm) {
                        continue;
                    }
                    if hits.len() >= cap {
                        truncated = true;
                        reason = Some("cap");
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    hits.push((path, anchor));
                }
            }
        }
    });

    (hits, truncated, reason)
}

/// Haengt `from` und alle Vorfahren bis einschliesslich `to` an `out`.
fn add_ancestor_chain(from: &Path, to: &str, out: &mut HashSet<String>) {
    let mut cur = Some(from.to_path_buf());
    while let Some(p) = cur {
        let norm = normalize_path(&p);
        out.insert(norm.clone());
        if norm == to {
            break;
        }
        cur = p.parent().map(|q| q.to_path_buf());
    }
}

/// R4-Tiefenfilter: findet Dateien, deren **Name** case-insensitive die
/// Query enthaelt, und liefert dazu deren Vorfahren-Ordner.
///
/// - `scope = None`: alle Pins ueber [`resolve_scope`] (Ordner rekursiv,
///   Datei-Pins direkt, Overlap-Dedup) — dieselbe Aufloesung wie Palette und
///   Volltextsuche.
/// - `scope = Some(dir)`: nur dieser Ordner; die Kette Pin-Wurzel → Bereich
///   kommt in `dirs` auch ohne Treffer dazu.
///
/// Gitignore wird nicht angewandt, `.git` immer uebersprungen, versteckte
/// Eintraege folgen `opts.show_hidden`, `opts.markdown_only` filtert
/// endungsbasiert. `cap` und `time_budget` sind fuer Tests injizierbar.
pub fn find_by_name(
    pinned: &[PinnedItem],
    scope: Option<&str>,
    query: &str,
    opts: VaultListOptions,
    cap: usize,
    time_budget: Duration,
) -> Result<FilterFindResponse, FilterScopeError> {
    let query_lower = query.to_lowercase();
    if query_lower.is_empty() {
        return Ok(FilterFindResponse {
            files: Vec::new(),
            dirs: Vec::new(),
            truncated: false,
            reason: None,
        });
    }

    let start = Instant::now();
    let mut dirs: HashSet<String> = HashSet::new();

    let (walk_roots, file_pins): (Vec<(PathBuf, PathBuf)>, Vec<PathBuf>) = match scope {
        Some(raw_scope) => {
            let scope_norm = raw_scope.replace('\\', "/");
            let scope_path = Path::new(&scope_norm);
            if !scope_path.is_absolute() {
                return Err(FilterScopeError::Invalid(scope_norm));
            }
            if !scope_path.exists() {
                return Err(FilterScopeError::NotFound(scope_norm));
            }
            if !scope_path.is_dir() {
                return Err(FilterScopeError::Invalid(scope_norm));
            }
            // `.git` ist als Bereich nie erlaubt — auch nicht ueber einen Pin.
            if scope_path
                .components()
                .any(|c| c.as_os_str() == OsStr::new(".git"))
            {
                return Err(FilterScopeError::Invalid(scope_norm));
            }
            // Anker = laengste Pin-Wurzel, die den Bereich enthaelt; sonst der
            // Bereich selbst. Die Kette Anker → Bereich gehoert immer in dirs.
            let anchor_pin = pinned
                .iter()
                .filter(|item| item.is_directory)
                .map(|item| item.path.replace('\\', "/"))
                .filter(|pin| crate::path_migration::is_under(&scope_norm, pin))
                .max_by_key(|pin| pin.len());
            let anchor_is_pin = anchor_pin.is_some();
            let anchor = anchor_pin.unwrap_or_else(|| scope_norm.clone());
            // Symlink-Schutz: eine exakt gepinnte Wurzel bleibt erlaubt
            // (Pin-Bypass wie in der Suche). Sonst darf weder der Bereich
            // selbst noch eine Komponente zwischen Anker und Bereich ein
            // Symlink sein — sonst wuerde der Walk ueber einen Link in einen
            // nicht sichtbaren Baum laufen.
            let pinned_root_exact = anchor_is_pin && scope_norm == anchor;
            if !pinned_root_exact {
                if is_symlink(scope_path) {
                    return Err(FilterScopeError::Invalid(scope_norm));
                }
                if anchor_is_pin {
                    if let Ok(rel) = scope_path.strip_prefix(Path::new(&anchor)) {
                        let mut cur = PathBuf::from(&anchor);
                        for comp in rel.components() {
                            cur.push(comp);
                            if is_symlink(&cur) {
                                return Err(FilterScopeError::Invalid(scope_norm));
                            }
                        }
                    }
                }
            }
            add_ancestor_chain(scope_path, &anchor, &mut dirs);
            (
                vec![(scope_path.to_path_buf(), PathBuf::from(anchor))],
                Vec::new(),
            )
        }
        None => {
            let roots = resolve_scope(pinned, &SearchScope::Vault);
            // W3-Rest: `.git`-Wurzeln (und Wurzeln unterhalb einer
            // `.git`-Komponente) werden auch ohne Bereich entfernt — der
            // Entry-Filter schuetzt nur Kind-Eintraege, nicht die Wurzel.
            // Der Symlink-Pin-Bypass (explizit gepinnte Wurzel) bleibt.
            let has_git_component =
                |p: &Path| p.components().any(|c| c.as_os_str() == OsStr::new(".git"));
            let walk_roots = roots
                .dirs
                .iter()
                .filter(|d| !has_git_component(d))
                .map(|d| (d.clone(), d.clone()))
                .collect();
            let file_pins = roots
                .files
                .iter()
                .filter(|f| !has_git_component(f))
                .cloned()
                .collect();
            (walk_roots, file_pins)
        }
    };

    let (hits, mut truncated, mut reason) = collect_hits(
        &walk_roots,
        &query_lower,
        opts.markdown_only,
        opts.show_hidden,
        cap,
        time_budget,
        start,
    );

    let mut files: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (path, anchor) in &hits {
        let norm = normalize_path(path);
        if !seen.insert(norm.clone()) {
            continue;
        }
        files.push(norm);
        if let Some(parent) = path.parent() {
            add_ancestor_chain(parent, &normalize_path(anchor), &mut dirs);
        }
    }

    // Datei-Pins: direkt matchen, ohne Vorfahren (sie sind selbst die Wurzel).
    // Die Deadline gilt auch hier (K5) — der Walk oben kann das Budget schon
    // aufgebraucht haben.
    for file in &file_pins {
        if start.elapsed() >= time_budget {
            truncated = true;
            reason = Some("time");
            break;
        }
        if !file.is_file() {
            continue;
        }
        if opts.markdown_only && classify(&file.to_string_lossy()) != FileKind::Markdown {
            continue;
        }
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !name.contains(&query_lower) {
            continue;
        }
        let norm = normalize_path(file);
        if !seen.insert(norm.clone()) {
            continue;
        }
        if files.len() >= cap {
            truncated = true;
            reason = Some("cap");
            break;
        }
        files.push(norm);
    }

    files.sort();
    let mut dir_list: Vec<String> = dirs.into_iter().collect();
    dir_list.sort_by(|a, b| {
        let da = a.split('/').count();
        let db = b.split('/').count();
        da.cmp(&db).then_with(|| a.cmp(b))
    });

    Ok(FilterFindResponse {
        files,
        dirs: dir_list,
        truncated,
        reason,
    })
}

/// Kostendeckel für [`dir_contains_markdown`]: nach so vielen
/// besuchten Einträgen bricht die Probe ab und liefert `true`.
pub const DIR_CONTAINS_MD_VISIT_CAP: usize = 2_000;

/// Rekursive Probe „enthält irgendwo Markdown?" mit Early-Exit und
/// Kostendeckel. `.git` und Link-Verzeichnisse werden übersprungen
/// (Loop-sicher ohne visited-Set).
pub fn dir_contains_markdown(dir: &Path) -> bool {
    let mut visits = 0usize;
    dir_contains_markdown_walk(dir, &mut visits)
}

fn dir_contains_markdown_walk(dir: &Path, visits: &mut usize) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return false,
    };
    for entry in entries.filter_map(Result::ok) {
        *visits += 1;
        if *visits >= DIR_CONTAINS_MD_VISIT_CAP {
            return true;
        }
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == ".git" {
            continue;
        }
        let info = classify_entry(&path);
        if info.is_directory {
            // Nicht in Link-Verzeichnisse absteigen (Symlink-Loops).
            if info.is_link {
                continue;
            }
            if dir_contains_markdown_walk(&path, visits) {
                return true;
            }
        } else if classify(&path.to_string_lossy()) == FileKind::Markdown {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn init_git(root: &Path) {
        let git = root.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    fn data_path_attr(p: &Path) -> String {
        format!(r#"data-path="{}""#, p.to_string_lossy().replace('\\', "/"))
    }

    fn norm(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn dir_contains_markdown_early_exit_cost_cap_and_git_skip() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let with_md = root.join("with_md");
        write(&with_md, "a/b/c/note.md", "# n\n");
        write(&with_md, "a/b/other.txt", "t\n");
        assert!(
            dir_contains_markdown(&with_md),
            "verschachteltes MD muss true liefern"
        );

        let only_txt = root.join("only_txt");
        write(&only_txt, "a.txt", "x\n");
        write(&only_txt, "sub/b.txt", "y\n");
        assert!(!dir_contains_markdown(&only_txt), "ohne MD → false");

        let git_only = root.join("git_only");
        init_git(&git_only);
        write(&git_only, ".git/hooks/x.md", "# g\n");
        write(&git_only, "plain.txt", "p\n");
        assert!(
            !dir_contains_markdown(&git_only),
            ".git-Inhalt darf die Probe nicht true machen"
        );

        let huge = root.join("huge");
        fs::create_dir_all(&huge).unwrap();
        for i in 0..(DIR_CONTAINS_MD_VISIT_CAP + 10) {
            fs::write(huge.join(format!("n{i:04}.txt")), b"x").unwrap();
        }
        assert!(
            dir_contains_markdown(&huge),
            "Kostendeckel muss true liefern (falsches Anzeigen harmlos)"
        );
    }

    #[test]
    fn lazy_mode_type_filter_hides_non_md_and_mdless_dirs() {
        use crate::vault::Vault;

        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "note.md", "# n\n");
        write(root, "data.json", "{}\n");
        write(root, "empty_folder/.keep", "");
        fs::create_dir(root.join("truly_empty")).unwrap();
        write(root, "md_folder/a.md", "# a\n");
        write(root, "md_folder/b.txt", "b\n");

        let vault = Vault::new();
        let path = norm(root);
        let html = vault
            .build_dir_children_html(&path, crate::vault::VaultListOptions::markdown_only(true))
            .expect("read_dir ok");

        assert!(
            html.contains(&data_path_attr(&root.join("note.md"))),
            "MD-Datei muss sichtbar sein; html={html}"
        );
        assert!(
            !html.contains(&data_path_attr(&root.join("data.json"))),
            "Non-MD-Datei muss ausgeblendet sein"
        );
        assert!(
            !html.contains(&data_path_attr(&root.join("empty_folder")))
                && !html.contains(&data_path_attr(&root.join("truly_empty"))),
            "MD-lose Ordner müssen ausgeblendet sein"
        );
        assert!(
            html.contains(&data_path_attr(&root.join("md_folder"))),
            "Ordner mit MD muss sichtbar sein"
        );
        let all = vault
            .build_dir_children_html(&path, crate::vault::VaultListOptions::default())
            .expect("read_dir ok");
        assert!(all.contains(&data_path_attr(&root.join("data.json"))));
        assert!(all.contains(&data_path_attr(&root.join("note.md"))));
    }

    #[cfg(unix)]
    #[test]
    fn dir_contains_markdown_does_not_follow_symlink_loops() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        std::os::unix::fs::symlink(&b, a.join("loop")).unwrap();
        std::os::unix::fs::symlink(&a, b.join("loop")).unwrap();
        write(root, "plain.txt", "x\n");
        assert!(
            !dir_contains_markdown(root),
            "Symlink-Loops duerfen die Probe nicht true machen ohne MD"
        );
        write(root, "note.md", "# n\n");
        assert!(dir_contains_markdown(root));
    }

    // --- R4: Tiefenfilter ---------------------------------------------------

    fn pin_dir(p: &Path) -> PinnedItem {
        PinnedItem {
            path: p.to_string_lossy().replace('\\', "/"),
            is_directory: true,
        }
    }

    fn pin_file(p: &Path) -> PinnedItem {
        PinnedItem {
            path: p.to_string_lossy().replace('\\', "/"),
            is_directory: false,
        }
    }

    /// Fixture des Referenzfalls (Spec R4): Pin `R`, versteckt, gitignoriert,
    /// Nicht-MD, Ordnername-Match, `.git` und ein Symlink-Verzeichnis.
    fn reference_fixture(root: &Path) {
        init_git(root);
        write(root, ".gitignore", "ignoriert/\n");
        write(root, "a/b/c/Ziel-Tief.md", "# z\n");
        write(root, ".versteckt/ziel-versteckt.md", "# v\n");
        write(root, "ignoriert/ziel-ignoriert.md", "# i\n");
        write(root, "andere/ziel-anders.txt", "t\n");
        write(root, "leer/nichts.md", "# n\n");
        write(root, "zielordner/x.md", "# x\n");
        write(root, ".git/ziel-in-git.md", "# g\n");
    }

    fn find(
        pinned: &[PinnedItem],
        scope: Option<&str>,
        query: &str,
        opts: VaultListOptions,
    ) -> FilterFindResponse {
        // Zeitbudget und Deckel der Produktion; nur die Spezialtests
        // ueberschreiben sie.
        find_by_name(
            pinned,
            scope,
            query,
            opts,
            FILTER_MAX_HITS,
            FILTER_TIME_BUDGET,
        )
        .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn deep_filter_reference_case() {
        // Herleitung der Erwartung aus der Spec: Treffer sind Dateien, deren
        // NAME `ziel` enthaelt — `zielordner/x.md` also NICHT (Ordnername),
        // `.git/**` nie, unter `link/` nie (Symlink-Dir). `ignoriert/` ist per
        // `.gitignore` ausgeschlossen, muss aber trotzdem erscheinen: der
        // Filter wendet Gitignore bewusst NICHT an. dirs = alle Vorfahren der
        // Treffer inkl. Pin-Wurzel R, flach nach Tiefe.
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        reference_fixture(root);
        std::os::unix::fs::symlink(root.join("a"), root.join("link")).unwrap();
        let pin = pin_dir(root);

        let res = find(&[pin], None, "ziel", VaultListOptions::default());
        let expected_files = vec![
            norm(&root.join(".versteckt/ziel-versteckt.md")),
            norm(&root.join("a/b/c/Ziel-Tief.md")),
            norm(&root.join("andere/ziel-anders.txt")),
            norm(&root.join("ignoriert/ziel-ignoriert.md")),
        ];
        assert_eq!(expected_files, res.files, "Trefferliste");
        let expected_dirs = vec![
            norm(root),
            norm(&root.join(".versteckt")),
            norm(&root.join("a")),
            norm(&root.join("andere")),
            norm(&root.join("ignoriert")),
            norm(&root.join("a/b")),
            norm(&root.join("a/b/c")),
        ];
        assert_eq!(expected_dirs, res.dirs, "Vorfahren-Ordner");
        assert!(!res.truncated);
        assert_eq!(None, res.reason);
    }

    #[test]
    fn deep_filter_hidden_and_markdown_flags() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        reference_fixture(root);
        let pin = pin_dir(root);

        let no_hidden = find(
            std::slice::from_ref(&pin),
            None,
            "ziel",
            VaultListOptions {
                markdown_only: false,
                show_hidden: false,
            },
        );
        assert!(
            !no_hidden.files.iter().any(|f| f.contains(".versteckt")),
            "hidden=aus darf .versteckt nicht liefern: {:?}",
            no_hidden.files
        );
        assert!(
            !no_hidden.dirs.iter().any(|d| d.ends_with("/.versteckt")),
            "hidden=aus darf .versteckt nicht als Ordner zeigen"
        );

        let md_only = find(
            &[pin],
            None,
            "ziel",
            VaultListOptions {
                markdown_only: true,
                show_hidden: true,
            },
        );
        assert!(
            !md_only.files.iter().any(|f| f.ends_with(".txt")),
            "md-only darf .txt nicht liefern: {:?}",
            md_only.files
        );
        assert!(
            !md_only.dirs.iter().any(|d| d.ends_with("/andere")),
            "md-only darf den Ordner ohne MD-Treffer nicht zeigen"
        );
    }

    #[test]
    fn deep_filter_scope_limits_and_includes_pin_to_scope_chain() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        reference_fixture(root);
        let pin = pin_dir(root);
        let scope = norm(&root.join("a/b"));

        let res = find(&[pin], Some(&scope), "ziel", VaultListOptions::default());
        assert_eq!(vec![norm(&root.join("a/b/c/Ziel-Tief.md"))], res.files);
        assert_eq!(
            vec![
                norm(root),
                norm(&root.join("a")),
                norm(&root.join("a/b")),
                norm(&root.join("a/b/c")),
            ],
            res.dirs,
            "Bereichskette Pin-Wurzel → Bereich muss enthalten sein"
        );
        assert!(!res.truncated);

        // Leerer Bereich: die Kette Pin-Wurzel → Bereich bleibt sichtbar.
        let empty = find(
            &[pin_dir(root)],
            Some(&norm(&root.join("leer"))),
            "ziel",
            VaultListOptions::default(),
        );
        assert!(empty.files.is_empty());
        assert_eq!(
            vec![norm(root), norm(&root.join("leer"))],
            empty.dirs,
            "leerer Bereich zeigt die Bereichskette"
        );
    }

    #[test]
    fn deep_filter_scope_errors() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "leer/nichts.md", "# n\n");
        let pin = pin_dir(root);

        let missing = find_by_name(
            std::slice::from_ref(&pin),
            Some(&norm(&root.join("gibtsnicht"))),
            "ziel",
            VaultListOptions::default(),
            FILTER_MAX_HITS,
            FILTER_TIME_BUDGET,
        )
        .unwrap_err();
        assert!(matches!(missing, FilterScopeError::NotFound(_)));

        let relative = find_by_name(
            std::slice::from_ref(&pin),
            Some("a/b"),
            "ziel",
            VaultListOptions::default(),
            FILTER_MAX_HITS,
            FILTER_TIME_BUDGET,
        )
        .unwrap_err();
        assert!(matches!(relative, FilterScopeError::Invalid(_)));

        let file = find_by_name(
            &[pin],
            Some(&norm(&root.join("leer/nichts.md"))),
            "ziel",
            VaultListOptions::default(),
            FILTER_MAX_HITS,
            FILTER_TIME_BUDGET,
        )
        .unwrap_err();
        assert!(matches!(file, FilterScopeError::Invalid(_)));
    }

    fn twelve_files_fixture(root: &Path) {
        for i in 0..12 {
            write(root, &format!("t{i:02}.md"), "#\n");
        }
    }

    #[test]
    fn deep_filter_cap_triggers_only_on_an_extra_hit() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        twelve_files_fixture(root);
        let pin = pin_dir(root);

        let capped = find_by_name(
            std::slice::from_ref(&pin),
            None,
            "t",
            VaultListOptions::default(),
            5,
            FILTER_TIME_BUDGET,
        )
        .unwrap();
        assert_eq!(5, capped.files.len(), "genau der Deckel");
        assert!(capped.truncated);
        assert_eq!(Some("cap"), capped.reason);

        // Gleichstand ist KEINE Truncation — der Deckel greift erst, wenn ein
        // weiterer Treffer ansteht.
        let exact = find_by_name(
            &[pin],
            None,
            "t",
            VaultListOptions::default(),
            12,
            FILTER_TIME_BUDGET,
        )
        .unwrap();
        assert_eq!(12, exact.files.len());
        assert!(!exact.truncated);
        assert_eq!(None, exact.reason);
    }

    #[test]
    fn deep_filter_cap_counts_hits_not_visits() {
        // Nur EIN Namens-Treffer, aber viele Nicht-Treffer. Ein Visit-Deckel
        // (der R2-Fehler) wuerde hier truncaten; der Treffer-Deckel nicht.
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        for i in 0..50 {
            write(root, &format!("decoy{i:02}.md"), "#\n");
        }
        write(root, "ziel.md", "# z\n");
        let res = find_by_name(
            &[pin_dir(root)],
            None,
            "ziel",
            VaultListOptions::default(),
            5,
            FILTER_TIME_BUDGET,
        )
        .unwrap();
        assert_eq!(vec![norm(&root.join("ziel.md"))], res.files);
        assert!(
            !res.truncated,
            "ein einziger Treffer unter vielen Nicht-Treffern darf nicht truncaten"
        );
        assert_eq!(None, res.reason);
    }

    #[test]
    fn deep_filter_time_budget_sets_time_reason() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        twelve_files_fixture(root);
        let res = find_by_name(
            &[pin_dir(root)],
            None,
            "t",
            VaultListOptions::default(),
            FILTER_MAX_HITS,
            Duration::ZERO,
        )
        .unwrap();
        assert!(res.truncated, "Budget 0 muss truncaten");
        assert_eq!(Some("time"), res.reason);
    }

    #[test]
    fn deep_filter_file_pin_matches_without_dirs() {
        let tmp = TempDir::new().unwrap();
        let vault_root = tmp.path().join("vault");
        let file_root = tmp.path().join("solo");
        write(&vault_root, "a/ziel.md", "# z\n");
        write(&file_root, "einzel-ziel.md", "# e\n");
        let pins = vec![
            pin_dir(&vault_root),
            pin_file(&file_root.join("einzel-ziel.md")),
        ];

        let res = find(&pins, None, "ziel", VaultListOptions::default());
        assert!(res.files.contains(&norm(&file_root.join("einzel-ziel.md"))));
        assert!(
            !res.dirs
                .iter()
                .any(|d| crate::path_migration::is_under(d, &norm(&file_root))),
            "Datei-Pin darf keine dirs liefern: {:?}",
            res.dirs
        );
    }

    #[test]
    fn deep_filter_empty_query_is_empty_without_walk() {
        let tmp = TempDir::new().unwrap();
        twelve_files_fixture(tmp.path());
        let res = find(
            &[pin_dir(tmp.path())],
            None,
            "  ",
            VaultListOptions::default(),
        );
        // "  " ist nicht leer → matcht nichts (kein Name enthaelt zwei Leerzeichen).
        assert!(res.files.is_empty());
        let res = find(
            &[pin_dir(tmp.path())],
            None,
            "",
            VaultListOptions::default(),
        );
        assert!(res.files.is_empty() && res.dirs.is_empty());
    }

    // --- Korrekturrunde 1: aus den Review-Repros abgeleitete Faelle --------

    #[test]
    fn deep_filter_rejects_git_scope() {
        // Der Bereich wird validiert, NICHT still uebersprungen: eine
        // `.git`-Komponente ist nie ein erlaubter Walk-Root.
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), ".git/ziel-in-git.md", "x");
        let scope = norm(&tmp.path().join(".git"));
        let err = find_by_name(
            &[pin_dir(tmp.path())],
            Some(&scope),
            "ziel",
            VaultListOptions::default(),
            FILTER_MAX_HITS,
            FILTER_TIME_BUDGET,
        )
        .unwrap_err();
        assert_eq!(FilterScopeError::Invalid(scope), err);
    }

    #[cfg(unix)]
    #[test]
    fn deep_filter_rejects_symlink_scope() {
        // Ein Symlink-Verzeichnis unterhalb der Pin-Wurzel ist kein erlaubter
        // Bereich; eine exakt gepinnte Wurzel waere die Ausnahme (Pin-Bypass).
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "real/ziel.md", "x");
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(tmp.path().join("real"), &link).unwrap();
        let scope = norm(&link);
        let err = find_by_name(
            &[pin_dir(tmp.path())],
            Some(&scope),
            "ziel",
            VaultListOptions::default(),
            FILTER_MAX_HITS,
            FILTER_TIME_BUDGET,
        )
        .unwrap_err();
        assert_eq!(FilterScopeError::Invalid(scope), err);
    }

    #[cfg(unix)]
    #[test]
    fn deep_filter_rejects_symlink_component_between_pin_and_scope() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "real/inner/ziel.md", "x");
        // `mid` ist ein Symlink; der Bereich liegt dahinter.
        std::os::unix::fs::symlink(tmp.path().join("real"), tmp.path().join("mid")).unwrap();
        let scope = norm(&tmp.path().join("mid/inner"));
        let err = find_by_name(
            &[pin_dir(tmp.path())],
            Some(&scope),
            "ziel",
            VaultListOptions::default(),
            FILTER_MAX_HITS,
            FILTER_TIME_BUDGET,
        )
        .unwrap_err();
        assert_eq!(FilterScopeError::Invalid(scope), err);
    }

    #[test]
    fn deep_filter_time_budget_covers_hidden_entries() {
        // Versteckte Eintraege werden im Visitor gefiltert, nicht vom Walker —
        // die Deadline sieht jeden Eintrag. Ein breites, komplett verstecktes
        // Verzeichnis muss trotzdem als `time` truncaten.
        let tmp = TempDir::new().unwrap();
        for i in 0..30_000 {
            write(tmp.path(), &format!(".hidden-{i:05}"), "");
        }
        let budget = Duration::from_millis(10);
        let start = Instant::now();
        let res = find_by_name(
            &[pin_dir(tmp.path())],
            None,
            "ziel",
            VaultListOptions {
                markdown_only: false,
                show_hidden: false,
            },
            FILTER_MAX_HITS,
            budget,
        )
        .unwrap();
        let elapsed = start.elapsed();
        assert!(elapsed > budget, "Fixture muss das Budget ausschoepfen");
        assert!(
            res.truncated,
            "ueber dem Budget darf der Walk nicht Vollstaendigkeit melden"
        );
        assert_eq!(res.reason, Some("time"));
    }

    // --- Korrekturrunde 2: aus der Nachpruefung -----------------------------

    #[test]
    fn deep_filter_git_pin_never_walked() {
        // Auch eine explizit gepinnte `.git`-Wurzel darf ohne Bereich nicht
        // betreten werden (`.git` immer draussen).
        let tmp = TempDir::new().unwrap();
        let git = tmp.path().join(".git");
        write(&git, "ziel-in-git.md", "x");
        let res = find(&[pin_dir(&git)], None, "ziel", VaultListOptions::default());
        assert!(
            res.files.is_empty(),
            ".git-Pin-Wurzel darf nicht gelaufen werden: {:?}",
            res.files
        );
    }

    #[cfg(unix)]
    #[test]
    fn deep_filter_exact_symlink_pin_bypass_preserved() {
        // Akzeptierte Ausnahme: eine exakt gepinnte Symlink-Wurzel bleibt
        // erlaubt (Pin-Bypass) — mit und ohne Bereich.
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "real/ziel.md", "x");
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(tmp.path().join("real"), &link).unwrap();
        let pins = [pin_dir(&link)];
        let scoped = find(
            &pins,
            Some(&norm(&link)),
            "ziel",
            VaultListOptions::default(),
        );
        assert_eq!(scoped.files, vec![norm(&link.join("ziel.md"))]);
        let unscoped = find(&pins, None, "ziel", VaultListOptions::default());
        assert_eq!(unscoped.files, scoped.files);
    }
}
