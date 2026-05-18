"""Undo/Redo-Szenario.

Verifiziert, dass FolioEditor.undo / FolioEditor.redo den Monaco-Undo-
Stack korrekt bedienen. Zwei Pfade:

  1. `insertText` (editor.trigger('keyboard','type',...)) — realistischer
     User-Type-Vorgang, landet sauber im Stack.

  2. `tb-bold` ueber applyReplace (Voll-Range-Replace via executeEdits).
     Bis zum 2026-05-19-Fix nutzte applyReplace `setValue()` und loeschte
     damit den Undo-Stack — Bold-Wrap war undo-untauglich. Dieser Step
     ist die Regression-Sperre.
"""

import time

INSERT_MARKER = "\nundo-test marker line\n"
BOLD_TEXT = "hallo welt\n"


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

    # ----- Regression: Bold-Wrap (applyReplace) muss undo-bar sein ----
    # Vor dem 2026-05-19-Fix clearte applyReplace via setValue() den
    # Monaco-Undo-Stack — ein Bold-Klick loeschte die gesamte Edit-
    # Historie, der Wrap selbst war auch nicht rueckgaengig zu machen.
    with ctx.step("kontrollierten Text setzen (Stack-Reset via setText)"):
        ctx.api.editor_text_set(BOLD_TEXT)
        ctx.expect(
            ctx.api.editor_text_get().get("text", "") == BOLD_TEXT,
            "editor_text_set hat nicht gegriffen",
        )

    with ctx.step("Insert 'X' (regulaerer Edit, fuellt Undo-Stack)"):
        ctx.api.editor_selection(len(BOLD_TEXT), 0)
        ctx.api.editor_command("insertText", args="X")
        text = ctx.api.editor_text_get().get("text", "")
        ctx.expect(text.endswith("X"), f"insertText hat nicht geschrieben: {text!r}")

    with ctx.step("selection auf 'hallo' setzen, tb-bold klicken"):
        ctx.api.editor_selection(0, len("hallo"))
        ctx.api.editor_click_bold = ctx.api.click("tb-bold")
        deadline = time.monotonic() + 2.0
        wrapped = False
        while time.monotonic() < deadline:
            if "**hallo**" in ctx.api.editor_text_get().get("text", ""):
                wrapped = True
                break
            time.sleep(0.05)
        ctx.expect(wrapped, "tb-bold hat 'hallo' nicht eingewrapt")

    with ctx.step("undo → '**hallo**' verschwindet, X bleibt"):
        ctx.api.editor_command("undo")
        text = ctx.api.editor_text_get().get("text", "")
        ctx.expect(
            "**hallo**" not in text,
            f"Bold-Wrap nicht undo-bar (text: {text!r}) — Regression von "
            f"applyReplace.setValue() zurueck?",
        )
        ctx.expect(
            text.endswith("X"),
            f"X (vorheriger Edit) verloren — Undo-Stack wurde geclearet "
            f"(text: {text!r})",
        )

    with ctx.step("zweiter undo → X verschwindet, base-text bleibt"):
        ctx.api.editor_command("undo")
        text = ctx.api.editor_text_get().get("text", "")
        ctx.expect(
            text == BOLD_TEXT,
            f"zweiter undo hat nicht zum base-text zurueckgefuehrt: {text!r}",
        )
