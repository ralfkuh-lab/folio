"""Vault-Tree-Klick-Szenario.

Testet, dass der Vault-Tree-Klick-Pfad (DOM-Listener in
`vault/tree.ts`) tatsaechlich funktioniert: eine Datei pinnen, dann
echten DOM-Klick auf den Tree-Eintrag → openDocument-Trigger →
state.file zeigt auf die Datei.

Vorher war im Vault nur `/workspace/pin` als Phase-0-Endpoint
abgedeckt; die Klick-Route, die ein User dauerhaft nutzt, war komplett
ungetestet.
"""

import tempfile
import time
from pathlib import Path


def _wait_dom_path(ctx, path: str, timeout_s: float = 3.0) -> dict:
    """Pollt das Vault-Tree, bis ein Eintrag mit data-path=path
    existiert (sichtbar nach vault:refresh-Roundtrip)."""
    selector = f'#vault-tree li.node[data-path="{path}"]'
    deadline = time.monotonic() + timeout_s
    last = {}
    while time.monotonic() < deadline:
        snap = ctx.api.dom(selector)
        last = snap
        if snap.get("exists"):
            return snap
        time.sleep(0.1)
    return last


def _wait_file_state(ctx, expected_basename: str, timeout_s: float = 2.0):
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        f = ctx.api.state().get("file")
        last = f
        if f and expected_basename in f:
            return f
        time.sleep(0.05)
    return last


def run(ctx):
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-vault-"))
    file_path = tmp / "vault-tree-test.md"
    file_path.write_text("# vault-tree-test\n")
    # Folio normalisiert Pfade intern auf Forward-Slashes (auch im
    # data-path-Attribut), damit CSS-Selektoren auf Windows nicht ueber
    # Backslash-Escapes (`\U` etc.) stolpern. Test-Selektor muss daher
    # ebenfalls Forward-Slashes nutzen.
    file_str = str(file_path).replace("\\", "/")
    selector = f'#vault-tree li.node[data-path="{file_str}"]'

    with ctx.step("baseline: keine Test-Datei im DOM"):
        snap = ctx.api.dom(selector)
        ctx.expect(
            not snap.get("exists"),
            f"Test-Datei taucht ohne pin schon im Vault auf: {snap}",
        )

    with ctx.step("/workspace/pin schiebt Datei in Pinned-Section"):
        ctx.api.workspace_pin(file_str, is_directory=False)
        snap = _wait_dom_path(ctx, file_str)
        ctx.expect(
            snap.get("exists"),
            f"Vault-Tree-Eintrag fehlt nach pin (selector={selector}): {snap}",
        )
        ctx.expect(
            (snap.get("attributes") or {}).get("data-kind") == "file",
            f"data-kind sollte 'file' sein, ist {snap.get('attributes')!r}",
        )

    with ctx.step("/click auf den Vault-Eintrag → state.file gesetzt"):
        # /click resolved CSS-Selektoren als Fallback. Der Frontend-
        # Klick-Listener in vault/tree.ts greift entweder ueber den
        # Hauptbaum-Handler (ROW-Walk) oder ueber den
        # .vault-item-Listener — beide enden in deps.openDocument(path).
        ctx.api.click(f"{selector} .row")
        f = _wait_file_state(ctx, "vault-tree-test.md")
        ctx.expect(
            f and "vault-tree-test.md" in f,
            f"state.file zeigt nicht auf die geklickte Datei: {f!r}",
        )

    with ctx.step("cleanup: /workspace/unpin"):
        ctx.api.workspace_unpin(file_str)
        # Kurzer Poll, damit kein leakage in andere Tests.
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            pinned = (ctx.api.state().get("workspace") or {}).get("pinned") or []
            if file_str not in [p.get("path") for p in pinned if isinstance(p, dict)]:
                break
            time.sleep(0.05)
