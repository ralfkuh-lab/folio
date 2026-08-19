"""E2E: Hex-Ansicht fuer Binärdateien.

Deckt das Öffnen ohne Fehlerdialog, body.kind-binary, die erste Zeile
byteweise, den gesperrten Edit-Button, Tab-/History-Wechsel, externen
Truncate, den Save-Negativtest (Bytes bleiben unverändert) sowie die
Hex-Suche (Text, Hex-Bytes, Weiter, ungültige Eingabe).

Fixture auf festem Temp-Pfad, weil der Pfad in Statusleiste und Vault
sichtbar und damit Teil der Visual-Baseline ist (wie 56/57/59).
"""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path

from lib.api import ApiError

ROOT_DIR = Path(tempfile.gettempdir()) / "folio-e2e-hex"

# 16 Bytes: druckbar + NUL, damit die erste Hex-Zeile eindeutig ist.
SAMPLE = bytes(
    [
        0x46, 0x6F, 0x6C, 0x69, 0x6F, 0x00, 0x48, 0x45,
        0x58, 0x20, 0x76, 0x69, 0x65, 0x77, 0x21, 0x0A,
    ]
)
SAMPLE_ASCII = "Folio.HEX view!."
LARGE_SIZE = 6 * 1024 * 1024


def _norm(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(fn, timeout: float = 6.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _hex_state(ctx):
    return _evalv(ctx, "window.__folioHexViewState && window.__folioHexViewState()")


def _wait_hex(ctx, path: str | None = None, timeout: float = 6.0) -> dict:
    def ready():
        body = _evalv(
            ctx,
            "({ kind: document.body.classList.contains('kind-binary'), "
            "state: window.__folioHexViewState && window.__folioHexViewState() })",
        ) or {}
        state = body.get("state") or {}
        if not body.get("kind"):
            return None
        if state.get("status") not in ("ready", "empty"):
            return None
        if path and path not in (state.get("path") or "").replace("\\", "/"):
            return None
        if state.get("fileSize", 0) > 0 and not state.get("firstLine"):
            return None
        return state

    snap = _poll(ready, timeout=timeout)
    ctx.expect(bool(snap), f"Hex-Ansicht wurde nicht bereit: {_hex_state(ctx)!r}")
    return snap


def _counter(ctx) -> str:
    return _evalv(
        ctx,
        "(function(){var c=document.getElementById('find-counter');"
        "return c ? c.textContent : '';})()",
    ) or ""


def _counter_has(ctx, needle: str):
    text = _counter(ctx)
    return text if needle in text else None


def _click(ctx, element_id: str) -> None:
    clicked = _evalv(
        ctx,
        "(function(){var el=document.getElementById('" + element_id + "');"
        "if(!el)return false;el.click();return true;})()",
    )
    ctx.expect(clicked is True, f"#{element_id} fehlt")


def _set_find_mode(ctx, mode: str) -> None:
    button = "find-mode-hex" if mode == "hex" else "find-mode-text"
    _click(ctx, button)
    pressed = _poll(
        lambda: _evalv(
            ctx,
            "(function(){var b=document.getElementById('" + button + "');"
            "return b && b.getAttribute('aria-pressed');})()",
        ) == "true",
        timeout=3.0,
    )
    ctx.expect(bool(pressed), f"Suchmodus {mode} nicht aktiv")


def _goto_offset(ctx, value: str) -> None:
    """Offset über die Toolbar der Hex-Ansicht anspringen (Enter im Feld)."""
    ok = _evalv(
        ctx,
        "(function(){var i=document.getElementById('hex-view-goto');"
        "if(!i)return false;i.value='" + value + "';"
        "i.dispatchEvent(new KeyboardEvent('keydown',"
        "{key:'Enter',bubbles:true,cancelable:true}));return true;})()",
    )
    ctx.expect(ok is True, "Gehe-zu-Feld fehlt (Toolbar ausgeblendet?)")


def _setup_fixture() -> tuple[Path, Path, Path]:
    shutil.rmtree(ROOT_DIR, ignore_errors=True)
    ROOT_DIR.mkdir(parents=True)
    small = ROOT_DIR / "sample.bin"
    small.write_bytes(SAMPLE)
    large = ROOT_DIR / "large.bin"
    fd = os.open(large, os.O_CREAT | os.O_RDWR | os.O_TRUNC)
    try:
        os.ftruncate(fd, LARGE_SIZE)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, b"HEAD" + b"\x00" * 12)
    finally:
        os.close(fd)
    return ROOT_DIR, small, large


def run(ctx):
    pin = ""
    small = Path()
    large = Path()
    try:
        with ctx.step("Fixture anlegen und pinnen"):
            root, small, large = _setup_fixture()
            pin = _norm(root)
            ctx.api.tabs_close_all()
            ctx.api.mode("view")
            ctx.api.workspace_pin(str(root), is_directory=True)

        with ctx.step("Kleine Binärdatei öffnen ohne Fehlerdialog"):
            ctx.api.console_errors(clear=True)
            ctx.api.open(_norm(small), discard=True)
            ctx.api.mode("view")
            state = _wait_hex(ctx, _norm(small))
            snap = ctx.api.state()
            ctx.expect(snap.get("kind") == "binary", f"/state.kind nicht binary: {snap!r}")
            ctx.expect(
                snap.get("fileSize") == len(SAMPLE),
                f"/state.fileSize {snap.get('fileSize')!r} != {len(SAMPLE)}",
            )
            ctx.expect(snap.get("hex") is not None, f"/state.hex fehlt: {snap!r}")
            ctx.expect(
                state.get("firstLine", {}).get("ascii") == SAMPLE_ASCII,
                f"erste Zeile weicht ab: {state.get('firstLine')!r}",
            )
            errs = ctx.api.console_errors(clear=False)
            ctx.expect(
                errs.get("count", 0) == 0,
                f"Console-Fehler beim Öffnen: {errs.get('errors')}",
            )
            dialog = _evalv(
                ctx,
                "(function(){var d=document.getElementById('unsaved-dialog');"
                "return !d || d.hidden;})()",
            )
            ctx.expect(dialog is True, "Fehler-/Unsaved-Dialog nach dem Öffnen sichtbar")

        with ctx.step("Edit-Button ist disabled"):
            edit = _evalv(
                ctx,
                "(function(){var b=document.getElementById('tb-mode-edit');"
                "return {disabled: !b || b.disabled};})()",
            )
            ctx.expect(edit.get("disabled") is True, f"Edit nicht disabled: {edit!r}")
            view = _evalv(
                ctx,
                "(function(){var b=document.getElementById('tb-mode-view');"
                "return {disabled: !b || b.disabled};})()",
            )
            ctx.expect(view.get("disabled") is False, f"View disabled: {view!r}")

        with ctx.step("Screenshot-Baseline hex_view_small"):
            ctx.screenshot("hex_view_small")

        with ctx.step("Save ändert die Bytes nicht"):
            before = small.read_bytes()
            try:
                ctx.api.save()
            except ApiError:
                pass
            after = small.read_bytes()
            ctx.expect(after == before, f"Save hat Bytes verändert: {after!r} != {before!r}")
            ctx.expect(after == SAMPLE, f"Dateiinhalt nach Save falsch: {after!r}")

        with ctx.step("Tab-Wechsel erhält die Fensterposition"):
            ctx.api.tab_open(_norm(large))
            large_state = _wait_hex(ctx, _norm(large))
            ctx.expect(
                large_state.get("fileSize") == LARGE_SIZE,
                f"large.bin size {large_state.get('fileSize')!r}",
            )
            toolbar = _evalv(
                ctx,
                "(function(){var t=document.getElementById('hex-view-toolbar');"
                "var n=document.getElementById('hex-view-next');"
                "var p=document.getElementById('hex-view-prev');"
                "return {hidden: !t || t.hidden, nextDisabled: !n || n.disabled,"
                "prevDisabled: !p || p.disabled};})()",
            )
            ctx.expect(toolbar.get("hidden") is False, f"Nav-Leiste fehlt: {toolbar!r}")
            ctx.expect(toolbar.get("prevDisabled") is True, f"Prev nicht am Anfang disabled: {toolbar!r}")
            ctx.expect(toolbar.get("nextDisabled") is False, f"Next am Anfang disabled: {toolbar!r}")
            clicked = _evalv(
                ctx,
                "(function(){var n=document.getElementById('hex-view-next');"
                "if(!n)return false;n.click();return true;})()",
            )
            ctx.expect(clicked is True, "Next-Klick fehlgeschlagen")
            after_next = _poll(
                lambda: (s := _hex_state(ctx)) and s.get("windowStart", 0) > 0 and s,
                timeout=4.0,
            )
            ctx.expect(bool(after_next), f"Next verschob das Fenster nicht: {_hex_state(ctx)!r}")
            next_start = after_next.get("windowStart")
            hex_state = _poll(
                lambda: (s := ctx.api.state().get("hex") or {})
                and s.get("windowStart") == next_start
                and s,
                timeout=4.0,
            )
            ctx.expect(
                bool(hex_state) and hex_state.get("windowStart") not in (None, 0),
                f"/state.hex folgte dem Fenstersprung nicht: "
                f"state={ctx.api.state().get('hex')!r} hook={next_start!r}",
            )

            tabs = ctx.api.tabs().get("tabs") or []
            small_tab = next(
                (
                    t
                    for t in tabs
                    if _norm(t.get("path") or "").endswith("sample.bin")
                ),
                None,
            )
            ctx.expect(small_tab is not None, f"sample.bin-Tab fehlt: {tabs!r}")
            ctx.api.tab_activate(small_tab["id"])
            back_small = _wait_hex(ctx, _norm(small))
            ctx.expect(
                back_small.get("windowStart") == 0,
                f"sample.bin nicht bei Offset 0: {back_small!r}",
            )
            large_tab = next(
                (
                    t
                    for t in tabs
                    if _norm(t.get("path") or "").endswith("large.bin")
                ),
                None,
            )
            ctx.expect(large_tab is not None, f"large.bin-Tab fehlt: {tabs!r}")
            ctx.api.tab_activate(large_tab["id"])
            back_large = _wait_hex(ctx, _norm(large))
            ctx.expect(
                back_large.get("windowStart") == next_start,
                f"Tab-Restore verlor das Fenster: {back_large!r} expected {next_start}",
            )

        with ctx.step("History-Back kehrt zur Hex-Ansicht zurück"):
            sample_md = ctx.fixture("sample.md")
            ctx.api.open(sample_md, discard=True)
            md_ok = _poll(
                lambda: ctx.api.state().get("kind") == "markdown",
                timeout=4.0,
            )
            ctx.expect(bool(md_ok), f"sample.md nicht geladen: {ctx.api.state()!r}")
            moved = ctx.api.history_back()
            ctx.expect(moved.get("moved") is True, f"history_back: {moved!r}")
            hist = _wait_hex(ctx)
            ctx.expect(
                "large.bin" in _norm(hist.get("path") or "")
                or "sample.bin" in _norm(hist.get("path") or ""),
                f"History-Back landete nicht auf Hex: {hist!r}",
            )
            kind_body = _evalv(ctx, "document.body.classList.contains('kind-binary')")
            ctx.expect(kind_body is True, "History-Back ohne kind-binary")

        with ctx.step("Textsuche findet ein bekanntes Zeichen der Fixture"):
            ctx.api.open(_norm(small), discard=True)
            _wait_hex(ctx, _norm(small))
            ctx.api.find_text("o")

            def text_hit():
                snap = _evalv(
                    ctx,
                    "(function(){var c=document.getElementById('find-counter');"
                    "var hits=document.querySelectorAll('.hex-hit-active');"
                    "return {text: c && c.textContent, hits: hits.length};})()",
                ) or {}
                text = snap.get("text") or ""
                if "0x00000001" in text and snap.get("hits", 0) >= 2:
                    return snap
                return None

            hit = _poll(text_hit, timeout=4.0)
            ctx.expect(bool(hit), f"Textsuche fand 'o' nicht: {_evalv(ctx, 'document.getElementById(\"find-counter\") && document.getElementById(\"find-counter\").textContent')!r}")

        with ctx.step("Hex-Suche findet dieselbe Stelle über ihre Bytes"):
            switched = _evalv(
                ctx,
                "(function(){var b=document.getElementById('find-mode-hex');"
                "if(!b)return false;b.click();return true;})()",
            )
            ctx.expect(switched is True, "Hex-Modus-Button fehlt")
            ctx.api.find_text("6f")

            def hex_hit():
                snap = _evalv(
                    ctx,
                    "(function(){var c=document.getElementById('find-counter');"
                    "var mode=document.getElementById('find-mode-hex');"
                    "return {text: c && c.textContent,"
                    "pressed: mode && mode.getAttribute('aria-pressed')};})()",
                ) or {}
                if "0x00000001" in (snap.get("text") or "") and snap.get("pressed") == "true":
                    return snap
                return None

            hex_ok = _poll(hex_hit, timeout=4.0)
            ctx.expect(bool(hex_ok), f"Hex-Suche landete nicht bei 0x00000001: {hex_ok!r} counter={_evalv(ctx, 'document.getElementById(\"find-counter\") && document.getElementById(\"find-counter\").textContent')!r}")

        with ctx.step("Weiter springt zum zweiten Vorkommen"):
            clicked = _evalv(
                ctx,
                "(function(){var n=document.getElementById('find-next');"
                "if(!n)return false;n.click();return true;})()",
            )
            ctx.expect(clicked is True, "find-next fehlt")

            def second_hit():
                text = _evalv(
                    ctx,
                    "document.getElementById('find-counter') && document.getElementById('find-counter').textContent",
                ) or ""
                return "0x00000004" in text and text

            nxt = _poll(second_hit, timeout=4.0)
            ctx.expect(bool(nxt), f"Weiter sprang nicht zum zweiten 'o': {_evalv(ctx, 'document.getElementById(\"find-counter\") && document.getElementById(\"find-counter\").textContent')!r}")

        with ctx.step("Ungültige Hex-Eingabe zeigt den Fehler"):
            ctx.api.find_text("123")

            def invalid():
                snap = _evalv(
                    ctx,
                    "(function(){var i=document.getElementById('find-input');"
                    "var c=document.getElementById('find-counter');"
                    "return {invalid: i && i.classList.contains('find-input--invalid'),"
                    "counter: c && c.textContent,"
                    "counterInvalid: c && c.classList.contains('find-counter--invalid')};})()",
                ) or {}
                if snap.get("invalid") and snap.get("counterInvalid") and snap.get("counter"):
                    return snap
                return None

            bad = _poll(invalid, timeout=4.0)
            ctx.expect(bool(bad), f"Ungültige Hex-Eingabe ohne Fehlerzustand: {bad!r}")
            ctx.expect(
                "0/0" not in (bad.get("counter") or ""),
                f"Ungültige Hex-Eingabe als 0 Treffer: {bad!r}",
            )

        with ctx.step("Zurück findet den direkten Nachbar-Treffer"):
            # Eigene Fixture: das Sample hat keine zwei benachbarten gleichen
            # Bytes, genau die deckten den Rückwärts-Off-by-one aber auf
            # (`from` ist rückwärts die exklusive Obergrenze).
            pair = ROOT_DIR / "pair.bin"
            pair.write_bytes(bytes([0x41, 0x6F, 0x6F, 0x00]))
            _set_find_mode(ctx, "text")
            ctx.api.open(_norm(pair), discard=True)
            _wait_hex(ctx, _norm(pair))
            ctx.api.find_text("o")
            ctx.expect(
                bool(_poll(lambda: _counter_has(ctx, "0x00000001"), timeout=4.0)),
                f"Textsuche fand den ersten Nachbarn nicht: {_counter(ctx)!r}",
            )

            _click(ctx, "find-next")
            ctx.expect(
                bool(_poll(lambda: _counter_has(ctx, "0x00000002"), timeout=4.0)),
                f"Weiter sprang nicht auf den zweiten Nachbarn: {_counter(ctx)!r}",
            )

            _click(ctx, "find-prev")
            ctx.expect(
                bool(_poll(lambda: _counter_has(ctx, "0x00000001"), timeout=4.0)),
                f"Zurück übersprang den direkten Nachbarn: {_counter(ctx)!r}",
            )

        with ctx.step("Dokumentwechsel setzt die offene Suche auf das neue Dokument"):
            ctx.api.open(_norm(small), discard=True)
            _wait_hex(ctx, _norm(small))

            def switched_counter():
                snap = _evalv(
                    ctx,
                    "(function(){var c=document.getElementById('find-counter');"
                    "var hits=document.querySelectorAll('.hex-hit-active');"
                    "return {text: c && c.textContent, hits: hits.length};})()",
                ) or {}
                text = snap.get("text") or ""
                if "0x00000001" in text and snap.get("hits", 0) >= 2:
                    return snap
                return None

            moved = _poll(switched_counter, timeout=4.0)
            ctx.expect(
                bool(moved),
                f"Suche folgte dem Dokumentwechsel nicht: {_counter(ctx)!r}",
            )

        with ctx.step("Gehe-zu-Offset räumt die Fundstellen-Markierung auf"):
            ctx.api.open(_norm(large), discard=True)
            _wait_hex(ctx, _norm(large))
            ctx.api.find_text("HEAD")
            ctx.expect(
                bool(_poll(lambda: _counter_has(ctx, "0x00000000"), timeout=4.0)),
                f"Suche in large.bin fand HEAD nicht: {_counter(ctx)!r}",
            )
            marked = _poll(
                lambda: (_evalv(ctx, "document.querySelectorAll('.hex-hit-active').length") or 0) >= 8,
                timeout=4.0,
            )
            ctx.expect(bool(marked), "Treffer in large.bin wurde nicht markiert")

            _goto_offset(ctx, "0x100000")
            cleared = _poll(
                lambda: (_evalv(ctx, "document.querySelectorAll('.hex-hit-active').length") or 0) == 0
                or None,
                timeout=4.0,
            )
            ctx.expect(bool(cleared), "Markierung überlebte den Gehe-zu-Sprung")

            _goto_offset(ctx, "0x0")
            back = _poll(
                lambda: (_hex_state(ctx) or {}).get("windowStart") == 0 and _hex_state(ctx),
                timeout=4.0,
            )
            ctx.expect(bool(back), f"Rücksprung auf 0 misslang: {_hex_state(ctx)!r}")
            still_clear = _evalv(ctx, "document.querySelectorAll('.hex-hit-active').length")
            ctx.expect(
                still_clear == 0,
                f"Markierung tauchte beim Zurückspringen wieder auf: {still_clear!r}",
            )

        with ctx.step("Externer Truncate klemmt das Fenster"):
            ctx.api.open(_norm(large), discard=True)
            _wait_hex(ctx, _norm(large))
            os.truncate(large, 8)
            shrunk = _poll(
                lambda: (s := _hex_state(ctx))
                and s.get("fileSize") == 8
                and s.get("path")
                and "large.bin" in _norm(s.get("path") or "")
                and s,
                timeout=6.0,
            )
            ctx.expect(
                bool(shrunk),
                f"Truncate nicht übernommen: {_hex_state(ctx)!r} /state={ctx.api.state()!r}",
            )
            ctx.expect(
                shrunk.get("windowStart") == 0,
                f"Fenster nach Truncate nicht geklemmt: {shrunk!r}",
            )

    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        if pin:
            try:
                ctx.api.workspace_unpin(pin)
            except Exception:
                pass
        shutil.rmtree(ROOT_DIR, ignore_errors=True)
