use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Markdown,
    Text,
    Image,
    Binary,
}

const MARKDOWN_EXT: &[&str] = &["md", "markdown", "mdown", "mkd"];

// Browser-/WebView-rendering-faehige Bildformate. SVG ist hier dabei,
// weil das XML-Routing als Text trotzdem unkomfortabel ist — als
// Vorschau klassifizieren wir es als Bild, eine Edit-Sicht ist via
// Picker-Override weiterhin moeglich (TODO Editor-Sprache-Override).
const IMAGE_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];

const TEXT_EXT: &[&str] = &[
    "txt",
    "log",
    "ini",
    "conf",
    "cfg",
    "env",
    "rst",
    "csv",
    "tsv",
    "json",
    "json5",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "xml",
    "svg",
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "rs",
    "py",
    "rb",
    "go",
    "java",
    "kt",
    "kts",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "fs",
    "fsx",
    "swift",
    "php",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "sql",
    "graphql",
    "gql",
    "lua",
    "r",
    "tex",
    "bib",
    "dockerfile",
    "makefile",
    "gitignore",
    "gitattributes",
    "editorconfig",
    // CAD/CAM-Textformate (ASCII). STL/PLY bewusst nicht — die gibt es
    // als ASCII *und* binaer (deckt classify_deep ab). 3MF/AMF sind
    // ZIP-Container.
    "step",
    "stp",
    "gcode",
    "gco",
    "nc",
    "scad",
    "obj",
];

/// Dateien groesser als dieses Limit bleiben `Binary`, auch wenn der
/// Anfang nach Text aussieht. 32 MiB — darueber lohnt sich kein
/// Editor-Open eines unbekannten Formats.
const SNIFF_MAX_BYTES: u64 = 32 * 1024 * 1024;
const SNIFF_BLOCK_BYTES: usize = 64 * 1024;

/// Wenn `name` mit '.' beginnt, der Rest (so `.gitignore` dieselben Keys
/// trifft wie `foo.gitignore`). Kein blindes Strippen: Namen ohne
/// fuehrenden Punkt bleiben unveraendert.
fn leading_dot_key(name: &str) -> Option<&str> {
    name.strip_prefix('.').filter(|rest| !rest.is_empty())
}

/// Editor-Sprache (Monaco-ID) anhand der Dateiendung. Unabhängig von
/// `FileKind` — feinere Granularität, steuert nur Syntax-Highlighting.
/// Default `"plaintext"` für unbekannte/fehlende Endungen.
pub fn editor_language(path: &str) -> &'static str {
    let p = Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    if let Some(ext) = ext.as_deref() {
        if let Some(lang) = match_extension(ext) {
            return lang;
        }
    }
    if let Some(name) = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_ascii_lowercase())
    {
        if let Some(lang) = match_filename(name.as_str()) {
            return lang;
        }
        if let Some(stripped) = leading_dot_key(&name) {
            if let Some(lang) = match_filename(stripped) {
                return lang;
            }
            // `.env` / `.editorconfig` haben keine `Path::extension()`,
            // `foo.env` schon — denselben Monaco-Treffer liefern.
            if let Some(lang) = match_extension(stripped) {
                return lang;
            }
        }
    }
    "plaintext"
}

fn match_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "md" | "markdown" | "mdown" | "mkd" => "markdown",
        "json" | "jsonc" | "json5" => "json",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "less" => "less",
        "xml" | "svg" => "xml",
        "yaml" | "yml" => "yaml",
        "toml" | "ini" | "cfg" | "conf" | "env" | "editorconfig" => "ini",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "ps1" => "powershell",
        "bat" | "cmd" => "bat",
        "py" => "python",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cc" | "cpp" | "hpp" => "cpp",
        "cs" => "csharp",
        "fs" | "fsx" => "fsharp",
        "swift" => "swift",
        "php" => "php",
        "rb" => "ruby",
        "sql" => "sql",
        "graphql" | "gql" => "graphql",
        "lua" => "lua",
        "r" => "r",
        "tex" | "bib" => "plaintext",
        "dockerfile" => "dockerfile",
        "csv" | "tsv" | "log" | "txt" | "rst" => "plaintext",
        _ => return None,
    })
}

