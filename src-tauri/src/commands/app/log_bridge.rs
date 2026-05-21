//! Diagnose-Bruecke vom Frontend ins `tracing`-Logfile.
//!
//! Frontend ruft `frontend_log` mit `{ level, source, message, fields }`;
//! das Backend dispatcht an das passende `tracing`-Macro mit dem festen
//! Target `folio::frontend`. Damit landen DOM-/Editor-/Vault-Errors aus
//! dem Frontend zusammen mit den Backend-Logs in derselben Tagesdatei
//! (`YYYY-MM-DD.log`), filterbar ueber das `logLevel`-Setting.
//!
//! Filtering passiert serverseitig im `tracing`-Subscriber — das
//! Frontend macht keine eigene Vorab-Filterung, weil ein
//! Sub-Microsekunden-IPC-Roundtrip pro Event vertretbar ist und die
//! Filter-Hoheit beim einen System (Setting + RUST_LOG) bleibt.
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
