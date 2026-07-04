"""Funktionaler Test fuer statisches Code-Highlighting im Export."""


def run(ctx):
    markdown = ctx.fixture("sample.md")

    with ctx.step("Markdown-Fixture mit Python-Codeblock oeffnen"):
        ctx.api.open(markdown)
        ctx.api.mode("view")

    with ctx.step("GitHub-Export enthaelt Inline-Highlighting und Sprachklasse"):
        response = ctx.api.eval(
            "window.__folioInvoke('export_render', {layoutId: 'github'})"
        )
        ctx.expect(
            response.get("ok") is True,
            f"export_render schlug fehl: {response!r}",
        )
        html = response.get("value")
        ctx.expect(isinstance(html, str), f"Export-HTML fehlt: {response!r}")
        ctx.expect("<span style=" in html, "Export enthaelt keine Inline-Styles")
        ctx.expect(
            'class="language-python"' in html,
            "Export enthaelt keine Python-Sprachklasse",
        )
