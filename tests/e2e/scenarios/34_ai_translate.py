"""Dokumentübersetzung über einen lokalen OpenAI-kompatiblen Mock-Provider."""

import json
import re
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROVIDER_ID = "e2e-translate-provider"
MODEL_ID = "mock-translate"
LANGUAGE = "fr"
SOURCE = """---
title: Geschützter Titel
slug: ai-mask-test
---

# Originalüberschrift

Deutscher Absatz mit `secret_call("ä")`.

```python
def hello(name: str) -> str:
    return f"Hallo, {name}!"
```
"""
TRANSLATED = SOURCE.replace(
    "# Originalüberschrift", "# MOCK-ÜBERSETZUNG (fr)"
).replace(
    "Deutscher Absatz mit", "Paragraphe français avec"
)
PROTECTED_FRAGMENTS = (
    "---\ntitle: Geschützter Titel\nslug: ai-mask-test\n---",
    '`secret_call("ä")`',
    '```python\ndef hello(name: str) -> str:\n    return f"Hallo, {name}!"\n```',
)
TOKEN_RE = re.compile(r"⟦F(?P<nonce>\d+):(?P<index>\d+)⟧")


def _validate_masked_user(content: str):
    for fragment in PROTECTED_FRAGMENTS:
        if fragment in content:
            raise ValueError(f"geschütztes Fragment kam im Klartext an: {fragment!r}")

    matches = list(TOKEN_RE.finditer(content))
    if len(matches) != len(PROTECTED_FRAGMENTS):
        raise ValueError(
            f"{len(matches)} Platzhalter empfangen, "
            f"{len(PROTECTED_FRAGMENTS)} erwartet: {content!r}"
        )
    nonces = {match.group("nonce") for match in matches}
    indices = [int(match.group("index")) for match in matches]
    if len(nonces) != 1 or indices != list(range(len(PROTECTED_FRAGMENTS))):
        raise ValueError(f"unerwartete Platzhalter: {[match.group(0) for match in matches]!r}")

    placeholders = [match.group(0) for match in matches]
    expected = SOURCE
    for fragment, placeholder in zip(PROTECTED_FRAGMENTS, placeholders):
        expected = expected.replace(fragment, placeholder)
    if content != expected:
        raise ValueError(f"maskierter User-Content weicht ab: {content!r}")


