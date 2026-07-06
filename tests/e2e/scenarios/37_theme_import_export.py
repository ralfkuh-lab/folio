"""Theme-Import/Export-Roundtrip ueber .mdtheme und path-Parameter."""

import json
import shutil
import tempfile
from pathlib import Path


SOURCE_ID = "e2e-theme-export-source"
IMPORTED_ID = "e2e-theme-imported"
MARKER = "#37e7aa"


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
    export_path = Path(tempfile.gettempdir()) / f"{IMPORTED_ID}.mdtheme"

    try:
        with ctx.step("View-Mode explizit setzen und Quell-Theme vorbereiten"):
            ctx.api.mode("view")
            _eval(
                ctx,
                f"""window.__folioInvoke("theme_clone", {{
                    sourceId: "clean",
                    newId: {SOURCE_ID!r}
                }})""",
            )
            files = _eval(
                ctx,
                f"window.__folioInvoke('theme_read', {{ id: {SOURCE_ID!r} }})",
            )
            files["manifest"]["name"] = "E2E Theme Import Export"
            files["contentCss"] = (
                files["contentCss"]
                + f"\n.markdown-body {{ outline-color: {MARKER}; }}\n"
            )
            _eval(
                ctx,
                """window.__folioInvoke("theme_write", %s)"""
                % json.dumps(
                    {"id": SOURCE_ID, "files": files},
                    ensure_ascii=False,
                ),
            )

        with ctx.step("Theme per path-Parameter exportieren"):
            result = _eval(
                ctx,
                f"""window.__folioInvoke("theme_export", {{
                    id: {SOURCE_ID!r},
                    path: {str(export_path)!r}
                }})""",
            )
            ctx.expect(result == str(export_path), f"export={result!r}")
            ctx.expect(export_path.is_file(), f"Export-Datei fehlt: {export_path}")

        with ctx.step("Theme per path-Parameter importieren"):
            imported = _eval(
                ctx,
                f"""window.__folioInvoke("theme_import", {{
                    path: {str(export_path)!r}
                }})""",
            )
            ctx.expect(imported.get("id") == IMPORTED_ID, f"import={imported!r}")
            ctx.expect(imported.get("custom") is True, f"import={imported!r}")

            reread = _eval(
                ctx,
                f"window.__folioInvoke('theme_read', {{ id: {IMPORTED_ID!r} }})",
            )
            ctx.expect(
                reread.get("manifest", {}).get("name") == "E2E Theme Import Export",
                f"reread={reread!r}",
            )
            ctx.expect(MARKER in (reread.get("contentCss") or ""), f"reread={reread!r}")
    finally:
        try:
            _eval(
                ctx,
                f"""Promise.allSettled([
                    window.__folioInvoke("theme_delete", {{ id: {SOURCE_ID!r} }}),
                    window.__folioInvoke("theme_delete", {{ id: {IMPORTED_ID!r} }}),
                    window.__folioInvoke("settings_update", {{
                        patch: {{ viewTheme: "standard" }}
                    }})
                ])""",
            )
        except Exception:
            pass
        for theme_id in (SOURCE_ID, IMPORTED_ID):
            shutil.rmtree(themes_dir / theme_id, ignore_errors=True)
            for suffix in (".css", ".dark.css", ".page.css"):
                (themes_dir / f"{theme_id}{suffix}").unlink(missing_ok=True)
        export_path.unlink(missing_ok=True)
        ctx.api.mode("view")
