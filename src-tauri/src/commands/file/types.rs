use crate::file_kind::FileKind;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileData {
    pub path: String,
    pub content: String,
    pub kind: FileKind,
    pub language: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_data_shape_holds_path_and_content() {
        let data = FileData {
            path: "a".into(),
            content: "b".into(),
            kind: FileKind::Markdown,
            language: "markdown".into(),
        };
        assert_eq!("a", data.path);
        assert_eq!("b", data.content);
    }
}
