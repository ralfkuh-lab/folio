use crate::workspace::Workspace;
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

/// Klassifikation eines Eintrags für die Vault-Anzeige.
///
/// `is_directory` ist immer der **effektive** Wert (Symlink-/Junction-/
/// .lnk-Ziel berücksichtigt). `is_link` ist true für jede Form von
/// Verknüpfung (Unix-Symlink, Windows-Symlink, Junction, .lnk). `target`
/// wird nur für `.lnk` gesetzt — bei OS-Links übernimmt das OS die
/// transparente Auflösung beim `read_dir`, der Pfad bleibt unverändert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryInfo {
    pub is_directory: bool,
    pub is_link: bool,
    pub target: Option<PathBuf>,
}

impl EntryInfo {
    fn plain(is_directory: bool) -> Self {
        Self {
            is_directory,
            is_link: false,
            target: None,
        }
    }
}

pub fn classify_entry(path: &Path) -> EntryInfo {
    if let Some(info) = classify_os_link(path) {
        return info;
    }
    if let Some(info) = classify_shortcut(path) {
        return info;
    }
    EntryInfo::plain(path.is_dir())
}

fn classify_os_link(path: &Path) -> Option<EntryInfo> {
    let meta = fs::symlink_metadata(path).ok()?;
    let ft = meta.file_type();
    if !is_os_link(&ft) {
        return None;
    }
    let is_dir = fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
    Some(EntryInfo {
        is_directory: is_dir,
        is_link: true,
        target: None,
    })
}

#[cfg(unix)]
fn is_os_link(ft: &fs::FileType) -> bool {
    ft.is_symlink()
}

#[cfg(windows)]
fn is_os_link(ft: &fs::FileType) -> bool {
    use std::os::windows::fs::FileTypeExt;
    ft.is_symlink() || ft.is_symlink_dir() || ft.is_symlink_file()
}

#[cfg(not(any(unix, windows)))]
fn is_os_link(_ft: &fs::FileType) -> bool {
    false
}

fn classify_shortcut(path: &Path) -> Option<EntryInfo> {
    let is_lnk = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("lnk"))
        .unwrap_or(false);
    if !is_lnk {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let target = parse_lnk_target(&bytes)?;
    if target.as_os_str().is_empty() {
        return None;
    }
    let is_dir = target.is_dir();
    Some(EntryInfo {
        is_directory: is_dir,
        is_link: true,
        target: Some(target),
    })
}

/// Minimaler Parser des `LinkInfo`-Blocks aus MS-SHLLINK
/// (`LocalBasePath` + optional `CommonPathSuffix`, ANSI oder Unicode).
/// Deckt den typischen Fall ab (Shortcut mit absolutem Ziel-Pfad);
/// Netzwerk-Pfade, UWP-Apps und MSI-Shortcuts liefern `None`.
fn parse_lnk_target(bytes: &[u8]) -> Option<PathBuf> {
    fn u32_at(b: &[u8], o: usize) -> Option<usize> {
        Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?) as usize)
    }
    fn u16_at(b: &[u8], o: usize) -> Option<usize> {
        Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?) as usize)
    }

    if u32_at(bytes, 0)? != 0x0000_004C {
        return None;
    }
    let flags = u32_at(bytes, 20)?;
    let has_id_list = flags & 0x01 != 0;
    let has_link_info = flags & 0x02 != 0;

    let mut offset = 76;
    if has_id_list {
        let len = u16_at(bytes, offset)?;
        offset += 2 + len;
    }

    if !has_link_info {
        return None;
    }

    let link_info_size = u32_at(bytes, offset)?;
    let li = bytes.get(offset..offset + link_info_size)?;
    if li.len() < 32 {
        return None;
    }

    let header_size = u32_at(li, 4)?;
    let li_flags = u32_at(li, 8)?;
    let has_volume_and_local = li_flags & 0x01 != 0;
    if !has_volume_and_local {
        return None;
    }

    let local_ansi = u32_at(li, 16)?;
    let suffix_ansi = u32_at(li, 24)?;

    let (local_off, suffix_off, unicode) = if header_size >= 0x24 {
        let local_u = u32_at(li, 28).unwrap_or(0);
        let suffix_u = u32_at(li, 32).unwrap_or(0);
        if local_u > 0 {
            (local_u, suffix_u, true)
        } else {
            (local_ansi, suffix_ansi, false)
        }
    } else {
        (local_ansi, suffix_ansi, false)
    };

    if local_off == 0 {
        return None;
    }

    let base = read_lnk_string(li.get(local_off..)?, unicode)?;
    let suffix = if suffix_off > 0 {
        read_lnk_string(li.get(suffix_off..)?, unicode).unwrap_or_default()
    } else {
        String::new()
    };

    let mut full = base;
    full.push_str(&suffix);
    Some(PathBuf::from(full))
}

fn read_lnk_string(bytes: &[u8], unicode: bool) -> Option<String> {
    if unicode {
        let mut chars: Vec<u16> = Vec::new();
        let mut i = 0;
        while i + 1 < bytes.len() {
            let c = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
            if c == 0 {
                break;
            }
            chars.push(c);
            i += 2;
        }
        String::from_utf16(&chars).ok()
    } else {
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
    }
}

fn strip_lnk_extension(name: &str) -> String {
    if name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(".lnk") {
        name[..name.len() - 4].to_owned()
    } else {
        name.to_owned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultRefreshDelta {
    pub pinned: Option<String>,
    pub recent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpandPathsResult {
    pub paths: Vec<String>,
    pub capped: bool,
}

/// Gemeinsame Filter fuer Lazy-Kinderlisten. Zwei bools in Folge an
/// `on_expand_with` / `expand_paths` waeren leicht zu vertauschen;
/// das Struct macht die Paarung explizit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultListOptions {
    pub markdown_only: bool,
    /// `true` = Dot-Namen sichtbar (Default, historisches Verhalten).
    /// `.git` bleibt unabhaengig davon immer ausgeblendet.
    pub show_hidden: bool,
}

impl Default for VaultListOptions {
    fn default() -> Self {
        Self {
            markdown_only: false,
            show_hidden: true,
        }
    }
}

impl VaultListOptions {
    /// Nur den Typ-Filter setzen; Hidden bleibt sichtbar.
    pub fn markdown_only(markdown_only: bool) -> Self {
        Self {
            markdown_only,
            show_hidden: true,
        }
    }
}

/// Name-basiert und plattformneutral: ein Eintrag ist „versteckt",
/// wenn der Dateiname mit `.` beginnt. Das Windows-Hidden-Attribut
/// wird bewusst nicht ausgewertet (zweite, plattformabhaengige Wahrheit).
pub fn is_vault_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

/// Exakter Verzeichnisname `.git` (nicht Pfad-Substring), analog zur Suche.
pub fn is_git_dir_name(name: &str) -> bool {
    name == ".git"
}

fn child_is_filtered(name: &str, show_hidden: bool) -> bool {
    is_git_dir_name(name) || (!show_hidden && is_vault_hidden_name(name))
}

fn is_under_pin(path: &str, pin: &str) -> bool {
    path == pin || path.starts_with(&format!("{pin}/"))
}

/// `true`, wenn `path` im Baum nicht als Kind erscheinen wuerde.
/// Pin-Wurzeln bleiben sichtbar — auch ein gepinntes `.git` oder `.hidden`.
fn expanded_path_is_invisible(path: &str, show_hidden: bool, pins: &[String]) -> bool {
    if pins.iter().any(|pin| pin == path) {
        return false;
    }
    let rel = pins
        .iter()
        .filter(|pin| is_under_pin(path, pin))
        .max_by_key(|pin| pin.len())
        .map(|pin| &path[pin.len()..])
        .unwrap_or(path);
    rel.split('/')
        .filter(|component| !component.is_empty())
        .any(|component| child_is_filtered(component, show_hidden))
}

#[derive(Debug, Clone)]
pub struct Vault {
    expanded_dirs: BTreeSet<String>,
    active_path: Option<String>,
    /// Lazy-Tree Typ-Filter — **Spiegel** von
    /// `panel_state.vault_filter_markdown_only`, keine eigene Source of Truth.
    ///
    /// Invariante: vor jedem Lazy-Render (`build_dir_children_html` /
    /// `pinned_children_html` / Expand) muss der Wert dem Panel-State
    /// entsprechen. Sync-Pfade: Boot (`state.rs`),
    /// `vault_filter_options_set`, `vault_build_tree`,
    /// `sync_vault_list_options` vor `compute_refresh_delta`, Expand
    /// (`on_expand_with`).
    markdown_only: bool,
    /// Spiegel von `settings.vault_show_hidden` (Default an).
    /// Dieselbe Invariante wie `markdown_only`: vor jedem Lazy-Render
    /// syncen. Quelle ist `settings.json`, nicht `panel_state`.
    show_hidden: bool,
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            expanded_dirs: BTreeSet::new(),
            active_path: None,
            markdown_only: false,
            show_hidden: true,
        }
    }
}

