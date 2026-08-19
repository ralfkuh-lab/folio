"""E2E Wikilinks (W6): Render, Klick-Navigation, Backlinks-Panel.

Kopiert fixtures/wikilinks nach Temp (isoliert vom Repo-Gitignore/Walk),
pinnt den Temp-Ordner, öffnet A im View-Mode.

W8: Wikilinks sind **Opt-in pro Pin-Wurzel** (`workspace_wikilink_root_set`).
Ohne die Freischaltung ist der Index leer und alles würde als `missing`
rendern — jeder Pin dieses Szenarios muss also zusätzlich als Wurzel
aktiviert werden. Der Index-Build läuft danach im Hintergrund; das
`wikilink:index_ready`-Event zieht die View nach, die Polls unten warten
darauf ab (kein zusätzlicher Sleep nötig).
"""

from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path


def _norm(path: str) -> str:
    return path.replace("\\", "/")


def _evalv(ctx, js: str, timeout_ms: int = 3000):
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(ctx, fn, timeout: float = 5.0, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def run(ctx):
    src = Path(ctx.fixture("wikilinks"))
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-wikilinks-"))
    shutil.copytree(src, tmp, dirs_exist_ok=True)
    folder = str(tmp)
    a_path = str(tmp / "A.md")
    b_path = str(tmp / "B.md")
    pinned_folder = False

    try:
        with ctx.step("Wikilinks-Dateien pinnen + A oeffnen (View)"):
            ctx.api.tabs_close_all()
            # Einzeldatei-Pins umgehen den WalkBuilder/gitignore-Pfad
            # (Datei-Pins sind explizit im Index — robuster im Voll-Lauf).
            for fpath in (a_path, b_path, str(tmp / "bild.png")):
                ctx.api.workspace_pin(fpath, is_directory=False)
                # W8-Opt-in: ohne Wurzel-Freischaltung bleibt der Index leer.
                ctx.api.workspace_wikilink_root(fpath, True)
            pinned_folder = True
            ctx.api.open(a_path, discard=True)
            try:
                ctx.api.wait("document.loaded", timeout_ms=8000)
            except Exception:
                pass
            opened = _poll(
                ctx,
                lambda: _norm((ctx.api.state().get("file") or "")) == _norm(a_path),
                timeout=5.0,
            )
            ctx.expect(bool(opened), f"A nicht geoeffnet: file={ctx.api.state().get('file')!r}")
            # Re-Open nach Pin: frischer document:loaded mit Index.
            ctx.api.open(a_path, discard=True)
            try:
                ctx.api.wait("document.loaded", timeout_ms=5000)
            except Exception:
                pass
            ctx.api.mode("view")
            ctx.api.rail("right", True)
            ctx.api.sync_render()

        with ctx.step("Render: a.wikilink / a.wikilink-missing / img embed"):
            def _check():
                return _evalv(
                    ctx,
                    """(() => {
                        const body = document.querySelector('.markdown-body');
                        if (!body) return { err: 'no-body' };
                        const html = body.innerHTML || '';
                        const ok = body.querySelector(
                            'a.wikilink[href]:not(.wikilink-missing)'
                        );
                        const miss = body.querySelector(
                            'a.wikilink-missing[href^="folio-new:"]'
                        );
                        const img = body.querySelector('img[src]');
                        const allA = Array.from(body.querySelectorAll('a')).map(a => ({
                            href: a.getAttribute('href'),
                            cls: a.className,
                        }));
                        if (!ok || !miss || !img) {
                            return {
                                err: 'incomplete',
                                hasOk: !!ok, hasMiss: !!miss, hasImg: !!img,
                                allA, snippet: html.slice(0, 400),
                            };
                        }
                        return {
                            href: ok.getAttribute('href') || '',
                            missing: miss.getAttribute('href') || '',
                            img: true,
                        };
                    })()""",
                )

            info = _poll(
                ctx,
                lambda: (r if isinstance(r := _check(), dict) and r.get("href") else None),
                timeout=10.0,
            )
            ctx.expect(bool(info), f"Wikilink-Markup nicht gerendert: {_check()!r}")
            href = (info or {}).get("href") or ""
            ctx.expect(
                "B.md" in href or href.endswith("B.md") or href == "B.md",
                f"aufgeloester Wikilink-Href unerwartet: {href!r}",
            )
            missing = (info or {}).get("missing") or ""
            ctx.expect(
                missing.startswith("folio-new:"),
                f"missing href ohne folio-new:: {missing!r}",
            )

        with ctx.step("Klick auf aufgeloesten Wikilink → B geladen"):
            clicked = _evalv(
                ctx,
                """(() => {
                    const a = document.querySelector(
                        '.markdown-body a.wikilink:not(.wikilink-missing)'
                    );
                    if (!a) return false;
                    a.dispatchEvent(new MouseEvent('click', {
                        bubbles: true, cancelable: true,
                    }));
                    return true;
                })()""",
            )
            ctx.expect(clicked is True, "kein aufgeloester Wikilink zum Klicken")
            try:
                ctx.api.wait("document.loaded", timeout_ms=8000)
            except Exception:
                pass
            state = _poll(
                ctx,
                lambda: (
                    ctx.api.state()
                    if _norm((ctx.api.state().get("file") or "")) == _norm(b_path)
                    else None
                ),
                timeout=8.0,
            )
            cur = _norm((state or ctx.api.state()).get("file") or "")
            ctx.expect(
                cur == _norm(b_path),
                f"nach Wikilink-Klick erwartet B, got file={cur!r}",
            )
            ctx.api.mode("view")
            ctx.api.sync_render()

        with ctx.step("Backlinks-Panel zeigt A als Quelle"):
            def _backlinks():
                return _evalv(
                    ctx,
                    """(() => {
                        const list = document.getElementById('backlinks-list');
                        const text = list ? (list.textContent || '') : '';
                        const has = /A\\.md/i.test(text);
                        return has ? { has: true, text: text.slice(0, 200) } : null;
                    })()""",
                )

            bl = _poll(ctx, _backlinks, timeout=8.0)
            ctx.expect(bool(bl), f"Backlinks ohne A: {_backlinks()!r}")

        with ctx.step("Screenshot-Baseline wikilinks"):
            ctx.screenshot("wikilinks_view")

    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        if pinned_folder:
            # `workspace_unpin` raeumt den passenden wikilink_roots-Eintrag
            # mit ab (Workspace::unpin) — kein separates Opt-out noetig.
            for fpath in (a_path, b_path, str(tmp / "bild.png"), folder):
                try:
                    ctx.api.workspace_unpin(fpath)
                except Exception:
                    pass
        shutil.rmtree(tmp, ignore_errors=True)
