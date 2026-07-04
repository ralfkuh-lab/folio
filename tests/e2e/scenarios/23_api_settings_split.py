"""Funktionaler API-Test fuer Settings und Split-Teiler."""


def run(ctx):
    with ctx.step("Settings lesen"):
        original = ctx.api.settings_get()
        original_auto_format = original["viewAutoFormat"]

    try:
        with ctx.step("harmloses Setting aendern und per GET verifizieren"):
            changed = not original_auto_format
            ctx.api.settings_set({"viewAutoFormat": changed})
            current = ctx.api.settings_get()
            ctx.expect(
                current.get("viewAutoFormat") is changed,
                f"viewAutoFormat={current.get('viewAutoFormat')!r}, erwartet {changed!r}",
            )
    finally:
        with ctx.step("Setting auf Ursprungswert zuruecksetzen"):
            ctx.api.settings_set({"viewAutoFormat": original_auto_format})

    try:
        with ctx.step("Split-Teiler auf 65 Prozent setzen"):
            response = ctx.api.split(65)
            ctx.expect(response.get("percent") == 65, f"split response={response!r}")

        with ctx.step("GET /state liefert splitMidPercent 65"):
            state = ctx.api.state()
            ctx.expect(
                state.get("splitMidPercent") == 65,
                f"splitMidPercent={state.get('splitMidPercent')!r}, erwartet 65",
            )
    finally:
        with ctx.step("Split-Teiler auf Default 50 zuruecksetzen"):
            ctx.api.split(50)
