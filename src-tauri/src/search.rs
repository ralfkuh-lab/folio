//! Vault-Volltextsuche — öffentliche API, Datenmodell + Suchkern.
//!
//! Test-first entstanden (S1a: Typen + Tests, S1b: Implementierung gegen die
//! fixierten Tests). Die Tests in `mod tests` bleiben unantastbar — Änderungen
//! nur additiv.
//!
//! Kern: [`resolve_scope`] (Scope → deduplizierte [`SearchRoots`]) und
//! [`run_search`] (`ignore::WalkBuilder` single-threaded, `FileKind`-Filter,
//! Größen-/NUL-Filter, `regex`-Matching, UTF-16-Spalten, Snippet-Fensterung,
//! Per-File-/Global-Caps mit Probe-Modus, kooperativer Cancel).
//!
//! S6: [`run_search_parallel`] ist die parallele Variante von
//! [`run_search_ex`] (identischer Vertrag). Sie fächert die Verzeichnis-
//! Phase über `WalkBuilder::build_parallel()` auf; die Worker senden fertige
//! Ergebnisse über `mpsc` an den aufrufenden Thread, der als EINZIGER
//! `on_file` ruft und Caps/Stats exakt führt (Completion-Order, nicht
//! deterministisch). Die sequenzielle Pipeline bleibt unverändert.
//!
//! Grundlage: [`docs/spec-vault-search.md`], Architektur-Entscheidungen 1–5.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Instant;

use ignore::{WalkBuilder, WalkState};
use regex::Regex;
use serde::Serialize;

use crate::file_kind::{classify, FileKind};
use crate::workspace::PinnedItem;

/// Snippet-Fensterung: Zeilen bis zu dieser UTF-16-Länge werden ungekürzt
/// als Snippet übernommen (Richtgröße ~240 aus der Spec).
const SNIPPET_MAX_UTF16: usize = 240;
/// Kontext (in Zeichen) links vor dem ersten Treffer beim Fenstern langer Zeilen.
const SNIPPET_CONTEXT_CHARS: usize = 40;
/// Fensterbreite (in Zeichen) für gekürzte Snippets.
const SNIPPET_WINDOW_CHARS: usize = 240;

/// Größere Dateien werden übersprungen und in `SearchStats::skipped_large`
/// gezählt (kein Read großer Binärblobs).
pub const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2 MiB

/// Maximale Zahl an Zeilen-Treffern (Hits) pro Datei; bei Überschreitung wird
/// `FileResult::truncated` gesetzt (kein stilles Abschneiden).
pub const MAX_HITS_PER_FILE: usize = 50;

/// Globaler Deckel über alle Dateien hinweg; bei Überschreitung wird
/// `SearchStats::truncated` gesetzt und der Walk beendet.
pub const MAX_HITS_TOTAL: usize = 500;

/// Kürzere Suchbegriffe werden mit [`SearchError::QueryTooShort`] abgelehnt.
pub const MIN_QUERY_LEN: usize = 2;

/// Wieviele Bytes am Dateianfang auf NUL-Bytes geprüft werden (Sniff gegen
/// falsch benannte Binärdateien).
pub const NUL_SNIFF_BYTES: usize = 8 * 1024; // 8 KiB

/// Such-Scope. Kommt fachlich vom Frontend als optionaler Ordnerpfad
/// (`None` → `Vault`); die Umsetzung ins Command-Modell passiert in S1b.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchScope {
    /// Gesamter Vault: Union aller angepinnten Ordner (rekursiv) + Einzeldateien.
    Vault,
    /// Ein einzelner Ordner (absoluter Pfad), rekursiv.
    Folder(String),
}

/// Such-Optionen (Frontend → Backend, camelCase).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    /// Groß-/Kleinschreibung beachten. Default `false` → regex `(?i)`.
    pub case_sensitive: bool,
    /// Nur ganze Wörter (an Unicode-Wortgrenzen, regex `\b…\b`).
    pub whole_word: bool,
    /// Auch versteckte und gitignorierte Dateien durchsuchen (Default aus).
    /// Deaktiviert im Walk den hidden-Filter und alle ignore/gitignore-Filter.
    #[serde(default)]
    pub include_hidden: bool,
}

/// Erweitertes Scope-Modell (S4). Wird an der Command-/HTTP-Grenze aus den
/// flachen Argumenten (`scope`, `open_tabs`) gebaut und intern in konkrete
/// Roots bzw. einen OpenTabs-Snapshot übersetzt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchScopeEx {
    /// Gesamter Vault (Union der angepinnten Einträge).
    Vault,
    /// Ein einzelner Ordner (absoluter Pfad), rekursiv.
    Folder(String),
    /// Alle aktuell offenen Tabs (Editor-Puffer bzw. pending-Pfad von Platte).
    OpenTabs,
}

/// Dateityp-Filter (S4). `Markdown` = nur echte Markdown-Dateien, `AllText` =
/// das S1-Verhalten (Markdown + Text via `FileKind`), `Custom` = eine
/// benutzerdefinierte Endungsliste (siehe [`parse_custom_extensions`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileFilter {
    Markdown,
    AllText,
    Custom(Vec<String>),
}

/// Erweiterte Such-Optionen (S4): kapselt die S1-[`SearchOptions`] plus
/// Regex-Modus und Dateityp-Filter. Öffentliche Erweiterungs-API, damit
/// [`run_search`]/[`SearchOptions`] (S1) unverändert bleiben.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtendedSearchOptions {
    pub base: SearchOptions,
    pub regex: bool,
    pub filter: FileFilter,
}

/// Herkunft des zu durchsuchenden Inhalts eines offenen Tabs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BufferSource {
    /// Editor-Puffer (geladener textueller Store) — unabhängig von Textleere.
    InMemory(String),
    /// Kein Puffer (pending/opaque Tab) — Inhalt von Platte lesen.
    OnDisk,
}

/// Ein zu durchsuchender offener Tab (OpenTabs-Scope). `path` ist bereits
/// forward-slash-normalisiert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferDoc {
    pub path: String,
    pub source: BufferSource,
}

impl FileFilter {
    /// Ob `path` unter diesem Filter durchsucht wird. Ersetzt das frühere
    /// `is_searchable_kind` an beiden Call-Sites.
    fn accepts(&self, path: &Path) -> bool {
        match self {
            FileFilter::Markdown => path
                .to_str()
                .map(|s| matches!(classify(s), FileKind::Markdown))
                .unwrap_or(false),
            FileFilter::AllText => path
                .to_str()
                .map(|s| matches!(classify(s), FileKind::Markdown | FileKind::Text))
                .unwrap_or(false),
            FileFilter::Custom(exts) => path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    let e = e.to_ascii_lowercase();
                    exts.contains(&e)
                })
                .unwrap_or(false),
        }
    }

    /// Baut den Filter aus dem UI-/API-Wert. `custom_extensions` ist der rohe
    /// Feldtext (nur bei `"custom"` relevant, sonst ignoriert).
    pub fn from_raw(file_filter: &str, custom_extensions: &str) -> Result<FileFilter, SearchError> {
        match file_filter {
            "markdown" => Ok(FileFilter::Markdown),
            "allText" => Ok(FileFilter::AllText),
            "custom" => {
                let exts = parse_custom_extensions(custom_extensions)?;
                if exts.is_empty() {
                    return Err(SearchError::EmptyCustomExtensions);
                }
                Ok(FileFilter::Custom(exts))
            }
            other => Err(SearchError::UnknownFileFilter(other.to_string())),
        }
    }
}

/// Zerlegt den rohen Endungs-Feldtext in eine normalisierte, deduplizierte
/// Liste. **Einzige** Zerlegungsstelle (UI/Tauri/HTTP laufen hier durch):
/// Trennung an Komma, Semikolon und Whitespace; pro Token trimmen, führenden
/// Punkt entfernen, lowercase; erlaubte Zeichen `[a-z0-9_-]`. Leere Tokens
/// werden ignoriert (die Leerlisten-Policy greift erst beim `Custom`-Filter,
/// siehe [`FileFilter::from_raw`]).
pub fn parse_custom_extensions(raw: &str) -> Result<Vec<String>, SearchError> {
    let mut out: Vec<String> = Vec::new();
    for token in raw.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let ext = token.trim_start_matches('.').to_ascii_lowercase();
        if ext.is_empty() {
            continue;
        }
        let allowed = ext
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
        if !allowed {
            return Err(SearchError::InvalidCustomExtension(token.to_string()));
        }
        if !out.contains(&ext) {
            out.push(ext);
        }
    }
    Ok(out)
}

/// Baut das erweiterte Scope-Modell aus den flachen Grenz-Argumenten.
/// `open_tabs=true` **und** ein gesetzter `scope` schließen sich aus
/// (Client-Fehler).
pub fn to_scope_ex(scope: Option<String>, open_tabs: bool) -> Result<SearchScopeEx, SearchError> {
    match (open_tabs, scope) {
        (true, Some(_)) => Err(SearchError::ScopeConflict),
        (true, None) => Ok(SearchScopeEx::OpenTabs),
        (false, Some(path)) => Ok(SearchScopeEx::Folder(path)),
        (false, None) => Ok(SearchScopeEx::Vault),
    }
}

/// Aufgelöster, deduplizierter Such-Umfang. Verschachtelte Ordner sind
/// eingeklappt (ein Kind-Ordner unter einem enthaltenen Eltern-Ordner
/// entfällt) und Einzeldateien, die schon von einem Ordner abgedeckt sind,
/// werden verworfen — so wird jede Datei genau einmal durchsucht.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchRoots {
    /// Rekursiv zu durchsuchende Ordner.
    pub dirs: Vec<PathBuf>,
    /// Einzelne angepinnte Dateien, die von keinem `dirs`-Eintrag abgedeckt sind.
    pub files: Vec<PathBuf>,
}

/// Ein Treffer entspricht **einer Zeile** mit allen Match-Ranges dieser Zeile.
/// Spalten in UTF-16-Code-Units (Monaco-Konvention).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Zeilennummer, 1-based.
    pub line: u32,
    /// Spalte des ersten Treffers in der Zeile, 1-based, UTF-16-Code-Units.
    pub col_utf16: u32,
    /// Länge des ersten Treffers in UTF-16-Code-Units.
    pub len_utf16: u32,
    /// Angezeigte Zeile (ohne `\r`); bei Überlänge um den ersten Treffer
    /// auf ~240 Zeichen gefenstert.
    pub snippet: String,
    /// UTF-16-Offset, an dem `snippet` innerhalb der Originalzeile beginnt
    /// (0, wenn nicht gefenstert).
    pub snippet_offset_utf16: u32,
    /// Alle Match-Ranges der Zeile, `[startUtf16, lenUtf16]`, **0-based
    /// relativ zum `snippet`** (für `<mark>`-Markup im Frontend).
    pub ranges: Vec<[u32; 2]>,
}

/// Treffer gruppiert pro Datei.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    /// Absoluter Pfad, Forward-Slash-normalisiert.
    pub path: String,
    /// Reiner Dateiname (letzte Pfadkomponente).
    pub file_name: String,
    /// Zeilen-Treffer in Datei-Reihenfolge.
    pub hits: Vec<SearchHit>,
    /// `true`, wenn in dieser Datei mehr als `MAX_HITS_PER_FILE` Zeilen
    /// getroffen wurden.
    pub truncated: bool,
}

/// Aggregierte Lauf-Statistik (Frontend-Statuszeile).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStats {
    /// Zahl der tatsächlich gelesenen/durchsuchten Dateien.
    pub files_scanned: usize,
    /// Zahl der Dateien mit mindestens einem Treffer.
    pub files_matched: usize,
    /// Gesamtzahl der Zeilen-Treffer (Hits) über alle Dateien.
    pub hits: usize,
    /// Zahl der wegen `MAX_FILE_SIZE` übersprungenen Dateien.
    pub skipped_large: usize,
    /// `true`, wenn der globale Deckel `MAX_HITS_TOTAL` gegriffen hat.
    pub truncated: bool,
    /// Laufzeit in Millisekunden.
    pub elapsed_ms: u64,
}

/// Fehlerfälle der Suche.
#[derive(Debug)]
pub enum SearchError {
    /// Suchbegriff kürzer als [`MIN_QUERY_LEN`].
    QueryTooShort,
    /// Ein zu durchsuchender Root existiert nicht (mehr).
    RootNotFound(String),
    /// Ein Root existiert, hat aber den falschen Typ oder ist relativ
    /// (Ordner-Root ist keine absolute Verzeichnis; Datei-Root ist keine Datei).
    InvalidScope(String),
    /// Der aus dem Suchbegriff kompilierte Regex war ungültig (S1b).
    InvalidPattern(String),
    /// Regex-Modus + Nur-ganze-Wörter kombiniert (nicht unterstützt, S4).
    RegexWholeWordConflict,
    /// Eine benutzerdefinierte Endung enthält verbotene Zeichen (S4).
    InvalidCustomExtension(String),
    /// `Custom`-Filter aktiv, aber keine gültige Endung angegeben (S4).
    EmptyCustomExtensions,
    /// Unbekannter `fileFilter`-Wert an der Grenze (S4).
    UnknownFileFilter(String),
    /// OpenTabs-Scope mit gesetztem Ordner-Scope kombiniert (S4).
    ScopeConflict,
}

impl SearchError {
    fn translation_parts(&self) -> (&'static str, Option<&str>) {
        match self {
            Self::QueryTooShort => ("errors.search.queryTooShort", None),
            Self::RootNotFound(detail) => ("errors.search.rootNotFound", Some(detail)),
            Self::InvalidScope(detail) => ("errors.search.invalidScope", Some(detail)),
            Self::InvalidPattern(detail) => ("errors.search.invalidQuery", Some(detail)),
            Self::RegexWholeWordConflict => ("errors.search.regexWholeWord", None),
            Self::InvalidCustomExtension(detail) => {
                ("errors.search.invalidCustomExtension", Some(detail))
            }
            Self::EmptyCustomExtensions => ("errors.search.emptyCustomExtensions", None),
            Self::UnknownFileFilter(detail) => ("errors.search.unknownFileFilter", Some(detail)),
            Self::ScopeConflict => ("errors.search.scopeConflict", None),
        }
    }

