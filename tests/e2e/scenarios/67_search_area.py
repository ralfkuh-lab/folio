"""E2E: Such- und Filterbereich (S9) — die Zustände aus Mockup D, hell und dunkel.

Fixture auf festem Temp-Pfad (Grund wie 56/57/59/66: der Pin-Name steht im
Vault-Baum und damit in der Visual-Baseline). Pro Theme sechs Aufnahmen:

1. Ruhezustand — Funnel aus, nur Kopf + Baum.
2. Bereich offen, nichts eingegeben (Fokus im Namensfeld).
3. Filter aktiv: Name `spec`, `.md` an, Bereich `docs` → Baum gefiltert.
4. Suche aktiv: zusätzlich Inhalt `TODO`, Rx an → Trefferliste statt Baum.
5. Zahnrad-Popover offen (über Zustand 4).
6. Zustand 4 bei 480 px Rail-Breite (Felder nebeneinander).

Die Trefferliste wird vor den Aufnahmen auf „Dateiname" sortiert (die
Ankunftsreihenfolge ist nicht deterministisch) und am Ende zurückgestellt.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT_DIR = Path(tempfile.gettempdir()) / "folio-e2e-searcharea"


def _norm(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def _evalv(ctx, js: str):
    return ctx.api.eval(js).get("value")


def _poll(fn, timeout: float = 6.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _setup_fixture() -> None:
    shutil.rmtree(ROOT_DIR, ignore_errors=True)
    _write(ROOT_DIR / "README.md", "# Readme\n")
    _write(ROOT_DIR / "notes" / "spec-a.md", "TODO alpha\n")
    _write(ROOT_DIR / "docs" / "spec-vault-search.md", "# Suche\nTODO one\nTODO two\n")
    _write(ROOT_DIR / "docs" / "spec-i18n.md", "TODO i18n\n")
    _write(ROOT_DIR / "docs" / "feature-ideen.md", "TODO idee\n")


def _click(ctx, el_id: str) -> None:
    ctx.api.eval(
        "document.getElementById(%s).dispatchEvent(new MouseEvent('click',{bubbles:true}))"
        % json.dumps(el_id)
    )


def _area_open(ctx) -> bool:
    return _evalv(ctx, "document.getElementById('vault-filter').hidden") is False


def _pressed(ctx, el_id: str) -> bool:
    return _evalv(
        ctx, "document.getElementById(%s).getAttribute('aria-pressed')" % json.dumps(el_id)
    ) == "true"


def _sort_active(ctx) -> bool:
    return _evalv(
        ctx, "document.getElementById('vault-search-sort').classList.contains('active')"
    ) is True


def _sort_label(ctx) -> str:
    return _evalv(ctx, "document.getElementById('vault-search-sort-label').textContent") or ""


def _reset_area(ctx) -> None:
    ctx.api.eval(
        "typeof window.__folioVaultFilterReset==='function'&&window.__folioVaultFilterReset()"
    )
    ctx.api.eval(
        "(function(){var i=document.getElementById('vault-search-input');"
        "i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));"
        "var b=document.getElementById('vault-search-regex');"
        "if(b.getAttribute('aria-pressed')==='true')b.click();return true;})()"
    )
    ctx.expect(
        _poll(lambda: not _area_open(ctx)) is True, "Bereich nach Reset noch offen"
    )


def _xdotool(*args: str) -> bool:
    """Echte X-Tastaturereignisse (Xvfb, gleiches DISPLAY wie die App).
    `/key` dispatcht nur synthetische Events — die verschieben bei Tab keinen
    Fokus und sind fuer Popover-/Fokus-Pruefungen ungeeignet."""
    if not shutil.which("xdotool") or not os.environ.get("DISPLAY"):
        return False
    try:
        subprocess.run(["xdotool", *args], check=True, capture_output=True, timeout=5)
        return True
    except (subprocess.SubprocessError, OSError):
        return False


def _focus_app_window() -> bool:
    for query in (["--class", "folio"], ["--name", "Folio"], ["--name", "."]):
        try:
            out = subprocess.run(
                ["xdotool", "search", "--onlyvisible", *query],
                check=True, capture_output=True, text=True, timeout=5,
            ).stdout.split()
        except (subprocess.SubprocessError, OSError):
            continue
        if out:
            return _xdotool("windowfocus", "--sync", out[-1])
    return False


def _popover_escape_from_results_head(ctx) -> None:
    """Korrekturrunde 1, Befund 3: Popover offen, Tab hinaus in den
    Ergebnis-Kopf, Escape → Popover zu, Fokus am Zahnrad, Suche aktiv."""
    def state():
        return _evalv(
            ctx,
            "(function(){var a=document.activeElement;return {"
            "pop:document.getElementById('vault-search-options').matches(':popover-open'),"
            "head:!!(a&&a.closest&&a.closest('#vault-search-results-head')),"
            "id:a&&a.id,"
            "search:document.getElementById('vault-region').classList.contains('vault-searching')};})()",
        ) or {}

    ctx.api.eval("document.getElementById('vault-search-options-toggle').click()")
    ctx.expect(_poll(lambda: state().get("pop") is True) is True, "Popover nicht offen")
    real = shutil.which("xdotool") is not None and _focus_app_window()
    if real:
        for _ in range(6):
            if state().get("head"):
                break
            _xdotool("key", "Tab")
            time.sleep(0.1)
    else:
        # Fallback ohne xdotool: Fokus direkt in den Kopf, synthetisches Escape.
        ctx.api.eval("document.getElementById('vault-search-sort').focus()")
    st = state()
    ctx.expect(st.get("head") is True and st.get("pop") is True,
               f"Fokus nicht im Ergebnis-Kopf bei offenem Popover: {st}")
    if real:
        _xdotool("key", "Escape")
    else:
        ctx.api.eval(
            "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',"
            "{key:'Escape',bubbles:true}))"
        )
    after = _poll(lambda: (lambda s: s if s.get("pop") is False else None)(state())) or state()
    ctx.expect(after.get("pop") is False, f"Popover blieb offen: {after}")
    ctx.expect(after.get("id") == "vault-search-options-toggle", f"Fokus nicht am Zahnrad: {after}")
    ctx.expect(after.get("search") is True, f"Suche wurde beendet: {after}")
    print(f"[67] Popover-Escape mit {'echten X-Tastaturereignissen (xdotool)' if real else 'synthetischen Ereignissen (kein xdotool)'}")


def _states(ctx, suffix: str, docs: str) -> None:
    with ctx.step(f"[{suffix}] 1 Ruhezustand"):
        _reset_area(ctx)
    ctx.screenshot(f"67_d1_ruhe_{suffix}")

    with ctx.step(f"[{suffix}] 2 Bereich offen, Fokus im Namensfeld"):
        _click(ctx, "vault-filter-toggle")
        focus = _poll(
            lambda: _evalv(ctx, "document.activeElement&&document.activeElement.id")
            == "vault-filter-input"
        )
        ctx.expect(focus is True, "Namensfeld nicht fokussiert")
    ctx.screenshot(f"67_d2_offen_{suffix}")

    with ctx.step(f"[{suffix}] 3 Filter: spec + .md + Bereich docs"):
        if not _pressed(ctx, "vault-filter-md"):
            _click(ctx, "vault-filter-md")
        ctx.api.eval("window.__folioVaultFilterInFolder(%s)" % json.dumps(docs))
        ctx.api.eval(
            "(function(){var i=document.getElementById('vault-filter-input');i.value='spec';"
            "i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()"
        )
        shown = _poll(
            lambda: _evalv(
                ctx,
                "(function(){var a=document.querySelector('#vault-tree li.node[data-path=%s]');"
                "var b=document.querySelector('#vault-tree li.node[data-path=%s]');"
                "var c=document.querySelector('#vault-tree li.node[data-path=%s]');"
                "return !!a&&!a.classList.contains('vf-hidden')&&!!b&&!b.classList.contains('vf-hidden')"
                "&&(!c||c.classList.contains('vf-hidden'));})()"
                % (
                    json.dumps(f"{docs}/spec-vault-search.md"),
                    json.dumps(f"{docs}/spec-i18n.md"),
                    json.dumps(f"{docs}/feature-ideen.md"),
                )
            ),
            timeout=8.0,
        )
        ctx.expect(shown is True, "gefilterter Baum zeigt nicht genau die spec-Dateien")
    ctx.screenshot(f"67_d3_filter_{suffix}")

    with ctx.step(f"[{suffix}] 4 Suche: TODO + Rx"):
        if not _pressed(ctx, "vault-search-regex"):
            _click(ctx, "vault-search-regex")
        ctx.api.eval(
            "(function(){var i=document.getElementById('vault-search-input');i.value='TODO';"
            "i.dispatchEvent(new Event('input',{bubbles:true}));"
            "i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));"
            "return true;})()"
        )
        done = _poll(
            lambda: _evalv(
                ctx,
                "(function(){var s=document.getElementById('vault-search-status');"
                "return !s.classList.contains('vs-running')&&s.textContent.indexOf('gefiltert')>=0"
                "&&document.querySelectorAll('#vault-search-list .vs-group').length===2;})()",
            ),
            timeout=8.0,
        )
        ctx.expect(done is True, "Suche im gefilterten Raum nicht fertig")
        # Deterministische Reihenfolge: Sortierung „Dateiname".
        for _ in range(3):
            if _sort_active(ctx) and _sort_label(ctx) == "Dateiname":
                break
            _click(ctx, "vault-search-sort")
        ctx.expect(_sort_label(ctx) == "Dateiname", f"Sortierung: {_sort_label(ctx)!r}")
        # Status ohne Laufzeitangabe (ms schwankt) für eine stabile Baseline.
        ctx.api.eval(
            "(function(){var s=document.getElementById('vault-search-status');"
            "s.textContent=s.textContent.replace(/ \\([^)]*\\)/,'');return true;})()"
        )
        ctx.api.eval("document.getElementById('vault-search-input').focus()")
    ctx.screenshot(f"67_d4_suche_{suffix}")

    if suffix == "hell":
        with ctx.step("[hell] Popover offen, Tab in den Ergebnis-Kopf, Escape"):
            _popover_escape_from_results_head(ctx)
            ctx.api.eval("document.getElementById('vault-search-input').focus()")

    with ctx.step(f"[{suffix}] 5 Zahnrad-Popover"):
        ctx.api.eval("document.getElementById('vault-search-options-toggle').click()")
        opened = _poll(
            lambda: _evalv(
                ctx, "document.getElementById('vault-search-options').matches(':popover-open')"
            )
            is True
        )
        ctx.expect(opened is True, "Popover nicht offen")
    ctx.screenshot(f"67_d5_zahnrad_{suffix}")

    with ctx.step(f"[{suffix}] 6 breite Rail (480 px)"):
        ctx.api.eval(
            "document.getElementById('vault-search-include-ignored')"
            ".dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
        )
        ctx.expect(
            _poll(
                lambda: _evalv(
                    ctx,
                    "!document.getElementById('vault-search-options').matches(':popover-open')",
                )
                is True
            )
            is True,
            "Popover blieb offen",
        )
        ctx.api.eval("document.body.style.setProperty('--vault-w','480px')")
        side = _poll(
            lambda: _evalv(
                ctx,
                "(function(){var a=document.getElementById('vault-filter-input').getBoundingClientRect();"
                "var b=document.getElementById('vault-search-input').getBoundingClientRect();"
                "return Math.abs(a.top-b.top)<1;})()",
            )
        )
        ctx.expect(side is True, "Felder bei 480 px nicht nebeneinander")
        ctx.api.eval("document.getElementById('vault-search-input').focus()")
    ctx.screenshot(f"67_d6_breit_{suffix}")
    ctx.api.eval("document.body.style.removeProperty('--vault-w')")


def run(ctx):
    _setup_fixture()
    root = _norm(ROOT_DIR)
    docs = f"{root}/docs"
    pinned = False
    try:
        with ctx.step("Fixture pinnen, Tabs zu, Bereich zu"):
            ctx.api.tabs_close_all()
            ctx.api.workspace_pin(str(ROOT_DIR), is_directory=True)
            pinned = True
            ctx.api.click('#vault-tree li.node[data-path="%s"] > .row' % root)
            ctx.expect(
                _poll(
                    lambda: _evalv(
                        ctx,
                        "!!document.querySelector(%s)"
                        % json.dumps(f'#vault-tree li.node[data-path="{docs}"]'),
                    )
                )
                is True,
                "Pin nicht aufgeklappt",
            )
        _states(ctx, "hell", docs)
        with ctx.step("Theme dunkel"):
            ctx.api.theme("dark")
        _states(ctx, "dunkel", docs)
    finally:
        try:
            ctx.api.eval("document.body.style.removeProperty('--vault-w')")
            # Sortierung zurück auf „Fundreihenfolge" (persistiert).
            for _ in range(3):
                if not _sort_active(ctx):
                    break
                _click(ctx, "vault-search-sort")
            # Der Umweg über „Pfad" blendet die Pfadzeile ein (persistiert).
            if _pressed(ctx, "vault-search-paths"):
                _click(ctx, "vault-search-paths")
            _reset_area(ctx)
            ctx.api.theme("light")
        except Exception:
            pass
        if pinned:
            try:
                ctx.api.workspace_unpin(str(ROOT_DIR))
            except Exception:
                pass
        shutil.rmtree(ROOT_DIR, ignore_errors=True)
