//! Vault-Tags (Obsidian-kompatibel): Scan + Aggregation für den Tag-Browser.
//!
//! Spec: `docs/spec-wikilinks.md` (Etappe W5). Walk-/Filter-Bausteine wie
//! [`crate::wikilink::find_backlinks`]; Code-Ausschluss zeilenbasiert
//! (Fence-Toggle + Inline-Code-Maske).

use crate::file_kind::{classify, FileKind};
use crate::frontmatter;
use crate::search::{resolve_scope, SearchScope, MAX_FILE_SIZE};
use crate::workspace::PinnedItem;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Max. Tags in der Antwort.
pub const TAGS_MAX: usize = 500;
/// Max. Dateien pro Tag.
pub const TAGS_MAX_FILES_PER_TAG: usize = 100;
const NUL_SNIFF: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTagFile {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTagEntry {
    /// Anzeige-Schreibweise (erste gesehene).
    pub tag: String,
    /// Anzahl Dateien mit diesem Tag.
    pub count: usize,
    pub files: Vec<VaultTagFile>,
    /// `true`, wenn mehr als [`TAGS_MAX_FILES_PER_TAG`] Dateien vorlagen.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTagsResult {
    pub tags: Vec<VaultTagEntry>,
    /// `true`, wenn die globale Tag-Cap griff oder irgendeine Dateiliste
    /// abgeschnitten wurde.
    pub truncated: bool,
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string()
}

/// Scannt den Vault und aggregiert Tags aus Fließtext + Frontmatter.
pub fn collect_vault_tags(pinned: &[PinnedItem]) -> VaultTagsResult {
    let roots = resolve_scope(pinned, &SearchScope::Vault);
    let mut seen_files: HashSet<String> = HashSet::new();
    // key = lowercase tag → (display, paths set as path → name)
    let mut agg: HashMap<String, TagAgg> = HashMap::new();

    let mut consider = |path: PathBuf| {
        let normalized = normalize_path(&path);
        if classify(&normalized) != FileKind::Markdown {
            return;
        }
        if !seen_files.insert(normalized.clone()) {
            return;
        }
        let Some(content) = read_md(&path) else {
            return;
        };
        let name = file_name_of(&path);
        let tags = extract_tags_from_markdown(&content);
        for tag in tags {
            let key = tag.to_lowercase();
            let entry = agg.entry(key).or_insert_with(|| TagAgg {
                display: tag.clone(),
                files: HashMap::new(),
            });
            entry
                .files
                .entry(normalized.clone())
                .or_insert_with(|| name.clone());
        }
    };

    for dir in &roots.dirs {
        let walker = WalkBuilder::new(dir)
            .sort_by_file_name(|a, b| a.cmp(b))
            .build();
        for result in walker {
            let Ok(entry) = result else { continue };
            if !entry.file_type().is_some_and(|k| k.is_file()) {
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

    let mut any_file_trunc = false;
    let mut tags: Vec<VaultTagEntry> = agg
        .into_values()
        .map(|mut a| {
            let mut files: Vec<VaultTagFile> = a
                .files
                .drain()
                .map(|(path, name)| VaultTagFile { path, name })
                .collect();
            files.sort_by(|x, y| {
                x.path
                    .to_lowercase()
                    .cmp(&y.path.to_lowercase())
                    .then_with(|| x.path.cmp(&y.path))
            });
            let total = files.len();
            let truncated = total > TAGS_MAX_FILES_PER_TAG;
            if truncated {
                any_file_trunc = true;
                files.truncate(TAGS_MAX_FILES_PER_TAG);
            }
            VaultTagEntry {
                tag: a.display,
                count: total,
                files,
                truncated,
            }
        })
        .collect();

    tags.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.tag.to_lowercase().cmp(&b.tag.to_lowercase()))
            .then_with(|| a.tag.cmp(&b.tag))
    });

    let tag_trunc = tags.len() > TAGS_MAX;
    if tag_trunc {
        tags.truncate(TAGS_MAX);
    }

    VaultTagsResult {
        tags,
        truncated: any_file_trunc || tag_trunc,
    }
}

struct TagAgg {
    display: String,
    files: HashMap<String, String>,
}

fn read_md(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return None;
    }
    let sniff_end = bytes.len().min(NUL_SNIFF);
    if bytes[..sniff_end].contains(&0u8) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Extrahiert alle Tags aus einem Markdown-Dokument (FM + Body).
/// Exportiert für Unit-Tests.
pub fn extract_tags_from_markdown(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let fm = frontmatter::extract(content);
    extract_frontmatter_tags(&fm.entries, &mut tags);
    extract_text_tags(&fm.body, &mut tags);
    tags
}

fn extract_frontmatter_tags(entries: &[frontmatter::Entry], out: &mut Vec<String>) {
    for e in entries {
        if !e.key.eq_ignore_ascii_case("tags") && !e.key.eq_ignore_ascii_case("tag") {
            continue;
        }
        // frontmatter::yaml_to_value join't Arrays mit `\n`; Komma-Strings
        // bleiben ein Wert. Split auf Newline + Komma + Whitespace.
        for part in e.value.split(['\n', ',', ';']) {
            let t = part.trim().trim_start_matches('#').trim();
            if t.is_empty() {
                continue;
            }
            // Nur erlaubte Zeichen (Obsidian-ähnlich) — sonst verwerfen.
            if is_valid_tag_body(t) {
                out.push(t.to_string());
            }
        }
    }
}

/// Fließtext-Tags: Fence-Toggle + Inline-Code-Maske, dann `#tag`-Scan.
fn extract_text_tags(body: &str, out: &mut Vec<String>) {
    let mut in_fence = false;
    for line in body.lines() {
        if is_fence_toggle_line(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let masked = mask_inline_code(line);
        scan_line_for_tags(&masked, out);
    }
}

fn is_fence_toggle_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

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

/// Scannt eine (maskierte) Zeile nach `#tag`.
///
/// - Vor `#`: Zeilenanfang oder Whitespace (kein `foo#bar`).
/// - ATX-Überschrift: `#` am (ggf. eingerückten) Zeilenanfang + Space → kein Tag.
/// - Multi-Hash-Heading-Marker (`##` …) am Zeilenanfang → kein Tag.
/// - Tag-Body: Unicode-alphanumerisch + `_` `/` `-`; mind. ein Nicht-Ziffer.
pub fn scan_line_for_tags(line: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '#' {
            i += 1;
            continue;
        }
        let prev_ok = i == 0 || chars[i - 1].is_whitespace();
        if !prev_ok {
            i += 1;
            continue;
        }
        // Einrückung vor dem `#` nur Spaces/Tabs?
        let only_ws_before = chars[..i].iter().all(|c| c.is_whitespace());
        if only_ws_before {
            // ATX-Heading: `# ` / `## ` / …
            let mut j = i;
            while j < chars.len() && chars[j] == '#' {
                j += 1;
            }
            if j > i + 1 {
                // Multi-hash am Zeilenanfang → Heading-Marker, kein Tag.
                i = j;
                continue;
            }
            if j < chars.len() && chars[j].is_whitespace() {
                // `# Heading`
                i = j;
                continue;
            }
        }

        // Tag-Body ab i+1
        if i + 1 >= chars.len() {
            break;
        }
        let start = i + 1;
        let mut j = start;
        while j < chars.len() && is_tag_char(chars[j]) {
            j += 1;
        }
        if j > start {
            let tag: String = chars[start..j].iter().collect();
            if is_valid_tag_body(&tag) {
                out.push(tag);
            }
            i = j;
            continue;
        }
        i += 1;
    }
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '/' || c == '-'
}

/// Obsidian: mind. ein Nicht-Ziffer-Zeichen; erlaubte Zeichen nur.
fn is_valid_tag_body(tag: &str) -> bool {
    if tag.is_empty() {
        return false;
    }
    if !tag.chars().all(is_tag_char) {
        return false;
    }
    // Keine leeren Nested-Segmente (`a//b`, `/a`, `a/`).
    if tag.starts_with('/') || tag.ends_with('/') || tag.contains("//") {
        return false;
    }
    tag.chars().any(|c| !c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::PinnedItem;
    use std::fs;
    use tempfile::TempDir;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn pin_dir(p: &Path) -> PinnedItem {
        PinnedItem {
            path: p.to_string_lossy().to_string(),
            is_directory: true,
        }
    }

    #[test]
    fn text_tags_basic() {
        let mut tags = Vec::new();
        scan_line_for_tags("hello #work and #life", &mut tags);
        assert_eq!(vec!["work".to_string(), "life".to_string()], tags);
    }

    #[test]
    fn heading_is_not_a_tag() {
        let mut tags = Vec::new();
        scan_line_for_tags("# Heading one", &mut tags);
        assert!(tags.is_empty());
        scan_line_for_tags("## Sub", &mut tags);
        assert!(tags.is_empty());
        // `#tag` ohne Space = Tag
        scan_line_for_tags("#tag", &mut tags);
        assert_eq!(vec!["tag".to_string()], tags);
    }

    #[test]
    fn pure_digits_not_a_tag() {
        let mut tags = Vec::new();
        scan_line_for_tags("see #123 and #12a", &mut tags);
        assert_eq!(vec!["12a".to_string()], tags);
    }

    #[test]
    fn nested_tag_counts_as_full() {
        let mut tags = Vec::new();
        scan_line_for_tags("#a/b/c next", &mut tags);
        assert_eq!(vec!["a/b/c".to_string()], tags);
    }

    #[test]
    fn no_mid_word_hash() {
        let mut tags = Vec::new();
        scan_line_for_tags("foo#bar https://x.com/#frag", &mut tags);
        assert!(tags.is_empty(), "{tags:?}");
    }

    #[test]
    fn code_fence_and_inline_excluded() {
        let md = "out #keep\n\
                  `#skip`\n\
                  ```\n\
                  #fence\n\
                  ```\n\
                  after #ok\n";
        let tags = extract_tags_from_markdown(md);
        assert_eq!(vec!["keep".to_string(), "ok".to_string()], tags);
    }

    #[test]
    fn frontmatter_array_and_list() {
        let md = "---\ntags: [alpha, beta]\n---\nbody\n";
        let tags = extract_tags_from_markdown(md);
        assert!(tags.contains(&"alpha".to_string()));
        assert!(tags.contains(&"beta".to_string()));

        let md2 = "---\ntags:\n  - one\n  - two\n---\n";
        let tags2 = extract_tags_from_markdown(md2);
        assert!(tags2.contains(&"one".to_string()));
        assert!(tags2.contains(&"two".to_string()));
    }

    #[test]
    fn frontmatter_comma_string() {
        let md = "---\ntags: red, green, blue\n---\n";
        let tags = extract_tags_from_markdown(md);
        assert_eq!(3, tags.len());
        assert!(tags.iter().any(|t| t == "red"));
        assert!(tags.iter().any(|t| t == "green"));
        assert!(tags.iter().any(|t| t == "blue"));
    }

    #[test]
    fn case_aggregation_preserves_first_spelling() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "a.md", "#Work note\n");
        write(temp.path(), "b.md", "also #work here\n");
        let result = collect_vault_tags(&[pin_dir(temp.path())]);
        let work = result
            .tags
            .iter()
            .find(|t| t.tag.eq_ignore_ascii_case("work"))
            .expect("work");
        assert_eq!("Work", work.tag, "first seen spelling");
        assert_eq!(2, work.count);
        assert_eq!(2, work.files.len());
    }

    #[test]
    fn vault_scan_sorts_by_count_then_alpha() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "a.md", "#common #zebra\n");
        write(temp.path(), "b.md", "#common #apple\n");
        write(temp.path(), "c.md", "#common\n");
        let result = collect_vault_tags(&[pin_dir(temp.path())]);
        assert_eq!("common", result.tags[0].tag);
        assert_eq!(3, result.tags[0].count);
        // apple und zebra count 1 → alpha
        let singles: Vec<_> = result.tags.iter().skip(1).map(|t| t.tag.as_str()).collect();
        assert_eq!(vec!["apple", "zebra"], singles);
    }

    #[test]
    fn unicode_letters_in_tags() {
        let mut tags = Vec::new();
        scan_line_for_tags("#Überblick #日本語", &mut tags);
        assert_eq!(vec!["Überblick".to_string(), "日本語".to_string()], tags);
    }
}