    /// Lokalisierte UI-/Diagnosedarstellung mit einer expliziten Translator-Instanz.
    /// Produktiv verwendet `Display` die einmal initialisierte Prozess-Fassade;
    /// Tests können damit ohne globalen Zustand arbeiten.
    pub fn localized(&self, tr: &crate::i18n::Translator) -> String {
        match self {
            Self::QueryTooShort => tr.t("errors.search.queryTooShort"),
            Self::RootNotFound(detail) => {
                tr.t_args("errors.search.rootNotFound", &[("detail", detail)])
            }
            Self::InvalidScope(detail) => {
                tr.t_args("errors.search.invalidScope", &[("detail", detail)])
            }
            Self::InvalidPattern(detail) => {
                tr.t_args("errors.search.invalidQuery", &[("detail", detail)])
            }
            Self::RegexWholeWordConflict => tr.t("errors.search.regexWholeWord"),
            Self::InvalidCustomExtension(detail) => tr.t_args(
                "errors.search.invalidCustomExtension",
                &[("detail", detail)],
            ),
            Self::EmptyCustomExtensions => tr.t("errors.search.emptyCustomExtensions"),
            Self::UnknownFileFilter(detail) => {
                tr.t_args("errors.search.unknownFileFilter", &[("detail", detail)])
            }
            Self::ScopeConflict => tr.t("errors.search.scopeConflict"),
        }
    }

    fn key_fallback(&self) -> String {
        let (key, detail) = self.translation_parts();
        match detail {
            Some(detail) => format!("{key}: {detail}"),
            None => key.to_string(),
        }
    }
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match crate::i18n::process_translator() {
            Some(tr) => self.localized(tr),
            None => self.key_fallback(),
        };
        f.write_str(&message)
    }
}

impl std::error::Error for SearchError {}

/// Löst einen [`SearchScope`] gegen die angepinnten Einträge in einen
/// deduplizierten [`SearchRoots`] auf (Overlap-Dedup, Forward-Slash-
/// Normalisierung).
///
/// - [`SearchScope::Vault`]: Union aller angepinnten Ordner + Einzeldateien,
///   verschachtelte Ordner eingeklappt. Explizit gepinnte Einzeldateien
///   bleiben auch dann erhalten, wenn sie unter einem gepinnten Ordner
///   liegen — der Pin-Bypass (hidden/gitignore umgehen) greift nur über die
///   Einzeldatei-Phase; der Walk-Dedup läuft über das gemeinsame `seen`-Set.
///   Nur exakte Duplikat-Pins werden entfernt.
/// - [`SearchScope::Folder`]: genau dieser Ordner (Pins irrelevant).
pub fn resolve_scope(pinned: &[PinnedItem], scope: &SearchScope) -> SearchRoots {
    if let SearchScope::Folder(path) = scope {
        // Ordner-Scope: genau dieser Ordner (Existenz prüft `run_search`).
        return SearchRoots {
            dirs: vec![PathBuf::from(normalize_str(path))],
            files: vec![],
        };
    }

    // Vault-Scope: Union aller angepinnten, noch existierenden Einträge.
    // Tote Pins werden STILL verworfen (Abnahme S1a, 2026-07-12).
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();
    for item in pinned {
        let pb = PathBuf::from(normalize_str(&item.path));
        if item.is_directory {
            if pb.is_dir() {
                dirs.push(pb);
            }
        } else if pb.is_file() {
            files.push(pb);
        }
    }

    // Overlap-Dedup Ordner: verschachtelte + doppelte Ordner entfernen.
    let kept_dirs = collapse_overlapping_dirs(&dirs);

    // Einzeldatei-Pins: nur exakte Duplikate entfernen. Abdeckung durch einen
    // Elternordner-Pin verwirft den Datei-Pin NICHT — sonst bricht der
    // dokumentierte Pin-Bypass für hidden/gitignorierte Dateien, wenn der
    // Ordner-Walk sie (includeHidden=false) nicht sieht.
    let mut kept_files: Vec<PathBuf> = Vec::new();
    for f in &files {
        if kept_files.iter().any(|k| k == f) {
            continue;
        }
        kept_files.push(f.clone());
    }

    SearchRoots {
        dirs: kept_dirs,
        files: kept_files,
    }
}

/// Klappt überlappende Verzeichnis-Roots ein: ein Kind-Root, der von einem
/// anderen (Eltern-)Root abgedeckt ist, entfällt; exakte Duplikate ebenfalls.
/// Nutzt `PathBuf::starts_with` (komponentenweise, also separator-grenzen-sicher —
/// `/a/b` deckt `/a/bc` NICHT ab). Ergebnis: jede Datei liegt unter höchstens
/// einem Root, sodass ein rekursiver Walk pro Root jede Datei genau einmal
/// besucht. Gemeinsame Grundlage von [`resolve_scope`] und
/// [`walk_dirs_parallel`].
fn collapse_overlapping_dirs(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut kept: Vec<PathBuf> = Vec::new();
    for d in dirs {
        let covered_by_other = dirs.iter().any(|other| other != d && d.starts_with(other));
        if covered_by_other || kept.iter().any(|k| k == d) {
            continue;
        }
        kept.push(d.clone());
    }
    kept
}

/// Backslashes → Forward-Slashes (Pfad-Normalisierung wie überall in folio).
fn normalize_str(s: &str) -> String {
    s.replace('\\', "/")
}

/// Forward-Slash-normalisierter Pfad-String für DOM/Frontend + Dedup.
fn normalize_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Prüft Suchbegriff (Mindestlänge, gültiges Regex) und Root-Existenz.
/// Gibt das kompilierte Regex zurück, damit Aufrufer es wiederverwenden
/// können (synchrone Vorabprüfung im Command-Layer vor dem Blocking-Task).
///
/// Der Vault-Scope hat tote Pins bereits in [`resolve_scope`] verworfen;
/// [`SearchError::RootNotFound`] betrifft nur direkt übergebene Roots
/// (Ordner-Scope / Automation-API).
pub fn validate(
    roots: &SearchRoots,
    query: &str,
    options: &SearchOptions,
) -> Result<Regex, SearchError> {
    if query.chars().count() < MIN_QUERY_LEN {
        return Err(SearchError::QueryTooShort);
    }
    let re = compile_regex(query, options)?;
    validate_roots(roots)?;
    Ok(re)
}

/// Prüft nur die Roots (Existenz/Typ/absolut). Ausgelagert aus [`validate`],
/// damit die Query-Validierung (S4) roots-frei laufen kann und der
/// Command-Layer die Roots separat für den `scope:`-Fehler-Fallback prüfen
/// kann.
pub fn validate_roots(roots: &SearchRoots) -> Result<(), SearchError> {
    for d in &roots.dirs {
        // Relativ zuerst prüfen: ein relativer Pfad ist grundsätzlich ungültig
        // (nicht bloß „nicht gefunden"). Danach Existenz, danach Typ.
        if !d.is_absolute() {
            return Err(SearchError::InvalidScope(normalize_path(d)));
        }
        if !d.exists() {
            return Err(SearchError::RootNotFound(normalize_path(d)));
        }
        if !d.is_dir() {
            return Err(SearchError::InvalidScope(normalize_path(d)));
        }
    }
    for f in &roots.files {
        if !f.exists() {
            return Err(SearchError::RootNotFound(normalize_path(f)));
        }
        if !f.is_file() {
            return Err(SearchError::InvalidScope(normalize_path(f)));
        }
    }
    Ok(())
}

/// Baut aus dem (escapten) Suchbegriff das Match-Regex (S1-Pfad ohne
/// Regex-Modus). Delegiert an [`compile_pattern`].
fn compile_regex(query: &str, options: &SearchOptions) -> Result<Regex, SearchError> {
    compile_pattern(
        query,
        &ExtendedSearchOptions {
            base: *options,
            regex: false,
            filter: FileFilter::AllText,
        },
    )
}

/// Kompiliert das Match-Regex aus Query + erweiterten Optionen (S4).
/// - `regex=false`: Query wird als Literal escaped.
/// - `regex=true`: Query wird direkt als Regex kompiliert (kein `escape`).
/// - `regex=true && whole_word=true`: Client-Fehler — Rust-`regex` kennt keine
///   Lookarounds; ein `\b`-Wrap wäre bei Satzzeichen/Anchor/Alternation
///   semantisch überraschend, daher lehnen wir die Kombination ab statt sie
///   still umzudeuten.
/// - `case_sensitive=false`: `(?i)`-Präfix.
fn compile_pattern(query: &str, o: &ExtendedSearchOptions) -> Result<Regex, SearchError> {
    if o.regex && o.base.whole_word {
        return Err(SearchError::RegexWholeWordConflict);
    }
    let mut pat = if o.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if o.base.whole_word {
        pat = format!(r"\b{pat}\b");
    }
    if !o.base.case_sensitive {
        pat = format!("(?i){pat}");
    }
    Regex::new(&pat).map_err(|e| SearchError::InvalidPattern(e.to_string()))
}

/// Query-Validierung (Mindestlänge + Regex-Kompilierung), roots-frei. Liefert
/// das kompilierte Regex zur Wiederverwendung.
fn compile_validated_pattern(query: &str, o: &ExtendedSearchOptions) -> Result<Regex, SearchError> {
    if query.chars().count() < MIN_QUERY_LEN {
        return Err(SearchError::QueryTooShort);
    }
    compile_pattern(query, o)
}

/// Öffentliche, roots-freie Query-/Options-Validierung für die Dialog-
/// Vorabprüfung (`vault_search_validate`). Fängt zu kurze Begriffe, ungültige
/// Regex-Patterns und die Regex+WholeWord-Kombination ab.
pub fn validate_query_ex(query: &str, o: &ExtendedSearchOptions) -> Result<(), SearchError> {
    compile_validated_pattern(query, o).map(|_| ())
}

/// Erzeugt einen Zeilen-Hit aus allen Match-Byte-Ranges dieser (bereits
/// CR-bereinigten) Zeile. Berechnet UTF-16-Spalten und fenstert lange Zeilen
/// um den ersten Treffer.
///
/// Perf: eine einmalige Byte→UTF-16-Präfix-Map pro Zeile (O(N)) statt
/// wiederholter `encode_utf16().count()`-Präfixzählungen (O(M·N)).
fn make_hit(line: &str, line_no: u32, matches: &[(usize, usize)]) -> SearchHit {
    // byte_at[k] = Byte-Offset der k-ten Zeichen-Grenze, u16_prefix[k] = Zahl
    // der UTF-16-Code-Units der ersten k Zeichen. Länge jeweils n_chars + 1.
    let mut byte_at: Vec<usize> = Vec::with_capacity(line.len() + 1);
    let mut u16_prefix: Vec<u32> = Vec::with_capacity(line.len() + 1);
    let mut acc = 0u32;
    for (b, c) in line.char_indices() {
        byte_at.push(b);
        u16_prefix.push(acc);
        acc += c.len_utf16() as u32;
    }
    byte_at.push(line.len());
    u16_prefix.push(acc);
    let line_u16 = acc as usize;

    // Match-Byte-Offsets liegen immer auf Zeichen-Grenzen (Regex matcht ganze
    // Zeichen) → binary_search trifft; der Err-Zweig ist ein defensiver Fallback.
    let char_at = |byte: usize| byte_at.binary_search(&byte).unwrap_or_else(|i| i);
    let u16_of = |byte: usize| u16_prefix[char_at(byte)];

    let (bs0, be0) = matches[0];
    let col_utf16 = u16_of(bs0) + 1;
    let len_utf16 = u16_of(be0) - u16_of(bs0);

    // Fenstern nur bei überlangen Zeilen. Das Fenster reicht garantiert bis zum
    // Ende des ersten Treffers (die ~240 sind eine weiche Richtgröße) — so liegt
    // der erste Match IMMER vollständig im Snippet und ist die erste Range.
    let (start_byte, end_byte, snippet_offset_utf16) = if line_u16 <= SNIPPET_MAX_UTF16 {
        (0usize, line.len(), 0u32)
    } else {
        let n_chars = byte_at.len() - 1;
        let first_char = char_at(bs0);
        let first_end_char = char_at(be0);
        let start_char = first_char.saturating_sub(SNIPPET_CONTEXT_CHARS);
        let end_char = (start_char + SNIPPET_WINDOW_CHARS)
            .max(first_end_char)
            .min(n_chars);
        (
            byte_at[start_char],
            byte_at[end_char],
            u16_prefix[start_char],
        )
    };

    let snippet = line[start_byte..end_byte].to_string();
    // Übrige Matches nur aufnehmen, wenn vollständig im Fenster (kein Clamping).
    let ranges: Vec<[u32; 2]> = matches
        .iter()
        .filter(|&&(bs, be)| bs >= start_byte && be <= end_byte)
        .map(|&(bs, be)| [u16_of(bs) - snippet_offset_utf16, u16_of(be) - u16_of(bs)])
        .collect();

    SearchHit {
        line: line_no,
        col_utf16,
        len_utf16,
        snippet,
        snippet_offset_utf16,
        ranges,
    }
}

/// Durchsucht einen Dateiinhalt zeilenweise; ein Hit pro Treffer-Zeile
/// (mit allen Ranges). Kappt bei `cap` Zeilen-Hits (zweites Tupel-Element
/// `truncated`). Prüft `cancel` pro Zeile — bei Abbruch ist das dritte
/// Element `cancelled = true` (Datei wird verworfen).
fn build_file_hits(
    content: &str,
    re: &Regex,
    cap: usize,
    cancel: &AtomicBool,
) -> (Vec<SearchHit>, bool, bool) {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut truncated = false;
    for (idx, raw) in content.split('\n').enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return (hits, truncated, true);
        }
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        // Zero-Width-Matches (z. B. Regex `a*`) überspringen — ein Hit mit
        // `lenUtf16 == 0` ist nutzlos und würde die UI verwirren.
        let matches: Vec<(usize, usize)> = re
            .find_iter(line)
            .filter(|m| m.start() < m.end())
            .map(|m| (m.start(), m.end()))
            .collect();
        if matches.is_empty() {
            continue;
        }
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        hits.push(make_hit(line, idx as u32 + 1, &matches));
    }
    (hits, truncated, false)
}

/// Rohes, statistikfreies Ergebnis des Content-Gates. Trennt die reine
/// Größen-/NUL-Klassifikation von der `SearchStats`-Buchführung, sodass die
/// parallelen Worker (S6) das Gate ohne Zugriff auf die Consumer-Stats nutzen
/// können. `TooLarge` und `Skip` (NUL) unterscheiden sich nur darin, dass
/// `TooLarge` beim Aufrufer `skipped_large` erhöhen kann.
enum ContentGate {
    /// Über [`MAX_FILE_SIZE`] — überspringen, ggf. `skipped_large` zählen.
    TooLarge,
    /// NUL-Sniff / kein Content — still überspringen.
    Skip,
    /// Durchsuchbarer Text (lossy dekodiert).
    Ok(String),
}

