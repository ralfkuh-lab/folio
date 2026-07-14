"""Kurzer englischer Prozess-Smoke ueber die Folio-Automation-API."""

from __future__ import annotations

import sys
import time
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.api import AutomationApi  # noqa: E402


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"[lang-smoke] PASS {message}")


def wait_for_frontend(api: AutomationApi, timeout_s: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout_s
    last_state: dict = {}
    while time.monotonic() < deadline:
        last_state = api.state()
        if last_state.get("frontendReady") is True:
            return last_state
        time.sleep(0.25)
    raise AssertionError(f"frontendReady blieb false: {last_state!r}")


def dom_text(api: AutomationApi, selector: str) -> str:
    snapshot = api.dom(selector)
    check(snapshot.get("exists") is True, f"DOM {selector} vorhanden")
    return snapshot.get("textContent") or ""


def main() -> int:
    api = AutomationApi()
    try:
        state = wait_for_frontend(api)
        check(state.get("frontendReady") is True, "/state frontendReady=true")
        check(state.get("lang") == "en", '/state lang="en"')

        save = api.dom("#tb-save")
        check(save.get("exists") is True, "Toolbar-Speichern vorhanden")
        check(
            (save.get("attributes") or {}).get("title") == "Save (Ctrl+S)",
            'Toolbar-Tooltip ist "Save (Ctrl+S)"',
        )
        check(
            dom_text(api, '[data-i18n="vault.header.title"]') == "Workspace",
            'Vault-Titel ist "Workspace"',
        )
        check(
            dom_text(api, '[data-i18n="view.toc.title"]') == "Table of Contents",
            'TOC-Titel ist "Table of Contents"',
        )
        check(
            dom_text(api, "#status-path") == "Ready",
            'Statusleiste ist englisch ("Ready")',
        )

        console = api.console_errors()
        check(
            console.get("count") == 0 and console.get("errors") == [],
            "GET /console/errors ist leer",
        )
    except Exception as error:
        print(f"[lang-smoke] FAIL {error}", file=sys.stderr)
        return 1
    print("[lang-smoke] OK englischer Prozess-Smoke bestanden")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
