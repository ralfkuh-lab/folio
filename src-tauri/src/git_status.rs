//! Git-Status-Dots fuer den Vault-Baum.
//!
//! Datenquelle ist das `git`-Binary (`git status --porcelain=v1 -z`), nicht
//! libgit2 und nicht ein selbst geparstes `.git/index`. Der Vault-Render
//! bleibt davon unberuehrt: Status laeuft asynchron pro Repo-Root und kommt
//! als `vault:git_status` ins Frontend.
//!
//! Nur zwei Klassen: **modified** und **untracked**. Fail-open: fehlt git,
//! schlaegt der Aufruf fehl, haengt er (Deadline) oder ist der Pfad kein
//! Repo, gibt es keine Dots und hoechstens ein `debug!`.

use crate::workspace::Workspace;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const STATUS_TTL: Duration = Duration::from_secs(15);
const COLLECT_TIMEOUT: Duration = Duration::from_secs(10);
const WAIT_POLL: Duration = Duration::from_millis(50);
const EVENT_NAME: &str = "vault:git_status";

/// Die zwei Anzeige-Zustaende. Alles ausser `??` gilt als modified
/// (inkl. staged, renamed, deleted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeKind {
    Modified,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub status: GitChangeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusPayload {
    pub repo_root: String,
    pub entries: Vec<GitStatusEntry>,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_roots: Option<Vec<String>>,
}

/// Ein Eintrag aus porcelain v1 `-z`, noch repo-relativ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PorcelainEntry {
    pub rel_path: String,
    pub status: GitChangeKind,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepoStatus {
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Clone)]
pub struct GitStatusCache {
    inner: Arc<CacheInner>,
}

#[derive(Debug)]
struct CacheInner {
    ttl: Duration,
    state: Mutex<CacheState>,
}

#[derive(Debug, Default)]
struct CacheState {
    repos: BTreeMap<String, RepoCacheEntry>,
    /// Cache-weit monoton, analog `document:*`-seq: ein verworfenes
    /// Repo darf nach Re-Pin keine kleinere Generation wiederverwenden.
    next_generation: u64,
}

#[derive(Debug, Default)]
struct RepoCacheEntry {
    cached: Option<CachedStatus>,
    generation: u64,
    refreshing: bool,
    in_flight: Option<u64>,
}

#[derive(Debug, Clone)]
struct CachedStatus {
    entries: Vec<GitStatusEntry>,
    built_at: Instant,
    generation: u64,
}

/// Setzt `refreshing` zurueck, sobald der Job (gleiche Generation)
/// endet — auch bei Panic oder fruehem Return.
struct RefreshingGuard {
    cache: GitStatusCache,
    root: String,
    generation: u64,
}

impl RefreshingGuard {
    fn new(cache: GitStatusCache, root: String, generation: u64) -> Self {
        Self {
            cache,
            root,
            generation,
        }
    }
}

impl Drop for RefreshingGuard {
    fn drop(&mut self) {
        self.cache.release_job(&self.root, self.generation);
    }
}

impl Default for GitStatusCache {
    fn default() -> Self {
        Self::new()
    }
}

