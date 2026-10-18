"""E2E: Bearbeiten → Tabellen formatieren (Spec T1, ohne Screenshot).

Fixture `table-format.md` enthaelt die unformatierte Tabelle aus
Referenzfall A und eine Tabelle in einem Code-Fence, die unveraendert
bleiben muss. Ausgeloest wird ueber `/menu/click edit.format_tables`
(gleicher Pfad wie Menue und Command Palette → `menu:edit_format_tables`
→ `FolioEditor.formatDocument()` → Monacos `editor.action.formatDocument`
→ Formatting-Provider aus `editor/events.ts`). Der Editortext wird per
`/eval` gelesen; ein Undo muss das Original in EINEM Schritt
wiederherstellen. Die Fixture wird in ein Temp-Verzeichnis kopiert,
nichts wird gespeichert.
"""

from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

WORKDIR = Path(tempfile.gettempdir()) / "folio-e2e-tableformat"
DOC = WORKDIR / "tabelle.md"

UNFORMATTED = (
    "| Name | Wert | Notiz |\n"
    "|:--|--:|:-:|\n"
    "| Alpha | 1 | erste Zeile |\n"
    "| B | 1000 | x |\n"
)
FORMATTED = (
    "| Name  | Wert |    Notiz    |\n"
    "| :---- | ---: | :---------: |\n"
    "| Alpha |    1 | erste Zeile |\n"
    "| B     | 1000 |      x      |\n"
)


def _poll(fn, timeout: float = 5.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _text(ctx) -> str:
    js = (
        "(() => window.FolioEditor && typeof window.FolioEditor.getText === 'function'"
        " ? window.FolioEditor.getText() : null)()"
    )
    return ctx.api.eval(js).get("value") or ""


def _wait_text(ctx, expected: str, timeout_s: float = 5.0) -> str:
    last = ""

    def hit():
        nonlocal last
        last = _text(ctx)
        return last == expected

    _poll(hit, timeout=timeout_s)
    return last


def run(ctx):
    original = Path(ctx.fixture("table-format.md")).read_text(encoding="utf-8")
    assert UNFORMATTED in original, "Fixture enthaelt Referenzfall A nicht"
    expected = original.replace(UNFORMATTED, FORMATTED)
    try:
        shutil.rmtree(WORKDIR, ignore_errors=True)
        WORKDIR.mkdir(parents=True)
        DOC.write_text(original, encoding="utf-8", newline="\n")

        with ctx.step("Markdown-Datei oeffnen + Edit-Mode"):
            ctx.api.tabs_close_all()
            ctx.api.open(str(DOC), discard=True)
            ctx.api.mode("edit")
            ctx.expect_event("editor.ready", timeout_ms=10000)
            got = _wait_text(ctx, original)
            ctx.expect(got == original, f"Fixture nicht im Editor: {got!r}")

        with ctx.step("/menu/click edit.format_tables → Tabelle A formatiert, Fence unveraendert"):
            ctx.api.menu_click("edit.format_tables")
            got = _wait_text(ctx, expected)
            ctx.expect(got == expected, f"nach Formatieren: erwartet {expected!r}, bekommen {got!r}")

        with ctx.step("Erneut formatieren → keine Aenderung"):
            ctx.api.menu_click("edit.format_tables")
            time.sleep(0.5)
            got = _text(ctx)
            ctx.expect(got == expected, f"zweiter Lauf hat geaendert: {got!r}")

        with ctx.step("Ein Undo stellt das Original wieder her"):
            ctx.api.editor_command("undo")
            got = _wait_text(ctx, original)
            ctx.expect(got == original, f"nach Undo: erwartet {original!r}, bekommen {got!r}")

    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        shutil.rmtree(WORKDIR, ignore_errors=True)
