"""View-Menue-Szenario.

Testet `menu:view_*`:
  view.mode.view / edit / split → state.viewMode
  view.theme.light / dark        → state.theme
  view.rail_left / rail_right    → state.leftRailVisible / rightRailVisible
"""

import time


def _poll_state(ctx, predicate, timeout_s: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout_s
    state: dict = {}
    while time.monotonic() < deadline:
        state = ctx.api.state()
        if predicate(state):
            return state
        time.sleep(0.05)
    return state


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    # ----- view.mode.* ------------------------------------------------
    with ctx.step("/menu/click view.mode.edit → viewMode=edit"):
        ctx.api.menu_click("view.mode.edit")
        state = _poll_state(ctx, lambda s: s.get("viewMode") == "edit")
        ctx.expect(state.get("viewMode") == "edit",
                   f"viewMode={state.get('viewMode')!r}, erwartet 'edit'")
        ctx.expect_event("editor.ready", timeout_ms=10000)

    with ctx.step("/menu/click view.mode.split → viewMode=split"):
        ctx.api.menu_click("view.mode.split")
        state = _poll_state(ctx, lambda s: s.get("viewMode") == "split")
        ctx.expect(state.get("viewMode") == "split",
                   f"viewMode={state.get('viewMode')!r}, erwartet 'split'")

    with ctx.step("/menu/click view.mode.view → viewMode=view"):
        ctx.api.menu_click("view.mode.view")
        state = _poll_state(ctx, lambda s: s.get("viewMode") == "view")
        ctx.expect(state.get("viewMode") == "view",
                   f"viewMode={state.get('viewMode')!r}, erwartet 'view'")

    # ----- view.theme.* -----------------------------------------------
    with ctx.step("/menu/click view.theme.dark → theme=dark"):
        ctx.api.menu_click("view.theme.dark")
        state = _poll_state(ctx, lambda s: s.get("theme") == "dark")
        ctx.expect(state.get("theme") == "dark",
                   f"theme={state.get('theme')!r}, erwartet 'dark'")

    with ctx.step("/menu/click view.theme.light → theme=light"):
        ctx.api.menu_click("view.theme.light")
        state = _poll_state(ctx, lambda s: s.get("theme") == "light")
        ctx.expect(state.get("theme") == "light",
                   f"theme={state.get('theme')!r}, erwartet 'light'")

    # ----- view.rail_left ---------------------------------------------
    with ctx.step("ausgangszustand: leftRailVisible=true"):
        # Voraussetzung sicherstellen — sonst koennte das toggle in die
        # andere Richtung gehen.
        ctx.api.rail("left", visible=True)
        state = _poll_state(ctx, lambda s: s.get("leftRailVisible") is True)
        ctx.expect(state.get("leftRailVisible") is True,
                   "leftRailVisible nicht True nach explizitem set")

    with ctx.step("/menu/click view.rail_left toggelt → leftRailVisible=false"):
        ctx.api.menu_click("view.rail_left")
        state = _poll_state(ctx, lambda s: s.get("leftRailVisible") is False)
        ctx.expect(state.get("leftRailVisible") is False,
                   f"leftRailVisible nicht False nach toggle, ist "
                   f"{state.get('leftRailVisible')!r}")

    with ctx.step("/menu/click view.rail_left zweites Toggle → wieder true"):
        ctx.api.menu_click("view.rail_left")
        state = _poll_state(ctx, lambda s: s.get("leftRailVisible") is True)
        ctx.expect(state.get("leftRailVisible") is True,
                   f"leftRailVisible nicht True nach Re-Toggle, ist "
                   f"{state.get('leftRailVisible')!r}")

    # ----- view.rail_right --------------------------------------------
    with ctx.step("ausgangszustand: rightRailVisible=true"):
        ctx.api.rail("right", visible=True)
        state = _poll_state(ctx, lambda s: s.get("rightRailVisible") is True)
        ctx.expect(state.get("rightRailVisible") is True,
                   "rightRailVisible nicht True nach explizitem set")

    with ctx.step("/menu/click view.rail_right toggelt → rightRailVisible=false"):
        ctx.api.menu_click("view.rail_right")
        state = _poll_state(ctx, lambda s: s.get("rightRailVisible") is False)
        ctx.expect(state.get("rightRailVisible") is False,
                   f"rightRailVisible nicht False nach toggle, ist "
                   f"{state.get('rightRailVisible')!r}")
