"""Mermaid-Diagramme in Markdown-View (Szenario 42).

Verifiziert:
- ```mermaid``` Fence wird zu .mermaid-diagram svg gerendert.
- Andere Code-Bloecke (rust) bleiben als pre code.language-rust erhalten.
- Keine Screenshots (kein Baseline-Impact).
- Explizites api.mode("view") fuer Isolation.
"""

def run(ctx):
    fix = ctx.fixture("mermaid-test.md")

    with ctx.step("open mermaid-test.md + View-Mode explizit"):
        ctx.api.open(fix)
        # default_mode_* ist Current — explizit setzen, sonst Leak aus
        # Vor-Szenario moeglich (vgl. e2e-headless-caveats.md).
        ctx.api.mode("view")

    with ctx.step("state: kind-markdown und Datei korrekt"):
        st = ctx.api.state()
        ctx.expect(st.get("file") == fix, f"file={st.get('file')!r}")
        bodyCls = ((ctx.api.dom("body").get("attributes") or {}).get("class") or "")
        ctx.expect("kind-markdown" in bodyCls, f"body.class={bodyCls!r}")

    with ctx.step("mermaid-diagram svg vorhanden (via /dom, Bundle-Ready-Poll)"):
        # Erster Lazy-Load des 3.3MB-Bundles kann unter Xvfb-Last mehrere
        # Sekunden dauern. ACHTUNG: /dom-timeoutMs wartet nur auf die
        # Snapshot-Antwort des Frontends, NICHT auf das Erscheinen des
        # Selektors — deshalb hier ein echter Retry-Poll (TODO-Eintrag
        # "42_mermaid flaky", ausgeloest 2026-07-25).
        import time
        deadline = time.monotonic() + 15.0
        d = {}
        while time.monotonic() < deadline:
            d = ctx.api.dom(".markdown-body .mermaid-diagram svg")
            if d.get("exists") is True:
                break
            time.sleep(0.5)
        ctx.expect(d.get("exists") is True, f"mermaid svg nicht gefunden (15s-Poll): {d}")

    with ctx.step("Rust-Fence bleibt pre code.language-rust (kein Mermaid)"):
        r = ctx.api.dom(".markdown-body pre code.language-rust")
        ctx.expect(r.get("exists") is True, f"rust code block fehlt: {r}")
        # Die Fixture enthaelt einen validen UND einen kaputten Mermaid-
        # Block (fuer den Export-Fallback in 43): der valide wird durch
        # div.mermaid-diagram ersetzt (Step oben), der kaputte bleibt
        # bewusst als pre stehen und traegt einen .mermaid-error-Hinweis.
        mpre = ctx.api.dom(".markdown-body pre code.language-mermaid")
        ctx.expect(mpre.get("exists") is True, "kaputter mermaid-Block sollte als pre bleiben")
        # Gleicher Poll wie beim svg — der Error-Hinweis entsteht im selben
        # Render-Durchlauf, kann aber einen Tick spaeter im DOM sein.
        import time
        deadline = time.monotonic() + 5.0
        merr = {}
        while time.monotonic() < deadline:
            merr = ctx.api.dom(".markdown-body .mermaid-error")
            if merr.get("exists") is True:
                break
            time.sleep(0.5)
        ctx.expect(merr.get("exists") is True, f"mermaid-error-Hinweis fehlt (5s-Poll): {merr}")

    with ctx.step("console.errors leer"):
        errs = ctx.api.console_errors(clear=False)
        ctx.expect(errs.get("count", 0) == 0, f"console errors: {errs.get('errors')}")
