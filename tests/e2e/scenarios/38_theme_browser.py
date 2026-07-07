"""Settings-Theme-Browser: Detailauswahl und explizites Verwenden."""

import json
import shutil
import time
from pathlib import Path


THEME_ID = "e2e-theme-browser"


def _eval(ctx, js: str):
    response = ctx.api.eval(js, timeout_ms=10_000)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


def _themes_dir(ctx) -> Path:
    path = _eval(ctx, "window.__folioInvoke('themes_dir_path')")
    ctx.expect(isinstance(path, str) and bool(path), f"ungueltiger Theme-Pfad: {path!r}")
    return Path(path)


def _poll_view_theme(ctx, theme_id: str, timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        settings = ctx.api.settings_get()
        if settings.get("viewTheme") == theme_id:
            return True
        time.sleep(0.05)
    return False


def run(ctx):
    themes_dir = _themes_dir(ctx)
    package_dir = themes_dir / THEME_ID

    try:
        with ctx.step("View-Mode explizit setzen und Browser-Theme vorbereiten"):
            ctx.api.mode("view")
            ctx.api.settings_set({"viewTheme": "standard"})
            _eval(
                ctx,
                f"""window.__folioInvoke("theme_clone", {{
                    sourceId: "clean",
                    newId: {THEME_ID!r}
                }})""",
            )
            files = _eval(
                ctx,
                f"window.__folioInvoke('theme_read', {{ id: {THEME_ID!r} }})",
            )
            files["manifest"]["name"] = "E2E Theme Browser"
            files["manifest"]["description"] = "Detailauswahl im Settings-Browser"
            _eval(
                ctx,
                """window.__folioInvoke("theme_write", %s)"""
                % json.dumps(
                    {"id": THEME_ID, "files": files},
                    ensure_ascii=False,
                ),
            )

        with ctx.step("Settings-Themes oeffnen und Detail per /eval auswaehlen"):
            ctx.api.menu_click("edit.settings")
            ctx.api.click("settings-tab-themes")
            _eval(
                ctx,
                f"""(() => {{
                    const card = document.querySelector(
                        '[data-view-theme="{THEME_ID}"]'
                    );
                    if (!card) throw new Error("Theme-Karte fehlt");
                    card.click();
                    return true;
                }})()""",
            )
            detail_text = _eval(
                ctx,
                """(() => {
                    const detail = document.getElementById("settings-theme-detail");
                    return detail ? detail.textContent : "";
                })()""",
            )
            ctx.expect("E2E Theme Browser" in detail_text, f"Detail fehlt: {detail_text!r}")

        with ctx.step("Ansichts-Theme ausschliesslich ueber Detail-Button setzen"):
            ctx.api.click("settings-theme-use")
            ctx.expect(
                _poll_view_theme(ctx, THEME_ID),
                f"viewTheme wurde nicht auf {THEME_ID!r} gesetzt",
            )

        with ctx.step("Screenshot des Browser-Details"):
            ctx.api.sync_render()
            ctx.screenshot("theme_browser_detail")
    finally:
        try:
            _eval(
                ctx,
                f"""Promise.allSettled([
                    window.__folioInvoke("settings_update", {{
                        patch: {{ viewTheme: "standard" }}
                    }}),
                    window.__folioInvoke("theme_delete", {{ id: {THEME_ID!r} }})
                ])""",
            )
        except Exception:
            pass
        shutil.rmtree(package_dir, ignore_errors=True)
        for suffix in (".css", ".dark.css", ".page.css"):
            (themes_dir / f"{THEME_ID}{suffix}").unlink(missing_ok=True)
        ctx.api.mode("view")
