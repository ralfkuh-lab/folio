use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub(crate) fn config_file(name: &str) -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("folio");
    let legacy = base.join("folio-rs");
    if !dir.exists() && legacy.exists() {
        let _ = fs::rename(&legacy, &dir);
    }
    dir.join(name)
}

/// Liefert das OS-spezifische Log-Verzeichnis fuer Folio.
///
/// - Linux/BSD: `$XDG_STATE_HOME/folio/logs` (Fallback
///   `~/.local/state/folio/logs`)
/// - macOS: `~/Library/Logs/Folio`
/// - Windows: `%LOCALAPPDATA%\Folio\logs`
///
/// `dirs::state_dir()` ist auf Linux der XDG-State-Pfad und liefert auf
/// anderen Plattformen `None`; dort fallen wir auf `data_local_dir()`
/// (Windows: LocalAppData, macOS: `~/Library/Application Support`) bzw.
/// `~/Library/Logs` auf macOS zurueck.
pub fn log_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            return home.join("Library").join("Logs").join("Folio");
        }
    }
    if let Some(state) = dirs::state_dir() {
        return state.join("folio").join("logs");
    }
    if let Some(local) = dirs::data_local_dir() {
        return local.join("folio").join("logs");
    }
    PathBuf::from(".").join("folio-logs")
}

pub(crate) fn load_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn save_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}
