"""Undo/Redo-Szenario.

Verifiziert, dass FolioEditor.undo / FolioEditor.redo den Monaco-Undo-
Stack korrekt bedienen. Die Edit-Mutation kommt ueber den neuen
`insertText`-Trigger ("editor.trigger('keyboard', 'type', ...)") — der
landet im Monaco-Undo-Stack. `applyReplace` (Bold-Wrap etc.) tut das
NICHT (setValue() clearet den Stack), daher hier bewusst ein realistischer
Type-Vorgang.

Setup:
  open sample.md → edit mode → Cursor ans Ende → insertText
  → undo → expect Originaltext → redo → expect modifizierter Text
"""

INSERT_MARKER = "\nundo-test marker line\n"


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    with ctx.step("switch to edit mode"):
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("originaltext erfassen"):
        original = ctx.api.editor_text_get().get("text", "")
        ctx.expect(
            len(original) > 0,
            "leerer editor-text nach mount — fixture defekt?",
        )
        # Im Test-Scope verfuegbar machen.
        ctx._undo_original = original

    with ctx.step("cursor ans Dokument-Ende setzen"):
        # Selection-Endpunkt klappt auch mit length=0 (= reiner Cursor).
        ctx.api.editor_selection(len(ctx._undo_original), 0)

    with ctx.step("insertText (geht in Monaco-Undo-Stack)"):
        ctx.api.editor_command("insertText", args=INSERT_MARKER)

    with ctx.step("modifizierter Text enthaelt Marker"):
        text = ctx.api.editor_text_get().get("text", "")
        ctx.expect(
            INSERT_MARKER.strip() in text,
            f"marker fehlt nach insertText (letzte 80 chars: {text[-80:]!r})",
        )

    with ctx.step("undo → zurueck zum Original"):
        ctx.api.editor_command("undo")
        text = ctx.api.editor_text_get().get("text", "")
        ctx.expect(
            text == ctx._undo_original,
            f"undo hat nicht zum Original zurueckgefuehrt "
            f"(diff am Ende: {text[-80:]!r} vs {ctx._undo_original[-80:]!r})",
        )

    with ctx.step("redo → modifizierter Text"):
        ctx.api.editor_command("redo")
        text = ctx.api.editor_text_get().get("text", "")
        ctx.expect(
            INSERT_MARKER.strip() in text,
            f"redo hat nicht den marker zurueckgebracht "
            f"(letzte 80 chars: {text[-80:]!r})",
        )
