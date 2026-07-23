"""E2E: Command Palette (Strg+P) — Datei-Walk, Commands, TOC.

Spec: docs/spec-command-palette.md (Automation / E2E).
Hook via /eval + __folioOpenPalette (kein nativer Accelerator unter Xvfb).
Polling statt fixer Sleeps. Temp-Fixtures + finally-Aufräumen.
Negativ-Asserts nur gegen gescopte #cmd-palette-Ausschnitte (Recent-Lektion).
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time


def _norm(path: str) -> str:
    return path.replace("\\", "/")


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    """IIFE/Expression via /eval — Frontend: return (js)."""
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(ctx, fn, timeout: float = 5.0, interval: float = 0.08):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _palette_open(ctx) -> bool:
    return _evalv(
        ctx,
        "(function(){var el=document.getElementById('cmd-palette');"
        "return !!(el&&!el.hidden&&document.body.classList.contains('palette-open'));})()",
    ) is True


def _open_palette(ctx, prefill: str | None = None) -> None:
    if prefill is None:
        js = (
            "(function(){if(typeof window.__folioOpenPalette!=='function')return false;"
            "window.__folioOpenPalette();return true;})()"
        )
    else:
        js = (
            "(function(){if(typeof window.__folioOpenPalette!=='function')return false;"
            "window.__folioOpenPalette(%s);return true;})()" % json.dumps(prefill)
        )
    ctx.expect(_evalv(ctx, js) is True, "__folioOpenPalette fehlt/fehlgeschlagen")
    ctx.expect(
        _poll(ctx, lambda: _palette_open(ctx), timeout=3.0),
        "Palette öffnet nicht",
    )


def _close_palette(ctx) -> None:
    js = (
        "(function(){if(typeof window.__folioClosePalette==='function')"
        "{window.__folioClosePalette();return true;}"
        "document.dispatchEvent(new KeyboardEvent('keydown',"
        "{key:'Escape',bubbles:true,cancelable:true}));return true;})()"
    )
    _evalv(ctx, js)
    _poll(ctx, lambda: not _palette_open(ctx), timeout=2.0)


def _set_query(ctx, query: str) -> None:
    js = (
        "(function(){var el=document.getElementById('cmd-palette-input');"
        "if(!el)return false;el.value=%s;"
        "el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()"
        % json.dumps(query)
    )
    ctx.expect(_evalv(ctx, js) is True, "Palette-Input nicht gesetzt")


def _palette_list_html(ctx) -> str:
    """Nur #cmd-palette-list — nicht Vault/Recent."""
    return (
        _evalv(
            ctx,
            "document.getElementById('cmd-palette-list')?.innerHTML||''",
        )
        or ""
    )


def _item_labels(ctx) -> list:
    val = _evalv(
        ctx,
        "(function(){var nodes=document.querySelectorAll("
        "'#cmd-palette-list .cmd-palette-item .cmd-palette-label');"
        "return Array.from(nodes).map(function(n){return n.textContent||'';});})()",
    )
    return val if isinstance(val, list) else []


def _has_cp_hit(ctx) -> bool:
    return (
        _evalv(
            ctx,
            "!!document.querySelector('#cmd-palette-list .cp-hit')",
        )
        is True
    )


def _active_path_attr(ctx) -> str | None:
    return _evalv(
        ctx,
        "(function(){var el=document.querySelector("
        "'#cmd-palette-list .cmd-palette-item.active');"
        "return el?el.getAttribute('data-path'):null;})()",
    )


def _press_enter(ctx, ctrl: bool = False) -> None:
    js = (
        "(function(){var el=document.getElementById('cmd-palette-input');"
        "if(!el)return false;"
        "el.dispatchEvent(new KeyboardEvent('keydown',{"
        "key:'Enter',bubbles:true,cancelable:true,ctrlKey:%s,metaKey:false"
        "}));return true;})()" % ("true" if ctrl else "false")
    )
    ctx.expect(_evalv(ctx, js) is True, "Enter nicht dispatcht")


def _press_escape(ctx) -> None:
    js = (
        "(function(){var el=document.getElementById('cmd-palette-input');"
        "if(el)el.dispatchEvent(new KeyboardEvent('keydown',"
        "{key:'Escape',bubbles:true,cancelable:true}));"
        "document.dispatchEvent(new KeyboardEvent('keydown',"
        "{key:'Escape',bubbles:true,cancelable:true}));return true;})()"
    )
    _evalv(ctx, js)


def _state_file(ctx) -> str | None:
    f = ctx.api.state().get("file")
    return _norm(f) if isinstance(f, str) else None


def _doc_tabs(ctx) -> list:
    return [t for t in (ctx.api.tabs().get("tabs") or []) if t.get("path")]


def _body_has_class(ctx, cls: str) -> bool:
    return (
        _evalv(
            ctx,
            "document.body.classList.contains(%s)" % json.dumps(cls),
        )
        is True
    )


def _toc_active_slug(ctx) -> str | None:
    return _evalv(
        ctx,
        "(function(){var el=document.querySelector("
        "'#toc-region li.entry.active');"
        "return el?el.getAttribute('data-slug'):null;})()",
    )


