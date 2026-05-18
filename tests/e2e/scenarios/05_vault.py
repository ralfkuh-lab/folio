"""Vault-Szenario. Verifiziert Rail-Toggle und Rail-Sichtbarkeit
ueber den Automation-API-Stack.

Hinweis: Vault-Tree-Interaktionen (expand_dir, click on node) sind
fixture-pfad-sensitiv und schwierig zu standardisieren. Dieses
Szenario testet daher nur die Rail-/Workspace-Sichtbarkeits-Mechanik;
voll-funktionale Vault-Tests sollten gegen ein dediziertes Test-
Workspace-Verzeichnis laufen.
"""


def run(ctx):
    with ctx.step("rails sichtbar nach boot"):
        state = ctx.api.state()
        ctx.expect(
            state.get("leftRailVisible") is True,
            f"expected leftRailVisible=True, got {state.get('leftRailVisible')}",
        )

    with ctx.step("left rail toggle off"):
        ctx.api.rail("left", visible=False)
        state = ctx.api.state()
        ctx.expect(
            state.get("leftRailVisible") is False,
            f"left rail did not hide; state={state.get('leftRailVisible')}",
        )

    with ctx.step("left rail toggle on"):
        ctx.api.rail("left", visible=True)
        state = ctx.api.state()
        ctx.expect(
            state.get("leftRailVisible") is True,
            f"left rail did not reappear; state={state.get('leftRailVisible')}",
        )

    with ctx.step("screenshot rails-visible"):
        ctx.screenshot("vault_rails_visible")