impl GitStatusCache {
    pub fn new() -> Self {
        Self::with_ttl(STATUS_TTL)
    }

    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(CacheInner {
                ttl,
                state: Mutex::new(CacheState::default()),
            }),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.inner
            .state
            .lock()
            .expect("git status cache must not be poisoned")
    }

    /// Markiert den Cache-Eintrag des Repos als stale. Existiert noch
    /// keiner, wird er angelegt, damit ein laufender Erst-Job verworfen
    /// werden kann.
    pub fn invalidate(&self, repo_root: &str) {
        let root = normalize_abs(repo_root);
        let mut state = self.lock_state();
        let gen = next_gen(&mut state);
        let entry = state.repos.entry(root).or_default();
        entry.generation = gen;
    }

    /// Fenster-Fokus: alle bekannten Repos stale markieren.
    pub fn invalidate_all(&self) {
        let mut state = self.lock_state();
        let roots: Vec<String> = state.repos.keys().cloned().collect();
        for root in roots {
            let gen = next_gen(&mut state);
            if let Some(entry) = state.repos.get_mut(&root) {
                entry.generation = gen;
            }
        }
    }

    /// Invalidiert das Repo, zu dem `path` gehoert. `None`, wenn der
    /// Pfad in keinem Git-Root liegt.
    pub fn invalidate_for_path(&self, path: &str) -> Option<String> {
        let root = repo_root_normalized(path)?;
        self.invalidate(&root);
        Some(root)
    }

    /// Startet einen Job, sofern nicht schon einer laeuft und der Cache
    /// nicht frisch ist. Gibt die Generation zurueck, die der Job spaeter
    /// in [`Self::finish_refresh`] vorlegen muss.
    pub fn begin_refresh(&self, repo_root: &str) -> Option<u64> {
        self.begin_refresh_at(repo_root, Instant::now())
    }

    pub fn begin_refresh_at(&self, repo_root: &str, now: Instant) -> Option<u64> {
        let root = normalize_abs(repo_root);
        let mut state = self.lock_state();
        let ttl = self.inner.ttl;
        if let Some(entry) = state.repos.get(&root) {
            if entry.refreshing {
                return None;
            }
            if let Some(cached) = &entry.cached {
                let fresh = cached.generation == entry.generation
                    && now.saturating_duration_since(cached.built_at) < ttl;
                if fresh {
                    return None;
                }
            }
        }
        let gen = next_gen(&mut state);
        let entry = state.repos.entry(root).or_default();
        entry.generation = gen;
        entry.refreshing = true;
        entry.in_flight = Some(gen);
        Some(gen)
    }

    /// Frischer Cache-Treffer: vollstaendiger Snapshot zum erneuten Emit
    /// (WebView-Reload, Vault-Rebuild innerhalb der TTL).
    pub fn fresh_snapshot(&self, repo_root: &str) -> Option<GitStatusPayload> {
        self.fresh_snapshot_at(repo_root, Instant::now())
    }

    pub fn fresh_snapshot_at(&self, repo_root: &str, now: Instant) -> Option<GitStatusPayload> {
        let root = normalize_abs(repo_root);
        let state = self.lock_state();
        let entry = state.repos.get(&root)?;
        let cached = entry.cached.as_ref()?;
        let fresh = cached.generation == entry.generation
            && now.saturating_duration_since(cached.built_at) < self.inner.ttl;
        if !fresh {
            return None;
        }
        Some(GitStatusPayload {
            repo_root: root,
            entries: cached.entries.clone(),
            generation: cached.generation,
            active_roots: None,
        })
    }

    /// Entfernt Repos, die nicht mehr zur aktuellen Root-Menge gehoeren,
    /// und liefert sie mit einer neuen Generation fuer ein leeres Event.
    pub fn evict_except(&self, keep: &BTreeSet<String>) -> Vec<(String, u64)> {
        let mut state = self.lock_state();
        let gone: Vec<String> = state
            .repos
            .keys()
            .filter(|root| !keep.contains(*root))
            .cloned()
            .collect();
        let mut out = Vec::with_capacity(gone.len());
        for root in gone {
            state.repos.remove(&root);
            out.push((root, next_gen(&mut state)));
        }
        out
    }

    /// Veroeffentlicht das Ergebnis, wenn die Generation noch stimmt.
    /// `None` (fail-open) landet als leere Entry-Liste, damit das Frontend
    /// alte Dots raeumt. Stale Jobs geben `None` zurueck — der Aufrufer
    /// startet dann ggf. neu.
    pub fn finish_refresh(
        &self,
        repo_root: &str,
        snapshot_generation: u64,
        status: Option<GitRepoStatus>,
        now: Instant,
    ) -> Option<GitStatusPayload> {
        let root = normalize_abs(repo_root);
        let mut state = self.lock_state();
        let entry = state.repos.get_mut(&root)?;
        release_in_flight(entry, snapshot_generation);
        if entry.generation != snapshot_generation {
            tracing::debug!(
                target: "folio::git_status",
                repo = %root,
                snapshot_generation,
                current_generation = entry.generation,
                "discarding git status job invalidated during collect"
            );
            return None;
        }
        let entries = status.map(|s| s.entries).unwrap_or_default();
        entry.cached = Some(CachedStatus {
            entries: entries.clone(),
            built_at: now,
            generation: snapshot_generation,
        });
        Some(GitStatusPayload {
            repo_root: root,
            entries,
            generation: snapshot_generation,
            active_roots: None,
        })
    }

    /// True, wenn der veroeffentlichte Stand hinter der aktuellen
    /// Generation zurueckliegt (Invalidate waehrend/nach dem Job).
    pub fn is_stale(&self, repo_root: &str) -> bool {
        let root = normalize_abs(repo_root);
        let state = self.lock_state();
        let Some(entry) = state.repos.get(&root) else {
            return false;
        };
        match &entry.cached {
            Some(cached) => cached.generation != entry.generation,
            None => !entry.refreshing,
        }
    }

    fn release_job(&self, repo_root: &str, generation: u64) {
        let root = normalize_abs(repo_root);
        if let Some(entry) = self.lock_state().repos.get_mut(&root) {
            release_in_flight(entry, generation);
        }
    }

    #[cfg(test)]
    fn generation_of(&self, repo_root: &str) -> u64 {
        let root = normalize_abs(repo_root);
        self.lock_state()
            .repos
            .get(&root)
            .map(|e| e.generation)
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn is_refreshing(&self, repo_root: &str) -> bool {
        let root = normalize_abs(repo_root);
        self.lock_state()
            .repos
            .get(&root)
            .is_some_and(|e| e.refreshing)
    }
}

