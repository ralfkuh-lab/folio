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
//!    Wenn `RUST_LOG` gesetzt war, sperrt das auch den Live-Reload:
//!    spaetere `set_level`-Aufrufe (z. B. aus dem Settings-Dialog)
//!    werden als No-op behandelt, sonst koennte ein UI-Wechsel den
//!    Diagnose-Override stillschweigend wieder aufheben.
//! 2. Debug-Build (`cfg(debug_assertions)`) → `debug`.
//! 3. Setting `logLevel` aus `settings.json` → Default `info`, oder das
//!    persistierte Level.
//!
//! `Off` (Setting) deaktiviert die Ausgabe nicht durch Abschalten des
//! Subscribers, sondern durch einen `EnvFilter::new("off")` — das ist
//! wichtig, weil derselbe Reload-Handle Off→Info-Uebergaenge weiterhin
//! schalten koennen muss. `tracing-appender` legt das Tagesfile erst
//! beim ersten Schreiben an, also entstehen bei `off` keine leeren
//! Logdateien.
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
// Merkt sich, ob `RUST_LOG` beim Boot fuer den initialen Filter
// verantwortlich war. `set_level` macht in diesem Fall einen No-op,
// damit ein Settings-UI-Wechsel den ENV-Override nicht ueberschreibt
// (Override-Hierarchie aus dem Modul-Doc).
static RUST_LOG_OVERRIDE: OnceLock<bool> = OnceLock::new();

const LOG_FILE_SUFFIX: &str = "log";
const RETENTION_DAYS: u64 = 7;

pub fn init(level: LogLevel, log_dir: &Path) {
    if RELOAD_HANDLE.get().is_some() {
        // Schon initialisiert (sollte nur in Tests passieren).
        return;
    }

    let rust_log_set = std::env::var("RUST_LOG")
        .ok()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let (filter_expr, filter_kind) = resolve_boot_filter(level);

    let env_filter = match EnvFilter::try_new(&filter_expr) {
        Ok(filter) => filter,
        Err(err) => {
            // Tracing-Subscriber ist noch nicht initialisiert — direkter
            // Schreibzugriff auf stderr, damit Tippfehler im
            // RUST_LOG-Override sichtbar werden.
            eprintln!(
                "[folio::logging] ungueltiger Filter-Ausdruck '{filter_expr}' \
                 ({filter_kind}): {err} — Fallback auf 'info'"
            );
            EnvFilter::new(LogLevel::Info.env_filter())
        }
    };
    let (filter_layer, reload_handle) = reload::Layer::new(env_filter);

    // Rolling-File-Sink. Verzeichnis best-effort anlegen.
    if let Err(err) = std::fs::create_dir_all(log_dir) {
        eprintln!(
            "[folio::logging] konnte Log-Verzeichnis '{}' nicht anlegen: {err}",
            log_dir.display()
        );
    }
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

    // Globale Default-Subscriber erst installieren, dann die Handles
    // global sichtbar machen. Wenn `set_global_default` scheitert (z. B.
    // weil schon ein Subscriber installiert wurde), bleiben
    // `RELOAD_HANDLE` und `FILE_GUARD` leer — `set_level` wird damit
    // konsistent zum No-op, statt einen nie aktiven Subscriber zu
    // reloaden. `guard` geht out-of-scope, der Non-Blocking-Worker
    // wird sauber heruntergefahren.
    match tracing::subscriber::set_global_default(subscriber) {
        Ok(()) => {
            let _ = RELOAD_HANDLE.set(reload_handle);
            let _ = FILE_GUARD.set(guard);
            let _ = RUST_LOG_OVERRIDE.set(rust_log_set);
            tracing::info!(
                target: "folio::boot",
                level = %level.code(),
                log_dir = %log_dir.display(),
                rust_log = rust_log_set,
                "logging initialisiert"
            );
        }
        Err(err) => {
            eprintln!("[folio::logging] set_global_default fehlgeschlagen: {err}");
        }
    }
}

