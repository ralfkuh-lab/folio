use std::{fs, path::Path};

use super::types::FileEntry;

#[tauri::command]
pub async fn file_list(dir: String) -> Result<Vec<FileEntry>, String> {
    list_dir(&dir).map_err(|error| error.to_string())
}

pub fn list_dir(dir: &str) -> std::io::Result<Vec<FileEntry>> {
    let mut entries = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            FileEntry {
                name: file_name(&path),
                is_directory: path.is_dir(),
                path: path.to_string_lossy().into_owned(),
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn list_dir_sorts_directories_first() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("b.md"), "").unwrap();
        fs::create_dir(temp.path().join("a")).unwrap();
        let entries = list_dir(temp.path().to_str().unwrap()).unwrap();
        assert_eq!("a", entries[0].name);
        assert!(entries[0].is_directory);
    }

    #[test]
    fn missing_directory_returns_error() {
        assert!(list_dir("/definitely/missing/folio").is_err());
    }
}
