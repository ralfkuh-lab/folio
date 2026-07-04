"""Funktionaler Test fuer die Tabs im Settings-Dialog."""

import time


def _attributes(ctx, selector: str) -> dict:
    return ctx.api.dom(selector).get("attributes") or {}


def _is_hidden(ctx, selector: str) -> bool:
    snap = ctx.api.dom(selector)
    return not snap.get("exists") or "hidden" in (snap.get("attributes") or {})


def _poll(ctx, predicate, timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def run(ctx):
    try:
        with ctx.step("/menu/click edit.settings oeffnet den Settings-Dialog"):
            ctx.expect(
                _is_hidden(ctx, "#settings-dialog"),
                "settings-dialog war vor dem Test bereits sichtbar",
            )
            ctx.api.menu_click("edit.settings")
            ctx.expect(
                _poll(ctx, lambda: not _is_hidden(ctx, "#settings-dialog")),
                "settings-dialog wurde nach edit.settings nicht sichtbar",
            )

        with ctx.step("Allgemein ist aktiv und Diagnose versteckt"):
            allgemein = _attributes(ctx, "#settings-tab-allgemein")
            diagnose_panel = ctx.api.dom('[data-settings-tab="diagnose"]')
            log_level = ctx.api.dom("#settings-log-level")
            ctx.expect(
                allgemein.get("aria-selected") == "true",
                f"Allgemein aria-selected={allgemein.get('aria-selected')!r}",
            )
            ctx.expect(log_level.get("exists"), "settings-log-level fehlt im DOM")
            ctx.expect(
                "hidden" in (diagnose_panel.get("attributes") or {}),
                "Diagnose-Panel mit Log-Level ist initial nicht hidden",
            )

        with ctx.step("Klick auf Diagnose zeigt das Diagnose-Panel"):
            ctx.api.click("settings-tab-diagnose")
            diagnose_active = _poll(
                ctx,
                lambda: _attributes(ctx, "#settings-tab-diagnose").get(
                    "aria-selected"
                )
                == "true",
            )
            diagnose_panel = ctx.api.dom('[data-settings-tab="diagnose"]')
            allgemein_panel = ctx.api.dom('[data-settings-tab="allgemein"]')
            ctx.expect(diagnose_active, "Diagnose-Tab wurde nicht aktiv")
            ctx.expect(
                "hidden" not in (diagnose_panel.get("attributes") or {}),
                "Diagnose-Panel blieb nach Tab-Klick hidden",
            )
            ctx.expect(
                "hidden" in (allgemein_panel.get("attributes") or {}),
                "Allgemein-Panel wurde nach Tab-Klick nicht hidden",
            )

        with ctx.step("Escape schliesst den Dialog"):
            ctx.api.key("Escape")
            ctx.expect(
                _poll(ctx, lambda: _is_hidden(ctx, "#settings-dialog")),
                "settings-dialog wurde durch Escape nicht geschlossen",
            )
    finally:
        if not _is_hidden(ctx, "#settings-dialog"):
            ctx.api.key("Escape")
