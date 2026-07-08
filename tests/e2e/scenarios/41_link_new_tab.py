"""Ctrl-Klick auf interne Markdown-Links oeffnet das Ziel in neuem Tab."""

import shutil
import tempfile
import time
from pathlib import Path


def _norm(path: str) -> str:
    return path.replace("\\", "/")


def _tab_for_path(tabs: list[dict], path: Path) -> dict:
    normalized = _norm(str(path))
    return next((tab for tab in tabs if tab.get("path") == normalized), {})


def _wait_for_markdown_link(ctx, timeout_s: float = 4.0) -> bool:
    deadline = time.monotonic() + timeout_s
    # /eval erwartet eine EXPRESSION (Frontend: new Function('return (' + js + ')')).
    script = "!!document.querySelector('.markdown-body a[href$=\".md\"]')"
    while time.monotonic() < deadline:
        result = ctx.api.eval(script, timeout_ms=1000)
        if result.get("ok") and result.get("value") is True:
            return True
        time.sleep(0.05)
    return False


def _wait_for_anchor_link(ctx, timeout_s: float = 4.0) -> bool:
    deadline = time.monotonic() + timeout_s
    script = "!!document.querySelector('.markdown-body a[href^=\"#\"]')"
    while time.monotonic() < deadline:
        result = ctx.api.eval(script, timeout_ms=1000)
        if result.get("ok") and result.get("value") is True:
            return True
        time.sleep(0.05)
    return False


def _wait_tabs(ctx, expected_count: int, active_path: Path, timeout_s: float = 4.0) -> list[dict]:
    deadline = time.monotonic() + timeout_s
    tabs: list[dict] = []
    expected_active = _norm(str(active_path))
    while time.monotonic() < deadline:
        tabs = ctx.api.tabs().get("tabs") or []
        if (
            len(tabs) == expected_count
            and any(tab.get("active") is True and tab.get("path") == expected_active for tab in tabs)
        ):
            return tabs
        time.sleep(0.05)
    return tabs


def run(ctx):
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-link-new-tab-"))
    source = tmp / "source.md"
    target = tmp / "target.md"
    source.write_text(
        "# Source\n\n[Open target](target.md)\n\n[Jump to source](#source)\n",
        encoding="utf-8",
    )
    target.write_text("# Target\n\nBack to [source](source.md).\n", encoding="utf-8")

    try:
        with ctx.step("Markdown-Fixture im View-Mode oeffnen"):
            ctx.api.tabs_close_all()
            ctx.api.open(str(source), discard=True)
            ctx.api.mode("view")
            ctx.expect(_wait_for_markdown_link(ctx), "Markdown-Link wurde nicht gerendert")
            before = ctx.api.tabs().get("tabs") or []
            source_tab = _tab_for_path(before, source)
            ctx.expect(bool(source_tab), f"Source-Tab fehlt vor Klick: {before!r}")

        with ctx.step("Ctrl-Klick auf relativen Markdown-Link oeffnet Ziel-Tab"):
            result = ctx.api.eval(
                """
                (() => {
                    const link = document.querySelector('.markdown-body a[href$=".md"]');
                    if (!link) return { clicked: false };
                    const event = new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        ctrlKey: true,
                    });
                    const defaultAllowed = link.dispatchEvent(event);
                    return {
                        clicked: true,
                        defaultAllowed,
                        href: link.getAttribute('href'),
                    };
                })()
                """,
                timeout_ms=1000,
            )
            ctx.expect(result.get("ok") is True, f"eval fehlgeschlagen: {result!r}")
            value = result.get("value") or {}
            ctx.expect(value.get("clicked") is True, f"kein Link geklickt: {result!r}")
            ctx.expect(value.get("defaultAllowed") is False, f"Default nicht verhindert: {result!r}")

            tabs = _wait_tabs(ctx, 2, target)
            target_tab = _tab_for_path(tabs, target)
            source_after = _tab_for_path(tabs, source)
            ctx.expect(bool(target_tab), f"Target-Tab fehlt: {tabs!r}")
            ctx.expect(target_tab.get("active") is True, f"Target-Tab nicht aktiv: {tabs!r}")
            ctx.expect(
                source_after.get("id") == source_tab.get("id")
                and source_after.get("active") is False,
                f"Ausgangstab wurde nicht erhalten: before={source_tab!r}, after={tabs!r}",
            )

        with ctx.step("Normaler Klick auf bereits offenen Link aktiviert Ziel-Tab"):
            ctx.api.tab_activate(source_tab["id"])
            tabs = _wait_tabs(ctx, 2, source)
            ctx.expect(_wait_for_markdown_link(ctx), "Markdown-Link wurde nicht gerendert")
            result = ctx.api.eval(
                """
                (() => {
                    const link = document.querySelector('.markdown-body a[href$=".md"]');
                    if (!link) return { clicked: false };
                    const event = new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                    });
                    const defaultAllowed = link.dispatchEvent(event);
                    return {
                        clicked: true,
                        defaultAllowed,
                        href: link.getAttribute('href'),
                    };
                })()
                """,
                timeout_ms=1000,
            )
            ctx.expect(result.get("ok") is True, f"eval fehlgeschlagen: {result!r}")
            value = result.get("value") or {}
            ctx.expect(value.get("clicked") is True, f"kein Link geklickt: {result!r}")
            ctx.expect(value.get("defaultAllowed") is False, f"Default nicht verhindert: {result!r}")

            tabs = _wait_tabs(ctx, 2, target)
            target_after = _tab_for_path(tabs, target)
            source_after = _tab_for_path(tabs, source)
            ctx.expect(
                target_after.get("id") == target_tab.get("id")
                and target_after.get("active") is True,
                f"Bestehender Target-Tab wurde nicht aktiviert: before={target_tab!r}, after={tabs!r}",
            )
            ctx.expect(
                source_after.get("id") == source_tab.get("id")
                and source_after.get("path") == _norm(str(source)),
                f"Source-Tab wurde ersetzt: before={source_tab!r}, after={tabs!r}",
            )

        with ctx.step("Anker-Link im aktiven Dokument bleibt im aktiven Tab"):
            ctx.api.tab_activate(source_tab["id"])
            tabs = _wait_tabs(ctx, 2, source)
            ctx.expect(_wait_for_anchor_link(ctx), "Anker-Link wurde nicht gerendert")
            result = ctx.api.eval(
                """
                (() => {
                    const link = document.querySelector('.markdown-body a[href^="#"]');
                    if (!link) return { clicked: false };
                    const event = new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                    });
                    const defaultAllowed = link.dispatchEvent(event);
                    return {
                        clicked: true,
                        defaultAllowed,
                        href: link.getAttribute('href'),
                    };
                })()
                """,
                timeout_ms=1000,
            )
            ctx.expect(result.get("ok") is True, f"eval fehlgeschlagen: {result!r}")
            value = result.get("value") or {}
            ctx.expect(value.get("clicked") is True, f"kein Link geklickt: {result!r}")
            ctx.expect(value.get("defaultAllowed") is False, f"Default nicht verhindert: {result!r}")

            tabs = _wait_tabs(ctx, 2, source)
            source_after = _tab_for_path(tabs, source)
            ctx.expect(
                source_after.get("id") == source_tab.get("id")
                and source_after.get("active") is True,
                f"Anker-Link hat den aktiven Tab gewechselt: before={source_tab!r}, after={tabs!r}",
            )
    finally:
        try:
            ctx.api.tabs_close_all()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
