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

#[derive(Debug, Default, Clone)]
pub struct Vault {
    expanded_dirs: BTreeSet<String>,
    active_path: Option<String>,
}

impl Vault {
    pub fn new() -> Self {
        Self::default()
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
            "Angepinnt",
            self.pinned_children_html(workspace),
            pinned_expanded,
        ));
        html.push_str(&self.section_html(
            "recent",
            "🕘",
            "Zuletzt geöffnet",
            self.recent_children_html(workspace),
            recent_expanded,
        ));
        html
    }

    pub fn build_dir_children_html(&self, path: &str) -> io::Result<String> {
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
        Ok(entries
            .iter()
            .map(|(path, info)| self.item_html(&path.to_string_lossy(), info))
            .collect())
    }

    pub fn compute_refresh_delta(&self, workspace: &Workspace) -> VaultRefreshDelta {
        VaultRefreshDelta {
            pinned: Some(self.pinned_children_html(workspace)),
            recent: Some(self.recent_children_html(workspace)),
        }
    }

    pub fn on_expand(&mut self, path: String) -> io::Result<String> {
        let path = path.replace('\\', "/");
        self.expanded_dirs.insert(path.clone());
        self.build_dir_children_html(&path)
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

    pub fn set_active(&mut self, path: Option<String>) {
        // Auf Forward-Slashes normalisieren, damit der Vergleich gegen
        // das normalisierte data-path-Attribut im `item_html`-Render
        // greift — sonst markiert die aktive Datei auf Windows nichts.
        self.active_path = path.map(|p| p.replace('\\', "/"));
    }

    pub fn is_expanded(&self, path: &str) -> bool {
        let normalized = path.replace('\\', "/");
        self.expanded_dirs.contains(&normalized)
    }

    pub fn expanded_paths(&self) -> Vec<String> {
        self.expanded_dirs.iter().cloned().collect()
    }

    fn item_html(&self, original_path: &str, info: &EntryInfo) -> String {
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
        let expanded = is_directory && self.is_expanded(&nav_path);
        let active = self.active_path.as_deref() == Some(nav_path.as_str());
        let mut classes = String::from("node");
        if active {
            classes.push_str(" active");
        }
        if info.is_link {
            classes.push_str(" link");
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
        let children = if expanded {
            self.build_dir_children_html(&nav_path).unwrap_or_default()
        } else {
            String::new()
        };
        format!(
            r#"<li class="{classes}" data-kind="{kind}" data-path="{path}"><div class="row"><span class="{caret_class}">▾</span>{icon_html}<span class="label">{name}</span></div><ul class="{children_class}">{children}</ul></li>"#,
            path = escape_attr(&nav_path),
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
                self.item_html(&item.path, &info)
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
                self.item_html(&item.path, &info)
            })
            .collect::<String>();
        empty_placeholder(html)
    }
}

fn empty_placeholder(html: String) -> String {
    if html.is_empty() {
        r#"<li class="empty">Keine Einträge</li>"#.to_string()
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
        let temp = TempDir::new().unwrap();
        let mut workspace = Workspace::load_from(temp.path().join("workspace.json"));
        workspace.pin("/tmp/a.md".into(), false).unwrap();
        workspace.add_recent("/tmp/b.md".into()).unwrap();
        let html = Vault::new().build_initial_tree_html(&workspace);
        assert!(html.contains("Angepinnt"));
        assert!(html.contains("Zuletzt geöffnet"));
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
        let html = vault.item_html("/tmp/a.md", &EntryInfo::plain(false));
        assert!(html.contains("node active"));
    }

    #[test]
    fn linked_directory_gets_link_class() {
        let info = EntryInfo {
            is_directory: true,
            is_link: true,
            target: None,
        };
        let html = Vault::new().item_html("/tmp/junction", &info);
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
        let html = Vault::new().item_html("/tmp/Shortcut.lnk", &info);
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
        let html = Vault::new().item_html("/tmp/Notes.lnk", &info);
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

    #[test]
    fn directories_render_caret_and_child_container() {
        let html = Vault::new().item_html("/tmp/dir", &EntryInfo::plain(true));
        assert!(html.contains(r#"data-kind="dir""#));
        assert!(html.contains(r#"class="caret""#));
        assert!(html.contains(r#"class="children collapsed""#));
    }
}
