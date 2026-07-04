"""Dokumentübersetzung über einen lokalen OpenAI-kompatiblen Mock-Provider."""

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROVIDER_ID = "e2e-translate-provider"
MODEL_ID = "mock-translate"
LANGUAGE = "fr"


class _MockHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        system = next(
            (
                message.get("content", "")
                for message in payload.get("messages", [])
                if message.get("role") == "system"
            ),
            "",
        )
        match = re.search(r"target language\s+([^\s(]+)", system, re.IGNORECASE)
        language = match.group(1) if match else "unknown"
        content = f"# MOCK-ÜBERSETZUNG ({language})\n\nLokaler Testinhalt.\n"
        body = json.dumps(
            {"choices": [{"message": {"role": "assistant", "content": content}}]}
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
    server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    source = Path(ctx.fixture("sample.md"))
    generated = source.with_name(f"{source.stem}.{LANGUAGE}.md")
    expected = f"# MOCK-ÜBERSETZUNG ({LANGUAGE})\n\nLokaler Testinhalt.\n"

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
            ctx.expect(generated.is_file(), f"Übersetzungsdatei fehlt: {generated}")
            ctx.expect(generated.read_text(encoding="utf-8") == expected, "Mock-Inhalt weicht ab")
    finally:
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        _cleanup_provider(ctx)
        for path in _translation_files(source):
            path.unlink(missing_ok=True)
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)
