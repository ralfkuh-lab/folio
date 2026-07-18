"""Find-Bar im read-only Code-View.

Prueft, dass Non-Markdown-Textdateien im View-Mode nicht mehr auf
Monacos internes Widget angewiesen sind, sondern ueber die Folio-Find-Bar
Treffer/Navigation liefern. Zusaetzlich wird die offene Suche beim
Tab-/Dokumentwechsel gegen das neue Code-View-Model invalidiert.
"""

import tempfile
import time
from pathlib import Path


def _wait_counter(ctx, expected_total: int, timeout_s: float = 4.0) -> str:
    deadline = time.monotonic() + timeout_s
    last = ""
    suffix = f"/{expected_total}"
    while time.monotonic() < deadline:
        snap = ctx.api.dom("#find-counter", timeout_ms=500)
        last = (snap.get("textContent") or "").strip()
        if last.endswith(suffix) and not last.startswith("0/"):
            return last
        time.sleep(0.05)
    return last


def _wait_code_view(ctx, timeout_s: float = 4.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        result = ctx.api.eval("!!(window.FolioCodeView && window.FolioCodeView.isMounted())")
        if result.get("ok") and result.get("value") is True:
            return True
        time.sleep(0.05)
    return False


def run(ctx):
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-find-code-"))
    file_a = tmp / "find-code-a.json"
    file_b = tmp / "find-code-b.json"
    file_a.write_text(
        '{\n'
        '  "title": "needle",\n'
        '  "items": ["needle", "other"]\n'
        '}\n',
        encoding="utf-8",
    )
    file_b.write_text(
        '{\n'
        '  "title": "needle",\n'
        '  "items": ["needle", "needle", "needle"]\n'
        '}\n',
        encoding="utf-8",
    )

    try:
        with ctx.step("open JSON A in view-mode Code-View"):
            ctx.api.tabs_close_all()
            ctx.api.open(str(file_a), discard=True)
            ctx.api.mode("view")
            ctx.expect(_wait_code_view(ctx), "Code-View wurde fuer JSON A nicht gemountet")

        with ctx.step("POST /find/text findet Treffer im Code-View"):
            ctx.api.find_text("needle")
            counter = _wait_counter(ctx, 2)
            ctx.expect(counter.endswith("/2") and not counter.startswith("0/"), f"counter A={counter!r}")

        with ctx.step("F3 schaltet aktiven Treffer weiter"):
            before = ctx.api.dom("#find-counter").get("textContent") or ""
            ctx.api.key("F3")
            deadline = time.monotonic() + 2.0
            after = before
            while time.monotonic() < deadline:
                after = ctx.api.dom("#find-counter").get("textContent") or ""
                if after != before and after.endswith("/2"):
                    break
                time.sleep(0.05)
            ctx.expect(after != before and after.endswith("/2"), f"F3 counter before={before!r}, after={after!r}")

        with ctx.step("zweites JSON in neuem Tab invalidiert offene Suche"):
            ctx.api.tab_open(str(file_b))
            ctx.api.mode("view")
            ctx.expect(_wait_code_view(ctx), "Code-View wurde fuer JSON B nicht gemountet")
            counter = _wait_counter(ctx, 4)
            ctx.expect(counter.endswith("/4") and not counter.startswith("0/"), f"counter B={counter!r}")

        # T1 Live-Preview Code-View: Split-Mode + Editor-Text aendern →
        # Read-Only-Code-View uebernimmt debounced (kein Screenshot).
        with ctx.step("Split-Mode Live-Update der Code-View"):
            try:
                ctx.api.find_close()
            except Exception:
                pass
            ctx.api.tabs_close_all()
            ctx.api.open(str(file_a), discard=True)
            ctx.api.mode("split")
            ctx.expect(_wait_code_view(ctx), "Code-View im Split-Mode nicht gemountet")
            marker = "code-live-preview-marker-xyz"
            # Vorher: Code-View hat den Disk-Stand (ohne Marker).
            before = ctx.api.eval(
                "(function(){var cv=window.FolioCodeView;"
                "return (cv&&cv.getText)?cv.getText():'';})()"
            )
            ctx.expect(
                before.get("ok") is True and marker not in (before.get("value") or ""),
                f"Precondition: Marker darf vor Edit nicht in Code-View sein: {before!r}",
            )
            ctx.api.editor_text_set(
                '{\n'
                '  "title": "needle",\n'
                '  "items": ["needle", "other"],\n'
                f'  "live": "{marker}"\n'
                '}\n'
            )
            deadline = time.monotonic() + 4.0
            seen = ""
            while time.monotonic() < deadline:
                result = ctx.api.eval(
                    "(function(){var cv=window.FolioCodeView;"
                    "if(!cv||!cv.isMounted||!cv.isMounted())return null;"
                    "return typeof cv.getText==='function'?cv.getText():null;})()"
                )
                if result.get("ok") and isinstance(result.get("value"), str) and marker in result["value"]:
                    seen = result["value"]
                    break
                time.sleep(0.05)
            ctx.expect(
                marker in seen,
                f"Code-View Live-Update im Split-Mode fehlgeschlagen "
                f"(Marker {marker!r} nicht in FolioCodeView.getText(); last={seen!r})",
            )
    finally:
        try:
            ctx.api.find_close()
        finally:
            ctx.api.tabs_close_all()
