"""Mermaid-Export (HTML) via vorgerenderte SVGs (Szenario 43).

Verifiziert (wie in spec-mermaid-export.md):
- export_mermaid_sources + renderMermaidForExport + export_html Kette via /eval
- valider Block -> <div class="mermaid-diagram"><svg ...> im Export
- kaputter Block -> bleibt language-mermaid Code-Block (Fallback)
- Nicht-Mermaid (rust) bleibt language-rust
- Keine Screenshots (kein Baseline-Impact).
- Explizites api.mode("view"), tabs etc. fuer Isolation (siehe e2e-headless-caveats.md).
- Verwendet tempfile als Export-Ziel (Python-seitig geschrieben, dann gelesen).
"""

import json
import tempfile
from pathlib import Path


def run(ctx):
    fix = ctx.fixture("mermaid-test.md")

    with ctx.step("open mermaid-test.md + View-Mode explizit"):
        ctx.api.tabs_close_all()
        ctx.api.open(fix)
        ctx.api.mode("view")

    target = Path(tempfile.gettempdir()) / "folio-43-mermaid-export.html"
    target.unlink(missing_ok=True)

    try:
        with ctx.step("export_mermaid_sources + render + export_html via /eval"):
            # 1. Quellen holen (comrak-basiert)
            src_resp = ctx.api.eval(
                'window.__folioInvoke("export_mermaid_sources")',
                timeout_ms=10_000,
            )
            ctx.expect(src_resp.get("ok") is True, f"sources failed: {src_resp!r}")
            sources = src_resp.get("value")
            ctx.expect(isinstance(sources, list) and len(sources) >= 2, f"sources: {sources!r}")

            # 2. Frontend-Render (light) -> Paare {source, svg} (exponiert in mermaid.ts)
            render_resp = ctx.api.eval(
                """(async () => {
                  const srcs = %s;
                  const fn = window.__renderMermaidForExport;
                  if (typeof fn !== 'function') throw new Error('__renderMermaidForExport not attached');
                  return await fn(srcs);
                })()"""
                % json.dumps(sources),
                timeout_ms=15000,
            )
            ctx.expect(render_resp.get("ok") is True, f"renderMermaidForExport failed: {render_resp!r}")
            entries = render_resp.get("value")
            ctx.expect(isinstance(entries, list) and len(entries) >= 2, f"entries bad: {entries!r}")

            # 3. Export nach temp (mit den Entries fuer source-match)
            exp_js = (
                "window.__folioInvoke('export_html', %s)"
                % json.dumps(
                    {
                        "layoutId": "github",
                        "targetPath": str(target),
                        "mermaidSvgs": entries,
                    },
                    ensure_ascii=False,
                )
            )
            exp_resp = ctx.api.eval(exp_js, timeout_ms=15000)
            ctx.expect(exp_resp.get("ok") is True, f"export_html failed: {exp_resp!r}")

        with ctx.step("Export-Datei pruefen"):
            ctx.expect(target.is_file(), f"Export-Datei fehlt: {target}")
            html = target.read_text(encoding="utf-8", errors="replace")

            # valider mermaid -> svg div
            ctx.expect(
                '<div class="mermaid-diagram"><svg' in html,
                "valider Mermaid-Block sollte als svg-div erscheinen",
            )

            # kaputter Block bleibt language-mermaid (Fallback)
            ctx.expect(
                'class="language-mermaid"' in html,
                "kaputter Block muss als language-mermaid Code-Block bleiben",
            )

            # rust Gegenprobe
            ctx.expect(
                'class="language-rust"' in html or "language-rust" in html,
                "Rust-Block muss language-rust bleiben",
            )

        with ctx.step("console.errors leer"):
            errs = ctx.api.console_errors(clear=False)
            ctx.expect(errs.get("count", 0) == 0, f"console errors: {errs.get('errors')}")
    finally:
        target.unlink(missing_ok=True)
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
