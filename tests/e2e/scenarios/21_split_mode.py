"""Split-Mode-Szenario.

Eigenes Szenario fuer den split-Mode (Cmd+3), den 02_view_mode + 03_edit_mode
nicht abdecken. Verifiziert:
  - /mode "split" → state.viewMode == "split"
  - Editor und View sind beide gemountet (state.editor.ready true)
  - Visual-Baseline split-default
"""


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    with ctx.step("/mode split"):
        ctx.api.mode("split")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("state.viewMode == 'split', editor ist ready"):
        state = ctx.api.state()
        ctx.expect(
            state.get("viewMode") == "split",
            f"viewMode={state.get('viewMode')!r}, erwartet 'split'",
        )
        editor = state.get("editor") or {}
        ctx.expect(
            editor.get("ready") is True,
            f"editor.ready={editor.get('ready')!r} im split-Mode",
        )

    with ctx.step("screenshot split-Default"):
        ctx.screenshot("split_default")

    with ctx.step("zurueck in view mode (kein Aufraeumen-Side-effect)"):
        ctx.api.mode("view")
        state = ctx.api.state()
        ctx.expect(state["viewMode"] == "view", f"expected view, got {state['viewMode']!r}")
