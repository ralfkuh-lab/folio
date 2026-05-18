"""Edit-Menue-Szenario.

Testet, dass `menu:edit_*` aus dem Menue-Pfad durch zum Frontend-Handler
durchschlaegt.

  edit.undo / edit.redo — ruft FolioEditor.undo/redo (Monaco-Stack)
  edit.find             — oeffnet die find-bar (#find-bar erhaelt .open)
"""

import time

INSERT = "\nmenu-edit-undo-test\n"


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open + edit mode"):
        ctx.api.open(sample)
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("baseline-text festhalten"):
        ctx._undo_original = ctx.api.editor_text_get().get("text", "")

    with ctx.step("insertText (geht in Undo-Stack)"):
        ctx.api.editor_selection(len(ctx._undo_original), 0)
        ctx.api.editor_command("insertText", args=INSERT)
        text = ctx.api.editor_text_get().get("text", "")
        ctx.expect(INSERT.strip() in text, "insertText hat nicht geschrieben")

    # ----- edit.undo --------------------------------------------------
    with ctx.step("/menu/click edit.undo → Originaltext"):
        ctx.api.menu_click("edit.undo")
        # Kein Ack-Pfad ueber menu:* — kurz polling.
        deadline = time.monotonic() + 2.0
        reverted = False
        while time.monotonic() < deadline:
            if ctx.api.editor_text_get().get("text", "") == ctx._undo_original:
                reverted = True
                break
            time.sleep(0.05)
        ctx.expect(
            reverted,
            f"undo hat Original nicht wiederhergestellt; aktueller Text endet "
            f"auf {ctx.api.editor_text_get().get('text', '')[-80:]!r}",
        )

    # ----- edit.redo --------------------------------------------------
    with ctx.step("/menu/click edit.redo → Marker wieder da"):
        ctx.api.menu_click("edit.redo")
        deadline = time.monotonic() + 2.0
        redone = False
        while time.monotonic() < deadline:
            if INSERT.strip() in ctx.api.editor_text_get().get("text", ""):
                redone = True
                break
            time.sleep(0.05)
        ctx.expect(
            redone,
            f"redo hat Marker nicht zurueckgebracht; Text endet auf "
            f"{ctx.api.editor_text_get().get('text', '')[-80:]!r}",
        )

    # ----- edit.find --------------------------------------------------
    with ctx.step("/menu/click edit.find → #find-bar.open"):
        ctx.api.menu_click("edit.find")
        # find-bar ist DOM-gesteuert (class .open). /dom liefert
        # attributes inkl. class.
        deadline = time.monotonic() + 2.0
        opened = False
        last_snap = None
        while time.monotonic() < deadline:
            snap = ctx.api.dom("#find-bar")
            last_snap = snap
            cls = (snap.get("attributes") or {}).get("class", "")
            if snap.get("exists") and "open" in cls.split():
                opened = True
                break
            time.sleep(0.05)
        ctx.expect(
            opened,
            f"#find-bar hat .open nicht nach edit.find (last snap: {last_snap})",
        )
