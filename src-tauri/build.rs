use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "src/i18n/catalog.rs"]
mod catalog;

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

    // i18n registry codegen (fail closed)
    let locales = Path::new("locales");
    println!("cargo:rerun-if-changed=locales");
    if locales.is_dir() {
        if let Ok(rd) = fs::read_dir(locales) {
            for ent in rd.flatten() {
                let p = ent.path();
                if p.extension().and_then(|e| e.to_str()) == Some("json") {
                    println!("cargo:rerun-if-changed={}", p.display());
                }
            }
        }
    }
    match catalog::generate_registry(locales) {
        Ok(gen) => {
            let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
            let out = out_dir.join("i18n_registry.rs");
            fs::write(&out, gen.rust_source).expect("write i18n_registry.rs");
        }
        Err(e) => {
            panic!("i18n catalog generation failed: {e}");
        }
    }

    emit_test_manifest_link_args();

    tauri_build::build();
}

/// Bettet unter Windows/MSVC ein Common-Controls-6.0-Manifest in die
/// Test-Binaries ein. Ohne dieses Manifest laedt Windows nur comctl32
/// v5, in der `TaskDialogIndirect` fehlt — die Dialog-Dependency-Kette
/// (rfd/tauri-plugin-dialog) importiert das Symbol aber statisch, sodass
/// der Loader das Test-Binary mit `STATUS_ENTRYPOINT_NOT_FOUND`
/// (0xc0000139) killt, bevor ein einziger Test laeuft. Das echte
/// `folio.exe` bekommt sein Manifest von tauri-build (embed-resource,
/// wirkt nur auf bins); Test-Binaries gehen sonst leer aus.
///
/// Zielgenauigkeit ist hier heikel: das von `cargo test --lib` gelinkte
/// Unit-Test-Binary ist das LIB-Target im Test-Modus — `rustc-link-arg-tests`
/// erreicht es NICHT (das greift nur bei echten Integrationstest-Targets in
/// `tests/`, verifiziert). Nur das ungetypte `rustc-link-arg` erreicht auch
/// das Lib-Unit-Test-Binary — es faellt aber ebenso auf das `folio`-bin, und
/// dort waere ein zweites, vom Linker erzeugtes RT_MANIFEST neben Tauris
/// eingebettetem Manifest ein `CVT1100 duplicate resource`-Fehler. Deshalb:
/// `/MANIFEST:EMBED` + `/MANIFESTDEPENDENCY` global fuer alle gelinkten
/// Targets, und fuer das `folio`-bin gezielt `/MANIFEST:NO` obendrauf — das
/// unterdrueckt dort die Linker-Manifest-Generierung, sodass allein Tauris
/// Manifest (das Common-Controls v6 bereits enthaelt) im bin bleibt. Globale
/// rustflags in `.cargo/config.toml` scheiden aus demselben Grund aus: sie
/// wuerden das bin ungeschuetzt treffen.
///
/// build.rs laeuft auf dem Host, daher pruefen wir das Ziel-Triple ueber
/// die von Cargo gesetzten `CARGO_CFG_TARGET_*`-Variablen statt ueber das
/// `cfg!`-Makro des Host-Builds.
fn emit_test_manifest_link_args() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         publicKeyToken='6595b64144ccf1df' language='*' \
         processorArchitecture='*'"
    );
    println!("cargo:rustc-link-arg-bin=folio=/MANIFEST:NO");
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
