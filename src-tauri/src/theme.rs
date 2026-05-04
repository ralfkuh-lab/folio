use crate::persist;
use serde::{Deserialize, Serialize};
use std::{io, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeData {
    pub mode: String,
}

impl Default for ThemeData {
    fn default() -> Self {
        Self {
            mode: "light".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ThemeService {
    data: ThemeData,
    path: PathBuf,
}

impl Default for ThemeService {
    fn default() -> Self {
        Self::load()
    }
}

impl ThemeService {
    pub fn load() -> Self {
        Self::load_from(persist::config_file("theme.json"))
    }

    pub fn load_from(path: PathBuf) -> Self {
        let data = persist::load_json(&path);
        Self { data, path }
    }

    pub fn mode(&self) -> &str {
        &self.data.mode
    }

    pub fn set_mode(&mut self, mode: &str) -> io::Result<()> {
        let normalized = match mode.to_ascii_lowercase().as_str() {
            "dark" => "dark".to_string(),
            _ => "light".to_string(),
        };
        if normalized == self.data.mode {
            return Ok(());
        }
        self.data.mode = normalized;
        persist::save_json_atomic(&self.path, &self.data)
    }

    pub fn toggle(&mut self) -> io::Result<&str> {
        let next = if self.data.mode == "dark" { "light" } else { "dark" };
        self.set_mode(next)?;
        Ok(self.mode())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn defaults_to_light() {
        let temp = TempDir::new().unwrap();
        let svc = ThemeService::load_from(temp.path().join("theme.json"));
        assert_eq!("light", svc.mode());
    }

    #[test]
    fn set_mode_persists_dark_normalized() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("theme.json");
        let mut svc = ThemeService::load_from(path.clone());
        svc.set_mode("DARK").unwrap();
        let reloaded = ThemeService::load_from(path);
        assert_eq!("dark", reloaded.mode());
    }

    #[test]
    fn toggle_flips_mode() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("theme.json");
        let mut svc = ThemeService::load_from(path);
        assert_eq!("dark", svc.toggle().unwrap());
        assert_eq!("light", svc.toggle().unwrap());
    }
}
