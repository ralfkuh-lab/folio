//! Folio-Logging: `tracing`-Setup mit Stderr- und Rolling-File-Sink,
//! Live-Reload des Levels und RUST_LOG-Override.
//!
//! Aufgerufen genau einmal aus `lib.rs::run`. Frontend kann das Level
//! ueber das Settings-Panel zur Laufzeit aendern — der Subscriber wird
//! per `tracing_subscriber::reload` umkonfiguriert, ohne dass Folio neu
//! gestartet werden muss.
//!
//! Hierarchie der Level-Aufloesung beim Boot:
//! 1. `RUST_LOG` (ENV) → wird unveraendert an `EnvFilter` weitergereicht.
//! 2. Debug-Build (`cfg(debug_assertions)`) → `debug`.
//! 3. Setting `logLevel` aus `settings.json` → Default `info`, oder das
//!    persistierte Level.
//!
//! `Off` (Setting) deaktiviert die Ausgabe. Der File-Appender wird
//! trotzdem registriert, schreibt aber wegen des Off-Filters nie — und
//! `tracing-appender` legt das Tagesfile erst beim ersten Schreiben an,
//! also entstehen keine leeren Logdateien.
//!
//! Dateinamen-Konvention: `YYYY-MM-DD.log` (kein Prefix, Suffix `log`).
//! Damit erkennt Folio die Dateien als Text/`plaintext` und kann sie
//! selbst oeffnen; die alphabetische Sortierung im Datei-Manager faellt
//! mit der chronologischen Sortierung zusammen. Der Folio-Kontext
//! steckt im Verzeichnisnamen.

use crate::settings::LogLevel;
use std::path::Path;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::{fmt, layer::SubscriberExt, reload, EnvFilter, Registry};

type ReloadHandle = reload::Handle<EnvFilter, Registry>;

static RELOAD_HANDLE: OnceLock<ReloadHandle> = OnceLock::new();
// Lebt bis Programm-Ende, damit der Non-Blocking-Worker-Thread des
// File-Appenders nicht vor dem letzten Flush gedroppt wird.
static FILE_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

const LOG_FILE_SUFFIX: &str = "log";
const RETENTION_DAYS: u64 = 7;

pub fn init(level: LogLevel, log_dir: &Path) {
    if RELOAD_HANDLE.get().is_some() {
        // Schon initialisiert (sollte nur in Tests passieren).
        return;
    }

    let filter_expr = boot_filter_expr(level);
    let env_filter =
        EnvFilter::try_new(&filter_expr).unwrap_or_else(|_| EnvFilter::new(LogLevel::Info.env_filter()));
    let (filter_layer, reload_handle) = reload::Layer::new(env_filter);
    let _ = RELOAD_HANDLE.set(reload_handle);

    // Rolling-File-Sink. Verzeichnis best-effort anlegen; falls das
    // fehlschlaegt, behaelt der Appender den Pfad und schreibt nichts —
    // der Stderr-Layer bleibt intakt.
    let _ = std::fs::create_dir_all(log_dir);
    prune_old_logs(log_dir);
    // Nur Suffix, kein Prefix: ergibt `YYYY-MM-DD.log`. `Builder::build`
    // gibt nur dann `Err`, wenn weder Prefix noch Suffix gesetzt sind;
    // mit gesetztem Suffix ist `unwrap` sicher.
    let file_writer = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_suffix(LOG_FILE_SUFFIX)
        .build(log_dir)
        .expect("rolling file appender builder invariant");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_writer);
    let _ = FILE_GUARD.set(guard);

    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_ansi(true)
        .with_writer(std::io::stderr);

    let file_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(true)
        .with_ansi(false)
        .with_writer(non_blocking);

    let subscriber = Registry::default()
        .with(filter_layer)
        .with(stderr_layer)
        .with(file_layer);

    let _ = tracing::subscriber::set_global_default(subscriber);

    tracing::info!(
        target: "folio::boot",
        level = %level.code(),
        log_dir = %log_dir.display(),
        "logging initialisiert"
    );
}

/// Live-Update des Level-Filters. Wird vom Settings-Side-Effect
/// aufgerufen, wenn der User das Setting im UI aendert.
pub fn set_level(level: LogLevel) {
    let Some(handle) = RELOAD_HANDLE.get() else {
        return;
    };
    let expr = level.env_filter();
    if let Ok(new_filter) = EnvFilter::try_new(expr) {
        let _ = handle.reload(new_filter);
        tracing::info!(target: "folio::settings", level = %level.code(), "log-level umgeschaltet");
    }
}

fn boot_filter_expr(level: LogLevel) -> String {
    if let Ok(env) = std::env::var("RUST_LOG") {
        if !env.trim().is_empty() {
            return env;
        }
    }
    if cfg!(debug_assertions) {
        return LogLevel::Debug.env_filter().to_string();
    }
    level.env_filter().to_string()
}

fn prune_old_logs(dir: &Path) {
    use std::time::{Duration, SystemTime};
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let max_age = Duration::from_secs(60 * 60 * 24 * RETENTION_DAYS);
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // Matchen, was unser Appender erzeugt: `YYYY-MM-DD.log` und
        // Altbestand `folio.log.YYYY-MM-DD` (vor dem Rename-Schritt).
        let is_new = name.ends_with(".log") && is_iso_date_stem(name);
        let is_legacy = name.starts_with("folio.log");
        if !(is_new || is_legacy) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age > max_age {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn is_iso_date_stem(name: &str) -> bool {
    // `YYYY-MM-DD.log` ⇒ Stem ist die ersten 10 Zeichen.
    let stem = name.strip_suffix(".log").unwrap_or("");
    if stem.len() != 10 {
        return false;
    }
    let bytes = stem.as_bytes();
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(|c| c.is_ascii_digit())
        && bytes[5..7].iter().all(|c| c.is_ascii_digit())
        && bytes[8..10].iter().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_yields_off_filter_expression() {
        assert_eq!("off", LogLevel::Off.env_filter());
    }

    #[test]
    fn rust_log_overrides_setting() {
        std::env::set_var("RUST_LOG", "folio=trace");
        let expr = boot_filter_expr(LogLevel::Info);
        std::env::remove_var("RUST_LOG");
        assert_eq!("folio=trace", expr);
    }

    #[test]
    fn iso_date_stem_matches_appender_naming() {
        assert!(is_iso_date_stem("2026-05-21.log"));
        assert!(is_iso_date_stem("1999-01-01.log"));
        assert!(!is_iso_date_stem("folio.log.2026-05-21"));
        assert!(!is_iso_date_stem("2026-5-21.log"));
        assert!(!is_iso_date_stem("notes.log"));
        assert!(!is_iso_date_stem("2026-05-21"));
    }

    #[test]
    fn empty_rust_log_falls_back_to_setting() {
        std::env::set_var("RUST_LOG", "   ");
        let expr = boot_filter_expr(LogLevel::Error);
        std::env::remove_var("RUST_LOG");
        // Im Debug-Build ueberschreibt cfg(debug_assertions) auf debug;
        // im Release-Build kommt der Error-Filter.
        let expected = if cfg!(debug_assertions) {
            LogLevel::Debug.env_filter()
        } else {
            LogLevel::Error.env_filter()
        };
        assert_eq!(expected, expr);
    }
}