/// Reine Byte-Klassifikation ohne Statistik: Größen-Cap ([`MAX_FILE_SIZE`]) +
/// NUL-Sniff (erste [`NUL_SNIFF_BYTES`]). Einzige Zerlegungsstelle für
/// [`inspect_content`] (sequenziell) und [`worker_read_disk`] (parallel).
///
/// Hinweis: UTF-16-Dateien (die im `document_store` per BOM erkannt und
/// geöffnet werden können) enthalten für ASCII-Text reichlich NUL-Bytes und
/// fallen deshalb hier als „binär" heraus — die Volltextsuche überspringt
/// sie bewusst (kein Bug; der Suchkern arbeitet auf UTF-8-lossy-Bytes).
fn gate_bytes(bytes: &[u8]) -> ContentGate {
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return ContentGate::TooLarge;
    }
    let sniff_end = bytes.len().min(NUL_SNIFF_BYTES);
    if bytes[..sniff_end].contains(&0u8) {
        return ContentGate::Skip;
    }
    ContentGate::Ok(String::from_utf8_lossy(bytes).into_owned())
}

/// Gemeinsames Content-Gate für Disk-Reads **und** In-Memory-Puffer (S4):
/// Größen-Cap ([`MAX_FILE_SIZE`]) + NUL-Sniff (erste [`NUL_SNIFF_BYTES`]).
/// `None` = überspringen. Übergröße wird nur bei `count_large` in
/// [`SearchStats::skipped_large`] gezählt (Voll-Scan-Modus; der Probe-Modus
/// zählt nicht) — das schließt gecappte Puffer ein.
fn inspect_content(bytes: &[u8], stats: &mut SearchStats, count_large: bool) -> Option<String> {
    match gate_bytes(bytes) {
        ContentGate::TooLarge => {
            if count_large {
                stats.skipped_large += 1;
            }
            None
        }
        ContentGate::Skip => None,
        ContentGate::Ok(content) => Some(content),
    }
}

/// Disk-Read für die parallelen Worker (S6): Metadaten-Größenprüfung **vor**
/// `fs::read` (kein Riesenblob nur zum Verwerfen), dann [`gate_bytes`]. Gibt
/// keine `SearchStats` an — die Buchführung (`skipped_large`/`files_scanned`)
/// macht ausschließlich der Consumer aus den Worker-Events.
fn worker_read_disk(path: &Path) -> ContentGate {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return ContentGate::Skip,
    };
    if meta.len() > MAX_FILE_SIZE {
        return ContentGate::TooLarge;
    }
    match fs::read(path) {
        Ok(bytes) => gate_bytes(&bytes),
        Err(_) => ContentGate::Skip,
    }
}

/// Liest eine (bereits als durchsuchbar gefilterte) Datei über das gemeinsame
/// [`inspect_content`]-Gate. Der Disk-Pfad behält die Metadaten-Größenprüfung
/// **vor** `fs::read`, damit kein Riesenblob nur zum Verwerfen eingelesen wird.
fn read_searchable(path: &Path, stats: &mut SearchStats, count_large: bool) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        if count_large {
            stats.skipped_large += 1;
        }
        return None;
    }
    let bytes = fs::read(path).ok()?;
    // Größe bereits per Metadaten geprüft/gezählt → hier nicht erneut zählen.
    inspect_content(&bytes, stats, false)
}

/// Ergebnis eines Voll-Scan-Kandidaten.
enum ScanOutcome {
    /// Normal weiterscannen.
    Continue,
    /// Deckel exakt gefüllt (kein Cut, Datei nicht selbst gekappt) — in den
    /// leichten Probe-Modus wechseln, statt weiter voll zu scannen.
    Probe,
    /// Reale Treffer sind weggefallen (`stats.truncated` gesetzt) — Walk beenden.
    Stop,
    /// `cancel` mitten in der Datei gesehen — Walk beenden, Datei verworfen.
    Cancelled,
}

/// Voll-Scan einer Disk-Datei: liest über das Content-Gate, dann
/// [`process_content`]. Klassifizierung/Filter ist bereits durch den Aufrufer
/// erfolgt.
fn scan_disk(
    path: &Path,
    norm: &str,
    re: &Regex,
    cancel: &AtomicBool,
    stats: &mut SearchStats,
    on_file: &mut dyn FnMut(FileResult),
) -> ScanOutcome {
    let content = match read_searchable(path, stats, true) {
        Some(c) => c,
        None => return ScanOutcome::Continue,
    };
    process_content(content.as_str(), norm, re, cancel, stats, on_file)
}

/// Durchsucht einen bereits gelesenen/gepufferten Inhalt: aktualisiert `stats`,
/// streamt bei Treffern über `on_file` und meldet über [`ScanOutcome`], wie der
/// Aufrufer weiterfahren soll (Cap-/Probe-/Cancel-Logik identisch zu S1).
/// Gemeinsam genutzt von Disk-Scan und OpenTabs-Puffer-Scan.
fn process_content(
    content: &str,
    norm: &str,
    re: &Regex,
    cancel: &AtomicBool,
    stats: &mut SearchStats,
    on_file: &mut dyn FnMut(FileResult),
) -> ScanOutcome {
    // Deckel prüfen (defensiv; regulär wechselt der Aufrufer beim exakten
    // Erreichen bereits in den Probe-Modus, sodass das hier nicht greift).
    let remaining_global = MAX_HITS_TOTAL - stats.hits;
    if remaining_global == 0 {
        stats.truncated = true;
        return ScanOutcome::Stop;
    }
    stats.files_scanned += 1;

    let (mut hits, perfile_truncated, cancelled) =
        build_file_hits(content, re, MAX_HITS_PER_FILE, cancel);
    if cancelled {
        return ScanOutcome::Cancelled;
    }
    if hits.is_empty() {
        return ScanOutcome::Continue;
    }

    let mut cut = false;
    if hits.len() > remaining_global {
        hits.truncate(remaining_global);
        cut = true;
    }

    stats.hits += hits.len();
    stats.files_matched += 1;
    let file_name = Path::new(norm)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    on_file(FileResult {
        path: norm.to_string(),
        file_name,
        hits,
        truncated: perfile_truncated || cut,
    });

    if cut {
        // Reale Treffer weggeschnitten → definitiv mehr vorhanden.
        stats.truncated = true;
        return ScanOutcome::Stop;
    }
    if stats.hits == MAX_HITS_TOTAL {
        if perfile_truncated {
            // Die Datei, die den Deckel exakt füllt, war selbst gekappt →
            // es gibt real mehr Treffer.
            stats.truncated = true;
            return ScanOutcome::Stop;
        }
        // Exakt gefüllt, kein Cut — unklar ob mehr kommt → Probe-Modus.
        return ScanOutcome::Probe;
    }
    ScanOutcome::Continue
}

/// Probe-Scan eines bereits gelesenen/gepufferten Inhalts: `true`, sobald eine
/// Zeile mindestens einen **nicht-leeren** Treffer hat. Zero-Width-Matches
/// (`start == end`) zählen bewusst nicht — sonst würde ein Zero-Width-only-
/// Kandidat nach dem Deckel fälschlich `truncated` setzen [Sol-Rev2#2].
fn probe_str(content: &str, re: &Regex, cancel: &AtomicBool) -> bool {
    for raw in content.split('\n') {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if re.find_iter(line).any(|m| m.start() < m.end()) {
            return true;
        }
    }
    false
}

/// Leichter Probe-Modus (nach exaktem Erreichen des Deckels): liest einen
/// Disk-Kandidaten und prüft über [`probe_str`], ob es weitere Treffer gibt.
/// Kein `on_file`, kein `files_scanned`-Increment.
fn probe_has_match(path: &Path, re: &Regex, cancel: &AtomicBool) -> bool {
    let mut sink = SearchStats::default();
    match read_searchable(path, &mut sink, false) {
        Some(content) => probe_str(&content, re, cancel),
        None => false,
    }
}

/// Konfiguriert den `WalkBuilder` für den Opt-in-Toggle „auch versteckte und
/// ignorierte Dateien". Default (`include_hidden = false`): Crate-Defaults
/// (`standard_filters` an). An: `standard_filters(false)` schaltet hidden/
/// parents/ignore/git_ignore/git_global/git_exclude als Gruppe ab
/// (`require_git` unangetastet). Zusätzlich bleiben `.git`-Verzeichnisse per
/// `filter_entry` draußen (Object-Store/hooks/logs wären sonst Kosten + Rausch-
/// Treffer).
fn apply_include_hidden(builder: &mut WalkBuilder, include_hidden: bool) {
    if include_hidden {
        builder.standard_filters(false).filter_entry(|entry| {
            // Verzeichnisname ".git" (nicht Pfad-Substring) — weder eintragen
            // noch absteigen.
            entry.file_name() != std::ffi::OsStr::new(".git")
        });
    }
}

/// Läuft über [`SearchRoots`] (Verzeichnis-Walk + explizit gepinnte Dateien)
/// mit einem bereits kompilierten Regex und einem [`FileFilter`]. Gemeinsamer
/// Kern von [`run_search`]/[`run_search_ex`] (ohne Query-/Root-Validierung und
/// ohne `elapsed_ms` — das setzt der Aufrufer).
fn run_over_roots(
    roots: &SearchRoots,
    re: &Regex,
    filter: &FileFilter,
    include_hidden: bool,
    cancel: &AtomicBool,
    on_file: &mut dyn FnMut(FileResult),
) -> SearchStats {
    let mut stats = SearchStats::default();
    let mut seen: HashSet<String> = HashSet::new();
    // Nach exaktem Erreichen des Deckels ohne Cut läuft der Walk in einem
    // leichten Probe-Modus weiter, um `truncated` korrekt zu setzen.
    let mut probing = false;
    let mut stopped = false;

    'walk: for dir in &roots.dirs {
        // Single-threaded Walk; Filter (hidden + gitignore) an, sofern nicht
        // `include_hidden`; deterministische Reihenfolge via sort_by_file_name.
        let mut builder = WalkBuilder::new(dir);
        apply_include_hidden(&mut builder, include_hidden);
        let walker = builder.sort_by_file_name(|a, b| a.cmp(b)).build();
        for result in walker {
            if cancel.load(Ordering::Relaxed) {
                stopped = true;
                break 'walk;
            }
            let entry = match result {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            // Filter vor Normalisierung/seen (Perf: keine Allokation für
            // gefilterte Dateien).
            if !filter.accepts(entry.path()) {
                continue;
            }
            let norm = normalize_path(entry.path());
            if !seen.insert(norm.clone()) {
                continue;
            }
            if probing {
                if probe_has_match(entry.path(), re, cancel) {
                    stats.truncated = true;
                    stopped = true;
                    break 'walk;
                }
                continue;
            }
            match scan_disk(entry.path(), &norm, re, cancel, &mut stats, on_file) {
                ScanOutcome::Continue => {}
                ScanOutcome::Probe => probing = true,
                ScanOutcome::Stop | ScanOutcome::Cancelled => {
                    stopped = true;
                    break 'walk;
                }
            }
        }
    }

    // Einzeln angepinnte Dateien (nicht von einem Ordner abgedeckt).
    if !stopped {
        scan_pinned_files(
            &roots.files,
            re,
            filter,
            cancel,
            &mut stats,
            &mut seen,
            &mut probing,
            on_file,
        );
    }

    stats
}

/// Sequenzielle Einzeldatei-Phase (explizit angepinnte Dateien, die von keinem
/// Ordner abgedeckt sind). Aus [`run_over_roots`] ausgelagert, damit die
/// parallele Variante ([`run_search_parallel`]) genau denselben Code nach der
/// Verzeichnis-Phase wiederverwendet (gemeinsame `stats`/`seen`/`probing`-
/// Maschinerie, statt zu duplizieren). Explizite Pins umgehen den hidden-/
/// gitignore-Filter bewusst (Nutzer-Intention), durchlaufen aber weiterhin
/// Filter-/Größen-/NUL-Prüfung.
#[allow(clippy::too_many_arguments)]
fn scan_pinned_files(
    files: &[PathBuf],
    re: &Regex,
    filter: &FileFilter,
    cancel: &AtomicBool,
    stats: &mut SearchStats,
    seen: &mut HashSet<String>,
    probing: &mut bool,
    on_file: &mut dyn FnMut(FileResult),
) {
    for f in files {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if !filter.accepts(f) {
            continue;
        }
        let norm = normalize_path(f);
        if !seen.insert(norm.clone()) {
            continue;
        }
        if *probing {
            if probe_has_match(f, re, cancel) {
                stats.truncated = true;
                break;
            }
            continue;
        }
        match scan_disk(f, &norm, re, cancel, stats, on_file) {
            ScanOutcome::Continue => {}
            ScanOutcome::Probe => *probing = true,
            ScanOutcome::Stop | ScanOutcome::Cancelled => break,
        }
    }
}

/// Synchroner Suchkern (S1-API). Läuft über [`SearchRoots`], ruft `on_file` je
/// Datei **mit mindestens einem Treffer** (Streaming) und liefert am Ende die
/// aggregierten [`SearchStats`]. Delegiert an [`run_search_ex`] mit dem
/// S1-Standardverhalten (kein Regex, [`FileFilter::AllText`]).
///
/// - `cancel`: kooperatives Abbruch-Flag; ist es gesetzt, bricht der Lauf ab
///   und liefert die bis dahin gesammelte Statistik (keine weiteren `on_file`).
/// - Query kürzer als [`MIN_QUERY_LEN`] → [`SearchError::QueryTooShort`].
/// - Nicht existierender Root → [`SearchError::RootNotFound`];
///   falscher Typ / relativ → [`SearchError::InvalidScope`].
pub fn run_search(
    roots: &SearchRoots,
    query: &str,
    options: &SearchOptions,
    cancel: &AtomicBool,
    on_file: &mut dyn FnMut(FileResult),
) -> Result<SearchStats, SearchError> {
    let ext = ExtendedSearchOptions {
        base: *options,
        regex: false,
        filter: FileFilter::AllText,
    };
    run_search_ex(roots, query, &ext, cancel, on_file)
}

