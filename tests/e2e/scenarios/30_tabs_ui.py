"""Funktionaler Test der Tab-Leiste und des Monaco-Model-Caches."""

import time


def _poll(ctx, predicate, timeout_s: float = 3.0):
    deadline = time.monotonic() + timeout_s
    value = None
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return value


def _normalized(path: str) -> str:
    return path.replace("\\", "/")


def run(ctx):
    file_a = ctx.fixture("sample.md")
    file_b = ctx.fixture("notes", "deep.md")

    try:
        with ctx.step("zwei Tabs oeffnen und Tab-Leiste pruefen"):
            ctx.api.tabs_close_all()
            ctx.api.open(file_a, discard=True)
            ctx.api.tab_open(file_b)
            tabs = ctx.api.tabs().get("tabs") or []
            tab_a = next(tab for tab in tabs if tab.get("path") == _normalized(file_a))
            tab_b = next(tab for tab in tabs if tab.get("path") == _normalized(file_b))
            ctx.api.tab_activate(tab_a["id"])

            visible = _poll(
                ctx,
                lambda: (
                    (snap := ctx.api.dom("#tab-bar")).get("exists")
                    and "hidden" not in (snap.get("attributes") or {})
                    and snap
                ),
            )
            ctx.expect(bool(visible), "#tab-bar ist bei zwei Tabs nicht sichtbar")
            count = ctx.api.eval(
                "document.querySelectorAll('#tab-bar .tab-item').length"
            )
            ctx.expect(count.get("value") == 2, f"Tab-Anzahl im DOM: {count!r}")
            active = ctx.api.dom("#tab-bar .tab-item.active")
            ctx.expect(
                (active.get("attributes") or {}).get("data-tab-id") == str(tab_a["id"]),
                f"aktiver DOM-Tab stimmt nicht: {active!r}",
            )

        with ctx.step("Klick auf zweiten DOM-Tab wechselt state.file"):
            ctx.api.click(f'.tab-item[data-tab-id="{tab_b["id"]}"]')

            def _state_if_file_b():
                state = ctx.api.state()
                if _normalized(state.get("file") or "") == _normalized(file_b):
                    return state
                return None

            state = _poll(ctx, _state_if_file_b)
            ctx.expect(bool(state), "DOM-Tab-Klick hat nicht auf Datei B gewechselt")

        with ctx.step("Tab A editieren und Dirty-Punkt pruefen"):
            ctx.api.click(f'.tab-item[data-tab-id="{tab_a["id"]}"]')
            _poll(
                ctx,
                lambda: _normalized(ctx.api.state().get("file") or "")
                == _normalized(file_a),
            )
            ctx.api.mode("edit")
            ctx.expect_event("editor.ready", timeout_ms=10000)
            original = ctx.api.editor_text_get().get("text", "")
            marker = "\nT3 model cache marker\n"
            ctx.api.editor_selection(len(original), 0)
            ctx.api.editor_command("insertText", args=marker)
            dirty = _poll(
                ctx,
                lambda: ctx.api.dom(
                    f'.tab-item[data-tab-id="{tab_a["id"]}"] .tab-dirty'
                ).get("exists"),
            )
            ctx.expect(bool(dirty), "Dirty-Punkt fuer Tab A fehlt")

        with ctx.step("Wechsel weg und zurueck behaelt Text und Undo-Stack"):
            ctx.api.click(f'.tab-item[data-tab-id="{tab_b["id"]}"]')
            _poll(
                ctx,
                lambda: _normalized(ctx.api.state().get("file") or "")
                == _normalized(file_b),
            )
            ctx.api.click(f'.tab-item[data-tab-id="{tab_a["id"]}"]')
            _poll(
                ctx,
                lambda: _normalized(ctx.api.state().get("file") or "")
                == _normalized(file_a),
            )
            restored = ctx.api.editor_text_get().get("text", "")
            ctx.expect(marker.strip() in restored, "Editor-Text ging beim Tab-Wechsel verloren")
            ctx.expect(ctx.api.state().get("dirty") is True, "Dirty-State ging verloren")

            ctx.api.editor_command("undo")

            # editorTextChanged synct den Store asynchron (IPC) — pollen
            # statt sofort lesen, sonst liest man den Pre-Undo-Stand.
            def _text_if_original():
                text = ctx.api.editor_text_get().get("text", "")
                return text if text == original else None

            undone = _poll(ctx, _text_if_original)
            ctx.expect(undone == original, "Undo-Stack hat den Tab-Wechsel nicht ueberlebt")

            # Regression (User-Bug 2026-07-04): Revert auf den
            # Ausgangstext muss auch den BACKEND-Dirty-State und damit
            # den Tab-Punkt zuruecksetzen (clean_text-Referenz im Store).
            dirty_cleared = _poll(
                ctx, lambda: ctx.api.state().get("dirty") is False
            )
            ctx.expect(bool(dirty_cleared), "Backend blieb nach Undo-Revert dirty")
            dot_gone = _poll(
                ctx,
                lambda: not ctx.api.dom(
                    f'.tab-item[data-tab-id="{tab_a["id"]}"] .tab-dirty'
                ).get("exists"),
            )
            ctx.expect(bool(dot_gone), "Tab-Dirty-Punkt blieb nach Undo-Revert")

        with ctx.step("Ctrl+W schliesst aktiven Dirty-Tab nach Verwerfen"):
            # Nach Undo erneut dirty machen, damit der Dialogpfad garantiert
            # getestet wird.
            ctx.api.editor_selection(len(original), 0)
            ctx.api.editor_command("insertText", args=marker)
            _poll(ctx, lambda: ctx.api.state().get("dirty") is True)
            ctx.api.key("w", modifiers={"ctrl": True})
            dialog = _poll(
                ctx,
                lambda: (
                    (snap := ctx.api.dom("#unsaved-dialog")).get("exists")
                    and "hidden" not in (snap.get("attributes") or {})
                ),
            )
            ctx.expect(bool(dialog), "Ctrl+W hat keinen Dirty-Dialog geoeffnet")
            ctx.api.click("unsaved-discard")
            closed = _poll(
                ctx,
                lambda: len(ctx.api.tabs().get("tabs") or []) == 1,
            )
            ctx.expect(bool(closed), "aktiver Tab wurde nach Verwerfen nicht geschlossen")

        with ctx.step("Leiste verschwindet beim leeren letzten Tab"):
            ctx.api.tabs_close_all()
            hidden = _poll(
                ctx,
                lambda: "hidden" in (
                    ctx.api.dom("#tab-bar").get("attributes") or {}
                ),
            )
            ctx.expect(bool(hidden), "#tab-bar blieb beim leeren Tab sichtbar")
    finally:
        ctx.api.tabs_close_all()
