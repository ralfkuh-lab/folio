//! Wikilinks (Obsidian-kompatibel): Namens-Index über den Vault + Auflösung
//! eines `[[Ziel]]`-Strings auf einen konkreten Dateipfad.
//!
//! Spec: `docs/spec-wikilinks.md` (Etappe W1). Der Renderer
//! (`renderer::render_body_with_wikilinks`) hängt sich mit einem
//! [`WikilinkContext`] hier ein; Aufrufer ohne Kontext (Theme-Editor-
//! Vorschau) bekommen bewusst missing-Optik.

use crate::file_kind::{classify, FileKind};
use crate::file_resolver::make_relative;
use crate::renderer::slugify_heading;
use crate::search::{resolve_scope, SearchScope, MAX_FILE_SIZE};
use crate::workspace::PinnedItem;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// TTL-Fallback des Index-Caches. Der Vault-Watcher sieht nur aufgeklappte
/// Ordner; tiefere externe Änderungen wären ohne TTL unsichtbar (Spec).
pub const INDEX_TTL: Duration = Duration::from_secs(30);

/// URL-Schema für nicht auflösbare Wikilinks. Das Frontend (W2) fängt es ab
/// und öffnet den „Notiz anlegen?"-Dialog.
pub const MISSING_SCHEME: &str = "folio-new:";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Zerlegtes Wikilink-Ziel. Quelle ist der `url`-Teil des comrak-Nodes
/// `NodeValue::WikiLink` (bei `wikilinks_title_after_pipe` also alles vor
/// dem `|`); `parse_target` toleriert trotzdem einen mitgelieferten Alias.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikilinkTarget {
    /// Name bzw. pfad-qualifizierter Name, getrimmt, ohne Anker/Alias.
    /// Ein evtl. vorhandenes `.md` bleibt erhalten (die Auflösung behandelt
    /// `[[Name.md]]` und `[[Name]]` gleich).
    pub name: String,
    /// `#Überschrift` (roher Heading-Text, noch nicht slugifiziert).
    pub heading: Option<String>,
    /// `#^blockid` — in V1 bewusst ignoriert (Link zeigt auf die Datei).
    pub block_id: Option<String>,
    /// `|Anzeigetext` — reine Anzeige, nie Teil der Auflösung.
    pub alias: Option<String>,
}

/// Zerlegt einen rohen Wikilink-Zielstring (`Name#Überschrift|Alias`).
pub fn parse_target(raw: &str) -> WikilinkTarget {
    let raw = raw.trim();
    let (before_alias, alias) = match raw.split_once('|') {
        Some((target, alias)) => (target.trim(), Some(alias.trim().to_string())),
        None => (raw, None),
    };
    let (name, anchor) = match before_alias.split_once('#') {
        Some((name, anchor)) => (name.trim(), Some(anchor.trim())),
        None => (before_alias, None),
    };
    let (heading, block_id) = match anchor {
        // `#^id` = Block-Referenz. V1 ignoriert sie bewusst (Link auf die Datei).
        Some(anchor) => match anchor.strip_prefix('^') {
            Some(block) => (None, Some(block.trim().to_string())),
            None if anchor.is_empty() => (None, None),
            None => (Some(anchor.to_string()), None),
        },
        None => (None, None),
    };

    WikilinkTarget {
        name: name.to_string(),
        heading,
        block_id,
        alias,
    }
}

/// Export-Postprocess: ersetzt `href="folio-new:…"` durch `href="#"`
/// (Klassen `wikilink-missing` bleiben). App-View behält das Schema für
/// den Anlegen-Dialog; Export/PDF sollen kein `folio-new:` enthalten.
pub fn sanitize_export_missing_hrefs(html: &str) -> String {
    sanitize_export_missing_hrefs_quote(html, '"')
}

fn sanitize_export_missing_hrefs_quote(html: &str, quote: char) -> String {
    let needle = format!("href={quote}{MISSING_SCHEME}");
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find(&needle) {
        out.push_str(&rest[..i]);
        out.push_str("href=");
        out.push(quote);
        out.push('#');
        out.push(quote);
        let after = &rest[i + needle.len()..];
        if let Some(end) = after.find(quote) {
            rest = &after[end + 1..];
        } else {
            rest = after;
            break;
        }
    }
    out.push_str(rest);
    // Einmal mit dem anderen Quote-Zeichen (defensiv).
    if quote == '"' && out.contains("href='folio-new:") {
        return sanitize_export_missing_hrefs_quote(&out, '\'');
    }
    out
}

/// `folio-new:<urlencoded name>` für ein nicht auflösbares Ziel.
/// Prozent-kodiert alles außer `A-Za-z0-9-._~` (inklusive `/`), damit der
/// Dialog in W2 den Namen eindeutig zurückgewinnt.
pub fn missing_href(name: &str) -> String {
    let mut href = String::with_capacity(MISSING_SCHEME.len() + name.len());
    href.push_str(MISSING_SCHEME);
    for byte in name.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                href.push(*byte as char)
            }
            _ => href.push_str(&format!("%{byte:02X}")),
        }
    }
    href
}

/// Forward-Slash-normalisierter Pfad-String (folio-Konvention).
fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

/// Pfad relativ zur Walk-Wurzel (POSIX-Slashes); Fallback = Dateiname.
fn relative_to(root: &Path, file: &Path) -> String {
    match file.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => file_name_of(file),
    }
}

/// Vergleicht zwei bereits Forward-Slash-normalisierte Pfade so, wie das
/// Dateisystem sie behandelt: case-insensitiv auf Windows/macOS, sonst
/// exakt. Die Namensaufloesung ist case-insensitiv — ein exakter Vergleich
/// am Ende liess auf case-insensitiven Volumes Backlinks verschwinden,
/// wenn die Schreibweise des geoeffneten Dokuments vom Walk abwich
/// (Review kimi #6).
pub fn paths_equal(a: &str, b: &str) -> bool {
    #[cfg(any(windows, target_os = "macos"))]
    {
        a.eq_ignore_ascii_case(b) || a.to_lowercase() == b.to_lowercase()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        a == b
    }
}

/// Suffix-Match auf Komponentengrenze: `notes/alpha` matcht
/// `/vault/notes/alpha`, aber `otes/alpha` nicht.
fn ends_with_components(path: &str, needle_lowercase: &str) -> bool {
    let path = path.to_lowercase();
    path == needle_lowercase || path.ends_with(&format!("/{needle_lowercase}"))
}

/// Gleichheit zweier normalisierter Pfade (FS-Semantik wie [`paths_equal`]).
fn path_strings_equal(a: &str, b: &str) -> bool {
    paths_equal(a, b)
}