/// Erweiterter Root-basierter Suchlauf (S4): validiert Query + Roots,
/// kompiliert das Regex (inkl. Regex-Modus) und läuft mit dem gewählten
/// [`FileFilter`]. Der `on_file`-/Streaming-/Cap-Vertrag ist identisch zu
/// [`run_search`].
pub fn run_search_ex(
    roots: &SearchRoots,
    query: &str,
    options: &ExtendedSearchOptions,
    cancel: &AtomicBool,
    on_file: &mut dyn FnMut(FileResult),
) -> Result<SearchStats, SearchError> {
    let re = compile_validated_pattern(query, options)?;
    validate_roots(roots)?;

    let start = Instant::now();
    let mut stats = run_over_roots(
        roots,
        &re,
        &options.filter,
        options.base.include_hidden,
        cancel,
        on_file,
    );
    stats.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(stats)
}

/// Durchsucht offene Tab-Puffer (OpenTabs-Scope, S4). Nutzt dieselbe Cap-/
/// Probe-/Dedup-Maschinerie wie der Root-Lauf; der Inhalt je Dokument kommt aus
/// dem Editor-Puffer ([`BufferSource::InMemory`], unabhängig von Textleere)
/// oder von Platte ([`BufferSource::OnDisk`], pending/opaque Tabs). Query-
/// Validierung roots-frei; das gemeinsame Content-Gate ([`inspect_content`])
/// gilt auch für Puffer, sodass `skippedLarge` gecappte Puffer mitzählt.
pub fn run_search_buffers(
    docs: &[BufferDoc],
    query: &str,
    options: &ExtendedSearchOptions,
    cancel: &AtomicBool,
    on_file: &mut dyn FnMut(FileResult),
) -> Result<SearchStats, SearchError> {
    let re = compile_validated_pattern(query, options)?;

    let start = Instant::now();
    let mut stats = SearchStats::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut probing = false;

    for doc in docs {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let path = Path::new(&doc.path);
        if !options.filter.accepts(path) {
            continue;
        }
        if !seen.insert(doc.path.clone()) {
            continue;
        }

        if probing {
            let mut sink = SearchStats::default();
            let content = match &doc.source {
                BufferSource::InMemory(text) => inspect_content(text.as_bytes(), &mut sink, false),
                BufferSource::OnDisk => read_searchable(path, &mut sink, false),
            };
            if let Some(content) = content {
                if probe_str(&content, &re, cancel) {
                    stats.truncated = true;
                    break;
                }
            }
            continue;
        }

        let content = match &doc.source {
            BufferSource::InMemory(text) => inspect_content(text.as_bytes(), &mut stats, true),
            BufferSource::OnDisk => read_searchable(path, &mut stats, true),
        };
        let Some(content) = content else {
            continue;
        };
        match process_content(&content, &doc.path, &re, cancel, &mut stats, on_file) {
            ScanOutcome::Continue => {}
            ScanOutcome::Probe => probing = true,
            ScanOutcome::Stop | ScanOutcome::Cancelled => break,
        }
    }

    stats.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(stats)
}

/// Fertiges Worker-Ergebnis, das über `mpsc` an den Consumer-Thread geht (S6).
/// Alle Varianten tragen den **forward-slash-normalisierten** Pfad, damit der
/// Consumer über beide Phasen hinweg deduplizieren kann. Die Worker senden
/// diese Events; nur der Consumer ruft `on_file` und führt Caps/Stats.
enum WalkEvent {
    /// Datei mit gültigem Inhalt, aber **ohne** Treffer (zählt als
    /// `files_scanned`, solange der globale Deckel noch nicht erreicht ist).
    NoHit { path: String },
    /// Datei mit mindestens einem Treffer; `hits` ist bereits per-Datei auf
    /// [`MAX_HITS_PER_FILE`] gekappt (`truncated` = per-Datei-Cut). Den
    /// globalen Cut macht der Consumer.
    Matched(FileResult),
    /// Datei über [`MAX_FILE_SIZE`] (Voll-Scan-Modus) → `skipped_large`.
    SkippedLarge { path: String },
    /// Probe-Modus (nach exaktem Erreichen des Deckels) hat einen **echten**
    /// (nicht zero-width) Treffer gefunden → `truncated`.
    ProbeHit { path: String },
}

/// Parallele Variante von [`run_search_ex`] (S6) — identischer Vertrag
/// (`on_file`-Streaming, Caps, Cancel, Rückgabe). Fächert die Verzeichnis-
/// Phase über `WalkBuilder::build_parallel()` auf und lässt die anschließende
/// Einzeldatei-Phase ([`scan_pinned_files`]) unverändert sequenziell laufen.
///
/// Reihenfolge ist **Completion-Order** (nichtdeterministisch) — das Frontend
/// behandelt Ankunft als Fundreihenfolge (Sortiermodi Name/Pfad existieren).
/// Bei aktiver Truncation kann die parallele Variante wegen der nebenläufigen,
/// nur näherungsweise gekoppelten Deckel-Erkennung **bis zu**
/// [`MAX_HITS_TOTAL`] Treffer melden (ggf. minimal weniger als der sequenzielle
/// Lauf) — `truncated` wird dabei genau dann gesetzt, wenn real Treffer
/// weggefallen sind.
pub fn run_search_parallel(
    roots: &SearchRoots,
    query: &str,
    options: &ExtendedSearchOptions,
    cancel: &AtomicBool,
    on_file: &mut dyn FnMut(FileResult),
) -> Result<SearchStats, SearchError> {
    let re = compile_validated_pattern(query, options)?;
    validate_roots(roots)?;

    let start = Instant::now();
    let mut stats = SearchStats::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut probing = false;

    let stopped = walk_dirs_parallel(
        &roots.dirs,
        &re,
        &options.filter,
        options.base.include_hidden,
        cancel,
        &mut stats,
        &mut seen,
        &mut probing,
        on_file,
    );
    if !stopped {
        scan_pinned_files(
            &roots.files,
            &re,
            &options.filter,
            cancel,
            &mut stats,
            &mut seen,
            &mut probing,
            on_file,
        );
    }

    stats.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(stats)
}

