//! I1c i18n reference gate (docs/spec-i18n.md „Qualitäts-Gates" / Etappe I1c).
//!
//! Scans production sources for `t` / `t_args` / `t_plural` / `tPlural` /
//! `data-i18n*` usages and checks them against the embedded `en` catalog.
//!
//! - Hard: missing keys, non-literal first args (outside i18n core), aliases
//! - Soft (until I6): unreferenced catalog keys — println report; set
//!   `FOLIO_I18N_DEAD_KEYS=hard` to fail (I6 switch)

use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

// ─── Paths ───────────────────────────────────────────────────────────────────

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn en_catalog_path() -> PathBuf {
    manifest_dir().join("locales/en.json")
}

fn allowlist_path() -> PathBuf {
    manifest_dir().join("tests/i18n_ref_allowlist.txt")
}

/// Directories/files under scan (relative to CARGO_MANIFEST_DIR).
fn scan_roots() -> Vec<PathBuf> {
    let m = manifest_dir();
    vec![
        m.join("src"),
        m.join("web/app"),
        m.join("web/editor"),
        m.join("dist/index.html"),
    ]
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

fn load_en_keys() -> BTreeSet<String> {
    let text = fs::read_to_string(en_catalog_path()).expect("read locales/en.json");
    let v: Value = serde_json::from_str(&text).expect("parse en.json");
    let obj = v.as_object().expect("en.json must be an object");
    let mut keys = BTreeSet::new();
    for (k, _) in obj {
        if k == "@meta" {
            continue;
        }
        keys.insert(k.clone());
    }
    keys
}

// ─── Allowlist ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct AllowlistEntry {
    prefix: String,
    /// Source line for diagnostics.
    line_no: usize,
}

fn load_allowlist() -> Vec<AllowlistEntry> {
    let path = allowlist_path();
    if !path.exists() {
        return Vec::new();
    }
    let text = fs::read_to_string(&path).expect("read allowlist");
    let mut out = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line_no = i + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // prefix + optional trailing `# reason`
        let prefix = trimmed.split('#').next().unwrap_or("").trim().to_string();
        if prefix.is_empty() {
            continue;
        }
        // Require a justification somewhere on the line (inline # …).
        if !trimmed.contains('#') {
            panic!(
                "i18n_ref_allowlist.txt:{line_no}: entry `{prefix}` needs a # justification comment"
            );
        }
        out.push(AllowlistEntry { prefix, line_no });
    }
    out
}

// ─── Source walk ─────────────────────────────────────────────────────────────

fn is_test_path(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == "tests" || s == "test" || s.ends_with("_test.ts") || s.ends_with(".test.ts")
    }) || path
        .file_name()
        .map(|n| {
            let n = n.to_string_lossy();
            n.ends_with(".test.ts") || n.ends_with("_test.rs") || n == "tests.rs"
        })
        .unwrap_or(false)
}

/// i18n core: may call t(key) with non-literals (facade/applier).
fn is_i18n_core(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/");
    s.contains("/src/i18n/") || s.ends_with("/src/i18n/mod.rs") || s.contains("/web/app/i18n/")
}

fn collect_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in scan_roots() {
        if root.is_file() {
            files.push(root);
            continue;
        }
        if !root.is_dir() {
            continue;
        }
        walk_dir(&root, &mut files);
    }
    files.sort();
    files
}

fn walk_dir(dir: &Path, out: &mut Vec<PathBuf>) {
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if is_test_path(&p) {
            continue;
        }
        if p.is_dir() {
            // Skip node_modules / dist under web if any
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "node_modules" || name == "dist" || name == "target" {
                continue;
            }
            walk_dir(&p, out);
        } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if matches!(ext, "rs" | "ts" | "html") {
                out.push(p);
            }
        }
    }
}

// ─── Comment stripping (best-effort, UTF-8 safe) ─────────────────────────────

