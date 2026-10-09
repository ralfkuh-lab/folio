"""E2E: Smart-List-Fortsetzung im Markdown-Editor (ohne Screenshot).

Synthetische Tasten erreichen Monaco nicht (docs/e2e-headless-caveats.md
Abschnitt 3); die Enter-Action wird daher per `/eval` direkt ueber
`editor.trigger('e2e', 'folio.markdown.continueList', null)` ausgeloest.
Der Haupteditor wird ueber die vorhandene `window.monaco`-API gefunden
(Editor, dessen Container in `#editor-mount` haengt) — kein eigener Hook.
Fixture ist eine temporaere Datei, nichts wird gespeichert.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import time
from pathlib import Path

WORKDIR = Path(tempfile.gettempdir()) / "folio-e2e-smartlist"
DOC = WORKDIR / "liste.md"

ACTION_ID = "folio.markdown.continueList"


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
    return ctx.api.editor_text_get().get("text") or ""


def _wait_text(ctx, expected: str, timeout_s: float = 4.0) -> str:
    last = ""

    def hit():
        nonlocal last
        last = _text(ctx)
        return last == expected

    _poll(hit, timeout=timeout_s)
    return last


def _press_enter_at(ctx, offset: int) -> str:
    """Cursor auf `offset` setzen und die Smart-List-Action ausloesen."""
    js = (
        "(() => {"
        "const host = document.getElementById('editor-mount');"
        "const eds = (window.monaco && window.monaco.editor"
        " && window.monaco.editor.getEditors) ? window.monaco.editor.getEditors() : [];"
        "const ed = eds.find(e => host && host.contains(e.getContainerDomNode()));"
        "if (!ed) return 'no-editor';"
        "const m = ed.getModel();"
        f"ed.setPosition(m.getPositionAt({offset}));"
        f"ed.trigger('e2e', {json.dumps(ACTION_ID)}, null);"
        "return m.getLanguageId();"
        "})()"
    )
    return ctx.api.eval(js).get("value") or ""


def _enter_case(ctx, before: str, offset: int, expected: str) -> None:
    ctx.api.editor_text_set(before)
    got = _wait_text(ctx, before)
    ctx.expect(got == before, f"editor_text_set nicht angekommen: {got!r}")
    lang = _press_enter_at(ctx, offset)
    ctx.expect(lang == "markdown", f"Haupteditor/Sprache unerwartet: {lang!r}")
    got = _wait_text(ctx, expected)
    ctx.expect(got == expected, f"nach Enter: erwartet {expected!r}, bekommen {got!r}")


def _undo_once(ctx, expected: str) -> None:
    ctx.api.editor_command("undo")
    got = _wait_text(ctx, expected)
    ctx.expect(got == expected, f"nach Undo: erwartet {expected!r}, bekommen {got!r}")


def run(ctx):
    try:
        shutil.rmtree(WORKDIR, ignore_errors=True)
        WORKDIR.mkdir(parents=True)
        DOC.write_text("start\n", encoding="utf-8", newline="\n")

        with ctx.step("Markdown-Datei oeffnen + Edit-Mode"):
            ctx.api.tabs_close_all()
            ctx.api.open(str(DOC), discard=True)
            ctx.api.mode("edit")
            ctx.expect_event("editor.ready", timeout_ms=10000)
            ctx.expect(
                _wait_text(ctx, "start\n") == "start\n",
                f"Fixture nicht im Editor: {_text(ctx)!r}",
            )

        with ctx.step("Bullet-Fortsetzung, ein Undo stellt den Zustand vor Enter her"):
            _enter_case(ctx, "- foo", 5, "- foo\n- ")
            _undo_once(ctx, "- foo")

        with ctx.step("Nummerierung 1. -> 2."):
            _enter_case(ctx, "1. foo", 6, "1. foo\n2. ")

        with ctx.step("Task [x] -> [ ]"):
            _enter_case(ctx, "- [x] erledigt", 14, "- [x] erledigt\n- [ ] ")

        with ctx.step("Leeres Item beendet die Liste (ein Undo-Schritt)"):
            _enter_case(ctx, "- foo\n- ", 8, "- foo\n")
            _undo_once(ctx, "- foo\n- ")

        with ctx.step("Keine Liste: Standard-Enter"):
            _enter_case(ctx, "foo", 3, "foo\n")

        with ctx.step("In Code-Fence: Standard-Enter"):
            _enter_case(ctx, "```\n- a", 7, "```\n- a\n")

    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        shutil.rmtree(WORKDIR, ignore_errors=True)
