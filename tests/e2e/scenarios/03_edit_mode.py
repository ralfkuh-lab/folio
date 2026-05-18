"""Edit-Mode-Szenario.

Wechselt in den Edit-Mode, prueft editor.ready, setzt Text via
/editor/text und liest ihn zurueck. Visual-Check nach Mode-Switch.
"""


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    with ctx.step("switch to edit mode"):
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("state.editor.ready ist true"):
        state = ctx.api.state()
        editor = state.get("editor", {})
        ctx.expect(
            editor.get("ready") is True,
            f"editor.ready is {editor.get('ready')!r} after mode switch",
        )

    with ctx.step("editor text matches file content"):
        editor_text = ctx.api.editor_text_get()
        text = editor_text.get("text", "")
        ctx.expect(
            "Folio E2E Fixture" in text,
            f"editor text missing header; got first 80 chars: {text[:80]!r}",
        )

    with ctx.step("screenshot edit mode"):
        ctx.screenshot("edit_default")

    # Selection setzen, Bold-Wrap nicht ausloesen (testet nur den
    # Selection-Endpunkt — apply_editor_command waere ein eigener Step
    # mit echtem Text-Mutation, das spart Baseline-Drift fuer den
    # MVP).
    with ctx.step("selection setzen auf Header"):
        # "Folio E2E Fixture" beginnt nach "# " an Offset 2; Laenge 17.
        ctx.api.editor_selection(2, 17)
        state = ctx.api.state()
        sel_len = state.get("editor", {}).get("selectionLength", 0)
        ctx.expect(
            sel_len == 17,
            f"expected selectionLength 17, got {sel_len}",
        )

    with ctx.step("zurueck in view mode"):
        ctx.api.mode("view")
        state = ctx.api.state()
        ctx.expect(state["viewMode"] == "view", f"expected view, got {state['viewMode']!r}")
