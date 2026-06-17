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
];

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

pub fn classify(path: &str) -> FileKind {
    let p = Path::new(path);

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());

    if let Some(ext) = ext.as_deref() {
        if MARKDOWN_EXT.contains(&ext) {
            return FileKind::Markdown;
        }
        if IMAGE_EXT.contains(&ext) {
            return FileKind::Image;
        }
        if TEXT_EXT.contains(&ext) {
            return FileKind::Text;
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
        if TEXT_EXT.contains(&name.as_str()) {
            return FileKind::Text;
        }
    }

    FileKind::Binary
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
}