impl Vault {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sync des Lazy-Typ-Filters aus dem Panel-State (vor Tree-Build/Refresh).
    pub fn set_markdown_only(&mut self, markdown_only: bool) {
        self.markdown_only = markdown_only;
    }

    pub fn markdown_only(&self) -> bool {
        self.markdown_only
    }

    pub fn set_show_hidden(&mut self, show_hidden: bool) {
        self.show_hidden = show_hidden;
    }

    pub fn show_hidden(&self) -> bool {
        self.show_hidden
    }

    pub fn set_list_options(&mut self, opts: VaultListOptions) {
        self.markdown_only = opts.markdown_only;
        self.show_hidden = opts.show_hidden;
    }

    pub fn list_options(&self) -> VaultListOptions {
        VaultListOptions {
            markdown_only: self.markdown_only,
            show_hidden: self.show_hidden,
        }
    }

    pub fn build_initial_tree_html(&self, workspace: &Workspace) -> String {
        self.build_initial_tree_html_with(workspace, true, true)
    }

    pub fn build_initial_tree_html_with(
        &self,
        workspace: &Workspace,
        pinned_expanded: bool,
        recent_expanded: bool,
    ) -> String {
        let mut html = String::new();
        html.push_str(&self.section_html(
            "pinned",
            "📌",
            &crate::i18n::t("vault.section.pinned"),
            self.pinned_children_html(workspace),
            pinned_expanded,
        ));
        html.push_str(&self.section_html(
            "recent",
            "🕘",
            &crate::i18n::t("vault.section.recent"),
            self.recent_children_html(workspace),
            recent_expanded,
        ));
        html
    }

    /// Kinder-HTML eines Ordners (Lazy-Tree).
    ///
    /// Einziger Ort, an dem Kinderlisten gefiltert werden (Lazy-Expand
    /// und Pin-Wurzel-Kinder). Pin-Wurzeln selbst laufen nicht hier durch.
    ///
    /// - `.git` ist immer weg (wie der Suchkern).
    /// - andere Namen mit führendem `.` nur bei `show_hidden == false`.
    /// - `markdown_only`: Nicht-Markdown und Ordner ohne (rekursiv)
    ///   Markdown ausgeblendet — siehe Spec vault-filter A1.
    pub fn build_dir_children_html(
        &self,
        path: &str,
        opts: VaultListOptions,
    ) -> io::Result<String> {
        let mut entries = fs::read_dir(path)?
            .filter_map(Result::ok)
            .map(|entry| {
                let path = entry.path();
                let info = classify_entry(&path);
                (path, info)
            })
            .collect::<Vec<_>>();
        entries.sort_by(|(pa, ia), (pb, ib)| {
            ib.is_directory
                .cmp(&ia.is_directory)
                .then_with(|| display_name(pa).cmp(&display_name(pb)))
        });
        let matcher = crate::git_ignore::matcher_for(Path::new(path));
        Ok(entries
            .iter()
            .filter(|(p, info)| {
                let name = display_name(p);
                if child_is_filtered(&name, opts.show_hidden) {
                    return false;
                }
                if !opts.markdown_only {
                    return true;
                }
                if info.is_directory {
                    crate::vault_filter::dir_contains_markdown(p)
                } else {
                    crate::file_kind::classify(&p.to_string_lossy())
                        == crate::file_kind::FileKind::Markdown
                }
            })
            .map(|(p, info)| {
                let ignored = matcher
                    .as_ref()
                    .is_some_and(|m| m.is_ignored(p, info.is_directory));
                self.item_html(&p.to_string_lossy(), info, None, ignored, None, false)
            })
            .collect())
    }

    pub fn compute_refresh_delta(&self, workspace: &Workspace) -> VaultRefreshDelta {
        VaultRefreshDelta {
            pinned: Some(self.pinned_children_html(workspace)),
            recent: Some(self.recent_children_html(workspace)),
        }
    }

    pub fn on_expand(&mut self, path: String) -> io::Result<String> {
        self.on_expand_with(path, self.list_options())
    }

    /// Expand mit expliziten Listen-Optionen (Quellen: Panel-State + Settings).
    pub fn on_expand_with(&mut self, path: String, opts: VaultListOptions) -> io::Result<String> {
        self.set_list_options(opts);
        let path = path.replace('\\', "/");
        self.expanded_dirs.insert(path.clone());
        self.build_dir_children_html(&path, opts)
    }

    /// Soft-Cap fuer gezielte Massen-Expands (Git-Filter). `vault_expand_level`
    /// ist seit R3.1 entfernt; dasselbe 1000er-Cap gilt hier fuer den
    /// bestehenden `on_expand`-Pfad.
    pub const EXPAND_PATHS_CAP: usize = 1000;

    /// Expandiert die gegebenen Verzeichnisse ueber `on_expand` (Watcher
    /// registriert der Caller). Bereits offene Ordner zaehlen nicht.
    /// Sortierung flach zuerst, damit verschachtelte Kinder beim
    /// anschliessenden Tree-Rebuild sichtbar sind.
    pub fn expand_paths(
        &mut self,
        dirs: &[String],
        opts: VaultListOptions,
        cap: usize,
        pin_roots: &[String],
    ) -> ExpandPathsResult {
        self.set_list_options(opts);
        let pins: Vec<String> = pin_roots.iter().map(|p| p.replace('\\', "/")).collect();

        let mut sorted: Vec<String> = dirs
            .iter()
            .map(|p| p.replace('\\', "/"))
            .filter(|p| !p.is_empty())
            .collect();
        sorted.sort_by(|a, b| {
            a.matches('/')
                .count()
                .cmp(&b.matches('/').count())
                .then(a.cmp(b))
        });
        sorted.dedup();

        let mut paths = Vec::new();
        let mut capped = false;
        for norm in sorted {
            if !Path::new(&norm).is_dir() || self.is_expanded(&norm) {
                continue;
            }
            if expanded_path_is_invisible(&norm, opts.show_hidden, &pins) {
                continue;
            }
            if opts.markdown_only && !crate::vault_filter::dir_contains_markdown(Path::new(&norm)) {
                continue;
            }
            if paths.len() >= cap {
                capped = true;
                break;
            }
            match self.on_expand_with(norm.clone(), opts) {
                Ok(_) => paths.push(norm),
                Err(err) => {
                    tracing::warn!(
                        target: "folio::vault",
                        %err,
                        path = %norm,
                        "expand_paths: on_expand failed; skipping"
                    );
                }
            }
        }
        ExpandPathsResult { paths, capped }
    }