fn match_filename(name: &str) -> Option<&'static str> {
    Some(match name {
        "dockerfile" => "dockerfile",
        "makefile" => "plaintext",
        "gitignore" | "gitattributes" => "plaintext",
        _ => return None,
    })
}

/// Endung bzw. Dateiname → Kind, in der festen Reihenfolge Markdown →
/// Image → Text. `None`, wenn der Schlüssel in keiner Liste steht.
fn kind_from_key(key: &str) -> Option<FileKind> {
    if MARKDOWN_EXT.contains(&key) {
        Some(FileKind::Markdown)
    } else if IMAGE_EXT.contains(&key) {
        Some(FileKind::Image)
    } else if TEXT_EXT.contains(&key) {
        Some(FileKind::Text)
    } else {
        None
    }
}

pub fn classify(path: &str) -> FileKind {
    let p = Path::new(path);

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());

    if let Some(ext) = ext.as_deref() {
        if let Some(kind) = kind_from_key(ext) {
            return kind;
        }
    }

    if let Some(name) = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_ascii_lowercase())
    {
        if matches!(
            name.as_str(),
            "readme" | "license" | "licence" | "changelog" | "authors" | "contributors"
        ) {
            return FileKind::Text;
        }
        if let Some(kind) = kind_from_key(name.as_str()) {
            return kind;
        }
        if let Some(stripped) = leading_dot_key(&name) {
            if let Some(kind) = kind_from_key(stripped) {
                return kind;
            }
        }
    }

    FileKind::Binary
}

/// Wie [`classify`], aber wenn die Endung nichts hergibt (`Binary`), entscheidet
/// der Dateiinhalt. Macht IO — deshalb NUR für ein einzelnes, konkret zu
/// öffnendes Dokument verwenden, niemals über Listen/Bäume/Indizes iterieren
/// (`vault.rs`, `vault_filter.rs`, `wikilink.rs`, `tags.rs`, der
/// `FileFilter`-Walk in `search.rs` bleiben endungsbasiert).
///
/// Sniff: bekannte BOM am Dateianfang → Text (UTF-16 mit BOM ist voller NULs
/// und muss Text bleiben). Sonst NUL irgendwo in der Datei (gestreamt in
/// 64-KiB-Blöcken, Cap 32 MiB) → Binary, kein NUL → Text. Nicht-Dateien und
/// alles über dem Cap bleiben Binary.
///
/// Eine nur per Sniff erkannte Textdatei lässt sich öffnen, bearbeiten und
/// speichern, hat im Vault aber kein `data-text="1"` (also kein „Änderungen
/// anzeigen" im Kontextmenü) und wird von `fileFilter: allText` nicht
/// durchsucht.
pub fn classify_deep(path: &str) -> FileKind {
    classify_deep_with_limit(path, SNIFF_MAX_BYTES)
}

/// Wie [`classify_deep`], mit übergebenem Größen-Cap — damit der 32-MiB-
/// Cutover in Tests ohne eine 33-MiB-Datei belegbar ist.
fn classify_deep_with_limit(path: &str, max_bytes: u64) -> FileKind {
    let kind = classify(path);
    if kind != FileKind::Binary {
        return kind;
    }
    sniff_unknown(path, max_bytes)
}

