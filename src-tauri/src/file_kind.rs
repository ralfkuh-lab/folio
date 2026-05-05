use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Markdown,
    Text,
    Binary,
}

const MARKDOWN_EXT: &[&str] = &["md", "markdown", "mdown", "mkd"];

const TEXT_EXT: &[&str] = &[
    "txt", "log", "ini", "conf", "cfg", "env", "rst", "csv", "tsv", "json", "json5", "jsonc",
    "yaml", "yml", "toml", "xml", "svg", "html", "htm", "css", "scss", "sass", "less", "js",
    "jsx", "mjs", "cjs", "ts", "tsx", "rs", "py", "rb", "go", "java", "kt", "kts", "c", "h",
    "cc", "cpp", "hpp", "cs", "fs", "fsx", "swift", "php", "sh", "bash", "zsh", "fish", "ps1",
    "bat", "cmd", "sql", "graphql", "gql", "lua", "r", "tex", "bib", "dockerfile", "makefile",
    "gitignore", "gitattributes", "editorconfig",
];

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
    fn classifies_binary() {
        assert_eq!(FileKind::Binary, classify("photo.png"));
        assert_eq!(FileKind::Binary, classify("archive.zip"));
        assert_eq!(FileKind::Binary, classify("noext"));
    }
}