/// `path` liegt unter `root` (inkl. Gleichheit), komponentengrenzen-sicher.
fn path_under_root(path: &str, root: &str) -> bool {
    if path_strings_equal(path, root) {
        return true;
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        let p = path.to_lowercase();
        let r = root.to_lowercase();
        p.starts_with(&format!("{r}/"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        path.starts_with(&format!("{root}/"))
    }
}

/// Existierende Ordner-Pins als normalisierte Root-Strings (vor Collapse).
fn directory_pin_roots(pinned: &[PinnedItem]) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for item in pinned {
        if !item.is_directory {
            continue;
        }
        let pb = PathBuf::from(item.path.replace('\\', "/"));
        if pb.is_dir() {
            let n = normalize_path(&pb);
            if !roots.iter().any(|r| path_strings_equal(r, &n)) {
                roots.push(n);
            }
        }
    }
    roots.sort();
    roots
}

/// Längster Pin-Root, unter dem `normalized_path` liegt.
fn longest_matching_root(roots: &[String], normalized_path: &str) -> Option<String> {
    roots
        .iter()
        .filter(|root| path_under_root(normalized_path, root))
        .max_by_key(|root| root.len())
        .cloned()
}

/// Elternverzeichnis eines bereits Forward-Slash-normalisierten Pfads
/// (ohne `Path`/`normalize_path`-Allokation pro Kandidat).
fn parent_dir_normalized(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

/// `entry_path` (normalisiert) hat Elternverzeichnis `ctx_dir`.
fn entry_parent_equals(entry_path: &str, ctx_dir: &str) -> bool {
    let parent = match entry_path.rfind('/') {
        Some(0) => "/",
        Some(i) => &entry_path[..i],
        None => "",
    };
    path_strings_equal(parent, ctx_dir)
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/// Ein Index-Kandidat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    /// Absoluter Pfad, Forward-Slash-normalisiert (folio-Konvention).
    pub path: String,
    /// Pfad relativ zur **kollabierten Walk-Wurzel** aus `resolve_scope`
    /// (POSIX-Slashes) — nicht zum Lokalitäts-`root`. Grundlage der globalen
    /// Mehrdeutigkeits-Rangfolge in [`WikilinkIndex::sort_candidates`].
    /// Bei reinen Datei-Pins (kein Ordner-Walk) = Basename.
    pub relative: String,
    /// Absoluter Pin-Root für W7-Lokalität (Forward-Slashes): längster
    /// passender Ordner-Pin; nur wenn keiner greift (Datei-Pin außerhalb
    /// aller Ordner-Pins) das Elternverzeichnis. Unabhängig vom Einfügepfad
    /// (Walk vs. Datei-Pin / gitignore). Beeinflusst `relative` **nicht**.
    pub root: String,
}

/// In-Memory-Index `Name(lowercase) → Kandidaten`.
///
/// Schlüssel pro Datei:
/// - immer der **volle Dateiname** in Kleinschreibung (`bild.png`, `name.md`),
/// - für Markdown zusätzlich der **Stem** (`name`).
///
/// Damit matchen `[[Name]]`, `[[Name.md]]` und `![[bild.png]]` über denselben
/// Lookup; `[[bild]]` (Bild ohne Extension) matcht bewusst nicht.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WikilinkIndex {
    entries: HashMap<String, Vec<IndexEntry>>,
    files: usize,
    /// Alle Pin-Roots der Index-Erzeugung (Ordner-Pins + Eltern von Datei-Pins),
    /// sortiert — für deterministische Lokalitäts-Heimat des Kontextdokuments.
    roots: Vec<String>,
}

impl WikilinkIndex {
    /// Baut den Index über den Vault-Walk (`search::resolve_scope` +
    /// `collapse_overlapping_dirs`, hidden/gitignore-Filter, `.git`-Skip).
    /// Explizit gepinnte Einzeldateien umgehen die Filter (wie in der Suche).
    pub fn build(pinned: &[PinnedItem]) -> Self {
        let started = Instant::now();
        let walk_roots = resolve_scope(pinned, &SearchScope::Vault);
        // Alle existierenden Ordner-Pins (vor Overlap-Collapse) — für
        // längsten passenden Root pro Datei (W7 verschachtelte Pins).
        let pin_dir_roots = directory_pin_roots(pinned);
        let mut index = WikilinkIndex::default();
        let mut seen: HashSet<String> = HashSet::new();
        let mut roots_set: HashSet<String> = HashSet::new();

        for dir in &walk_roots.dirs {
            // Crate-Default-Filter (hidden + gitignore) an; `.git` ist als
            // Hidden-Verzeichnis damit bereits draußen.
            let walker = WalkBuilder::new(dir)
                .sort_by_file_name(|a, b| a.cmp(b))
                .build();
            for result in walker {
                let Ok(entry) = result else { continue };
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    continue;
                }
                let normalized = normalize_path(entry.path());
                if !seen.insert(normalized.clone()) {
                    continue;
                }
                // root = Lokalität (längster Ordner-Pin); relative = Walk-Wurzel.
                let root = longest_matching_root(&pin_dir_roots, &normalized)
                    .unwrap_or_else(|| normalize_path(dir));
                roots_set.insert(root.clone());
                let relative = relative_to(dir, entry.path());
                index.insert(normalized, relative, root);
            }
        }

        // Explizit gepinnte Einzeldateien: umgehen hidden/gitignore bewusst
        // (dokumentierter Pin-Bypass der Suche). Root: dieselbe Regel wie im
        // Walk (längster Ordner-Pin), sonst Elternverzeichnis — nicht
        // walk-Reihenfolge-/gitignore-abhängig (W7 F3).
        for file in &walk_roots.files {
            if !file.is_file() {
                continue;
            }
            let normalized = normalize_path(file);
            if !seen.insert(normalized.clone()) {
                continue;
            }
            let root = longest_matching_root(&pin_dir_roots, &normalized)
                .or_else(|| file.parent().map(normalize_path))
                .unwrap_or_else(|| normalized.clone());
            roots_set.insert(root.clone());
            let relative = file_name_of(file);
            index.insert(normalized, relative, root);
        }

        let mut roots: Vec<String> = roots_set.into_iter().collect();
        roots.sort();
        index.roots = roots;

        index.sort_candidates();
        tracing::debug!(
            target: "folio::wikilink",
            files = index.files,
            names = index.entries.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "wikilink index rebuilt"
        );
        index
    }

    /// Anzahl indizierter Namensschlüssel.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Anzahl indizierter Dateien (eine Datei kann zwei Schlüssel belegen).
    pub fn file_count(&self) -> usize {
        self.files
    }

    /// Alle Kandidaten zu einem Namensschlüssel, in Rangfolge sortiert
    /// (kürzester vault-relativer Pfad zuerst, Tiebreak lexikografisch).
    /// Pfad-qualifizierte Namen werden dabei auf die letzte Komponente
    /// reduziert — das Suffix-Filtern übernimmt [`Self::resolve_name`].
    pub fn candidates(&self, name: &str) -> &[IndexEntry] {
        let Some(key) = lookup_key(name) else {
            return &[];
        };
        self.entries.get(&key).map_or(&[][..], Vec::as_slice)
    }

    /// Auflösung ohne Kontextdokument: globale Rangfolge
    /// (kürzester vault-relativer Pfad, Tiebreak lexikografisch).
    pub fn resolve_name(&self, name: &str) -> Option<&IndexEntry> {
        self.pick_resolved(name, None)
    }

    /// Auflösung mit Lokalitäts-Priorität (W7) relativ zum Kontextdokument:
    /// 1. gleiches Verzeichnis, 2. gleicher Pin-Root, 3. Rest (global).
    ///
    /// Pfad-qualifizierte Links filtern zuerst per Suffix-Match; die
    /// Lokalität entscheidet erst unter den Suffix-Treffern.
    pub fn resolve_name_from(&self, name: &str, context: &Path) -> Option<&IndexEntry> {
        self.pick_resolved(name, Some(context))
    }

    fn pick_resolved(&self, name: &str, context: Option<&Path>) -> Option<&IndexEntry> {
        let query = normalized_query(name);
        if query.is_empty() {
            return None;
        }
        let candidates = self.candidates(&query);
        if candidates.is_empty() {
            return None;
        }

        // Pfad-qualifiziert: Suffix-Match auf Komponentengrenze, wahlweise
        // gegen den vollen Pfad oder (bei Markdown) gegen den Pfad ohne
        // Extension — `[[a/b/Name]]` und `[[a/b/Name.md]]` sind identisch.
        // Unqualifiziert und qualifiziert: kein temporärer Vec — drei
        // Iterator-Pässe über den sortierten Slice (W7 F4).
        if query.contains('/') {
            let needle = query.to_lowercase();
            let suffix_ok = |entry: &IndexEntry| {
                ends_with_components(&entry.path, &needle)
                    || markdown_stem_path(&entry.path)
                        .is_some_and(|stem| ends_with_components(&stem, &needle))
            };
            let Some(ctx) = context else {
                return candidates.iter().find(|e| suffix_ok(e));
            };
            return self.pick_by_locality_filtered(candidates, ctx, suffix_ok);
        }

        let Some(ctx) = context else {
            return candidates.first();
        };
        self.pick_by_locality_filtered(candidates, ctx, |_| true)
    }

    /// W7-Lokalität in drei Pässen über den (gefilterten) sortierten Slice.
    /// Reihenfolge innerhalb jeder Stufe = globale `sort_candidates`-Ordnung.
    fn pick_by_locality_filtered<'a, F>(
        &self,
        candidates: &'a [IndexEntry],
        context: &Path,
        mut pred: F,
    ) -> Option<&'a IndexEntry>
    where
        F: FnMut(&IndexEntry) -> bool,
    {
        let ctx_path = normalize_path(context);
        let ctx_dir = parent_dir_normalized(&ctx_path);

        // Stufe 1: gleiches Verzeichnis (ctx_dir einmal berechnet).
        if let Some(entry) = candidates
            .iter()
            .find(|entry| pred(entry) && entry_parent_equals(&entry.path, &ctx_dir))
        {
            return Some(entry);
        }

        // Stufe 2: gleicher Pin-Root (Heimat = längster passender Root).
        if let Some(ctx_root) = self.home_root_for(&ctx_path) {
            if let Some(entry) = candidates
                .iter()
                .find(|entry| pred(entry) && path_strings_equal(&entry.root, ctx_root))
            {
                return Some(entry);
            }
        }

        // Stufe 3: global erste verbleibende (gefiltert).
        candidates.iter().find(|entry| pred(entry))
    }

    /// Längster Pin-Root, unter dem `path` liegt; `None` außerhalb aller Pins.
    fn home_root_for(&self, path: &str) -> Option<&str> {
        self.roots
            .iter()
            .filter(|root| path_under_root(path, root))
            .max_by_key(|root| root.len())
            .map(String::as_str)
    }

    fn insert(&mut self, path: String, relative: String, root: String) {
        let name = file_name_of(Path::new(&path));
        if name.is_empty() {
            return;
        }
        self.files += 1;
        let entry = IndexEntry {
            path,
            relative,
            root,
        };

        // Markdown zusätzlich unter dem Stem — `[[Name]]` ohne Extension.
        if classify(&entry.path) == FileKind::Markdown {
            if let Some(stem) = Path::new(&name).file_stem().and_then(|s| s.to_str()) {
                let stem_key = stem.to_lowercase();
                if stem_key != name.to_lowercase() {
                    self.entries
                        .entry(stem_key)
                        .or_default()
                        .push(entry.clone());
                }
            }
        }

        self.entries
            .entry(name.to_lowercase())
            .or_default()
            .push(entry);
    }

    /// Deterministische Rangfolge: kürzester vault-relativer Pfad
    /// (Komponentenzahl) zuerst, dann lexikografisch.
    fn sort_candidates(&mut self) {
        for candidates in self.entries.values_mut() {
            candidates.sort_by(|a, b| {
                let depth = a
                    .relative
                    .split('/')
                    .count()
                    .cmp(&b.relative.split('/').count());
                depth
                    .then_with(|| a.relative.to_lowercase().cmp(&b.relative.to_lowercase()))
                    .then_with(|| a.path.cmp(&b.path))
            });
        }
    }
}

/// Getrimmter, auf Forward-Slashes normalisierter Link-Name.
fn normalized_query(name: &str) -> String {
    let query = name.trim().replace('\\', "/");
    query.trim_start_matches("./").to_string()
}

/// Index-Schlüssel eines Namens = letzte Pfadkomponente in Kleinschreibung.
fn lookup_key(name: &str) -> Option<String> {
    let query = normalized_query(name);
    let last = query.rsplit('/').next()?;
    if last.is_empty() {
        return None;
    }
    Some(last.to_lowercase())
}

/// Markdown-Pfad ohne Extension (für extensionslose Suffix-Matches).
fn markdown_stem_path(path: &str) -> Option<String> {
    if classify(path) != FileKind::Markdown {
        return None;
    }
    let stripped = Path::new(path).with_extension("");
    Some(normalize_path(&stripped))
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/// Fingerprint der Pin-Liste (Pfad + Typ, in Reihenfolge). Wechselt der
/// Suchraum, ist ein gecachter Index fuer den neuen Aufrufer wertlos —
/// stale ausliefern waere schlicht falsch (Review codex #1).
fn fingerprint_of(pinned: &[PinnedItem]) -> u64 {
    let mut hasher = DefaultHasher::new();
    pinned.len().hash(&mut hasher);
    for item in pinned {
        item.path.hash(&mut hasher);
        item.is_directory.hash(&mut hasher);
    }
    hasher.finish()
}

/// Wie der Hintergrund-Refresh ausgefuehrt wird.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshMode {
    /// Produktion: eigener Thread, der Aufrufer bekommt sofort den
    /// stale Index.
    Background,
    /// Tests: der Refresh laeuft synchron im aufrufenden Thread, aber
    /// erst NACH dem Freigeben des Locks und der Aufrufer bekommt
    /// weiterhin den stale Index — gleiche Semantik, deterministisch.
    #[cfg(test)]
    Inline,
}

/// Index-Cache mit expliziter Invalidierung, TTL-Fallback und
/// **stale-while-revalidate**.
///
/// Vertrag (nach Review codex #1/#2, kimi #1):
/// - Passender, frischer Eintrag → sofort.
/// - Passender, **abgelaufener oder invalidierter** Eintrag → der alte
///   Index wird sofort zurueckgegeben, der Rebuild laeuft im Hintergrund.
///   Das gilt bewusst auch fuer explizites [`Self::invalidate`]: es feuert
///   bei jedem Watcher-Event und jeder Datei-Operation, ein synchroner
///   Vault-Walk wuerde genau den Hot-Path treffen, den die Spec ausschliesst
///   (Live-Preview pro Tastendruck, `document:loaded`-Emit). Preis: fuer
///   die Dauer eines Rebuilds kann ein frisch angelegtes Ziel noch als
///   missing rendern; der naechste Render ist korrekt.
/// - **Kein** passender Eintrag (Cold Start, anderer Pin-Fingerprint) →
///   synchroner Build, weil es nichts auszuliefern gaebe.
/// - Ein fertiger Build wird nur veroeffentlicht, wenn seither weder
///   invalidiert wurde (Generation) noch der Suchraum wechselte
///   (Fingerprint) — sonst wird er verworfen.
///
/// Gebaut wird **nie** unter dem Cache-Mutex.
#[derive(Debug, Clone)]
pub struct WikilinkIndexCache {
    inner: Arc<CacheInner>,
}

#[derive(Debug)]
struct CacheInner {
    ttl: Duration,
    refresh_mode: RefreshMode,
    state: Mutex<CacheState>,
}

#[derive(Debug, Default)]
struct CacheState {
    cached: Option<CachedIndex>,
    /// Zaehlt jedes [`WikilinkIndexCache::invalidate`]. Ein Build mit
    /// aelterer Generation darf nicht mehr veroeffentlicht werden.
    generation: u64,
    /// Laeuft bereits ein Hintergrund-Refresh? Verhindert Thread-Herden,
    /// wenn viele Renders gleichzeitig auf einen stale Index treffen.
    refreshing: bool,
    rebuilds: usize,
}

#[derive(Debug)]
struct CachedIndex {
    index: Arc<WikilinkIndex>,
    built_at: Instant,
    generation: u64,
    fingerprint: u64,
}

/// Was `get_at` nach dem Lock-Scope zu tun hat.
enum CacheAction {
    Stale {
        index: Arc<WikilinkIndex>,
        generation: u64,
    },
    BuildSync {
        generation: u64,
    },
}

impl Default for WikilinkIndexCache {
    fn default() -> Self {
        Self::new()
    }
}

impl WikilinkIndexCache {
    pub fn new() -> Self {
        Self::with_mode(INDEX_TTL, RefreshMode::Background)
    }

    /// Variante mit konfigurierbarer TTL (Tests).
    pub fn with_ttl(ttl: Duration) -> Self {
        Self::with_mode(ttl, RefreshMode::Background)
    }

    /// Test-Variante: Hintergrund-Refresh laeuft synchron (siehe
    /// [`RefreshMode::Inline`]).
    #[cfg(test)]
    fn with_inline_refresh(ttl: Duration) -> Self {
        Self::with_mode(ttl, RefreshMode::Inline)
    }

    fn with_mode(ttl: Duration, refresh_mode: RefreshMode) -> Self {
        Self {
            inner: Arc::new(CacheInner {
                ttl,
                refresh_mode,
                state: Mutex::new(CacheState::default()),
            }),
        }
    }

    /// Aktueller Index (stale-while-revalidate, siehe Typ-Doku).
    pub fn get(&self, pinned: &[PinnedItem]) -> Arc<WikilinkIndex> {
        self.get_at(pinned, Instant::now())
    }

