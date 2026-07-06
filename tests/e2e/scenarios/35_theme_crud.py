"""CRUD-Vertrag fuer Verzeichnis-Themes ueber die Tauri-Commands."""

import json
import shutil
from pathlib import Path


THEME_ID = "e2e-theme-crud"
CSS_MARKER = "#e2c0de"


def _eval(ctx, js: str):
    response = ctx.api.eval(js, timeout_ms=10_000)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


def _themes_dir(ctx) -> Path:
    path = _eval(ctx, "window.__folioInvoke('themes_dir_path')")
    ctx.expect(isinstance(path, str) and bool(path), f"ungueltiger Theme-Pfad: {path!r}")
    return Path(path)


def run(ctx):
    themes_dir = _themes_dir(ctx)
    package_dir = themes_dir / THEME_ID

    try:
        with ctx.step("View-Mode explizit setzen und Built-in klonen"):
            ctx.api.mode("view")
            cloned = _eval(
                ctx,
                f"""window.__folioInvoke("theme_clone", {{
                    sourceId: "clean",
                    newId: {THEME_ID!r}
                }})""",
            )
            ctx.expect(cloned.get("id") == THEME_ID, f"clone={cloned!r}")
            ctx.expect(cloned.get("custom") is True, f"clone={cloned!r}")

        with ctx.step("materialisiertes Theme lesen"):
            files = _eval(
                ctx,
                f"window.__folioInvoke('theme_read', {{ id: {THEME_ID!r} }})",
            )
            ctx.expect(files.get("source") == "directory", f"files={files!r}")
            ctx.expect(bool(files.get("contentCss")), f"files={files!r}")
            ctx.expect(files.get("assets") == [], f"files={files!r}")

        with ctx.step("Manifest und CSS schreiben und erneut lesen"):
            files["manifest"]["name"] = "E2E Theme CRUD"
            files["contentCss"] = (
                files["contentCss"]
                + f"\n.markdown-body {{ border-color: {CSS_MARKER}; }}\n"
            )
            written = _eval(
                ctx,
                """window.__folioInvoke("theme_write", %s)"""
                % json.dumps(
                    {"id": THEME_ID, "files": files},
                    ensure_ascii=False,
                ),
            )
            ctx.expect(written.get("name") == "E2E Theme CRUD", f"write={written!r}")

            reread = _eval(
                ctx,
                f"window.__folioInvoke('theme_read', {{ id: {THEME_ID!r} }})",
            )
            ctx.expect(
                CSS_MARKER in (reread.get("contentCss") or ""),
                f"reread={reread!r}",
            )
            ctx.expect(
                reread.get("manifest", {}).get("name") == "E2E Theme CRUD",
                f"reread={reread!r}",
            )

        with ctx.step("Custom-Theme loeschen"):
            _eval(
                ctx,
                f"window.__folioInvoke('theme_delete', {{ id: {THEME_ID!r} }})",
            )
            ctx.expect(not package_dir.exists(), f"Theme blieb bestehen: {package_dir}")
    finally:
        try:
            _eval(
                ctx,
                f"""Promise.allSettled([
                    window.__folioInvoke("theme_delete", {{ id: {THEME_ID!r} }}),
                    window.__folioInvoke("settings_update", {{
                        patch: {{ viewTheme: "standard" }}
                    }})
                ])""",
            )
        except Exception:
            pass
        shutil.rmtree(package_dir, ignore_errors=True)
        for suffix in (".css", ".dark.css", ".page.css"):
            (themes_dir / f"{THEME_ID}{suffix}").unlink(missing_ok=True)
        ctx.api.mode("view")
