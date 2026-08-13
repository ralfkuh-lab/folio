//! Tauri-Commands fuer Git-Anzeige (HEAD-Fassung fuer den Diff).

use crate::file_kind::{classify, editor_language, FileKind};
use crate::git_status::{show_head, ShowHeadError};
use crate::i18n;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHeadPayload {
    pub text: String,
    pub disk_text: String,
    pub language: String,
}

#[tauri::command]
pub async fn git_show_head(path: String) -> Result<GitHeadPayload, String> {
    let path = path.replace('\\', "/");
    match classify(&path) {
        FileKind::Markdown | FileKind::Text => {}
        _ => {
            let detail = Path::new(&path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&path);
            return Err(i18n::t_args(
                "errors.file.unsupportedType",
                &[("detail", detail)],
            ));
        }
    }
    let original = match show_head(Path::new(&path)) {
        Ok(text) => text,
        Err(ShowHeadError::NoHead) => return Err(i18n::t("errors.git.noHead")),
        Err(ShowHeadError::NotInHead) => return Err(i18n::t("errors.git.notInHead")),
        Err(ShowHeadError::TooLarge) => return Err(i18n::t("errors.git.diffTooLarge")),
        Err(ShowHeadError::NoRepo) | Err(ShowHeadError::Failed) => {
            return Err(i18n::t("errors.git.showFailed"));
        }
    };
    let disk_text = match crate::git_status::read_working_tree_for_diff(Path::new(&path)) {
        Ok(text) => text,
        Err(ShowHeadError::TooLarge) => return Err(i18n::t("errors.git.diffTooLarge")),
        Err(_) => return Err(i18n::t("errors.git.showFailed")),
    };
    Ok(GitHeadPayload {
        text: original,
        disk_text,
        language: editor_language(&path).to_string(),
    })
}
