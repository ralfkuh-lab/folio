"""Help-Menue-Szenario.

Testbar:
  help.cheatsheet — toggelt #cheatsheet-overlay (sichtbar/unsichtbar via
                    `hidden`-Attribut). Setzt edit-mode + kind-markdown
                    voraus (sonst no-op laut tb-cheatsheet-Handler).

Nicht testbar via Automation-API:
  help.about — der Frontend-Handler ruft `alert(...)`, das die WebView-
               JavaScript-Schleife blockiert. Wir loesen es nicht aus.
"""

import time


def _overlay_hidden(ctx) -> bool:
    snap = ctx.api.dom("#cheatsheet-overlay")
    if not snap.get("exists"):
        return True
    # Tauris /dom liefert nur explizit gesetzte Attribute. `hidden` wird
    # vom toggle als boolesches HTML-Attribut gesetzt (`.hidden = true`)
    # bzw. entfernt (`.hidden = false`). In beiden Faellen liegt der
    # Anwesenheits-Status im attributes-Dict.
    attrs = snap.get("attributes") or {}
    return "hidden" in attrs


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md + edit mode (cheatsheet braucht edit+md)"):
        ctx.api.open(sample)
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("ausgangszustand: cheatsheet versteckt"):
        # initCheatsheet startet das overlay mit hidden=true (oder
        # wantsVisible aus persistierter Position, was nach einem
        # frischen User-Profil false ist). Stellen wir sicher.
        ctx.expect(
            _overlay_hidden(ctx),
            "cheatsheet-overlay ist initial nicht hidden — frueherer "
            "Test/Persistenz hat es offen gelassen",
        )

    with ctx.step("/menu/click help.cheatsheet → overlay sichtbar"):
        ctx.api.menu_click("help.cheatsheet")
        deadline = time.monotonic() + 2.0
        shown = False
        while time.monotonic() < deadline:
            if not _overlay_hidden(ctx):
                shown = True
                break
            time.sleep(0.05)
        ctx.expect(
            shown,
            "cheatsheet-overlay wurde nach help.cheatsheet nicht sichtbar",
        )

    with ctx.step("/menu/click help.cheatsheet erneut → toggelt aus"):
        ctx.api.menu_click("help.cheatsheet")
        deadline = time.monotonic() + 2.0
        hidden_again = False
        while time.monotonic() < deadline:
            if _overlay_hidden(ctx):
                hidden_again = True
                break
            time.sleep(0.05)
        ctx.expect(
            hidden_again,
            "cheatsheet-overlay wurde nach zweitem help.cheatsheet nicht hidden",
        )
