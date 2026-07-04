"""Etappe T5: Oeffnen-Integration der Tabs.

Funktional, kein Screenshot:
  - Setting openFileTarget: Roundtrip + Ablehnung unbekannter Werte.
  - Vault: Ctrl+Klick und Mittelklick (auxclick) auf eine Datei-Row
    oeffnen einen NEUEN Tab; normaler Klick ersetzt im aktiven Tab.
  - Kontextmenue-Item "In neuem Tab oeffnen".
Der cli:open-Zweig (Single-Instance-Reinvoke) ist backendseitig
implementiert und wird ausserhalb der Suite headless verifiziert —
eine zweite Instanz wuerde hier mit dem Wrapper-Vorabcheck kollidieren.
"""

import tempfile
import time
from pathlib import Path

from lib.api import ApiError


def _poll(ctx, predicate, timeout_s: float = 3.0):
    deadline = time.monotonic() + timeout_s
    value = None
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return value


def _tab_paths(ctx) -> list:
    return [t.get("path") for t in (ctx.api.tabs().get("tabs") or [])]


def _dispatch_row_mouse(ctx, file_str: str, event: str, extra_init: str) -> dict:
    js = f"""(() => {{
        const node = document.querySelector('#vault-tree li.node[data-path="{file_str}"] .row');
        if (!node) return {{ ok: false, reason: 'row fehlt' }};
        node.dispatchEvent(new MouseEvent('{event}', {{
            bubbles: true, cancelable: true, {extra_init}
        }}));
        return {{ ok: true }};
    }})()"""
    return ctx.api.eval(js)


def run(ctx):
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-opentarget-"))
    file_a = tmp / "target-a.md"
    file_b = tmp / "target-b.md"
    file_c = tmp / "target-c.md"
    for f, title in ((file_a, "A"), (file_b, "B"), (file_c, "C")):
        f.write_text(f"# Datei {title}\n", encoding="utf-8")
    a_str = str(file_a).replace("\\", "/")
    b_str = str(file_b).replace("\\", "/")
    c_str = str(file_c).replace("\\", "/")

    try:
        with ctx.step("Setting openFileTarget: Default + Roundtrip + 4xx"):
            current = ctx.api.settings_get()
            ctx.expect(
                current.get("openFileTarget") == "newtab",
                f"Default ist nicht newtab: {current.get('openFileTarget')!r}",
            )
            updated = ctx.api.settings_set({"openFileTarget": "replace"})
            ctx.expect(updated.get("openFileTarget") == "replace", f"{updated!r}")
            ctx.api.settings_set({"openFileTarget": "newtab"})
            try:
                ctx.api.settings_set({"openFileTarget": "popup"})
                ctx.expect(False, "ungueltiger openFileTarget wurde akzeptiert")
            except ApiError as error:
                ctx.expect(400 <= error.status < 500, f"HTTP-Status={error.status}")

        with ctx.step("Fixtures pinnen + Datei A regulaer oeffnen"):
            ctx.api.workspace_pin(a_str, is_directory=False)
            ctx.api.workspace_pin(b_str, is_directory=False)
            ctx.api.workspace_pin(c_str, is_directory=False)
            ctx.api.open(a_str)
            ctx.api.mode("view")
            paths = _poll(ctx, lambda: _tab_paths(ctx) if a_str in _tab_paths(ctx) else None)
            ctx.expect(paths and len(paths) == 1, f"unerwartete Tabs: {paths!r}")

        with ctx.step("Ctrl+Klick im Vault oeffnet Datei B als neuen Tab"):
            result = _dispatch_row_mouse(ctx, b_str, "click", "button: 0, ctrlKey: true")
            ctx.expect(result.get("ok") is True, f"eval: {result!r}")
            paths = _poll(
                ctx,
                lambda: _tab_paths(ctx) if b_str in _tab_paths(ctx) else None,
            )
            ctx.expect(paths == [a_str, b_str], f"Tabs nach Ctrl+Klick: {paths!r}")

        with ctx.step("Mittelklick (auxclick) oeffnet Datei C als neuen Tab"):
            result = _dispatch_row_mouse(ctx, c_str, "auxclick", "button: 1")
            ctx.expect(result.get("ok") is True, f"eval: {result!r}")
            paths = _poll(
                ctx,
                lambda: _tab_paths(ctx) if c_str in _tab_paths(ctx) else None,
            )
            ctx.expect(c_str in (paths or []) and len(paths) == 3,
                       f"Tabs nach Mittelklick: {paths!r}")

        with ctx.step("Normaler Vault-Klick ersetzt im aktiven Tab (kein 4. Tab)"):
            result = _dispatch_row_mouse(ctx, a_str, "click", "button: 0")
            ctx.expect(result.get("ok") is True, f"eval: {result!r}")
            # Datei A ist bereits als Tab offen — openDocument ersetzt im
            # aktiven Tab; die Tab-Anzahl darf nicht wachsen.
            time.sleep(0.3)
            paths = _tab_paths(ctx)
            ctx.expect(len(paths) == 3, f"Tab-Anzahl gewachsen: {paths!r}")

        with ctx.step("Kontextmenue: 'In neuem Tab oeffnen' vorhanden"):
            ctx.api.tabs_close_all()
            ctx.api.open(a_str)
            ctx.api.right_click(f'#vault-tree li.node[data-path="{b_str}"]')
            item = _poll(
                ctx,
                lambda: (
                    ctx.api.dom('#context-menu .ctx-item[data-act="open-newtab"]')
                    if ctx.api.dom(
                        '#context-menu .ctx-item[data-act="open-newtab"]'
                    ).get("exists")
                    else None
                ),
            )
            ctx.expect(bool(item), "ctx-item open-newtab fehlt")
            ctx.api.click('#context-menu .ctx-item[data-act="open-newtab"]')
            paths = _poll(
                ctx,
                lambda: _tab_paths(ctx) if b_str in _tab_paths(ctx) else None,
            )
            ctx.expect(paths == [a_str, b_str], f"Tabs nach ctx-open: {paths!r}")
    finally:
        ctx.api.tabs_close_all()
        for p in (a_str, b_str, c_str):
            try:
                ctx.api.workspace_unpin(p)
            except Exception:
                pass
        ctx.api.settings_set({"openFileTarget": "newtab"})
