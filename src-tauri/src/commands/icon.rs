use std::collections::HashMap;

use crate::file_icon;
use base64::{engine::general_purpose::STANDARD, Engine as _};

#[tauri::command]
pub async fn file_icon_data_uri(ext: String) -> String {
    match file_icon::icon_for_extension(&ext) {
        Some(icon) => {
            let b64 = STANDARD.encode(&icon.bytes);
            format!("data:{};base64,{}", icon.mime, b64)
        }
        None => String::new(),
    }
}

/// Löst mehrere Extensions in einem einzigen IPC-Call auf.
/// Rückgabe: Map von Extension → Data-URI (leerer String wenn kein Icon).
#[tauri::command]
pub async fn file_icons_batch(exts: Vec<String>) -> HashMap<String, String> {
    exts.into_iter()
        .map(|ext| {
            let uri = match file_icon::icon_for_extension(&ext) {
                Some(icon) => {
                    let b64 = STANDARD.encode(&icon.bytes);
                    format!("data:{};base64,{}", icon.mime, b64)
                }
                None => String::new(),
            };
            (ext, uri)
        })
        .collect()
}
