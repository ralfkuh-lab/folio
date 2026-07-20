"""E2E: Vault-Tree-Filter (Etappe F2) — Namensfilter + „nur Markdown".

Fixture-Ordner mit MD/Nicht-MD/Unterordnern; Filterzeile per Klick öffnen,
Query per /eval + input-Event, /dom-Asserts (Treffer da, Nicht-Treffer weg,
Ordner gestutzt, Recent ausgeblendet), .md-Chip, Clear → Lazy + Recents.
Screenshot am Ende jedes Blocks. E2E-Lauf startet der Orchestrator.
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
    # Nur die Pinned-Section: die Recent-Section ist im Filtermodus bloss
    # per CSS versteckt und enthaelt weiterhin die zuletzt geoeffneten
    # Dateien (z. B. Alpha.md) — sie wuerde Negativ-Asserts vergiften.
    return (
        _evalv(
            ctx,
            "document.querySelector('#vault-tree li.section"
            "[data-section=\"pinned\"]')?.innerHTML||''",
        )
        or ""
    )


def _filtering(ctx) -> bool:
    return (
        _evalv(
            ctx,
            "!!document.getElementById('vault-tree')"
            "?.classList.contains('filtering')",
        )
        is True
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
            # Vorzustand-Leak abwehren: der kanonische Reset raeumt die
            # Vault-SUCHE nicht (Ergebnisliste aus 47_vault_search_ui
            # bleibt sonst in der Rail und kippt die Baselines).
            ctx.api.eval(
                "(function(){var x=document.getElementById('vault-search-exit');"
                "if(x&&x.offsetParent)x.dispatchEvent("
                "new MouseEvent('click',{bubbles:true}));})()"
            )
            ctx.api.workspace_pin(root, is_directory=True)
            # recent via open so Recent-Section exists for hide-assert
            sample = os.path.join(root, "Alpha.md")
            ctx.api.open(sample)
            # Konvention: View-Mode explizit setzen (default_mode ist
            # Current — ein Mode-Leak aus dem Vorszenario kippt sonst
            # die Screenshot-Baselines).
            ctx.api.mode("view")
            ctx.api.sync_render()

        with ctx.step("expand pinned folder (lazy)"):
            # Pin-Ordner im Lazy-Baum aufklappen: (a) sonst zeigt der
            # Baum nach dem Clear-Schritt korrekt nur den zugeklappten
            # Root und die Kinder-Asserts liefen ins Leere; (b) so ist
            # mitgetestet, dass expanded_dirs den Filtermodus uebersteht.
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
            ctx.api.eval(
                "document.getElementById('vault-filter-toggle')"
                ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
            )
            ctx.expect(
                _poll(ctx, lambda: _filter_bar_open(ctx)),
                "Filterzeile öffnet nicht",
            )
            ctx.api.sync_render()
            ctx.screenshot("49_filter_bar_open")

        with ctx.step("name filter: Alpha match, Beta/notes pruned"):
            _set_query(ctx, "alp")
            # Debounce 150ms + roundtrip
            ok = _poll(
                ctx,
                lambda: _filtering(ctx)
                and "Alpha.md" in _tree_html(ctx)
                and "Beta.md" not in _tree_html(ctx)
                and "notes.txt" not in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(ok, f"Filter DOM falsch: {_tree_html(ctx)[:400]}")
            # Recent hidden via .filtering CSS class
            ctx.expect(_filtering(ctx), "filtering-Klasse fehlt")
            recent_display = _evalv(
                ctx,
                "getComputedStyle(document.querySelector("
                "'#vault-tree li.section[data-section=\"recent\"]')"
                "||document.createElement('li')).display",
            )
            ctx.expect(
                recent_display == "none",
                f"Recent sollte ausgeblendet sein, display={recent_display!r}",
            )
            ctx.api.sync_render()
            ctx.screenshot("49_filter_name_match")

        with ctx.step("folder name match shows node without full subtree"):
            _set_query(ctx, "notes")
            # Ordner Notes + notes.txt matchen; file.md/skip.txt nicht.
            ok = _poll(
                ctx,
                lambda: _filtering(ctx)
                and "Notes" in _tree_html(ctx)
                and "notes.txt" in _tree_html(ctx)
                and "file.md" not in _tree_html(ctx)
                and "skip.txt" not in _tree_html(ctx)
                and "Alpha.md" not in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(ok, f"Ordner-Match (kein Subtree): {_tree_html(ctx)[:400]}")
            hit = _evalv(
                ctx,
                "!!document.querySelector('#vault-tree .vf-hit')",
            )
            ctx.expect(hit is True, "span.vf-hit erwartet im Filterbaum")
            ctx.api.sync_render()
            ctx.screenshot("49_filter_folder_match")

        with ctx.step(".md chip hides non-md while name filter stays"):
            ctx.api.eval(
                "document.getElementById('vault-filter-md')"
                ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
            )
            # notes.txt (Non-MD) weg; Notes bleibt (rekursiv MD, leerer Knoten).
            ok = _poll(
                ctx,
                lambda: _filtering(ctx)
                and "Notes" in _tree_html(ctx)
                and "notes.txt" not in _tree_html(ctx)
                and "file.md" not in _tree_html(ctx)
                and "skip.txt" not in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(ok, f"md-chip: {_tree_html(ctx)[:400]}")
            ctx.api.sync_render()
            ctx.screenshot("49_filter_md_chip")

        with ctx.step("clear: lazy tree keeps md-only filter (FX1)"):
            ctx.api.eval(
                "document.getElementById('vault-filter-clear')"
                ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
            )
            # Chip ist noch an: Lazy-Baum zeigt MD, blendet notes.txt aus.
            ok = _poll(
                ctx,
                lambda: (not _filtering(ctx))
                and "Alpha.md" in _tree_html(ctx)
                and "notes.txt" not in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(ok, f"Clear/Lazy-md-only: {_tree_html(ctx)[:400]}")
            ctx.api.sync_render()
            ctx.screenshot("49_filter_lazy_md_only")

        with ctx.step("chip off returns full lazy tree + recents"):
            ctx.api.eval(
                "document.getElementById('vault-filter-md')"
                ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
            )
            ok = _poll(
                ctx,
                lambda: (not _filtering(ctx))
                and "Alpha.md" in _tree_html(ctx)
                and "notes.txt" in _tree_html(ctx),
                timeout=4.0,
            )
            ctx.expect(ok, f"Chip-off/Lazy: {_tree_html(ctx)[:400]}")
            recent_display = _evalv(
                ctx,
                "getComputedStyle(document.querySelector("
                "'#vault-tree li.section[data-section=\"recent\"]')"
                "||document.createElement('li')).display",
            )
            ctx.expect(
                recent_display != "none",
                f"Recent nach Clear wieder sichtbar erwartet, got {recent_display!r}",
            )
            ctx.api.sync_render()
            ctx.screenshot("49_filter_cleared")

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
