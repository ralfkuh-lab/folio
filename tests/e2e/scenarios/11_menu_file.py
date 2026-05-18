"""File-Menue-Szenario.

Testet, dass das File-Menue ueber `/menu/click {id}` denselben Pfad
durchlaeuft wie ein nativer User-Klick — die Routing-Logik in
`menu/events.rs::dispatch_menu_action` plus die Frontend-Handler in
`menu-router.ts`.

Testbar:
  file.save     — wenn dirty, triggert document:saved
  file.close    — schliesst aktives Dokument, state.file=null
  file.recent.0 — oeffnet zuletzt geoeffnete Datei wieder

Nicht testbar via Automation-API (jeweils mit Begruendung im Code):
  file.open     — oeffnet OS-Dateidialog (pick_file)
  file.save_as  — oeffnet OS-Dateidialog
  file.rename   — oeffnet OS-Dateidialog
  file.quit     — wuerde die App killen, ist Test-toxisch
"""

import time


def run(ctx):
    sample = ctx.fixture("sample.md")

    # ----- Setup: Dokument oeffnen + dirty machen ---------------------
    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    with ctx.step("edit mode + cursor ans Ende"):
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)
        original = ctx.api.editor_text_get().get("text", "")
        ctx.api.editor_selection(len(original), 0)

    with ctx.step("insertText → state.dirty=true"):
        ctx.api.editor_command("insertText", args="\nfile-menue-test\n")
        # markDirty wird per editor_text_changed-Roundtrip nachgezogen;
        # kurzer Poll auf state.dirty.
        deadline = time.monotonic() + 2.0
        dirty = False
        while time.monotonic() < deadline:
            if ctx.api.state().get("dirty"):
                dirty = True
                break
            time.sleep(0.05)
        ctx.expect(dirty, "state.dirty wurde nach insertText nicht true")

    # ----- file.save --------------------------------------------------
    with ctx.step("/menu/click file.save → document.saved-Event"):
        ctx.api.menu_click("file.save")
        ctx.expect_event("document.saved", timeout_ms=5000)

    with ctx.step("nach save: state.dirty=false, file gesetzt"):
        state = ctx.api.state()
        ctx.expect(
            state.get("dirty") is False,
            f"state.dirty=false erwartet nach save, ist {state.get('dirty')!r}",
        )
        ctx.expect(
            state.get("file") and "sample.md" in state["file"],
            f"state.file fehlt/falsch nach save: {state.get('file')!r}",
        )

    # ----- file.close -------------------------------------------------
    with ctx.step("/menu/click file.close → state.file=null"):
        ctx.api.menu_click("file.close")
        # close emittiert document:closed; State-Update ist asynchron,
        # daher polling auf file=null.
        deadline = time.monotonic() + 2.0
        closed = False
        while time.monotonic() < deadline:
            if ctx.api.state().get("file") is None:
                closed = True
                break
            time.sleep(0.05)
        ctx.expect(closed, f"state.file nicht null nach file.close: {ctx.api.state().get('file')!r}")

    # ----- file.recent.0 ----------------------------------------------
    with ctx.step("workspace.recent enthaelt sample.md vor recent.0-Klick"):
        # open() oben hat sample.md in recent geschoben. Ohne diesen
        # Eintrag waere file.recent.0 ein No-op und der naechste Schritt
        # nicht beweisend.
        state = ctx.api.state()
        recent = (state.get("workspace") or {}).get("recent") or []
        paths = [r.get("path") for r in recent if isinstance(r, dict)]
        ctx.expect(
            any(p and "sample.md" in p for p in paths),
            f"sample.md fehlt in workspace.recent: {paths[:5]}",
        )

    with ctx.step("/menu/click file.recent.0 → state.file != null"):
        ctx.api.menu_click("file.recent.0")
        deadline = time.monotonic() + 2.0
        reopened = False
        while time.monotonic() < deadline:
            f = ctx.api.state().get("file")
            if f and "sample.md" in f:
                reopened = True
                break
            time.sleep(0.05)
        ctx.expect(
            reopened,
            f"state.file zeigt nicht auf sample.md nach file.recent.0: "
            f"{ctx.api.state().get('file')!r}",
        )
