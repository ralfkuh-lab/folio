use std::process::Command;

fn main() {
    // Git-Hash (kurz) als compile-time env exposen. Fehlt Git oder die
    // Working Tree-Info, bleibt das Feld leer — der About-Dialog faellt
    // dann auf "—" zurueck, kein Build-Fehler.
    let git_hash = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=FOLIO_GIT_HASH={git_hash}");

    // Build-Datum (UTC, ISO-Date). Reiner Helper, keine externe Dep —
    // chrono ist im Workspace nicht vorhanden.
    let build_date = build_date_utc();
    println!("cargo:rustc-env=FOLIO_BUILD_DATE={build_date}");

    // Re-build triggern, wenn sich HEAD bewegt — sonst friert der Hash
    // im inkrementellen Cache ein.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");

    tauri_build::build();
}

fn build_date_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day) = ymd_from_unix_seconds(secs as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Konvertiert Unix-Sekunden (UTC) in `(year, month, day)`. Reine
/// Datums-Komponenten reichen fuer den About-Dialog — keine Uhrzeit,
/// keine Zeitzone, daher auch kein chrono-Crate noetig. Algorithmus
/// nach Howard Hinnant's "date" — robust ueber Jahrhunderte.
fn ymd_from_unix_seconds(secs: i64) -> (i32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}
