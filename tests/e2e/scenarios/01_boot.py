"""Boot-Sanity-Check.

Ueberprueft, dass die App ueberhaupt lebt und Grundzustand sinnvoll
liefert. Macht einen Baseline-Screenshot der leeren Oberflaeche.
"""


def run(ctx):
    with ctx.step("api alive"):
        state = ctx.api.state()
        ctx.expect("title" in state, "/state did not return a title")
        ctx.expect("viewMode" in state, "/state did not return viewMode")

    with ctx.step("default viewMode == view"):
        state = ctx.api.state()
        ctx.expect(
            state["viewMode"] == "view",
            f"viewMode is {state['viewMode']!r} on cold start, expected 'view'",
        )

    with ctx.step("console.errors leer nach boot"):
        errs = ctx.api.console_errors(clear=False)
        ctx.expect(
            errs.get("count", 0) == 0,
            f"unexpected console errors after boot: {errs.get('errors')}",
        )

    with ctx.step("baseline screenshot (boot)"):
        ctx.screenshot("boot_initial")
