"""E2E: Pfad-Identität — dieselbe Datei bekommt nur EINEN Tab.

Deckt den Kern des Fixes: eine Datei, die über ein Symlink-Verzeichnis UND
über den echten Pfad erreichbar ist, darf nicht zwei Tabs mit je eigenem
Puffer erzeugen. Geprüft werden beide Reihenfolgen (erst echt, dann Symlink
und umgekehrt) sowie der Replace-Open-Pfad `/open`, der über
`focus_existing_tab` denselben Vergleich benutzt.

Gegenprobe zum Nicht-Ziel der Spec: der angezeigte/persistierte Pfad bleibt
die Schreibweise, mit der geöffnet wurde — kanonisiert wird nur der
Vergleichsschlüssel, nie der Pfad selbst.

Fixture auf festem Temp-Pfad, weil der Pfad in Statusleiste und `/state`
sichtbar ist (wie 56/57/59/61). Kein Screenshot: das Szenario prüft
ausschließlich Backend-State, kein neues Bild-Baseline-Material nötig.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

ROOT_DIR = Path(tempfile.gettempdir()) / "folio-e2e-symlink"

CONTENT = "# Notiz\n\nEine Datei, zwei Pfade.\n"


def _norm(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def _setup_fixture() -> tuple[Path, Path]:
    """`real/notiz.md` plus Symlink-Verzeichnis `link` → `real`."""
    shutil.rmtree(ROOT_DIR, ignore_errors=True)
    ROOT_DIR.mkdir(parents=True)
    real = ROOT_DIR / "real"
    real.mkdir()
    (real / "notiz.md").write_text(CONTENT, encoding="utf-8")
    link = ROOT_DIR / "link"
    os.symlink(real, link, target_is_directory=True)
    return real / "notiz.md", link / "notiz.md"


def _doc_tabs(ctx) -> list[dict]:
    """Nur dokumenttragende Tabs — der leere Container zählt nicht."""
    return [tab for tab in (ctx.api.tabs().get("tabs") or []) if tab.get("path")]


def _expect_single_tab(ctx, label: str) -> dict:
    tabs = _doc_tabs(ctx)
    ctx.expect(len(tabs) == 1, f"{label}: erwartet 1 Dokument-Tab, bekam {tabs!r}")
    tab = tabs[0]
    ctx.expect(tab.get("active") is True, f"{label}: Tab ist nicht aktiv: {tab!r}")
    return tab


def run(ctx):
    try:
        with ctx.step("Fixture mit Symlink-Verzeichnis anlegen"):
            real, link = _setup_fixture()
            ctx.expect(
                _norm(real) != _norm(link),
                f"Fixture taugt nicht: beide Pfade sind gleich ({_norm(real)})",
            )
            ctx.api.tabs_close_all()
            ctx.api.mode("view")

        with ctx.step("Erst echter Pfad, dann Symlink-Pfad → ein Tab"):
            ctx.api.tab_open(_norm(real))
            first = _expect_single_tab(ctx, "nach dem echten Pfad")
            ctx.expect(
                _norm(first.get("path")) == _norm(real),
                f"Tab-Pfad wurde umgeschrieben: {first.get('path')!r} != {_norm(real)}",
            )

            ctx.api.tab_open(_norm(link))
            second = _expect_single_tab(ctx, "nach dem Symlink-Pfad")
            ctx.expect(
                second.get("id") == first.get("id"),
                f"neuer Tab statt Aktivierung: {second!r} vs. {first!r}",
            )
            ctx.expect(
                _norm(second.get("path")) == _norm(real),
                f"Pfad des bestehenden Tabs wurde ersetzt: {second.get('path')!r}",
            )

        with ctx.step("Replace-Open (/open) über den Symlink-Pfad → ein Tab"):
            # `/open` ist Replace-Semantik: es laedt im aktiven Tab neu und
            # setzt dabei die uebergebene Schreibweise. Entscheidend ist, dass
            # KEIN zweiter Tab entsteht (focus_existing_tab vergleicht ueber
            # die Datei-Identitaet).
            ctx.api.open(_norm(link), discard=True)
            tab = _expect_single_tab(ctx, "nach /open über den Symlink")
            ctx.expect(
                _norm(tab.get("path")) in (_norm(real), _norm(link)),
                f"/open zeigt auf eine fremde Datei: {tab.get('path')!r}",
            )

        with ctx.step("Umgekehrte Reihenfolge: erst Symlink, dann echter Pfad"):
            ctx.api.tabs_close_all()
            ctx.api.tab_open(_norm(link))
            first = _expect_single_tab(ctx, "nach dem Symlink-Pfad")
            # Der Pfad bleibt die Schreibweise, mit der geoeffnet wurde —
            # es wird ausschliesslich der Vergleichsschluessel kanonisiert.
            ctx.expect(
                _norm(first.get("path")) == _norm(link),
                f"Symlink-Pfad wurde aufgeloest: {first.get('path')!r} != {_norm(link)}",
            )
            state = ctx.api.state()
            ctx.expect(
                _norm(state.get("file") or "") == _norm(link),
                f"/state.file wurde aufgeloest: {state.get('file')!r}",
            )

            ctx.api.tab_open(_norm(real))
            second = _expect_single_tab(ctx, "nach dem echten Pfad")
            ctx.expect(
                second.get("id") == first.get("id"),
                f"neuer Tab statt Aktivierung: {second!r} vs. {first!r}",
            )
            ctx.expect(
                _norm(second.get("path")) == _norm(link),
                f"Pfad des bestehenden Tabs wurde ersetzt: {second.get('path')!r}",
            )

        with ctx.step("Andere Datei bekommt weiterhin einen eigenen Tab"):
            other = ROOT_DIR / "real" / "zweite.md"
            other.write_text("# Zweite\n", encoding="utf-8")
            ctx.api.tab_open(_norm(other))
            tabs = _doc_tabs(ctx)
            ctx.expect(
                len(tabs) == 2,
                f"zweite Datei wurde faelschlich dedupliziert: {tabs!r}",
            )

    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        shutil.rmtree(ROOT_DIR, ignore_errors=True)