fn sniff_unknown(path: &str, max_bytes: u64) -> FileKind {
    use std::io::Read;

    // Vorprüfung per Pfad-Metadaten: hält uns von FIFOs fern, deren
    // `File::open` ohne Writer blockiert. Das geöffnete Handle wird
    // danach noch einmal gegengeprüft — sonst gälte das Versprechen
    // für ein anderes Objekt als das gelesene.
    let pre = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return FileKind::Binary,
    };
    if !pre.is_file() || pre.len() > max_bytes {
        return FileKind::Binary;
    }

    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return FileKind::Binary,
    };

    let meta = match file.metadata() {
        Ok(meta) => meta,
        Err(_) => return FileKind::Binary,
    };
    if !meta.is_file() || meta.len() > max_bytes {
        return FileKind::Binary;
    }

    let mut head = Vec::new();
    if file.by_ref().take(3).read_to_end(&mut head).is_err() {
        return FileKind::Binary;
    }
    if has_text_bom(&head) {
        return FileKind::Text;
    }
    if head.contains(&0) {
        return FileKind::Binary;
    }

    let mut limited = file.take(max_bytes.saturating_sub(head.len() as u64));
    let mut block = vec![0u8; SNIFF_BLOCK_BYTES];
    loop {
        match limited.read(&mut block) {
            Ok(0) => break,
            Ok(n) => {
                if block[..n].contains(&0) {
                    return FileKind::Binary;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return FileKind::Binary,
        }
    }
    FileKind::Text
}

fn has_text_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
}