    /// Expandiert ausschließlich zugeklappte Pin-Wurzel-Ordner (erste Ebene).
    /// Verschachtelte Ordner bleiben zu. Bei `markdown_only` werden
    /// MD-lose Wurzeln übersprungen. Kein Cap (Anzahl = Anzahl der Pins).
    ///
    /// `pin_dirs`: absolute Pfade der angepinnten Verzeichnisse.
    /// Rückgabe: neu expandierte Pfade (für Watcher-Registrierung).
    pub fn expand_roots(&mut self, pin_dirs: &[String], opts: VaultListOptions) -> Vec<String> {
        self.set_list_options(opts);

        let mut paths = Vec::new();
        for pin in pin_dirs {
            let norm = pin.replace('\\', "/");
            if !Path::new(&norm).is_dir() || self.is_expanded(&norm) {
                continue;
            }
            if opts.markdown_only && !crate::vault_filter::dir_contains_markdown(Path::new(&norm)) {
                continue;
            }
            match self.on_expand_with(norm.clone(), opts) {
                Ok(_) => paths.push(norm),
                Err(err) => {
                    tracing::warn!(
                        target: "folio::vault",
                        %err,
                        path = %norm,
                        "expand_roots: on_expand failed; skipping"
                    );
                }
            }
        }
        paths
    }

    /// Entfernt aufgeklappte Pfade, die der aktuelle Filter nicht mehr
    /// zeigt (`.git` immer; andere Dot-Namen bei `!show_hidden`).
    /// Pin-Wurzeln bleiben — ein direkt gepinntes `.git` waere abwegig
    /// und kostet so keine Extra-Regel.
    /// Rueckgabe: entfernte Pfade (Caller deregistriert die Watches).
    pub fn prune_invisible_expanded(&mut self, pin_roots: &[String]) -> Vec<String> {
        let pins: Vec<String> = pin_roots.iter().map(|p| p.replace('\\', "/")).collect();
        let show_hidden = self.show_hidden;
        let mut pruned = Vec::new();
        self.expanded_dirs.retain(|path| {
            if expanded_path_is_invisible(path, show_hidden, &pins) {
                pruned.push(path.clone());
                false
            } else {
                true
            }
        });
        pruned
    }

    /// Beim Zuklappen eines Ordners auch alle bisher aufgeklappten
    /// Unterordner aus `expanded_dirs` werfen. Damit startet ein
    /// erneutes Aufklappen mit komplett kollabiertem Subtree —
    /// kombiniert mit dem "expand-dir immer neu lesen"-Pfad im
    /// Frontend ist das ein konsequenter Auto-Refresh.
    pub fn on_collapse(&mut self, path: &str) {
        let normalized = path.replace('\\', "/");
        let target = Path::new(&normalized);
        self.expanded_dirs
            .retain(|entry| !Path::new(entry).starts_with(target));
    }

    /// Alles einklappen: leert `expanded_dirs` (Watches deregistriert der Caller).
    pub fn collapse_all(&mut self) {
        self.expanded_dirs.clear();
    }

    pub fn set_active(&mut self, path: Option<String>) {
        // Auf Forward-Slashes normalisieren, damit der Vergleich gegen
        // das normalisierte data-path-Attribut im `item_html`-Render
        // greift — sonst markiert die aktive Datei auf Windows nichts.
        self.active_path = path.map(|p| p.replace('\\', "/"));
    }

    /// Schreibt `expanded_dirs` und `active_path` unter `old_root` um.
    /// Rückgabe: (alte Pfade zum Unwatch, neue Pfade zum Watch).
    pub fn remap_prefix(&mut self, old_root: &str, new_root: &str) -> (Vec<String>, Vec<String>) {
        let old_root = old_root.replace('\\', "/");
        let new_root = new_root.replace('\\', "/");
        let mut unwatch = Vec::new();
        let mut watch = Vec::new();
        let next: BTreeSet<String> = self
            .expanded_dirs
            .iter()
            .map(|path| {
                if let Some(rewritten) = crate::path_migration::remap(path, &old_root, &new_root) {
                    unwatch.push(path.clone());
                    watch.push(rewritten.clone());
                    rewritten
                } else {
                    path.clone()
                }
            })
            .collect();
        self.expanded_dirs = next;
        if let Some(active) = &self.active_path {
            if let Some(rewritten) = crate::path_migration::remap(active, &old_root, &new_root) {
                self.active_path = Some(rewritten);
            }
        }
        (unwatch, watch)
    }

    /// Wirft `expanded_dirs` unter `root` raus und leert `active_path`,
    /// wenn es darunter liegt. Rückgabe: entfernte Watch-Pfade.
    pub fn remove_under(&mut self, root: &str) -> Vec<String> {
        let root = root.replace('\\', "/");
        let mut removed = Vec::new();
        self.expanded_dirs.retain(|path| {
            if crate::path_migration::is_under(path, &root) {
                removed.push(path.clone());
                false
            } else {
                true
            }
        });
        if self
            .active_path
            .as_deref()
            .is_some_and(|path| crate::path_migration::is_under(path, &root))
        {
            self.active_path = None;
        }
        removed
    }

    pub fn is_expanded(&self, path: &str) -> bool {
        let normalized = path.replace('\\', "/");
        self.expanded_dirs.contains(&normalized)
    }

    pub fn expanded_paths(&self) -> Vec<String> {
        self.expanded_dirs.iter().cloned().collect()
    }