/// Visitor-Kern eines parallelen Workers: Filter + Content-Gate + Match, dann
/// ein `WalkEvent` an den Consumer. Berührt **kein** `on_file` und keine
/// Consumer-Stats. Der globale Hit-Zähler (`hit_counter`) ist eine
/// Näherung: erreicht er den Deckel, schalten die Worker in den Probe-Modus.
/// `cancel`/`stop_flag` → [`WalkState::Quit`].
#[allow(clippy::too_many_arguments)]
fn walk_worker_visit(
    result: Result<ignore::DirEntry, ignore::Error>,
    re: &Regex,
    filter: &FileFilter,
    cancel: &AtomicBool,
    hit_counter: &AtomicUsize,
    stop_flag: &AtomicBool,
    tx: &mpsc::Sender<WalkEvent>,
) -> WalkState {
    if cancel.load(Ordering::Relaxed) || stop_flag.load(Ordering::Relaxed) {
        return WalkState::Quit;
    }
    let entry = match result {
        Ok(e) => e,
        Err(_) => return WalkState::Continue,
    };
    if !entry.file_type().is_some_and(|t| t.is_file()) {
        return WalkState::Continue;
    }
    if !filter.accepts(entry.path()) {
        return WalkState::Continue;
    }
    let norm = normalize_path(entry.path());

    // Probe-Modus: der globale Deckel ist (näherungsweise) erreicht. Nur noch
    // prüfen, ob es weitere echte Treffer gibt — kein voller Scan, kein
    // `files_scanned`.
    if hit_counter.load(Ordering::Relaxed) >= MAX_HITS_TOTAL {
        if let ContentGate::Ok(content) = worker_read_disk(entry.path()) {
            if probe_str(&content, re, cancel) {
                let _ = tx.send(WalkEvent::ProbeHit { path: norm });
                stop_flag.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
        }
        return WalkState::Continue;
    }

    match worker_read_disk(entry.path()) {
        ContentGate::TooLarge => {
            let _ = tx.send(WalkEvent::SkippedLarge { path: norm });
        }
        ContentGate::Skip => {}
        ContentGate::Ok(content) => {
            let (hits, perfile_truncated, cancelled) =
                build_file_hits(&content, re, MAX_HITS_PER_FILE, cancel);
            if cancelled {
                return WalkState::Quit;
            }
            if hits.is_empty() {
                let _ = tx.send(WalkEvent::NoHit { path: norm });
            } else {
                // Näherungszähler früh erhöhen, damit andere Worker zeitnah in
                // den Probe-Modus schalten (exakte Buchführung bleibt Consumer).
                hit_counter.fetch_add(hits.len(), Ordering::Relaxed);
                let file_name = Path::new(&norm)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let _ = tx.send(WalkEvent::Matched(FileResult {
                    path: norm,
                    file_name,
                    hits,
                    truncated: perfile_truncated,
                }));
            }
        }
    }
    WalkState::Continue
}

/// Consumer-Seite der parallelen Verzeichnis-Phase (läuft auf dem aufrufenden
/// Thread): konsumiert Worker-Events, dedupliziert über `seen`, führt Stats +
/// Caps exakt (die per-Datei-50 haben die Worker geklemmt, den globalen 500er
/// klemmt hier der Consumer) und ruft als EINZIGER `on_file`. Rückgabe
/// `true` = Lauf gestoppt (kein Einzeldatei-Nachlauf mehr). Spiegelt die
/// Cap-/Probe-Semantik von [`process_content`].
///
/// **Cancel-Vertrag** [Sol-Rev S6#1]: `cancel` wird vor JEDEM Event geprüft.
/// Ist das Flag gesetzt (Nutzer-Abbruch / Timeout), setzt der Consumer den
/// internen `stop_flag` (bremst die Worker) und kehrt sofort mit „stopped"
/// zurück — es werden also keine bereits gepufferten Events mehr angewandt
/// (kein weiterer `on_file`) und die Einzeldatei-Nachlaufphase entfällt.
fn consume_walk_events(
    rx: mpsc::Receiver<WalkEvent>,
    cancel: &AtomicBool,
    stats: &mut SearchStats,
    seen: &mut HashSet<String>,
    probing: &mut bool,
    stop_flag: &AtomicBool,
    on_file: &mut dyn FnMut(FileResult),
) -> bool {
    for event in rx {
        // Vor jedem gepufferten Event auf Abbruch prüfen: nach einem Cancel
        // darf der Consumer keine nachlaufenden Treffer mehr melden.
        if cancel.load(Ordering::Relaxed) {
            stop_flag.store(true, Ordering::Relaxed);
            return true;
        }
        match event {
            WalkEvent::SkippedLarge { path } => {
                if seen.insert(path) {
                    stats.skipped_large += 1;
                }
            }
            WalkEvent::NoHit { path } => {
                if !seen.insert(path) {
                    continue;
                }
                // Nach dem Deckel zählt sequenziell nur noch der Probe-Modus
                // (kein `files_scanned`) — dieselbe Grenze hier.
                if stats.hits < MAX_HITS_TOTAL {
                    stats.files_scanned += 1;
                }
            }
            WalkEvent::ProbeHit { path } => {
                if !seen.insert(path) {
                    continue;
                }
                stats.truncated = true;
                stop_flag.store(true, Ordering::Relaxed);
                return true;
            }
            WalkEvent::Matched(file) => {
                if !seen.insert(file.path.clone()) {
                    continue;
                }
                let remaining = MAX_HITS_TOTAL - stats.hits;
                if remaining == 0 {
                    // Voll-Scan-Ergebnis nach bereits vollem Deckel → es gibt
                    // real mehr Treffer, als gemeldet werden.
                    stats.truncated = true;
                    stop_flag.store(true, Ordering::Relaxed);
                    return true;
                }
                stats.files_scanned += 1;
                let perfile_truncated = file.truncated;
                let mut hits = file.hits;
                let mut cut = false;
                if hits.len() > remaining {
                    hits.truncate(remaining);
                    cut = true;
                }
                stats.hits += hits.len();
                stats.files_matched += 1;
                on_file(FileResult {
                    path: file.path,
                    file_name: file.file_name,
                    hits,
                    truncated: perfile_truncated || cut,
                });
                if cut {
                    stats.truncated = true;
                    stop_flag.store(true, Ordering::Relaxed);
                    return true;
                }
                if stats.hits == MAX_HITS_TOTAL {
                    if perfile_truncated {
                        // Die Datei, die den Deckel exakt füllt, war selbst
                        // gekappt → es gibt real mehr Treffer.
                        stats.truncated = true;
                        stop_flag.store(true, Ordering::Relaxed);
                        return true;
                    }
                    // Exakt gefüllt, kein Cut → Probe-Modus. Die Worker sind
                    // über den Näherungszähler bereits (≥500) umgeschaltet.
                    *probing = true;
                }
            }
        }
    }
    false
}

/// Parallele Verzeichnis-Phase: pro Root-Ordner ein `build_parallel()`-Walk
/// (gleiche Filterkonfiguration wie sequenziell — hidden/gitignore-Defaults
/// bzw. `include_hidden`-Opt-in).
/// Ein Producer-Thread treibt die Walks und speist einen `mpsc`-Kanal; dieser
/// Thread (Consumer) liest ihn über [`consume_walk_events`]. `on_file`/`stats`/
/// `seen`/`probing` gehören exklusiv dem Consumer-Thread (der `&mut dyn FnMut`-
/// Vertrag wandert nie in einen Worker). Rückgabe `true` = gestoppt.
#[allow(clippy::too_many_arguments)]
fn walk_dirs_parallel(
    dirs: &[PathBuf],
    re: &Regex,
    filter: &FileFilter,
    include_hidden: bool,
    cancel: &AtomicBool,
    stats: &mut SearchStats,
    seen: &mut HashSet<String>,
    probing: &mut bool,
    on_file: &mut dyn FnMut(FileResult),
) -> bool {
    if dirs.is_empty() {
        return false;
    }

    // [Sol-Rev S6#2] Überlappende Dir-Roots VOR dem Parallel-Walk kollabieren.
    // Sonst besuchen zwei Walks (Kind + Eltern) dieselbe Datei; der worker-
    // seitige Näherungs-Hit-Zähler zählt sie doppelt gegen `MAX_HITS_TOTAL` und
    // könnte den Walk in den Probe-Modus zwingen, bevor nicht-redundante Dateien
    // besucht sind — Ergebnis wäre unvollständig, ohne dass `truncated` gesetzt
    // wird. Nach dem Kollabieren trifft jede Datei höchstens ein Walk, der
    // Consumer-`seen` bleibt nur noch Netz für die geteilte Pinned-Phase.
    let dirs = collapse_overlapping_dirs(dirs);

    let hit_counter = AtomicUsize::new(0);
    let stop_flag = AtomicBool::new(false);
    let (tx, rx) = mpsc::channel::<WalkEvent>();

    let hc = &hit_counter;
    let sf = &stop_flag;
    let dirs = &dirs;
    let mut stopped = false;

    std::thread::scope(|scope| {
        // Producer: treibt die parallelen Walks und schließt beim Verlassen
        // seine `tx`-Instanz (→ `rx` endet, sobald alle Worker-Clones weg sind).
        scope.spawn(move || {
            for dir in dirs {
                if cancel.load(Ordering::Relaxed) || sf.load(Ordering::Relaxed) {
                    break;
                }
                let dir_tx = tx.clone();
                let mut builder = WalkBuilder::new(dir);
                apply_include_hidden(&mut builder, include_hidden);
                builder.build_parallel().run(|| {
                    let wtx = dir_tx.clone();
                    Box::new(move |result| {
                        walk_worker_visit(result, re, filter, cancel, hc, sf, &wtx)
                    })
                });
            }
        });

        // Consumer (dieser Thread): einziger Aufrufer von `on_file`.
        stopped = consume_walk_events(rx, cancel, stats, seen, probing, sf, on_file);
    });

    stopped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{CatalogRegistry, ResolvedLanguage, Translator};
    use crate::workspace::PinnedItem;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use tempfile::TempDir;

    fn translator(tag: &str) -> Translator {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("locales");
        let registry = CatalogRegistry::load_from_dir(&dir).expect("load locales");
        Translator::new(
            registry,
            ResolvedLanguage {
                catalog_tag: tag.to_string(),
                format_locale: "en-US".to_string(),
            },
        )
    }

    #[test]
    fn search_error_localizes_frame_and_preserves_detail() {
        let error = SearchError::InvalidScope("/technical/path".to_string());
        let message = error.localized(&translator("en"));
        assert!(message.contains("Invalid search path"), "message={message}");
        assert!(message.contains("/technical/path"), "message={message}");
    }

    #[test]
    fn search_error_has_a_preboot_key_fallback_with_detail() {
        let error = SearchError::RootNotFound("/technical/path".to_string());
        assert_eq!(
            "errors.search.rootNotFound: /technical/path",
            error.key_fallback()
        );
    }

    // --- Fixture-Helfer ------------------------------------------------------

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn write_bytes(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, bytes).unwrap();
    }

    /// Minimales Fake-Repo, damit `ignore::WalkBuilder` .gitignore ehrt
    /// (require_git-Default).
    fn init_git(root: &Path) {
        let git = root.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    fn dir_roots(p: &Path) -> SearchRoots {
        SearchRoots {
            dirs: vec![p.to_path_buf()],
            files: vec![],
        }
    }

    fn pin_dir(p: &Path) -> PinnedItem {
        PinnedItem {
            path: p.to_string_lossy().to_string(),
            is_directory: true,
        }
    }

    fn pin_file(p: &Path) -> PinnedItem {
        PinnedItem {
            path: p.to_string_lossy().to_string(),
            is_directory: false,
        }
    }

    /// Führt eine Suche aus und sammelt Streaming-Ergebnisse + Stats.
    fn collect(
        roots: &SearchRoots,
        query: &str,
        opts: &SearchOptions,
    ) -> (Vec<FileResult>, SearchStats) {
        let cancel = AtomicBool::new(false);
        let mut files: Vec<FileResult> = Vec::new();
        let stats = run_search(roots, query, opts, &cancel, &mut |f| files.push(f)).unwrap();
        (files, stats)
    }

    fn names(files: &[FileResult]) -> Vec<String> {
        files.iter().map(|f| f.file_name.clone()).collect()
    }

    // --- UTF-16-Spalten ------------------------------------------------------

    #[test]
    fn utf16_columns_with_umlaut_and_emoji() {
        // Zeile: "äß😀 needle" — vor "needle" stehen ä(1) + ß(1) + 😀(2,
        // Surrogatpaar) + Leerzeichen(1) = 5 UTF-16-Code-Units. Damit ist
        // colUtf16 (1-based) = 6, lenUtf16 = 6, ranges (0-based im Snippet) = [[5,6]].
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "äß😀 needle\n");

        let (files, _) = collect(&dir_roots(tmp.path()), "needle", &SearchOptions::default());
        assert_eq!(1, files.len());
        let hit = &files[0].hits[0];
        assert_eq!(1, hit.line);
        assert_eq!(6, hit.col_utf16);
        assert_eq!(6, hit.len_utf16);
        assert_eq!("äß😀 needle", hit.snippet);
        assert_eq!(0, hit.snippet_offset_utf16);
        assert_eq!(vec![[5u32, 6]], hit.ranges);
    }

    // --- CRLF ----------------------------------------------------------------

    #[test]
    fn crlf_line_numbers_and_snippet_without_cr() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "note.md",
            "erste zeile\r\nfoo bar baz\r\nletzte\r\n",
        );

        let (files, _) = collect(&dir_roots(tmp.path()), "bar", &SearchOptions::default());
        assert_eq!(1, files.len());
        let hit = &files[0].hits[0];
        assert_eq!(2, hit.line);
        assert_eq!(5, hit.col_utf16); // "foo " = 4 Units davor
        assert_eq!(3, hit.len_utf16);
        assert_eq!("foo bar baz", hit.snippet);
        assert!(
            !hit.snippet.contains('\r'),
            "Snippet darf kein CR enthalten"
        );
        assert_eq!(vec![[4u32, 3]], hit.ranges);
    }

    // --- Caps / Truncation ---------------------------------------------------

    #[test]
    fn per_file_cap_flags_truncated() {
        let tmp = TempDir::new().unwrap();
        let mut content = String::new();
        for i in 0..60 {
            content.push_str(&format!("zeile {i} match\n"));
        }
        write(tmp.path(), "note.md", &content);

        let (files, stats) = collect(&dir_roots(tmp.path()), "match", &SearchOptions::default());
        assert_eq!(1, files.len());
        assert_eq!(MAX_HITS_PER_FILE, files[0].hits.len());
        assert!(files[0].truncated);
        // Globaler Deckel nicht erreicht (50 < 500).
        assert!(!stats.truncated);
    }

    #[test]
    fn global_cap_flags_stats_truncated() {
        let tmp = TempDir::new().unwrap();
        // 12 Dateien × je 50 (gekappte) Treffer = 600 potentielle Hits > 500.
        for f in 0..12 {
            let mut content = String::new();
            for i in 0..60 {
                content.push_str(&format!("z{i} match\n"));
            }
            write(tmp.path(), &format!("file_{f:02}.md"), &content);
        }

        let (_files, stats) = collect(&dir_roots(tmp.path()), "match", &SearchOptions::default());
        assert!(stats.truncated, "globaler Deckel muss greifen");
        assert!(
            stats.hits <= MAX_HITS_TOTAL,
            "Hits dürfen den Deckel nicht überschreiten"
        );
    }

    // --- Overlap-Dedup -------------------------------------------------------

    #[test]
    fn resolve_scope_collapses_nested_dirs_keeps_file_pins() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("a.md");
        fs::write(&file, "needle\n").unwrap();

        let pinned = vec![pin_dir(root), pin_dir(&sub), pin_file(&file)];
        let roots = resolve_scope(&pinned, &SearchScope::Vault);

        // Nur der oberste Ordner bleibt; verschachtelter Unterordner fällt weg.
        // Explizit gepinnte Einzeldatei bleibt (Pin-Bypass / seen-Dedup).
        assert_eq!(vec![root.to_path_buf()], roots.dirs);
        assert_eq!(vec![file], roots.files);
    }

    #[test]
    fn overlap_dedup_each_file_searched_once() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write(root, "a.md", "needle\n");
        write(root, "sub/b.md", "needle\n");

        let pinned = vec![pin_dir(root), pin_dir(&sub)];
        let roots = resolve_scope(&pinned, &SearchScope::Vault);
        let (files, _) = collect(&roots, "needle", &SearchOptions::default());

        assert_eq!(2, files.len());
        assert_eq!(1, files.iter().filter(|f| f.file_name == "a.md").count());
        assert_eq!(1, files.iter().filter(|f| f.file_name == "b.md").count());
    }

    // --- gitignore / hidden --------------------------------------------------

    #[test]
    fn skips_gitignored_and_hidden_entries() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_git(root);
        write(root, ".gitignore", "secret.md\n");
        write(root, "visible.md", "needle\n");
        write(root, "secret.md", "needle\n"); // gitignored
        write(root, ".hidden.md", "needle\n"); // hidden file
        write(root, ".hiddendir/inside.md", "needle\n"); // hidden dir

        let (files, _) = collect(&dir_roots(root), "needle", &SearchOptions::default());
        assert_eq!(vec!["visible.md".to_string()], names(&files));
    }

    #[test]
    fn include_hidden_finds_hidden_and_gitignored() {
        // Opt-in: hidden Datei, Datei in hidden Dir und gitignorierte Datei.
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_git(root);
        write(root, ".gitignore", "secret.md\n");
        write(root, "visible.md", "needle\n");
        write(root, "secret.md", "needle gitignored\n");
        write(root, ".hidden.md", "needle hidden file\n");
        write(root, ".hiddendir/inside.md", "needle hidden dir\n");

        let opts = SearchOptions {
            include_hidden: true,
            ..SearchOptions::default()
        };
        let (files, stats) = collect(&dir_roots(root), "needle", &opts);
        let mut found = names(&files);
        found.sort();
        assert_eq!(
            vec![
                ".hidden.md".to_string(),
                "inside.md".to_string(),
                "secret.md".to_string(),
                "visible.md".to_string(),
            ],
            found
        );
        assert!(!stats.truncated);
    }

    #[test]
    fn include_hidden_still_skips_binary_and_oversized() {
        // Flag an ändert nichts an Cap/Binary-Sniff.
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_git(root);
        write(root, ".gitignore", "secret.md\n");
        write(root, "visible.md", "needle\n");
        write(root, "secret.md", "needle\n");
        write(root, ".hidden.md", "needle\n");
        write_bytes(root, "fake.md", b"vorher \0\0 needle nachher\n");
        let mut big = String::from("needle\n");
        big.push_str(&"a".repeat(MAX_FILE_SIZE as usize + 10));
        write(root, "big.md", &big);

        let opts = SearchOptions {
            include_hidden: true,
            ..SearchOptions::default()
        };
        let (files, stats) = collect(&dir_roots(root), "needle", &opts);
        let mut found = names(&files);
        found.sort();
        assert_eq!(
            vec![
                ".hidden.md".to_string(),
                "secret.md".to_string(),
                "visible.md".to_string(),
            ],
            found
        );
        assert_eq!(1, stats.skipped_large);
        assert!(!found.iter().any(|n| n == "fake.md"));
        assert!(!found.iter().any(|n| n == "big.md"));
    }

    #[test]
    fn include_hidden_parallel_matches_sequential() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_git(root);
        write(root, ".gitignore", "secret.md\n");
        write(root, "visible.md", "needle\n");
        write(root, "secret.md", "needle secret\n");
        write(root, ".hidden.md", "needle hidden\n");
        write(root, ".hiddendir/inside.md", "needle deep\n");

        let o = ExtendedSearchOptions {
            base: SearchOptions {
                include_hidden: true,
                ..SearchOptions::default()
            },
            regex: false,
            filter: FileFilter::AllText,
        };
        let roots = dir_roots(root);
        let (seq_files, seq_stats) = collect_ex(&roots, "needle", &o);
        let (par_files, par_stats) = collect_parallel(&roots, "needle", &o);
        assert_stats_core_eq(&seq_stats, &par_stats);
        assert_eq!(as_map(&seq_files), as_map(&par_files));
        assert_eq!(4, par_files.len());
    }

    #[test]
    fn include_hidden_skips_dot_git_directory() {
        // Auch mit includeHidden bleibt .git draußen (Produktentscheid).
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_git(root);
        write(root, "visible.md", "needle\n");
        // Datei unter .git/ — würde nur bei abgeschaltetem hidden-Filter sichtbar.
        write(root, ".git/hooks/pre-commit.md", "needle in git hooks\n");
        write(root, ".git/COMMIT_EDITMSG.md", "needle in commit msg\n");

        let opts = SearchOptions {
            include_hidden: true,
            ..SearchOptions::default()
        };
        let (files, _) = collect(&dir_roots(root), "needle", &opts);
        assert_eq!(vec!["visible.md".to_string()], names(&files));
    }

    #[test]
    fn pinned_hidden_and_gitignored_under_dir_found_once_seq_and_parallel() {
        // Pin-Bypass: Ordner-Pin + explizit gepinnte hidden/gitignorierte Dateien
        // darunter, includeHidden=false → Einzeldatei-Phase findet sie (genau 1×).
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_git(root);
        write(root, ".gitignore", "secret.md\n");
        write(root, "visible.md", "needle\n");
        write(root, "secret.md", "needle secret\n");
        write(root, ".hidden.md", "needle hidden\n");

        let hidden = root.join(".hidden.md");
        let secret = root.join("secret.md");
        let pinned = vec![pin_dir(root), pin_file(&hidden), pin_file(&secret)];
        let roots = resolve_scope(&pinned, &SearchScope::Vault);
        // Beide Datei-Pins bleiben trotz Elternordner-Überdeckung.
        assert!(roots.files.iter().any(|f| f == &hidden));
        assert!(roots.files.iter().any(|f| f == &secret));

        let o = ExtendedSearchOptions {
            base: SearchOptions::default(), // include_hidden: false
            regex: false,
            filter: FileFilter::AllText,
        };
        let (seq_files, seq_stats) = collect_ex(&roots, "needle", &o);
        let (par_files, par_stats) = collect_parallel(&roots, "needle", &o);
        assert_stats_core_eq(&seq_stats, &par_stats);
        assert_eq!(as_map(&seq_files), as_map(&par_files));

        let mut found = names(&seq_files);
        found.sort();
        assert_eq!(
            vec![
                ".hidden.md".to_string(),
                "secret.md".to_string(),
                "visible.md".to_string(),
            ],
            found
        );
        // Genau einmal je Datei (Walk + Pin-Phase über seen dedupliziert).
        assert_eq!(
            1,
            seq_files
                .iter()
                .filter(|f| f.file_name == ".hidden.md")
                .count()
        );
        assert_eq!(
            1,
            seq_files
                .iter()
                .filter(|f| f.file_name == "secret.md")
                .count()
        );
        assert_eq!(
            1,
            seq_files
                .iter()
                .filter(|f| f.file_name == "visible.md")
                .count()
        );
    }

    // --- NUL-Sniff -----------------------------------------------------------

    #[test]
    fn skips_binary_by_nul_sniff() {
        let tmp = TempDir::new().unwrap();
        // .md-Endung, aber NUL-Bytes in den ersten 8 KiB → als Binär erkannt.
        write_bytes(tmp.path(), "fake.md", b"vorher \0\0 needle nachher\n");
        write(tmp.path(), "real.md", "needle\n");

        let (files, _) = collect(&dir_roots(tmp.path()), "needle", &SearchOptions::default());
        assert_eq!(vec!["real.md".to_string()], names(&files));
    }

    // --- Größen-Cap ----------------------------------------------------------

    #[test]
    fn skips_oversized_file_and_counts_it() {
        let tmp = TempDir::new().unwrap();
        let mut big = String::from("needle\n");
        big.push_str(&"a".repeat(MAX_FILE_SIZE as usize + 10));
        write(tmp.path(), "big.md", &big);
        write(tmp.path(), "small.md", "needle\n");

        let (files, stats) = collect(&dir_roots(tmp.path()), "needle", &SearchOptions::default());
        assert_eq!(vec!["small.md".to_string()], names(&files));
        assert_eq!(1, stats.skipped_large);
    }

    // --- Mindestlänge --------------------------------------------------------

    #[test]
    fn rejects_too_short_query() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "needle\n");
        let roots = dir_roots(tmp.path());
        let cancel = AtomicBool::new(false);

        assert!(matches!(
            run_search(&roots, "", &SearchOptions::default(), &cancel, &mut |_| {}),
            Err(SearchError::QueryTooShort)
        ));
        assert!(matches!(
            run_search(&roots, "a", &SearchOptions::default(), &cancel, &mut |_| {}),
            Err(SearchError::QueryTooShort)
        ));
    }

    #[test]
    fn min_query_len_counts_chars_not_bytes() {
        // "ä" ist 1 Zeichen, aber 2 UTF-8-Bytes — eine byte-basierte
        // Längenprüfung (query.len()) würde es fälschlich durchlassen.
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "äö needle\n");
        let roots = dir_roots(tmp.path());
        let cancel = AtomicBool::new(false);

        assert!(matches!(
            run_search(&roots, "ä", &SearchOptions::default(), &cancel, &mut |_| {}),
            Err(SearchError::QueryTooShort)
        ));
        // "äö" = 2 Zeichen → gültig und trifft.
        let (files, _) = collect(&roots, "äö", &SearchOptions::default());
        assert_eq!(1, files.len());
    }

    // --- case_sensitive ------------------------------------------------------

    #[test]
    fn case_insensitive_matches_both_cases() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "Hallo Welt\nhallo welt\n");

        let opts = SearchOptions {
            case_sensitive: false,
            whole_word: false,
            include_hidden: false,
        };
        let (files, _) = collect(&dir_roots(tmp.path()), "hallo", &opts);
        assert_eq!(1, files.len());
        assert_eq!(2, files[0].hits.len()); // "Hallo" + "hallo"
    }

    #[test]
    fn case_sensitive_matches_only_exact_case() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "Hallo Welt\nhallo welt\n");

        let opts = SearchOptions {
            case_sensitive: true,
            whole_word: false,
            include_hidden: false,
        };
        let (files, _) = collect(&dir_roots(tmp.path()), "hallo", &opts);
        assert_eq!(1, files.len());
        assert_eq!(1, files[0].hits.len()); // nur Zeile 2 "hallo"
        assert_eq!(2, files[0].hits[0].line);
    }

    #[test]
    fn case_insensitive_uses_simple_case_folding_not_ss_fold() {
        // regex `(?i)` macht Unicode *simple* case folding: „ß" faltet auf
        // sich selbst, NICHT auf „ss"/„SS". Daher matcht „STRASSE" NICHT
        // „Straße", aber „straße" schon (nur S↔s unterscheiden sich).
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "Die Straße ist breit\n");
        let opts = SearchOptions::default(); // case-insensitive

        let (no_hit, _) = collect(&dir_roots(tmp.path()), "STRASSE", &opts);
        assert!(no_hit.is_empty(), "ß≠ss: kein Treffer erwartet");

        let (hit, _) = collect(&dir_roots(tmp.path()), "straße", &opts);
        assert_eq!(1, hit.len());
    }

    // --- whole_word ----------------------------------------------------------

    #[test]
    fn whole_word_toggle() {
        let tmp = TempDir::new().unwrap();
        // "foobar foo bar": "foo" bei Index 0 (in "foobar") und Index 7 (allein).
        write(tmp.path(), "note.md", "foobar foo bar\n");

        let ww = SearchOptions {
            case_sensitive: false,
            whole_word: true,
            include_hidden: false,
        };
        let (files, _) = collect(&dir_roots(tmp.path()), "foo", &ww);
        assert_eq!(1, files.len());
        let hit = &files[0].hits[0];
        assert_eq!(vec![[7u32, 3]], hit.ranges); // nur das freistehende "foo"
        assert_eq!(8, hit.col_utf16);

        let off = SearchOptions {
            case_sensitive: false,
            whole_word: false,
            include_hidden: false,
        };
        let (files2, _) = collect(&dir_roots(tmp.path()), "foo", &off);
        assert_eq!(vec![[0u32, 3], [7u32, 3]], files2[0].hits[0].ranges);
    }

    #[test]
    fn whole_word_respects_unicode_boundaries() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "ein café hier\n");
        let ww = SearchOptions {
            case_sensitive: false,
            whole_word: true,
            include_hidden: false,
        };

        // "caf" ist kein ganzes Wort (é ist Wortzeichen) → kein Treffer.
        let (no_hit, _) = collect(&dir_roots(tmp.path()), "caf", &ww);
        assert!(no_hit.is_empty());

        // Das ganze Wort "café" trifft.
        let (hit, _) = collect(&dir_roots(tmp.path()), "café", &ww);
        assert_eq!(1, hit.len());
    }

    // --- Ordner- vs. Vault-Scope --------------------------------------------

    #[test]
    fn folder_scope_vs_vault_scope() {
        let tmp = TempDir::new().unwrap();
        let dir_a = tmp.path().join("A");
        let dir_b = tmp.path().join("B");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        write(&dir_a, "a.md", "needle\n");
        write(&dir_b, "b.md", "needle\n");
        let pinned = vec![pin_dir(&dir_a), pin_dir(&dir_b)];

        let vault = resolve_scope(&pinned, &SearchScope::Vault);
        let (all, _) = collect(&vault, "needle", &SearchOptions::default());
        assert_eq!(2, all.len());

        let folder = resolve_scope(
            &pinned,
            &SearchScope::Folder(dir_a.to_string_lossy().into()),
        );
        let (only_a, _) = collect(&folder, "needle", &SearchOptions::default());
        assert_eq!(vec!["a.md".to_string()], names(&only_a));
    }

    #[test]
    fn pinned_single_file_is_searched() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "a.md", "needle\n");
        write(tmp.path(), "b.md", "needle\n");
        let file_a = tmp.path().join("a.md");

        let roots = resolve_scope(&[pin_file(&file_a)], &SearchScope::Vault);
        assert!(roots.dirs.is_empty());
        assert_eq!(vec![file_a.clone()], roots.files);

        let (files, _) = collect(&roots, "needle", &SearchOptions::default());
        assert_eq!(vec!["a.md".to_string()], names(&files));
    }

    #[test]
    fn resolve_scope_vault_drops_dead_pins() {
        // Entscheidung (Abnahme S1a, 2026-07-12): Pins können veralten —
        // der Vault-Scope überspringt nicht mehr existente Roots STILL.
        // `RootNotFound` bleibt dem expliziten Ordner-Scope bzw. direkt
        // übergebenen `SearchRoots` (siehe `nonexistent_root_is_error`)
        // vorbehalten.
        let tmp = TempDir::new().unwrap();
        let alive = tmp.path().join("alive");
        fs::create_dir_all(&alive).unwrap();
        write(&alive, "a.md", "needle\n");
        let dead_dir = tmp.path().join("gone");
        let dead_file = tmp.path().join("gone.md");

        let pinned = vec![pin_dir(&alive), pin_dir(&dead_dir), pin_file(&dead_file)];
        let roots = resolve_scope(&pinned, &SearchScope::Vault);

        assert_eq!(vec![alive.clone()], roots.dirs);
        assert!(roots.files.is_empty());

        let (files, _) = collect(&roots, "needle", &SearchOptions::default());
        assert_eq!(vec!["a.md".to_string()], names(&files));
    }

    #[test]
    fn nonexistent_root_is_error() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let roots = SearchRoots {
            dirs: vec![missing],
            files: vec![],
        };
        let cancel = AtomicBool::new(false);
        assert!(matches!(
            run_search(
                &roots,
                "needle",
                &SearchOptions::default(),
                &cancel,
                &mut |_| {}
            ),
            Err(SearchError::RootNotFound(_))
        ));
    }

    // --- Cancel --------------------------------------------------------------

    #[test]
    fn cancel_flag_aborts_before_scanning() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "needle\n");
        let roots = dir_roots(tmp.path());

        let cancel = AtomicBool::new(true); // schon vor Start gesetzt
        let mut files: Vec<FileResult> = Vec::new();
        let stats = run_search(
            &roots,
            "needle",
            &SearchOptions::default(),
            &cancel,
            &mut |f| files.push(f),
        )
        .unwrap();

        assert!(files.is_empty());
        assert_eq!(0, stats.files_scanned);
        assert_eq!(0, stats.hits);
    }

    // --- Mehrere Treffer pro Zeile ------------------------------------------

    #[test]
    fn multiple_matches_in_one_line_yield_single_hit_with_ranges() {
        let tmp = TempDir::new().unwrap();
        // "ab cd ab ef ab": "ab" bei 0, 6, 12.
        write(tmp.path(), "note.md", "ab cd ab ef ab\n");

        let (files, _) = collect(&dir_roots(tmp.path()), "ab", &SearchOptions::default());
        assert_eq!(1, files.len());
        assert_eq!(1, files[0].hits.len(), "eine Zeile = ein Hit");
        let hit = &files[0].hits[0];
        assert_eq!(vec![[0u32, 2], [6u32, 2], [12u32, 2]], hit.ranges);
        assert_eq!(1, hit.col_utf16); // erster Treffer bei Spalte 1
    }

    // --- Snippet-Fensterung --------------------------------------------------

    #[test]
    fn long_line_snippet_is_windowed_around_first_match() {
        // Invariantenbasiert (die exakte Fenstergröße „~240" ist bewusst
        // Implementierungs-Spielraum): bei einer 800+-Zeichen-Zeile mit dem
        // Treffer in der Mitte muss das Snippet gefenstert sein, die
        // Koordinaten müssen konsistent bleiben. Bewusst reines ASCII, damit
        // UTF-16-Units == Byte-Offsets und String-Slicing im Test trivial ist.
        let tmp = TempDir::new().unwrap();
        let line = format!("{} needle {}", "a".repeat(400), "b".repeat(400));
        write(tmp.path(), "note.md", &format!("{line}\n"));

        let (files, _) = collect(&dir_roots(tmp.path()), "needle", &SearchOptions::default());
        assert_eq!(1, files.len());
        let hit = &files[0].hits[0];

        // Absolute Position: 400 a's + Leerzeichen davor → 0-based 401, col 402.
        assert_eq!(402, hit.col_utf16);
        assert_eq!(6, hit.len_utf16);

        // Gefenstert: deutlich kürzer als die Originalzeile, Obergrenze
        // großzügig über der Spec-Richtgröße ~240.
        let snip_len = hit.snippet.encode_utf16().count() as u32;
        assert!(
            snip_len <= 300,
            "Snippet muss gefenstert sein (ist {snip_len} Units)"
        );

        // Koordinaten-Kopplung: snippet_offset + range.start == col - 1.
        assert_eq!(1, hit.ranges.len());
        let [start, len] = hit.ranges[0];
        assert_eq!(6, len);
        assert_eq!(hit.col_utf16 - 1, hit.snippet_offset_utf16 + start);
        assert!(start + len <= snip_len, "Range muss im Snippet liegen");

        // Der Range zeigt im Snippet wirklich auf den Suchbegriff.
        let s = start as usize;
        assert_eq!("needle", &hit.snippet[s..s + 6]);
    }

    // --- Deterministische Reihenfolge ---------------------------------------

    #[test]
    fn results_are_sorted_by_file_name() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "c.md", "needle\n");
        write(tmp.path(), "a.md", "needle\n");
        write(tmp.path(), "b.md", "needle\n");

        let (files, _) = collect(&dir_roots(tmp.path()), "needle", &SearchOptions::default());
        assert_eq!(
            vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()],
            names(&files)
        );
    }

    // --- FileKind-Filter -----------------------------------------------------

    #[test]
    fn filekind_filter_only_markdown_and_text() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "needle\n");
        write(tmp.path(), "data.txt", "needle\n");
        write(tmp.path(), "code.rs", "needle\n");
        // Binär/Image: werden übersprungen, obwohl die Bytes "needle" enthalten.
        write_bytes(tmp.path(), "pic.png", b"needle-bytes\n");
        write_bytes(tmp.path(), "arch.zip", b"needle-bytes\n");

        let (files, _) = collect(&dir_roots(tmp.path()), "needle", &SearchOptions::default());
        assert_eq!(
            vec![
                "code.rs".to_string(),
                "data.txt".to_string(),
                "note.md".to_string()
            ],
            names(&files)
        );
    }

    // --- Fix-Paket S1: zusätzliche Tests (nur Additionen) --------------------

    #[test]
    fn long_query_first_match_stays_in_window() {
        // Fix 2: Ist der erste Match selbst länger als die Fenster-Richtgröße,
        // muss das Fenster bis zu dessen Ende reichen — ranges[0] existiert und
        // die Kopplung snippetOffset + ranges[0].start == colUtf16 - 1 hält.
        let tmp = TempDir::new().unwrap();
        let query = "q".repeat(300);
        let line = format!("{}{}{}", "a".repeat(50), query, "b".repeat(50));
        write(tmp.path(), "note.md", &format!("{line}\n"));

        let (files, _) = collect(&dir_roots(tmp.path()), &query, &SearchOptions::default());
        assert_eq!(1, files.len());
        let hit = &files[0].hits[0];
        assert_eq!(51, hit.col_utf16); // 50 a's davor
        assert_eq!(300, hit.len_utf16);
        assert!(!hit.ranges.is_empty(), "erster Match muss eine Range haben");
        let [start, len] = hit.ranges[0];
        assert_eq!(300, len);
        assert_eq!(hit.col_utf16 - 1, hit.snippet_offset_utf16 + start);
        // Der erste Match liegt vollständig im Snippet.
        let s = start as usize;
        assert_eq!(query, &hit.snippet[s..s + 300]);
    }

    #[test]
    fn relative_folder_scope_is_invalid() {
        // Fix 3: ein relativer Ordner-Root ist ungültig (nicht bloß „nicht
        // gefunden") — deterministisch InvalidScope, unabhängig von der Existenz.
        let roots = SearchRoots {
            dirs: vec![PathBuf::from("relative/dir")],
            files: vec![],
        };
        let cancel = AtomicBool::new(false);
        assert!(matches!(
            run_search(
                &roots,
                "needle",
                &SearchOptions::default(),
                &cancel,
                &mut |_| {}
            ),
            Err(SearchError::InvalidScope(_))
        ));
    }

    #[test]
    fn file_as_folder_scope_is_invalid() {
        // Fix 3: existierende Datei als Ordner-Root → InvalidScope (falscher Typ).
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("note.md");
        fs::write(&file, "needle\n").unwrap();
        let roots = SearchRoots {
            dirs: vec![file],
            files: vec![],
        };
        let cancel = AtomicBool::new(false);
        assert!(matches!(
            run_search(
                &roots,
                "needle",
                &SearchOptions::default(),
                &cancel,
                &mut |_| {}
            ),
            Err(SearchError::InvalidScope(_))
        ));
    }

    #[test]
    fn pinned_hidden_file_is_searched() {
        // Bewusste Entscheidung (Orchestrator): explizit gepinnte Einzeldateien
        // umgehen den hidden-/gitignore-Filter — der Pin ist Nutzer-Intention.
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), ".hidden.md", "needle in hidden\n");
        let hidden = tmp.path().join(".hidden.md");

        let roots = resolve_scope(&[pin_file(&hidden)], &SearchScope::Vault);
        assert_eq!(vec![hidden.clone()], roots.files);

        let (files, _) = collect(&roots, "needle", &SearchOptions::default());
        assert_eq!(vec![".hidden.md".to_string()], names(&files));
    }

    // --- S4-Additionen: FileFilter / Regex / OpenTabs-Puffer ----------------

    fn ext_opts(regex: bool, filter: FileFilter) -> ExtendedSearchOptions {
        ExtendedSearchOptions {
            base: SearchOptions::default(),
            regex,
            filter,
        }
    }

    fn collect_ex(
        roots: &SearchRoots,
        query: &str,
        o: &ExtendedSearchOptions,
    ) -> (Vec<FileResult>, SearchStats) {
        let cancel = AtomicBool::new(false);
        let mut files: Vec<FileResult> = Vec::new();
        let stats = run_search_ex(roots, query, o, &cancel, &mut |f| files.push(f)).unwrap();
        (files, stats)
    }

    fn collect_buffers(
        docs: &[BufferDoc],
        query: &str,
        o: &ExtendedSearchOptions,
    ) -> (Vec<FileResult>, SearchStats) {
        let cancel = AtomicBool::new(false);
        let mut files: Vec<FileResult> = Vec::new();
        let stats = run_search_buffers(docs, query, o, &cancel, &mut |f| files.push(f)).unwrap();
        (files, stats)
    }

    fn buffer_in_memory(path: &Path, text: &str) -> BufferDoc {
        BufferDoc {
            path: normalize_path(path),
            source: BufferSource::InMemory(text.to_string()),
        }
    }

    fn buffer_on_disk(path: &Path) -> BufferDoc {
        BufferDoc {
            path: normalize_path(path),
            source: BufferSource::OnDisk,
        }
    }

    #[test]
    fn parse_custom_extensions_grammar() {
        // Komma/Semikolon/Whitespace-Trennung, Punkt weg, lowercase.
        assert_eq!(
            vec!["md".to_string(), "txt".to_string(), "log".to_string()],
            parse_custom_extensions(".MD, txt ;log").unwrap()
        );
        // Dups (verschieden geschrieben) werden zusammengefasst, Reihenfolge
        // = erstes Vorkommen.
        assert_eq!(
            vec!["md".to_string()],
            parse_custom_extensions("md .md MD").unwrap()
        );
        // Nur Leerwerte/Trenner → leere Liste (Parse-Ebene kein Fehler).
        assert!(parse_custom_extensions("   , ; ").unwrap().is_empty());
        assert!(parse_custom_extensions("").unwrap().is_empty());
        // Erlaubt sind [a-z0-9_-].
        assert_eq!(
            vec!["c-h".to_string(), "a_b".to_string(), "h1".to_string()],
            parse_custom_extensions("c-h a_b h1").unwrap()
        );
        // Verbotene Zeichen → Fehler mit Original-Token.
        assert!(matches!(
            parse_custom_extensions("c++"),
            Err(SearchError::InvalidCustomExtension(t)) if t == "c++"
        ));
        assert!(matches!(
            parse_custom_extensions("mä"),
            Err(SearchError::InvalidCustomExtension(_))
        ));
    }

    #[test]
    fn file_filter_from_raw_maps_values_and_rejects_bad_input() {
        assert_eq!(
            FileFilter::Markdown,
            FileFilter::from_raw("markdown", "").unwrap()
        );
        assert_eq!(
            FileFilter::AllText,
            FileFilter::from_raw("allText", "").unwrap()
        );
        assert_eq!(
            FileFilter::Custom(vec!["foobar".to_string()]),
            FileFilter::from_raw("custom", ".FOOBAR").unwrap()
        );
        // Custom-Filter aktiv, aber leere Liste → Fehler.
        assert!(matches!(
            FileFilter::from_raw("custom", "  "),
            Err(SearchError::EmptyCustomExtensions)
        ));
        // Unbekannter Filter → Fehler mit Wert.
        assert!(matches!(
            FileFilter::from_raw("bogus", ""),
            Err(SearchError::UnknownFileFilter(v)) if v == "bogus"
        ));
    }

    #[test]
    fn file_filter_markdown_only_matches_markdown() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "needle\n");
        write(tmp.path(), "data.txt", "needle\n");
        let o = ext_opts(false, FileFilter::Markdown);
        let (files, _) = collect_ex(&dir_roots(tmp.path()), "needle", &o);
        assert_eq!(vec!["note.md".to_string()], names(&files));
    }

    #[test]
    fn file_filter_custom_matches_unknown_text_extension() {
        // `.foobar` liegt außerhalb TEXT_EXT → AllText überspringt es,
        // Custom(["foobar"]) nimmt es (classify()-Bypass, bewusstes Opt-in).
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "weird.foobar", "needle here\n");
        write(tmp.path(), "note.md", "needle here\n");

        let all_text = ext_opts(false, FileFilter::AllText);
        let (all, _) = collect_ex(&dir_roots(tmp.path()), "needle", &all_text);
        assert_eq!(vec!["note.md".to_string()], names(&all));

        let custom = ext_opts(false, FileFilter::Custom(vec!["foobar".to_string()]));
        let (files, _) = collect_ex(&dir_roots(tmp.path()), "needle", &custom);
        assert_eq!(vec!["weird.foobar".to_string()], names(&files));
    }

    #[test]
    fn file_filter_custom_still_skips_nul_binaries() {
        let tmp = TempDir::new().unwrap();
        write_bytes(tmp.path(), "bin.foobar", b"pre \0\0 needle\n");
        write(tmp.path(), "ok.foobar", "needle\n");
        let custom = ext_opts(false, FileFilter::Custom(vec!["foobar".to_string()]));
        let (files, _) = collect_ex(&dir_roots(tmp.path()), "needle", &custom);
        assert_eq!(vec!["ok.foobar".to_string()], names(&files));
    }

    #[test]
    fn regex_mode_matches_pattern() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "color colour\n");
        let o = ext_opts(true, FileFilter::AllText);
        let (files, _) = collect_ex(&dir_roots(tmp.path()), "colou?r", &o);
        assert_eq!(1, files.len());
        // "color" + "colour" auf derselben Zeile = 1 Hit mit 2 Ranges.
        assert_eq!(2, files[0].hits[0].ranges.len());
    }

    #[test]
    fn regex_off_treats_query_as_literal() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "a.b axb\n");
        // Ohne Regex ist "a.b" ein Literal → matcht nur "a.b", nicht "axb".
        let o = ext_opts(false, FileFilter::AllText);
        let (files, _) = collect_ex(&dir_roots(tmp.path()), "a.b", &o);
        assert_eq!(vec![[0u32, 3]], files[0].hits[0].ranges);
    }

    #[test]
    fn invalid_regex_pattern_is_rejected() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "note.md", "needle\n");
        let o = ext_opts(true, FileFilter::AllText);
        let cancel = AtomicBool::new(false);
        assert!(matches!(
            run_search_ex(
                &dir_roots(tmp.path()),
                "(unclosed",
                &o,
                &cancel,
                &mut |_| {}
            ),
            Err(SearchError::InvalidPattern(_))
        ));
    }

    #[test]
    fn regex_with_whole_word_is_rejected() {
        let o = ExtendedSearchOptions {
            base: SearchOptions {
                case_sensitive: false,
                whole_word: true,
                include_hidden: false,
            },
            regex: true,
            filter: FileFilter::AllText,
        };
        assert!(matches!(
            validate_query_ex("needle", &o),
            Err(SearchError::RegexWholeWordConflict)
        ));
        // Auch über den vollen Lauf (nicht nur die Vorabprüfung).
        let cancel = AtomicBool::new(false);
        let roots = SearchRoots::default();
        assert!(matches!(
            run_search_ex(&roots, "needle", &o, &cancel, &mut |_| {}),
            Err(SearchError::RegexWholeWordConflict)
        ));
    }

    #[test]
    fn zero_width_regex_matches_are_skipped() {
        let tmp = TempDir::new().unwrap();
        // "no such thing" enthält kein 'a' → `a*` matcht nur zero-width →
        // keine Treffer.
        write(tmp.path(), "note.md", "no such thing\n");
        let o = ext_opts(true, FileFilter::AllText);
        let (files, stats) = collect_ex(&dir_roots(tmp.path()), "a*", &o);
        assert!(files.is_empty(), "zero-width-only darf keine Hits liefern");
        assert_eq!(0, stats.hits);

        // Mit echten 'a's: nur die nicht-leeren Treffer zählen.
        write(tmp.path(), "note.md", "yaay\n");
        let (files2, _) = collect_ex(&dir_roots(tmp.path()), "a*", &o);
        assert_eq!(1, files2.len());
        assert_eq!(vec![[1u32, 2]], files2[0].hits[0].ranges); // "aa"
    }

    #[test]
    fn probe_mode_ignores_zero_width_only_candidate_after_cap() {
        let tmp = TempDir::new().unwrap();
        // 10 Dateien × exakt 50 Treffer-Zeilen = 500 = MAX_HITS_TOTAL ohne
        // per-Datei-Cut → Probe-Modus. Danach ein Kandidat, dessen einzige
        // "Treffer" zero-width sind → `truncated` darf NICHT gesetzt werden
        // [Sol-Rev2#2].
        for f in 0..10 {
            let body = "aaa\n".repeat(50);
            write(tmp.path(), &format!("cap_{f:02}.md"), &body);
        }
        write(tmp.path(), "zzz_zero.md", "no such thing here\n");
        let o = ext_opts(true, FileFilter::AllText);
        let (_files, stats) = collect_ex(&dir_roots(tmp.path()), "a*", &o);
        assert_eq!(MAX_HITS_TOTAL, stats.hits);
        assert!(
            !stats.truncated,
            "zero-width-only Kandidat im Probe-Modus darf truncated nicht setzen"
        );
    }

    #[test]
    fn buffers_search_in_memory_and_on_disk() {
        let tmp = TempDir::new().unwrap();
        let disk = tmp.path().join("disk.md");
        fs::write(&disk, "needle on disk\n").unwrap();
        let mem_path = tmp.path().join("buf.md");
        let docs = vec![
            buffer_in_memory(&mem_path, "needle in buffer\n"),
            buffer_on_disk(&disk),
        ];
        let o = ext_opts(false, FileFilter::AllText);
        let (files, stats) = collect_buffers(&docs, "needle", &o);
        assert_eq!(2, stats.files_matched);
        assert_eq!(2, files.len());
    }

    #[test]
    fn buffers_empty_in_memory_shadows_disk_content() {
        // Ein geladener, bewusst geleerter Puffer darf NICHT auf den alten
        // Disk-Inhalt zurückfallen [Sol-Rev2#1].
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("doc.md");
        fs::write(&path, "needle on disk only\n").unwrap();
        let docs = vec![buffer_in_memory(&path, "")];
        let o = ext_opts(false, FileFilter::AllText);
        let (files, stats) = collect_buffers(&docs, "needle", &o);
        assert!(files.is_empty());
        assert_eq!(1, stats.files_scanned);
        assert_eq!(0, stats.hits);
    }

    #[test]
    fn buffers_dedup_by_normalized_path() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("dup.md");
        let docs = vec![
            buffer_in_memory(&path, "needle one\nneedle two\n"),
            buffer_in_memory(&path, "needle three\n"),
        ];
        let o = ext_opts(false, FileFilter::AllText);
        let (files, _) = collect_buffers(&docs, "needle", &o);
        assert_eq!(1, files.len());
        assert_eq!(2, files[0].hits.len()); // erster Doc gewinnt
    }

    #[test]
    fn buffers_missing_on_disk_pending_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("gone.md");
        let docs = vec![buffer_on_disk(&missing)];
        let o = ext_opts(false, FileFilter::AllText);
        let (files, stats) = collect_buffers(&docs, "needle", &o);
        assert!(files.is_empty());
        assert_eq!(0, stats.files_scanned);
    }

    #[test]
    fn buffers_oversized_in_memory_counts_skipped_large() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("huge.md");
        let mut big = String::from("needle\n");
        big.push_str(&"a".repeat(MAX_FILE_SIZE as usize + 10));
        let docs = vec![buffer_in_memory(&path, &big)];
        let o = ext_opts(false, FileFilter::AllText);
        let (files, stats) = collect_buffers(&docs, "needle", &o);
        assert!(files.is_empty());
        assert_eq!(1, stats.skipped_large);
    }

    #[test]
    fn buffers_respect_file_filter() {
        let tmp = TempDir::new().unwrap();
        let md = tmp.path().join("a.md");
        let txt = tmp.path().join("b.txt");
        let docs = vec![
            buffer_in_memory(&md, "needle\n"),
            buffer_in_memory(&txt, "needle\n"),
        ];
        let o = ext_opts(false, FileFilter::Markdown);
        let (files, _) = collect_buffers(&docs, "needle", &o);
        assert_eq!(vec!["a.md".to_string()], names(&files));
    }

    #[test]
    fn buffers_global_cap_truncates_with_extra_hit() {
        // Cap-Parität zum Root-Pfad: 10 Puffer × exakt 50 Treffer-Zeilen =
        // 500 = MAX_HITS_TOTAL. Ein weiterer Puffer mit echtem Treffer läuft
        // in den Probe-Modus und muss `truncated` setzen.
        let tmp = TempDir::new().unwrap();
        let mut docs = Vec::new();
        for f in 0..10 {
            let body = "aaa\n".repeat(50);
            docs.push(buffer_in_memory(
                &tmp.path().join(format!("cap_{f:02}.md")),
                &body,
            ));
        }
        docs.push(buffer_in_memory(&tmp.path().join("zzz_more.md"), "aaa\n"));
        let o = ext_opts(false, FileFilter::AllText);
        let (_files, stats) = collect_buffers(&docs, "aaa", &o);
        assert_eq!(MAX_HITS_TOTAL, stats.hits);
        assert!(
            stats.truncated,
            "echter Zusatztreffer nach Cap muss truncated setzen"
        );
    }

    #[test]
    fn buffers_probe_mode_ignores_zero_width_only_after_cap() {
        // Cap-/Probe-Parität zum Root-Pfad [Sol-Rev2#2]: nach exakt
        // MAX_HITS_TOTAL ein Puffer, dessen einzige "Treffer" unter `a*`
        // zero-width sind → `truncated` darf NICHT gesetzt werden.
        let tmp = TempDir::new().unwrap();
        let mut docs = Vec::new();
        for f in 0..10 {
            let body = "aaa\n".repeat(50);
            docs.push(buffer_in_memory(
                &tmp.path().join(format!("cap_{f:02}.md")),
                &body,
            ));
        }
        docs.push(buffer_in_memory(
            &tmp.path().join("zzz_zero.md"),
            "no such thing here\n",
        ));
        let o = ext_opts(true, FileFilter::AllText);
        let (_files, stats) = collect_buffers(&docs, "a*", &o);
        assert_eq!(MAX_HITS_TOTAL, stats.hits);
        assert!(
            !stats.truncated,
            "zero-width-only Kandidat im Probe-Modus darf truncated nicht setzen"
        );
    }

    #[test]
    fn to_scope_ex_rejects_open_tabs_with_folder() {
        assert!(matches!(
            to_scope_ex(Some("/x".to_string()), true),
            Err(SearchError::ScopeConflict)
        ));
        assert_eq!(SearchScopeEx::OpenTabs, to_scope_ex(None, true).unwrap());
        assert_eq!(SearchScopeEx::Vault, to_scope_ex(None, false).unwrap());
        assert_eq!(
            SearchScopeEx::Folder("/x".to_string()),
            to_scope_ex(Some("/x".to_string()), false).unwrap()
        );
    }

    // --- S6-Additionen: paralleler Walk (run_search_parallel) ----------------

    fn collect_parallel(
        roots: &SearchRoots,
        query: &str,
        o: &ExtendedSearchOptions,
    ) -> (Vec<FileResult>, SearchStats) {
        let cancel = AtomicBool::new(false);
        let mut files: Vec<FileResult> = Vec::new();
        let stats = run_search_parallel(roots, query, o, &cancel, &mut |f| files.push(f)).unwrap();
        (files, stats)
    }

    /// Ergebnis nach Pfad indizieren (Completion-Order ist nichtdeterministisch;
    /// verglichen wird ordnungs-insensitiv über eine Map).
    fn as_map(files: &[FileResult]) -> std::collections::HashMap<String, FileResult> {
        files.iter().cloned().map(|f| (f.path.clone(), f)).collect()
    }

    /// Stats-Vergleich ohne `elapsed_ms` (Laufzeit variiert).
    fn assert_stats_core_eq(a: &SearchStats, b: &SearchStats) {
        assert_eq!(a.files_scanned, b.files_scanned, "files_scanned");
        assert_eq!(a.files_matched, b.files_matched, "files_matched");
        assert_eq!(a.hits, b.hits, "hits");
        assert_eq!(a.skipped_large, b.skipped_large, "skipped_large");
        assert_eq!(a.truncated, b.truncated, "truncated");
    }

    /// Reicher, NICHT truncierender Baum: nested Ordner, gitignore/hidden,
    /// NUL-Binär, Übergröße, Unicode/CRLF, .md/.txt/.rs, plus eine außerhalb
    /// liegende explizit gepinnte Einzeldatei (übt die geteilte Einzeldatei-
    /// Phase). Liefert die SearchRoots.
    fn build_parity_tree(tmp: &TempDir) -> SearchRoots {
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        init_git(&root);
        write(&root, ".gitignore", "secret.md\n");

        write(
            &root,
            "a.md",
            "needle here\nline two needle\nno match line\n",
        );
        write(&root, "notes.txt", "plain needle in text\n");
        write(&root, "code.rs", "fn main() {} // no hit here\n");
        write(&root, "sub/b.md", "deep needle inside\n");
        write(&root, "sub/deeper/c.md", "even deeper needle\n");
        write(&root, "uni.md", "äß😀 needle da\n");
        write_bytes(&root, "crlf.md", b"foo\r\nbar needle baz\r\nlast\r\n");

        // Gefiltert/übersprungen:
        write(&root, "secret.md", "needle gitignored\n"); // gitignore
        write(&root, ".hidden.md", "needle hidden\n"); // hidden
        write_bytes(&root, "fake.md", b"pre \0\0 needle post\n"); // NUL
        let mut big = String::from("needle\n");
        big.push_str(&"a".repeat(MAX_FILE_SIZE as usize + 10));
        write(&root, "big.md", &big); // oversized

        // Explizit gepinnte Einzeldatei außerhalb von `root`.
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        write(&outside, "pinned.md", "pinned needle line\n");

        SearchRoots {
            dirs: vec![root],
            files: vec![outside.join("pinned.md")],
        }
    }

    #[test]
    fn parallel_matches_sequential_on_rich_tree() {
        let tmp = TempDir::new().unwrap();
        let roots = build_parity_tree(&tmp);
        let o = ext_opts(false, FileFilter::AllText);

        let (seq_files, seq_stats) = collect_ex(&roots, "needle", &o);
        let (par_files, par_stats) = collect_parallel(&roots, "needle", &o);

        assert!(!seq_stats.truncated, "Fixture darf nicht truncaten");
        assert_stats_core_eq(&seq_stats, &par_stats);
        assert_eq!(
            as_map(&seq_files),
            as_map(&par_files),
            "parallele Ergebnismenge muss der sequenziellen entsprechen"
        );
        // skipped_large: die Übergröße-Datei; NUL/hidden/gitignore zählen nicht.
        assert_eq!(1, par_stats.skipped_large);
    }

    #[test]
    fn parallel_respects_file_filter() {
        let tmp = TempDir::new().unwrap();
        let roots = build_parity_tree(&tmp);
        let o = ext_opts(false, FileFilter::Markdown);

        let (seq_files, seq_stats) = collect_ex(&roots, "needle", &o);
        let (par_files, par_stats) = collect_parallel(&roots, "needle", &o);

        assert_stats_core_eq(&seq_stats, &par_stats);
        assert_eq!(as_map(&seq_files), as_map(&par_files));
        // Nur .md — .txt/.rs sind unter Markdown gefiltert.
        assert!(
            par_files.iter().all(|f| f.file_name.ends_with(".md")),
            "Markdown-Filter darf nur .md liefern: {:?}",
            names(&par_files)
        );
    }

    #[test]
    fn parallel_dedups_overlapping_dirs() {
        // Verschachtelte Roots (Parent + Kind) direkt gebaut (umgeht das
        // resolve_scope-Dedup) → jede Datei wird von beiden Walks besucht und
        // muss vom Consumer-`seen` auf genau einmal dedupliziert werden.
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write(&root, "a.md", "needle\n");
        write(&sub, "b.md", "needle\n");
        let roots = SearchRoots {
            dirs: vec![root.clone(), sub.clone()],
            files: vec![],
        };

        let (files, _) = collect_parallel(&roots, "needle", &ext_opts(false, FileFilter::AllText));
        assert_eq!(
            2,
            files.len(),
            "keine Duplikate erwartet: {:?}",
            names(&files)
        );
        assert_eq!(1, files.iter().filter(|f| f.file_name == "a.md").count());
        assert_eq!(1, files.iter().filter(|f| f.file_name == "b.md").count());
    }

    #[test]
    fn parallel_cap_flags_truncated_and_respects_caps() {
        // 12 Dateien × 60 Treffer-Zeilen (>500 gesamt) → truncated; wegen der
        // nichtdeterministischen Completion-Order wird die exakte Trefferzahl
        // NICHT verglichen, aber die Invarianten müssen halten.
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("caproot");
        fs::create_dir_all(&root).unwrap();
        for f in 0..12 {
            let body = "z match line\n".repeat(60);
            write(&root, &format!("cap_{f:02}.md"), &body);
        }
        let roots = SearchRoots {
            dirs: vec![root],
            files: vec![],
        };

        let (files, stats) =
            collect_parallel(&roots, "match", &ext_opts(false, FileFilter::AllText));
        assert!(stats.truncated, "globaler Deckel muss greifen");
        assert!(
            stats.hits > 0 && stats.hits <= MAX_HITS_TOTAL,
            "hits={}",
            stats.hits
        );
        assert!(
            files.iter().all(|f| f.hits.len() <= MAX_HITS_PER_FILE),
            "per-Datei-Cap verletzt"
        );
    }

    #[test]
    fn parallel_cancel_before_start_aborts() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        write(&root, "a.md", "needle\n");
        write(&root, "b.md", "needle\n");
        let roots = SearchRoots {
            dirs: vec![root],
            files: vec![],
        };

        let cancel = AtomicBool::new(true); // schon vor Start gesetzt
        let mut files: Vec<FileResult> = Vec::new();
        let stats = run_search_parallel(
            &roots,
            "needle",
            &ext_opts(false, FileFilter::AllText),
            &cancel,
            &mut |f| files.push(f),
        )
        .unwrap();

        assert!(files.is_empty());
        assert_eq!(0, stats.files_scanned);
        assert_eq!(0, stats.hits);
    }

    #[test]
    fn parallel_cancel_mid_run_stops_after_first_callback() {
        // [Sol-Rev S6#1] Deterministischer Mid-Run-Cancel: der erste on_file-
        // Callback setzt das Abbruch-Flag. Danach darf der Consumer KEINE weiteren
        // gepufferten Events mehr anwenden → exakt ein on_file-Call. (Der frühere
        // Cancel-Test setzte das Flag schon vor Start und deckte diesen Pfad nicht
        // ab.)
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        for f in 0..8 {
            write(&root, &format!("f{f:02}.md"), "needle line\n");
        }
        let roots = SearchRoots {
            dirs: vec![root],
            files: vec![],
        };

        let cancel = AtomicBool::new(false);
        let mut calls = 0usize;
        let stats = run_search_parallel(
            &roots,
            "needle",
            &ext_opts(false, FileFilter::AllText),
            &cancel,
            &mut |_f| {
                calls += 1;
                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            },
        )
        .unwrap();

        assert_eq!(
            1, calls,
            "nach Cancel im ersten Callback dürfen keine weiteren on_file-Calls folgen"
        );
        assert_eq!(1, stats.files_matched);
    }

    #[test]
    fn parallel_overlap_child_then_parent_matches_sequential() {
        // [Sol-Rev S6#2] Roots in Reihenfolge Kind→Eltern, viele doppelte Treffer
        // und eine NUR im Eltern-Root liegende Trefferdatei. Ohne das Kollabieren
        // überlappender Roots würde der Kind-Walk die Sub-Dateien doppelt gegen
        // den Deckel zählen und den Walk in den Probe-Modus zwingen, bevor die
        // Eltern-only-Datei besucht ist → unvollständiges Ergebnis, teils ohne
        // `truncated`. Ergebnismenge + `truncated` müssen dem sequenziellen
        // Referenzlauf entsprechen, und das reproduzierbar (Stress ≥20×).
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("parent");
        let sub = parent.join("sub");
        fs::create_dir_all(&sub).unwrap();
        // 8 Sub-Dateien × 50 Treffer = 400; parent-only 50 → 450 < 500 (kein Cap).
        for f in 0..8 {
            write(&sub, &format!("s{f:02}.md"), &"needle line\n".repeat(50));
        }
        write(&parent, "parent_only.md", &"needle line\n".repeat(50));
        // Kind zuerst, dann Eltern — die Reihenfolge, die das Doppelzählen provoziert.
        let roots = SearchRoots {
            dirs: vec![sub.clone(), parent.clone()],
            files: vec![],
        };
        let o = ext_opts(false, FileFilter::AllText);

        // Sequenzieller Referenzlauf (dedupliziert über `seen`).
        let (seq_files, seq_stats) = collect_ex(&roots, "needle", &o);
        assert!(!seq_stats.truncated, "Referenzlauf darf nicht truncaten");
        assert_eq!(9, seq_files.len(), "Referenz: 8 Sub + 1 Eltern-Datei");

        for _ in 0..20 {
            let (par_files, par_stats) = collect_parallel(&roots, "needle", &o);
            assert_eq!(
                as_map(&seq_files),
                as_map(&par_files),
                "parallele Ergebnismenge muss der sequenziellen entsprechen"
            );
            assert_eq!(seq_stats.truncated, par_stats.truncated, "truncated");
            assert_eq!(seq_stats.hits, par_stats.hits, "hits");
            assert_eq!(
                seq_stats.files_matched, par_stats.files_matched,
                "files_matched"
            );
            assert!(
                par_files.iter().any(|f| f.file_name == "parent_only.md"),
                "die nur im Eltern-Root liegende Trefferdatei muss enthalten sein: {:?}",
                names(&par_files)
            );
        }
    }

    #[test]
    fn parallel_empty_tree_yields_nothing() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("empty");
        fs::create_dir_all(&root).unwrap();
        let roots = SearchRoots {
            dirs: vec![root],
            files: vec![],
        };
        let (files, stats) =
            collect_parallel(&roots, "needle", &ext_opts(false, FileFilter::AllText));
        assert!(files.is_empty());
        assert_eq!(0, stats.files_scanned);
        assert!(!stats.truncated);
    }
}
