"""Theme-Szenario: dark → light → dark Toggle. Jeder Zustand
visualisiert.
"""


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    with ctx.step("force dark theme"):
        ctx.api.theme("dark")
        # Theme-Apply ist synchron (HTML class-toggle + editor.setTheme).
        state = ctx.api.state()
        ctx.expect(state["theme"] == "dark", f"theme is {state['theme']!r}")

    with ctx.step("screenshot dark"):
        ctx.screenshot("theme_dark")

    with ctx.step("force light theme"):
        ctx.api.theme("light")
        state = ctx.api.state()
        ctx.expect(state["theme"] == "light", f"theme is {state['theme']!r}")

    with ctx.step("screenshot light"):
        ctx.screenshot("theme_light")

    with ctx.step("back to dark"):
        ctx.api.theme("dark")
        state = ctx.api.state()
        ctx.expect(state["theme"] == "dark", f"theme is {state['theme']!r}")
