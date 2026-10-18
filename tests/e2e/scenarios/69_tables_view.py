"""E2E: Tabellen in der View — breite Tabellen und Overlay (Spec
docs/spec-tables.md, T2).

Geprüft wird an gemessenen Rechtecken (1280×800), nicht nur an Klassen:

  1. Breite Tabelle (14 Spalten, 30 Zeilen) in „GitHub" (Tabelle
     `display: block`) und „Clean" (`width: 100%`): `#view-content` läuft
     nie waagerecht über, der Tabellenrahmen scrollt; er ist breiter als
     die Textspalte, liegt in `#view-content` und mittig zur Spalte. Kleine
     Tabellen bleiben in der Spalte. Rails, „volle Breite" und Split messen
     neu. `brand`/`pastel` (`overflow: hidden` für runde Ecken) schneiden
     nichts ab.
  2. Overlay: Kopfzeile sticky, Scrollen in beide Richtungen; Escape,
     ✕ und Hintergrund schließen, die Tabelle steht danach wieder an ihrer
     Stelle, der Fokus auf dem Button. Ein Live-Preview-Re-Render bei
     offenem Overlay schließt es ohne Console-Fehler.
  Umbruch: im Scroll-Zustand und im Overlay bleiben kurze Zellen
     (Beträge, Daten, Bezeichnungen) einzeilig, nur die lange
     Fließtext-Zelle bricht um, und zwar erst ab ~24em.
  3. Sortieren per Klick und per Tastatur (Enter am Button im th),
     `aria-sort`, Pfeil sichtbar, Kopfzeile behält die Theme-Optik.
  4. Filtern: echte Eingabe, versteckte Zeilen, „{shown} von {total}",
     Escape leert, Find-Bar zählt versteckte Zeilen nicht mit; Filterfeld
     erst ab 6 Datenzeilen.
  5. Split: Sortierung und Filter überleben Tippen im Editor; geänderte
     Kopfzeile → Zustand verfällt still.
  6. Export und Theme-Editor-Vorschau enthalten nichts davon.

Echte Tasten und Mausbewegungen über xdotool (Escape am Dialog,
Hover-Leiste): `/key` dispatcht nur synthetische Events, die den nativen
Dialog nicht schließen.

Feste Fixture unter /tmp (nicht mkdtemp): der Pfad steht in Statusleiste
und Tab und ist damit Teil der Visual-Baseline — gleiche Begründung wie
bei 56/57/59/63/64.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

FIXTURE_DIR = Path("/tmp/folio-e2e-tables")
GUTTER = 24  # --folio-table-gutter in content.css

# Rechtecke der View, der Textspalte und aller Tabellenrahmen.
LAYOUT_JS = """
(() => {
    const vc = document.getElementById('view-content');
    const body = vc && vc.querySelector('.markdown-body');
    if (!body) return null;
    const bs = getComputedStyle(body);
    const br = body.getBoundingClientRect();
    const vr = vc.getBoundingClientRect();
    const colLeft = br.left + parseFloat(bs.borderLeftWidth) + parseFloat(bs.paddingLeft);
    const colRight = br.right - parseFloat(bs.borderRightWidth) - parseFloat(bs.paddingRight);
    const wraps = [...body.querySelectorAll('.folio-table')].map((w) => {
        const r = w.getBoundingClientRect();
        const s = w.querySelector(':scope > .folio-table-scroll');
        const t = s.querySelector(':scope > table');
        const tr = t.getBoundingClientRect();
        const cells = [...t.querySelectorAll('th, td')];
        const cellRight = Math.max(...cells.map((c) => c.getBoundingClientRect().right));
        return {
            cls: w.className, left: r.left, right: r.right, width: r.width,
            sw: s.scrollWidth, cw: s.clientWidth, ox: getComputedStyle(s).overflowX,
            tableRight: tr.right, cellRight, tableSW: t.scrollWidth,
        };
    });
    return {
        vcSW: vc.scrollWidth, vcCW: vc.clientWidth, vcLeft: vr.left,
        vcRight: vr.left + vc.clientWidth, colLeft, colRight, wraps,
    };
})()
"""

OVERLAY_JS = """
(() => {
    const d = document.getElementById('table-overlay');
    const host = document.getElementById('table-overlay-body');
    const s = host.querySelector('.folio-table-scroll');
    const th = s && s.querySelector('thead th');
    const a = document.activeElement;
    const body = document.querySelector('#view-region .markdown-body');
    return {
        open: d.open,
        inOverlay: !!s,
        placeholders: body.querySelectorAll('.folio-table-placeholder').length,
        viewTables: body.querySelectorAll('.folio-table').length,
        firstIsWide: !!body.querySelector('.folio-table:first-of-type table th')
            && body.querySelectorAll('.folio-table')[0].querySelectorAll('th').length === 14,
        ox: s ? getComputedStyle(s).overflowX : null,
        oy: s ? getComputedStyle(s).overflowY : null,
        sh: s ? s.scrollHeight : 0, ch: s ? s.clientHeight : 0,
        sw: s ? s.scrollWidth : 0, cw: s ? s.clientWidth : 0,
        thPos: th ? getComputedStyle(th).position : null,
        focusExpand: !!(a && a.classList && a.classList.contains('folio-table-expand')),
        active: a ? (a.tagName + '.' + a.className) : null,
    };
})()
"""

# Zeilenzahl je Zelle (Textknoten-Rechtecke, unabhängig vom Sortier-Button
# im th) für einige kurze Inhalte und die lange Fließtext-Zelle.
SHORT_TEXTS = ["8.169,25 €", "2027-06-08", "Vorhaben Alpha", "Rückfrage beim Auftraggeber",
               "Abteilungsleitung", "Verantwortlich", "Qualitätssicherung"]
LINES_JS = """
((sel, texts) => {
    const scope = document.querySelector(sel);
    if (!scope) return null;
    const lines = (cell) => {
        const tops = new Set();
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
            const r = document.createRange();
            r.selectNodeContents(n);
            for (const x of r.getClientRects()) if (x.width > 0) tops.add(Math.round(x.top));
        }
        return tops.size;
    };
    const cells = [...scope.querySelectorAll('th, td')];
    const out = {};
    for (const t of texts) {
        const c = cells.find((cell) => cell.textContent.trim() === t);
        out[t] = c ? lines(c) : -1;
    }
    const long = scope.querySelector('td.folio-cell-long');
    if (long) {
        const cs = getComputedStyle(long);
        out.__long = {
            lines: lines(long),
            width: long.getBoundingClientRect().width,
            limit: 24 * parseFloat(cs.fontSize) + parseFloat(cs.paddingLeft)
                + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth)
                + parseFloat(cs.borderRightWidth) + 1,
        };
    }
    return out;
})(%r, %s)
"""

OPEN_OVERLAY_JS = (
    "(() => { const b = document.querySelectorAll('#view-region .folio-table-expand')[0];"
    " b.click(); return document.getElementById('table-overlay').open; })()"
)


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    response = ctx.api.eval(js, timeout_ms=timeout_ms)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


def _poll(fn, timeout: float = 3.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _xdotool(*args: str) -> bool:
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


def _view_theme(ctx, theme_id: str, dark: bool) -> None:
    ctx.api.theme("dark" if dark else "light")
    ctx.api.settings_set({"viewTheme": theme_id})
    expected = _evalv(
        ctx,
        "window.__folioInvoke('view_theme_css', { themeId: %r, dark: %s })"
        % (theme_id, "true" if dark else "false"),
    )
    ok = _poll(
        lambda: _evalv(
            ctx,
            "(() => { const s = document.getElementById('view-theme-style');"
            " return document.body.dataset.viewTheme === %r && !!s && s.textContent; })()"
            % theme_id,
        )
        == expected
    )
    ctx.expect(bool(ok), f"View-Theme {theme_id} (dark={dark}) nicht angewendet")
    _settle(ctx)


def _settle(ctx) -> None:
    """Zwei Render-Roundtrips: der erste laesst den ResizeObserver feuern,
    der zweite den von ihm angestossenen Mess-Frame."""
    ctx.api.sync_render()
    ctx.api.sync_render()


def _check_layout(ctx, label: str) -> dict:
    lay = _evalv(ctx, LAYOUT_JS) or {}
    wraps = lay.get("wraps") or []
    ctx.expect(len(wraps) == 3, f"[{label}] erwartet 3 Tabellenrahmen: {lay!r}")
    ctx.expect(
        lay["vcSW"] <= lay["vcCW"],
        f"[{label}] #view-content läuft waagerecht über: {lay['vcSW']} > {lay['vcCW']}",
    )
    wide, small = wraps[0], wraps[1:]
    ctx.expect("folio-table--wide" in wide["cls"], f"[{label}] breite Tabelle nicht --wide: {wide!r}")
    ctx.expect(
        wide["ox"] == "auto" and wide["sw"] > wide["cw"],
        f"[{label}] Rahmen der breiten Tabelle scrollt nicht: {wide!r}",
    )
    col_width = lay["colRight"] - lay["colLeft"]
    ctx.expect(
        wide["width"] > col_width + 1,
        f"[{label}] breite Tabelle nicht breiter als die Textspalte ({col_width}): {wide!r}",
    )
    ctx.expect(
        wide["left"] >= lay["vcLeft"] - 0.5 and wide["right"] <= lay["vcRight"] + 0.5,
        f"[{label}] breite Tabelle ragt aus #view-content: {wide!r} / {lay!r}",
    )
    ctx.expect(
        abs(wide["width"] - (lay["vcCW"] - 2 * GUTTER)) <= 1,
        f"[{label}] Rahmenbreite {wide['width']} ≠ View {lay['vcCW']} − 2×{GUTTER}",
    )
    centre_wide = (wide["left"] + wide["right"]) / 2
    centre_col = (lay["colLeft"] + lay["colRight"]) / 2
    ctx.expect(
        abs(centre_wide - centre_col) <= 1.5,
        f"[{label}] nicht mittig zur Spalte: {centre_wide} vs {centre_col}",
    )
    for i, w in enumerate(small):
        ctx.expect(
            "folio-table--wide" not in w["cls"] and "folio-table--scroll" not in w["cls"],
            f"[{label}] kleine Tabelle {i} faelschlich breit: {w!r}",
        )
        ctx.expect(
            w["left"] >= lay["colLeft"] - 0.5 and w["right"] <= lay["colRight"] + 0.5,
            f"[{label}] kleine Tabelle {i} verlaesst die Spalte: {w!r} / {lay!r}",
        )
    for i, w in enumerate(wraps):
        ctx.expect(
            w["cellRight"] <= w["tableRight"] + 1,
            f"[{label}] Tabelle {i} schneidet Zellen ab: {w!r}",
        )
    return lay


def _check_wrapping(ctx, label: str, selector: str) -> None:
    import json
    res = _evalv(ctx, LINES_JS % (selector, json.dumps(SHORT_TEXTS))) or {}
    for text in SHORT_TEXTS:
        ctx.expect(res.get(text) == 1, f"[{label}] „{text}“ nicht einzeilig: {res!r}")
    long = res.get("__long") or {}
    ctx.expect(
        long.get("lines", 0) >= 2 and long.get("width", 1e9) <= long.get("limit", 0),
        f"[{label}] lange Zelle sollte bei ~24em umbrechen: {long!r}",
    )


def _fixture_rows(doc: Path) -> list[list[str]]:
    """Datenzeilen der breiten Tabelle aus der Fixture (erste Tabelle)."""
    rows, in_table = [], False
    for line in doc.read_text(encoding="utf-8").splitlines():
        if line.startswith("| Nr."):
            in_table = True
            continue
        if in_table:
            if not line.startswith("|"):
                break
            if line.startswith("|--") or line.startswith("|:"):
                continue
            rows.append([c.strip() for c in line.strip().strip("|").split("|")])
    return rows


def _de_number(text: str) -> float:
    return float(text.replace("€", "").replace(".", "").replace(",", ".").strip())


def _column(ctx, col: int, only_visible: bool = True) -> list[str]:
    return _evalv(
        ctx,
        "[...document.querySelectorAll('#view-region .folio-table')[0].querySelectorAll('tbody tr')]"
        ".filter((tr) => %s || !tr.hidden).map((tr) => tr.cells[%d].textContent.trim())"
        % ("false" if only_visible else "true", col),
    ) or []


def _sort_state(ctx, col: int) -> dict:
    return _evalv(
        ctx,
        """(() => {
            const wrap = document.querySelectorAll('#view-region .folio-table')[0];
            const th = wrap.querySelectorAll('thead th')[%d];
            const btn = th.querySelector('.folio-th-sort');
            const after = getComputedStyle(btn, '::after');
            const thCs = getComputedStyle(th), bCs = getComputedStyle(btn);
            return {
                ariaSort: th.getAttribute('aria-sort'),
                arrow: after.content, arrowOpacity: after.opacity,
                sameFont: bCs.fontWeight === thCs.fontWeight && bCs.fontFamily === thCs.fontFamily
                    && bCs.fontSize === thCs.fontSize,
                sameColor: bCs.color === thCs.color,
                arranged: wrap.querySelector('table').hasAttribute('data-folio-arranged'),
            };
        })()""" % col,
    ) or {}


FILTER_JS = """
(() => {
    const wrap = document.querySelectorAll('#view-region .folio-table')[0];
    const input = wrap.querySelector('.folio-table-filter');
    const count = wrap.querySelector('.folio-table-count');
    const bar = wrap.querySelector('.folio-table-bar');
    return {
        value: input ? input.value : null,
        hidden: [...wrap.querySelectorAll('tbody tr')].filter((tr) => tr.hidden).length,
        count: count && !count.hidden ? count.textContent : null,
        barOpacity: getComputedStyle(bar).opacity,
        focused: document.activeElement === input,
    };
})()
"""


def _expect_overlay(ctx, **want) -> dict:
    st = _poll(lambda: (lambda s: s if all(s.get(k) == v for k, v in want.items()) else None)(
        _evalv(ctx, OVERLAY_JS) or {}
    ))
    ctx.expect(bool(st), f"Overlay-Zustand {want!r} nicht erreicht: {_evalv(ctx, OVERLAY_JS)!r}")
    return st or {}


def run(ctx):
    shutil.rmtree(FIXTURE_DIR, ignore_errors=True)
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    doc = FIXTURE_DIR / "tabellen.md"
    shutil.copyfile(ctx.fixture("tables-view.md"), doc)
    real_input = False

    try:
        with ctx.step("Fixture im View-Mode oeffnen, Theme GitHub hell"):
            ctx.api.open(str(doc))
            ctx.api.mode("view")
            _view_theme(ctx, "github", False)
            ctx.api.console_errors(clear=True)
            real_input = _focus_app_window()
            # Maus aus der View: die Hover-Leiste soll in der Baseline fehlen.
            if real_input:
                _xdotool("mousemove", "5", "795")

        with ctx.step("GitHub: breite Tabelle bricht aus, scrollt im Rahmen"):
            _check_layout(ctx, "github")
            _check_wrapping(ctx, "github", "#view-region .folio-table")
        with ctx.step("Screenshot tables_wide_github_light"):
            ctx.screenshot("tables_wide_github_light")

        with ctx.step("Clean hell/dunkel: gleiche Geometrie"):
            _view_theme(ctx, "clean", False)
            _check_layout(ctx, "clean")
            _check_wrapping(ctx, "clean", "#view-region .folio-table")
            ctx.screenshot("tables_wide_clean_light")
            _view_theme(ctx, "clean", True)
            _check_layout(ctx, "clean-dark")
            ctx.screenshot("tables_wide_clean_dark")

        with ctx.step("brand/pastel (overflow: hidden) schneiden nichts ab"):
            for theme_id in ("brand", "pastel"):
                _view_theme(ctx, theme_id, False)
                _check_layout(ctx, theme_id)

        with ctx.step("Rails, volle Breite und Split messen neu"):
            _view_theme(ctx, "clean", False)
            ctx.api.rail("left", False)
            ctx.api.rail("right", False)
            _settle(ctx)
            no_rails = _check_layout(ctx, "ohne Rails")
            ctx.api.eval("window.__TAURI__.core.invoke('set_content_wide',{wide:true})")
            ctx.expect(
                _poll(lambda: _evalv(ctx, "document.body.classList.contains('content-wide')")) is True,
                "content-wide nicht aktiv",
            )
            _settle(ctx)
            _check_layout(ctx, "volle Breite")
            ctx.api.eval("window.__TAURI__.core.invoke('set_content_wide',{wide:false})")
            ctx.api.rail("left", True)
            ctx.api.rail("right", True)
            ctx.api.mode("split")
            ctx.api.split(50)
            _settle(ctx)
            split = _check_layout(ctx, "split 50 %")
            ctx.expect(
                split["vcCW"] < no_rails["vcCW"],
                f"Split sollte die View schmaler machen: {split['vcCW']} vs {no_rails['vcCW']}",
            )
            ctx.api.mode("view")
            _view_theme(ctx, "github", False)

        with ctx.step("Hover zeigt die Leiste mit dem Vergroessern-Button"):
            if real_input:
                rect = _evalv(
                    ctx,
                    "(() => { const r = document.querySelector('#view-region .folio-table')"
                    ".getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + 40,"
                    " sx: window.screenX, sy: window.screenY}; })()",
                )
                _xdotool(
                    "mousemove",
                    str(int(rect["sx"] + rect["x"])),
                    str(int(rect["sy"] + rect["y"])),
                )
                ok = _poll(lambda: _evalv(
                    ctx,
                    "getComputedStyle(document.querySelector('#view-region .folio-table-bar')).opacity === '1'",
                ))
                ctx.expect(ok is True, "Leiste nach Hover nicht sichtbar")
                ctx.screenshot("tables_bar_hover")
                _xdotool("mousemove", "5", "795")
            else:
                print("[69] xdotool fehlt — Hover-Prüfung übersprungen")

        with ctx.step("Overlay oeffnen: sticky Kopf, Scrollen in beide Richtungen"):
            ctx.expect(_evalv(ctx, OPEN_OVERLAY_JS) is True, "Overlay nicht offen")
            st = _expect_overlay(ctx, open=True, inOverlay=True, placeholders=1)
            ctx.expect(
                st["ox"] == "auto" and st["oy"] == "auto"
                and st["sh"] > st["ch"] and st["sw"] > st["cw"],
                f"Overlay scrollt nicht in beide Richtungen: {st!r}",
            )
            ctx.expect(st["thPos"] == "sticky", f"Kopfzeile nicht sticky: {st!r}")
            _check_wrapping(ctx, "overlay", "#table-overlay-body")
            ctx.screenshot("tables_overlay_light")
            sticky = _evalv(
                ctx,
                "(() => { const s = document.querySelector('#table-overlay-body .folio-table-scroll');"
                " s.scrollTop = 300; const th = s.querySelector('thead th');"
                " return {top: th.getBoundingClientRect().top, box: s.getBoundingClientRect().top,"
                " scrolled: s.scrollTop}; })()",
            )
            ctx.expect(
                sticky["scrolled"] > 0 and abs(sticky["top"] - sticky["box"]) <= 1,
                f"Kopfzeile bleibt beim Scrollen nicht oben: {sticky!r}",
            )
            _evalv(ctx, "document.querySelector('#table-overlay-body .folio-table-scroll').scrollTop = 0")
            ctx.api.theme("dark")
            _view_theme(ctx, "github", True)
            ctx.screenshot("tables_overlay_dark")
            ctx.api.theme("light")
            _view_theme(ctx, "github", False)

        with ctx.step("Escape schliesst, Tabelle zurueck, Fokus auf dem Button"):
            if real_input:
                _focus_app_window()
                _xdotool("key", "Escape")
            else:
                print("[69] xdotool fehlt — Escape per dialog.close() nachgebildet")
                ctx.api.eval("document.getElementById('table-overlay').close()")
            _expect_overlay(ctx, open=False, placeholders=0, viewTables=3, firstIsWide=True,
                            focusExpand=True)

        with ctx.step("✕ schliesst"):
            _evalv(ctx, OPEN_OVERLAY_JS)
            _expect_overlay(ctx, open=True)
            ctx.api.eval("document.getElementById('table-overlay-close').click()")
            _expect_overlay(ctx, open=False, placeholders=0, viewTables=3, focusExpand=True)

        with ctx.step("Klick auf den Hintergrund schliesst"):
            _evalv(ctx, OPEN_OVERLAY_JS)
            _expect_overlay(ctx, open=True)
            if real_input:
                # Unterer Rand des Webviews (oben liegt die native GTK-Menüleiste):
                # ausserhalb des Dialogs, also auf dem ::backdrop.
                geo = _evalv(
                    ctx,
                    "({x: window.screenX, y: window.screenY + window.outerHeight - 10})",
                )
                _xdotool("mousemove", str(int(geo["x"] + 10)), str(int(geo["y"])), "click", "1")
                _xdotool("mousemove", "5", "795")
            else:
                ctx.api.eval(
                    "document.getElementById('table-overlay')"
                    ".dispatchEvent(new MouseEvent('click', {bubbles: true}))"
                )
            _expect_overlay(ctx, open=False, placeholders=0, viewTables=3)

        with ctx.step("Split: Live-Preview-Re-Render schliesst ein offenes Overlay"):
            ctx.api.mode("split")
            ctx.expect_event("editor.ready", timeout_ms=10000)
            _settle(ctx)
            _evalv(ctx, OPEN_OVERLAY_JS)
            _expect_overlay(ctx, open=True)
            ctx.api.eval(
                "(() => { const t = window.FolioEditor.getText();"
                " window.FolioEditor.applyReplace({fullText: t + '\\nNachtrag im Split.\\n',"
                " selectionStart: 0, selectionLength: 0, noReveal: true}); })()"
            )
            ok = _poll(lambda: _evalv(
                ctx,
                "document.querySelector('#view-region .markdown-body').textContent"
                ".includes('Nachtrag im Split')",
            ), timeout=5.0)
            ctx.expect(ok is True, "Live-Preview hat nicht neu gerendert")
            _expect_overlay(ctx, open=False, placeholders=0, viewTables=3)
            _check_layout(ctx, "nach Re-Render")
            errors = ctx.api.console_errors().get("errors") or []
            ctx.expect(not errors, f"Console-Fehler: {errors!r}")
            # Puffer zurueck auf den Dateistand (nicht dirty fuer den Reset).
            ctx.api.eval(
                "(() => { const t = window.FolioEditor.getText();"
                " window.FolioEditor.applyReplace({fullText: t.replace('\\nNachtrag im Split.\\n', ''),"
                " selectionStart: 0, selectionLength: 0, noReveal: true}); })()"
            )
            ctx.api.mode("view")

        rows = _fixture_rows(doc)
        ctx.expect(len(rows) == 30 and len(rows[0]) == 14, f"Fixture unerwartet: {len(rows)} Zeilen")
        original_nr = [r[0] for r in rows]

        with ctx.step("Filterfeld erst ab 6 Datenzeilen"):
            fields = _evalv(
                ctx,
                "[...document.querySelectorAll('#view-region .folio-table')]"
                ".map((w) => !!w.querySelector('.folio-table-filter'))",
            )
            ctx.expect(fields == [True, False, True], f"Filterfelder (30/5/6 Zeilen): {fields!r}")

        with ctx.step("Sortieren per Klick: Budget numerisch (de), Zyklus, aria-sort, Pfeil"):
            click = ("document.querySelectorAll('#view-region .folio-table')[0]"
                     ".querySelectorAll('thead th .folio-th-sort')[9].click()")
            ctx.api.eval(click)
            expected = [r[0] for r in sorted(rows, key=lambda r: _de_number(r[9]))]
            ctx.expect(_column(ctx, 0) == expected, f"Budget aufsteigend: {_column(ctx, 0)!r}")
            st = _sort_state(ctx, 9)
            ctx.expect(
                st.get("ariaSort") == "ascending" and st.get("arrow") == '"▲"'
                and st.get("arrowOpacity") == "0.8" and st.get("arranged") is True,
                f"Sortierzustand aufsteigend: {st!r}",
            )
            ctx.expect(st.get("sameFont") and st.get("sameColor"), f"Kopfzeile verliert Theme-Optik: {st!r}")
            ctx.api.eval(click)
            ctx.expect(_column(ctx, 0) == list(reversed(expected)), "Budget absteigend falsch")
            ctx.expect(_sort_state(ctx, 9).get("ariaSort") == "descending", "aria-sort nicht descending")
            ctx.api.eval(click)
            ctx.expect(_column(ctx, 0) == original_nr, "dritter Klick stellt die Originalreihenfolge nicht her")
            st = _sort_state(ctx, 9)
            ctx.expect(st.get("ariaSort") is None and st.get("arranged") is False, f"Zustand nach Reset: {st!r}")

        with ctx.step("Sortieren per Tastatur (Enter am Button), leere Zellen am Ende"):
            # Spalte „Bemerkung“ (12) hat leere Zellen (jede 6. Zeile).
            ctx.api.eval(
                "document.querySelectorAll('#view-region .folio-table')[0]"
                ".querySelectorAll('thead th .folio-th-sort')[12].focus()"
            )
            if real_input:
                _focus_app_window()
                _xdotool("key", "Return")
                _xdotool("key", "Return")
            else:
                print("[69] xdotool fehlt — Enter per click() nachgebildet")
                for _ in range(2):
                    ctx.api.eval("document.activeElement.click()")
            ok = _poll(lambda: _sort_state(ctx, 12).get("ariaSort") == "descending")
            ctx.expect(ok is True, f"Tastatur-Sortierung: {_sort_state(ctx, 12)!r}")
            col = _column(ctx, 12)
            empties = sum(1 for r in rows if r[12] == "")
            ctx.expect(
                empties == 5 and col[-empties:] == [""] * empties and "" not in col[:-empties],
                f"leere Zellen nicht am Ende: {col!r}",
            )
            ctx.screenshot("tables_sorted_light")

        with ctx.step("Filtern: echte Eingabe, Zaehler, Leiste bleibt sichtbar"):
            ctx.api.eval(
                "document.querySelectorAll('#view-region .folio-table')[0]"
                ".querySelector('.folio-table-filter').focus()"
            )
            if real_input:
                _xdotool("type", "--delay", "40", "NORD")
            else:
                ctx.api.eval(
                    "(() => { const i = document.activeElement; i.value = 'NORD';"
                    " i.dispatchEvent(new Event('input', {bubbles: true})); })()"
                )
            shown = sum(1 for r in rows if "nord" in " ".join(r).lower())
            want_count = f"{shown} von 30"
            st = _poll(lambda: (lambda f: f if f.get("count") == want_count else None)(_evalv(ctx, FILTER_JS) or {}))
            ctx.expect(bool(st), f"Filter „NORD“: erwartet {want_count}, ist {_evalv(ctx, FILTER_JS)!r}")
            ctx.expect(st["hidden"] == 30 - shown, f"versteckte Zeilen: {st!r}")
            ctx.expect(
                all("nord" in " ".join(r).lower() for r in rows if r[0] in _column(ctx, 0)),
                "sichtbare Zeile ohne Treffer",
            )
            # Sortierung (Bemerkung absteigend) bleibt beim Filtern bestehen.
            ctx.expect(_sort_state(ctx, 12).get("ariaSort") == "descending", "Sortierung beim Filtern verloren")
            ctx.api.eval("document.activeElement.blur()")
            ctx.api.sync_render()
            ctx.expect(
                (_evalv(ctx, FILTER_JS) or {}).get("barOpacity") == "1",
                "Leiste bei aktivem Filter nicht sichtbar",
            )
            ctx.screenshot("tables_sorted_filtered_light")
            ctx.api.theme("dark")
            _view_theme(ctx, "github", True)
            ctx.screenshot("tables_sorted_filtered_dark")
            ctx.api.theme("light")
            _view_theme(ctx, "github", False)

        with ctx.step("Find-Bar zaehlt keine Treffer in versteckten Zeilen"):
            ctx.api.eval(
                "(() => { window.__t69find = null; window.addEventListener('folio-find-state',"
                " (e) => { if (!e.detail.scanning) window.__t69find = e.detail; }); return true; })()"
            )
            ctx.api.find_open()
            # „Süddeutschland“ steht nur in Zeilen, die der Filter „NORD" versteckt.
            ctx.api.find_text("Süddeutschland")
            res = _poll(lambda: _evalv(
                ctx, "window.__t69find && window.__t69find.term === 'Süddeutschland' && window.__t69find",
            ))
            ctx.expect(bool(res) and res.get("total") == 0, f"Find zaehlt versteckte Zeilen: {res!r}")
            ctx.api.find_text("Norddeutschland")
            res = _poll(lambda: _evalv(
                ctx, "window.__t69find && window.__t69find.term === 'Norddeutschland' && window.__t69find",
            ))
            north = sum(1 for r in rows if r[11] == "Norddeutschland")
            ctx.expect(bool(res) and res.get("total") == north, f"Find sichtbare Treffer: {res!r} (erwartet {north})")
            ctx.api.find_close()

        with ctx.step("Escape im Filterfeld leert es"):
            ctx.api.eval(
                "document.querySelectorAll('#view-region .folio-table')[0]"
                ".querySelector('.folio-table-filter').focus()"
            )
            if real_input:
                _focus_app_window()
                _xdotool("key", "Escape")
            else:
                ctx.api.key("Escape", target="document")
            st = _poll(lambda: (lambda f: f if f.get("value") == "" else None)(_evalv(ctx, FILTER_JS) or {}))
            ctx.expect(bool(st) and st["hidden"] == 0 and st["count"] is None, f"Escape leert nicht: {st!r}")
            ctx.expect(st.get("focused") is True, "Fokus sollte im Filterfeld bleiben")

        with ctx.step("Split: Sortierung und Filter ueberleben Tippen im Editor"):
            ctx.api.mode("split")
            _settle(ctx)
            # Zustand aus dem View-Mode (Bemerkung absteigend) ist noch da.
            ctx.expect(_sort_state(ctx, 12).get("ariaSort") == "descending", "Sortierung nach Mode-Wechsel weg")
            ctx.api.eval(
                "(() => { const i = document.querySelectorAll('#view-region .folio-table')[0]"
                ".querySelector('.folio-table-filter'); i.value = 'west';"
                " i.dispatchEvent(new Event('input', {bubbles: true})); })()"
            )
            west = sum(1 for r in rows if "west" in " ".join(r).lower())
            before = _column(ctx, 0)
            ctx.api.eval(
                "(() => { const t = window.FolioEditor.getText();"
                " window.FolioEditor.applyReplace({fullText: t + '\\nGetippt im Split.\\n',"
                " selectionStart: 0, selectionLength: 0, noReveal: true}); })()"
            )
            ok = _poll(lambda: _evalv(
                ctx, "document.querySelector('#view-region .markdown-body').textContent.includes('Getippt im Split')",
            ), timeout=5.0)
            ctx.expect(ok is True, "Live-Preview hat nicht neu gerendert")
            st = _evalv(ctx, FILTER_JS) or {}
            ctx.expect(
                st.get("value") == "west" and st.get("count") == f"{west} von 30",
                f"Filter nach Re-Render: {st!r}",
            )
            ctx.expect(_sort_state(ctx, 12).get("ariaSort") == "descending", "Sortierung nach Re-Render weg")
            ctx.expect(_column(ctx, 0) == before, "Zeilenfolge nach Re-Render anders")

        with ctx.step("Split: geaenderte Kopfzeile → Zustand verfaellt still"):
            ctx.api.eval(
                "(() => { const t = window.FolioEditor.getText();"
                " window.FolioEditor.applyReplace({fullText: t.replace('| Nr. |', '| Nummer |'),"
                " selectionStart: 0, selectionLength: 0, noReveal: true}); })()"
            )
            ok = _poll(lambda: _evalv(
                ctx, "!!document.querySelector('#view-region .markdown-body th') &&"
                " document.querySelector('#view-region .markdown-body th').textContent.trim() === 'Nummer'",
            ), timeout=5.0)
            ctx.expect(ok is True, "Kopfzeilen-Aenderung nicht gerendert")
            st = _evalv(ctx, FILTER_JS) or {}
            ctx.expect(st.get("value") == "" and st.get("hidden") == 0, f"Filter haette verfallen muessen: {st!r}")
            ctx.expect(_sort_state(ctx, 12).get("ariaSort") is None, "Sortierung haette verfallen muessen")
            ctx.expect(_column(ctx, 0) == original_nr, "Originalreihenfolge erwartet")
            errors = ctx.api.console_errors().get("errors") or []
            ctx.expect(not errors, f"Console-Fehler: {errors!r}")
            ctx.api.eval(
                "(() => { const t = window.FolioEditor.getText();"
                " window.FolioEditor.applyReplace({fullText: t.replace('| Nummer |', '| Nr. |')"
                ".replace('\\nGetippt im Split.\\n', ''),"
                " selectionStart: 0, selectionLength: 0, noReveal: true}); })()"
            )
            ctx.api.mode("view")
            if real_input:
                _xdotool("mousemove", "5", "795")

        with ctx.step("Export und Theme-Editor-Vorschau: kein Wrapper, kein Button"):
            html = _evalv(ctx, "window.__folioInvoke('export_render', {layoutId: 'github'})")
            ctx.expect(isinstance(html, str) and "<table" in html, "Export ohne Tabelle")
            for marker in ("folio-table", "folio-th-sort", "folio-cell-long", "data-folio"):
                ctx.expect(marker not in html, f"Export enthaelt App-Tabellen-Markup {marker!r}")
            preview = _evalv(
                ctx,
                "window.__folioInvoke('theme_read', {id: 'github'}).then((files) =>"
                " window.__folioInvoke('theme_preview_render', {markdown: %r, parts: files,"
                " dark: false, themeId: 'github'}))" % doc.read_text(encoding="utf-8"),
            )
            ctx.expect(isinstance(preview, str) and "<table" in preview, "Vorschau ohne Tabelle")
            for marker in ("folio-table", "folio-th-sort", "folio-cell-long", "data-folio"):
                ctx.expect(marker not in preview, f"Theme-Vorschau enthaelt App-Tabellen-Markup {marker!r}")
    finally:
        try:
            ctx.api.eval("window.__TAURI__.core.invoke('set_content_wide',{wide:false})")
            ctx.api.eval(
                "(() => { const d = document.getElementById('table-overlay');"
                " if (d && d.open) d.close(); })()"
            )
            ctx.api.rail("right", True)
            ctx.api.rail("left", True)
        except Exception:
            pass
        if real_input:
            # Ausgangsposition von Xvfb (Bildmitte) wiederherstellen.
            _xdotool("mousemove", "640", "400")
        shutil.rmtree(FIXTURE_DIR, ignore_errors=True)