    /// Rendert einen Vault-Knoten.
    ///
    /// `force_open_children`: wenn `Some(html)`, wird der Ordner unabhängig
    /// von `expanded_dirs` mit `caret open` und diesen Kindern gerendert
    /// (Filter-Render-Modus). `None` = Lazy-Verhalten über `expanded_dirs`.
    ///
    /// `wikilink_root`: nur an **Pin-Wurzeln** wahr — setzt
    /// `data-wikilink-root="1"` (Opt-in-Zustand für das Kontextmenü, Spec W8,
    /// analog `data-text`).
    pub(crate) fn item_html(
        &self,
        original_path: &str,
        info: &EntryInfo,
        branch: Option<&crate::git_branch::BranchInfo>,
        ignored: bool,
        force_open_children: Option<&str>,
        wikilink_root: bool,
    ) -> String {
        // Bei .lnk-Shortcuts navigieren wir zum aufgelösten Ziel; die
        // Beschriftung verliert die `.lnk`-Endung (analog Explorer).
        // Pfade auf Forward-Slashes normalisieren — egal ob aus
        // workspace.pinned/recent (auf Linux/Windows je nach Plattform)
        // oder aus fs::read_dir (auf Windows Backslashes). Konsistente
        // data-path-Attribute sind Voraussetzung dafuer, dass DOM-
        // Vergleiche, CSS-Selektoren im E2E und workspace-Lookups das
        // gleiche Path-Format sehen.
        let nav_path_raw = info
            .target
            .as_ref()
            .map(|t| t.to_string_lossy().into_owned())
            .unwrap_or_else(|| original_path.to_string());
        let nav_path = nav_path_raw.replace('\\', "/");
        let raw_name = display_name(Path::new(original_path));
        let label_name = if info.target.is_some() {
            strip_lnk_extension(&raw_name)
        } else {
            raw_name
        };

        let is_directory = info.is_directory;
        let expanded = if force_open_children.is_some() {
            is_directory
        } else {
            is_directory && self.is_expanded(&nav_path)
        };
        let active = self.active_path.as_deref() == Some(nav_path.as_str());
        let mut classes = String::from("node");
        if active {
            classes.push_str(" active");
        }
        if info.is_link {
            classes.push_str(" link");
        }
        if ignored {
            classes.push_str(" ignored");
        }
        let kind = if is_directory { "dir" } else { "file" };
        let caret_class = if is_directory {
            if expanded {
                "caret open"
            } else {
                "caret"
            }
        } else {
            "caret hidden"
        };
        let icon_html = if is_directory {
            let emoji = if expanded { "📂" } else { "📁" };
            format!(r#"<span class="icon">{emoji}</span>"#)
        } else {
            // Für .lnk-Shortcuts auf Dateien Icon des Zielpfades nutzen,
            // damit die Datei-Klasse stimmt — sonst Endung des Originals.
            let icon_source = info.target.as_deref().unwrap_or(Path::new(original_path));
            let ext = icon_source
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            format!(
                r#"<span class="icon"><img class="ftype-icon" data-ext="{ext}" alt=""></span>"#,
                ext = escape_attr(&ext),
            )
        };
        let children_class = if expanded {
            "children"
        } else {
            "children collapsed"
        };
        let children = if let Some(forced) = force_open_children {
            forced.to_string()
        } else if expanded {
            self.build_dir_children_html(&nav_path, self.list_options())
                .unwrap_or_else(|error| {
                    // Expandierter Ordner rendert leer (Verhalten bleibt),
                    // aber nicht mehr stumm.
                    tracing::warn!(
                        target: "folio::vault",
                        %error,
                        path = %nav_path,
                        "building dir children failed; rendering empty"
                    );
                    String::new()
                })
        } else {
            String::new()
        };
        let exec_attr = if !is_directory && crate::file_kind::is_executable(&nav_path) {
            r#" data-exec="1""#
        } else {
            ""
        };
        let wikilink_root_attr = if wikilink_root {
            r#" data-wikilink-root="1""#
        } else {
            ""
        };
        let text_attr = if !is_directory {
            match crate::file_kind::classify(&nav_path) {
                crate::file_kind::FileKind::Markdown | crate::file_kind::FileKind::Text => {
                    r#" data-text="1""#
                }
                _ => "",
            }
        } else {
            ""
        };
        let branch_html = if let Some(bi) = branch {
            if bi.label.is_empty() {
                String::new()
            } else {
                let cls = if bi.label == "main" || bi.label == "master" {
                    "git-branch git-branch--main"
                } else if bi.detached {
                    "git-branch git-branch--detached"
                } else {
                    "git-branch"
                };
                format!(r#"<span class="{}">{}</span>"#, cls, escape_html(&bi.label))
            }
        } else {
            String::new()
        };
        // title-Attribut: vollstaendiger Pfad als Browser-Tooltip beim
        // Hover. Bei Branch wird zweite Zeile "Branch: <name>" angehaengt
        // (vor Escapen mit \n; escape_attr belaesst \n, Browser rendert
        // Zeilenumbruch im Tooltip). data-path bleibt reiner Pfad.
        // Bei ignored: zusaetzliche Zeile "gitignored".
        let mut title = if let Some(bi) = branch {
            format!("{}\nBranch: {}", nav_path, bi.label)
        } else {
            nav_path.clone()
        };
        if ignored {
            title.push_str("\ngitignored");
        }
        format!(
            r#"<li class="{classes}" data-kind="{kind}"{exec_attr}{text_attr}{wikilink_root_attr} data-path="{datapath}" title="{title}"><div class="row"><span class="{caret_class}">▾</span>{icon_html}<span class="label">{name}</span>{branch_html}</div><ul class="{children_class}">{children}</ul></li>"#,
            datapath = escape_attr(&nav_path),
            title = escape_attr(&title),
            name = escape_html(&label_name),
        )
    }

    fn section_html(
        &self,
        key: &str,
        icon: &str,
        title: &str,
        children: String,
        expanded: bool,
    ) -> String {
        let caret_class = if expanded { "caret open" } else { "caret" };
        let children_class = if expanded {
            "children"
        } else {
            "children collapsed"
        };
        format!(
            r#"<li class="section" data-section="{key}"><div class="row"><span class="{caret_class}">▾</span><span class="icon">{icon}</span><span class="label">{title}</span></div><ul class="{children_class}">{children}</ul></li>"#,
            key = escape_attr(key),
            icon = escape_html(icon),
            title = escape_html(title),
        )
    }

    fn pinned_children_html(&self, workspace: &Workspace) -> String {
        let html = workspace
            .pinned()
            .iter()
            .filter(|item| {
                // FX1: Lazy-Typ-Filter gilt auch für Pin-Wurzeln (wie
                // build_dir_children_html). Recent bleibt unberührt.
                if !self.markdown_only {
                    return true;
                }
                let path = Path::new(&item.path);
                if item.is_directory {
                    path.is_dir() && crate::vault_filter::dir_contains_markdown(path)
                } else {
                    crate::file_kind::classify(&item.path) == crate::file_kind::FileKind::Markdown
                }
            })
            .map(|item| {
                let path = Path::new(&item.path);
                // Re-klassifizieren: ein gepinntes .lnk soll als Link
                // erscheinen, eine gepinnte Junction soll das Badge
                // bekommen. Wenn der Pfad nicht mehr existiert, fallen
                // wir auf das ursprünglich gespeicherte `is_directory`
                // zurück (damit verwaiste Pins korrekt sortiert bleiben).
                let info = if path.exists() {
                    classify_entry(path)
                } else {
                    EntryInfo::plain(item.is_directory)
                };
                let branch = if info.is_directory && path.exists() {
                    crate::git_branch::branch_of(path)
                } else {
                    None
                };
                // Matcher fuer Elternverzeichnis des Pins (damit .gitignores
                // bis zum Parent-Level greifen) und Pin selbst matchen.
                let parent = path.parent().unwrap_or(path);
                let matcher = crate::git_ignore::matcher_for(parent);
                let ignored = matcher
                    .as_ref()
                    .is_some_and(|m| m.is_ignored(path, info.is_directory));
                self.item_html(
                    &item.path,
                    &info,
                    branch.as_ref(),
                    ignored,
                    None,
                    workspace.is_wikilink_root(&item.path),
                )
            })
            .collect::<String>();
        empty_placeholder(html)
    }

    fn recent_children_html(&self, workspace: &Workspace) -> String {
        let html = workspace
            .recent()
            .iter()
            .map(|item| {
                let path = Path::new(&item.path);
                let info = if path.exists() {
                    classify_entry(path)
                } else {
                    EntryInfo::plain(false)
                };
                self.item_html(&item.path, &info, None, false, None, false)
            })
            .collect::<String>();
        empty_placeholder(html)
    }
}

fn empty_placeholder(html: String) -> String {
    if html.is_empty() {
        format!(
            r#"<li class="empty">{}</li>"#,
            crate::i18n::t("vault.section.empty")
        )
    } else {
        html
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(value: &str) -> String {
    escape_html(value).replace('"', "&quot;")
}

#[allow(dead_code)]
fn normalize_path(path: PathBuf) -> String {
    fs::canonicalize(&path)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Workspace;
    use tempfile::TempDir;

    #[test]
    fn initial_tree_contains_pinned_and_recent_sections() {
        let _ = crate::i18n::set_process_translator(crate::i18n::Translator::new(
            crate::i18n::load_embedded_registry(),
            crate::i18n::ResolvedLanguage {
                catalog_tag: "de".into(),
                format_locale: "de-DE".into(),
            },
        ));
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/tmp/a.md".into(), false).unwrap();
        workspace.add_recent("/tmp/b.md".into()).unwrap();
        let html = Vault::new().build_initial_tree_html(&workspace);
        assert!(html.contains(&crate::i18n::t("vault.section.pinned")));
        assert!(html.contains(&crate::i18n::t("vault.section.recent")));
        assert!(html.contains(r#"class="section" data-section="pinned""#));
        assert!(html.contains("a.md"));
    }

    #[test]
    fn expand_builds_children_with_directories_first() {
        let temp = TempDir::new().unwrap();
        fs::create_dir(temp.path().join("dir")).unwrap();
        fs::write(temp.path().join("file.md"), "").unwrap();
        let mut vault = Vault::new();
        let html = vault
            .on_expand(temp.path().to_str().unwrap().to_string())
            .unwrap();
        assert!(vault.is_expanded(temp.path().to_str().unwrap()));
        assert!(html.find("dir").unwrap() < html.find("file.md").unwrap());
    }

    #[test]
    fn active_item_gets_active_class() {
        let mut vault = Vault::new();
        vault.set_active(Some("/tmp/a.md".into()));
        let html = vault.item_html(
            "/tmp/a.md",
            &EntryInfo::plain(false),
            None,
            false,
            None,
            false,
        );
        assert!(html.contains("node active"));
    }

    #[test]
    fn ignored_true_adds_class_and_gitignored_to_title() {
        let html = Vault::new().item_html(
            "/tmp/ign.md",
            &EntryInfo::plain(false),
            None,
            true,
            None,
            false,
        );
        assert!(html.contains("node ignored"));
        // \n stays literal in the attr (no html-escape for LF in escape_attr)
        assert!(html.contains("/tmp/ign.md\ngitignored"));
        // also with branch
        let bi = crate::git_branch::BranchInfo {
            label: "main".into(),
            detached: false,
        };
        let html2 = Vault::new().item_html(
            "/tmp/ign",
            &EntryInfo::plain(true),
            Some(&bi),
            true,
            None,
            false,
        );
        assert!(html2.contains("node ignored"));
        assert!(html2.contains("gitignored"));
        assert!(html2.contains("Branch: main"));
    }

    #[cfg(unix)]
    #[test]
    fn executable_file_gets_data_exec_attribute() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().unwrap();
        let exec_path = temp.path().join("script.sh");
        std::fs::write(&exec_path, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exec_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let plain_path = temp.path().join("notes.txt");
        std::fs::write(&plain_path, b"hi").unwrap();

        let exec_html = Vault::new().item_html(
            &exec_path.to_string_lossy(),
            &EntryInfo::plain(false),
            None,
            false,
            None,
            false,
        );
        assert!(exec_html.contains(r#"data-exec="1""#));

        // Nicht-ausfuehrbare Datei traegt das Attribut nicht.
        let plain_html = Vault::new().item_html(
            &plain_path.to_string_lossy(),
            &EntryInfo::plain(false),
            None,
            false,
            None,
            false,
        );
        assert!(!plain_html.contains("data-exec"));
    }

    #[test]
    fn linked_directory_gets_link_class() {
        let info = EntryInfo {
            is_directory: true,
            is_link: true,
            target: None,
        };
        let html = Vault::new().item_html("/tmp/junction", &info, None, false, None, false);
        assert!(html.contains("class=\"node link\""));
        assert!(html.contains(r#"data-kind="dir""#));
    }

    #[test]
    fn shortcut_uses_target_path_and_strips_lnk_extension() {
        let info = EntryInfo {
            is_directory: true,
            is_link: true,
            target: Some(PathBuf::from("/real/target")),
        };
        let html = Vault::new().item_html("/tmp/Shortcut.lnk", &info, None, false, None, false);
        assert!(html.contains(r#"data-path="/real/target""#));
        assert!(html.contains("<span class=\"label\">Shortcut</span>"));
        assert!(html.contains("class=\"node link\""));
    }

    #[test]
    fn shortcut_to_file_uses_target_extension_for_icon() {
        let info = EntryInfo {
            is_directory: false,
            is_link: true,
            target: Some(PathBuf::from("/real/notes.md")),
        };
        let html = Vault::new().item_html("/tmp/Notes.lnk", &info, None, false, None, false);
        assert!(html.contains(r#"data-ext="md""#));
    }

    #[test]
    fn parse_lnk_target_rejects_garbage() {
        assert!(parse_lnk_target(&[0u8; 8]).is_none());
        assert!(parse_lnk_target(b"not a real lnk file").is_none());
    }

    #[test]
    fn classify_entry_marks_plain_dir_without_link() {
        let temp = TempDir::new().unwrap();
        let info = classify_entry(temp.path());
        assert!(info.is_directory);
        assert!(!info.is_link);
        assert!(info.target.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn classify_entry_detects_unix_symlink_to_dir() {
        let temp = TempDir::new().unwrap();
        let dir = temp.path().join("real");
        fs::create_dir(&dir).unwrap();
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        let info = classify_entry(&link);
        assert!(info.is_directory);
        assert!(info.is_link);
        assert!(info.target.is_none());
    }

    #[test]
    fn collapse_recursively_prunes_nested_expanded_dirs() {
        let temp = TempDir::new().unwrap();
        let outer = temp.path().join("outer");
        let inner = outer.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let sibling = temp.path().join("other");
        fs::create_dir(&sibling).unwrap();

        let mut vault = Vault::new();
        vault
            .on_expand(outer.to_string_lossy().into_owned())
            .unwrap();
        vault
            .on_expand(inner.to_string_lossy().into_owned())
            .unwrap();
        vault
            .on_expand(sibling.to_string_lossy().into_owned())
            .unwrap();

        vault.on_collapse(outer.to_str().unwrap());

        assert!(!vault.is_expanded(outer.to_str().unwrap()));
        assert!(!vault.is_expanded(inner.to_str().unwrap()));
        assert!(vault.is_expanded(sibling.to_str().unwrap()));
    }

    fn write_vf(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn norm_vf(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn expand_roots_opens_only_pin_roots() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        write_vf(root, "l1/l2/file.md", "# f\n");
        let root_s = norm_vf(root);
        let l1 = norm_vf(&root.join("l1"));
        let l2 = norm_vf(&root.join("l1/l2"));
        let pins = vec![root_s.clone()];

        let mut vault = Vault::new();
        let r1 = vault.expand_roots(&pins, VaultListOptions::default());
        assert_eq!(r1, vec![root_s.clone()]);
        assert!(
            vault.is_expanded(&root_s),
            "expand_roots expandiert Pin-Wurzel"
        );
        assert!(
            !vault.is_expanded(&l1),
            "verschachtelter Ordner l1 bleibt zu"
        );
        assert!(!vault.is_expanded(&l2), "l2 bleibt zu");
    }

    #[test]
    fn expand_roots_idempotent() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        write_vf(root, "l1/file.md", "# f\n");
        let root_s = norm_vf(root);
        let pins = vec![root_s.clone()];

        let mut vault = Vault::new();
        let r1 = vault.expand_roots(&pins, VaultListOptions::default());
        assert_eq!(r1.len(), 1);
        assert!(vault.is_expanded(&root_s));

        let before = vault.expanded_paths();
        let r2 = vault.expand_roots(&pins, VaultListOptions::default());
        assert!(
            r2.is_empty(),
            "zweiter Aufruf expandiert nichts neu; paths={:?}",
            r2
        );
        assert_eq!(
            vault.expanded_paths(),
            before,
            "expanded_dirs unverändert nach zweitem Aufruf"
        );
    }

    #[test]
    fn expand_roots_skips_md_less_when_markdown_only() {
        let temp = TempDir::new().unwrap();
        let with_md = temp.path().join("with_md");
        let only_txt = temp.path().join("only_txt");
        write_vf(temp.path(), "with_md/a.md", "# a\n");
        write_vf(temp.path(), "only_txt/x.txt", "t\n");
        let with_md_s = norm_vf(&with_md);
        let only_txt_s = norm_vf(&only_txt);
        let pins = vec![with_md_s.clone(), only_txt_s.clone()];

        let mut vault = Vault::new();
        let r = vault.expand_roots(&pins, VaultListOptions::markdown_only(true));
        assert!(vault.is_expanded(&with_md_s), "MD-Wurzel wird expandiert");
        assert!(
            !vault.is_expanded(&only_txt_s),
            "MD-lose Wurzel bleibt zu; paths={:?}",
            r
        );
        assert_eq!(r, vec![with_md_s]);
    }

    #[test]
    fn expand_paths_opens_nested_dirs_and_skips_already_open() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        write_vf(root, "a/b/c.md", "#\n");
        write_vf(root, "plain.txt", "x\n");
        let root_s = norm_vf(root);
        let a = norm_vf(&root.join("a"));
        let b = norm_vf(&root.join("a/b"));
        let mut vault = Vault::new();
        let first = vault.expand_paths(
            &[root_s.clone(), a.clone(), b.clone()],
            VaultListOptions::default(),
            1000,
            &[],
        );
        assert!(!first.capped);
        assert_eq!(first.paths, vec![root_s.clone(), a.clone(), b.clone()]);
        assert!(vault.is_expanded(&root_s));
        assert!(vault.is_expanded(&a));
        assert!(vault.is_expanded(&b));

        let again = vault.expand_paths(
            &[root_s.clone(), a.clone()],
            VaultListOptions::default(),
            1000,
            &[],
        );
        assert!(again.paths.is_empty());
        assert!(!again.capped);
    }

    #[test]
    fn expand_paths_respects_soft_cap() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        write_vf(root, "a/x.md", "#\n");
        write_vf(root, "b/x.md", "#\n");
        write_vf(root, "c/x.md", "#\n");
        let a = norm_vf(&root.join("a"));
        let b = norm_vf(&root.join("b"));
        let c = norm_vf(&root.join("c"));
        let mut vault = Vault::new();
        let result = vault.expand_paths(
            &[a.clone(), b.clone(), c.clone()],
            VaultListOptions::default(),
            2,
            &[],
        );
        assert!(result.capped);
        assert_eq!(result.paths.len(), 2);
        let opened = result.paths.len();
        let still_closed = [&a, &b, &c]
            .iter()
            .filter(|p| !vault.is_expanded(p))
            .count();
        assert_eq!(opened + still_closed, 3);
    }

    #[test]
    fn collapse_all_clears_expanded_dirs() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        write_vf(root, "a/b/c.md", "#\n");
        let root_s = norm_vf(root);
        let a = norm_vf(&root.join("a"));
        let pins = vec![root_s.clone()];

        let mut vault = Vault::new();
        vault.expand_roots(&pins, VaultListOptions::default());
        vault
            .on_expand_with(a.clone(), VaultListOptions::default())
            .unwrap();
        assert!(vault.is_expanded(&root_s));
        assert!(vault.is_expanded(&a));

        vault.collapse_all();
        assert!(
            vault.expanded_paths().is_empty(),
            "collapse_all leert expanded_dirs"
        );
        assert!(!vault.is_expanded(&root_s));
        assert!(!vault.is_expanded(&a));
    }

    #[test]
    fn directories_render_caret_and_child_container() {
        let html = Vault::new().item_html(
            "/tmp/dir",
            &EntryInfo::plain(true),
            None,
            false,
            None,
            false,
        );
        assert!(html.contains(r#"data-kind="dir""#));
        assert!(html.contains(r#"class="caret""#));
        assert!(html.contains(r#"class="children collapsed""#));
    }

    #[test]
    fn pinned_roots_carry_wikilink_root_attribute_only_when_opted_in() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        let on = temp.path().join("mit");
        let off = temp.path().join("ohne");
        fs::create_dir(&on).unwrap();
        fs::create_dir(&off).unwrap();
        let on_norm = on.to_string_lossy().replace('\\', "/");
        let off_norm = off.to_string_lossy().replace('\\', "/");
        workspace.pin(on_norm.clone(), true).unwrap();
        workspace.pin(off_norm.clone(), true).unwrap();

        let html = Vault::new().pinned_children_html(&workspace);
        assert!(!html.contains("data-wikilink-root"), "{html}");

        workspace.set_wikilink_root(&on_norm, true).unwrap();
        let html = Vault::new().pinned_children_html(&workspace);
        assert_eq!(
            1,
            html.matches(r#"data-wikilink-root="1""#).count(),
            "{html}"
        );
        // Das Attribut sitzt am freigeschalteten Knoten, nicht am anderen.
        assert!(
            html.contains(&format!(r#"data-wikilink-root="1" data-path="{on_norm}""#)),
            "{html}"
        );
        assert!(
            !html.contains(&format!(r#"data-wikilink-root="1" data-path="{off_norm}""#)),
            "{html}"
        );
    }

    #[test]
    fn pinned_git_dir_renders_branch_badge_only_for_git_root() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));

        // Non-git pinned dir -> no badge
        let non_git = temp.path().join("plaindir");
        fs::create_dir(&non_git).unwrap();
        workspace
            .pin(non_git.to_string_lossy().into_owned(), true)
            .unwrap();

        // Git root pinned dir -> badge
        let git_dir = temp.path().join("myrepo");
        fs::create_dir(&git_dir).unwrap();
        let git = git_dir.join(".git");
        fs::create_dir(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        workspace
            .pin(git_dir.to_string_lossy().into_owned(), true)
            .unwrap();

        let html = Vault::new().pinned_children_html(&workspace);
        // non-git has no git-branch span
        assert!(
            !html.contains(r#"class="git-branch""#)
                || html.matches(r#"class="git-branch""#).count() == 1
        );
        // the git one has main with --main modifier class
        assert!(html.contains(r#"<span class="git-branch git-branch--main">main</span>"#));
        // ensure recent has none (scope)
        // (no recent set, but placeholder ok)
    }

    #[test]
    fn pinned_non_git_dir_has_no_branch_span() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        let d = temp.path().join("docs");
        fs::create_dir(&d).unwrap();
        workspace
            .pin(d.to_string_lossy().into_owned(), true)
            .unwrap();
        let html = Vault::new().pinned_children_html(&workspace);
        assert!(!html.contains("git-branch"));
    }

    #[test]
    fn pinned_git_branch_classes_and_tooltip() {
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));

        // feature branch -> base class
        let feat = temp.path().join("featrepo");
        fs::create_dir(&feat).unwrap();
        let g = feat.join(".git");
        fs::create_dir(&g).unwrap();
        fs::write(g.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        workspace
            .pin(feat.to_string_lossy().into_owned(), true)
            .unwrap();

        // detached -> --detached
        let det = temp.path().join("detrepo");
        fs::create_dir(&det).unwrap();
        let gd = det.join(".git");
        fs::create_dir(&gd).unwrap();
        fs::write(
            gd.join("HEAD"),
            "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6\n",
        )
        .unwrap();
        workspace
            .pin(det.to_string_lossy().into_owned(), true)
            .unwrap();

        let html = Vault::new().pinned_children_html(&workspace);

        // feature: base class, no --main/--detached
        assert!(html.contains(r#"<span class="git-branch">feature/x</span>"#));
        assert!(!html.contains("git-branch--main"));
        // detached: modifier
        assert!(html.contains(r#"<span class="git-branch git-branch--detached">0f1e2d3</span>"#));

        // tooltip for feature contains literal \nBranch:
        let feat_path = feat.to_string_lossy().replace('\\', "/");
        let expected_title_part = format!("{}\nBranch: feature/x", feat_path);
        // after escape_attr the \n stays in the attr value inside the html string
        assert!(
            html.contains("\nBranch: feature/x"),
            "tooltip missing branch line: {}",
            html
        );
        // data-path is pure path, no \n
        assert!(html.contains(&format!(r#"data-path="{}""#, feat_path)));
        assert!(!html.contains(&format!(r#"data-path="{}"#, expected_title_part)));
    }

    /// FX1: Lazy-Typ-Filter gilt auch für Pin-Wurzeln.
    #[test]
    fn markdown_only_filters_pin_roots_not_recents() {
        let _ = crate::i18n::set_process_translator(crate::i18n::Translator::new(
            crate::i18n::load_embedded_registry(),
            crate::i18n::ResolvedLanguage {
                catalog_tag: "de".into(),
                format_locale: "de-DE".into(),
            },
        ));
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));

        let md_file = temp.path().join("keep.md");
        fs::write(&md_file, "# k\n").unwrap();
        let txt_file = temp.path().join("drop.txt");
        fs::write(&txt_file, "t\n").unwrap();
        let mdless = temp.path().join("mdless");
        fs::create_dir(&mdless).unwrap();
        fs::write(mdless.join("only.txt"), "x\n").unwrap();
        let with_md = temp.path().join("with_md");
        fs::create_dir(&with_md).unwrap();
        fs::write(with_md.join("nested.md"), "# n\n").unwrap();

        workspace
            .pin(md_file.to_string_lossy().into_owned(), false)
            .unwrap();
        workspace
            .pin(txt_file.to_string_lossy().into_owned(), false)
            .unwrap();
        workspace
            .pin(mdless.to_string_lossy().into_owned(), true)
            .unwrap();
        workspace
            .pin(with_md.to_string_lossy().into_owned(), true)
            .unwrap();
        workspace
            .add_recent(txt_file.to_string_lossy().into_owned())
            .unwrap();

        let mut vault = Vault::new();
        vault.set_markdown_only(true);
        let html = vault.build_initial_tree_html(&workspace);

        let norm = |p: &std::path::Path| p.to_string_lossy().replace('\\', "/");
        assert!(
            html.contains(&format!(r#"data-path="{}""#, norm(&md_file))),
            "MD-Datei-Pin muss bleiben"
        );
        assert!(
            !html.contains(&format!(r#"data-path="{}""#, norm(&txt_file))) || {
                // Recent darf die .txt noch zeigen — Pin nicht.
                let pinned = html
                    .split(r#"data-section="recent""#)
                    .next()
                    .unwrap_or(&html);
                !pinned.contains(&format!(r#"data-path="{}""#, norm(&txt_file)))
            },
            "txt-Pin muss im Lazy-Modus weg; html={html}"
        );
        assert!(
            {
                let pinned = html
                    .split(r#"data-section="recent""#)
                    .next()
                    .unwrap_or(&html);
                !pinned.contains(&format!(r#"data-path="{}""#, norm(&mdless)))
            },
            "MD-loser Ordner-Pin muss weg"
        );
        assert!(
            html.contains(&format!(r#"data-path="{}""#, norm(&with_md))),
            "Ordner mit MD muss bleiben"
        );
        // Recent unberührt: txt erscheint in Recent-Section.
        assert!(
            html.contains(r#"data-section="recent""#)
                && html.contains(&format!(r#"data-path="{}""#, norm(&txt_file))),
            "Recent-Liste bleibt unberührt (txt sichtbar)"
        );

        // Ohne Toggle: alles sichtbar.
        vault.set_markdown_only(false);
        let all = vault.build_initial_tree_html(&workspace);
        assert!(all.contains(&format!(r#"data-path="{}""#, norm(&txt_file))));
        assert!(all.contains(&format!(r#"data-path="{}""#, norm(&mdless))));
    }

    fn data_path_attr(path: &Path) -> String {
        format!(
            r#"data-path="{}""#,
            path.to_string_lossy().replace('\\', "/")
        )
    }

    #[test]
    fn hidden_children_visible_by_default_but_git_always_gone() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        fs::write(root.join("note.md"), "# n\n").unwrap();
        fs::write(root.join(".versteckte-datei.md"), "# h\n").unwrap();
        fs::create_dir(root.join(".versteckt")).unwrap();
        fs::write(root.join(".versteckt").join("in.md"), "# i\n").unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::create_dir(root.join("docs")).unwrap();

        let vault = Vault::new();
        assert!(vault.show_hidden());
        let html = vault
            .build_dir_children_html(&root.to_string_lossy(), VaultListOptions::default())
            .unwrap();

        assert!(html.contains(&data_path_attr(&root.join("note.md"))));
        assert!(html.contains(&data_path_attr(&root.join("docs"))));
        assert!(html.contains(&data_path_attr(&root.join(".versteckte-datei.md"))));
        assert!(html.contains(&data_path_attr(&root.join(".versteckt"))));
        assert!(
            !html.contains(&data_path_attr(&root.join(".git"))),
            ".git muss auch bei show_hidden=true weg sein; html={html}"
        );
    }

    #[test]
    fn hidden_children_filtered_when_show_hidden_false() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        fs::write(root.join("note.md"), "# n\n").unwrap();
        fs::write(root.join(".versteckte-datei.md"), "# h\n").unwrap();
        fs::create_dir(root.join(".versteckt")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join("docs")).unwrap();

        let html = Vault::new()
            .build_dir_children_html(
                &root.to_string_lossy(),
                VaultListOptions {
                    markdown_only: false,
                    show_hidden: false,
                },
            )
            .unwrap();

        assert!(html.contains(&data_path_attr(&root.join("note.md"))));
        assert!(html.contains(&data_path_attr(&root.join("docs"))));
        assert!(!html.contains(&data_path_attr(&root.join(".versteckte-datei.md"))));
        assert!(!html.contains(&data_path_attr(&root.join(".versteckt"))));
        assert!(!html.contains(&data_path_attr(&root.join(".git"))));
    }

    #[test]
    fn hidden_and_markdown_only_filters_compose() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        fs::write(root.join("keep.md"), "# k\n").unwrap();
        fs::write(root.join("drop.txt"), "t\n").unwrap();
        fs::write(root.join(".hidden.md"), "# h\n").unwrap();
        fs::write(root.join(".hidden.txt"), "x\n").unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join("mdless")).unwrap();
        fs::write(root.join("mdless").join("only.txt"), "t\n").unwrap();
        fs::create_dir(root.join(".hidden-dir")).unwrap();
        fs::write(root.join(".hidden-dir").join("inside.md"), "# i\n").unwrap();

        let both = Vault::new()
            .build_dir_children_html(
                &root.to_string_lossy(),
                VaultListOptions {
                    markdown_only: true,
                    show_hidden: false,
                },
            )
            .unwrap();
        assert!(both.contains(&data_path_attr(&root.join("keep.md"))));
        assert!(!both.contains(&data_path_attr(&root.join("drop.txt"))));
        assert!(!both.contains(&data_path_attr(&root.join(".hidden.md"))));
        assert!(!both.contains(&data_path_attr(&root.join(".hidden.txt"))));
        assert!(!both.contains(&data_path_attr(&root.join(".git"))));
        assert!(!both.contains(&data_path_attr(&root.join("mdless"))));
        assert!(
            !both.contains(&data_path_attr(&root.join(".hidden-dir"))),
            "Hidden-Ordner mit MD muss bei show_hidden=false weg sein; html={both}"
        );

        let md_only_hidden_on = Vault::new()
            .build_dir_children_html(
                &root.to_string_lossy(),
                VaultListOptions::markdown_only(true),
            )
            .unwrap();
        assert!(md_only_hidden_on.contains(&data_path_attr(&root.join("keep.md"))));
        assert!(md_only_hidden_on.contains(&data_path_attr(&root.join(".hidden.md"))));
        assert!(
            md_only_hidden_on.contains(&data_path_attr(&root.join(".hidden-dir"))),
            "Hidden-Ordner mit MD muss bei show_hidden=true bleiben; html={md_only_hidden_on}"
        );
        assert!(!md_only_hidden_on.contains(&data_path_attr(&root.join("drop.txt"))));
        assert!(!md_only_hidden_on.contains(&data_path_attr(&root.join(".hidden.txt"))));
        assert!(!md_only_hidden_on.contains(&data_path_attr(&root.join(".git"))));
    }

    #[test]
    fn pin_roots_stay_visible_when_hidden() {
        let _ = crate::i18n::set_process_translator(crate::i18n::Translator::new(
            crate::i18n::load_embedded_registry(),
            crate::i18n::ResolvedLanguage {
                catalog_tag: "de".into(),
                format_locale: "de-DE".into(),
            },
        ));
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        let hidden_pin = temp.path().join(".notes");
        fs::create_dir(&hidden_pin).unwrap();
        fs::write(hidden_pin.join("a.md"), "# a\n").unwrap();
        workspace
            .pin(hidden_pin.to_string_lossy().into_owned(), true)
            .unwrap();

        let mut vault = Vault::new();
        vault.set_show_hidden(false);
        let html = vault.build_initial_tree_html(&workspace);
        assert!(
            html.contains(&data_path_attr(&hidden_pin)),
            "expliziter Hidden-Pin bleibt sichtbar; html={html}"
        );
    }

    #[test]
    fn prune_invisible_expanded_drops_hidden_children_keeps_pins() {
        let mut vault = Vault::new();
        vault.set_show_hidden(false);
        vault.expanded_dirs.insert("/tmp/.notes".into());
        vault.expanded_dirs.insert("/tmp/.notes/child".into());
        vault.expanded_dirs.insert("/tmp/.notes/.secret".into());
        vault.expanded_dirs.insert("/tmp/.notes/.git".into());
        vault.expanded_dirs.insert("/tmp/visible/.git".into());

        let pruned = vault.prune_invisible_expanded(&["/tmp/.notes".into()]);
        assert!(vault.is_expanded("/tmp/.notes"));
        assert!(vault.is_expanded("/tmp/.notes/child"));
        assert!(!vault.is_expanded("/tmp/.notes/.secret"));
        assert!(!vault.is_expanded("/tmp/.notes/.git"));
        assert!(!vault.is_expanded("/tmp/visible/.git"));
        assert!(pruned.contains(&"/tmp/.notes/.secret".to_string()));
        assert!(pruned.contains(&"/tmp/.notes/.git".to_string()));
        assert!(pruned.contains(&"/tmp/visible/.git".to_string()));
    }

    #[test]
    fn prune_always_drops_git_even_when_show_hidden() {
        let mut vault = Vault::new();
        assert!(vault.show_hidden());
        vault.expanded_dirs.insert("/tmp/repo".into());
        vault.expanded_dirs.insert("/tmp/repo/.git".into());
        vault.expanded_dirs.insert("/tmp/repo/.github".into());

        let pruned = vault.prune_invisible_expanded(&["/tmp/repo".into()]);
        assert!(vault.is_expanded("/tmp/repo"));
        assert!(vault.is_expanded("/tmp/repo/.github"));
        assert!(!vault.is_expanded("/tmp/repo/.git"));
        assert_eq!(pruned, vec!["/tmp/repo/.git".to_string()]);
    }

    #[test]
    fn remap_prefix_rewrites_expanded_dirs_and_active_path() {
        let mut vault = Vault::new();
        vault.expanded_dirs.insert("/a/notizen".into());
        vault.expanded_dirs.insert("/a/notizen/sub".into());
        vault.expanded_dirs.insert("/a/notizen-alt".into());
        vault.set_active(Some("/a/notizen/x.md".into()));

        let (unwatch, watch) = vault.remap_prefix("/a/notizen", "/a/notes");

        assert!(vault.is_expanded("/a/notes"));
        assert!(vault.is_expanded("/a/notes/sub"));
        assert!(vault.is_expanded("/a/notizen-alt"));
        assert!(!vault.is_expanded("/a/notizen"));
        assert_eq!(vault.active_path.as_deref(), Some("/a/notes/x.md"));
        assert!(unwatch.contains(&"/a/notizen".to_string()));
        assert!(unwatch.contains(&"/a/notizen/sub".to_string()));
        assert!(!unwatch.iter().any(|p| p == "/a/notizen-alt"));
        assert!(watch.contains(&"/a/notes".to_string()));
        assert!(watch.contains(&"/a/notes/sub".to_string()));
    }

    #[test]
    fn remove_under_prunes_expanded_dirs_and_active_path() {
        let mut vault = Vault::new();
        vault.expanded_dirs.insert("/a/notizen".into());
        vault.expanded_dirs.insert("/a/notizen/sub".into());
        vault.expanded_dirs.insert("/a/notizen-alt".into());
        vault.set_active(Some("/a/notizen/x.md".into()));

        let removed = vault.remove_under("/a/notizen");

        assert!(!vault.is_expanded("/a/notizen"));
        assert!(!vault.is_expanded("/a/notizen/sub"));
        assert!(vault.is_expanded("/a/notizen-alt"));
        assert_eq!(vault.active_path, None);
        assert!(removed.contains(&"/a/notizen".to_string()));
        assert!(removed.contains(&"/a/notizen/sub".to_string()));
        assert!(!removed.iter().any(|p| p == "/a/notizen-alt"));
    }
}
