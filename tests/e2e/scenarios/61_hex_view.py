"""E2E: Hex-Ansicht fuer Binärdateien.

Deckt das Öffnen ohne Fehlerdialog, body.kind-binary, die erste Zeile
byteweise, den gesperrten Edit-Button, Tab-/History-Wechsel, externen
Truncate und den Save-Negativtest (Bytes bleiben unverändert).

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
