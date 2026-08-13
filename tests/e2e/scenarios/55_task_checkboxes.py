"""E2E Tasklist-Checkboxen (Etappe 1b): Klicks in View- und Split-Mode.

Testet das interaktive Umschalten von Markdown-Tasklisten (- [ ] / - [x])
in der gerenderten View und Split-Preview im echten WebView-DOM.
"""

from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path


def _norm(path: str) -> str:
    return path.replace("\\", "/")


def _evalv(ctx, js: str, timeout_ms: int = 3000):
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(fn, timeout: float = 5.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _wait_preview_settled(ctx, timeout: float = 3.0):
    """Wartet, bis die debouncte Preview die aktuelle VersionId gerendert hat."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        is_synced = _evalv(
            ctx,
            """(() => {
                const el = document.getElementById('view-content') || document.getElementById('view-region');
                const renderVer = el ? el.getAttribute('data-render-version') : null;
                const editorVer = window.FolioEditor && typeof window.FolioEditor.getVersionId === 'function'
                    ? window.FolioEditor.getVersionId()
                    : null;
                if (renderVer == null || editorVer == null) return false;
                return String(renderVer) === String(editorVer);
            })()""",
        )
        if is_synced is True:
            return True
        time.sleep(0.05)
    return False


def run(ctx):
    src = Path(ctx.fixture("tasklist.md"))
    tmp_dir = Path(tempfile.mkdtemp(prefix="folio-e2e-tasklist-"))
    tmp_file = tmp_dir / "tasklist.md"
    shutil.copy2(src, tmp_file)
    fpath = str(tmp_file)

    try:
        with ctx.step("Fixture tasklist.md oeffnen (View-Mode)"):
            ctx.api.tabs_close_all()
            ctx.api.open(fpath, discard=True)
            try:
                ctx.api.wait("document.loaded", timeout_ms=8000)
            except Exception:
                pass

            opened = _poll(
                lambda: _norm((ctx.api.state().get("file") or "")) == _norm(fpath),
                timeout=5.0,
            )
            ctx.expect(bool(opened), f"tasklist.md nicht geoeffnet: file={ctx.api.state().get('file')!r}")

            ctx.api.mode("view")
            ctx.api.sync_render()

            initial_text = (ctx.api.editor_text_get() or {}).get("text", "")
            ctx.expect(
                "- [ ] Erste offene Aufgabe" in initial_text,
                f"Initialtext enthaelt nicht offene Aufgabe: {initial_text!r}",
            )
            ctx.expect(
                "- [x] Bereits erledigte Aufgabe" in initial_text,
                f"Initialtext enthaelt nicht erledigte Aufgabe: {initial_text!r}",
            )
            ctx.expect(
                _wait_preview_settled(ctx),
                "Preview nach Initial-Load nicht synchron mit Editor-Version",
            )

        with ctx.step("View-Mode: Klick auf unchecked Checkbox schaltet Quelltext auf [x]"):
            # Line 3 ist "- [ ] Erste offene Aufgabe"
            sel = '.markdown-body li.task-list-item[data-line="3"] input[type="checkbox"]'
            ctx.api.click(sel)

            updated = _poll(
                lambda: (
                    t
                    if "- [x] Erste offene Aufgabe" in (t := (ctx.api.editor_text_get() or {}).get("text", ""))
                    else None
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(updated),
                f"Quelltext nach Klick auf Box 1 enthaelt kein [x]: got {ctx.api.editor_text_get()!r}",
            )
            # Warten, bis der nachlaufende Preview-Re-Render durch ist
            ctx.expect(_wait_preview_settled(ctx), "Preview nach Step 1 nicht synchron")

        with ctx.step("Rueckrichtung: Klick auf checked Checkbox schaltet Quelltext auf [ ]"):
            # Line 4 ist "- [x] Bereits erledigte Aufgabe"
            sel = '.markdown-body li.task-list-item[data-line="4"] input[type="checkbox"]'
            ctx.api.click(sel)

            updated = _poll(
                lambda: (
                    t
                    if "- [ ] Bereits erledigte Aufgabe" in (t := (ctx.api.editor_text_get() or {}).get("text", ""))
                    else None
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(updated),
                f"Quelltext nach Klick auf Box 2 enthaelt kein [ ]: got {ctx.api.editor_text_get()!r}",
            )
            ctx.expect(_wait_preview_settled(ctx), "Preview nach Step 2 nicht synchron")

        with ctx.step("Split-Mode: Klick auf verschachteltes Child-Item togglet nur Kindzeile"):
            ctx.api.mode("split")
            ctx.api.sync_render()
            ctx.expect(_wait_preview_settled(ctx), "Preview nach Split-Switch nicht synchron")

            # Line 6 ist "  - [ ] Verschachtelte Unteraufgabe" unter Line 5 "- [ ] Elternaufgabe"
            sel = '.markdown-body li.task-list-item[data-line="6"] input[type="checkbox"]'
            ctx.api.click(sel)

            updated = _poll(
                lambda: (
                    t
                    if "  - [x] Verschachtelte Unteraufgabe" in (t := (ctx.api.editor_text_get() or {}).get("text", ""))
                    else None
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(updated),
                f"Quelltext nach Klick auf Child-Box enthaelt kein [x]: got {ctx.api.editor_text_get()!r}",
            )

            # Elternzeile Line 5 muss unveraendert unchecked bleiben
            full_text = (ctx.api.editor_text_get() or {}).get("text", "")
            ctx.expect(
                "- [ ] Elternaufgabe" in full_text,
                f"Elternzeile wurde faelschlicherweise veraendert: {full_text!r}",
            )
            ctx.expect(_wait_preview_settled(ctx), "Preview nach Step 3 nicht synchron")

        with ctx.step("Kein Fehlklick: Klick auf Item-Text/Inline-Code aendert Zustand nicht"):
            text_before = (ctx.api.editor_text_get() or {}).get("text", "")
            ctx.expect(
                "- [ ] Formatierte Aufgabe mit `inline_code` und **Fettschrift**" in text_before,
                "Line 7 Vorbedingung nicht erfuellt",
            )

            # Klick auf den Text / das <code>-Element statt der Checkbox
            ctx.api.click('.markdown-body li.task-list-item[data-line="7"] code')
            time.sleep(0.3)

            text_after = (ctx.api.editor_text_get() or {}).get("text", "")
            ctx.expect(
                text_after == text_before,
                f"Klick auf Text hat Dokument veraendert:\nVorher:\n{text_before}\nNachher:\n{text_after}",
            )

        with ctx.step("Klick auf Checkbox mit formatierter Zeile togglet sauber"):
            # Line 7 Checkbox
            sel = '.markdown-body li.task-list-item[data-line="7"] input[type="checkbox"]'
            ctx.api.click(sel)

            updated = _poll(
                lambda: (
                    t
                    if "- [x] Formatierte Aufgabe mit `inline_code` und **Fettschrift**"
                    in (t := (ctx.api.editor_text_get() or {}).get("text", ""))
                    else None
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(updated),
                f"Formatierte Zeile wurde nicht sauber getogglet: got {ctx.api.editor_text_get()!r}",
            )

        with ctx.step("Screenshot-Baseline task_checkboxes"):
            ctx.screenshot("task_checkboxes_view")

    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)
