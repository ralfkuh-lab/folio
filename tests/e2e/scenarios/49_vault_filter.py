"""E2E: Vault-Tree-Filter R3/R3.1 — clientseitiger Namensfilter + Baum-Ops.

Fixture-Ordner mit MD/Nicht-MD/Unterordnern; Filterzeile per Klick öffnen,
Query per /eval + input-Event. Asserts: Nicht-Treffer-Dateien weg (vf-hidden),
Ordner da, vf-hit; expand-roots öffnet nur Pin-Wurzeln; Alles-einklappen;
Zeilen-X räumt auf. Baselines erneuert der Orchestrator.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _evalv(ctx, js: str):
    return ctx.api.eval(js).get("value")


def _poll(ctx, fn, timeout: float = 5.0, interval: float = 0.1):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _tree_html(ctx) -> str:
    # Nur die Pinned-Section: die Recent-Liste enthaelt die im Setup
    # geoeffnete Alpha.md dauerhaft — ungescopte Negativ-Asserts
    # ("X not in tree") wuerden daran ewig scheitern (Lektion aus R1,
    # von der R3-Neufassung kurz wieder eingerissen).
    return (
        _evalv(
            ctx,
            "document.querySelector('#vault-tree li.section"
            "[data-section=\"pinned\"]')?.innerHTML||''",
        )
        or ""
    )


def _filter_bar_open(ctx) -> bool:
    return _evalv(ctx, "!document.getElementById('vault-filter')?.hidden") is True


def _set_query(ctx, query: str) -> None:
    js = (
        "(function(){var el=document.getElementById('vault-filter-input');"
        "if(!el)return false;el.value=%s;"
        "el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()"
        % json.dumps(query)
    )
    ctx.expect(_evalv(ctx, js) is True, "Filter-Input nicht gesetzt")


def _file_hidden(ctx, name: str) -> bool:
    """True if a visible file node with that label is vf-hidden (or absent as visible)."""
    js = (
        "(function(){"
        "var nodes=document.querySelectorAll('#vault-tree li.node[data-kind=\"file\"]');"
        "var found=false,hidden=true;"
        "for(var i=0;i<nodes.length;i++){"
        "var lab=nodes[i].querySelector(':scope > .row > .label');"
        "if(!lab||lab.textContent!==%s)continue;"
        "found=true;"
        "if(!nodes[i].classList.contains('vf-hidden')){hidden=false;break;}"
        "}"
        "return found?hidden:true;"
        "})()" % json.dumps(name)
    )
    return _evalv(ctx, js) is True


def _dir_visible(ctx, name: str) -> bool:
    js = (
        "(function(){"
        "var nodes=document.querySelectorAll('#vault-tree li.node[data-kind=\"dir\"]');"
        "for(var i=0;i<nodes.length;i++){"
        "var lab=nodes[i].querySelector(':scope > .row > .label');"
        "if(lab&&lab.textContent===%s&&!nodes[i].classList.contains('vf-hidden'))"
        "return true;"
        "}"
        "return false;})()" % json.dumps(name)
    )
    return _evalv(ctx, js) is True


def _file_visible(ctx, name: str) -> bool:
    js = (
        "(function(){"
        "var nodes=document.querySelectorAll('#vault-tree li.node[data-kind=\"file\"]');"
        "for(var i=0;i<nodes.length;i++){"
        "var lab=nodes[i].querySelector(':scope > .row > .label');"
        "if(lab&&lab.textContent===%s&&!nodes[i].classList.contains('vf-hidden'))"
        "return true;"
        "}"
        "return false;})()" % json.dumps(name)
    )
    return _evalv(ctx, js) is True


def _has_vf_hit(ctx) -> bool:
    return _evalv(ctx, "!!document.querySelector('#vault-tree .vf-hit')") is True


def _click_id(ctx, el_id: str) -> None:
    ctx.api.eval(
        "document.getElementById(%s)"
        ".dispatchEvent(new MouseEvent('click',{bubbles:true}))" % json.dumps(el_id)
    )


def run(ctx):
    tmp = tempfile.mkdtemp(prefix="folio-e2e-vfilter-")
    root = os.path.join(tmp, "vault")
    _write(os.path.join(root, "Alpha.md"), "# A\n")
    _write(os.path.join(root, "Beta.md"), "# B\n")
    _write(os.path.join(root, "notes.txt"), "plain\n")
    _write(os.path.join(root, "Notes", "deep", "file.md"), "# deep\n")
    _write(os.path.join(root, "Notes", "deep", "skip.txt"), "x\n")
    _write(os.path.join(root, "empty_branch", "only.txt"), "y\n")

    root_norm = root.replace("\\", "/")

    try:
        with ctx.step("pin fixture folder"):
            # Vorzustand-Leak abwehren: Vault-Suche aus 47 leckt sonst in die Rail.
            ctx.api.eval(
                "(function(){var x=document.getElementById('vault-search-exit');"
                "if(x&&x.offsetParent)x.dispatchEvent("
                "new MouseEvent('click',{bubbles:true}));})()"
            )
            ctx.api.workspace_pin(root, is_directory=True)
            sample = os.path.join(root, "Alpha.md")
            ctx.api.open(sample)
            ctx.api.mode("view")
            ctx.api.sync_render()

        with ctx.step("expand pinned folder (lazy)"):
            js = (
                "(function(){var n=document.querySelector("
                "'#vault-tree li.node[data-path=%s] > .row');"
                "if(!n)return false;"
                "n.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
                "return true;})()" % json.dumps(root_norm)
            )
            ctx.expect(_evalv(ctx, js) is True, "Pin-Ordner-Row nicht gefunden")
            ok = _poll(
                ctx,
                lambda: "Alpha.md" in _tree_html(ctx)
                and "notes.txt" in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(ok, f"Lazy-Expand zeigt Kinder nicht: {_tree_html(ctx)[:400]}")
            ctx.api.sync_render()

        with ctx.step("open filter bar via funnel click"):
            _click_id(ctx, "vault-filter-toggle")
            ctx.expect(
                _poll(ctx, lambda: _filter_bar_open(ctx)),
                "Filterzeile öffnet nicht",
            )
            ctx.api.sync_render()
            ctx.screenshot("49_filter_bar_open")

        with ctx.step("name filter: Alpha match, Beta/notes hidden; folders stay"):
            _set_query(ctx, "alp")
            ok = _poll(
                ctx,
                lambda: _file_visible(ctx, "Alpha.md")
                and _file_hidden(ctx, "Beta.md")
                and _file_hidden(ctx, "notes.txt")
                and _dir_visible(ctx, "Notes")
                and _dir_visible(ctx, "empty_branch")
                and _has_vf_hit(ctx),
                timeout=4.0,
            )
            ctx.expect(
                ok,
                f"Filter DOM falsch: Alpha={_file_visible(ctx,'Alpha.md')} "
                f"Beta_hidden={_file_hidden(ctx,'Beta.md')} "
                f"hit={_has_vf_hit(ctx)} html={_tree_html(ctx)[:400]}",
            )
            # Recent bleibt im DOM (kein .filtering)
            recent_display = _evalv(
                ctx,
                "getComputedStyle(document.querySelector("
                "'#vault-tree li.section[data-section=\"recent\"]')"
                "||document.createElement('li')).display",
            )
            ctx.expect(
                recent_display != "none",
                f"Recent sollte sichtbar bleiben, display={recent_display!r}",
            )
            ctx.api.sync_render()
            ctx.screenshot("49_filter_name_match")

        with ctx.step("expand roots opens only first level; button disables"):
            # Pin ist aus vorherigem Step offen → erst collapse, dann expand-roots.
            _click_id(ctx, "vault-collapse-all")
            ok = _poll(
                ctx,
                lambda: "Alpha.md" not in _tree_html(ctx)
                and (
                    root_norm in _tree_html(ctx)
                    or os.path.basename(root) in _tree_html(ctx)
                ),
                timeout=4.0,
            )
            ctx.expect(ok, f"pre-expand collapse: {_tree_html(ctx)[:400]}")
            enabled = _poll(
                ctx,
                lambda: _evalv(
                    ctx,
                    "!document.getElementById('vault-expand-roots')?.disabled",
                )
                is True,
                timeout=2.0,
            )
            ctx.expect(enabled, "expand-roots sollte nach collapse enabled sein")

            _click_id(ctx, "vault-expand-roots")
            # Erste Ebene sichtbar (Alpha.md, Notes), verschachteltes deep bleibt zu.
            ok = _poll(
                ctx,
                lambda: "Alpha.md" in _tree_html(ctx)
                and _dir_visible(ctx, "Notes")
                and "file.md" not in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(
                ok,
                f"expand-roots: erste Ebene fehlt oder deep schon offen: "
                f"{_tree_html(ctx)[:500]}",
            )
            # deep-Ordner darf nicht expandiert sein (kein caret open auf deep).
            deep_open = _evalv(
                ctx,
                "(function(){"
                "var n=document.querySelectorAll('#vault-tree li.node[data-kind=\"dir\"]');"
                "for(var i=0;i<n.length;i++){"
                "var lab=n[i].querySelector(':scope > .row > .label');"
                "if(lab&&lab.textContent==='deep'){"
                "var c=n[i].querySelector(':scope > .row > .caret');"
                "return !!(c&&c.classList.contains('open'));"
                "}}return false;})()",
            )
            ctx.expect(
                deep_open is not True,
                "verschachtelter Ordner deep darf nach expand-roots nicht offen sein",
            )
            disabled = _poll(
                ctx,
                lambda: _evalv(
                    ctx,
                    "!!document.getElementById('vault-expand-roots')?.disabled",
                )
                is True,
                timeout=2.0,
            )
            ctx.expect(disabled, "expand-roots nach Expand muss disabled sein")
            ctx.api.sync_render()
            ctx.screenshot("49_filter_expand_level")

        with ctx.step("collapse all folds tree and re-enables expand-roots"):
            _click_id(ctx, "vault-collapse-all")
            ok = _poll(
                ctx,
                lambda: "Alpha.md" not in _tree_html(ctx)
                or (
                    # Pin-Wurzel da, Kinder weg / collapsed
                    root_norm in _tree_html(ctx)
                    and "file.md" not in _tree_html(ctx)
                ),
                timeout=4.0,
            )
            ctx.expect(ok, f"collapse_all: {_tree_html(ctx)[:400]}")
            # Pin-Wurzel noch da
            pin_ok = _poll(
                ctx,
                lambda: root_norm in _tree_html(ctx)
                or _dir_visible(ctx, "vault")
                or os.path.basename(root) in _tree_html(ctx),
                timeout=2.0,
            )
            ctx.expect(pin_ok, f"Pin-Wurzel nach collapse fehlt: {_tree_html(ctx)[:300]}")
            re_enabled = _poll(
                ctx,
                lambda: _evalv(
                    ctx,
                    "!document.getElementById('vault-expand-roots')?.disabled",
                )
                is True,
                timeout=2.0,
            )
            ctx.expect(re_enabled, "expand-roots nach collapse_all muss enabled sein")
            ctx.api.sync_render()
            ctx.screenshot("49_filter_collapse_all")

        with ctx.step("re-expand for close test"):
            js = (
                "(function(){var n=document.querySelector("
                "'#vault-tree li.node[data-path=%s] > .row');"
                "if(!n)return false;"
                "n.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
                "return true;})()" % json.dumps(root_norm)
            )
            ctx.expect(_evalv(ctx, js) is True, "Re-Expand Pin")
            _poll(ctx, lambda: "Alpha.md" in _tree_html(ctx), timeout=4.0)

        with ctx.step("close bar clears filter (A7)"):
            if not _filter_bar_open(ctx):
                _click_id(ctx, "vault-filter-toggle")
                ctx.expect(
                    _poll(ctx, lambda: _filter_bar_open(ctx)),
                    "Filterzeile öffnet nicht vor Close-Test",
                )
            _set_query(ctx, "alp")
            ok = _poll(
                ctx,
                lambda: _file_visible(ctx, "Alpha.md") and _file_hidden(ctx, "Beta.md"),
                timeout=4.0,
            )
            ctx.expect(ok, f"Vor Close: Filter nicht aktiv: {_tree_html(ctx)[:400]}")
            _click_id(ctx, "vault-filter-close")
            ok = _poll(
                ctx,
                lambda: (not _filter_bar_open(ctx))
                and _file_visible(ctx, "Alpha.md")
                and _file_visible(ctx, "Beta.md")
                and _file_visible(ctx, "notes.txt"),
                timeout=4.0,
            )
            ctx.expect(
                ok,
                f"Close: bar={_filter_bar_open(ctx)} "
                f"Beta={_file_visible(ctx,'Beta.md')} "
                f"html={_tree_html(ctx)[:400]}",
            )
            query_val = _evalv(
                ctx,
                "document.getElementById('vault-filter-input')?.value||''",
            )
            ctx.expect(query_val == "", f"Query sollte leer sein, got {query_val!r}")
            ctx.expect(
                _evalv(ctx, "!!document.querySelector('#vault-tree .vf-hit')") is not True,
                "vf-hit nach Close weg",
            )
            ctx.api.sync_render()
            ctx.screenshot("49_filter_closed")

        with ctx.step(".md chip filters lazy tree"):
            if not _filter_bar_open(ctx):
                _click_id(ctx, "vault-filter-toggle")
                _poll(ctx, lambda: _filter_bar_open(ctx))
            _click_id(ctx, "vault-filter-md")
            ok = _poll(
                ctx,
                lambda: "Alpha.md" in _tree_html(ctx)
                and "notes.txt" not in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(ok, f"md-chip: {_tree_html(ctx)[:400]}")
            badge = _evalv(
                ctx,
                "document.getElementById('vault-filter-toggle')"
                "?.classList.contains('filter-active')",
            )
            ctx.expect(badge is True, "Badge bei md-only")
            # Chip aus
            _click_id(ctx, "vault-filter-md")
            ok = _poll(
                ctx,
                lambda: "notes.txt" in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(ok, f"Chip-off: {_tree_html(ctx)[:400]}")
            ctx.api.sync_render()
            ctx.screenshot("49_filter_md_chip")

    finally:
        try:
            ctx.api.workspace_unpin(root_norm)
        except Exception:
            try:
                ctx.api.workspace_unpin(root)
            except Exception:
                pass
        try:
            ctx.api.eval(
                "typeof window.__folioVaultFilterReset==='function'"
                "&&window.__folioVaultFilterReset()"
            )
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)