fn next_gen(state: &mut CacheState) -> u64 {
    let gen = state.next_generation;
    state.next_generation = state.next_generation.saturating_add(1);
    gen
}

fn release_in_flight(entry: &mut RepoCacheEntry, generation: u64) {
    if entry.in_flight == Some(generation) {
        entry.refreshing = false;
        entry.in_flight = None;
    }
}

/// Startet (single-flight) einen Hintergrund-Job fuer `repo_root`.
/// Ein frischer Cache-Treffer wird sofort erneut emittiert.
pub fn spawn_refresh(cache: GitStatusCache, repo_root: String, handle: AppHandle) {
    spawn_refresh_with_active(cache, repo_root, handle, None);
}

fn spawn_refresh_with_active(
    cache: GitStatusCache,
    repo_root: String,
    handle: AppHandle,
    active_roots: Option<Vec<String>>,
) {
    let root = normalize_abs(&repo_root);
    if let Some(mut payload) = cache.fresh_snapshot(&root) {
        payload.active_roots = active_roots.clone();
        emit_status(&handle, &payload);
        if !cache.is_stale(&root) {
            return;
        }
    }
    let Some(generation) = cache.begin_refresh(&root) else {
        return;
    };
    let cache_job = cache.clone();
    let handle_job = handle.clone();
    let root_job = root.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("folio-git-status".to_string())
        .spawn(move || {
            run_refresh(cache_job, root_job, handle_job, generation);
        })
    {
        tracing::debug!(
            target: "folio::git_status",
            %error,
            repo = %root,
            "could not spawn git status thread"
        );
        cache.release_job(&root, generation);
    }
}

fn run_refresh(cache: GitStatusCache, root: String, handle: AppHandle, generation: u64) {
    let _guard = RefreshingGuard::new(cache.clone(), root.clone(), generation);
    let result = collect_status(Path::new(&root));
    let payload = cache.finish_refresh(&root, generation, result, Instant::now());
    if let Some(payload) = payload {
        emit_status(&handle, &payload);
    }
    if cache.is_stale(&root) {
        spawn_refresh(cache, root, handle);
    }
}

fn emit_status(handle: &AppHandle, payload: &GitStatusPayload) {
    if let Err(error) = handle.emit(EVENT_NAME, payload) {
        tracing::debug!(
            target: "folio::git_status",
            %error,
            repo = %payload.repo_root,
            "could not emit vault:git_status"
        );
    }
}

/// Pin-/Recent-Pfade unter dem Workspace-Lock kopieren; Root-Discovery
/// und `git status` laufen danach ohne den Lock.
pub fn workspace_scan_paths(workspace: &Workspace) -> Vec<String> {
    let mut paths = Vec::with_capacity(workspace.pinned().len() + workspace.recent().len());
    for item in workspace.pinned() {
        paths.push(item.path.clone());
    }
    for item in workspace.recent() {
        paths.push(item.path.clone());
    }
    paths
}

/// Plant Refreshs fuer die Git-Roots der gegebenen Pfade. Verwaiste
/// Cache-Eintraege werden entfernt und als leerer Snapshot gemeldet.
pub fn schedule_for_paths(cache: &GitStatusCache, paths: &[String], handle: &AppHandle) {
    let roots = repo_roots_from_paths(paths);
    let keep: BTreeSet<String> = roots.iter().cloned().collect();
    let orphans = cache.evict_except(&keep);
    let active = Some(roots.clone());
    for (root, generation) in orphans {
        emit_status(
            handle,
            &GitStatusPayload {
                repo_root: root,
                entries: Vec::new(),
                generation,
                active_roots: active.clone(),
            },
        );
    }
    for root in roots {
        spawn_refresh_with_active(cache.clone(), root, handle.clone(), active.clone());
    }
}

