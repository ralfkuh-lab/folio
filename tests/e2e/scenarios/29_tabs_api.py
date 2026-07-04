"""Funktionaler Test der Backend-Tab- und Automation-API."""

import json

from lib.api import ApiError


def _tab_for_path(tabs: list[dict], path: str) -> dict:
    normalized = path.replace("\\", "/")
    return next((tab for tab in tabs if tab.get("path") == normalized), {})


def run(ctx):
    initial_file = ctx.api.state().get("file")
    file_a = ctx.fixture("sample.md")
    file_b = ctx.fixture("notes", "deep.md")

    try:
        with ctx.step("isolierter Start und zwei Fixtures in zwei Tabs"):
            ctx.api.tabs_close_all()
            ctx.api.open(file_a, discard=True)
            ctx.api.tab_open(file_b)
            tabs = ctx.api.tabs().get("tabs") or []
            ctx.expect(len(tabs) == 2, f"tabs={tabs!r}, erwartet zwei Tabs")
            tab_a = _tab_for_path(tabs, file_a)
            tab_b = _tab_for_path(tabs, file_b)
            ctx.expect(bool(tab_a) and bool(tab_b), f"Fixture-Tabs fehlen: {tabs!r}")
            ctx.expect(tab_b.get("active") is True, f"Tab B nicht aktiv: {tabs!r}")

        with ctx.step("GET /state enthaelt dieselbe Tab-Liste"):
            state = ctx.api.state()
            ctx.expect(state.get("tabs") == tabs, f"state.tabs={state.get('tabs')!r}")
            ctx.expect(
                (state.get("file") or "").replace("\\", "/")
                == file_b.replace("\\", "/"),
                f"state.file={state.get('file')!r}, erwartet B",
            )

        with ctx.step("Ungueltiger Pfad und unbekannte ID liefern 4xx"):
            try:
                ctx.api.tab_open(file_b + ".missing")
                ctx.expect(False, "ungueltiger Pfad wurde akzeptiert")
            except ApiError as error:
                ctx.expect(400 <= error.status < 500, f"Pfad-Status={error.status}")
            try:
                ctx.api.tab_activate(9_999_999)
                ctx.expect(False, "unbekannte Tab-ID wurde akzeptiert")
            except ApiError as error:
                ctx.expect(400 <= error.status < 500, f"ID-Status={error.status}")

        with ctx.step("Aktivieren von Tab A wechselt state.file"):
            response = ctx.api.tab_activate(tab_a["id"])
            ctx.expect(response.get("acked") is True, f"activate response={response!r}")
            state = ctx.api.state()
            ctx.expect(
                (state.get("file") or "").replace("\\", "/")
                == file_a.replace("\\", "/"),
                f"state.file={state.get('file')!r}, erwartet A",
            )

        with ctx.step("Doppeltes Open aktiviert nur und haelt die Tab-Anzahl"):
            ctx.api.tab_activate(tab_b["id"])
            response = ctx.api.tab_open(file_a)
            current = ctx.api.tabs().get("tabs") or []
            ctx.expect(len(current) == 2, f"duplicate open erzeugte Tab: {current!r}")
            ctx.expect(response.get("tab", {}).get("id") == tab_a["id"], f"{response!r}")
            ctx.expect(_tab_for_path(current, file_a).get("active") is True, f"{current!r}")

        with ctx.step("History bleibt pro Tab isoliert"):
            script = (
                "window.__folioInvoke('navigate', "
                + json.dumps({"path": file_a, "anchor": "abschnitt-b"})
                + ")"
            )
            result = ctx.api.eval(script)
            ctx.expect(result.get("ok") is True, f"navigate eval={result!r}")
            ctx.api.tab_activate(tab_b["id"])
            back_b = ctx.api.history_back()
            ctx.expect(back_b.get("moved") is False, f"History B bewegte sich: {back_b!r}")
            ctx.api.tab_activate(tab_a["id"])
            back_a = ctx.api.history_back()
            ctx.expect(back_a.get("moved") is True, f"History A bewegte sich nicht: {back_a!r}")

        with ctx.step("Dirty-Tab braucht discard zum Schliessen"):
            original = ctx.api.editor_text_get().get("text") or ""
            ctx.api.editor_text_set(original + "\nDirty nur fuer Tab-Close-Test.\n")
            try:
                ctx.api.tab_close(tab_a["id"])
                ctx.expect(False, "Dirty-Tab wurde ohne discard geschlossen")
            except ApiError as error:
                ctx.expect(400 <= error.status < 500, f"HTTP-Status={error.status}")
            dirty_tabs = ctx.api.tabs().get("tabs") or []
            ctx.expect(_tab_for_path(dirty_tabs, file_a).get("dirty") is True, f"{dirty_tabs!r}")
            ctx.api.tab_close(tab_a["id"], discard=True)
            remaining = ctx.api.tabs().get("tabs") or []
            ctx.expect(len(remaining) == 1, f"remaining={remaining!r}")
            ctx.expect(_tab_for_path(remaining, file_b).get("active") is True, f"{remaining!r}")

        with ctx.step("close_all hinterlaesst genau einen leeren Tab"):
            ctx.api.tabs_close_all()
            final_tabs = ctx.api.tabs().get("tabs") or []
            ctx.expect(len(final_tabs) == 1, f"final tabs={final_tabs!r}")
            ctx.expect(final_tabs[0].get("path") is None, f"final tabs={final_tabs!r}")
            ctx.expect(ctx.api.state().get("file") is None, "state.file ist nicht leer")
    finally:
        ctx.api.tabs_close_all()
        if initial_file:
            ctx.api.open(initial_file, discard=True)
