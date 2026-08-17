"""E2E: Zen-Modus — Chrome ausblenden, ohne persistierten Zustand zu ändern.

Der Kern der Spec (`docs/spec-zen-mode.md`) ist die Layer-Semantik: die
Body-Klasse `zen-mode` ÜBERDECKT Toolbar, Rails, Tab-Leiste und
Statusleiste, statt die Rail-Toggles umzuschalten. Würde Zen
`panel_state.json` schreiben, hätte der Nutzer nach dem Ausschalten seine
vorher offene Vault-Rail dauerhaft verloren. Genau das prüft dieses
Szenario — am Zustand der Datei, nicht nur am DOM.

`zenFullscreen` wird bewusst auf False gesetzt: ob Xvfb echtes Vollbild
liefert, ist nicht verlässlich, und ein umgeschalteter Fenstermodus machte
jede Visual-Baseline wertlos. Der Vollbild-Pfad wird hier nur daraufhin
geprüft, dass der Command ohne Fehler durchläuft.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

# Vom run-e2e.sh-Wrapper gesetzt (XDG_CONFIG_HOME=<repo>/tests/e2e/.temp_home/.config).
PANEL_STATE = "folio/panel-state.json"

ZEN_HIDDEN = ["#toolbar", "#vault-region", "#tab-bar", "#statusbar"]


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(fn, timeout: float = 5.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _panel_state_path() -> Path | None:
    base = os.environ.get("XDG_CONFIG_HOME")
    if not base:
        return None
    path = Path(base) / PANEL_STATE
    return path if path.is_file() else None


def _rail_flags_from_disk() -> dict | None:
    """Nur die Rail-Felder — andere dürfen sich ändern (z. B. zen_hint_seen)."""
    path = _panel_state_path()
    if path is None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return {
        key: data.get(key)
        for key in ("left_rail_visible", "right_rail_visible")
    }


def _visible(ctx, selector: str) -> bool:
    return _evalv(
        ctx,
        "(function(){"
        f"var n=document.querySelector({json.dumps(selector)});"
        "if(!n)return false;"
        "return n.offsetParent!==null||n.getClientRects().length>0;})()",
    ) is True


def _zen_on(ctx) -> bool:
    return _evalv(ctx, "document.body.classList.contains('zen-mode')") is True


def _ensure_zen(ctx, want: bool) -> None:
    """Zustand herstellen statt blind togglen.

    `view.zen` ist ein Toggle; wer den Vorzustand aus dem vorherigen Schritt
    errät, baut sich Folgefehler ein (dieselbe Lektion wie beim View-Mode,
    siehe docs/e2e-headless-caveats.md).
    """
    if _zen_on(ctx) == want:
        return
    ctx.api.menu_click("view.zen")
    ctx.expect(
        bool(_poll(lambda: _zen_on(ctx) == want)),
        f"Zen ließ sich nicht auf {want!r} setzen",
    )


def _send_escape(ctx, selector: str | None = None) -> None:
    """Escape an document oder gezielt an ein Element.

    Der Zen-Handler sitzt in der Capture-Phase auf `document` und sieht das
    Event auch dann, wenn es an einem Kind dispatcht wird — genau so lässt
    sich die Prioritätskette realistisch prüfen: Die Find-Bar hört Escape
    nur auf ihren eigenen Inputs (`ui/find-bar.ts`), nicht auf `document`.
    """
    target = f"document.querySelector({json.dumps(selector)})" if selector else "document"
    _evalv(
        ctx,
        "(function(){"
        f"var t={target};"
        "if(!t)return false;"
        "t.dispatchEvent(new KeyboardEvent('keydown',"
        "{key:'Escape',bubbles:true,cancelable:true}));return true;})()",
    )


def run(ctx):
    sample = ctx.fixture("sample.md")
    try:
        with ctx.step("Vorbereiten: Dokument offen, zenFullscreen aus"):
            ctx.api.settings_set({"zenFullscreen": False})
            ctx.api.open(sample)
            ctx.api.mode("view")
            for sel in ZEN_HIDDEN:
                ctx.expect(_visible(ctx, sel), f"{sel} sollte vor Zen sichtbar sein")
            ctx.expect(not _zen_on(ctx), "Zen darf vor dem Test nicht an sein")

        with ctx.step("Einmal an/aus, damit der Einmal-Hinweis abgehakt ist"):
            # Der erste Zen-Aufruf setzt zen_hint_seen in panel-state.json.
            # Ohne diesen Vorlauf verglichen wir später eine Datei, die sich
            # aus einem anderen — legitimen — Grund geändert hat.
            _ensure_zen(ctx, True)
            _ensure_zen(ctx, False)

        with ctx.step("Zen blendet Toolbar, Rails, Tabs und Statusleiste aus"):
            before_disk = _rail_flags_from_disk()
            before_state = ctx.api.state()

            _ensure_zen(ctx, True)
            for sel in ZEN_HIDDEN:
                ctx.expect(
                    bool(_poll(lambda s=sel: not _visible(ctx, s))),
                    f"{sel} ist im Zen noch sichtbar",
                )
            state = ctx.api.state()
            ctx.expect(state.get("zen") is True, f"/state.zen nicht true: {state.get('zen')!r}")

        with ctx.step("Screenshot-Baseline zen_mode_on"):
            ctx.screenshot("zen_mode_on")

        with ctx.step("Ausschalten stellt alles wieder her"):
            _ensure_zen(ctx, False)
            for sel in ZEN_HIDDEN:
                ctx.expect(
                    bool(_poll(lambda s=sel: _visible(ctx, s))),
                    f"{sel} kam nach dem Zen nicht zurück",
                )

        with ctx.step("Kernvertrag: panel_state ist unverändert geblieben"):
            after_disk = _rail_flags_from_disk()
            after_state = ctx.api.state()
            # Der eigentliche Beweis der Layer-Semantik: Zen hat die
            # Rail-Toggles nicht angefasst, weder im Speicher noch auf Platte.
            ctx.expect(
                after_disk == before_disk,
                f"Rail-Flags in panel-state.json geändert: {before_disk!r} → {after_disk!r}",
            )
            for key in ("left_rail_visible", "right_rail_visible"):
                ctx.expect(
                    before_state.get(key) == after_state.get(key),
                    f"/state.{key} geändert: "
                    f"{before_state.get(key)!r} → {after_state.get(key)!r}",
                )

        with ctx.step("Escape verlässt Zen"):
            _ensure_zen(ctx, True)
            _send_escape(ctx)
            ctx.expect(
                bool(_poll(lambda: not _zen_on(ctx))),
                "Escape hat den Zen-Modus nicht verlassen",
            )

        with ctx.step("Escape gehört zuerst der Find-Bar, Zen bleibt an"):
            _ensure_zen(ctx, True)
            ctx.api.find_text("Markdown")
            ctx.expect(
                bool(_poll(lambda: _evalv(
                    ctx,
                    "(function(){var b=document.getElementById('find-bar');"
                    "return !!b&&b.classList.contains('open');})()",
                ) is True)),
                "Find-Bar öffnete nicht",
            )
            # Gezielt an den Find-Input: die Find-Bar hört Escape nur dort.
            _send_escape(ctx, "#find-input")
            # Die Find-Bar schließt, der Zen-Layer überlebt — Zen ist der
            # LETZTE Kandidat in der Escape-Kette.
            ctx.expect(
                bool(_poll(lambda: _evalv(
                    ctx,
                    "(function(){var b=document.getElementById('find-bar');"
                    "return !b||!b.classList.contains('open');})()",
                ) is True)),
                "Find-Bar schloss nicht auf Escape",
            )
            ctx.expect(_zen_on(ctx), "Zen wurde zusammen mit der Find-Bar beendet")

        with ctx.step("Offene Filterzeile blockiert den Escape-Ausstieg nicht"):
            # Regressionstest zum Kreuz-Review-Befund: #vault-filter behält sein
            # hidden=false, während die Rail im Zen per CSS weg ist. Die
            # Prioritätsliste hielt den unsichtbaren Filter für ein offenes
            # Overlay und verweigerte jeden Escape-Ausstieg — und
            # `vault_filter_bar_visible` ist persistiert, der Zustand also
            # dauerhaft.
            # Erst Zen verlassen — im Zen ist die Rail ausgeblendet und der
            # Funnel-Button nicht klickbar.
            _ensure_zen(ctx, False)
            ctx.api.click("#vault-filter-toggle")
            ctx.expect(
                bool(_poll(lambda: _evalv(
                    ctx,
                    "(function(){var f=document.getElementById('vault-filter');"
                    "return !!f&&!f.hidden;})()",
                ) is True)),
                "Filterzeile öffnete nicht",
            )
            _ensure_zen(ctx, True)
            _send_escape(ctx)
            ctx.expect(
                bool(_poll(lambda: not _zen_on(ctx))),
                "Escape blieb an der unsichtbaren Filterzeile hängen",
            )
            ctx.api.click("#vault-filter-toggle")

        with ctx.step("Vollbild-Command läuft (ohne Xvfb-Zusicherung)"):
            _ensure_zen(ctx, False)
            # Nur Rauchtest: unter Xvfb ist echtes Vollbild nicht verlässlich,
            # der Command darf aber nicht fehlschlagen.
            ctx.api.menu_click("view.fullscreen")
            ctx.api.menu_click("view.fullscreen")
            ctx.expect(
                ctx.api.state().get("zen") is False,
                "Vollbild-Toggle hat den Zen-Zustand verändert",
            )
    finally:
        try:
            _evalv(ctx, "typeof window.__folioZenReset==='function'&&window.__folioZenReset()")
        except Exception:
            pass
        try:
            _evalv(
                ctx,
                "typeof window.__folioVaultFilterReset==='function'"
                "&&window.__folioVaultFilterReset()",
            )
        except Exception:
            pass
        try:
            ctx.api.settings_set({"zenFullscreen": True})
        except Exception:
            pass
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