def run(ctx):
    tmp = tempfile.mkdtemp(prefix="folio-e2e-palette-")
    root = os.path.join(tmp, "vault")
    # Eindeutige Namen — Negativ-Asserts nur in #cmd-palette-list
    alpha = os.path.join(root, "alpha-palette.md")
    beta = os.path.join(root, "beta-unique.md")
    deep = os.path.join(root, "notes", "deep-unique.md")
    _write(
        alpha,
        "# Palette Intro\n\n## Abschnitt B\n\nText für TOC.\n\n## Schluss\n",
    )
    _write(beta, "# Beta\n\nNur für Datei-Treffer.\n")
    _write(deep, "# Deep\n\nStrg+Enter-Ziel.\n")
    root_n = _norm(root)
    beta_n = _norm(beta)
    deep_n = _norm(deep)
    alpha_n = _norm(alpha)

    try:
        with ctx.step("fixture pinnen + alpha öffnen (view)"):
            ctx.api.tabs_close_all()
            ctx.api.workspace_pin(root, is_directory=True)
            ctx.api.open(alpha)
            ctx.api.mode("view")
            ctx.api.sync_render()
            ctx.expect(
                _poll(ctx, lambda: _state_file(ctx) == alpha_n, timeout=4.0),
                f"alpha nicht aktiv: {_state_file(ctx)!r}",
            )

        with ctx.step("Palette öffnen (Hook) + Walk abwarten"):
            _open_palette(ctx)
            # Walk liefert beta — poll bis Label sichtbar (async palette_files)
            ok = _poll(
                ctx,
                lambda: any("beta-unique" in (lab or "") for lab in _item_labels(ctx)),
                timeout=6.0,
            )
            ctx.expect(
                ok,
                f"Walk/Tabs zeigen beta-unique nicht: {_item_labels(ctx)!r} "
                f"html={_palette_list_html(ctx)[:300]!r}",
            )

        with ctx.step("Filter beta-unique: Treffer + Highlight"):
            _set_query(ctx, "beta-unique")
            ok = _poll(
                ctx,
                lambda: len(_item_labels(ctx)) >= 1
                and any("beta-unique" in (lab or "") for lab in _item_labels(ctx))
                and _has_cp_hit(ctx),
                timeout=4.0,
            )
            labels = _item_labels(ctx)
            ctx.expect(
                ok,
                f"beta-Treffer/Highlight fehlen: labels={labels!r} "
                f"hit={_has_cp_hit(ctx)} html={_palette_list_html(ctx)[:400]!r}",
            )
            # Negativ nur im Palette-List-Scope (nicht Vault/Recent)
            html = _palette_list_html(ctx)
            ctx.expect(
                "deep-unique" not in html,
                f"deep-unique unerwartet in Palette-Liste: {html[:300]!r}",
            )
            ctx.api.sync_render()
            ctx.screenshot("51_palette_file_hits")

        with ctx.step("Enter öffnet beta im aktiven Tab (ersetzt, count stabil)"):
            # FXP6: vor Enter aktive Tab-ID + Dokument-Tab-Anzahl
            tabs_before = _doc_tabs(ctx)
            count_before = len(tabs_before)
            active_before = next(
                (t for t in tabs_before if t.get("active")),
                tabs_before[0] if tabs_before else {},
            )
            active_id = active_before.get("id")
            ctx.expect(
                active_id is not None,
                f"kein aktiver Tab vor Enter: {tabs_before!r}",
            )
            _press_enter(ctx, ctrl=False)
            ok = _poll(
                ctx,
                lambda: (not _palette_open(ctx)) and _state_file(ctx) == beta_n,
                timeout=5.0,
            )
            ctx.expect(
                ok,
                f"Enter öffnete beta nicht: open={_palette_open(ctx)} "
                f"file={_state_file(ctx)!r}",
            )
            tabs_after = _doc_tabs(ctx)
            count_after = len(tabs_after)
            ctx.expect(
                count_after == count_before,
                f"Enter darf Tab-Anzahl nicht erhöhen: "
                f"before={count_before} after={count_after} paths="
                f"{[_norm(t.get('path') or '') for t in tabs_after]!r}",
            )
            replaced = next(
                (t for t in tabs_after if t.get("id") == active_id),
                None,
            )
            ctx.expect(
                replaced is not None
                and _norm(replaced.get("path") or "") == beta_n,
                f"derselbe Tab-ID sollte beta tragen: id={active_id} "
                f"tabs={tabs_after!r}",
            )

        with ctx.step("Strg+Enter öffnet deep in neuem Tab (+1)"):
            before_count = len(_doc_tabs(ctx))
            _open_palette(ctx)
            _set_query(ctx, "deep-unique")
            ok = _poll(
                ctx,
                lambda: any("deep-unique" in (lab or "") for lab in _item_labels(ctx)),
                timeout=5.0,
            )
            ctx.expect(ok, f"deep-unique nicht in Liste: {_item_labels(ctx)!r}")
            path_attr = _active_path_attr(ctx)
            ctx.expect(
                path_attr and "deep-unique" in path_attr,
                f"active path nicht deep: {path_attr!r}",
            )
            _press_enter(ctx, ctrl=True)
            ok = _poll(
                ctx,
                lambda: (not _palette_open(ctx))
                and len(_doc_tabs(ctx)) == before_count + 1
                and any(
                    _norm(t.get("path") or "") == deep_n for t in _doc_tabs(ctx)
                ),
                timeout=5.0,
            )
            tabs = _doc_tabs(ctx)
            paths = [_norm(t.get("path") or "") for t in tabs]
            ctx.expect(
                ok,
                f"Strg+Enter tab_open fehlgeschlagen: before={before_count} "
                f"after={len(tabs)} paths={paths!r}",
            )

        with ctx.step(">-Modus: Edit-Mode ausführen"):
            # alpha zurück für MD-Edit-Enable
            ctx.api.open(alpha)
            ctx.api.mode("view")
            ctx.api.sync_render()
            _open_palette(ctx, ">")
            _set_query(ctx, ">Edit")
            ok = _poll(
                ctx,
                lambda: any(
                    "Edit" in (lab or "") or "edit" in (lab or "").lower()
                    for lab in _item_labels(ctx)
                ),
                timeout=3.0,
            )
            ctx.expect(ok, f">Edit zeigt keine Commands: {_item_labels(ctx)!r}")
            ctx.api.sync_render()
            ctx.screenshot("51_palette_commands")
            # Enter auf erstem (Edit-Mode / modeEdit)
            _press_enter(ctx, ctrl=False)
            ok = _poll(
                ctx,
                lambda: (not _palette_open(ctx)) and _body_has_class(ctx, "edit-mode"),
                timeout=4.0,
            )
            ctx.expect(
                ok,
                f"Edit-Mode nicht gesetzt: open={_palette_open(ctx)} "
                f"edit={_body_has_class(ctx, 'edit-mode')}",
            )

        with ctx.step("#-Modus: Sprung zu Überschrift"):
            ctx.api.mode("view")
            ctx.api.sync_render()
            # TOC muss da sein
            slugs = [e.get("slug") for e in (ctx.api.state().get("toc") or [])]
            ctx.expect(
                any(s and "abschnitt" in s for s in slugs),
                f"TOC ohne abschnitt-*: {slugs!r}",
            )
            target_slug = next(s for s in slugs if s and "abschnitt" in s)
            _open_palette(ctx, "#")
            toc_texts = [
                (e.get("text") or "").strip()
                for e in (ctx.api.state().get("toc") or [])
            ][:50]
            ok = _poll(
                ctx,
                lambda: len(_item_labels(ctx)) >= len(toc_texts),
                timeout=3.0,
            )
            ctx.expect(ok, f"#-Modus (leer) unvollständig: {_item_labels(ctx)!r}")
            labels = [(lab or "").strip() for lab in _item_labels(ctx)][:len(toc_texts)]
            ctx.expect(
                labels == toc_texts,
                f"Headings nicht in Dokumentreihenfolge: {labels!r} != {toc_texts!r}",
            )
            _set_query(ctx, "#Abschnitt")
            ok = _poll(
                ctx,
                lambda: len(_item_labels(ctx)) >= 1,
                timeout=3.0,
            )
            ctx.expect(ok, f"#-Modus leer: {_item_labels(ctx)!r} slugs={slugs!r}")
            _press_enter(ctx, ctrl=False)
            ok = _poll(
                ctx,
                lambda: (not _palette_open(ctx))
                and (_toc_active_slug(ctx) == target_slug
                     or (ctx.api.state().get("view") or {}).get("anchor")
                     in (target_slug, f"#{target_slug}")),
                timeout=4.0,
            )
            # Xvfb: Scroll/anchor soft — mindestens Palette zu + kein Error
            ctx.expect(
                not _palette_open(ctx),
                "Palette nach #-Enter nicht zu",
            )
            if not ok:
                # soft: active TOC class oder state.view.anchor
                anchor = (ctx.api.state().get("view") or {}).get("anchor")
                toc_a = _toc_active_slug(ctx)
                ctx.expect(
                    toc_a == target_slug or (anchor and target_slug in str(anchor)),
                    f"#-Sprung unsicher: toc_active={toc_a!r} "
                    f"anchor={anchor!r} target={target_slug!r}",
                )

        with ctx.step("Esc schließt Palette"):
            _open_palette(ctx, "beta")
            ctx.expect(_palette_open(ctx), "Palette für Esc-Test nicht offen")
            _press_escape(ctx)
            ctx.expect(
                _poll(ctx, lambda: not _palette_open(ctx), timeout=2.0),
                "Esc schließt Palette nicht",
            )

        with ctx.step("console.errors leer"):
            errs = ctx.api.console_errors(clear=False)
            ctx.expect(
                errs.get("count", 0) == 0,
                f"unerwartete console errors: {errs.get('errors')}",
            )

    finally:
        try:
            _close_palette(ctx)
        except Exception:
            pass
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        try:
            ctx.api.workspace_unpin(root)
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)
