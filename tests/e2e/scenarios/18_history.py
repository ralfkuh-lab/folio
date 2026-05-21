"""History-Back/Forward-Szenario.

Verifiziert die Phase-0-Endpoints /history/back und /history/forward
durch echten Navigations-Roundtrip:

  open A → open B → back → state.file=A → forward → state.file=B
                 → second back at edge → moved=false
                 → second forward at edge → moved=false

Der moved=false-Edge-Step war vor dem 2026-05-19-Fix unbrauchbar:
move_history hat go_back/go_forward immer rufen lassen, die per
Konvention auch am Edge `current()` zurueckgeben. Mit der
can_go_*-Vorschaltung liefert der Endpoint jetzt sauber
{moved: false, entry: null}.
"""

import tempfile
import time
from pathlib import Path


def _wait_for_file(ctx, expected_basename: str, timeout_s: float = 2.0) -> str:
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        f = ctx.api.state().get("file")
        last = f
        if f and expected_basename in f:
            return f
        time.sleep(0.05)
    return last


def run(ctx):
    # Ganz nach links in der Historie navigieren, um den Stack davor zu minimieren.
    # Dadurch bleibt genau 1 Element an Index 0 uebrig, wenn wir neu oeffnen.
    while True:
        res = ctx.api.history_back()
        if not res.get("moved"):
            break

    # Zwei eigene Dateien — sample.md fixture ist als A nutzbar, aber
    # ein zweites File brauchen wir extra. tempfile haelt's hermetisch.
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-history-"))
    file_a = tmp / "history-a.md"
    file_a.write_text("# A\n")
    file_b = tmp / "history-b.md"
    file_b.write_text("# B\n")

    with ctx.step("open A"):
        ctx.api.open(str(file_a))
        f = _wait_for_file(ctx, "history-a.md")
        ctx.expect(f and "history-a.md" in f, f"open A: state.file={f!r}")

    with ctx.step("open B"):
        ctx.api.open(str(file_b))
        f = _wait_for_file(ctx, "history-b.md")
        ctx.expect(f and "history-b.md" in f, f"open B: state.file={f!r}")

    with ctx.step("/history/back → moved=true, entry zeigt auf A"):
        result = ctx.api.history_back()
        ctx.expect(result.get("moved") is True, f"back: moved={result.get('moved')!r}")
        entry = result.get("entry") or {}
        ctx.expect(
            "history-a.md" in (entry.get("path") or ""),
            f"back-entry zeigt nicht auf A: {entry}",
        )

    with ctx.step("nach back: state.file == A"):
        f = _wait_for_file(ctx, "history-a.md")
        ctx.expect(f and "history-a.md" in f, f"state.file nach back: {f!r}")

    with ctx.step("/history/forward → moved=true, entry zeigt auf B"):
        result = ctx.api.history_forward()
        ctx.expect(result.get("moved") is True, f"forward: moved={result.get('moved')!r}")
        entry = result.get("entry") or {}
        ctx.expect(
            "history-b.md" in (entry.get("path") or ""),
            f"forward-entry zeigt nicht auf B: {entry}",
        )

    with ctx.step("nach forward: state.file == B"):
        f = _wait_for_file(ctx, "history-b.md")
        ctx.expect(f and "history-b.md" in f, f"state.file nach forward: {f!r}")

    # ----- Edge-Case: zweimal in die gleiche Richtung am Stack-Ende ---
    with ctx.step("/history/forward am vorderen Ende → moved=false"):
        result = ctx.api.history_forward()
        ctx.expect(
            result.get("moved") is False,
            f"forward at edge: moved={result.get('moved')!r}, erwartet False",
        )
        ctx.expect(
            result.get("entry") is None,
            f"forward at edge: entry={result.get('entry')!r}, erwartet None",
        )

    with ctx.step("state.file weiterhin B (kein unnoetiges Reload)"):
        f = ctx.api.state().get("file")
        ctx.expect(
            f and "history-b.md" in f,
            f"state.file nach forward-no-op: {f!r}",
        )

    with ctx.step("/history/back → A; dann zu Index 0; /history/back am hinteren Ende → moved=false"):
        # Zurueck zu A
        result = ctx.api.history_back()
        ctx.expect(result.get("moved") is True, f"back to A: {result!r}")
        _wait_for_file(ctx, "history-a.md")
        # Zurueck zu Index 0
        result = ctx.api.history_back()
        ctx.expect(result.get("moved") is True, f"back to index 0: {result!r}")
        # Weiter zurueck — am echten Anfang (Index 0).
        result = ctx.api.history_back()
        ctx.expect(
            result.get("moved") is False,
            f"back at edge: moved={result.get('moved')!r}, erwartet False",
        )
        ctx.expect(
            result.get("entry") is None,
            f"back at edge: entry={result.get('entry')!r}, erwartet None",
        )
