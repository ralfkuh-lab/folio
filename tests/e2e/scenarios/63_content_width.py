"""E2E: „Volle Breite" — Lesebreite der gerenderten View umschalten.

Der Vertrag ist eng umrissen: der Toggle hebt `max-width` auf
`.markdown-body` auf — und nur dort. Geprüft wird deshalb nicht nur, DASS
die Breite wächst, sondern auch, wo der Schalter bewusst NICHT hinreicht:

  1. View-Mode: Ausgangsbreite ≤ Lesebreite, nach dem Klick volle
     Region-Breite, Body-Klasse + Button-State + Persistenz im Backend.
  2. Split-Mode: die View-Seite ist dieselbe `.markdown-body` und zieht
     mit — der Toggle ist kein View-Mode-Sonderfall.
  3. Edit-Mode: Button ausgeblendet (`view-only`), Menüeintrag disabled.
     Monaco war nie breitenbegrenzt, hier gäbe es nichts zu schalten.

Beide Rails werden dafür ausgeblendet, und der Split-Teiler auf 20 %
gestellt. Das ist keine Test-Kosmetik, sondern Voraussetzung: bei
sichtbaren Rails ist die View-Region auf 1280×800 nur ~670 px breit,
`max-width: 900px` bindet dort gar nicht, und der Toggle wäre
wirkungslos — messbar wird er erst, wenn Platz da ist. Genau darum geht
es beim Feature (Rails zuklappen soll etwas bringen).

Feste Fixture unter /tmp (nicht mkdtemp): der Pfad steht in der
Statusleiste und im Tab und ist damit Teil der Visual-Baseline — gleiche
Begründung wie bei 56/57/59.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

FIXTURE_DIR = Path("/tmp/folio-e2e-contentwidth")

# Breite Tabelle: im begrenzten Zustand brechen die Spalten um, in voller
# Breite nicht. Genau der Fall, für den es den Schalter gibt.
DOC = """# Breitentest

| Aufgabe | Bevorzugte Besetzung | Alternativen und Grenzen | Bemerkung |
| --- | --- | --- | --- |
| Planung, Spezifikation, Koordination | Modell A oder Modell B | Nur diese beiden; eigene Pruefung bleibt Pflicht | Endabnahme beim Orchestrator |
| Sparring, Beratung, Architektur-Zweitmeinung | Der Partner aus der Rollenpaartabelle | Feste Zuordnung; fehlende Verfuegbarkeit offen benennen | Kein stiller Wechsel |
| Implementierung groesserer Pakete | Der jeweils schnellste Implementierer | Bei Problemen eskalieren statt blind wiederholen | Modellwechsel kurz begruenden |

Ein Absatz Fliesstext darunter, damit die Lesebreite sichtbar bleibt und
der Unterschied zwischen begrenzter und voller Breite auch ohne Tabelle
im Screenshot erkennbar ist.
"""


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(fn, timeout: float = 3.0, interval: float = 0.05):
    """Pollt fn() bis truthy oder Timeout; liefert den letzten Wert."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _body_width(ctx) -> float:
    """Gerenderte Breite von .markdown-body in CSS-Pixeln."""
    value = _evalv(
        ctx,
        "(() => { const el = document.querySelector('#view-region .markdown-body');"
        " return el ? el.getBoundingClientRect().width : -1; })()",
    )
    return float(value if isinstance(value, (int, float)) else -1)


def _state(ctx) -> dict:
    """Body-Klasse, Button-State und Button-Sichtbarkeit in einem Zug."""
    return _evalv(
        ctx,
        """
        (() => {
            const btn = document.getElementById('tb-content-width');
            return {
                wide: document.body.classList.contains('content-wide'),
                active: !!btn && btn.classList.contains('active'),
                visible: !!btn && btn.offsetParent !== null,
            };
        })()
        """,
    ) or {}


def _persisted(ctx):
    """Backend-Wahrheit statt DOM: was liefert content_wide_get?"""
    return _evalv(ctx, "window.__TAURI__.core.invoke('content_wide_get')")