/// Heuristik, ob `path` "ausführbar" im Sinne eines Doppelklicks im
/// Dateimanager ist. Unix: reguläre Datei mit gesetztem Execute-Bit
/// (folgt Symlinks via `metadata`). Windows: reguläre Datei mit Endung
/// aus einer PATHEXT-ähnlichen Liste. Verzeichnisse und nicht
/// existierende Pfade sind nie ausführbar.
#[cfg(unix)]
pub fn is_executable(path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(Path::new(path)) {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

#[cfg(windows)]
pub fn is_executable(path: &str) -> bool {
    const EXEC_EXT: &[&str] = &["exe", "bat", "cmd", "com", "ps1", "msi", "scr"];
    let p = Path::new(path);
    if !p.is_file() {
        return false;
    }
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXEC_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_markdown() {
        assert_eq!(FileKind::Markdown, classify("notes.md"));
        assert_eq!(FileKind::Markdown, classify("/abs/path/x.MARKDOWN"));
    }

    #[test]
    fn classifies_text() {
        assert_eq!(FileKind::Text, classify("config.json"));
        assert_eq!(FileKind::Text, classify("page.html"));
        assert_eq!(FileKind::Text, classify("Dockerfile"));
        assert_eq!(FileKind::Text, classify("LICENSE"));
    }

    #[test]
    fn editor_language_maps_common_extensions() {
        assert_eq!("markdown", editor_language("notes.md"));
        assert_eq!("json", editor_language("config.json"));
        assert_eq!("typescript", editor_language("/abs/x.TS"));
        assert_eq!("html", editor_language("page.htm"));
        assert_eq!("shell", editor_language("run.sh"));
        assert_eq!("dockerfile", editor_language("Dockerfile"));
        assert_eq!("plaintext", editor_language("notes.txt"));
        assert_eq!("plaintext", editor_language("noext"));
    }

    #[test]
    fn classifies_binary() {
        assert_eq!(FileKind::Binary, classify("archive.zip"));
        assert_eq!(FileKind::Binary, classify("doc.docx"));
        assert_eq!(FileKind::Binary, classify("noext"));
        // STL/PLY/3MF bewusst nicht in TEXT_EXT (Binaer- bzw. ZIP-Variante).
        assert_eq!(FileKind::Binary, classify("mesh.stl"));
        assert_eq!(FileKind::Binary, classify("mesh.ply"));
        assert_eq!(FileKind::Binary, classify("model.3mf"));
    }

    #[test]
    fn classifies_cad_cam_text_extensions() {
        assert_eq!(FileKind::Text, classify("part.step"));
        assert_eq!(FileKind::Text, classify("part.stp"));
        assert_eq!(FileKind::Text, classify("print.gcode"));
        assert_eq!(FileKind::Text, classify("print.gco"));
        assert_eq!(FileKind::Text, classify("mill.nc"));
        assert_eq!(FileKind::Text, classify("model.scad"));
        assert_eq!(FileKind::Text, classify("mesh.obj"));
        assert_eq!(FileKind::Text, classify("TOWEL.GCODE"));
        assert_eq!("plaintext", editor_language("print.gcode"));
        assert_eq!("plaintext", editor_language("TOWEL.GCODE"));
        assert_eq!("plaintext", editor_language("part.step"));
    }

    #[test]
    fn classifies_dotfiles_as_text() {
        assert_eq!(FileKind::Text, classify(".gitignore"));
        assert_eq!(FileKind::Text, classify(".env"));
        assert_eq!(FileKind::Text, classify(".editorconfig"));
        assert_eq!(FileKind::Text, classify(".gitattributes"));
        assert_eq!(FileKind::Text, classify("/abs/path/.GITIGNORE"));
        assert_eq!(FileKind::Text, classify("foo.gitignore"));
        // Ohne fuehrenden Punkt nicht strippen: "notgitignore" bleibt Binary.
        assert_eq!(FileKind::Binary, classify("notgitignore"));
    }

    #[test]
    fn classifies_dotfile_keys_like_extensions() {
        assert_eq!(FileKind::Markdown, classify(".md"));
        assert_eq!(FileKind::Image, classify(".svg"));
        assert_eq!(FileKind::Text, classify(".txt"));
        assert_eq!(FileKind::Image, classify(".png"));
        assert_eq!(FileKind::Text, classify(".gitignore"));
        assert_eq!(FileKind::Markdown, classify("/abs/.MD"));
    }

    #[test]
    fn editor_language_matches_dotfile_to_extension_form() {
        assert_eq!(
            editor_language(".gitignore"),
            editor_language("foo.gitignore")
        );
        assert_eq!(editor_language(".env"), editor_language("foo.env"));
        assert_eq!(
            editor_language(".editorconfig"),
            editor_language("foo.editorconfig")
        );
        assert_eq!(
            editor_language(".gitattributes"),
            editor_language("foo.gitattributes")
        );
        assert_eq!("ini", editor_language(".env"));
        assert_eq!("plaintext", editor_language(".gitignore"));
    }

    #[test]
    fn classifies_image() {
        assert_eq!(FileKind::Image, classify("photo.png"));
        assert_eq!(FileKind::Image, classify("logo.SVG"));
        assert_eq!(FileKind::Image, classify("/abs/path/sprite.webp"));
        assert_eq!(FileKind::Image, classify("favicon.ico"));
        assert_eq!(FileKind::Image, classify("animated.gif"));
        assert_eq!(FileKind::Image, classify("photo.jpeg"));
        assert_eq!(FileKind::Image, classify("photo.jpg"));
    }

    #[cfg(unix)]
    #[test]
    fn test_is_executable_unix() {
        use std::fs::{remove_file, set_permissions, File, Permissions};
        use std::os::unix::fs::PermissionsExt;

        let mut temp_path = std::env::temp_dir();
        let file_name = format!("test_exec_{}", std::process::id());
        temp_path.push(file_name);

        let path_str = temp_path.to_str().unwrap();

        // Frisch geschriebene Datei anlegen (ohne +x)
        {
            let _file = File::create(&temp_path).unwrap();
        }
        set_permissions(&temp_path, Permissions::from_mode(0o644)).ok();
        assert!(!is_executable(path_str));

        // Nach set_permissions(0o755) -> true
        set_permissions(&temp_path, Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable(path_str));

        // Datei wieder löschen
        let _ = remove_file(&temp_path);

        // Ein Verzeichnis (z. B. std::env::temp_dir()) -> false
        let temp_dir_str = std::env::temp_dir().to_str().unwrap().to_string();
        assert!(!is_executable(&temp_dir_str));
    }

    fn sniff_path(dir: &tempfile::TempDir, name: &str) -> String {
        dir.path().join(name).to_str().unwrap().to_string()
    }

    #[test]
    fn classify_deep_ascii_without_extension_is_text() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sniff_path(&dir, "untitled");
        std::fs::write(&path, b"G1 X10 Y20\n").unwrap();
        assert_eq!(FileKind::Text, classify_deep(&path));
    }

    #[test]
    fn classify_deep_nul_in_window_is_binary() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sniff_path(&dir, "blob");
        std::fs::write(&path, b"hello\0world").unwrap();
        assert_eq!(FileKind::Binary, classify_deep(&path));
    }

    #[test]
    fn classify_deep_empty_file_is_text() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sniff_path(&dir, "empty");
        std::fs::write(&path, b"").unwrap();
        assert_eq!(FileKind::Text, classify_deep(&path));
    }

    #[test]
    fn classify_deep_utf16_le_bom_is_text_despite_nuls() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sniff_path(&dir, "wide");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "Hi".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(FileKind::Text, classify_deep(&path));
    }

    #[test]
    fn classify_deep_over_limit_stays_binary() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sniff_path(&dir, "big");
        std::fs::write(&path, b"0123456789").unwrap();
        assert_eq!(FileKind::Binary, classify_deep_with_limit(&path, 9));
        assert_eq!(FileKind::Text, classify_deep_with_limit(&path, 10));
    }

    #[test]
    fn classify_deep_exactly_at_limit_is_sniffed() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sniff_path(&dir, "exact");
        std::fs::write(&path, b"0123456789").unwrap();
        assert_eq!(FileKind::Text, classify_deep_with_limit(&path, 10));
    }

    #[test]
    fn classify_deep_utf8_and_utf16be_bom_are_text() {
        let dir = tempfile::TempDir::new().unwrap();
        let utf8 = sniff_path(&dir, "utf8bom");
        std::fs::write(&utf8, b"\xEF\xBB\xBFHello").unwrap();
        assert_eq!(FileKind::Text, classify_deep(&utf8));

        let be = sniff_path(&dir, "utf16be");
        let mut bytes = vec![0xFE, 0xFF];
        for unit in "Hi".encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        std::fs::write(&be, &bytes).unwrap();
        assert_eq!(FileKind::Text, classify_deep(&be));
    }

    #[test]
    fn classify_deep_nul_beyond_and_at_8kib_is_binary() {
        let dir = tempfile::TempDir::new().unwrap();

        let far = sniff_path(&dir, "far");
        let mut far_bytes = vec![b'A'; 9000];
        far_bytes.push(0);
        std::fs::write(&far, &far_bytes).unwrap();
        assert_eq!(FileKind::Binary, classify_deep(&far));

        let at_8191 = sniff_path(&dir, "at8191");
        let mut b8191 = vec![b'A'; 8191];
        b8191.push(0);
        std::fs::write(&at_8191, &b8191).unwrap();
        assert_eq!(FileKind::Binary, classify_deep(&at_8191));

        let at_8192 = sniff_path(&dir, "at8192");
        let mut b8192 = vec![b'A'; 8192];
        b8192.push(0);
        std::fs::write(&at_8192, &b8192).unwrap();
        assert_eq!(FileKind::Binary, classify_deep(&at_8192));
    }

    #[test]
    fn classify_deep_latin1_high_bytes_without_nul_are_text() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = sniff_path(&dir, "latin1");
        std::fs::write(&path, b"Gr\xfc\xdfe\n").unwrap();
        assert_eq!(FileKind::Text, classify_deep(&path));
    }

    #[test]
    fn classify_deep_directory_is_binary() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            FileKind::Binary,
            classify_deep(dir.path().to_str().unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn classify_deep_symlink_to_text_is_text() {
        let dir = tempfile::TempDir::new().unwrap();
        let target = dir.path().join("target");
        std::fs::write(&target, b"hello\n").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(FileKind::Text, classify_deep(link.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn classify_deep_broken_symlink_is_binary() {
        let dir = tempfile::TempDir::new().unwrap();
        let link = dir.path().join("broken");
        std::os::unix::fs::symlink(dir.path().join("missing"), &link).unwrap();
        assert_eq!(FileKind::Binary, classify_deep(link.to_str().unwrap()));
    }

    #[test]
    fn classify_deep_known_extension_skips_io() {
        assert_eq!(FileKind::Markdown, classify_deep("nicht/vorhanden/foo.md"));
    }

    #[test]
    fn classify_deep_missing_unknown_is_binary() {
        assert_eq!(FileKind::Binary, classify_deep("nicht/vorhanden/foo"));
    }
}
