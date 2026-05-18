"""History-Back/Forward-Szenario.

Verifiziert die Phase-0-Endpoints /history/back und /history/forward
durch echten Navigations-Roundtrip:

  open A → open B → back → state.file=A → forward → state.file=B

Was hier NICHT geprueft wird (pre-existing in commands::nav::move_history):
Am Ende der History (current_index=0) liefert go_back() trotzdem das
aktuelle Entry — ein "moved=false am Anfang"-Check waere also brittle
zum aktuellen Verhalten. Wenn das mal sauber `can_go_back`-gegated wird,
gehoert hier ein Edge-Case-Step zu.
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
