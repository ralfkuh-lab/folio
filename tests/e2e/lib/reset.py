"""Kanonischer UI-Reset vor jedem Szenario.

Stellt den Ausgangszustand wieder her, den ein Szenario beim Start
vorfinden soll: leerer Tab, Light-Theme, Find-Bar zu, View-Mode,
Vault-Rail sichtbar, Split auf 50 %, leere Recent-Liste, Settings auf
dem Run-Start-Snapshot. Damit kodiert jede Visual-Baseline nur noch
den Zustand ihres eigenen Szenarios statt des kumulierten
Voll-Lauf-Zustands (Dark-Theme aus 04, offene Find-Bar aus 06,
wachsende Recent-Liste, Mode-Leaks). Der Reset laeuft in Voll- UND
Auswahl-Laeufen gleichermassen — sonst stimmen Einzellaeufe nicht mit
den Baselines ueberein. Ausnahme: im --attach-Modus ist der Reset
opt-in (--attach-reset), weil er Tabs verwerfen und die echte
Recent-Liste persistent leeren wuerde.

Fehlerverhalten: jeder Schritt ausser dem Mode-Reset ist ein harter
Fehler (Exception) — der Lauf soll laut scheitern statt mit
vergiftetem Zustand weiterzulaufen. Ack-basierte Schritte (theme,
rail, split, clear_recents, sync_render) muessen ok+acked vom
Frontend bestaetigt bekommen; tabs_close_all liefert beim leeren
Rest-Tab kein Ack (Backend-No-op von navigation:changed) und wird
nur auf ok + leeren Tab-Pfad geprueft. Theme, Find-Bar und Recents
werden zusaetzlich per DOM-/State-Poll verifiziert, weil der Ack nur
die Event-Verarbeitung bestaetigt, nicht den sichtbaren Endzustand.

Bewusst NICHT zurueckgesetzt: Pins (Szenarien raeumen ihre eigenen
Pins auf, Konvention siehe 17_workspace_pin) und Panel-State jenseits
des Split-Teilers (Minimap, Section-Expansion, Fenster-Geometrie —
kein Endpunkt vorhanden).
"""

from __future__ import annotations

import time
from typing import Any

from lib.api import AutomationApi


def _expect_ok(step: str, resp: Any) -> None:
    """Harter Fehler, wenn der Endpunkt nicht ok=true liefert."""
    if not isinstance(resp, dict) or resp.get("ok") is not True:
        raise RuntimeError(f"Reset-Schritt {step}: ok nicht true: {resp!r}")


def _expect_acked(step: str, resp: Any) -> None:
    """Harter Fehler, wenn ein Ack-basierter Reset-Schritt nicht vom
    Frontend bestaetigt wurde. Erwartet `{ok: true, acked: true, ...}` —
    gilt fuer theme/rail/split/clear_recents/sync_render. tabs_close_all
    ist absichtlich ausgenommen (siehe Aufrufstelle)."""
    _expect_ok(step, resp)
    if resp.get("acked") is not True:
        raise RuntimeError(f"Reset-Schritt {step}: ok/acked nicht true: {resp!r}")


