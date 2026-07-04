"""Funktionaler Test fuer Markdown-View-Themes."""

import time

from lib.api import ApiError


def _theme_state(ctx) -> dict:
    response = ctx.api.eval(
        """(() => {
            const style = document.getElementById('view-theme-style');
            return {
                theme: document.body.dataset.viewTheme || null,
                css: style ? style.textContent : null
            };
        })()"""
    )
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value") or {}


def _poll_theme(ctx, theme_id: str, timeout_s: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout_s
    state = {}
    while time.monotonic() < deadline:
        state = _theme_state(ctx)
        if state.get("theme") == theme_id:
            return state
        time.sleep(0.05)
    return state


def run(ctx):
    markdown = ctx.fixture("sample.md")

    try:
        with ctx.step("Markdown-Fixture im View-Mode oeffnen"):
            ctx.api.open(markdown)
            ctx.api.mode("view")

        with ctx.step("GitHub-Theme setzt Dataset und Content-CSS"):
            response = ctx.api.settings_set({"viewTheme": "github"})
            ctx.expect(response.get("viewTheme") == "github", f"response={response!r}")
            state = _poll_theme(ctx, "github")
            ctx.expect(state.get("theme") == "github", f"theme state={state!r}")
            ctx.expect(bool(state.get("css")), "GitHub-Theme-CSS ist leer")

        with ctx.step("Dark-App-Theme laedt die GitHub-Dark-Variante"):
            ctx.api.theme("dark")
            state = _theme_state(ctx)
            ctx.expect("#0d1117" in (state.get("css") or ""), f"theme state={state!r}")

        with ctx.step("Classic bleibt im Dark-App-Theme in der Light-Variante"):
            ctx.api.settings_set({"viewTheme": "classic"})
            state = _poll_theme(ctx, "classic")
            css = state.get("css") or ""
            ctx.expect("Iowan Old Style" in css, "Classic-Light-CSS fehlt")
            ctx.expect("#0d1117" not in css, "Classic hat unerwartete Dark-Regeln")

        with ctx.step("Standard entfernt das injizierte CSS"):
            ctx.api.settings_set({"viewTheme": "standard"})
            state = _poll_theme(ctx, "standard")
            ctx.expect(state.get("css") == "", f"Standard-CSS={state.get('css')!r}")

        with ctx.step("Unbekanntes Theme wird abgelehnt und nicht gespeichert"):
            try:
                ctx.api.settings_set({"viewTheme": "gibtsnicht"})
                ctx.expect(False, "ungueltiges View-Theme wurde akzeptiert")
            except ApiError as error:
                ctx.expect(400 <= error.status < 500, f"HTTP-Status={error.status}")
            current = ctx.api.settings_get()
            ctx.expect(
                current.get("viewTheme") == "standard",
                f"viewTheme nach Fehler={current.get('viewTheme')!r}",
            )
    finally:
        ctx.api.theme("light")
        ctx.api.settings_set({"viewTheme": "standard"})