/// Invalidiert das Repo von `path` und startet einen Refresh.
pub fn refresh_for_path(cache: &GitStatusCache, path: &str, handle: &AppHandle) {
    refresh_for_paths(cache, [path], handle);
}

/// Wie [`refresh_for_path`], aber Roots zuerst sammeln und deduplizieren —
/// Rename im selben Repo startet nur einen Job.
pub fn refresh_for_paths<I, S>(cache: &GitStatusCache, paths: I, handle: &AppHandle)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let collected: Vec<String> = paths.into_iter().map(|p| p.as_ref().to_string()).collect();
    let roots = repo_roots_from_paths(&collected);
    for root in roots {
        cache.invalidate(&root);
        spawn_refresh(cache.clone(), root, handle.clone());
    }
}

pub fn repo_roots_from_paths(paths: &[String]) -> Vec<String> {
    let mut roots = BTreeSet::new();
    for path in paths {
        if let Some(root) = repo_root_normalized(path) {
            roots.insert(root);
        }
    }
    roots.into_iter().collect()
}

pub fn repo_root_normalized(path: &str) -> Option<String> {
    crate::git_branch::repo_root(Path::new(path)).map(|p| normalize_abs(&path_to_string(&p)))
}

/// `git status --porcelain=v1 -z --untracked-files=normal` im Repo-Root.
/// Fail-open: jeder Fehler, Timeout, kein Binary, kein Repo → `None`.
pub fn collect_status(repo_root: &Path) -> Option<GitRepoStatus> {
    collect_status_timed(repo_root, COLLECT_TIMEOUT)
}

fn collect_status_timed(repo_root: &Path, timeout: Duration) -> Option<GitRepoStatus> {
    if !repo_root.is_dir() {
        return None;
    }
    let mut child = match Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
        .current_dir(repo_root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            tracing::debug!(
                target: "folio::git_status",
                repo = %repo_root.display(),
                %error,
                "git status not available; omitting dots"
            );
            return None;
        }
    };
    match wait_child_with_timeout(&mut child, timeout) {
        Ok(Some(status)) if status.success() => {
            let mut stdout = Vec::new();
            if let Some(mut pipe) = child.stdout.take() {
                let _ = pipe.read_to_end(&mut stdout);
            }
            let raw = parse_porcelain_z(&stdout);
            let resolved = resolve_entries(repo_root, &raw);
            let root = normalize_abs(&path_to_string(repo_root));
            Some(GitRepoStatus {
                entries: aggregate_dirs(&root, &resolved),
            })
        }
        Ok(Some(status)) => {
            tracing::debug!(
                target: "folio::git_status",
                repo = %repo_root.display(),
                code = ?status.code(),
                "git status failed; omitting dots"
            );
            None
        }
        Ok(None) => {
            tracing::debug!(
                target: "folio::git_status",
                repo = %repo_root.display(),
                timeout_ms = timeout.as_millis() as u64,
                "git status timed out; omitting dots"
            );
            None
        }
        Err(error) => {
            tracing::debug!(
                target: "folio::git_status",
                repo = %repo_root.display(),
                %error,
                "git status wait failed; omitting dots"
            );
            None
        }
    }
}

/// Wartet auf `child` bis `timeout`. Bei Ablauf: `kill()` und `wait()`
/// (reap). `Ok(None)` = Timeout (fail-open).
fn wait_child_with_timeout(
    child: &mut Child,
    timeout: Duration,
) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(Some(status)),
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(None);
                }
                std::thread::sleep(WAIT_POLL);
            }
        }
    }
}

/// Parst `git status --porcelain=v1 -z`. Eintraege sind NUL-getrennt;
/// Rename/Copy liefern einen zweiten Pfad (alter Name), der mitgelesen
/// werden muss, sonst verschiebt sich der Parse.
pub fn parse_porcelain_z(bytes: &[u8]) -> Vec<PorcelainEntry> {
    let mut entries = Vec::new();
    let mut parts = bytes.split(|b| *b == 0);
    while let Some(part) = parts.next() {
        if part.is_empty() {
            continue;
        }
        // Framing zuerst: der zweite Rename-/Copy-Pfad wird immer
        // konsumiert, auch wenn der Record spaeter verworfen wird.
        if is_rename_or_copy(part) {
            let _ = parts.next();
        }
        let Some((status, rel_path, is_dir)) = parse_xy_entry(part) else {
            continue;
        };
        entries.push(PorcelainEntry {
            rel_path,
            status,
            is_dir,
        });
    }
    entries
}

