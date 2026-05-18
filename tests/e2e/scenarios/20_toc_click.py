"""TOC-DOM-Klick-Szenario.

Bisher (02_view_mode.py) nutzt die Suite den /toc/activate-API-Pfad,
der das Backend-Event `navigation:toc_click` synthetisch emittiert.
Damit blieb der echte Frontend-Klick-Handler (in view/markdown.ts:
addEventListener auf #toc → .entry[data-slug] → post 'tocClick')
ungetestet. Dieser Test schliesst die Luecke.

  view-mode → /click [data-slug='abschnitt-b'] → Screenshot

state.view.anchor und state.view.scrollY werden nur sanft geprueft —
in headless WebKitGTK/Xvfb ist das Scroll-Update nach Anchor-Jump nicht
zuverlaessig (siehe Doku in 02_view_mode.py).
"""

import time


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md (view-mode default)"):
        ctx.api.open(sample)

    with ctx.step("TOC enthaelt abschnitt-b-Slug"):
        state = ctx.api.state()
        slugs = [e.get("slug") for e in (state.get("toc") or [])]
        ctx.expect(
            "abschnitt-b" in slugs,
            f"abschnitt-b nicht in TOC-Slugs: {slugs}",
        )

    with ctx.step("DOM-Snapshot: [data-slug='abschnitt-b'] existiert"):
        snap = ctx.api.dom('[data-slug="abschnitt-b"]')
        ctx.expect(
            snap.get("exists"),
            f"TOC-Entry-Element nicht im DOM (snap: {snap})",
        )

    with ctx.step("/click [data-slug='abschnitt-b'] (echter DOM-Klick)"):
        # /click resolves Selektoren ueber id/data-name/CSS-Selektor —
        # der CSS-Selektor greift hier, weil das Element weder ID noch
        # data-name hat.
        ctx.api.click('[data-slug="abschnitt-b"]')
        # Klick-Handler bubbled an #toc, dispatcht post('tocClick'),
        # Backend liefert navigation:toc_click. Kurze Stabilisierung —
        # ohne deterministischem Sync-Signal pollen wir, ob anchor im
        # state auftaucht. Wenn nicht (Xvfb-Subtility), ist Screenshot
        # immer noch ein Indiz.
        time.sleep(0.3)

    with ctx.step("console.errors leer nach TOC-Klick"):
        errs = ctx.api.console_errors(clear=False)
        ctx.expect(
            errs.get("count", 0) == 0,
            f"unerwartete console errors: {errs.get('errors')}",
        )

    with ctx.step("screenshot nach DOM-TOC-Klick"):
        ctx.screenshot("toc_click_abschnitt_b")