fn strip_comments_rs_ts(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let n = chars.len();
    while i < n {
        // line comment
        if i + 1 < n && chars[i] == '/' && chars[i + 1] == '/' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i < n && chars[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        // block comment
        if i + 1 < n && chars[i] == '/' && chars[i + 1] == '*' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            if i + 1 < n {
                out.push(' ');
                out.push(' ');
                i += 2;
            }
            continue;
        }
        // ordinary / raw strings — preserve content (and newlines)
        if chars[i] == '"' || chars[i] == '\'' {
            let q = chars[i];
            out.push(q);
            i += 1;
            while i < n {
                if chars[i] == '\\' && i + 1 < n {
                    out.push(chars[i]);
                    out.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                out.push(chars[i]);
                if chars[i] == q {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if chars[i] == 'r' && i + 1 < n && (chars[i + 1] == '"' || chars[i + 1] == '#') {
            out.push('r');
            i += 1;
            let mut hashes = 0;
            while i < n && chars[i] == '#' {
                out.push('#');
                hashes += 1;
                i += 1;
            }
            if i < n && chars[i] == '"' {
                out.push('"');
                i += 1;
                loop {
                    if i >= n {
                        break;
                    }
                    if chars[i] == '"' {
                        let mut ok = true;
                        for h in 0..hashes {
                            if i + 1 + h >= n || chars[i + 1 + h] != '#' {
                                ok = false;
                                break;
                            }
                        }
                        if ok {
                            out.push('"');
                            i += 1;
                            for _ in 0..hashes {
                                out.push('#');
                                i += 1;
                            }
                            break;
                        }
                    }
                    out.push(chars[i]);
                    i += 1;
                }
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

// ─── Call extraction ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct RefHit {
    file: String,
    line: usize,
    kind: &'static str,
    key: Option<String>,
    /// true if first arg was not a string literal
    non_literal: bool,
}

fn rel_display(path: &Path) -> String {
    let m = manifest_dir();
    path.strip_prefix(&m)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn line_of_char(src: &str, char_idx: usize) -> usize {
    src.chars().take(char_idx).filter(|&c| c == '\n').count() + 1
}

/// After `name(`, skip ws and return (is_string_literal, key_or_none).
fn parse_first_arg_chars(chars: &[char], open_paren: usize) -> (bool, Option<String>) {
    let mut i = open_paren + 1;
    let n = chars.len();
    while i < n && chars[i].is_whitespace() {
        i += 1;
    }
    if i >= n {
        return (false, None);
    }
    // Rust raw string r#"..."# / r"..."
    if chars[i] == 'r' {
        let mut j = i + 1;
        let mut hashes = 0;
        while j < n && chars[j] == '#' {
            hashes += 1;
            j += 1;
        }
        if j < n && chars[j] == '"' {
            j += 1;
            let start = j;
            loop {
                if j >= n {
                    return (false, None);
                }
                if chars[j] == '"' {
                    let mut ok = true;
                    for h in 0..hashes {
                        if j + 1 + h >= n || chars[j + 1 + h] != '#' {
                            ok = false;
                            break;
                        }
                    }
                    if ok {
                        let key: String = chars[start..j].iter().collect();
                        return (true, Some(key));
                    }
                }
                j += 1;
            }
        }
    }
    if chars[i] == '"' || chars[i] == '\'' {
        let q = chars[i];
        i += 1;
        let start = i;
        while i < n {
            if chars[i] == '\\' && i + 1 < n {
                i += 2;
                continue;
            }
            if chars[i] == q {
                let key: String = chars[start..i].iter().collect();
                let key = key
                    .replace("\\\"", "\"")
                    .replace("\\'", "'")
                    .replace("\\\\", "\\");
                return (true, Some(key));
            }
            i += 1;
        }
        return (false, None);
    }
    (false, None)
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}
fn is_ident_cont(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn find_calls(src: &str, file: &Path, is_ts: bool) -> Vec<RefHit> {
    let clean = strip_comments_rs_ts(src);
    let chars: Vec<char> = clean.chars().collect();
    let mut hits = Vec::new();
    let names_rust = ["t_plural", "t_args", "t"]; // longer first for equality
    let names_ts = ["tPlural", "t"];
    let names: &[&str] = if is_ts { &names_ts } else { &names_rust };

    let n = chars.len();
    let mut i = 0;
    while i < n {
        if !is_ident_start(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < n && is_ident_cont(chars[i]) {
            i += 1;
        }
        let ident: String = chars[start..i].iter().collect();
        let mut matched: Option<&'static str> = None;
        for name in names {
            if ident == *name {
                matched = Some(*name);
                break;
            }
        }
        if matched.is_none() {
            continue;
        }

        let mut j = i;
        while j < n && chars[j].is_whitespace() {
            j += 1;
        }
        if j >= n || chars[j] != '(' {
            continue;
        }

        // Skip function *definitions*: `fn t(` / `function t(`
        let before: String = chars[..start].iter().collect();
        let before_trim = before.trim_end();
        let last = before_trim
            .rsplit(|c: char| c.is_whitespace() || c == '{' || c == ';' || c == '}' || c == '(')
            .next()
            .unwrap_or("");
        if matches!(last, "fn" | "function" | "async") || last.ends_with("fn") {
            continue;
        }
        if is_ts && before_trim.ends_with("function") {
            continue;
        }

        let kind = matched.unwrap();
        let (is_lit, key) = parse_first_arg_chars(&chars, j);
        let line = line_of_char(&clean, start);
        hits.push(RefHit {
            file: rel_display(file),
            line,
            kind,
            key,
            non_literal: !is_lit,
        });
    }
    hits
}

fn find_html_attrs(src: &str, file: &Path) -> Vec<RefHit> {
    let mut hits = Vec::new();
    let attrs = [
        "data-i18n-aria-label",
        "data-i18n-placeholder",
        "data-i18n-title",
        "data-i18n",
    ];
    for (line_idx, line) in src.lines().enumerate() {
        for attr in attrs {
            // attr="key" or attr='key'
            let patterns = [format!("{attr}=\""), format!("{attr}='")];
            for pat in &patterns {
                let mut search_from = 0;
                while let Some(pos) = line[search_from..].find(pat.as_str()) {
                    let abs = search_from + pos + pat.len();
                    let quote = if pat.ends_with('"') { '"' } else { '\'' };
                    if let Some(end) = line[abs..].find(quote) {
                        let key = line[abs..abs + end].to_string();
                        if !key.is_empty() {
                            hits.push(RefHit {
                                file: rel_display(file),
                                line: line_idx + 1,
                                kind: attr,
                                key: Some(key),
                                non_literal: false,
                            });
                        }
                        search_from = abs + end + 1;
                    } else {
                        break;
                    }
                }
            }
        }
    }
    hits
}

fn find_aliases(src: &str, file: &Path, is_ts: bool) -> Vec<String> {
    let mut out = Vec::new();
    for (i, line) in src.lines().enumerate() {
        let t = line.trim();
        if is_ts {
            if !t.starts_with("import ") && !t.contains(" import ") {
                // also multi-import lines that are pure import
                if !t.contains("from ") {
                    continue;
                }
            }
            // import { t as foo } / import { tPlural as x }
            if alias_on_import_line(t, &["t", "tPlural"]) {
                out.push(format!(
                    "{}:{}: forbidden i18n alias in import: {t}",
                    rel_display(file),
                    i + 1
                ));
            }
        } else {
            // use crate::i18n::t as foo / use ...::{t as foo, ...}
            if t.starts_with("use ") && alias_on_import_line(t, &["t", "t_args", "t_plural"]) {
                out.push(format!(
                    "{}:{}: forbidden i18n alias in use: {t}",
                    rel_display(file),
                    i + 1
                ));
            }
        }
    }
    out
}

fn alias_on_import_line(line: &str, names: &[&str]) -> bool {
    for name in names {
        // `t as something` but not `as t` re-export style alone without aliasing away
        // Pattern: word-boundary name + as + identifier
        let pat = format!("{name} as ");
        if let Some(idx) = line.find(&pat) {
            // ensure not part of longer ident (e.g. tPlural matched t)
            let before_ok = idx == 0
                || !line.as_bytes()[idx - 1].is_ascii_alphanumeric()
                    && line.as_bytes()[idx - 1] != b'_';
            if before_ok {
                return true;
            }
        }
    }
    false
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[test]
fn i18n_reference_gate() {
    let catalog = load_en_keys();
    assert!(!catalog.is_empty(), "en catalog must contain keys");
    let allowlist = load_allowlist();
    let files = collect_files();
    assert!(
        !files.is_empty(),
        "scan found no source files under {:?}",
        scan_roots()
    );

    let mut refs: Vec<RefHit> = Vec::new();
    let mut alias_errors: Vec<String> = Vec::new();
    let mut non_literal_errors: Vec<String> = Vec::new();

    for file in &files {
        let Ok(src) = fs::read_to_string(file) else {
            continue;
        };
        let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
        match ext {
            "rs" => {
                alias_errors.extend(find_aliases(&src, file, false));
                for hit in find_calls(&src, file, false) {
                    if hit.non_literal {
                        if !is_i18n_core(file) {
                            non_literal_errors.push(format!(
                                "{}:{}: {}(…) first argument must be a string literal (dynamic keys forbidden)",
                                hit.file, hit.line, hit.kind
                            ));
                        }
                    } else {
                        refs.push(hit);
                    }
                }
            }
            "ts" => {
                alias_errors.extend(find_aliases(&src, file, true));
                for hit in find_calls(&src, file, true) {
                    if hit.non_literal {
                        if !is_i18n_core(file) {
                            non_literal_errors.push(format!(
                                "{}:{}: {}(…) first argument must be a string literal (dynamic keys forbidden)",
                                hit.file, hit.line, hit.kind
                            ));
                        }
                    } else {
                        refs.push(hit);
                    }
                }
            }
            "html" => {
                refs.extend(find_html_attrs(&src, file));
            }
            _ => {}
        }
    }

    // Literal reference keys
    let mut referenced: BTreeSet<String> = BTreeSet::new();
    for hit in &refs {
        if let Some(k) = &hit.key {
            referenced.insert(k.clone());
        }
    }

    // Allowlist prefixes mark matching catalog keys as referenced (dead-key soft)
    let mut allowlist_unused = Vec::new();
    for entry in &allowlist {
        let mut any = false;
        for ck in &catalog {
            if ck.starts_with(&entry.prefix) {
                referenced.insert(ck.clone());
                any = true;
            }
        }
        // "müssen selbst referenziert sein" — at least one code ref should
        // start with the prefix, OR we already expanded catalog matches.
        // If prefix matches no catalog key and no code ref, warn unused.
        let code_hit = refs.iter().any(|h| {
            h.key
                .as_ref()
                .map(|k| k.starts_with(&entry.prefix))
                .unwrap_or(false)
        });
        if !any && !code_hit {
            allowlist_unused.push(format!(
                "allowlist L{}: prefix `{}` matches no catalog key and no code reference",
                entry.line_no, entry.prefix
            ));
        } else if any && !code_hit {
            // Catalog keys covered by prefix but no literal in code — that's
            // the point of the allowlist; still OK. Spec: entry must be
            // "referenziert" — interpret as: justified for keys that exist.
            // Soft-warn only if prefix matches zero catalog keys.
        }
    }

    // Direction 1 (hard): every referenced key exists in en
    let mut missing = Vec::new();
    for hit in &refs {
        let Some(k) = &hit.key else { continue };
        if !catalog.contains(k) {
            missing.push(format!(
                "{}:{}: key `{k}` (via {}) not in en catalog",
                hit.file, hit.line, hit.kind
            ));
        }
    }

    // Direction 2 (soft): dead keys
    let dead: Vec<String> = catalog
        .iter()
        .filter(|k| !referenced.contains(*k))
        .cloned()
        .collect();

    let hard_dead = std::env::var("FOLIO_I18N_DEAD_KEYS")
        .map(|v| v == "hard")
        .unwrap_or(false);

    // Report
    println!("i18n reference gate");
    println!("  files scanned:     {}", files.len());
    println!("  references found:  {}", refs.len());
    println!(
        "  unique ref keys:   {}",
        referenced
            .iter()
            .filter(|k| catalog.contains(*k) || refs.iter().any(|h| h.key.as_ref() == Some(k)))
            .count()
    );
    println!("  en catalog keys:   {}", catalog.len());
    println!("  dead keys (soft):  {}", dead.len());
    if !dead.is_empty() {
        println!("  --- dead key report (soft until I6) ---");
        for k in &dead {
            println!("    DEAD  {k}");
        }
        println!("  --- end dead key report ---");
    }
    for w in &allowlist_unused {
        println!("  WARN allowlist: {w}");
    }

    // Failures
    let mut errors = Vec::new();
    errors.extend(alias_errors);
    errors.extend(non_literal_errors);
    errors.extend(missing);
    if hard_dead {
        for k in &dead {
            errors.push(format!("dead key (FOLIO_I18N_DEAD_KEYS=hard): {k}"));
        }
    }
    // Unused allowlist with no catalog match is a soft warn only (already printed)

    if !errors.is_empty() {
        eprintln!("i18n reference gate FAILED ({} error(s)):", errors.len());
        for e in &errors {
            eprintln!("  ERROR  {e}");
        }
        panic!("i18n reference gate: {} error(s); see stderr", errors.len());
    }
}

#[test]
fn i18n_ref_finds_menu_literals_in_menu_labels() {
    // Sanity: the scanner must see menu.* keys from menu_labels_from_translator.
    let path = manifest_dir().join("src/i18n/mod.rs");
    let src = fs::read_to_string(&path).unwrap();
    let hits = find_calls(&src, &path, false);
    let keys: BTreeSet<_> = hits.into_iter().filter_map(|h| h.key).collect();
    assert!(
        keys.contains("menu.file"),
        "expected menu.file literal in i18n/mod.rs; got {keys:?}"
    );
    assert!(keys.contains("menu.edit.undo"));
}

#[test]
fn i18n_ref_rejects_non_literal_outside_core() {
    let fake = PathBuf::from("/tmp/fake_app_file.rs");
    // Simulate a production file path under src/
    let path = manifest_dir().join("src/commands/app/mod.rs");
    let sample = r#"
        fn demo(key: &str) {
            let _ = t(key);
            let _ = t("menu.file");
        }
    "#;
    let hits = find_calls(sample, &path, false);
    let non_lit: Vec<_> = hits.iter().filter(|h| h.non_literal).collect();
    let lit: Vec<_> = hits.iter().filter(|h| !h.non_literal).collect();
    assert_eq!(non_lit.len(), 1, "{hits:?}");
    assert_eq!(lit.len(), 1);
    assert_eq!(lit[0].key.as_deref(), Some("menu.file"));
    let _ = fake;
}

// ─── Markup gate (I2): leaf rule + key existence for dist/index.html ─────────

/// True if the element body (until matching close) contains an element child.
/// Best-effort HTML scan: ignores comments; sufficient for our static shell.
fn html_element_has_element_children(body: &str) -> bool {
    let mut i = 0;
    let b = body.as_bytes();
    let n = b.len();
    while i < n {
        if b[i] == b'<' {
            // comment
            if i + 3 < n && &body[i..i + 4] == "<!--" {
                if let Some(end) = body[i + 4..].find("-->") {
                    i = i + 4 + end + 3;
                    continue;
                }
                return true; // unclosed comment: be conservative
            }
            // closing tag — not a child open
            if i + 1 < n && b[i + 1] == b'/' {
                i += 1;
                continue;
            }
            // doctype / processing
            if i + 1 < n && (b[i + 1] == b'!' || b[i + 1] == b'?') {
                i += 1;
                continue;
            }
            // opening element tag → has element child
            if i + 1 < n && (b[i + 1] as char).is_ascii_alphabetic() {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Find `data-i18n="…"` (textContent only — not -title/-placeholder/-aria-label)
/// on elements and check the leaf rule.
fn find_data_i18n_non_leaves(src: &str) -> Vec<String> {
    let mut errors = Vec::new();
    // Match opening tags that carry data-i18n="key" (not data-i18n-title etc.)
    // Attribute may appear anywhere in the tag.
    let mut search_from = 0;
    let bytes = src.as_bytes();
    while let Some(rel) = src[search_from..].find("data-i18n=") {
        let abs = search_from + rel;
        // Ensure it's exactly data-i18n= not data-i18n-title etc.
        // char before 'd' should be whitespace or start; after 'n' is '='.
        // Reject if preceded by '-' (as in data-i18n-title)
        if abs > 0 && bytes[abs - 1] == b'-' {
            search_from = abs + 9;
            continue;
        }
        // Also reject if the next chars are not quote after =
        let after_eq = abs + "data-i18n=".len();
        if after_eq >= src.len() {
            break;
        }
        let quote = src.as_bytes()[after_eq];
        if quote != b'"' && quote != b'\'' {
            search_from = after_eq;
            continue;
        }
        let q = quote as char;
        let key_start = after_eq + 1;
        let Some(key_end_rel) = src[key_start..].find(q) else {
            search_from = key_start;
            continue;
        };
        let key = &src[key_start..key_start + key_end_rel];
        // Walk back to '<' of this tag
        let tag_start = match src[..abs].rfind('<') {
            Some(p) => p,
            None => {
                search_from = key_start + key_end_rel + 1;
                continue;
            }
        };
        // Find end of opening tag '>'
        let Some(tag_end_rel) = src[abs..].find('>') else {
            search_from = key_start + key_end_rel + 1;
            continue;
        };
        let tag_end = abs + tag_end_rel;
        let open_tag = &src[tag_start..=tag_end];
        // Self-closing or void: no body to violate leaf rule
        if open_tag.ends_with("/>") {
            search_from = tag_end + 1;
            continue;
        }
        // Tag name
        let name_start = tag_start + 1;
        let name_end = src[name_start..]
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .map(|o| name_start + o)
            .unwrap_or(tag_end);
        let tag_name = &src[name_start..name_end];
        let void = matches!(
            tag_name.to_ascii_lowercase().as_str(),
            "area"
                | "base"
                | "br"
                | "col"
                | "embed"
                | "hr"
                | "img"
                | "input"
                | "link"
                | "meta"
                | "param"
                | "source"
                | "track"
                | "wbr"
        );
        if void {
            search_from = tag_end + 1;
            continue;
        }
        // Find matching close tag (naive: first </tagName>)
        let close = format!("</{tag_name}>");
        let close_l = format!("</{}>", tag_name.to_ascii_lowercase());
        let body_start = tag_end + 1;
        let body_end = src[body_start..]
            .find(&close)
            .or_else(|| {
                if close_l != close {
                    src[body_start..].find(&close_l)
                } else {
                    None
                }
            })
            .map(|o| body_start + o);
        let Some(body_end) = body_end else {
            // Unclosed — skip
            search_from = tag_end + 1;
            continue;
        };
        let body = &src[body_start..body_end];
        if html_element_has_element_children(body) {
            let line = src[..tag_start].bytes().filter(|&b| b == b'\n').count() + 1;
            errors.push(format!(
                "dist/index.html:{line}: data-i18n=\"{key}\" on non-leaf <{tag_name}> (has element children)"
            ));
        }
        search_from = body_end;
    }
    errors
}

#[test]
fn i18n_markup_gate_index_html() {
    let path = manifest_dir().join("dist/index.html");
    let src = fs::read_to_string(&path).expect("read dist/index.html");
    let catalog = load_en_keys();

    // Every data-i18n-* key must exist in en (also covered by reference gate;
    // re-assert here so the markup gate is self-contained).
    let hits = find_html_attrs(&src, &path);
    assert!(
        !hits.is_empty(),
        "dist/index.html must contain data-i18n-* attributes (I2)"
    );
    let mut missing = Vec::new();
    for hit in &hits {
        let Some(k) = &hit.key else { continue };
        if !catalog.contains(k) {
            missing.push(format!(
                "{}:{}: key `{k}` (via {}) not in en catalog",
                hit.file, hit.line, hit.kind
            ));
        }
    }

    let non_leaves = find_data_i18n_non_leaves(&src);

    let mut errors = missing;
    errors.extend(non_leaves);
    if !errors.is_empty() {
        eprintln!("i18n markup gate FAILED ({} error(s)):", errors.len());
        for e in &errors {
            eprintln!("  ERROR  {e}");
        }
        panic!("i18n markup gate: {} error(s)", errors.len());
    }
    println!(
        "i18n markup gate OK: {} data-i18n-* refs, all leaf-safe",
        hits.len()
    );
}

#[test]
fn i18n_markup_leaf_detector_unit() {
    assert!(!html_element_has_element_children("Hello world"));
    assert!(!html_element_has_element_children(
        "Aa Groß-/Kleinschreibung"
    ));
    assert!(html_element_has_element_children(
        "<input type=\"checkbox\" /> text"
    ));
    assert!(html_element_has_element_children("<svg></svg>Version"));
    let errs = find_data_i18n_non_leaves(
        r#"<label data-i18n="x.label"><input type="checkbox" /> text</label>"#,
    );
    assert_eq!(errs.len(), 1, "{errs:?}");
    let ok = find_data_i18n_non_leaves(
        r#"<label><input type="checkbox" /> <span data-i18n="x.label">text</span></label>"#,
    );
    assert!(ok.is_empty(), "{ok:?}");
}
