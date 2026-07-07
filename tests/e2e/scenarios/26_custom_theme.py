"""Funktionaler Test fuer benutzerdefinierte Markdown-Themes."""

import json
import shutil
import time
from pathlib import Path

from lib.api import ApiError


LIGHT_MARKER = "#12ab34"
DARK_MARKER = "#ba21dc"
FONT_STACK = "Inter, system-ui, sans-serif"


def _eval(ctx, js: str):
    response = ctx.api.eval(js, timeout_ms=10_000)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


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


def _poll_css(ctx, theme_id: str, marker: str, timeout_s: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout_s
    state = {}
    while time.monotonic() < deadline:
        state = _theme_state(ctx)
        if state.get("theme") == theme_id and marker in (state.get("css") or ""):
            return state
        time.sleep(0.05)
    return state


def _themes_dir(ctx) -> Path:
    response = ctx.api.eval("window.__folioInvoke('themes_dir_path')")
    ctx.expect(response.get("ok") is True, f"themes_dir_path schlug fehl: {response!r}")
    path = response.get("value")
    ctx.expect(isinstance(path, str) and bool(path), f"ungueltiger Theme-Pfad: {path!r}")
    return Path(path)


def run(ctx):
    themes_dir = _themes_dir(ctx)
    light_path = themes_dir / "e2etheme.css"
    dark_path = themes_dir / "e2etheme.dark.css"
    package_dir = themes_dir / "e2etheme"

    try:
        with ctx.step("Custom-Theme zur Laufzeit anlegen"):
            themes_dir.mkdir(parents=True, exist_ok=True)
            light_path.write_text(
                f"/* name: E2E Theme */\n.markdown-body {{ color: {LIGHT_MARKER}; }}\n",
                encoding="utf-8",
            )
            dark_path.write_text(
                f".markdown-body {{ color: {DARK_MARKER}; }}\n",
                encoding="utf-8",
            )

        with ctx.step("Custom-Light-Theme wird ohne Neustart geladen"):
            ctx.api.theme("light")
            response = ctx.api.settings_set({"viewTheme": "e2etheme"})
            ctx.expect(response.get("viewTheme") == "e2etheme", f"response={response!r}")
            state = _poll_css(ctx, "e2etheme", LIGHT_MARKER)
            ctx.expect(state.get("theme") == "e2etheme", f"theme state={state!r}")
            ctx.expect(LIGHT_MARKER in (state.get("css") or ""), f"theme state={state!r}")

        with ctx.step("Custom-Dark-Override wird geladen"):
            ctx.api.theme("dark")
            state = _poll_css(ctx, "e2etheme", DARK_MARKER)
            ctx.expect(DARK_MARKER in (state.get("css") or ""), f"theme state={state!r}")

        with ctx.step("Manifest-Font wird in View-CSS angehaengt"):
            files = _eval(ctx, "window.__folioInvoke('theme_read', { id: 'e2etheme' })")
            files["manifest"]["fontBody"] = FONT_STACK
            _eval(
                ctx,
                """window.__folioInvoke("theme_write", %s)"""
                % json.dumps(
                    {"id": "e2etheme", "files": files},
                    ensure_ascii=False,
                ),
            )
            css = _eval(
                ctx,
                "window.__folioInvoke('view_theme_css', { themeId: 'e2etheme', dark: false })",
            )
            ctx.expect(
                f"font-family: {FONT_STACK};" in (css or ""),
                f"Font-CSS fehlt: {css!r}",
            )

        with ctx.step("Traversal-ID wird abgelehnt"):
            try:
                ctx.api.settings_set({"viewTheme": "../evil"})
                ctx.expect(False, "Traversal-ID wurde akzeptiert")
            except ApiError as error:
                ctx.expect(400 <= error.status < 500, f"HTTP-Status={error.status}")
    finally:
        shutil.rmtree(package_dir, ignore_errors=True)
        light_path.unlink(missing_ok=True)
        dark_path.unlink(missing_ok=True)
        ctx.api.settings_set({"viewTheme": "standard"})
        ctx.api.theme("light")
