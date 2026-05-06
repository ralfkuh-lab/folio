//! Smoke-Test für den PDF-Export.
//!
//! Generiert ein kleines HTML und ruft `pdf_export::render_pdf` auf.
//! Wenn auf dem Test-System kein Chromium-Browser gefunden wird, wird
//! der Test übersprungen (kein Fehler) — CI ohne Chrome bleibt grün.

use folio_rs::{export, pdf_export};
use std::fs;

#[test]
fn renders_simple_pdf_via_headless_chromium() {
    if pdf_export::find_chromium().is_none() {
        eprintln!("Skipping: kein Chromium-Browser auf diesem System gefunden.");
        return;
    }

    let temp = tempfile::tempdir().expect("temp dir");
    let target = temp.path().join("smoke.pdf");

    let markdown = "# Hallo Folio\n\nDies ist ein **Smoke-Test** für den PDF-Export.\n\n- Liste\n- Mit Punkten\n";
    let html = export::render_document("clean", "Smoke", markdown).expect("render html");

    pdf_export::render_pdf(&html, Some(temp.path()), &target).expect("render pdf");

    assert!(target.exists(), "PDF-Datei wurde nicht erzeugt");
    let size = fs::metadata(&target).expect("metadata").len();
    assert!(size > 1000, "PDF zu klein ({size} bytes), wahrscheinlich kaputt");
    // PDF-Header prüfen: %PDF-
    let header = fs::read(&target).expect("read pdf");
    assert!(header.starts_with(b"%PDF-"), "Kein PDF-Header");
}
