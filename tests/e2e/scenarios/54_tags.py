"""E2E Tag-Browser (W6): Sektion, Dateiliste, Search-Präfill.

Kopiert fixtures/tags nach Temp (isoliert), pinnt, lazy Tag-Scan.
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


def _poll(ctx, fn, timeout: float = 6.0, interval: float = 0.12):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def run(ctx):
    src = Path(ctx.fixture("tags"))
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-tags-"))
    shutil.copytree(src, tmp, dirs_exist_ok=True)
    folder = str(tmp)
    projekt = str(tmp / "projekt.md")
    pinned = False

    try:
        with ctx.step("Tags-Temp-Ordner pinnen + Datei oeffnen"):
            ctx.api.tabs_close_all()
            ctx.api.workspace_pin(folder, is_directory=True)
            pinned = True
            ctx.api.open(projekt, discard=True)
            try:
                ctx.api.wait("document.loaded", timeout_ms=5000)
            except Exception:
                pass
            ctx.api.mode("view")
            ctx.api.rail("left", True)
            ctx.api.sync_render()

        with ctx.step("Tags-Sektion aufklappen (lazy Scan)"):
            ctx.api.click("#vault-tags-header")
            try:
                ctx.api.click("#vault-tags-refresh")
            except Exception:
                pass

            def _tags_ready():
                return _evalv(
                    ctx,
                    """(() => {
                        const sec = document.getElementById('vault-tags-section');
                        if (!sec || sec.classList.contains('collapsed')) return null;
                        const labels = Array.from(
                            document.querySelectorAll('#vault-tags-list .vault-tag-label')
                        ).map(el => (el.textContent || '').trim());
                        if (!labels.length) return null;
                        return labels;
                    })()""",
                )

            labels = _poll(ctx, _tags_ready, timeout=10.0)
            ctx.expect(bool(labels), f"keine Tag-Zeilen: {labels!r}")
            joined = " ".join(labels or [])
            ctx.expect(
                "#projekt" in joined or "projekt" in joined.lower(),
                f"#projekt fehlt in Tags: {labels!r}",
            )

        with ctx.step("Tag aufklappen → Dateiliste → Datei oeffnen"):
            opened = _evalv(
                ctx,
                """(() => {
                    const rows = document.querySelectorAll('#vault-tags-list .vault-tag-row');
                    let target = null;
                    for (const row of rows) {
                        const lab = row.querySelector('.vault-tag-label');
                        if (lab && /projekt/i.test(lab.textContent || '')) {
                            target = row; break;
                        }
                    }
                    if (!target) return { ok: false, reason: 'no-tag-row' };
                    target.click();
                    const li = target.closest('li.vault-tag');
                    const file = li && li.querySelector('.vault-tag-file');
                    if (!file) return {
                        ok: false, reason: 'no-file',
                        open: li && li.classList.contains('open'),
                    };
                    file.click();
                    return { ok: true, path: file.getAttribute('data-path') || '' };
                })()""",
            )
            ctx.expect(
                opened and opened.get("ok") is True,
                f"Tag/Datei-Klick fehlgeschlagen: {opened!r}",
            )
            try:
                ctx.api.wait("document.loaded", timeout_ms=6000)
            except Exception:
                pass

            def _file_ok():
                f = _norm((ctx.api.state().get("file") or ""))
                if f.endswith("projekt.md") or f.endswith("notiz.md"):
                    return f
                return None

            path = _poll(ctx, _file_ok, timeout=6.0) or _norm(
                (ctx.api.state().get("file") or "")
            )
            ctx.expect(
                path.endswith("projekt.md") or path.endswith("notiz.md"),
                f"unerwarteter Pfad nach Tag-Datei-Klick: {path!r}",
            )
            ctx.api.mode("view")

        with ctx.step("Such-Icon → Dialog mit #tag-Praefill, schliessen"):
            pref = _evalv(
                ctx,
                """(() => {
                    const btn = document.querySelector(
                        '#vault-tags-list .vault-tag-search[data-tag="projekt"]'
                    ) || document.querySelector('#vault-tags-list .vault-tag-search');
                    if (!btn) return { ok: false, reason: 'no-btn' };
                    btn.click();
                    const dlg = document.getElementById('vault-search-dialog');
                    const q = document.getElementById('vsd-query');
                    return {
                        ok: !!(dlg && !dlg.hidden),
                        query: q ? (q.value || '') : '',
                    };
                })()""",
            )
            ctx.expect(pref and pref.get("ok") is True, f"Suchdialog nicht offen: {pref!r}")
            q = (pref or {}).get("query") or ""
            ctx.expect(
                q.startswith("#") and "projekt" in q.lower(),
                f"Praefill unerwartet: {q!r}",
            )
            try:
                ctx.api.click("#vsd-cancel")
            except Exception:
                _evalv(
                    ctx,
                    """(() => {
                        const c = document.getElementById('vsd-cancel');
                        if (c) c.click();
                        return true;
                    })()""",
                )
            closed = _poll(
                ctx,
                lambda: _evalv(
                    ctx,
                    "!!(document.getElementById('vault-search-dialog')||{}).hidden",
                )
                is True,
                timeout=3.0,
            )
            ctx.expect(closed is True, "Suchdialog blieb offen")

        with ctx.step("Screenshot-Baseline tags"):
            ctx.screenshot("tags_browser")

    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        if pinned:
            try:
                ctx.api.workspace_unpin(folder)
            except Exception:
                pass
        shutil.rmtree(tmp, ignore_errors=True)
