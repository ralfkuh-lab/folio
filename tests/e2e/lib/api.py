"""Thin client over the Folio Automation API (default http://127.0.0.1:9876).

Uses only the standard library (urllib + json) — no third-party deps.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Optional


class ApiError(RuntimeError):
    def __init__(self, status: int, body: str, message: str = ""):
        self.status = status
        self.body = body
        super().__init__(message or f"HTTP {status}: {body[:200]}")


class AutomationApi:
    """Synchronous wrapper around the Folio Automation HTTP API."""

    def __init__(self, base_url: str = "http://127.0.0.1:9876", request_timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = request_timeout

    # ----- low-level -------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict] = None,
        timeout: Optional[float] = None,
        accept_bytes: bool = False,
    ) -> Any:
        url = f"{self.base_url}{path}"
        data = None
        headers = {"Accept": "application/json" if not accept_bytes else "*/*"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url=url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                payload = json.loads(raw.decode("utf-8"))
                msg = payload.get("error", raw.decode("utf-8", "replace"))
            except Exception:
                msg = raw.decode("utf-8", "replace")
            raise ApiError(e.code, msg)
        if accept_bytes:
            return raw
        text = raw.decode("utf-8")
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            raise ApiError(status, text, f"non-JSON response from {path}")

    # ----- high-level endpoints --------------------------------------

    def state(self) -> dict:
        return self._request("GET", "/state")

    def screenshot(self) -> bytes:
        return self._request("GET", "/screenshot", accept_bytes=True, timeout=30.0)

    def dom(self, selector: str, timeout_ms: int = 1000) -> dict:
        # /dom is GET with selector as query param
        from urllib.parse import urlencode

        qs = urlencode({"selector": selector, "timeoutMs": timeout_ms})
        return self._request("GET", f"/dom?{qs}")

    def console_errors(self, clear: bool = False) -> dict:
        from urllib.parse import urlencode

        qs = urlencode({"clear": "true" if clear else "false"})
        return self._request("GET", f"/console/errors?{qs}")

    def open(self, path: str, anchor: Optional[str] = None) -> dict:
        body: dict = {"path": path}
        if anchor:
            body["anchor"] = anchor
        return self._request("POST", "/open", body)

    def mode(self, mode: str, ack_timeout_ms: int = 2000) -> dict:
        # /mode supports ?ackTimeoutMs= query
        return self._request(
            "POST", f"/mode?ackTimeoutMs={ack_timeout_ms}", {"mode": mode}
        )

    def theme(self, mode: str) -> dict:
        return self._request("POST", "/theme", {"mode": mode})

    def rail(self, side: str, visible: bool) -> dict:
        return self._request("POST", "/rail", {"side": side, "visible": visible})

    def click(self, name: str, ack_timeout_ms: int = 1000) -> dict:
        return self._request(
            "POST", f"/click?ackTimeoutMs={ack_timeout_ms}", {"name": name}
        )

    def right_click(self, name: str, coords: Optional[dict] = None) -> dict:
        body: dict = {"name": name}
        if coords:
            body["coords"] = coords
        return self._request("POST", "/rightclick", body)

    def key(self, key: str, modifiers: Optional[dict] = None, target: str = "document",
            ack_timeout_ms: int = 1000) -> dict:
        body: dict = {"key": key, "target": target}
        if modifiers:
            body["modifiers"] = modifiers
        return self._request(
            "POST", f"/key?ackTimeoutMs={ack_timeout_ms}", body
        )

    def toc_activate(self, slug: str) -> dict:
        return self._request("POST", "/toc/activate", {"slug": slug})

    def focus(self, target: str) -> dict:
        return self._request("POST", "/focus", {"target": target})

    def find_open(self) -> dict:
        # `/find` nimmt keinen Payload — emittet `editor:open_find`.
        return self._request("POST", "/find", {})

    def find_text(self, term: str) -> dict:
        return self._request("POST", "/find/text", {"term": term})

    def find_close(self) -> dict:
        # Es gibt keinen dedizierten Close-Endpunkt; Escape an die Find-Bar.
        return self.key("Escape", target="document")

    def editor_text_get(self) -> dict:
        return self._request("GET", "/editor/text")

    def editor_text_set(self, text: str) -> dict:
        return self._request("POST", "/editor/text", {"text": text})

    def editor_selection(self, start: int, length: int) -> dict:
        return self._request(
            "POST", "/editor/selection", {"start": start, "length": length}
        )

    def resize(self, width: int, height: int) -> dict:
        return self._request("POST", "/resize", {"width": width, "height": height})

    def save(self) -> dict:
        return self._request("POST", "/save", {})

    def menu_click(self, menu_id: str) -> dict:
        # Synthetischer Menue-Klick: gleicher Routing-Pfad wie ein nativer
        # Klick, ohne OS-Eingabe. Tests warten danach ueber /wait oder
        # /state-Polling auf das Resultat (kein Ack-Mechanismus, weil
        # die Frontend-`menu:*`-Handler keinen requestId durchreichen).
        return self._request("POST", "/menu/click", {"id": menu_id})

    def editor_command(self, command: str, args: Any = None,
                       ack_timeout_ms: int = 1000) -> dict:
        # Ruft eine Methode am window.FolioEditor-Surface auf
        # (undo, redo, setSelection, ...). Args werden als einzelnes
        # Argument durchgereicht.
        body: dict = {"command": command}
        if args is not None:
            body["args"] = args
        return self._request(
            "POST", f"/editor/command?ackTimeoutMs={ack_timeout_ms}", body
        )

    def workspace_pin(self, path: str, is_directory: bool = False) -> dict:
        return self._request(
            "POST", "/workspace/pin",
            {"path": path, "isDirectory": is_directory},
        )

    def workspace_unpin(self, path: str) -> dict:
        return self._request("POST", "/workspace/unpin", {"path": path})

    def history_back(self) -> dict:
        return self._request("POST", "/history/back", {})

    def history_forward(self) -> dict:
        return self._request("POST", "/history/forward", {})

    def wait(self, event: str, timeout_ms: int = 5000) -> dict:
        # /wait blocks server-side; bump client timeout to event timeout + slack.
        return self._request(
            "POST",
            "/wait",
            {"event": event, "timeoutMs": timeout_ms},
            timeout=(timeout_ms / 1000.0) + 5.0,
        )

    def quit(self) -> None:
        try:
            self._request("POST", "/quit", {})
        except (ApiError, urllib.error.URLError, ConnectionError):
            # /quit terminates the process — the response may not make it
            # back. Treat all transport errors as success here.
            pass

    # ----- convenience -----------------------------------------------

    def is_alive(self) -> bool:
        try:
            self.state()
            return True
        except Exception:
            return False

    def wait_for_alive(self, timeout: float = 30.0, poll_interval: float = 0.5) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.is_alive():
                return True
            time.sleep(poll_interval)
        return False
