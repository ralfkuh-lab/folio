"""Tab-Kontextmenü: Tabs rechts / Alle anderen / restore_last."""

import os
import tempfile
import time


def _poll(ctx, predicate, timeout_s: float = 3.0):
    deadline = time.monotonic() + timeout_s
    value = None
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return value


def _normalized(path: str) -> str:
    return path.replace("\\", "/")


def _tab_for_path(tabs: list, path: str) -> dict:
    n = _normalized(path)
    return next((t for t in tabs if _normalized(t.get("path") or "") == n), {})


def _doc_paths(tabs: list) -> list[str]:
    return [_normalized(t["path"]) for t in tabs if t.get("path")]


def run(ctx):
    with tempfile.TemporaryDirectory(prefix="folio-tabctx-") as td:
        file_a = os.path.join(td, "a.md")
        file_b = os.path.join(td, "b.md")
        file_c = os.path.join(td, "c.md")
        for path, body in [
            (file_a, "# A\n"),
            (file_b, "# B\n"),
            (file_c, "# C\n"),
        ]:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)

        try:
            with ctx.step("drei Tabs oeffnen"):
                ctx.api.tabs_close_all()
                ctx.api.tab_open(file_a)
                ctx.api.tab_open(file_b)
                ctx.api.tab_open(file_c)
                tabs = ctx.api.tabs().get("tabs") or []
                doc = [t for t in tabs if t.get("path")]
                ctx.expect(len(doc) == 3, f"erwartet 3 Tabs, got {tabs!r}")
                tab_a = _tab_for_path(tabs, file_a)
                tab_b = _tab_for_path(tabs, file_b)
                tab_c = _tab_for_path(tabs, file_c)
                ctx.expect(
                    bool(tab_a and tab_b and tab_c),
                    f"tabs missing: {tabs!r}",
                )

            with ctx.step("Rechtsklick mittlerer Tab oeffnet Kontextmenue"):
                script = f"""
                (function() {{
                  var el = document.querySelector('.tab-item[data-tab-id="{tab_b["id"]}"]');
                  if (!el) return {{ ok: false, reason: 'no-el' }};
                  var r = el.getBoundingClientRect();
                  el.dispatchEvent(new MouseEvent('contextmenu', {{
                    bubbles: true, cancelable: true,
                    clientX: r.left + r.width/2, clientY: r.top + r.height/2
                  }}));
                  var menu = document.getElementById('tab-ctx-menu');
                  return {{
                    ok: !!(menu && menu.classList.contains('open')),
                    items: menu ? Array.from(menu.querySelectorAll('[data-act]')).map(function(n) {{
                      return n.getAttribute('data-act');
                    }}) : []
                  }};
                }})()
                """
                result = ctx.api.eval(script)
                val = result.get("value") or {}
                ctx.expect(val.get("ok") is True, f"Menü nicht offen: {result!r}")
                ctx.expect(
                    "close-right" in (val.get("items") or []),
                    f"Items={val.get('items')!r}",
                )
                ctx.screenshot("tab_context_menu_open")

            with ctx.step("Tabs rechts schliessen via Menue"):
                click_right = """
                (function() {
                  var item = document.querySelector('#tab-ctx-menu [data-act="close-right"]');
                  if (!item || item.classList.contains('disabled')) return false;
                  item.click();
                  return true;
                })()
                """
                clicked = ctx.api.eval(click_right)
                ctx.expect(
                    clicked.get("value") is True,
                    f"close-right click={clicked!r}",
                )
                closed = _poll(
                    ctx,
                    lambda: len(
                        [
                            t
                            for t in (ctx.api.tabs().get("tabs") or [])
                            if t.get("path")
                        ]
                    )
                    == 2,
                )
                ctx.expect(bool(closed), "close-right hat Tab C nicht geschlossen")
                remaining = _doc_paths(ctx.api.tabs().get("tabs") or [])
                ctx.expect(
                    _normalized(file_c) not in remaining,
                    f"C sollte weg sein: {remaining!r}",
                )
                ctx.expect(
                    _normalized(file_a) in remaining
                    and _normalized(file_b) in remaining,
                    f"A/B sollten bleiben: {remaining!r}",
                )

            with ctx.step("Alle anderen schliessen (nur B bleibt)"):
                reopen = f"""
                (function() {{
                  var el = document.querySelector('.tab-item[data-tab-id="{tab_b["id"]}"]');
                  if (!el) return false;
                  var r = el.getBoundingClientRect();
                  el.dispatchEvent(new MouseEvent('contextmenu', {{
                    bubbles: true, cancelable: true,
                    clientX: r.left + 5, clientY: r.top + 5
                  }}));
                  var item = document.querySelector('#tab-ctx-menu [data-act="close-others"]');
                  if (!item || item.classList.contains('disabled')) return false;
                  item.click();
                  return true;
                }})()
                """
                r = ctx.api.eval(reopen)
                ctx.expect(r.get("value") is True, f"close-others={r!r}")
                only_one = _poll(
                    ctx,
                    lambda: len(
                        [
                            t
                            for t in (ctx.api.tabs().get("tabs") or [])
                            if t.get("path")
                        ]
                    )
                    == 1,
                )
                ctx.expect(
                    bool(only_one),
                    "close-others hat nicht auf einen Tab reduziert",
                )
                left = _doc_paths(ctx.api.tabs().get("tabs") or [])
                ctx.expect(
                    left == [_normalized(file_b)],
                    f"nur B erwartet: {left!r}",
                )

            with ctx.step("POST /tabs/restore_last oeffnet zuletzt geschlossenen"):
                # Stack nach close-right(C) und close-others(A): jüngster = A
                resp = ctx.api.tab_restore_last()
                ctx.expect(resp.get("ok") is True, f"restore_last={resp!r}")
                restored = _poll(
                    ctx,
                    lambda: len(
                        [
                            t
                            for t in (ctx.api.tabs().get("tabs") or [])
                            if t.get("path")
                        ]
                    )
                    == 2,
                )
                ctx.expect(
                    bool(restored),
                    "restore_last hat keinen Tab wiederhergestellt",
                )
                paths = _doc_paths(ctx.api.tabs().get("tabs") or [])
                ctx.expect(
                    _normalized(file_a) in paths,
                    f"erwartet A restored: {paths!r}",
                )
                active = next(
                    (
                        t
                        for t in (ctx.api.tabs().get("tabs") or [])
                        if t.get("active")
                    ),
                    {},
                )
                ctx.expect(
                    _normalized(active.get("path") or "") == _normalized(file_a),
                    f"restored Tab sollte aktiv sein: {active!r}",
                )
                payload = ctx.api.tabs()
                count = payload.get("recentlyClosedCount")
                ctx.expect(
                    isinstance(count, int) and count >= 0,
                    f"recentlyClosedCount fehlt: {payload!r}",
                )
        finally:
            ctx.api.tabs_close_all()
