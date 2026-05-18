"""View-Mode-Szenario.

Oeffnet eine Test-Fixture-MD, prueft TOC-Aufbau, springt zu einem
Anchor und macht zwei visuelle Vergleiche (default + nach TOC-Sprung).
"""


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        # /open ist synchron: Backend laedt das Dokument vor der HTTP-
        # Antwort. document.loaded feuert dabei BEFORE wait registriert
        # sein kann — kein Event-Wait, sondern direkter State-Check.
        ctx.api.open(sample)
        state = ctx.api.state()
        ctx.expect(
            (state.get("file") or "").endswith("sample.md"),
            f"state.file is {state.get('file')!r} after /open",
        )

    with ctx.step("state spiegelt Dokument"):
        state = ctx.api.state()
        ctx.expect(
            (state.get("file") or "").endswith("sample.md"),
            f"state.file is {state.get('file')!r}, expected sample.md",
        )
        ctx.expect(state["viewMode"] == "view", "expected view mode after open")
        ctx.expect(
            state.get("dirty") is False,
            f"expected dirty=False on freshly opened doc, got {state.get('dirty')}",
        )

    with ctx.step("TOC hat erwartete Eintraege"):
        state = ctx.api.state()
        toc = state.get("toc") or []
        ctx.expect(len(toc) >= 4, f"TOC too short: {len(toc)} entries")
        labels = [t.get("text") or t.get("title") or "" for t in toc]
        ctx.expect(
            any("Abschnitt A" in l for l in labels),
            f"TOC missing 'Abschnitt A': {labels}",
        )

    with ctx.step("screenshot default view"):
        ctx.screenshot("view_default")

    with ctx.step("anchor scroll zu Abschnitt B"):
        # Anchor ist der slugifierte Heading-Text (heading_anchor.rs).
        ctx.api.toc_activate("abschnitt-b")

    with ctx.step("screenshot nach anchor jump"):
        # Headless-WebKitGTK liefert scrollY == 0 trotz erfolgreichem
        # TOC-Click — der Jump funktioniert, aber der Scroll-State ist
        # in Xvfb nicht zuverlaessig. Screenshot statt numerischer Pruefung.
        ctx.screenshot("view_anchor_b")
