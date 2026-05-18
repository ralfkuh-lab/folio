"""Workspace-Szenario.

Verifiziert, dass nach einem `/open` der Pfad im workspace.recent
landet. Pin/Unpin-Logik wird nicht via Automation-API exponiert
(nur via Tauri-Command), insofern ist das ein read-only-Check.
"""


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    with ctx.step("workspace.recent enthaelt sample.md"):
        state = ctx.api.state()
        workspace = state.get("workspace", {}) or {}
        recent = workspace.get("recent", []) or []
        paths = [r.get("path") if isinstance(r, dict) else r for r in recent]
        ctx.expect(
            any(str(p).endswith("sample.md") for p in paths if p),
            f"sample.md fehlt in workspace.recent: {paths[:5]}...",
        )
