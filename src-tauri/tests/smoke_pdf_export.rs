//! Smoke-Test für den PDF-Export.
//!
//! Generiert ein kleines HTML und ruft `pdf_export::render_pdf` auf.
//! Wenn auf dem Test-System kein Chromium-Browser gefunden wird, wird
//! der Test übersprungen (kein Fehler) — CI ohne Chrome bleibt grün.

use folio_lib::{export, pdf_export};
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
    assert!(
        size > 1000,
        "PDF zu klein ({size} bytes), wahrscheinlich kaputt"
    );
    // PDF-Header prüfen: %PDF-
    let header = fs::read(&target).expect("read pdf");
    assert!(header.starts_with(b"%PDF-"), "Kein PDF-Header");
}

#[test]
fn renders_long_code_lines_pdf_in_all_layouts() {
    // Stellt sicher dass lange Code-Zeilen im PDF wrappen statt eine
    // Scrollbar zu produzieren (kein automatischer Pixel-Check, aber
    // verifiziert dass der Render-Pfad mit dem korrigierten white-space
    // durchläuft).
    if pdf_export::find_chromium().is_none() {
        return;
    }

    let temp = tempfile::tempdir().expect("temp dir");
    let markdown = "# Code\n\n```\nikaros.EmailDispatchTemplate                       (1)  -- Designation, Sender, MessageType, Spooler, AnotherLongIdentifierThatShouldWrap\nikaros.EmailDispatchTemplateLocalisation        (n)  -- (TemplateId, Language, Subject, Body), PK = (TemplateId, Language)\n```\n";

    for layout in &["classic", "clean", "github"] {
        let target = temp.path().join(format!("code-{layout}.pdf"));
        let html = export::render_document(layout, "Code", markdown).expect("render html");
        pdf_export::render_pdf(&html, Some(temp.path()), &target).expect("render pdf");
        assert!(target.exists(), "{layout}: PDF nicht erzeugt");
    }
}

#[test]
fn renders_wide_table_pdf_in_all_layouts() {
    if pdf_export::find_chromium().is_none() {
        eprintln!("Skipping: kein Chromium-Browser auf diesem System gefunden.");
        return;
    }

    let temp = tempfile::tempdir().expect("temp dir");

    // Tabelle mit vielen Spalten und langen Werten — würde ohne Overflow-Fix
    // über die A4-Breite hinausgehen.
    let markdown = "# Tabellen-Test\n\n\
        | SpalteEinsLang | SpalteZweiLang | SpalteDreiLang | SpalteVierLang | SpalteFunfLang | SpalteSechsLang |\n\
        |----------------|----------------|----------------|----------------|----------------|-----------------|\n\
        | langerWertOhneLeerzeichen | abcdefghijklmnopqrstuvwxyz | x | x | x | x |\n\
        | y | y | y | y | y | y |\n";

    for layout in &["classic", "clean", "github"] {
        let target = temp.path().join(format!("table-{layout}.pdf"));
        let html = export::render_document(layout, "Tabellen-Test", markdown).expect("render html");
        pdf_export::render_pdf(&html, Some(temp.path()), &target).expect("render pdf");
        assert!(target.exists(), "{layout}: PDF nicht erzeugt");
        let size = fs::metadata(&target).expect("metadata").len();
        assert!(size > 1000, "{layout}: PDF zu klein ({size} bytes)");
    }
}
