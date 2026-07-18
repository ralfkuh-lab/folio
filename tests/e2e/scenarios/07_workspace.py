"""Workspace-Szenario.

Verifiziert, dass nach einem `/open` der Pfad im workspace.recent
landet. Pin/Unpin-Logik wird nicht via Automation-API exponiert
(nur via Tauri-Command), insofern ist das ein read-only-Check.
"""

import time


def run(ctx):
    sample = ctx.fixture("sample.md")

    with ctx.step("open sample.md"):
        ctx.api.open(sample)

    with ctx.step("workspace.recent enthaelt sample.md"):
        # Das Frontend feuert workspace_add_recent nach document:loaded
        # asynchron (safeInvoke, fire-and-forget) — auf den Eintrag
        # pollen statt sofort nach dem /open-Ack zu lesen.
        paths = []
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            state = ctx.api.state()
            workspace = state.get("workspace", {}) or {}
            recent = workspace.get("recent", []) or []
            paths = [r.get("path") if isinstance(r, dict) else r for r in recent]
            if any(str(p).endswith("sample.md") for p in paths if p):
                break
            time.sleep(0.05)
        ctx.expect(
            any(str(p).endswith("sample.md") for p in paths if p),
            f"sample.md fehlt in workspace.recent: {paths[:5]}...",
        )