class _MockHandler(BaseHTTPRequestHandler):
    received_user = None
    received_stream = None
    validation_error = None

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        type(self).received_stream = payload.get("stream")
        if payload.get("stream") is not True:
            type(self).validation_error = "Request enthielt nicht stream: true"
        system = next(
            (
                message.get("content", "")
                for message in payload.get("messages", [])
                if message.get("role") == "system"
            ),
            "",
        )
        user = next(
            (
                message.get("content", "")
                for message in payload.get("messages", [])
                if message.get("role") == "user"
            ),
            "",
        )
        type(self).received_user = user
        try:
            if type(self).validation_error:
                raise ValueError(type(self).validation_error)
            _validate_masked_user(user)
        except ValueError as error:
            type(self).validation_error = str(error)
            body = json.dumps(
                {"error": {"message": str(error)}}, ensure_ascii=False
            ).encode("utf-8")
            self.send_response(422)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        match = re.search(r"target language\s+([^\s(]+)", system, re.IGNORECASE)
        language = match.group(1) if match else "unknown"
        content = user.replace(
            "# Originalüberschrift", f"# MOCK-ÜBERSETZUNG ({language})"
        ).replace(
            "Deutscher Absatz mit", "Paragraphe français avec"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        token = TOKEN_RE.search(content)
        cuts = [max(1, (token.start() if token else 4) - 2)]
        if token:
            cuts.extend([token.start() + 3, token.end() - 1])
        cuts.extend([max(1, len(content) // 2), len(content)])
        start = 0
        for end in sorted(set(cut for cut in cuts if start < cut <= len(content))):
            delta = content[start:end]
            event = (
                "data: "
                + json.dumps(
                    {"choices": [{"delta": {"content": delta}}]},
                    ensure_ascii=False,
                )
                + "\r\n\r\n"
            ).encode("utf-8")
            midpoint = max(1, len(event) // 2)
            self.wfile.write(event[:midpoint])
            self.wfile.flush()
            self.wfile.write(event[midpoint:])
            self.wfile.flush()
            start = end
        self.wfile.write(b"data: [DONE]\r\n\r\n")
        self.wfile.flush()

    def log_message(self, _format, *_args):
        return


def _poll(predicate, timeout_s: float = 10.0):
    deadline = time.monotonic() + timeout_s
    value = None
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return value


def _eval(ctx, js: str):
    response = ctx.api.eval(js, timeout_ms=10_000)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


def _configure_provider(ctx, base_url: str):
    script = f"""(async () => {{
        await window.__folioInvoke("ai_custom_upsert", {{
            definition: {{
                id: {PROVIDER_ID!r},
                name: "E2E Translate Mock",
                baseURL: {base_url!r}
            }}
        }});
        await window.__folioInvoke("ai_model_toggle", {{
            providerId: {PROVIDER_ID!r},
            modelId: {MODEL_ID!r},
            on: true
        }});
        await window.__folioInvoke("ai_default_model_set", {{
            providerId: {PROVIDER_ID!r},
            modelId: {MODEL_ID!r}
        }});
        return true;
    }})()"""
    return _eval(ctx, script)


def _cleanup_provider(ctx):
    try:
        _eval(
            ctx,
            f"""Promise.allSettled([
                window.__folioInvoke("ai_auth_remove", {{
                    providerId: {PROVIDER_ID!r}
                }}),
                window.__folioInvoke("ai_custom_delete", {{
                    id: {PROVIDER_ID!r}
                }})
            ])""",
        )
    except Exception:
        pass


def _translation_files(source: Path):
    pattern = re.compile(rf"^{re.escape(source.stem)}\.{LANGUAGE}(?:-\d+)?\.md$")
    return [path for path in source.parent.iterdir() if pattern.match(path.name)]


def run(ctx):
    _MockHandler.received_user = None
    _MockHandler.received_stream = None
    _MockHandler.validation_error = None
    server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-ai-translate-"))
    source = tmp / "translate-mask.md"
    source.write_text(SOURCE, encoding="utf-8")
    generated = source.with_name(f"{source.stem}.{LANGUAGE}.md")

    try:
        for path in _translation_files(source):
            path.unlink(missing_ok=True)
        _cleanup_provider(ctx)

        with ctx.step("lokalen Mock-Provider konfigurieren"):
            base_url = f"http://127.0.0.1:{server.server_port}/v1"
            ctx.expect(_configure_provider(ctx, base_url) is True, "Provider-Setup fehlgeschlagen")

        with ctx.step("Markdown öffnen und Übersetzungsdialog per Menü routen"):
            ctx.api.tabs_close_all()
            ctx.api.open(str(source), discard=True)
            ctx.api.mode("view")
            ctx.api.menu_click("edit.ai_translate")
            visible = _poll(
                lambda: (
                    (snapshot := ctx.api.dom("#ai-translate-dialog")).get("exists")
                    and "hidden" not in (snapshot.get("attributes") or {})
                )
            )
            ctx.expect(bool(visible), "Übersetzungsdialog wurde nicht sichtbar")

        with ctx.step("eine Zielsprache wählen und Übersetzung starten"):
            selected_model = _eval(
                ctx,
                f"""(() => {{
                    document.getElementById("ai-translate-lang-{LANGUAGE}").checked = true;
                    return document.getElementById("ai-translate-model").value;
                }})()""",
            )
            ctx.expect(bool(selected_model), "Mock-Modell fehlt im Übersetzungsdialog")
            ctx.api.click("ai-translate-start")
            active = _poll(
                lambda: next(
                    (
                        tab
                        for tab in (ctx.api.tabs().get("tabs") or [])
                        if tab.get("active")
                        and (tab.get("path") or "").replace("\\", "/")
                        == str(generated).replace("\\", "/")
                    ),
                    None,
                ),
                timeout_s=15.0,
            )
            ctx.expect(bool(active), f"Erzeugter Tab wurde nicht aktiv: {ctx.api.tabs()!r}")
            completed = _poll(
                lambda: generated.is_file()
                and generated.read_text(encoding="utf-8") == TRANSLATED,
                timeout_s=15.0,
            )
            ctx.expect(bool(completed), f"Übersetzungsdatei fehlt oder ist unvollständig: {generated}")
            ctx.expect(
                _MockHandler.validation_error is None,
                f"Mock-Payload-Prüfung fehlgeschlagen: {_MockHandler.validation_error}",
            )
            ctx.expect(
                _MockHandler.received_stream is True,
                "Mock-Request enthielt nicht stream: true",
            )
            ctx.expect(bool(_MockHandler.received_user), "Mock erhielt keinen User-Content")
            ctx.expect(
                generated.read_text(encoding="utf-8") == TRANSLATED,
                "Demaskierter Mock-Inhalt weicht ab; geschützte Bytes wurden verändert",
            )
    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        _cleanup_provider(ctx)
        shutil.rmtree(tmp, ignore_errors=True)
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)
