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
//! Grundlage: [`docs/spec-vault-search.md`], Architektur-Entscheidungen 1–5.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use ignore::WalkBuilder;
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
}

impl SearchError {
    fn translation_parts(&self) -> (&'static str, Option<&str>) {
        match self {
            Self::QueryTooShort => ("errors.search.queryTooShort", None),
            Self::RootNotFound(detail) => ("errors.search.rootNotFound", Some(detail)),
            Self::InvalidScope(detail) => ("errors.search.invalidScope", Some(detail)),
            Self::InvalidPattern(detail) => ("errors.search.invalidQuery", Some(detail)),
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
///   verschachtelte Ordner eingeklappt, abgedeckte Dateien verworfen.
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
    let mut kept_dirs: Vec<PathBuf> = Vec::new();
    for d in &dirs {
        let covered_by_other = dirs.iter().any(|other| other != d && d.starts_with(other));
        if covered_by_other || kept_dirs.iter().any(|k| k == d) {
            continue;
        }
        kept_dirs.push(d.clone());
    }

    // Dateien verwerfen, die schon von einem Ordner abgedeckt sind (+ Duplikate).
    let mut kept_files: Vec<PathBuf> = Vec::new();
    for f in &files {
        let covered = kept_dirs.iter().any(|d| f.starts_with(d));
        if covered || kept_files.iter().any(|k| k == f) {
            continue;
        }
        kept_files.push(f.clone());
    }

    SearchRoots {
        dirs: kept_dirs,
        files: kept_files,
    }
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
    Ok(re)
}

/// Baut aus dem (escapten) Suchbegriff das Match-Regex.
fn compile_regex(query: &str, options: &SearchOptions) -> Result<Regex, SearchError> {
    let mut pat = regex::escape(query);
    if options.whole_word {
        pat = format!(r"\b{pat}\b");
    }
    if !options.case_sensitive {
        pat = format!("(?i){pat}");
    }
    Regex::new(&pat).map_err(|e| SearchError::InvalidPattern(e.to_string()))
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
        let matches: Vec<(usize, usize)> =
            re.find_iter(line).map(|m| (m.start(), m.end())).collect();
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

/// Liest eine (bereits als Markdown/Text klassifizierte) Datei, wenn sie
/// durchsuchbar ist: Größe ≤ [`MAX_FILE_SIZE`] und keine NUL-Bytes in den
/// ersten [`NUL_SNIFF_BYTES`]. `None` = überspringen. Übergröße wird nur bei
/// `count_large` in [`SearchStats::skipped_large`] gezählt (Voll-Scan-Modus;
/// der Probe-Modus zählt nicht).
fn read_searchable(path: &Path, stats: &mut SearchStats, count_large: bool) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        if count_large {
            stats.skipped_large += 1;
        }
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let sniff_end = bytes.len().min(NUL_SNIFF_BYTES);
    if bytes[..sniff_end].contains(&0u8) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
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

/// Voll-Scan einer Datei: liest, durchsucht, aktualisiert `stats` und streamt
/// bei Treffern über `on_file`. Klassifizierung ist bereits durch den Aufrufer
/// erfolgt.
fn process_file(
    path: &Path,
    norm: &str,
    re: &Regex,
    cancel: &AtomicBool,
    stats: &mut SearchStats,
    on_file: &mut dyn FnMut(FileResult),
) -> ScanOutcome {
    // Deckel VOR jedem IO prüfen (defensiv; regulär wechselt der Aufrufer beim
    // exakten Erreichen bereits in den Probe-Modus, sodass das hier nicht greift).
    let remaining_global = MAX_HITS_TOTAL - stats.hits;
    if remaining_global == 0 {
        stats.truncated = true;
        return ScanOutcome::Stop;
    }

    let content = match read_searchable(path, stats, true) {
        Some(c) => c,
        None => return ScanOutcome::Continue,
    };
    stats.files_scanned += 1;

    let (mut hits, perfile_truncated, cancelled) =
        build_file_hits(&content, re, MAX_HITS_PER_FILE, cancel);
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

/// Leichter Probe-Modus (nach exaktem Erreichen des Deckels): liest einen
/// Kandidaten nur bis zum ERSTEN Regex-Match. `true` = es gibt weitere Treffer
/// (→ `stats.truncated`). Kein `on_file`, kein `files_scanned`-Increment.
fn probe_has_match(path: &Path, re: &Regex, cancel: &AtomicBool) -> bool {
    let mut sink = SearchStats::default();
    let content = match read_searchable(path, &mut sink, false) {
        Some(c) => c,
        None => return false,
    };
    for raw in content.split('\n') {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if re.is_match(line) {
            return true;
        }
    }
    false
}

/// Prüft, ob `path` als durchsuchbare Text-/Markdown-Datei in Frage kommt.
/// Klassifikation läuft VOR Normalisierung/`seen`-Insert, damit Binär-/Bild-
/// Dateien keine Allokation kosten.
fn is_searchable_kind(path: &Path) -> bool {
    path.to_str()
        .map(|s| matches!(classify(s), FileKind::Markdown | FileKind::Text))
        .unwrap_or(false)
}

/// Synchroner Suchkern. Läuft über [`SearchRoots`], ruft `on_file` je Datei
/// **mit mindestens einem Treffer** (Streaming) und liefert am Ende die
/// aggregierten [`SearchStats`].
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
    let re = validate(roots, query, options)?;

    let start = Instant::now();
    let mut stats = SearchStats::default();
    let mut seen: HashSet<String> = HashSet::new();
    // Nach exaktem Erreichen des Deckels ohne Cut läuft der Walk in einem
    // leichten Probe-Modus weiter, um `truncated` korrekt zu setzen.
    let mut probing = false;
    let mut stopped = false;

    'walk: for dir in &roots.dirs {
        // Single-threaded Walk; Standard-Filter (hidden + gitignore) an,
        // deterministische Reihenfolge via sort_by_file_name.
        let walker = WalkBuilder::new(dir)
            .sort_by_file_name(|a, b| a.cmp(b))
            .build();
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
            // Klassifikation vor Normalisierung/seen (Perf: keine Allokation
            // für Binär-/Bild-Dateien).
            if !is_searchable_kind(entry.path()) {
                continue;
            }
            let norm = normalize_path(entry.path());
            if !seen.insert(norm.clone()) {
                continue;
            }
            if probing {
                if probe_has_match(entry.path(), &re, cancel) {
                    stats.truncated = true;
                    stopped = true;
                    break 'walk;
                }
                continue;
            }
            match process_file(entry.path(), &norm, &re, cancel, &mut stats, on_file) {
                ScanOutcome::Continue => {}
                ScanOutcome::Probe => probing = true,
                ScanOutcome::Stop | ScanOutcome::Cancelled => {
                    stopped = true;
                    break 'walk;
                }
            }
        }
    }

    // Einzeln angepinnte Dateien (nicht von einem Ordner abgedeckt). Explizite
    // Pins umgehen den hidden-/gitignore-Filter bewusst (Nutzer-Intention),
    // durchlaufen aber weiterhin Kind-/Größen-/NUL-Filter.
    if !stopped {
        for f in &roots.files {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if !is_searchable_kind(f) {
                continue;
            }
            let norm = normalize_path(f);
            if !seen.insert(norm.clone()) {
                continue;
            }
            if probing {
                if probe_has_match(f, &re, cancel) {
                    stats.truncated = true;
                    break;
                }
                continue;
            }
            match process_file(f, &norm, &re, cancel, &mut stats, on_file) {
                ScanOutcome::Continue => {}
                ScanOutcome::Probe => probing = true,
                ScanOutcome::Stop | ScanOutcome::Cancelled => break,
            }
        }
    }

    stats.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(stats)
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
    fn resolve_scope_collapses_nested_and_covered_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("a.md");
        fs::write(&file, "needle\n").unwrap();

        let pinned = vec![pin_dir(root), pin_dir(&sub), pin_file(&file)];
        let roots = resolve_scope(&pinned, &SearchScope::Vault);

        // Nur der oberste Ordner bleibt; verschachtelter Unterordner + darin
        // liegende gepinnte Datei sind bereits abgedeckt.
        assert_eq!(vec![root.to_path_buf()], roots.dirs);
        assert!(roots.files.is_empty());
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
        };
        let (files, _) = collect(&dir_roots(tmp.path()), "foo", &ww);
        assert_eq!(1, files.len());
        let hit = &files[0].hits[0];
        assert_eq!(vec![[7u32, 3]], hit.ranges); // nur das freistehende "foo"
        assert_eq!(8, hit.col_utf16);

        let off = SearchOptions {
            case_sensitive: false,
            whole_word: false,
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
}
