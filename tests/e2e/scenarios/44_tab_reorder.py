"""API-level test for POST /tabs/reorder (Tab-Drag-Reorder).

Covers backend TabManager::reorder + command + automation endpoint.
Verifies order via GET /tabs and via /dom (data-tab-id sequence).
No synthetic pointer drag (see e2e-headless-caveats); vitest covers the UI drag.
"""

import re
import tempfile
import os

from lib.api import ApiError


def run(ctx):
    initial = ctx.api.state().get("file")
    try:
        with ctx.step("close_all + open three distinct doc tabs via API"):
            ctx.api.tabs_close_all()
            with tempfile.TemporaryDirectory() as td:
                fa = os.path.join(td, "a.md")
                fb = os.path.join(td, "b.md")
                fc = os.path.join(td, "c.md")
                for p, body in [(fa, "# A"), (fb, "# B"), (fc, "# C")]:
                    with open(p, "w", encoding="utf-8") as f:
                        f.write(body)

                ctx.api.tab_open(fa)
                ctx.api.tab_open(fb)
                ctx.api.tab_open(fc)

                tabs = ctx.api.tabs().get("tabs") or []
                ctx.expect(len(tabs) == 3, f"expected 3 tabs, got {len(tabs)}: {tabs}")
                ids = [t["id"] for t in tabs]
                ctx.expect(len(set(ids)) == 3, f"non-unique ids: {ids}")
                active_id_before = next(t["id"] for t in tabs if t.get("active"))

                # initial order from open sequence
                initial_ids = ids[:]

                with ctx.step("POST /tabs/reorder with reversed order"):
                    reversed_ids = list(reversed(initial_ids))
                    resp = ctx.api.tab_reorder(reversed_ids)
                    ctx.expect(resp.get("ok") is True, f"reorder resp={resp!r}")

                with ctx.step("GET /tabs reflects new order"):
                    after = ctx.api.tabs().get("tabs") or []
                    after_ids = [t["id"] for t in after]
                    ctx.expect(after_ids == reversed_ids, f"tabs order {after_ids} != {reversed_ids}")
                    # Reorder darf die AKTIVITAET nicht verschieben: derselbe
                    # Tab (Identitaet per ID) bleibt aktiv, egal wo er landet.
                    active_id_after = next(t["id"] for t in after if t.get("active"))
                    ctx.expect(
                        active_id_after == active_id_before,
                        f"aktiver Tab wechselte durch Reorder: {active_id_before} -> {active_id_after}",
                    )

                with ctx.step("DOM order of .tab-item data-tab-id matches"):
                    # /dom liefert kein innerHTML — Reihenfolge per /eval lesen.
                    # Virtuelle Tabs (Settings/Theme-Editor) tragen ihren Slug in
                    # data-tab-id — nur numerische IDs sind Dokument-Tabs.
                    resp = ctx.api.eval(
                        "Array.from(document.querySelectorAll("
                        "'#tab-bar .tab-item[data-tab-id]'))"
                        ".map(function(e){return e.getAttribute('data-tab-id')})"
                        ".filter(function(v){return /^[0-9]+$/.test(v)})"
                        ".map(function(v){return parseInt(v,10)})"
                    )
                    dom_ids = resp.get("value") or []
                    ctx.expect(dom_ids == reversed_ids, f"dom tab order {dom_ids} != {reversed_ids}")

                with ctx.step("invalid reorder is rejected (400)"):
                    try:
                        ctx.api.tab_reorder([999999, 1])
                        ctx.expect(False, "invalid reorder ids accepted")
                    except ApiError as err:
                        ctx.expect(400 <= err.status < 500, f"bad reorder status {err.status}")

                with ctx.step("restore original order still works"):
                    ctx.api.tab_reorder(initial_ids)
                    back = ctx.api.tabs().get("tabs") or []
                    back_ids = [t["id"] for t in back]
                    ctx.expect(back_ids == initial_ids, f"restore failed: {back_ids}")

    finally:
        ctx.api.tabs_close_all()
        if initial:
            try:
                ctx.api.open(initial, discard=True)
            except Exception:
                pass