def reset_canonical_state(api: AutomationApi, settings_snapshot: dict[str, Any]) -> None:
    # 1) Alle Tabs schliessen — hinterlaesst den einen leeren Tab.
    #    Backend: close_all setzt frontend_changed immer true und wartet
    #    auf navigation:changed-Ack; emit_navigation_changed no-opt aber
    #    beim leeren Rest-Tab → acked bleibt false (Timeout). Deshalb nur
    #    ok + leerer Tab-Pfad pruefen, und kurzer ackTimeoutMs, damit der
    #    Reset nicht pro Szenario ~3 s blockiert.
    resp = api.tabs_close_all(ack_timeout_ms=50)
    _expect_ok("tabs_close_all", resp)
    tab = resp.get("tab") or {}
    if tab.get("path") is not None:
        raise RuntimeError(
            f"Reset-Schritt tabs_close_all: Rest-Tab hat noch path={tab.get('path')!r}"
        )
    # 2) Settings auf den Run-Start-Snapshot zurueck (faengt generisch
    #    alle Settings-Mutationen, z. B. 32_open_target,
    #    23_api_settings_split). POST /settings akzeptiert das
    #    vollstaendige GET-Objekt als Patch; unveraenderte Felder
    #    loesen keine Side-Effects aus.
    api.settings_set(settings_snapshot)
    # 3) Theme ist NICHT Teil von settings.json (eigene Persistenz in
    #    theme.rs) und muss separat zurueck.
    _expect_acked("theme", api.theme("light"))
    # 3b) Angewandten Theme-Zustand verifizieren: die Dark-Klasse
    #    `theme-dark` sitzt am <html>-Element (main.ts), das View-Theme
    #    am data-view-theme-Attribut des <body> (view/theme.ts
    #    ::applyViewTheme — laeuft async ueber einen Tauri-Invoke,
    #    darum pollen statt Einmal-Read).
    expected_view_theme = settings_snapshot.get("viewTheme", "standard")
    deadline = time.monotonic() + 2.0
    while True:
        html_cls = (api.dom("html").get("attributes") or {}).get("class") or ""
        view_theme = (api.dom("body").get("attributes") or {}).get("data-view-theme")
        if "theme-dark" not in html_cls.split() and view_theme == expected_view_theme:
            break
        if time.monotonic() > deadline:
            raise RuntimeError(
                "Reset: Theme-Zustand nicht angewandt "
                f"(html class={html_cls!r}, data-view-theme={view_theme!r}, "
                f"erwartet viewTheme={expected_view_theme!r})"
            )
        time.sleep(0.05)
    # 4) Find-Bar schliessen und das Schliessen verifizieren — ohne
    #    Verifikation blieb ein haengender .open-Zustand (Leck aus
    #    06_find/12_menu_edit) je nach Timing bis in spaetere
    #    Screenshots stehen.
    api.find_close()
    deadline = time.monotonic() + 2.0
    while True:
        snap = api.dom("#find-bar")
        cls = (snap.get("attributes") or {}).get("class") or ""
        if "open" not in cls.split():
            break
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"Reset: #find-bar behaelt .open trotz find_close (class={cls!r})"
            )
        time.sleep(0.05)
    # 5) Mode best effort: bei leerem Tab darf das fehlschlagen/no-op
    #    sein. Die Konvention "jedes Szenario setzt seinen Mode
    #    explizit" bleibt in Kraft.
    try:
        api.mode("view")
    except Exception:
        pass
    # 6) Vault-Rail sichtbar (Default-Zustand). Die rechte Rail/TOC
    #    steuert CSS ueber kind-markdown — nicht anfassen.
    _expect_acked("rail", api.rail("left", True))
    # 7) Split-Teiler auf Default.
    _expect_acked("split", api.split(50))
    # 8) Recent-Liste leeren (sonst waechst die Rail-Sektion "Zuletzt
    #    geoeffnet" ueber den Lauf in spaetere Baselines hinein).
    _expect_acked("workspace_clear_recents", api.workspace_clear_recents())
    # 9) Vault-Tree-Filter auf Defaults (Query leer, Zeile zu, md-only aus).
    #    Hook leert Input, schließt Zeile, persistiert Options (R3).
    api.eval(
        "typeof window.__folioVaultFilterReset==='function'"
        "&&window.__folioVaultFilterReset()"
    )
    deadline = time.monotonic() + 2.0
    while True:
        ev = api.eval(
            "({h:!!document.getElementById('vault-filter')?.hidden,"
            "q:(document.getElementById('vault-filter-input')?.value||'')})"
        ).get("value") or {}
        if bool(ev.get("h")) and ev.get("q") == "":
            break
        if time.monotonic() > deadline:
            raise RuntimeError(
                "Reset: Vault-Filter nicht geräumt "
                f"(filterHidden={ev.get('h')!r}, query={ev.get('q')!r})"
            )
        time.sleep(0.05)
    # 9b) Command Palette schließen (falls offen) — Hook, Verifikations-Poll.
    api.eval(
        "typeof window.__folioClosePalette==='function'"
        "&&window.__folioClosePalette()"
    )
    # 9c) Zen-Layer verlassen (Frontend-State, nicht persistiert).
    api.eval(
        "typeof window.__folioZenReset==='function'"
        "&&window.__folioZenReset()"
    )
    deadline = time.monotonic() + 2.0
    while True:
        open_flag = api.eval(
            "!!(document.body.classList.contains('palette-open')"
            "||!document.getElementById('cmd-palette')?.hidden)"
        ).get("value")
        if open_flag is not True:
            break
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"Reset: Command Palette bleibt offen (open={open_flag!r})"
            )
        time.sleep(0.05)
    deadline = time.monotonic() + 2.0
    while True:
        zen_on = api.eval("document.body.classList.contains('zen-mode')").get("value")
        if zen_on is not True:
            break
        if time.monotonic() > deadline:
            raise RuntimeError(f"Reset: Zen-Layer bleibt an (zen={zen_on!r})")
        time.sleep(0.05)
    # 10) Reflow settlen lassen, bevor das Szenario startet.
    _expect_acked("sync_render", api.sync_render())
    # 10b) Recents-Verifikation: ein in-flight workspace_add_recent des
    #    Vorszenarios (Frontend feuert es asynchron nach
    #    document:loaded) kann NACH dem Leeren einschlagen — einmal
    #    erneut leeren + Re-Check mit kurzer Deadline, dann harter
    #    Fehler.
    recent = (api.state().get("workspace") or {}).get("recent") or []
    if recent:
        _expect_acked("workspace_clear_recents (Retry)", api.workspace_clear_recents())
        _expect_acked("sync_render (Retry)", api.sync_render())
        deadline = time.monotonic() + 1.0
        while recent and time.monotonic() < deadline:
            time.sleep(0.05)
            recent = (api.state().get("workspace") or {}).get("recent") or []
        if recent:
            raise RuntimeError(f"Reset: workspace.recent nicht leer: {recent!r}")