    /// Wie [`Self::get`], aber mit injizierter „Jetzt"-Zeit — macht das
    /// TTL-Verhalten ohne `sleep` testbar.
    pub fn get_at(&self, pinned: &[PinnedItem], now: Instant) -> Arc<WikilinkIndex> {
        let fingerprint = fingerprint_of(pinned);
        let action = {
            let mut state = self.lock_state();
            let usable = state
                .cached
                .as_ref()
                .filter(|cached| cached.fingerprint == fingerprint);
            match usable {
                Some(cached) => {
                    let fresh = cached.generation == state.generation
                        && now.saturating_duration_since(cached.built_at) < self.inner.ttl;
                    let index = Arc::clone(&cached.index);
                    if fresh {
                        return index;
                    }
                    if state.refreshing {
                        // Refresh laeuft schon — stale ausliefern reicht.
                        return index;
                    }
                    state.refreshing = true;
                    CacheAction::Stale {
                        index,
                        generation: state.generation,
                    }
                }
                None => CacheAction::BuildSync {
                    generation: state.generation,
                },
            }
        };

        match action {
            CacheAction::Stale { index, generation } => {
                self.start_refresh(pinned.to_vec(), generation, fingerprint);
                index
            }
            CacheAction::BuildSync { generation } => {
                let index = Arc::new(WikilinkIndex::build(pinned));
                self.publish(Arc::clone(&index), generation, fingerprint, now);
                index
            }
        }
    }

    /// Explizite Invalidierung (Pin-Änderung, create_file/Rename/Delete,
    /// `vault:dir_changed`). Verwirft den Eintrag nicht sofort — er bleibt
    /// als stale-Quelle nutzbar, bis der Hintergrund-Rebuild landet.
    pub fn invalidate(&self) {
        let mut state = self.lock_state();
        state.generation += 1;
    }

    /// Aktuelle Invalidierungs-Generation (Diagnose + Build-Snapshots).
    pub fn generation(&self) -> u64 {
        self.lock_state().generation
    }

    /// Zahl der bisher veroeffentlichten Rebuilds (Diagnose + Tests).
    pub fn rebuild_count(&self) -> usize {
        self.lock_state().rebuilds
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.inner
            .state
            .lock()
            .expect("wikilink index cache must not be poisoned")
    }

    /// Veroeffentlicht einen fertigen Build, sofern Generation und
    /// Fingerprint noch aktuell sind. `false` = verworfen.
    fn publish(
        &self,
        index: Arc<WikilinkIndex>,
        snapshot_generation: u64,
        fingerprint: u64,
        now: Instant,
    ) -> bool {
        let mut state = self.lock_state();
        if state.generation != snapshot_generation {
            tracing::debug!(
                target: "folio::wikilink",
                snapshot_generation,
                current_generation = state.generation,
                "discarding wikilink index build invalidated during rebuild"
            );
            return false;
        }
        state.cached = Some(CachedIndex {
            index,
            built_at: now,
            generation: snapshot_generation,
            fingerprint,
        });
        state.rebuilds += 1;
        true
    }

    /// Startet den Rebuild ausserhalb des Locks.
    fn start_refresh(&self, pinned: Vec<PinnedItem>, generation: u64, fingerprint: u64) {
        match self.inner.refresh_mode {
            RefreshMode::Background => {
                let cache = self.clone();
                if let Err(error) = std::thread::Builder::new()
                    .name("folio-wikilink-index".to_string())
                    .spawn(move || cache.run_refresh(&pinned, generation, fingerprint))
                {
                    tracing::warn!(
                        target: "folio::wikilink",
                        %error,
                        "could not spawn wikilink index refresh thread; keeping stale index"
                    );
                    self.lock_state().refreshing = false;
                }
            }
            #[cfg(test)]
            RefreshMode::Inline => self.run_refresh(&pinned, generation, fingerprint),
        }
    }

    fn run_refresh(&self, pinned: &[PinnedItem], generation: u64, fingerprint: u64) {
        let index = Arc::new(WikilinkIndex::build(pinned));
        self.publish(index, generation, fingerprint, Instant::now());
        self.lock_state().refreshing = false;
    }
}

// ---------------------------------------------------------------------------
// Auflösung fuer den Renderer
// ---------------------------------------------------------------------------

/// Ergebnis der Auflösung eines Wikilinks im Kontext eines Dokuments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WikilinkResolution {
    Resolved {
        /// Absoluter Zielpfad, Forward-Slash-normalisiert.
        path: String,
        /// `href` für den gerenderten Anchor: Pfad **relativ zum aktuellen
        /// Dokument** (POSIX-Slashes) plus `#anchor`, falls ein Heading-Teil
        /// vorhanden war. Läuft damit über den bestehenden
        /// `link_click`/`file_resolver::resolve`-Pfad.
        href: String,
        /// Dateityp des Ziels — entscheidet beim Embed Bild vs. Link.
        kind: FileKind,
    },
    Missing {
        /// `folio-new:<urlencoded name>`.
        href: String,
    },
}

impl WikilinkResolution {
    pub fn href(&self) -> &str {
        match self {
            WikilinkResolution::Resolved { href, .. } => href,
            WikilinkResolution::Missing { href } => href,
        }
    }

    pub fn is_missing(&self) -> bool {
        matches!(self, WikilinkResolution::Missing { .. })
    }

    /// Bild-Ziel → das Embed `![[…]]` wird zum `<img>`.
    pub fn is_image(&self) -> bool {
        matches!(
            self,
            WikilinkResolution::Resolved {
                kind: FileKind::Image,
                ..
            }
        )
    }
}

/// Render-Kontext: Namensindex + Pfad des gerade gerenderten Dokuments
/// (bestimmt die Relativpfade und in W2 den Anlage-Ort neuer Notizen).
#[derive(Debug, Clone)]
pub struct WikilinkContext {
    index: Arc<WikilinkIndex>,
    current_doc: PathBuf,
}

impl WikilinkContext {
    pub fn new(index: Arc<WikilinkIndex>, current_doc: impl Into<PathBuf>) -> Self {
        Self {
            index,
            current_doc: current_doc.into(),
        }
    }

    pub fn index(&self) -> &WikilinkIndex {
        &self.index
    }

    pub fn current_doc(&self) -> &Path {
        &self.current_doc
    }

    /// Löst einen rohen Wikilink-Zielstring auf (Alias/Anker/Blockref
    /// inklusive). Ergebnis ist direkt der `href` für den Anchor.
    pub fn resolve(&self, raw_target: &str) -> WikilinkResolution {
        let target = parse_target(raw_target);
        let anchor = target
            .heading
            .as_deref()
            .map(|heading| format!("#{}", slugify_heading(heading)))
            .unwrap_or_default();

        if target.name.is_empty() {
            // `[[#Ueberschrift]]` = Anker im aktuellen Dokument.
            if anchor.is_empty() {
                return WikilinkResolution::Missing {
                    href: missing_href(&target.name),
                };
            }
            let path = normalize_path(&self.current_doc);
            let kind = classify(&path);
            return WikilinkResolution::Resolved {
                path,
                href: anchor,
                kind,
            };
        }

        match self
            .index
            .resolve_name_from(&target.name, &self.current_doc)
        {
            Some(entry) => {
                let from_dir = self.current_doc.parent().unwrap_or_else(|| Path::new(""));
                let relative = make_relative(from_dir, Path::new(&entry.path));
                WikilinkResolution::Resolved {
                    path: entry.path.clone(),
                    href: format!("{relative}{anchor}"),
                    kind: classify(&entry.path),
                }
            }
            None => WikilinkResolution::Missing {
                href: missing_href(&target.name),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Backlinks (W3)
// ---------------------------------------------------------------------------

/// Max. Quelldateien in der Backlinks-Antwort.
pub const BACKLINKS_MAX_SOURCES: usize = 200;
/// Max. Zeilen-Hits pro Quelldatei.
pub const BACKLINKS_MAX_HITS_PER_FILE: usize = 50;
/// Weiches Snippet-Fenster (Zeichen), analog zur Suche (~240).
const BACKLINKS_SNIPPET_CHARS: usize = 240;
/// NUL-Sniff-Fenster (wie `search::NUL_SNIFF_BYTES`).
const BACKLINKS_NUL_SNIFF: usize = 8 * 1024;

/// Ein Treffer in einer Quelldatei (1-basierte Zeile + Snippet).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkHit {
    pub line: u32,
    pub snippet: String,
}

/// Gruppierte Backlinks einer Quelldatei.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkSource {
    /// Absoluter Pfad, Forward-Slash-normalisiert.
    pub path: String,
    /// Dateiname (Anzeige).
    pub name: String,
    pub hits: Vec<BacklinkHit>,
}

/// Antwort von [`find_backlinks`] / Command `backlinks_for`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinksResult {
    pub sources: Vec<BacklinkSource>,
    /// `true`, wenn Caps (200 Quellen / 50 Hits/Datei) echte Treffer
    /// abgeschnitten haben.
    pub truncated: bool,
}

/// Findet Vault-MD-Dateien, die per Wikilink auf `target_path` zeigen.
///
/// `target_path` und Index-Pfade werden auf Forward-Slashes normalisiert;
/// Vergleich ist exakt (Schreibweise des Index). Die eigene Datei zählt
/// nicht. Caps: [`BACKLINKS_MAX_SOURCES`] / [`BACKLINKS_MAX_HITS_PER_FILE`].
///
/// **Code-Ausschluss** (pragmatisch, kein AST-Parse pro Datei):
/// 1. Fenced code: Zeilen, die nach Trim mit ``` oder ~~~ beginnen, toggeln
///    einen Fence-Zustand; innerhalb zählen keine `[[…]]`.
/// 2. Inline-Code: `` `…` ``-Spans (einfache Backticks, best effort) werden
///    maskiert, bevor die Suche läuft.
///
/// Bewusste Grenzen: verschachtelte Fences, Indented-Code und mehrfache
/// Backtick-Längen sind V1 nicht abgedeckt.
pub fn find_backlinks(
    pinned: &[PinnedItem],
    target_path: &str,
    index: &WikilinkIndex,
) -> BacklinksResult {
    let target = target_path.replace('\\', "/");
    if target.is_empty() {
        return BacklinksResult {
            sources: Vec::new(),
            truncated: false,
        };
    }

    let roots = resolve_scope(pinned, &SearchScope::Vault);
    let mut seen: HashSet<String> = HashSet::new();
    let mut sources: Vec<BacklinkSource> = Vec::new();
    let mut any_file_capped = false;

    let mut consider = |path: PathBuf| {
        let normalized = normalize_path(&path);
        if classify(&normalized) != FileKind::Markdown {
            return;
        }
        if !seen.insert(normalized.clone()) {
            return;
        }
        if paths_equal(&normalized, &target) {
            return;
        }
        let Some(content) = read_md_for_backlinks(&path) else {
            return;
        };
        let (hits, capped) = scan_file_for_backlinks(&content, &target, index, &normalized);
        if capped {
            any_file_capped = true;
        }
        if hits.is_empty() {
            return;
        }
        let name = file_name_of(&path);
        sources.push(BacklinkSource {
            path: normalized,
            name,
            hits,
        });
    };

    for dir in &roots.dirs {
        let walker = WalkBuilder::new(dir)
            .sort_by_file_name(|a, b| a.cmp(b))
            .build();
        for result in walker {
            let Ok(entry) = result else { continue };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            consider(entry.path().to_path_buf());
        }
    }
    for file in &roots.files {
        if file.is_file() {
            consider(file.clone());
        }
    }

    sources.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });

    let source_truncated = sources.len() > BACKLINKS_MAX_SOURCES;
    if source_truncated {
        sources.truncate(BACKLINKS_MAX_SOURCES);
    }

    BacklinksResult {
        sources,
        truncated: any_file_capped || source_truncated,
    }
}

fn read_md_for_backlinks(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return None;
    }
    let sniff_end = bytes.len().min(BACKLINKS_NUL_SNIFF);
    if bytes[..sniff_end].contains(&0u8) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Scannt eine Datei; liefert Hits (max. Cap) und ob abgeschnitten wurde.
