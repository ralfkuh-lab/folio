"""Funktionaler Test fuer Theme-Favoriten im Export-Dialog."""

import time

from lib.api import ApiError


def _export_state(ctx) -> dict:
    response = ctx.api.eval(
        """(() => {
            const dialog = document.getElementById("export-dialog");
            const cards = document.getElementById("export-cards");
            const first = cards && cards.querySelector(".export-card");
            const toggle = document.getElementById("export-more-toggle");
            const more = document.getElementById("export-more-cards");
            return {
                open: !!dialog && !dialog.hidden,
                first: first ? first.dataset.layoutId : null,
                hasToggle: !!toggle,
                moreHidden: more ? more.hidden : null,
                moreCount: more ? more.querySelectorAll(".export-card").length : 0
            };
        })()"""
    )
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value") or {}


def _poll_state(ctx, predicate, timeout_s: float = 3.0) -> dict:
    deadline = time.monotonic() + timeout_s
    state = {}
    while time.monotonic() < deadline:
        state = _export_state(ctx)
        if predicate(state):
            return state
        time.sleep(0.05)
    return state


def _close_dialog_if_open(ctx) -> None:
    state = _export_state(ctx)
    if state.get("open"):
        ctx.api.click("export-cancel")


def run(ctx):
    markdown = ctx.fixture("sample.md")

    try:
        with ctx.step("GitHub als Favorit speichern und Markdown oeffnen"):
            response = ctx.api.settings_set({"themeFavorites": ["github"]})
            ctx.expect(
                response.get("themeFavorites") == ["github"],
                f"response={response!r}",
            )
            ctx.api.open(markdown)
            ctx.api.mode("view")

        with ctx.step("Export priorisiert GitHub und klappt weitere Layouts ein"):
            ctx.api.click("tb-export")
            state = _poll_state(
                ctx,
                lambda value: value.get("open") and value.get("first") == "github",
            )
            ctx.expect(state.get("first") == "github", f"export state={state!r}")
            ctx.expect(state.get("hasToggle") is True, f"export state={state!r}")
            ctx.expect(state.get("moreHidden") is True, f"export state={state!r}")
            ctx.expect(state.get("moreCount", 0) > 0, f"export state={state!r}")

        with ctx.step("Weitere Layouts werden per Toggle sichtbar"):
            ctx.api.click("export-more-toggle")
            state = _poll_state(ctx, lambda value: value.get("moreHidden") is False)
            ctx.expect(state.get("moreHidden") is False, f"export state={state!r}")

        with ctx.step("Ohne Favoriten bleibt der Export-Dialog flach"):
            ctx.api.click("export-cancel")
            ctx.api.settings_set({"themeFavorites": []})
            ctx.api.click("tb-export")
            state = _poll_state(
                ctx,
                lambda value: value.get("open") and not value.get("hasToggle"),
            )
            ctx.expect(state.get("open") is True, f"export state={state!r}")
            ctx.expect(state.get("hasToggle") is False, f"export state={state!r}")
            ctx.api.click("export-cancel")

        with ctx.step("Standard kann nicht als Favorit gespeichert werden"):
            try:
                ctx.api.settings_set({"themeFavorites": ["standard"]})
                ctx.expect(False, "standard wurde als Theme-Favorit akzeptiert")
            except ApiError as error:
                ctx.expect(400 <= error.status < 500, f"HTTP-Status={error.status}")
    finally:
        try:
            _close_dialog_if_open(ctx)
        finally:
            ctx.api.settings_set({"themeFavorites": []})
