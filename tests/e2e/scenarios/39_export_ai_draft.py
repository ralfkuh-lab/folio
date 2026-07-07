"""Per-Export-KI-Draft mit lokalem OpenAI-kompatiblem Mock-Provider."""

import json
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROVIDER_ID = "e2e-export-ai-provider"
MODEL_ID = "mock-export-ai"
CSS_MARKER = "#3a6ea5"
SOURCE = """---
title: Marktanalyse 2026
author: Folio E2E
---

# Marktanalyse

Ein kurzer Bericht mit Tabellen und Code.

## Zahlen

| A | B |
| - | - |
| 1 | 2 |
"""


class _MockHandler(BaseHTTPRequestHandler):
    received_system = None
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
        type(self).received_system = system
        type(self).received_user = user
        if "Dokument-Kontext" not in system or "## Zahlen" not in system:
            type(self).validation_error = "Dokument-Kontext fehlt im System-Prompt"

        theme_json = json.dumps(
            {
                "manifest": {
                    "name": "E2E Export AI Draft",
                    "description": "Transient",
                    "code": "light",
                    "cover": False,
                    "header": False,
                    "footer": False,
                    "hideInlineFrontmatter": False,
                    "formatVersion": 1,
                },
                "contentCss": f".markdown-body {{ color: {CSS_MARKER}; }}",
            },
            ensure_ascii=False,
        )

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for i in range(0, len(theme_json), 24):
            event = (
                "data: "
                + json.dumps(
                    {"choices": [{"delta": {"content": theme_json[i:i + 24]}}]},
                    ensure_ascii=False,
                )
                + "\r\n\r\n"
            ).encode("utf-8")
            self.wfile.write(event)
            self.wfile.flush()
            time.sleep(0.005)
        self.wfile.write(b"data: [DONE]\r\n\r\n")
        self.wfile.flush()

    def log_message(self, _format, *_args):
        return


def _eval(ctx, js: str):
    response = ctx.api.eval(js, timeout_ms=10_000)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


def _configure_provider(ctx, base_url: str):
    return _eval(
        ctx,
        f"""(async () => {{
            await window.__folioInvoke("ai_custom_upsert", {{
                definition: {{
                    id: {PROVIDER_ID!r},
                    name: "E2E Export AI Mock",
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
        }})()""",
    )


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


def run(ctx):
    _MockHandler.received_system = None
    _MockHandler.received_user = None
    _MockHandler.received_stream = None
    _MockHandler.validation_error = None
    server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-export-ai-"))
    source = tmp / "market.md"
    target = tmp / "market-ai.html"
    source.write_text(SOURCE, encoding="utf-8")

    try:
        _cleanup_provider(ctx)

        with ctx.step("lokalen Mock-Provider konfigurieren"):
            base_url = f"http://127.0.0.1:{server.server_port}/v1"
            ctx.expect(_configure_provider(ctx, base_url) is True, "Provider-Setup fehlgeschlagen")

        with ctx.step("Markdown öffnen und View-Mode setzen"):
            ctx.api.tabs_close_all()
            ctx.api.open(str(source), discard=True)
            ctx.api.mode("view")

        with ctx.step("KI-Draft mit Dokumentkontext erzeugen"):
            draft = _eval(
                ctx,
                f"""window.__folioInvoke("ai_theme_author", {{
                    prompt: "Erzeuge ein klares Analysten-Layout",
                    baseId: null,
                    withDocument: true,
                    providerId: {PROVIDER_ID!r},
                    modelId: {MODEL_ID!r}
                }})""",
            )
            ctx.expect(_MockHandler.received_stream is True, "Mock-Request enthielt nicht stream: true")
            ctx.expect(_MockHandler.validation_error is None, _MockHandler.validation_error or "")
            ctx.expect("Marktanalyse" in (_MockHandler.received_system or ""), "Dokument fehlt im Prompt")
            ctx.expect("Erzeuge ein klares" in (_MockHandler.received_user or ""), "User-Prompt fehlt")

        with ctx.step("Draft direkt als HTML exportieren"):
            _eval(
                ctx,
                """window.__folioInvoke("export_html_draft", %s)"""
                % json.dumps(
                    {
                        "parts": draft,
                        "baseThemeId": None,
                        "targetPath": str(target),
                    },
                    ensure_ascii=False,
                ),
            )
            html = target.read_text(encoding="utf-8")
            ctx.expect(CSS_MARKER in html, "Draft-CSS fehlt im Export")
            ctx.expect("Marktanalyse" in html, "Dokumentinhalt fehlt im Export")
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