def run(ctx):
    shutil.rmtree(FIXTURE_DIR, ignore_errors=True)
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    doc = FIXTURE_DIR / "breite.md"
    doc.write_text(DOC, encoding="utf-8")

    try:
        with ctx.step("Dokument im View-Mode oeffnen, beide Rails zu"):
            ctx.api.open(str(doc))
            ctx.api.mode("view")
            # Ohne das bleibt die View-Region unter 900px und die
            # Lesebreite bindet nicht — siehe Modul-Docstring.
            ctx.api.rail("left", False)
            ctx.api.rail("right", False)
            ctx.api.sync_render()

        with ctx.step("Ausgangszustand: Lesebreite, Toggle aus, Button sichtbar"):
            before = _body_width(ctx)
            ctx.expect(before > 0, f".markdown-body nicht messbar: {before!r}")
            # 900px Default + Padding; die Themes liegen darunter. Ein
            # grosszuegiges Limit reicht — entscheidend ist der Sprung
            # unten, nicht der exakte Wert.
            # Default-Theme: exakt 900px (box-sizing: border-box). Ein
            # kleiner Puffer nach oben deckt Rundung ab.
            ctx.expect(
                before <= 910,
                f"erwartet begrenzte Lesebreite, gemessen {before!r}px",
            )
            st = _state(ctx)
            ctx.expect(
                st.get("wide") is False and st.get("active") is False,
                f"erwartet Toggle aus, State={st!r}",
            )
            ctx.expect(
                st.get("visible") is True,
                f"#tb-content-width sollte im View-Mode sichtbar sein, State={st!r}",
            )
            ctx.expect(
                _persisted(ctx) is False,
                "content_wide_get sollte beim Start false liefern",
            )

        with ctx.step("Screenshot-Baseline content_width_reading"):
            ctx.screenshot("content_width_reading")

        with ctx.step("Klick schaltet auf volle Breite (DOM + Persistenz)"):
            ctx.api.click("tb-content-width")
            st = _poll(lambda: _state(ctx) if _state(ctx).get("wide") else None)
            ctx.expect(
                bool(st) and st.get("wide") is True and st.get("active") is True,
                f"erwartet content-wide + aktiver Button, State={st!r}",
            )
            ctx.api.sync_render()
            after = _body_width(ctx)
            ctx.expect(
                after > before,
                f"erwartet breitere View: vorher {before!r}px, nachher {after!r}px",
            )
            # safeInvoke ist fire-and-forget — die Persistenz kann dem DOM
            # nachlaufen, deshalb pollen statt einmal lesen.
            ctx.expect(
                _poll(lambda: _persisted(ctx) is True) is True,
                "content_wide_get sollte nach dem Klick true liefern",
            )

        with ctx.step("Screenshot-Baseline content_width_full"):
            ctx.screenshot("content_width_full")

        with ctx.step("Split-Mode: die View-Seite zieht mit"):
            ctx.api.mode("split")
            # Editor auf 20 % → View-Seite ~1020px und damit ueber der
            # Lesebreite. Bei 50/50 waere sie ~640px, die Begrenzung
            # bliebe unwirksam und der Schritt truege nichts bei.
            ctx.api.split(20)
            ctx.api.sync_render()
            split_wide = _body_width(ctx)
            ctx.expect(
                _state(ctx).get("wide") is True,
                "content-wide sollte den Mode-Wechsel ueberleben",
            )
            # Gegenprobe im selben Mode: ausschalten muss die View-Seite
            # wieder schmaler machen. Ohne diesen Schritt bliebe offen, ob
            # die Klasse im Split ueberhaupt CSS-Wirkung hat.
            ctx.api.click("tb-content-width")
            ctx.expect(
                _poll(lambda: _state(ctx).get("wide") is False) is True,
                "Toggle sollte sich im Split-Mode ausschalten lassen",
            )
            ctx.api.sync_render()
            split_narrow = _body_width(ctx)
            ctx.expect(
                split_narrow < split_wide,
                "erwartet schmalere View-Seite im Split nach dem Ausschalten: "
                f"breit {split_wide!r}px, schmal {split_narrow!r}px",
            )

        with ctx.step("Edit-Mode: Button ausgeblendet (view-only)"):
            ctx.api.mode("edit")
            ctx.expect_event("editor.ready", timeout_ms=10000)
            ctx.api.sync_render()
            st = _state(ctx)
            ctx.expect(
                st.get("visible") is False,
                f"#tb-content-width sollte im Edit-Mode versteckt sein, State={st!r}",
            )

        with ctx.step("zurueck in den View-Mode (Mode-Reset)"):
            ctx.api.mode("view")
    finally:
        # Der Toggle ist persistent — ein angelassener Zustand wanderte in
        # jede spaetere Baseline. Der kanonische Reset faengt das ebenfalls
        # ab; hier zusaetzlich, damit ein Einzellauf nichts hinterlaesst.
        try:
            ctx.api.eval(
                "window.__TAURI__.core.invoke('set_content_wide',{wide:false})"
            )
        except Exception:
            pass
        # Die rechte Rail fasst der kanonische Reset bewusst nicht an
        # (siehe lib/reset.py) — dieses Szenario hat sie zugeklappt und
        # muss sie selbst zurueckgeben.
        try:
            ctx.api.rail("right", True)
        except Exception:
            pass
        shutil.rmtree(FIXTURE_DIR, ignore_errors=True)