fn parse_xy_entry(part: &[u8]) -> Option<(GitChangeKind, String, bool)> {
    if part.len() < 3 {
        return None;
    }
    let xy = &part[..2];
    if part[2] != b' ' {
        return None;
    }
    let raw_path = std::str::from_utf8(&part[3..]).ok()?.replace('\\', "/");
    if raw_path.is_empty() {
        return None;
    }
    let is_dir = raw_path.ends_with('/');
    let rel_path = if is_dir {
        raw_path.trim_end_matches('/').to_string()
    } else {
        raw_path
    };
    if rel_path.is_empty() {
        return None;
    }
    let status = if xy == b"??" {
        GitChangeKind::Untracked
    } else {
        GitChangeKind::Modified
    };
    Some((status, rel_path, is_dir))
}

fn is_rename_or_copy(part: &[u8]) -> bool {
    if part.len() < 2 {
        return false;
    }
    part[0] == b'R' || part[0] == b'C' || part[1] == b'R' || part[1] == b'C'
}

pub fn resolve_entries(repo_root: &Path, raw: &[PorcelainEntry]) -> Vec<ResolvedEntry> {
    let root = normalize_abs(&path_to_string(repo_root));
    raw.iter()
        .map(|entry| ResolvedEntry {
            path: join_repo_path(&root, &entry.rel_path),
            status: entry.status,
            is_dir: entry.is_dir,
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEntry {
    pub path: String,
    pub status: GitChangeKind,
    pub is_dir: bool,
}

/// Praefix-Aggregation: jedes Verzeichnis, das transitiv eine Aenderung
/// enthaelt, bekommt selbst einen Status. Mixed → modified gewinnt.
pub fn aggregate_dirs(repo_root: &str, entries: &[ResolvedEntry]) -> Vec<GitStatusEntry> {
    let root = normalize_abs(repo_root);
    let mut by_path: BTreeMap<String, GitChangeKind> = BTreeMap::new();
    for entry in entries {
        merge_status(&mut by_path, entry.path.clone(), entry.status);
        for ancestor in ancestors_to_root(&entry.path, &root) {
            merge_status(&mut by_path, ancestor, entry.status);
        }
    }
    by_path
        .into_iter()
        .map(|(path, status)| GitStatusEntry { path, status })
        .collect()
}

fn merge_status(map: &mut BTreeMap<String, GitChangeKind>, path: String, status: GitChangeKind) {
    match map.get(&path).copied() {
        Some(GitChangeKind::Modified) => {}
        Some(GitChangeKind::Untracked) if status == GitChangeKind::Modified => {
            map.insert(path, GitChangeKind::Modified);
        }
        Some(GitChangeKind::Untracked) => {}
        None => {
            map.insert(path, status);
        }
    }
}

fn ancestors_to_root(path: &str, root: &str) -> Vec<String> {
    let path = normalize_abs(path);
    let root = normalize_abs(root);
    let mut out = Vec::new();
    let mut current = parent_of(&path);
    while let Some(parent) = current {
        if !is_under(&parent, &root) {
            break;
        }
        let at_root = parent == root;
        out.push(parent.clone());
        if at_root {
            break;
        }
        current = parent_of(&parent);
    }
    out
}

fn is_under(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&(root.to_owned() + "/"))
}

fn parent_of(path: &str) -> Option<String> {
    let path = if path == "/" {
        return None;
    } else {
        path.trim_end_matches('/')
    };
    let idx = path.rfind('/')?;
    if idx == 0 {
        Some("/".to_string())
    } else {
        Some(path[..idx].to_string())
    }
}

fn join_repo_path(repo_root: &str, rel: &str) -> String {
    let root = normalize_abs(repo_root);
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() {
        root
    } else {
        format!("{root}/{rel}")
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_abs(path: &str) -> String {
    let path = path.replace('\\', "/");
    if path == "/" {
        return path;
    }
    path.trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use tempfile::TempDir;

    fn init_git(root: &Path) {
        let git = root.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    fn porcelain(parts: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for part in parts {
            out.extend_from_slice(part);
            out.push(0);
        }
        out
    }

    #[test]
    fn parse_porcelain_z_modified() {
        let bytes = porcelain(&[b" M src/main.rs"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "src/main.rs");
        assert_eq!(entries[0].status, GitChangeKind::Modified);
        assert!(!entries[0].is_dir);
    }

    #[test]
    fn parse_porcelain_z_untracked() {
        let bytes = porcelain(&[b"?? neu.md"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "neu.md");
        assert_eq!(entries[0].status, GitChangeKind::Untracked);
        assert!(!entries[0].is_dir);
    }

    #[test]
    fn parse_porcelain_z_untracked_directory_trailing_slash() {
        let bytes = porcelain(&[b"?? neu/"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "neu");
        assert_eq!(entries[0].status, GitChangeKind::Untracked);
        assert!(entries[0].is_dir);
    }

    #[test]
    fn parse_porcelain_z_rename_consumes_old_and_new_path() {
        // Ohne Konsum des zweiten Pfads wuerde "alt.md" als eigener
        // XY-Eintrag gelesen und " M other.md" verschoben.
        let bytes = porcelain(&[b"R  neu.md", b"alt.md", b" M other.md"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(entries[0].rel_path, "neu.md");
        assert_eq!(entries[0].status, GitChangeKind::Modified);
        assert_eq!(entries[1].rel_path, "other.md");
        assert_eq!(entries[1].status, GitChangeKind::Modified);
    }

    #[test]
    fn parse_porcelain_z_rename_invalid_utf8_still_consumes_old_path() {
        // Neuer Name ist kein UTF-8 — Record verwerfen, aber den alten
        // Pfad trotzdem konsumieren, sonst rutscht der Stream.
        let mut new_rec = b"R  ".to_vec();
        new_rec.extend_from_slice(&[0xff, 0xfe]);
        new_rec.extend_from_slice(b".md");
        let bytes = porcelain(&[&new_rec, b"alt.md", b" M other.md"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0].rel_path, "other.md");
        assert_eq!(entries[0].status, GitChangeKind::Modified);
    }

    #[test]
    fn parse_porcelain_z_copy_consumes_two_paths() {
        let bytes = porcelain(&[b"C  copy.md", b"src.md", b"?? extra.md"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].rel_path, "copy.md");
        assert_eq!(entries[0].status, GitChangeKind::Modified);
        assert_eq!(entries[1].rel_path, "extra.md");
        assert_eq!(entries[1].status, GitChangeKind::Untracked);
    }

    #[test]
    fn parse_porcelain_z_path_with_space() {
        let bytes = porcelain(&[b" M my file.md"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "my file.md");
        assert_eq!(entries[0].status, GitChangeKind::Modified);
    }

    #[test]
    fn parse_porcelain_z_path_with_umlaut() {
        let bytes = porcelain(&[b"?? \xc3\xa4.md"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "ä.md");
        assert_eq!(entries[0].status, GitChangeKind::Untracked);
    }

    #[test]
    fn parse_porcelain_z_empty() {
        assert!(parse_porcelain_z(b"").is_empty());
        assert!(parse_porcelain_z(b"\0").is_empty());
    }

    #[test]
    fn parse_porcelain_z_staged_is_modified() {
        let bytes = porcelain(&[b"M  staged.md", b"A  added.md"]);
        let entries = parse_porcelain_z(&bytes);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.status == GitChangeKind::Modified));
    }

    #[test]
    fn aggregate_dirs_nested_and_repo_root() {
        let entries = vec![
            ResolvedEntry {
                path: "/repo/src/lib.rs".into(),
                status: GitChangeKind::Modified,
                is_dir: false,
            },
            ResolvedEntry {
                path: "/repo/notes/a.md".into(),
                status: GitChangeKind::Untracked,
                is_dir: false,
            },
        ];
        let out = aggregate_dirs("/repo", &entries);
        let map: BTreeMap<_, _> = out.into_iter().map(|e| (e.path, e.status)).collect();
        assert_eq!(map.get("/repo/src/lib.rs"), Some(&GitChangeKind::Modified));
        assert_eq!(map.get("/repo/src"), Some(&GitChangeKind::Modified));
        assert_eq!(map.get("/repo/notes/a.md"), Some(&GitChangeKind::Untracked));
        assert_eq!(map.get("/repo/notes"), Some(&GitChangeKind::Untracked));
        // Mixed children: modified gewinnt an der Wurzel.
        assert_eq!(map.get("/repo"), Some(&GitChangeKind::Modified));
    }

    #[test]
    fn aggregate_dirs_repo_root_itself() {
        let entries = vec![ResolvedEntry {
            path: "/repo/file.md".into(),
            status: GitChangeKind::Untracked,
            is_dir: false,
        }];
        let out = aggregate_dirs("/repo", &entries);
        let map: BTreeMap<_, _> = out.into_iter().map(|e| (e.path, e.status)).collect();
        assert_eq!(map.get("/repo"), Some(&GitChangeKind::Untracked));
        assert_eq!(map.get("/repo/file.md"), Some(&GitChangeKind::Untracked));
    }

    #[test]
    fn aggregate_dirs_untracked_directory() {
        let entries = vec![ResolvedEntry {
            path: "/repo/neu".into(),
            status: GitChangeKind::Untracked,
            is_dir: true,
        }];
        let out = aggregate_dirs("/repo", &entries);
        let map: BTreeMap<_, _> = out.into_iter().map(|e| (e.path, e.status)).collect();
        assert_eq!(map.get("/repo/neu"), Some(&GitChangeKind::Untracked));
        assert_eq!(map.get("/repo"), Some(&GitChangeKind::Untracked));
    }

    #[test]
    fn collect_status_missing_dir_is_none() {
        assert_eq!(
            collect_status(Path::new("/this/path/does/not/exist/folio-git-status")),
            None
        );
    }

    #[test]
    fn collect_status_no_repo_is_none() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(collect_status(tmp.path()), None);
    }

    #[test]
    fn collect_status_fake_git_dir_is_none() {
        let tmp = TempDir::new().unwrap();
        init_git(tmp.path());
        assert_eq!(collect_status(tmp.path()), None);
    }

    #[test]
    fn collect_status_real_repo_untracked() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let init = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(tmp.path())
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .status();
        if !init.map(|s| s.success()).unwrap_or(false) {
            return;
        }
        fs::write(tmp.path().join("neu.md"), "x\n").unwrap();
        let status = collect_status(tmp.path()).expect("git status in real repo");
        let hit = status.entries.iter().find(|e| e.path.ends_with("/neu.md"));
        assert!(
            hit.is_some_and(|e| e.status == GitChangeKind::Untracked),
            "{:?}",
            status.entries
        );
        let root = normalize_abs(&path_to_string(tmp.path()));
        assert!(status
            .entries
            .iter()
            .any(|e| e.path == root && e.status == GitChangeKind::Untracked));
    }

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[test]
    fn begin_refresh_single_flight() {
        let cache = GitStatusCache::new();
        assert!(cache.begin_refresh("/repo").is_some());
        assert!(cache.is_refreshing("/repo"));
        assert!(cache.begin_refresh("/repo").is_none());
    }

    #[test]
    fn finish_refresh_discards_stale_generation() {
        let cache = GitStatusCache::new();
        let gen = cache.begin_refresh("/repo").unwrap();
        cache.invalidate("/repo");
        assert!(cache.generation_of("/repo") > gen);
        let published = cache.finish_refresh(
            "/repo",
            gen,
            Some(GitRepoStatus { entries: vec![] }),
            Instant::now(),
        );
        assert!(published.is_none());
        assert!(!cache.is_refreshing("/repo"));
        assert!(cache.is_stale("/repo"));
        assert!(cache.begin_refresh("/repo").is_some());
    }

    #[test]
    fn finish_refresh_publishes_and_is_fresh() {
        let cache = GitStatusCache::with_ttl(Duration::from_secs(60));
        let gen = cache.begin_refresh("/repo").unwrap();
        let payload = cache
            .finish_refresh(
                "/repo",
                gen,
                Some(GitRepoStatus {
                    entries: vec![GitStatusEntry {
                        path: "/repo/a.md".into(),
                        status: GitChangeKind::Modified,
                    }],
                }),
                Instant::now(),
            )
            .expect("publish");
        assert_eq!(payload.repo_root, "/repo");
        assert_eq!(payload.generation, gen);
        assert_eq!(payload.entries.len(), 1);
        assert!(cache.begin_refresh("/repo").is_none());
        assert!(!cache.is_stale("/repo"));
    }

    #[test]
    fn finish_refresh_none_emits_empty() {
        let cache = GitStatusCache::new();
        let gen = cache.begin_refresh("/repo").unwrap();
        let payload = cache
            .finish_refresh("/repo", gen, None, Instant::now())
            .expect("empty publish");
        assert!(payload.entries.is_empty());
        assert_eq!(payload.generation, gen);
    }

    #[test]
    fn invalidate_all_marks_known_repos_stale() {
        let cache = GitStatusCache::with_ttl(Duration::from_secs(60));
        let gen = cache.begin_refresh("/a").unwrap();
        cache.finish_refresh("/a", gen, None, Instant::now());
        cache.invalidate_all();
        assert!(cache.is_stale("/a"));
        assert!(cache.begin_refresh("/a").is_some());
    }

    #[test]
    fn ttl_expiry_allows_refresh() {
        let cache = GitStatusCache::with_ttl(Duration::from_secs(0));
        let gen = cache.begin_refresh("/repo").unwrap();
        cache.finish_refresh("/repo", gen, None, Instant::now());
        // TTL 0: sofort wieder stale-by-age, aber is_stale (Generation) nicht.
        assert!(!cache.is_stale("/repo"));
        assert!(cache.begin_refresh("/repo").is_some());
    }

    #[test]
    fn fresh_cache_returns_full_snapshot() {
        let cache = GitStatusCache::with_ttl(Duration::from_secs(60));
        let gen = cache.begin_refresh("/repo").unwrap();
        let entries = vec![GitStatusEntry {
            path: "/repo/a.md".into(),
            status: GitChangeKind::Modified,
        }];
        cache.finish_refresh(
            "/repo",
            gen,
            Some(GitRepoStatus {
                entries: entries.clone(),
            }),
            Instant::now(),
        );
        let again = cache.fresh_snapshot("/repo").expect("fresh hit");
        assert_eq!(again.generation, gen);
        assert_eq!(again.entries, entries);
        assert!(cache.begin_refresh("/repo").is_none());
    }

    #[test]
    fn refreshing_guard_releases_on_drop() {
        let cache = GitStatusCache::new();
        let gen = cache.begin_refresh("/repo").unwrap();
        assert!(cache.is_refreshing("/repo"));
        {
            let _guard = RefreshingGuard::new(cache.clone(), "/repo".into(), gen);
        }
        assert!(!cache.is_refreshing("/repo"));
        assert!(cache.begin_refresh("/repo").is_some());
    }

    #[test]
    fn refreshing_guard_releases_on_panic() {
        let cache = GitStatusCache::new();
        let gen = cache.begin_refresh("/repo").unwrap();
        let panicked = catch_unwind(AssertUnwindSafe(|| {
            let _guard = RefreshingGuard::new(cache.clone(), "/repo".into(), gen);
            panic!("collect failed");
        }));
        assert!(panicked.is_err());
        assert!(!cache.is_refreshing("/repo"));
    }

    #[cfg(unix)]
    #[test]
    fn wait_child_times_out_kills_and_reaps() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let started = Instant::now();
        let result = wait_child_with_timeout(&mut child, Duration::from_millis(200)).expect("wait");
        assert!(result.is_none(), "timeout must return Ok(None)");
        assert!(started.elapsed() < Duration::from_secs(2));
        // Reaped: ein zweites wait darf nicht mehr erfolgreich blocken.
        // try_wait nach reap liefert typischerweise Ok(None) oder Err.
        let _ = child.try_wait();
    }

    #[test]
    fn repo_roots_from_paths_dedups_same_repo() {
        let tmp = TempDir::new().unwrap();
        init_git(tmp.path());
        let a = tmp.path().join("a.md");
        let b = tmp.path().join("sub").join("b.md");
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        let paths = vec![
            a.to_string_lossy().replace('\\', "/"),
            b.to_string_lossy().replace('\\', "/"),
        ];
        let roots = repo_roots_from_paths(&paths);
        assert_eq!(roots.len(), 1, "{roots:?}");
    }

    #[test]
    fn evict_except_reports_orphans_with_new_generation() {
        let cache = GitStatusCache::with_ttl(Duration::from_secs(60));
        let gen = cache.begin_refresh("/old").unwrap();
        cache.finish_refresh("/old", gen, None, Instant::now());
        let keep = BTreeSet::from(["/kept".to_string()]);
        let gone = cache.evict_except(&keep);
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].0, "/old");
        assert!(gone[0].1 > gen);
        assert!(cache.fresh_snapshot("/old").is_none());
    }
}