/// Live-Update des Level-Filters. Wird vom Settings-Side-Effect
/// aufgerufen, wenn der User das Setting im UI aendert.
///
/// No-op, wenn:
/// - `init` nie erfolgreich Subscriber installiert hat,
/// - `RUST_LOG` beim Boot gesetzt war (ENV gewinnt gegen UI-Setting —
///   sonst koennte ein versehentlicher Settings-Wechsel den
///   Diagnose-Override aufheben).
pub fn set_level(level: LogLevel) {
    let Some(handle) = RELOAD_HANDLE.get() else {
        return;
    };
    if RUST_LOG_OVERRIDE.get().copied().unwrap_or(false) {
        tracing::warn!(
            target: "folio::settings",
            requested = %level.code(),
            "log-level wird nicht umgeschaltet — RUST_LOG-Override aktiv"
        );
        return;
    }
    let expr = level.env_filter();
    match EnvFilter::try_new(expr) {
        Ok(new_filter) => match handle.reload(new_filter) {
            Ok(()) => {
                tracing::info!(target: "folio::settings", level = %level.code(), "log-level umgeschaltet");
            }
            Err(err) => {
                tracing::error!(
                    target: "folio::settings",
                    level = %level.code(),
                    %err,
                    "reload des log-level-filters fehlgeschlagen"
                );
            }
        },
        Err(err) => {
            tracing::error!(
                target: "folio::settings",
                level = %level.code(),
                %err,
                "konnte EnvFilter fuer log-level nicht bauen"
            );
        }
    }
}

/// Liefert den Filter-Ausdruck fuer den Boot-Subscriber zusammen mit
/// einer Quellenkennzeichnung (fuer Fehlermeldungen). Implementiert die
/// Override-Hierarchie aus dem Modul-Doc:
/// `RUST_LOG` > `cfg(debug_assertions)` > Setting.
fn resolve_boot_filter(level: LogLevel) -> (String, &'static str) {
    if let Ok(env) = std::env::var("RUST_LOG") {
        if !env.trim().is_empty() {
            return (env, "RUST_LOG");
        }
    }
    if cfg!(debug_assertions) {
        return (LogLevel::Debug.env_filter().to_string(), "debug-build default");
    }
    (level.env_filter().to_string(), "logLevel setting")
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
    use std::sync::Mutex;

    // ENV-Mutationen serialisieren — sonst flackern parallele Tests bei
    // gleichzeitigem set_var/remove_var auf `RUST_LOG`.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn off_yields_off_filter_expression() {
        assert_eq!("off", LogLevel::Off.env_filter());
    }

    #[test]
    fn rust_log_overrides_setting() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("RUST_LOG", "folio=trace");
        let (expr, kind) = resolve_boot_filter(LogLevel::Info);
        std::env::remove_var("RUST_LOG");
        assert_eq!("folio=trace", expr);
        assert_eq!("RUST_LOG", kind);
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
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("RUST_LOG", "   ");
        let (expr, kind) = resolve_boot_filter(LogLevel::Error);
        std::env::remove_var("RUST_LOG");
        // Im Debug-Build ueberschreibt cfg(debug_assertions) auf debug;
        // im Release-Build kommt der Error-Filter.
        if cfg!(debug_assertions) {
            assert_eq!(LogLevel::Debug.env_filter(), expr);
            assert_eq!("debug-build default", kind);
        } else {
            assert_eq!(LogLevel::Error.env_filter(), expr);
            assert_eq!("logLevel setting", kind);
        }
    }

    #[test]
    fn invalid_rust_log_is_detected_by_envfilter() {
        // Bestaetigt, dass `EnvFilter::try_new` einen Tippfehler im
        // RUST_LOG-Override tatsaechlich erkennt — die Fallback-
        // Eprintln-Logik im echten `init` greift dann auf 'info'.
        // Hier explizit OHNE Mutation der ENV; wir testen nur die
        // Filter-Bibliothek, nicht `resolve_boot_filter`.
        let result = EnvFilter::try_new("!!!not-a-valid-filter!!!");
        assert!(result.is_err(), "EnvFilter sollte den Ausdruck ablehnen");
    }

    #[test]
    fn all_loglevel_env_filter_expressions_parse() {
        // Jedes `LogLevel` muss einen gueltigen EnvFilter-Ausdruck
        // liefern — sonst koennten Live-Reloads aus dem Settings-UI
        // im Stillen scheitern.
        for level in [
            LogLevel::Off,
            LogLevel::Error,
            LogLevel::Warn,
            LogLevel::Info,
            LogLevel::Debug,
        ] {
            let expr = level.env_filter();
            assert!(
                EnvFilter::try_new(expr).is_ok(),
                "LogLevel::{:?}.env_filter() = {expr:?} ist kein gueltiger EnvFilter-Ausdruck",
                level
            );
        }
    }
}
