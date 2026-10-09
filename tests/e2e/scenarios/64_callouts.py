"""E2E: Callouts (GitHub-Alerts) in View und Split, hell und dunkel.

Die Fixture enthält alle fünf Typen — Großschreibung, Kleinschreibung,
eigener Titel und beide Obsidian-Faltmarker (`+` ohne Titel → Default,
`-` mit Titel → Marker entfernt) — sowie ein `[!todo]`, das als normales
Zitat stehen bleiben muss.

Geprüft wird funktional (Klassen, Titel, Symbol-Maske, Kontrast von
Titel ≥ 4.5:1 und Boxtext ≥ 7:1 gegen den komponierten Boxhintergrund)
und per Screenshot. Die Kontrastprüfung läuft zusätzlich über alle eingebauten View-Themes, jeweils hell und
dunkel: View-Themes werden NACH content.css injiziert und setzen
eigene Hintergründe — `classic` hat keine Dark-Variante und bleibt im
dunklen App-Theme ein weißes Blatt.

Feste Fixture unter /tmp (nicht mkdtemp): der Pfad steht in Statusleiste
und Tab und ist damit Teil der Visual-Baseline — gleiche Begründung wie
bei 56/57/59/63.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

FIXTURE_DIR = Path("/tmp/folio-e2e-callouts")

# theme/builtin.rs::IDS ohne "standard" (oben schon geprüft).
BUILTIN_THEMES = (
    "classic", "clean", "github", "business", "report", "minimal", "brand",
    "warm", "tech", "contrast", "pastel",
)

EXPECTED = [
    ("markdown-alert markdown-alert-note", "Note"),
    ("markdown-alert markdown-alert-tip", "Tip"),
    ("markdown-alert markdown-alert-important", "Important"),
    ("markdown-alert markdown-alert-warning", "Achtung, Strom"),
    ("markdown-alert markdown-alert-caution", "Eingeklappt"),
]

# Liest pro Callout Klasse, Titel, Symbol-Maske und den Kontrast von Titel
# und Boxtext gegen den Hintergrund, auf dem sie tatsächlich stehen.
#
# Herleitung des effektiven Hintergrunds (unabhängig vom CSS der Box):
# Was hinter einem Element sichtbar ist, ergibt sich aus den
# Hintergrundfarben des Elements selbst und aller Vorfahren. Gesammelt wird
# vom Textelement nach oben bis einschließlich der ersten opaken Farbe
# (Alpha 1; darunter Liegendes ist verdeckt). Fehlt eine, ist die
# Canvas-Farbe Weiß die Basis. Dann wird von außen nach innen „source over"
# komponiert: C = a·Schicht + (1−a)·C. Eine halbtransparente Textfarbe wird
# ebenso über diesen Hintergrund gelegt. Kontrast nach WCAG 2.x (relative
# Luminanz, (L1+0.05)/(L2+0.05)).
PROBE_JS = """
(() => {
    const parse = (c) => {
        const m = c.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const p = m[1].split(',').map(s => parseFloat(s));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (top, base) => ({
        r: top.a * top.r + (1 - top.a) * base.r,
        g: top.a * top.g + (1 - top.a) * base.g,
        b: top.a * top.b + (1 - top.a) * base.b,
        a: 1,
    });
    const backdrop = (el) => {
        const layers = [];
        for (let n = el; n; n = n.parentElement) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c && c.a > 0) layers.push(c);
            if (c && c.a >= 1) break;
        }
        let acc = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
        return acc;
    };
    const lum = (c) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
        const x = lum(a), y = lum(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    const contrast = (el) => {
        const bg = backdrop(el);
        const fg = over(parse(getComputedStyle(el).color), bg);
        return { ratio: ratio(fg, bg), fg: hex(fg), bg: hex(bg) };
    };
    const body = document.querySelector('#view-region .markdown-body');
    if (!body) return null;
    const alerts = [...body.querySelectorAll('.markdown-alert')].map((el) => {
        const title = el.querySelector('.markdown-alert-title');
        const icon = getComputedStyle(title, '::before');
        const text = el.querySelector('p:not(.markdown-alert-title)');
        const mask = icon.webkitMaskImage || icon.maskImage || '';
        return {
            cls: el.className,
            title: title.textContent,
            icon: mask.includes('data:image/svg+xml') && icon.width === '16px',
            border: getComputedStyle(el).borderLeftWidth,
            titleC: contrast(title),
            textC: contrast(text),
        };
    });
    return {
        alerts,
        quotes: body.querySelectorAll('blockquote').length,
        todoQuote: [...body.querySelectorAll('blockquote')].some(q => q.textContent.includes('[!todo]')),
    };
})()
"""

# Vertrag: Titel ≥ 4.5:1 (WCAG AA), Boxtext ≥ 7:1 (AAA), jeweils gegen den
# komponierten Boxhintergrund.
MIN_TITLE = 4.5
MIN_TEXT = 7.0


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


def _check(ctx, label: str) -> list[str]:
    """Strukturfehler brechen sofort ab; Kontrastverstöße werden gesammelt
    zurückgegeben, damit ein Lauf die ganze Matrix zeigt."""
    probe = _evalv(ctx, PROBE_JS) or {}
    alerts = probe.get("alerts") or []
    got = [(a.get("cls"), a.get("title")) for a in alerts]
    ctx.expect(got == EXPECTED, f"[{label}] Callouts: {got!r}")
    ctx.expect(
        probe.get("quotes") == 1 and probe.get("todoQuote") is True,
        f"[{label}] [!todo] sollte das einzige Zitat sein: {probe!r}",
    )
    failures = []
    for alert in alerts:
        name = alert["cls"].rsplit("-", 1)[-1]
        ctx.expect(alert.get("icon") is True, f"[{label}] {name}: Symbol fehlt: {alert!r}")
        ctx.expect(alert.get("border") not in (None, "0px"), f"[{label}] {name}: kein Farbbalken: {alert!r}")
        title, text = alert["titleC"], alert["textC"]
        print(
            f"[contrast] {label:18} {name:9} titel {title['ratio']:5.2f} "
            f"({title['fg']} auf {title['bg']})  text {text['ratio']:5.2f} ({text['fg']})"
        )
        if title["ratio"] < MIN_TITLE:
            failures.append(f"[{label}] {name}: Titel {title['ratio']:.2f} < {MIN_TITLE} {title!r}")
        if text["ratio"] < MIN_TEXT:
            failures.append(f"[{label}] {name}: Text {text['ratio']:.2f} < {MIN_TEXT} {text!r}")
    return failures


def _expect_contrast(ctx, failures: list[str]) -> None:
    ctx.expect(not failures, f"{len(failures)} Kontrastverstöße:\n" + "\n".join(failures))


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
    ctx.api.sync_render()


def run(ctx):
    shutil.rmtree(FIXTURE_DIR, ignore_errors=True)
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    doc = FIXTURE_DIR / "callouts.md"
    shutil.copyfile(ctx.fixture("callouts.md"), doc)

    try:
        with ctx.step("Fixture im View-Mode oeffnen (hell)"):
            ctx.api.open(str(doc))
            ctx.api.mode("view")
            ctx.api.theme("light")
            ctx.expect(
                bool(_poll(lambda: _evalv(ctx, "document.querySelectorAll('#view-region .markdown-alert').length") == 5)),
                "fuenf .markdown-alert erwartet",
            )
            ctx.api.sync_render()

        with ctx.step("Hell: Klassen, Titel, Symbol, Kontrast"):
            _expect_contrast(ctx, _check(ctx, "standard/hell"))

        with ctx.step("Screenshot-Baseline callouts_view_light"):
            ctx.screenshot("callouts_view_light")

        with ctx.step("Dunkel: Klassen, Titel, Symbol, Kontrast"):
            ctx.api.theme("dark")
            ctx.api.sync_render()
            _expect_contrast(ctx, _check(ctx, "standard/dunkel"))

        with ctx.step("Screenshot-Baseline callouts_view_dark"):
            ctx.screenshot("callouts_view_dark")

        with ctx.step("Split-Mode (Live-Preview-Seite) hell"):
            ctx.api.theme("light")
            ctx.api.mode("split")
            ctx.api.sync_render()
            _expect_contrast(ctx, _check(ctx, "split/hell"))
            ctx.screenshot("callouts_split_light")

        with ctx.step("Alle eingebauten View-Themes (hell/dunkel): Box intakt, Kontrast"):
            ctx.api.mode("view")
            failures = []
            for theme_id in BUILTIN_THEMES:
                for dark in (False, True):
                    _view_theme(ctx, theme_id, dark)
                    failures += _check(ctx, f"{theme_id}/{'dunkel' if dark else 'hell'}")
            _expect_contrast(ctx, failures)

        with ctx.step("Screenshot-Baseline callouts_classic_dark"):
            # classic hat keine Dark-Variante: weißes Blatt im dunklen App-Theme.
            _view_theme(ctx, "classic", True)
            ctx.screenshot("callouts_classic_dark")
    finally:
        try:
            ctx.api.settings_set({"viewTheme": "standard"})
            ctx.api.theme("light")
            ctx.api.mode("view")
        except Exception:
            pass
        shutil.rmtree(FIXTURE_DIR, ignore_errors=True)
