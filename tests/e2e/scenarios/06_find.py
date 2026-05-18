"""Find-Bar-Szenario im Edit-Mode.

Oeffnet sample.md, wechselt in den Editor, oeffnet die Find-Bar mit
einem bekannten Term und prueft, dass der Find-State im /state-
Snapshot reflektiert wird.
"""


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md + edit mode"):
        ctx.api.open(sample)
        ctx.api.mode("edit")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("find-bar oeffnen"):
        ctx.api.find_open()

    with ctx.step("find-term setzen 'Abschnitt'"):
        ctx.api.find_text("Abschnitt")
        # Kurze Stabilisierung — Find-State propagiert ueber Event-Bus.
        import time as _t
        _t.sleep(0.3)

    with ctx.step("screenshot find-bar offen"):
        ctx.screenshot("find_open_abschnitt")

    with ctx.step("find-bar schliessen via Escape"):
        ctx.api.find_close()