///
/// Auflösung nutzt `source_path` als Kontextdokument (W7) — nicht das
/// Backlink-Ziel. So zählt `[[README]]` in Projekt A nur als Backlink auf
/// `A/README.md`, nicht auf ein fremdes `B/README.md`.
fn scan_file_for_backlinks(
    content: &str,
    target_path: &str,
    index: &WikilinkIndex,
    source_path: &str,
) -> (Vec<BacklinkHit>, bool) {
    let mut hits: Vec<BacklinkHit> = Vec::new();
    let mut capped = false;
    let mut in_fence = false;
    let source = Path::new(source_path);

    for (line_idx, line) in content.lines().enumerate() {
        let line_no = (line_idx + 1) as u32;
        if is_fence_toggle_line(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }

        let masked = mask_inline_code(line);
        for (raw, start, end) in find_wikilink_spans(&masked) {
            let parsed = parse_target(&raw);
            if parsed.name.is_empty() {
                continue;
            }
            let Some(entry) = index.resolve_name_from(&parsed.name, source) else {
                continue;
            };
            if !paths_equal(&entry.path, target_path) {
                continue;
            }
            if hits.len() >= BACKLINKS_MAX_HITS_PER_FILE {
                capped = true;
                break;
            }
            hits.push(BacklinkHit {
                line: line_no,
                snippet: make_snippet(line, start, end),
            });
        }
        if capped {
            break;
        }
    }

    (hits, capped)
}

fn is_fence_toggle_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

