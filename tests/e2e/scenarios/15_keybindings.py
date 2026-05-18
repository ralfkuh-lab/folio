"""DOM-Keybinding-Szenario.

Testet die im WebView abgefangenen Accelerators (DOM-keydown-Listener
in `toolbar-actions.ts` und `find-bar.ts`) per /key. Native Tauri-Menue-
Accelerators (`Strg+W` schliessen, `Strg+Q` quit, `Strg+Z` undo etc.)
laufen am WebView vorbei und werden ueber /menu/click in 11-14 abgedeckt.

Testbar via /key:
  Ctrl+1   — view-mode → 'view'
  Ctrl+2   — view-mode → 'edit'
  Ctrl+S   — save (im edit-mode)
  Ctrl+F   — find-bar oeffnen

Nicht getestet:
  Ctrl+O   — pick_file (OS-Dialog)
  Alt+Pfeil — Back/Forward (braucht History-Stack mit 2+ Eintraegen;
              deckt 18_history.py in Phase 3 ab)
  Strg+B    — Monaco-eigener Shortcut (durch das ohne /editor/command
              fragile Synthetic-Event-Verhalten nicht zuverlaessig).
              Coverage liegt im Toolbar-Klick (10_editor_commands.py).
"""

import time


def _poll_state(ctx, predicate, timeout_s: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout_s
    state: dict = {}
    while time.monotonic() < deadline:
        state = ctx.api.state()
        if predicate(state):
            return state
        time.sleep(0.05)
    return state


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    # ----- Ctrl+1 / Ctrl+2 → Mode-Switch ------------------------------
    with ctx.step("Ctrl+2 → viewMode=edit"):
        ctx.api.key("2", modifiers={"ctrl": True})
        state = _poll_state(ctx, lambda s: s.get("viewMode") == "edit")
        ctx.expect(state.get("viewMode") == "edit",
                   f"viewMode={state.get('viewMode')!r} nach Ctrl+2")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("Ctrl+1 → viewMode=view"):
        ctx.api.key("1", modifiers={"ctrl": True})
        state = _poll_state(ctx, lambda s: s.get("viewMode") == "view")
        ctx.expect(state.get("viewMode") == "view",
                   f"viewMode={state.get('viewMode')!r} nach Ctrl+1")

    # ----- Ctrl+S → Save ----------------------------------------------
    with ctx.step("zurueck in edit + Text dirty machen"):
        ctx.api.key("2", modifiers={"ctrl": True})
        _poll_state(ctx, lambda s: s.get("viewMode") == "edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)
        text = ctx.api.editor_text_get().get("text", "")
        ctx.api.editor_selection(len(text), 0)
        ctx.api.editor_command("insertText", args="\nctrl-s-test\n")
        _poll_state(ctx, lambda s: s.get("dirty") is True)

    with ctx.step("Ctrl+S → document.saved-Event"):
        ctx.api.key("s", modifiers={"ctrl": True})
        ctx.expect_event("document.saved", timeout_ms=5000)

    # ----- Ctrl+F → Find-Bar ------------------------------------------
    with ctx.step("Ctrl+F → #find-bar.open"):
        ctx.api.key("f", modifiers={"ctrl": True})
        deadline = time.monotonic() + 2.0
        opened = False
        while time.monotonic() < deadline:
            snap = ctx.api.dom("#find-bar")
            cls = (snap.get("attributes") or {}).get("class", "")
            if snap.get("exists") and "open" in cls.split():
                opened = True
                break
            time.sleep(0.05)
        ctx.expect(opened, "#find-bar hat .open nicht nach Ctrl+F")
