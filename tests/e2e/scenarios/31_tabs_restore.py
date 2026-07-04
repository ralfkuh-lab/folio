"""Funktionaler Test der Tab-Session-Persistenz in workspace.json."""

import json
import time
from pathlib import Path


def _normalized(path: str) -> str:
    return path.replace("\\", "/")


def _workspace_path(ctx) -> Path:
    response = ctx.api.eval("window.__folioInvoke('themes_dir_path')")
    ctx.expect(response.get("ok") is True, f"themes_dir_path schlug fehl: {response!r}")
    themes_dir = response.get("value")
    ctx.expect(
        isinstance(themes_dir, str) and bool(themes_dir),
        f"ungueltiger Theme-Pfad: {themes_dir!r}",
    )
    return Path(themes_dir).parent / "workspace.json"


def _poll_workspace(path: Path, predicate, timeout_s: float = 3.0) -> dict:
    deadline = time.monotonic() + timeout_s
    data = {}
    while time.monotonic() < deadline:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(0.05)
            continue
        if predicate(data):
            return data
        time.sleep(0.05)
    return data


def run(ctx):
    file_a = _normalized(ctx.fixture("sample.md"))
    file_b = _normalized(ctx.fixture("notes", "deep.md"))
    workspace_path = _workspace_path(ctx)

    try:
        with ctx.step("zwei offene Tabs werden mit aktivem Index persistiert"):
            ctx.api.tabs_close_all()
            ctx.api.open(file_a, discard=True)
            ctx.api.tab_open(file_b)
            tabs = ctx.api.tabs().get("tabs") or []
            tab_a = next(tab for tab in tabs if tab.get("path") == file_a)
            tab_b = next(tab for tab in tabs if tab.get("path") == file_b)

            workspace = _poll_workspace(
                workspace_path,
                lambda data: data.get("open_tabs") == [file_a, file_b]
                and data.get("active_tab") == 1,
            )
            ctx.expect(
                workspace.get("open_tabs") == [file_a, file_b],
                f"open_tabs nicht persistiert: {workspace!r}",
            )
            ctx.expect(
                workspace.get("active_tab") == 1,
                f"aktiver Index nicht persistiert: {workspace!r}",
            )

        with ctx.step("Aktivieren aktualisiert active_tab"):
            ctx.api.tab_activate(tab_a["id"])
            workspace = _poll_workspace(
                workspace_path,
                lambda data: data.get("active_tab") == 0,
            )
            ctx.expect(
                workspace.get("active_tab") == 0,
                f"active_tab blieb unveraendert: {workspace!r}",
            )

        with ctx.step("Schliessen entfernt den Tab-Pfad"):
            ctx.api.tab_close(tab_b["id"])
            workspace = _poll_workspace(
                workspace_path,
                lambda data: data.get("open_tabs") == [file_a]
                and data.get("active_tab") == 0,
            )
            ctx.expect(
                workspace.get("open_tabs") == [file_a],
                f"geschlossener Tab blieb persistiert: {workspace!r}",
            )
    finally:
        ctx.api.tabs_close_all()
