"""HTML-View-Szenario.

Verifiziert, dass .html-Dateien im View-Mode als sandboxed iframe
gerendert werden statt als read-only Monaco-Codeansicht.
"""


def run(ctx):
    html = ctx.fixture("html-view.html")

    with ctx.step("open html-view.html"):
        ctx.api.open(html)
        # Mode explizit auf view zwingen: default_mode_text ist `Current`,
        # d. h. der zuletzt aktive Mode bleibt erhalten. Laeuft ein
        # vorheriges Szenario (21_split) im Split-Mode und bricht vor
        # seinem Cleanup ab, wuerde dieser Szenario sonst den Split-Mode
        # erben und der Screenshot divergiert. Test-Isolation > Leak-Glueck.
        ctx.api.mode("view")

    with ctx.step("state file gesetzt und body markiert html-preview"):
        state = ctx.api.state()
        ctx.expect(state.get("file") == html, f"file={state.get('file')!r}")
        body = ctx.api.dom("body")
        classes = (body.get("attributes") or {}).get("class", "")
        ctx.expect("kind-text" in classes, f"body.class={classes!r}")
        ctx.expect("html-preview-mode" in classes, f"body.class={classes!r}")

    with ctx.step("html iframe sichtbar, code-view vorhanden aber nicht genutzt"):
        iframe = ctx.api.dom("#html-view-frame")
        ctx.expect(iframe.get("exists") is True, "#html-view-frame fehlt")
        attrs = iframe.get("attributes") or {}
        srcdoc = (attrs.get("srcdoc") or "").lower()
        ctx.expect(
            attrs.get("sandbox") == "allow-same-origin allow-scripts",
            f"sandbox={attrs.get('sandbox')!r}",
        )
        # Foreign-Scripts raus, nur die Folio-Bridge bleibt.
        ctx.expect("data-folio-html-bridge" in srcdoc, "bridge script fehlt im srcdoc")
        ctx.expect("window.evil" not in srcdoc, "foreign script wurde nicht entfernt")
        ctx.expect("onclick=" not in srcdoc, "inline handler wurde nicht entfernt")
        ctx.expect("data-folio-href" in srcdoc, "links werden nicht ueber Folio geroutet")
        ctx.expect("about:blank#folio-link" not in srcdoc, "link fallback navigiert noch auf about:blank")

    with ctx.step("screenshot html view"):
        ctx.screenshot("html_view_default")
