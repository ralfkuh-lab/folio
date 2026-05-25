//! Diagnose-Bruecke vom Frontend ins `tracing`-Logfile.
//!
//! Frontend ruft `frontend_log` mit `{ level, source, message, fields }`;
//! das Backend dispatcht an das passende `tracing`-Macro mit dem festen
//! Target `folio::frontend`. Damit landen DOM-/Editor-/Vault-Errors aus
//! dem Frontend zusammen mit den Backend-Logs in derselben Tagesdatei
//! (`YYYY-MM-DD.log`), filterbar ueber das `logLevel`-Setting.
//!
//! Filtering passiert serverseitig im `tracing`-Subscriber. Das
//! Frontend macht zusaetzlich eine billige Vorab-Filterung gegen den
//! gecachten `logLevel` (siehe `util/log.ts`), damit z. B. ein Trace
//! pro Code-Block auch dann gar nicht erst zum IPC wird, wenn das
//! Setting auf `info` steht. Die Filter-Hoheit bleibt trotzdem beim
//! Backend — ein RUST_LOG-Override wird vom Frontend-Cache nicht
//! gesehen, was dokumentierte Konsequenzen hat (siehe CLAUDE.md).
//!
//! `target:` muss in `tracing`-Macros eine `&'static str`-Konstante
//! sein. Deshalb steckt der Frontend-spezifische Sub-Namespace im
//! `source`-Feld statt im Tracing-Target. Beim Lesen der Logs sucht
//! man also nach `source=view`/`source=vault`/etc. statt nach
//! verschachtelten Target-Pfaden.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrontendLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

const TARGET: &str = "folio::frontend";

#[tauri::command]
pub async fn frontend_log(
    level: FrontendLevel,
    source: String,
    message: String,
    fields: Option<serde_json::Value>,
) -> Result<(), String> {
    let src: &str = if source.is_empty() {
        "unknown"
    } else {
        source.as_str()
    };
    let payload = fields.as_ref();

    match level {
        FrontendLevel::Error => match payload {
            Some(v) => tracing::error!(target: TARGET, source = src, fields = %v, "{}", message),
            None => tracing::error!(target: TARGET, source = src, "{}", message),
        },
        FrontendLevel::Warn => match payload {
            Some(v) => tracing::warn!(target: TARGET, source = src, fields = %v, "{}", message),
            None => tracing::warn!(target: TARGET, source = src, "{}", message),
        },
        FrontendLevel::Info => match payload {
            Some(v) => tracing::info!(target: TARGET, source = src, fields = %v, "{}", message),
            None => tracing::info!(target: TARGET, source = src, "{}", message),
        },
        FrontendLevel::Debug => match payload {
            Some(v) => tracing::debug!(target: TARGET, source = src, fields = %v, "{}", message),
            None => tracing::debug!(target: TARGET, source = src, "{}", message),
        },
        FrontendLevel::Trace => match payload {
            Some(v) => tracing::trace!(target: TARGET, source = src, fields = %v, "{}", message),
            None => tracing::trace!(target: TARGET, source = src, "{}", message),
        },
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_level(s: &str) -> Result<FrontendLevel, serde_json::Error> {
        serde_json::from_str::<FrontendLevel>(&format!("\"{s}\""))
    }

    #[test]
    fn all_valid_levels_deserialize() {
        // Wenn das Frontend einen dieser Strings schickt, muss das
        // Backend ihn akzeptieren — sonst landet die Bridge im
        // `Result::Err`-Pfad und der Diagnose-Eintrag geht verloren.
        for s in ["error", "warn", "info", "debug", "trace"] {
            assert!(
                parse_level(s).is_ok(),
                "Frontend-Level '{s}' soll deserialisieren"
            );
        }
    }

    #[test]
    fn unknown_level_rejected() {
        assert!(parse_level("verbose").is_err());
        assert!(parse_level("").is_err());
        assert!(
            parse_level("WARN").is_err(),
            "case-sensitive: lowercase erwartet"
        );
    }

    #[test]
    fn level_is_lowercase_only() {
        // Die TS-Wrapper-Funktion `folioLog` schickt ausschliesslich
        // lowercase — hier festklopfen, damit ein versehentlicher
        // Wechsel auf rename_all="snake_case" o.ae. auffaellt.
        let json = serde_json::to_string(&serde_json::json!({
            "level": "warn", "source": "x", "message": "y", "fields": null
        }))
        .unwrap();
        #[derive(Deserialize)]
        struct Args {
            level: FrontendLevel,
        }
        let parsed: Args = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed.level, FrontendLevel::Warn));
    }
}
