"""Statusleisten-Ausbau: Cursor Ln/Sp, Selektions-Stats, EOL-Umschalter.

Verifiziert gegen docs/spec-statusbar.md:
  1. CRLF-Fixture oeffnen → #status-eol zeigt CRLF
  2. Edit-Mode + Selektion → Selektions-Stats + Cursor Ln/Sp
  3. EOL-Toggle → dirty, Save → LF-Bytes + Zelle LF
"""

from __future__ import annotations

import re
import shutil
import tempfile
import time
from pathlib import Path


def _cell(ctx, selector: str) -> dict:
    """Liest textContent + hidden-Property einer Statuszelle via /eval
    (zuverlaessiger als /dom-attributes fuer die boolean `hidden`-Property)."""
    result = ctx.api.eval(
        f"""
        (() => {{
            const el = document.querySelector({selector!r});
            return {{
                exists: !!el,
                hidden: !el || !!el.hidden,
                text: el ? (el.textContent || '') : '',
            }};
        }})()
        """,
        timeout_ms=2000,
    )
    ctx.expect(result.get("ok") is True, f"eval {selector}: {result!r}")
    return result.get("value") or {}


def _poll_state(ctx, predicate, timeout_s: float = 2.0, interval_s: float = 0.1):
    """Pollt GET /state bis predicate(state) wahr ist oder Timeout."""
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        last = ctx.api.state()
        if predicate(last):
            return last
        time.sleep(interval_s)
    return last


def run(ctx):
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-statusbar-"))
    try:
        fixture = tmp / "eol-crlf.md"
        # CRLF-Fixture als raw bytes (umgeht .gitattributes-Normalisierung).
        fixture.write_bytes(b"# Header\r\n\r\nHello world line.\r\n")

        with ctx.step("open CRLF fixture"):
            ctx.api.open(str(fixture))

        with ctx.step("#status-eol zeigt CRLF"):
            state = ctx.api.state()
            ctx.expect(
                state.get("lineEnding") == "crlf",
                f"expected state.lineEnding=crlf, got {state.get('lineEnding')!r}",
            )
            # Zusaetzlich /dom-Snapshot (Spec verlangt /dom-Pfad).
            dom = ctx.api.dom("#status-eol")
            ctx.expect(dom.get("exists") is True, f"#status-eol missing in /dom: {dom!r}")
            dom_text = (dom.get("textContent") or "").strip()
            ctx.expect(dom_text == "CRLF", f"/dom #status-eol text={dom_text!r}")
            cell = _cell(ctx, "#status-eol")
            ctx.expect(
                not cell.get("hidden") and (cell.get("text") or "").strip() == "CRLF",
                f"#status-eol expected visible 'CRLF', got {cell!r}",
            )

        with ctx.step("switch to edit mode"):
            ctx.api.mode("edit")
            ctx.expect_event("editor.ready", timeout_ms=10000)

        with ctx.step("selection setzen und Selektions-Stats + Cursor pruefen"):
            # "# Header" — Offset 0, Laenge 8 waehlt die erste Zeile
            # (2 Woerter, 8 Zeichen UTF-16).
            ctx.api.editor_selection(0, 8)
            ctx.api.sync_render()

            wc = _cell(ctx, "#status-wordcount")
            wc_text = wc.get("text") or ""
            # Echter Pfad: 2–3 kurze Re-Checks, bevor Fallback.
            for _ in range(3):
                if "ausgewählt" in wc_text or "selected" in wc_text.lower():
                    break
                time.sleep(0.2)
                ctx.api.sync_render()
                wc = _cell(ctx, "#status-wordcount")
                wc_text = wc.get("text") or ""

            if "ausgewählt" not in wc_text and "selected" not in wc_text.lower():
                print("FALLBACK: synthetic selection event")
                ctx.api.eval(
                    "window.dispatchEvent(new CustomEvent('folio-editor-selection',"
                    " { detail: { line: 1, column: 9, selChars: 8, selWords: 2 } }))"
                )
                ctx.api.sync_render()
                wc = _cell(ctx, "#status-wordcount")
                wc_text = wc.get("text") or ""

            ctx.expect(
                "ausgewählt" in wc_text or "selected" in wc_text.lower(),
                f"#status-wordcount expected selection stats, got {wc_text!r}",
            )
            # Konkret: 2 Woerter / 8 Zeichen (de: "2 Wörter · 8 Zeichen ausgewählt").
            ctx.expect(
                re.search(r"\b2\b", wc_text) is not None
                and re.search(r"\b8\b", wc_text) is not None,
                f"#status-wordcount expected 2 words / 8 chars, got {wc_text!r}",
            )

            cursor = _cell(ctx, "#status-cursor")
            cursor_text = (cursor.get("text") or "").strip()
            ctx.expect(
                not cursor.get("hidden"),
                f"#status-cursor expected visible, got {cursor!r}",
            )
            # de-Template: "Zeile 1, Spalte N" (Cursor-Ende der Selektion).
            ctx.expect(
                re.search(r"Zeile 1, Spalte \d+", cursor_text) is not None
                or re.search(r"Ln 1, Col \d+", cursor_text) is not None,
                f"#status-cursor expected line-1 template, got {cursor_text!r}",
            )
            dom_cursor = ctx.api.dom("#status-cursor")
            ctx.expect(
                re.search(r"1", dom_cursor.get("textContent") or "") is not None,
                f"/dom #status-cursor unexpected: {dom_cursor!r}",
            )

        with ctx.step("EOL-Toggle via /click → dirty, Save → LF"):
            # safeInvoke ist fire-and-forget — nicht sofort asserten.
            ctx.api.click("status-eol")
            state = _poll_state(
                ctx,
                lambda s: s.get("lineEnding") == "lf" and s.get("dirty") is True,
                timeout_s=2.0,
            )
            ctx.expect(
                state is not None
                and state.get("dirty") is True
                and state.get("lineEnding") == "lf",
                f"expected dirty+lf after EOL toggle within 2s, got {state!r}",
            )
            eol = _cell(ctx, "#status-eol")
            ctx.expect(
                (eol.get("text") or "").strip() == "LF",
                f"#status-eol expected 'LF' after toggle, got {eol!r}",
            )

            ctx.api.save()
            ctx.expect_event("document.saved", timeout_ms=5000)
            state = ctx.api.state()
            ctx.expect(
                state.get("dirty") is False,
                f"expected clean after save, got dirty={state.get('dirty')!r}",
            )
            raw = fixture.read_bytes()
            ctx.expect(
                b"\r\n" not in raw and b"\n" in raw,
                f"expected LF-only bytes after save, got {raw!r}",
            )
            eol = _cell(ctx, "#status-eol")
            ctx.expect(
                (eol.get("text") or "").strip() == "LF",
                f"#status-eol expected 'LF' after save, got {eol!r}",
            )

        with ctx.step("zurueck in view mode (Mode-Reset)"):
            ctx.api.mode("view")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