/// Ersetzt `` `…` ``-Spans durch Spaces (längenerhaltend, best effort).
fn mask_inline_code(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '`' {
            if let Some(rel) = chars[i + 1..].iter().position(|&c| c == '`') {
                let end = i + 1 + rel;
                for _ in i..=end {
                    out.push(' ');
                }
                i = end + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `[[target]]` / `![[target]]` auf einer Zeile → (raw_inner, start, end)
/// in Char-Offsets (für Snippet am Original).
///
/// Backslash-escapte Vorkommen (`\[[Ziel]]`, `!\[[Ziel]]`) zaehlen NICHT:
/// der Renderer macht daraus keinen Wikilink, also darf der Scan daraus
/// auch keinen Backlink machen (Review codex #10). Ein doppelter Backslash
/// (`\\[[Ziel]]`) ist ein escapter Backslash und laesst den Link stehen.
fn find_wikilink_spans(line: &str) -> Vec<(String, usize, usize)> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let bang = chars[i] == '!';
        let open = if bang { i + 1 } else { i };
        if open + 1 < chars.len()
            && chars[open] == '['
            && chars[open + 1] == '['
            && !is_escaped(&chars, open)
        {
            let content_start = open + 2;
            let mut j = content_start;
            let mut found = None;
            while j + 1 < chars.len() {
                if chars[j] == ']' && chars[j + 1] == ']' {
                    found = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(close) = found {
                let inner: String = chars[content_start..close].iter().collect();
                let end = close + 2;
                out.push((inner, i, end));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Steht vor `start` eine ungerade Zahl Backslashes? Dann ist das Zeichen
/// an `start` escaped.
fn is_escaped(chars: &[char], start: usize) -> bool {
    let mut backslashes = 0usize;
    let mut i = start;
    while i > 0 && chars[i - 1] == '\\' {
        backslashes += 1;
        i -= 1;
    }
    backslashes % 2 == 1
}

// ---------------------------------------------------------------------------
// Headings for autocomplete (W4)
// ---------------------------------------------------------------------------

/// Eine Überschrift für `wikilink_headings` / `[[Name#`-Complete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkHeading {
    /// Roher Heading-Text (insertText; Auflösung slugifiziert selbst).
    pub text: String,
    pub level: u8,
}

/// Löst den Zieldateipfad für Heading-Autocomplete auf.
///
/// - leerer `name` → `current_path` (aktuelles Dokument, `[[#…]]`)
/// - sonst Index-Lookup wie beim Renderer; mit `current_path` lokalitätsbewusst (W7)
pub fn resolve_heading_source(
    index: &WikilinkIndex,
    name: &str,
    current_path: Option<&str>,
) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return current_path
            .map(|p| p.replace('\\', "/"))
            .filter(|p| !p.is_empty());
    }
    match current_path {
        Some(ctx) if !ctx.is_empty() => index
            .resolve_name_from(name, Path::new(&ctx.replace('\\', "/")))
            .map(|e| e.path.clone()),
        _ => index.resolve_name(name).map(|e| e.path.clone()),
    }
}

/// Liest `path` und extrahiert Überschriften über [`crate::toc::extract`]
/// (kein eigener Heading-Regex).
pub fn headings_for_path(path: &str) -> Result<Vec<WikilinkHeading>, String> {
    let path = path.replace('\\', "/");
    if path.is_empty() {
        return Err("empty path".into());
    }
    let content =
        read_md_for_backlinks(Path::new(&path)).ok_or_else(|| format!("could not read {path}"))?;
    let entries = crate::toc::extract(&content);
    Ok(entries
        .into_iter()
        .map(|e| WikilinkHeading {
            text: e.text,
            level: e.level,
        })
        .collect())
}

/// Kombiniert Auflösung + Extraktion (testbarer Kern von `wikilink_headings`).
pub fn headings_for_wikilink_name(
    index: &WikilinkIndex,
    name: &str,
    current_path: Option<&str>,
) -> Result<Vec<WikilinkHeading>, String> {
    let path = resolve_heading_source(index, name, current_path)
        .ok_or_else(|| "wikilink target not found".to_string())?;
    headings_for_path(&path)
}

// ---------------------------------------------------------------------------
// Autocomplete candidates (F7 / Review codex #5+#6)
// ---------------------------------------------------------------------------

/// Ein Datei-Kandidat für `[[`-Autocomplete — Index-Scope (gitignore/
/// hidden wie der Resolver), mit vorberechnetem `insert`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkCandidate {
    /// Dateiname (Basename inkl. Extension).
    pub name: String,
    /// Vault-relativer Pfad (POSIX), bei Datei-Pins oft nur der Basename.
    pub relative: String,
    /// Absoluter Pfad, Forward-Slashes.
    pub path: String,
    /// `markdown` | `image` | `text` | `binary` (serde-lowercase von FileKind).
    pub kind: String,
    /// Text, der bei Auswahl nach `[[` eingefügt wird.
    pub insert: String,
}

/// Alle eindeutigen Dateien aus dem Index als Autocomplete-Kandidaten.
///
/// `insert` (Markdown): mit Kontextdokument der **kürzeste** Insert, der aus
/// diesem Kontext heraus wieder genau diese Datei auflöst (W7). Ohne Kontext
/// wie bisher: Basename-Stem wenn global eindeutig, sonst relativer/absoluter
/// Suffix. Bilder: immer voller Dateiname.
pub fn collect_wikilink_candidates(
    index: &WikilinkIndex,
    context: Option<&Path>,
) -> Vec<WikilinkCandidate> {
    let entries = unique_index_entries(index);
    // Basename-Stem-Häufigkeit über ALLE Einträge (auch Nicht-MD) — so
    // zählt ein Datei-Pin `Alpha.md` gegen einen Ordner-`Alpha.md`.
    let mut stem_counts: HashMap<String, usize> = HashMap::new();
    for e in &entries {
        let stem = strip_md_extension(&file_name_of(Path::new(&e.path))).to_lowercase();
        *stem_counts.entry(stem).or_default() += 1;
    }
    // Relative-Stems (MD ohne .md, sonst mit Ext) für Suffix-Eindeutigkeit.
    let rel_stems: Vec<String> = entries
        .iter()
        .map(|e| candidate_rel_stem(e).to_lowercase())
        .collect();
    let abs_stems: Vec<String> = entries
        .iter()
        .map(|e| candidate_abs_stem(e).to_lowercase())
        .collect();

    let mut out: Vec<WikilinkCandidate> = Vec::with_capacity(entries.len());
    for e in &entries {
        let name = file_name_of(Path::new(&e.path));
        let kind = classify(&e.path);
        let kind_str = match kind {
            FileKind::Markdown => "markdown",
            FileKind::Image => "image",
            FileKind::Text => "text",
            FileKind::Binary => "binary",
        }
        .to_string();
        let insert = match context {
            Some(ctx) => compute_insert_text_from_context(e, kind, ctx, index),
            None => compute_insert_text_global(e, kind, &stem_counts, &rel_stems, &abs_stems),
        };
        out.push(WikilinkCandidate {
            name,
            relative: e.relative.clone(),
            path: e.path.clone(),
            kind: kind_str,
            insert,
        });
    }
    // Stabile Sortierung: relative, dann path.
    out.sort_by(|a, b| {
        a.relative
            .to_lowercase()
            .cmp(&b.relative.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });
    out
}

fn unique_index_entries(index: &WikilinkIndex) -> Vec<IndexEntry> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<IndexEntry> = Vec::new();
    for candidates in index.entries.values() {
        for e in candidates {
            if seen.insert(e.path.clone()) {
                out.push(e.clone());
            }
        }
    }
    out
}

fn strip_md_extension(name: &str) -> String {
    if let Some(stripped) = name
        .strip_suffix(".md")
        .or_else(|| name.strip_suffix(".MD"))
        .or_else(|| name.strip_suffix(".Md"))
        .or_else(|| name.strip_suffix(".mD"))
    {
        return stripped.to_string();
    }
    // case-insensitive .md
    if name.len() >= 3 && name[name.len() - 3..].eq_ignore_ascii_case(".md") {
        return name[..name.len() - 3].to_string();
    }
    name.to_string()
}

/// Relativer Stem: Markdown ohne `.md`, sonst relative unverändert.
fn candidate_rel_stem(e: &IndexEntry) -> String {
    let rel = e.relative.replace('\\', "/");
    if classify(&e.path) == FileKind::Markdown {
        strip_md_extension(&rel)
    } else {
        rel
    }
}

fn candidate_abs_stem(e: &IndexEntry) -> String {
    let path = e.path.replace('\\', "/");
    if classify(&e.path) == FileKind::Markdown {
        strip_md_extension(&path)
    } else {
        path
    }
}

/// Kontextfreie Insert-Disambiguierung (global eindeutiger Stem/Suffix).
fn compute_insert_text_global(
    e: &IndexEntry,
    kind: FileKind,
    stem_counts: &HashMap<String, usize>,
    rel_stems: &[String],
    abs_stems: &[String],
) -> String {
    let name = file_name_of(Path::new(&e.path));
    if kind == FileKind::Image {
        return name;
    }
    if kind != FileKind::Markdown {
        // Nicht-MD (Text/Binary) — Frontend filtert; Insert = Name.
        return name;
    }

    let stem = strip_md_extension(&name);
    let stem_key = stem.to_lowercase();
    if stem_counts.get(&stem_key).copied().unwrap_or(0) <= 1 {
        return stem;
    }

    // Kürzester komponentengrenzen-sicherer eindeutiger Suffix des Relatives.
    let rel = candidate_rel_stem(e);
    let components: Vec<&str> = rel.split('/').filter(|c| !c.is_empty()).collect();
    for n in 1..=components.len() {
        let suffix = components[components.len() - n..].join("/");
        let suffix_lower = suffix.to_lowercase();
        let matches = rel_stems
            .iter()
            .filter(|r| ends_with_components(r, &suffix_lower))
            .count();
        if matches == 1 {
            return suffix;
        }
    }

    // Relative kollidiert (Multi-Root gleiches Layout) → abs. Pfad-Suffix.
    let abs = candidate_abs_stem(e);
    let abs_components: Vec<&str> = abs.split('/').filter(|c| !c.is_empty()).collect();
    for n in 1..=abs_components.len() {
        let suffix = abs_components[abs_components.len() - n..].join("/");
        let suffix_lower = suffix.to_lowercase();
        let matches = abs_stems
            .iter()
            .filter(|r| ends_with_components(r, &suffix_lower))
            .count();
        if matches == 1 {
            return suffix;
        }
    }

    // Fallback: voller absoluter Stem (garantiert path-eindeutig).
    abs
}

/// Kürzester Insert-String, der aus `context` heraus genau `e.path` auflöst.
/// Gilt für Markdown **und** Bilder/Nicht-MD (Basename nur wenn verifiziert).
fn compute_insert_text_from_context(
    e: &IndexEntry,
    kind: FileKind,
    context: &Path,
    index: &WikilinkIndex,
) -> String {
    let name = file_name_of(Path::new(&e.path));

    // Markdown: Stem ohne .md; sonst voller Dateiname (mit Extension).
    let bare = if kind == FileKind::Markdown {
        strip_md_extension(&name)
    } else {
        name.clone()
    };
    if insert_resolves_to(index, &bare, context, &e.path) {
        return bare;
    }

    // Relative Suffixe (MD ohne .md, sonst mit Extension) — kürzester zuerst.
    let rel = if kind == FileKind::Markdown {
        candidate_rel_stem(e)
    } else {
        e.relative.replace('\\', "/")
    };
    let components: Vec<&str> = rel.split('/').filter(|c| !c.is_empty()).collect();
    for n in 1..=components.len() {
        let suffix = components[components.len() - n..].join("/");
        if insert_resolves_to(index, &suffix, context, &e.path) {
            return suffix;
        }
    }

    let abs = if kind == FileKind::Markdown {
        candidate_abs_stem(e)
    } else {
        e.path.replace('\\', "/")
    };
    let abs_components: Vec<&str> = abs.split('/').filter(|c| !c.is_empty()).collect();
    for n in 1..=abs_components.len() {
        let suffix = abs_components[abs_components.len() - n..].join("/");
        if insert_resolves_to(index, &suffix, context, &e.path) {
            return suffix;
        }
    }

    abs
}

fn insert_resolves_to(
    index: &WikilinkIndex,
    insert: &str,
    context: &Path,
    expected_path: &str,
) -> bool {
    index
        .resolve_name_from(insert, context)
        .is_some_and(|hit| paths_equal(&hit.path, expected_path))
}

fn make_snippet(line: &str, match_start: usize, match_end: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    if n <= BACKLINKS_SNIPPET_CHARS {
        return line.to_string();
    }
    let mut start = match_start.saturating_sub(40).min(n);
    let end = (start + BACKLINKS_SNIPPET_CHARS).max(match_end).min(n);
    if end - start > BACKLINKS_SNIPPET_CHARS {
        start = end.saturating_sub(BACKLINKS_SNIPPET_CHARS);
    }
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s.insert(0, '…');
    }
    if end < n {
        s.push('…');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::render_body_with_wikilinks;
    use std::fs;
    use tempfile::TempDir;

    // --- Fixtures -----------------------------------------------------------

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    /// Minimales Fake-Repo, damit `ignore::WalkBuilder` .gitignore ehrt
    /// (require_git-Default) — analog zu den search.rs-Tests.
    fn init_git(root: &Path) {
        let git = root.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
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

    /// Standard-Vault:
    ///
    /// ```text
    /// Alpha.md
    /// notes/Alpha.md
    /// notes/Beta.md          (# Erste Ueberschrift)
    /// notes/data.json
    /// images/bild.png
    /// deep/sub/Gamma.md
    /// a/Note.md
    /// b/Note.md
    /// ```
    fn vault() -> TempDir {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        write(root, "Alpha.md", "# Alpha (Wurzel)\n");
        write(root, "notes/Alpha.md", "# Alpha (notes)\n");
        write(
            root,
            "notes/Beta.md",
            "# Erste Ueberschrift\n\nText\n\n## Zweite Überschrift\n",
        );
        write(root, "notes/data.json", "{}\n");
        write(root, "images/bild.png", "not-a-real-png");
        write(root, "deep/sub/Gamma.md", "# Gamma\n");
        write(root, "a/Note.md", "# A\n");
        write(root, "b/Note.md", "# B\n");
        temp
    }

    fn index_of(temp: &TempDir) -> Arc<WikilinkIndex> {
        Arc::new(WikilinkIndex::build(&[pin_dir(temp.path())]))
    }

    /// Kontext mit `current_doc` = `<vault>/<rel>`.
    fn ctx(temp: &TempDir, rel: &str) -> WikilinkContext {
        WikilinkContext::new(index_of(temp), temp.path().join(rel))
    }

    fn resolved_href(temp: &TempDir, current: &str, target: &str) -> String {
        match ctx(temp, current).resolve(target) {
            WikilinkResolution::Resolved { href, .. } => href,
            other => panic!("expected resolved, got {other:?}"),
        }
    }

    // --- Parsing ------------------------------------------------------------

    #[test]
    fn parse_target_splits_heading_alias_and_trims() {
        let t = parse_target("  Ordner/Notiz#Erste Ueberschrift|Anzeigetext  ");
        assert_eq!("Ordner/Notiz", t.name);
        assert_eq!(Some("Erste Ueberschrift".to_string()), t.heading);
        assert_eq!(None, t.block_id);
        assert_eq!(Some("Anzeigetext".to_string()), t.alias);
    }

    #[test]
    fn parse_target_recognises_block_reference_instead_of_heading() {
        let t = parse_target("Beta#^abc123");
        assert_eq!("Beta", t.name);
        assert_eq!(None, t.heading);
        assert_eq!(Some("abc123".to_string()), t.block_id);
    }

    #[test]
    fn parse_target_keeps_md_extension_in_name() {
        let t = parse_target("Alpha.md");
        assert_eq!("Alpha.md", t.name);
        assert_eq!(None, t.heading);
        assert_eq!(None, t.alias);
    }

    #[test]
    fn missing_href_percent_encodes_name() {
        assert_eq!("folio-new:Neue%20Notiz", missing_href("Neue Notiz"));
        assert_eq!("folio-new:a%2Fb%2FNeu", missing_href("a/b/Neu"));
        assert_eq!("folio-new:Gr%C3%BC%C3%9Fe", missing_href("Grüße"));
        assert_eq!("folio-new:Plain-Name_1.md", missing_href("Plain-Name_1.md"));
    }

    #[test]
    fn sanitize_export_replaces_folio_new_href_keeps_class() {
        let html = r#"<p><a href="folio-new:Fehlt%20Noch" class="wikilink-missing" data-wikilink="true">Fehlt Noch</a> und <a href="Beta.md" class="wikilink">Beta</a></p>"#;
        let out = sanitize_export_missing_hrefs(html);
        assert!(out.contains("href=\"#\""), "{out}");
        assert!(!out.contains("folio-new:"), "{out}");
        assert!(out.contains("class=\"wikilink-missing\""), "{out}");
        assert!(out.contains("href=\"Beta.md\""), "{out}");
    }

    // --- Index --------------------------------------------------------------

    #[test]
    fn index_matches_name_case_insensitively_without_extension() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        let hit = index.resolve_name("aLpHa").expect("Alpha muss matchen");
        assert!(hit.path.ends_with("/Alpha.md"), "path={}", hit.path);
        assert_eq!("Alpha.md", hit.relative);
    }

    #[test]
    fn index_treats_md_extension_as_equivalent() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        assert_eq!(
            index.resolve_name("Alpha").map(|e| e.path.clone()),
            index.resolve_name("Alpha.md").map(|e| e.path.clone())
        );
        assert_eq!(
            index.resolve_name("Alpha").map(|e| e.path.clone()),
            index.resolve_name("ALPHA.MD").map(|e| e.path.clone())
        );
    }

    #[test]
    fn ambiguous_name_prefers_shortest_vault_relative_path() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        let candidates = index.candidates("alpha");
        assert_eq!(2, candidates.len(), "{candidates:?}");
        assert_eq!("Alpha.md", candidates[0].relative);
        assert_eq!("notes/Alpha.md", candidates[1].relative);
        assert_eq!(
            "Alpha.md",
            index.resolve_name("Alpha").expect("resolved").relative
        );
    }

    #[test]
    fn ambiguous_same_depth_breaks_tie_lexicographically() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        assert_eq!(
            "a/Note.md",
            index.resolve_name("Note").expect("resolved").relative
        );
    }

    #[test]
    fn path_qualified_link_matches_by_suffix() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        assert_eq!(
            "notes/Alpha.md",
            index
                .resolve_name("notes/Alpha")
                .expect("resolved")
                .relative
        );
        assert_eq!(
            "deep/sub/Gamma.md",
            index.resolve_name("sub/Gamma").expect("resolved").relative
        );
        assert_eq!(
            "deep/sub/Gamma.md",
            index
                .resolve_name("DEEP/SUB/gamma.md")
                .expect("resolved")
                .relative
        );
    }

    #[test]
    fn path_qualified_link_without_suffix_match_is_unresolved() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        assert!(index.resolve_name("other/Alpha").is_none());
        // Komponentengrenze: "otes/Alpha" darf nicht auf "notes/Alpha" matchen.
        assert!(index.resolve_name("otes/Alpha").is_none());
    }

    #[test]
    fn images_match_by_full_filename_only() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        assert_eq!(
            "images/bild.png",
            index.resolve_name("bild.png").expect("resolved").relative
        );
        assert_eq!(
            "images/bild.png",
            index.resolve_name("BILD.PNG").expect("resolved").relative
        );
        assert!(
            index.resolve_name("bild").is_none(),
            "Bilder matchen nur mit Extension"
        );
    }

    #[test]
    fn non_markdown_text_files_match_by_full_filename() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        assert_eq!(
            "notes/data.json",
            index.resolve_name("data.json").expect("resolved").relative
        );
        assert!(index.resolve_name("data").is_none());
    }

    #[test]
    fn index_skips_hidden_and_gitignored_files() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        init_git(root);
        write(root, ".gitignore", "Ignored.md\n");
        write(root, "Visible.md", "# V\n");
        write(root, "Ignored.md", "# I\n");
        write(root, ".hidden/Secret.md", "# S\n");

        let index = WikilinkIndex::build(&[pin_dir(root)]);
        assert!(index.resolve_name("Visible").is_some());
        assert!(index.resolve_name("Ignored").is_none());
        assert!(index.resolve_name("Secret").is_none());
    }

    #[test]
    fn explicitly_pinned_single_file_bypasses_filters() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        init_git(root);
        write(root, ".gitignore", "Ignored.md\n");
        write(root, "Ignored.md", "# I\n");

        let index = WikilinkIndex::build(&[pin_dir(root), pin_file(&root.join("Ignored.md"))]);
        assert!(
            index.resolve_name("Ignored").is_some(),
            "Datei-Pin umgeht hidden/gitignore (wie in der Suche)"
        );
    }

    #[test]
    fn dead_pins_are_dropped_silently() {
        let temp = vault();
        let index = WikilinkIndex::build(&[
            pin_dir(temp.path()),
            pin_dir(&temp.path().join("weg")),
            pin_file(&temp.path().join("weg.md")),
        ]);
        assert!(index.resolve_name("Alpha").is_some());
    }

    #[test]
    fn empty_pin_list_yields_empty_index() {
        let index = WikilinkIndex::build(&[]);
        assert!(index.is_empty());
        assert!(index.resolve_name("Alpha").is_none());
    }

    // --- Cache --------------------------------------------------------------

    #[test]
    fn cache_reuses_index_within_ttl() {
        let temp = vault();
        let pins = [pin_dir(temp.path())];
        let cache = WikilinkIndexCache::with_ttl(Duration::from_secs(30));
        let t0 = Instant::now();

        let first = cache.get_at(&pins, t0);
        write(temp.path(), "Neu.md", "# Neu\n");
        let second = cache.get_at(&pins, t0 + Duration::from_secs(29));

        assert_eq!(1, cache.rebuild_count());
        assert!(Arc::ptr_eq(&first, &second));
        assert!(
            second.resolve_name("Neu").is_none(),
            "innerhalb der TTL bleibt der alte Stand stehen"
        );
    }

    // Vertragsaenderung aus dem Review (codex #2 / kimi #1):
    // abgelaufen ODER invalidiert => stale sofort + Rebuild im Hintergrund.
    #[test]
    fn cache_serves_stale_after_ttl_and_refreshes_in_background() {
        let temp = vault();
        let pins = [pin_dir(temp.path())];
        let cache = WikilinkIndexCache::with_inline_refresh(Duration::from_secs(30));
        let t0 = Instant::now();

        let first = cache.get_at(&pins, t0);
        write(temp.path(), "Neu.md", "# Neu\n");
        let stale = cache.get_at(&pins, t0 + Duration::from_secs(31));

        assert!(
            Arc::ptr_eq(&first, &stale),
            "abgelaufener Index wird sofort (stale) ausgeliefert"
        );
        assert!(stale.resolve_name("Neu").is_none());
        // Der Hintergrund-Rebuild ist gelaufen und veroeffentlicht.
        assert_eq!(2, cache.rebuild_count());
        let fresh = cache.get_at(&pins, t0 + Duration::from_secs(32));
        assert!(fresh.resolve_name("Neu").is_some());
    }

    #[test]
    fn cache_serves_stale_after_explicit_invalidate_then_refreshes() {
        let temp = vault();
        let pins = [pin_dir(temp.path())];
        let cache = WikilinkIndexCache::with_inline_refresh(Duration::from_secs(30));
        let t0 = Instant::now();

        let first = cache.get_at(&pins, t0);
        write(temp.path(), "Neu.md", "# Neu\n");
        cache.invalidate();
        let stale = cache.get_at(&pins, t0 + Duration::from_millis(1));

        assert!(
            Arc::ptr_eq(&first, &stale),
            "invalidate liefert stale, blockiert nicht"
        );
        assert_eq!(2, cache.rebuild_count());
        let fresh = cache.get_at(&pins, t0 + Duration::from_millis(2));
        assert!(fresh.resolve_name("Neu").is_some());
    }

    #[test]
    fn cold_start_builds_synchronously() {
        let temp = vault();
        let pins = [pin_dir(temp.path())];
        let cache = WikilinkIndexCache::with_ttl(Duration::from_secs(30));

        // Ohne vorhandenen Eintrag gibt es nichts stale auszuliefern.
        let index = cache.get_at(&pins, Instant::now());
        assert!(index.resolve_name("Alpha").is_some());
        assert_eq!(1, cache.rebuild_count());
    }

    #[test]
    fn changed_pin_fingerprint_forces_synchronous_rebuild() {
        let temp = vault();
        let other = TempDir::new().unwrap();
        write(other.path(), "Extern.md", "# E\n");
        let cache = WikilinkIndexCache::with_ttl(Duration::from_secs(30));
        let t0 = Instant::now();

        let first = cache.get_at(&[pin_dir(temp.path())], t0);
        assert!(first.resolve_name("Extern").is_none());

        // Anderer Suchraum: stale waere falsch, nicht nur veraltet.
        let second = cache.get_at(&[pin_dir(other.path())], t0 + Duration::from_millis(1));
        assert!(second.resolve_name("Extern").is_some());
        assert!(second.resolve_name("Alpha").is_none());
        assert_eq!(2, cache.rebuild_count());
    }

    #[test]
    fn build_invalidated_during_rebuild_is_discarded() {
        // codex #1: ein Aufrufer mit altem Pin-Snapshot darf einen
        // zwischenzeitlich invalidierten Cache nicht wieder befuellen.
        let temp = vault();
        let pins = [pin_dir(temp.path())];
        let cache = WikilinkIndexCache::with_ttl(Duration::from_secs(30));
        let t0 = Instant::now();

        let snapshot = cache.generation();
        let built = Arc::new(WikilinkIndex::build(&pins));
        // Paralleler Pin-/Datei-Befehl invalidiert waehrend des Builds.
        cache.invalidate();

        assert!(
            !cache.publish(Arc::clone(&built), snapshot, fingerprint_of(&pins), t0),
            "Build mit veralteter Generation darf nicht veroeffentlicht werden"
        );
        assert_eq!(0, cache.rebuild_count());

        // Gegenprobe: mit aktueller Generation greift die Veroeffentlichung.
        assert!(cache.publish(built, cache.generation(), fingerprint_of(&pins), t0));
        assert_eq!(1, cache.rebuild_count());
    }

    #[test]
    fn fingerprint_reacts_to_pin_set_changes() {
        let temp = vault();
        let a = pin_dir(temp.path());
        let b = pin_file(&temp.path().join("Alpha.md"));
        let only_a = [a.clone()];
        let a_then_b = [a.clone(), b.clone()];
        let b_then_a = [b, a];
        assert_eq!(fingerprint_of(&only_a), fingerprint_of(&only_a));
        assert_ne!(fingerprint_of(&only_a), fingerprint_of(&a_then_b));
        assert_ne!(fingerprint_of(&a_then_b), fingerprint_of(&b_then_a));
    }

    // --- Auflösung im Dokumentkontext ---------------------------------------

    #[test]
    fn resolve_returns_relative_posix_href_in_same_directory() {
        let temp = vault();
        assert_eq!("Beta.md", resolved_href(&temp, "notes/Alpha.md", "Beta"));
    }

    #[test]
    fn resolve_walks_up_across_directory_boundaries() {
        let temp = vault();
        assert_eq!(
            "../../Alpha.md",
            resolved_href(&temp, "deep/sub/Gamma.md", "Alpha")
        );
        assert_eq!(
            "../images/bild.png",
            resolved_href(&temp, "notes/Alpha.md", "bild.png")
        );
    }

    #[test]
    fn resolve_appends_folio_slug_anchor_for_heading_links() {
        let temp = vault();
        assert_eq!(
            "Beta.md#erste-ueberschrift",
            resolved_href(&temp, "notes/Alpha.md", "Beta#Erste Ueberschrift")
        );
        // folio-Slugifier (nicht Obsidians Roh-Heading): Umlaute bleiben,
        // Leerzeichen werden zu '-'.
        assert_eq!(
            "Beta.md#zweite-überschrift",
            resolved_href(&temp, "notes/Alpha.md", "Beta#Zweite Überschrift")
        );
    }

    #[test]
    fn resolve_ignores_block_reference_and_links_to_the_file() {
        let temp = vault();
        assert_eq!(
            "Beta.md",
            resolved_href(&temp, "notes/Alpha.md", "Beta#^abc123")
        );
    }

    #[test]
    fn resolve_ignores_alias_for_target_lookup() {
        let temp = vault();
        assert_eq!(
            resolved_href(&temp, "notes/Alpha.md", "Beta"),
            resolved_href(&temp, "notes/Alpha.md", "Beta|Ganz anderer Text")
        );
    }

    #[test]
    fn resolve_reports_kind_and_absolute_path() {
        let temp = vault();
        match ctx(&temp, "notes/Alpha.md").resolve("bild.png") {
            WikilinkResolution::Resolved { path, kind, .. } => {
                assert_eq!(FileKind::Image, kind);
                assert!(path.ends_with("/images/bild.png"), "path={path}");
                assert!(!path.contains('\\'), "Forward-Slashes: {path}");
            }
            other => panic!("expected resolved image, got {other:?}"),
        }
        match ctx(&temp, "notes/Alpha.md").resolve("Beta") {
            WikilinkResolution::Resolved { kind, .. } => assert_eq!(FileKind::Markdown, kind),
            other => panic!("expected resolved markdown, got {other:?}"),
        }
    }

    #[test]
    fn resolve_missing_target_uses_folio_new_scheme() {
        let temp = vault();
        let resolution = ctx(&temp, "notes/Alpha.md").resolve("Gibt Es Nicht");
        assert!(resolution.is_missing());
        assert_eq!("folio-new:Gibt%20Es%20Nicht", resolution.href());
    }

    #[test]
    fn resolve_missing_target_ignores_alias_and_anchor_in_scheme() {
        let temp = vault();
        let resolution = ctx(&temp, "notes/Alpha.md").resolve("Gibt Es Nicht#Kapitel|Alias");
        assert_eq!("folio-new:Gibt%20Es%20Nicht", resolution.href());
    }

    #[test]
    fn resolve_without_any_pins_is_missing() {
        let temp = vault();
        let empty = WikilinkContext::new(
            Arc::new(WikilinkIndex::build(&[])),
            temp.path().join("notes/Alpha.md"),
        );
        assert!(empty.resolve("Alpha").is_missing());
    }

    // --- Render-Integration (renderer.rs mit Kontext) ------------------------

    #[test]
    fn render_resolved_wikilink_gets_class_and_relative_href() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("Siehe [[Beta]].", Some(&context));

        assert!(html.contains(r#"data-wikilink="true""#), "{html}");
        assert!(html.contains(r#"class="wikilink""#), "{html}");
        assert!(html.contains(r#"href="Beta.md""#), "{html}");
        assert!(!html.contains("wikilink-missing"), "{html}");
        assert!(html.contains(">Beta<"), "{html}");
    }

    #[test]
    fn render_alias_is_display_text_only() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("[[Beta|Zweiter Text]]", Some(&context));

        assert!(html.contains(r#"href="Beta.md""#), "{html}");
        assert!(html.contains(">Zweiter Text<"), "{html}");
    }

    #[test]
    fn render_heading_link_appends_anchor() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("[[Beta#Erste Ueberschrift]]", Some(&context));

        assert!(
            html.contains(r#"href="Beta.md#erste-ueberschrift""#),
            "{html}"
        );
        assert!(html.contains(r#"class="wikilink""#), "{html}");
    }

    #[test]
    fn render_missing_wikilink_uses_missing_class_and_scheme() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("[[Fehlt Hier]]", Some(&context));

        assert!(html.contains(r#"class="wikilink-missing""#), "{html}");
        assert!(html.contains(r#"href="folio-new:Fehlt%20Hier""#), "{html}");
        assert!(html.contains(">Fehlt Hier<"), "{html}");
    }

    #[test]
    fn render_image_embed_becomes_img_node() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("![[bild.png]]", Some(&context));

        assert!(html.contains("<img"), "{html}");
        assert!(html.contains(r#"src="../images/bild.png""#), "{html}");
        assert!(!html.contains("data-wikilink"), "{html}");
        assert!(
            !html.contains("!<img"),
            "das '!' darf nicht stehenbleiben: {html}"
        );
    }

    #[test]
    fn render_embed_label_drops_anchor_part() {
        // Review kimi #8: Obsidian zeigt "Notiz", nicht "Notiz#Ueberschrift".
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("![[Beta#Erste Ueberschrift]]", Some(&context));

        assert!(html.contains(">Beta<"), "{html}");
        assert!(!html.contains("Beta#Erste"), "{html}");
        assert!(
            html.contains(r#"href="Beta.md#erste-ueberschrift""#),
            "{html}"
        );
    }

    #[test]
    fn render_embed_label_prefers_alias_over_name() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("![[Beta#Erste Ueberschrift|Kurz]]", Some(&context));

        assert!(html.contains(">Kurz<"), "{html}");
    }

    #[test]
    fn render_note_embed_becomes_embed_link() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("![[Beta]]", Some(&context));

        assert!(html.contains("wikilink-embed"), "{html}");
        assert!(html.contains(r#"href="Beta.md""#), "{html}");
        assert!(
            !html.contains("!<a"),
            "das '!' darf nicht stehenbleiben: {html}"
        );
    }

    #[test]
    fn render_missing_embed_is_missing_link_without_literal_bang() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("![[Fehlt Hier]]", Some(&context));

        assert!(html.contains("wikilink-missing"), "{html}");
        assert!(html.contains("wikilink-embed"), "{html}");
        assert!(html.contains(r#"href="folio-new:Fehlt%20Hier""#), "{html}");
        assert!(
            !html.contains("!<a"),
            "das '!' darf nicht stehenbleiben: {html}"
        );
    }

    #[test]
    fn render_without_context_falls_back_to_missing_optics() {
        let html = render_body_with_wikilinks("[[Beta]]", None);

        assert!(html.contains(r#"class="wikilink-missing""#), "{html}");
        assert!(html.contains(r#"href="folio-new:Beta""#), "{html}");
    }

    #[test]
    fn render_leaves_wikilinks_in_code_untouched() {
        let temp = vault();
        let context = ctx(&temp, "notes/Alpha.md");
        let html = render_body_with_wikilinks("`[[Beta]]`\n\n```\n[[Beta]]\n```\n", Some(&context));

        assert!(!html.contains("data-wikilink"), "{html}");
        assert_eq!(2, html.matches("[[Beta]]").count(), "{html}");
    }

    // --- Backlinks (W3) -----------------------------------------------------

    #[test]
    fn backlinks_finds_sources_that_link_to_target() {
        let temp = vault();
        write(
            temp.path(),
            "notes/Ref.md",
            "Siehe [[Beta]] und nochmal [[Beta#Erste Ueberschrift|hier]].\n",
        );
        write(temp.path(), "notes/Other.md", "Kein Link hier.\n");
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let target = index.resolve_name("Beta").expect("Beta").path.clone();

        let result = find_backlinks(&pins, &target, &index);
        assert_eq!(1, result.sources.len(), "{result:?}");
        assert!(result.sources[0].path.ends_with("/notes/Ref.md"));
        assert_eq!("Ref.md", result.sources[0].name);
        assert_eq!(2, result.sources[0].hits.len());
        assert_eq!(1, result.sources[0].hits[0].line);
        assert!(result.sources[0].hits[0].snippet.contains("[[Beta]]"));
        assert!(!result.truncated);
    }

    #[test]
    fn backlinks_ignore_backslash_escaped_wikilinks() {
        // Review codex #10: `\[[Beta]]` rendert der Renderer nicht als
        // Wikilink — der Scan darf daraus keinen Backlink machen.
        let temp = vault();
        write(
            temp.path(),
            "notes/Escaped.md",
            "Nur Text: \\[[Beta]] und !\\[[Beta]]\n",
        );
        write(temp.path(), "notes/Real.md", "Echt: [[Beta]]\n");
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let target = index.resolve_name("Beta").expect("Beta").path.clone();

        let result = find_backlinks(&pins, &target, &index);
        assert_eq!(1, result.sources.len(), "{result:?}");
        assert!(result.sources[0].path.ends_with("/notes/Real.md"));
    }

    #[test]
    fn backlinks_count_link_after_escaped_backslash() {
        // `\\[[Beta]]` = escapter Backslash + echter Wikilink.
        let temp = vault();
        write(temp.path(), "notes/Double.md", "Pfad C:\\\\[[Beta]]\n");
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let target = index.resolve_name("Beta").expect("Beta").path.clone();

        let result = find_backlinks(&pins, &target, &index);
        assert_eq!(1, result.sources.len(), "{result:?}");
        assert!(result.sources[0].path.ends_with("/notes/Double.md"));
    }

    #[test]
    fn paths_equal_matches_platform_filesystem_semantics() {
        assert!(paths_equal("/vault/Notes/Beta.md", "/vault/Notes/Beta.md"));
        assert!(!paths_equal(
            "/vault/Notes/Beta.md",
            "/vault/Notes/Other.md"
        ));
        let mixed_case_matches = paths_equal("/vault/Notes/Beta.md", "/vault/notes/beta.md");
        if cfg!(any(windows, target_os = "macos")) {
            assert!(
                mixed_case_matches,
                "case-insensitive Volumes vergleichen gefaltet"
            );
        } else {
            assert!(!mixed_case_matches, "Linux vergleicht exakt");
        }
    }

    #[test]
    fn backlinks_exclude_self_links() {
        let temp = vault();
        write(
            temp.path(),
            "notes/Beta.md",
            "Self [[Beta]] and [[notes/Beta]].\n",
        );
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let target = index.resolve_name("Beta").expect("Beta").path.clone();

        let result = find_backlinks(&pins, &target, &index);
        assert!(
            result.sources.iter().all(|s| s.path != target),
            "self must be excluded: {result:?}"
        );
    }

    #[test]
    fn backlinks_ignore_wikilinks_in_fences_and_inline_code() {
        let temp = vault();
        write(
            temp.path(),
            "notes/Codey.md",
            "Good [[Beta]]\n\
             `[[Beta]]`\n\
             ```\n\
             [[Beta]]\n\
             ```\n\
             ~~~md\n\
             [[Beta]]\n\
             ~~~\n\
             Also ![[Beta]]\n",
        );
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let target = index.resolve_name("Beta").expect("Beta").path.clone();

        let result = find_backlinks(&pins, &target, &index);
        let src = result
            .sources
            .iter()
            .find(|s| s.path.ends_with("/notes/Codey.md"))
            .expect("Codey should appear");
        // Nur die zwei echten Zeilen (Good + ![[Beta]]), Code raus.
        assert_eq!(2, src.hits.len(), "{src:?}");
        assert_eq!(1, src.hits[0].line);
        assert_eq!(9, src.hits[1].line); // after both fences
    }

    #[test]
    fn backlinks_resolves_via_index_shortest_path() {
        // `[[Alpha]]` löst auf die Wurzel-Alpha.md (kürzester Pfad), nicht notes/Alpha.
        let temp = vault();
        write(temp.path(), "Linker.md", "-> [[Alpha]]\n");
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let root_alpha = index.resolve_name("Alpha").expect("Alpha").path.clone();
        assert!(root_alpha.ends_with("/Alpha.md") && !root_alpha.contains("/notes/"));

        let result = find_backlinks(&pins, &root_alpha, &index);
        assert!(
            result
                .sources
                .iter()
                .any(|s| s.path.ends_with("/Linker.md")),
            "{result:?}"
        );

        let notes_alpha = normalize_path(&temp.path().join("notes/Alpha.md"));
        let result_notes = find_backlinks(&pins, &notes_alpha, &index);
        assert!(
            !result_notes
                .sources
                .iter()
                .any(|s| s.path.ends_with("/Linker.md")),
            "unqualified [[Alpha]] must not count as backlink to notes/Alpha"
        );
    }

    #[test]
    fn backlinks_empty_without_pins_or_matches() {
        let temp = vault();
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let target = index.resolve_name("Gamma").expect("Gamma").path.clone();
        let result = find_backlinks(&pins, &target, &index);
        assert!(result.sources.is_empty());
        assert!(!result.truncated);

        let empty = find_backlinks(&[], &target, &WikilinkIndex::build(&[]));
        assert!(empty.sources.is_empty());
    }

    #[test]
    fn backlinks_caps_hits_per_file() {
        let temp = vault();
        let mut body = String::new();
        for i in 0..60 {
            body.push_str(&format!("L{i} [[Beta]]\n"));
        }
        write(temp.path(), "notes/Many.md", &body);
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let target = index.resolve_name("Beta").expect("Beta").path.clone();

        let result = find_backlinks(&pins, &target, &index);
        let src = result
            .sources
            .iter()
            .find(|s| s.path.ends_with("/notes/Many.md"))
            .expect("Many");
        assert_eq!(BACKLINKS_MAX_HITS_PER_FILE, src.hits.len());
        assert!(result.truncated);
    }

    // --- Headings autocomplete (W4) ----------------------------------------

    #[test]
    fn resolve_heading_source_empty_name_uses_current_path() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        let cur = normalize_path(&temp.path().join("notes/Alpha.md"));
        assert_eq!(
            Some(cur.clone()),
            resolve_heading_source(&index, "", Some(&cur))
        );
        assert_eq!(
            Some(cur.clone()),
            resolve_heading_source(&index, "  ", Some(&cur))
        );
        assert!(resolve_heading_source(&index, "", None).is_none());
    }

    #[test]
    fn resolve_heading_source_uses_index() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        let path = resolve_heading_source(&index, "Beta", None).expect("Beta");
        assert!(path.ends_with("/notes/Beta.md"), "{path}");
    }

    #[test]
    fn headings_for_path_uses_toc_extract() {
        let temp = vault();
        let path = normalize_path(&temp.path().join("notes/Beta.md"));
        let headings = headings_for_path(&path).expect("headings");
        assert!(
            headings
                .iter()
                .any(|h| h.text == "Erste Ueberschrift" && h.level == 1),
            "{headings:?}"
        );
        assert!(
            headings
                .iter()
                .any(|h| h.text == "Zweite Überschrift" && h.level == 2),
            "{headings:?}"
        );
    }

    #[test]
    fn headings_for_wikilink_name_empty_is_current_doc() {
        let temp = vault();
        let pins = [pin_dir(temp.path())];
        let index = WikilinkIndex::build(&pins);
        let cur = normalize_path(&temp.path().join("notes/Beta.md"));
        let headings = headings_for_wikilink_name(&index, "", Some(&cur)).expect("headings");
        assert!(!headings.is_empty());
        assert_eq!("Erste Ueberschrift", headings[0].text);
    }

    #[test]
    fn e2e_fixtures_wikilinks_are_indexed() {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/e2e/fixtures/wikilinks");
        assert!(root.is_dir(), "missing {root:?}");
        let index = WikilinkIndex::build(&[pin_dir(&root)]);
        assert!(
            index.resolve_name("B").is_some(),
            "B not found; file_count={}",
            index.file_count()
        );
        assert!(index.resolve_name("A").is_some());
        assert!(index.resolve_name("bild.png").is_some());
    }

    // --- Autocomplete candidates (F7) ---------------------------------------

    #[test]
    fn candidates_unique_basename_inserts_stem() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        let cands = collect_wikilink_candidates(&index, None);
        let beta = cands
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case("Beta.md"))
            .expect("Beta");
        assert_eq!("markdown", beta.kind);
        assert_eq!("Beta", beta.insert);
        let img = cands
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case("bild.png"))
            .expect("bild");
        assert_eq!("image", img.kind);
        assert_eq!("bild.png", img.insert);
    }

    #[test]
    fn candidates_ambiguous_basename_uses_relative_suffix() {
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        let cands = collect_wikilink_candidates(&index, None);
        let alphas: Vec<_> = cands
            .iter()
            .filter(|c| c.name.eq_ignore_ascii_case("Alpha.md"))
            .collect();
        assert!(alphas.len() >= 2, "{alphas:?}");
        let inserts: Vec<&str> = alphas.iter().map(|c| c.insert.as_str()).collect();
        // Beide Inserts unterschiedlich und component-safe.
        assert_eq!(
            inserts.iter().collect::<HashSet<_>>().len(),
            inserts.len(),
            "inserts must disambiguate: {inserts:?}"
        );
        for a in &alphas {
            assert!(
                a.insert == "Alpha" || a.insert.ends_with("/Alpha") || a.insert.contains("Alpha"),
                "unexpected insert {:?}",
                a.insert
            );
            // Basename allein ist mehrdeutig → mind. einer braucht Prefix.
        }
        assert!(
            alphas.iter().any(|c| c.insert.contains('/')),
            "expected at least one path-qualified insert, got {inserts:?}"
        );
    }

    #[test]
    fn candidates_multi_root_same_relative_uses_abs_suffix() {
        // Zwei Vault-Wurzeln mit identischem Layout notes/Alpha.md —
        // relative Suffixe kollidieren; Insert muss über den absoluten
        // Pfad disambiguieren (Review codex #6).
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        write(a.path(), "notes/Alpha.md", "# A\n");
        write(b.path(), "notes/Alpha.md", "# B\n");
        let index = WikilinkIndex::build(&[pin_dir(a.path()), pin_dir(b.path())]);
        let cands = collect_wikilink_candidates(&index, None);
        let alphas: Vec<_> = cands
            .iter()
            .filter(|c| c.name.eq_ignore_ascii_case("Alpha.md"))
            .collect();
        assert_eq!(2, alphas.len(), "{alphas:?}");
        assert_ne!(alphas[0].insert, alphas[1].insert, "{alphas:?}");
        // Beide müssen denselben Kandidaten auflösen können (Suffix → path).
        for c in &alphas {
            assert!(
                c.path.ends_with(&format!("{}.md", c.insert))
                    || c.path
                        .to_lowercase()
                        .ends_with(&format!("{}.md", c.insert.to_lowercase()))
                    || ends_with_components(
                        &candidate_abs_stem(&IndexEntry {
                            path: c.path.clone(),
                            relative: c.relative.clone(),
                            root: String::new(),
                        }),
                        &c.insert.to_lowercase()
                    ),
                "insert {:?} does not uniquely suffix path {}",
                c.insert,
                c.path
            );
        }
    }

    #[test]
    fn candidates_file_pin_duplicates_disambiguate() {
        // Zwei explizite Datei-Pins mit gleichem Basename → relative ist
        // jeweils nur der Basename; Insert braucht abs. Suffix.
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        write(a.path(), "Alpha.md", "# A\n");
        write(b.path(), "Alpha.md", "# B\n");
        let fa = a.path().join("Alpha.md");
        let fb = b.path().join("Alpha.md");
        let index = WikilinkIndex::build(&[pin_file(&fa), pin_file(&fb)]);
        let cands = collect_wikilink_candidates(&index, None);
        let alphas: Vec<_> = cands
            .iter()
            .filter(|c| c.name.eq_ignore_ascii_case("Alpha.md"))
            .collect();
        assert_eq!(2, alphas.len(), "{alphas:?}");
        assert_ne!(alphas[0].insert, alphas[1].insert, "{alphas:?}");
        assert!(
            alphas.iter().all(|c| c.insert != "Alpha"),
            "basename alone must not be used when ambiguous: {alphas:?}"
        );
    }

    // --- W7: Lokalitäts-Priorität ------------------------------------------

    /// Zwei Projekt-Pins mit gleichem Basename-Layout.
    fn dual_project_vault() -> (TempDir, TempDir) {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        write(a.path(), "README.md", "# A root\n");
        write(a.path(), "docs/README.md", "# A docs\n");
        write(a.path(), "TODO.md", "# A todo\n");
        write(a.path(), "notes/x.md", "from A\n");
        write(b.path(), "README.md", "# B root\n");
        write(b.path(), "docs/README.md", "# B docs\n");
        write(b.path(), "TODO.md", "# B todo\n");
        write(b.path(), "notes/y.md", "from B\n");
        (a, b)
    }

    #[test]
    fn w7_same_directory_wins() {
        let (a, b) = dual_project_vault();
        let index = WikilinkIndex::build(&[pin_dir(a.path()), pin_dir(b.path())]);
        let ctx = a.path().join("docs/note.md");
        write(a.path(), "docs/note.md", "ctx\n");
        let hit = index
            .resolve_name_from("README", &ctx)
            .expect("README from docs/");
        assert!(
            hit.path.ends_with("/docs/README.md") && hit.path.contains(a.path().to_str().unwrap()),
            "same-dir docs/README must win, got {}",
            hit.path
        );
    }

    #[test]
    fn w7_same_pin_root_wins_over_foreign() {
        let (a, b) = dual_project_vault();
        let index = WikilinkIndex::build(&[pin_dir(a.path()), pin_dir(b.path())]);
        // notes/x.md is not next to README.md, but same pin root A.
        let ctx = a.path().join("notes/x.md");
        let hit = index
            .resolve_name_from("README", &ctx)
            .expect("README from A/notes");
        assert!(
            hit.path.ends_with("/README.md")
                && !hit.path.contains("/docs/")
                && hit.path.contains(a.path().to_str().unwrap()),
            "A/README.md (same root) must beat B and docs/, got {}",
            hit.path
        );
    }

    #[test]
    fn w7_cross_root_fallback_when_local_missing() {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        write(a.path(), "notes/x.md", "only in A\n");
        write(b.path(), "Unique.md", "# only in B\n");
        let index = WikilinkIndex::build(&[pin_dir(a.path()), pin_dir(b.path())]);
        let ctx = a.path().join("notes/x.md");
        let hit = index
            .resolve_name_from("Unique", &ctx)
            .expect("cross-root Unique");
        assert!(
            hit.path.contains(b.path().to_str().unwrap()),
            "no local Unique → fall back to B, got {}",
            hit.path
        );
    }

    #[test]
    fn w7_nested_pins_longest_root_is_home() {
        let root = TempDir::new().unwrap();
        write(root.path(), "README.md", "# outer\n");
        write(root.path(), "sub/README.md", "# nested\n");
        write(root.path(), "sub/note.md", "ctx\n");
        write(root.path(), "other.md", "ctx outer\n");
        let sub = root.path().join("sub");
        let index = WikilinkIndex::build(&[pin_dir(root.path()), pin_dir(&sub)]);
        // From nested pin: home root = sub → sub/README.
        let hit_nested = index
            .resolve_name_from("README", &root.path().join("sub/note.md"))
            .expect("nested");
        assert!(
            hit_nested.path.ends_with("/sub/README.md"),
            "longest root sub wins, got {}",
            hit_nested.path
        );
        // From outer only: outer README (same root outer; sub is deeper root for sub files only).
        let hit_outer = index
            .resolve_name_from("README", &root.path().join("other.md"))
            .expect("outer");
        assert!(
            hit_outer.path.ends_with("/README.md") && !hit_outer.path.contains("/sub/"),
            "outer home → root README, got {}",
            hit_outer.path
        );
    }

    #[test]
    fn w7_path_qualified_then_locality() {
        let (a, b) = dual_project_vault();
        let index = WikilinkIndex::build(&[pin_dir(a.path()), pin_dir(b.path())]);
        let ctx = a.path().join("notes/x.md");
        // Both have docs/README.md — suffix filter then locality picks A's.
        let hit = index
            .resolve_name_from("docs/README", &ctx)
            .expect("docs/README");
        assert!(
            hit.path.contains(a.path().to_str().unwrap()) && hit.path.ends_with("/docs/README.md"),
            "path-qualified + locality → A/docs/README, got {}",
            hit.path
        );
    }

    #[test]
    fn w7_context_outside_all_pins_uses_global_rank() {
        let (a, b) = dual_project_vault();
        let index = WikilinkIndex::build(&[pin_dir(a.path()), pin_dir(b.path())]);
        // Outside pins: no same-dir / same-root → global first (shortest relative + path tiebreak).
        let outside = TempDir::new().unwrap();
        write(outside.path(), "orphan.md", "x\n");
        let global = index.resolve_name("README").expect("global");
        let from_outside = index
            .resolve_name_from("README", &outside.path().join("orphan.md"))
            .expect("from outside");
        assert_eq!(
            global.path, from_outside.path,
            "outside pins must match context-free resolve_name"
        );
    }

    #[test]
    fn w7_backlink_uses_source_file_not_target() {
        // [[README]] in A/notes/x.md points to A/README — must NOT appear as
        // backlink on B/README.
        let (a, b) = dual_project_vault();
        write(a.path(), "notes/x.md", "see [[README]]\n");
        let pins = [pin_dir(a.path()), pin_dir(b.path())];
        let index = WikilinkIndex::build(&pins);
        let a_readme = normalize_path(&a.path().join("README.md"));
        let b_readme = normalize_path(&b.path().join("README.md"));

        let on_a = find_backlinks(&pins, &a_readme, &index);
        assert!(
            on_a.sources.iter().any(|s| s.path.ends_with("/notes/x.md")),
            "A/notes/x → A/README should count: {on_a:?}"
        );

        let on_b = find_backlinks(&pins, &b_readme, &index);
        assert!(
            !on_b.sources.iter().any(|s| s.path.ends_with("/notes/x.md")),
            "[[README]] in A must not backlink B/README: {on_b:?}"
        );
    }

    #[test]
    fn w7_insert_roundtrip_invariant() {
        // Property: ALLE Kandidaten (inkl. Bilder/Nicht-MD), nicht nur Markdown.
        let (a, b) = dual_project_vault();
        write(a.path(), "images/logo.png", "a-logo");
        write(b.path(), "images/logo.png", "b-logo");
        write(a.path(), "notes/data.json", "{}\n");
        write(b.path(), "notes/data.json", "{}\n");
        let index = WikilinkIndex::build(&[pin_dir(a.path()), pin_dir(b.path())]);
        let ctx = a.path().join("notes/x.md");
        let cands = collect_wikilink_candidates(&index, Some(&ctx));
        assert!(!cands.is_empty());
        for c in &cands {
            let resolved = index.resolve_name_from(&c.insert, &ctx).unwrap_or_else(|| {
                panic!("insert {:?} did not resolve (kind={})", c.insert, c.kind)
            });
            assert!(
                paths_equal(&resolved.path, &c.path),
                "invariant: resolve_name_from({:?}, ctx) = {} but candidate.path = {} (kind={})",
                c.insert,
                resolved.path,
                c.path,
                c.kind
            );
        }
        // Local README from A/notes may be bare "README".
        let a_readme = cands
            .iter()
            .find(|c| {
                c.path.ends_with("/README.md")
                    && c.path.contains(a.path().to_str().unwrap())
                    && !c.path.contains("/docs/")
            })
            .expect("A/README");
        assert_eq!(
            "README", a_readme.insert,
            "context in A should allow bare README insert for A/README"
        );
        // B's logo must not insert bare "logo.png" (would resolve to A's).
        let b_logo = cands
            .iter()
            .find(|c| {
                c.path.ends_with("/images/logo.png") && c.path.contains(b.path().to_str().unwrap())
            })
            .expect("B/logo");
        assert_ne!(
            "logo.png", b_logo.insert,
            "ambiguous image insert must be path-qualified: {b_logo:?}"
        );
        assert!(
            b_logo.insert.contains("logo.png"),
            "insert still names the file: {b_logo:?}"
        );
    }

    #[test]
    fn w7_heading_source_uses_current_path_locality() {
        let (a, b) = dual_project_vault();
        let index = WikilinkIndex::build(&[pin_dir(a.path()), pin_dir(b.path())]);
        let ctx = normalize_path(&a.path().join("notes/x.md"));
        let path = resolve_heading_source(&index, "README", Some(&ctx)).expect("README");
        assert!(
            path.contains(a.path().to_str().unwrap())
                && path.ends_with("/README.md")
                && !path.contains("/docs/"),
            "headings resolve with locality: {path}"
        );
    }

    #[test]
    fn w7_context_free_resolve_name_unchanged_for_single_root() {
        // bestehende globale Rangfolge im Ein-Root-Vault bleibt.
        let temp = vault();
        let index = WikilinkIndex::build(&[pin_dir(temp.path())]);
        assert_eq!(
            "Alpha.md",
            index.resolve_name("Alpha").expect("resolved").relative
        );
    }

    /// F1: `relative` gegen Walk-Wurzel — kontextfreies resolve_name behält
    /// Vor-W7-Rangfolge bei verschachtelten Pins.
    #[test]
    fn w7_f1_nested_pins_context_free_keeps_walk_relative_rank() {
        let v = TempDir::new().unwrap();
        write(v.path(), "x/note.md", "# outer-ish\n");
        write(v.path(), "a/b/note.md", "# nested-ish\n");
        let nested = v.path().join("a");
        let index = WikilinkIndex::build(&[pin_dir(v.path()), pin_dir(&nested)]);
        let hit = index.resolve_name("note").expect("note");
        let expected = normalize_path(&v.path().join("x/note.md"));
        assert!(
            paths_equal(&hit.path, &expected),
            "pre-W7 global rank: walk-relative x/note.md (depth 2) beats a/b/note.md (depth 3); got {} want {}",
            hit.path,
            expected
        );
        assert_eq!("x/note.md", hit.relative);
        // Lokalitäts-root der nested-Datei ist /v/a, relative bleibt walk-basiert.
        let nested_note = index
            .candidates("note")
            .iter()
            .find(|e| e.path.ends_with("/a/b/note.md"))
            .expect("nested note");
        assert_eq!("a/b/note.md", nested_note.relative);
        assert!(
            nested_note.root.ends_with("/a")
                || paths_equal(&nested_note.root, &normalize_path(&nested)),
            "root is longest pin, not walk root: {}",
            nested_note.root
        );
    }

    /// F3: Datei-Pin unter Ordner-Pin → root = Ordner-Pin (Walk und gitignore-Bypass).
    #[test]
    fn w7_f3_file_pin_under_folder_gets_folder_root() {
        let v = TempDir::new().unwrap();
        init_git(v.path());
        write(v.path(), "keep.md", "# keep\n");
        write(v.path(), "tracked.md", "# tracked + file pin\n");
        write(v.path(), "secret.md", "# gitignored + file pin\n");
        fs::write(v.path().join(".gitignore"), "secret.md\n").unwrap();

        let tracked = v.path().join("tracked.md");
        let secret = v.path().join("secret.md");
        let folder_root = normalize_path(v.path());

        // tracked: Walk sieht sie, Datei-Pin wird von seen übersprungen.
        let index =
            WikilinkIndex::build(&[pin_dir(v.path()), pin_file(&tracked), pin_file(&secret)]);
        let t = index
            .candidates("tracked")
            .iter()
            .find(|e| e.path.ends_with("/tracked.md"))
            .expect("tracked");
        assert!(
            paths_equal(&t.root, &folder_root),
            "walk path: root = folder pin, got {}",
            t.root
        );

        // secret: nur via Datei-Pin (gitignore), aber unter Ordner-Pin → gleicher Root.
        let s = index
            .candidates("secret")
            .iter()
            .find(|e| e.path.ends_with("/secret.md"))
            .expect("secret via file pin");
        assert!(
            paths_equal(&s.root, &folder_root),
            "file-pin bypass under folder: root must be folder pin, got {}",
            s.root
        );
    }

    /// F3: Datei-Pin außerhalb aller Ordner-Pins → root = Elternverzeichnis.
    #[test]
    fn w7_f3_orphan_file_pin_root_is_parent() {
        let outside = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        write(project.path(), "in.md", "# in project\n");
        write(outside.path(), "orphan.md", "# orphan\n");
        let orphan = outside.path().join("orphan.md");
        let index = WikilinkIndex::build(&[pin_dir(project.path()), pin_file(&orphan)]);
        let e = index
            .candidates("orphan")
            .iter()
            .find(|c| c.path.ends_with("/orphan.md"))
            .expect("orphan");
        let parent = normalize_path(outside.path());
        assert!(
            paths_equal(&e.root, &parent),
            "orphan file pin root = parent dir, got {} want {}",
            e.root,
            parent
        );
    }
}
