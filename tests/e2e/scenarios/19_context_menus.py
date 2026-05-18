"""Vault-Kontextmenue-Szenario.

Rechtsklick auf einen Vault-Tree-Eintrag oeffnet das #context-menu mit
.ctx-item-Eintraegen. Vorher war dieser Pfad ungetestet (die /rightclick-
API existierte, wurde aber von keinem Szenario benutzt).

  pin file → /rightclick auf Tree-Item
  → #context-menu.open mit .ctx-item[data-act='unpin']
  → /click auf das unpin-Item
  → file ist nicht mehr in state.workspace.pinned
  → #context-menu hat .open nicht mehr
"""

import tempfile
import time
from pathlib import Path


def _wait_dom(ctx, selector: str, timeout_s: float = 3.0, predicate=None) -> dict:
    """Pollt /dom bis das Element existiert (Default) bzw. predicate(snap)
    True liefert."""
    deadline = time.monotonic() + timeout_s
    last = {}
    while time.monotonic() < deadline:
        snap = ctx.api.dom(selector)
        last = snap
        if (predicate(snap) if predicate else snap.get("exists")):
            return snap
        time.sleep(0.05)
    return last


def _has_class(snap: dict, cls: str) -> bool:
    attrs = snap.get("attributes") or {}
    return cls in (attrs.get("class") or "").split()


def run(ctx):
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-ctxmenu-"))
    file_path = tmp / "ctxmenu-test.md"
    file_path.write_text("# ctxmenu-test\n")
    file_str = str(file_path)
    item_selector = f'#vault-tree li.node[data-path="{file_str}"]'

    with ctx.step("/workspace/pin → Tree-Eintrag im DOM"):
        ctx.api.workspace_pin(file_str, is_directory=False)
        snap = _wait_dom(ctx, item_selector)
        ctx.expect(snap.get("exists"), f"Tree-Eintrag fehlt nach pin: {snap}")

    with ctx.step("baseline: #context-menu hat .open NICHT"):
        snap = ctx.api.dom("#context-menu")
        ctx.expect(snap.get("exists"), "#context-menu nicht im DOM")
        ctx.expect(
            not _has_class(snap, "open"),
            f"#context-menu hat .open ohne Trigger: {snap.get('attributes')}",
        )

    with ctx.step("/rightclick auf Tree-Eintrag → #context-menu.open"):
        ctx.api.right_click(item_selector)
        snap = _wait_dom(
            ctx, "#context-menu",
            predicate=lambda s: _has_class(s, "open"),
        )
        ctx.expect(
            _has_class(snap, "open"),
            f"#context-menu wurde nach rightclick nicht .open: {snap.get('attributes')}",
        )

    with ctx.step("ctx-item 'unpin' existiert (file ist gepinnt)"):
        snap = _wait_dom(ctx, "#context-menu .ctx-item[data-act=\"unpin\"]")
        ctx.expect(
            snap.get("exists"),
            f"unpin-Item nicht im Kontextmenue: {snap}",
        )

    with ctx.step("/click auf unpin → Datei verlaesst pinned"):
        ctx.api.click("#context-menu .ctx-item[data-act=\"unpin\"]")
        deadline = time.monotonic() + 2.0
        unpinned = False
        while time.monotonic() < deadline:
            pinned = (ctx.api.state().get("workspace") or {}).get("pinned") or []
            if file_str not in [p.get("path") for p in pinned if isinstance(p, dict)]:
                unpinned = True
                break
            time.sleep(0.05)
        ctx.expect(unpinned, f"Datei nach ctx-item-Klick noch in pinned")

    with ctx.step("#context-menu hat .open nach Click NICHT mehr"):
        # closeContextMenu() laeuft im Click-Handler des ctxMenu.
        deadline = time.monotonic() + 1.5
        closed = False
        while time.monotonic() < deadline:
            snap = ctx.api.dom("#context-menu")
            if not _has_class(snap, "open"):
                closed = True
                break
            time.sleep(0.05)
        ctx.expect(closed, "#context-menu blieb nach ctx-item-Klick offen")
