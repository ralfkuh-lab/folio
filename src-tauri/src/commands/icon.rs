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
