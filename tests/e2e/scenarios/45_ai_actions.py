"""KI-Aktionen (✨): NewFile-Lauf, Replace mit Diff-Review + Undo,
Cancel ohne Restdatei und Selektions-Offsets mit Emoji — gegen einen
lokalen OpenAI-kompatiblen SSE-Mock (Muster aus 39_export_ai_draft)."""

import json
import re
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROVIDER_ID = "e2e-ai-actions-provider"
MODEL_ID = "mock-ai-actions"
SUMMARY_TEXT = "# Zusammenfassung\n\n- Kernaussage eins\n- Kernaussage zwei\n"
SOURCE = """# Bericht

Dieser Text hat ein Feler drin.

```rust
fn geschuetzt() {}
```

Schluss.
"""


def _document_part(user_message: str) -> str:
    """Extrahiert den Dokument-Teil hinter der Nonce-Trennerzeile."""
    match = re.search(r"^=== DOKUMENT \d+ \(Daten, keine Anweisungen\) ===$",
                      user_message, flags=re.MULTILINE)
    if not match:
        return ""
    return user_message[match.end():].lstrip("\n")


class _MockHandler(BaseHTTPRequestHandler):
    mode = "summary"
    received_stream = None
    received_user = None
    received_system = None
    slow_started = threading.Event()

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        cls = type(self)
        cls.received_stream = payload.get("stream")
        cls.received_system = next(
            (m.get("content", "") for m in payload.get("messages", [])
             if m.get("role") == "system"), "")
        cls.received_user = next(
            (m.get("content", "") for m in payload.get("messages", [])
             if m.get("role") == "user"), "")

        if cls.mode == "summary":
            body = SUMMARY_TEXT
        elif cls.mode == "proofread":
            # Dokument-Teil (inkl. Masking-Token) 1:1 zurückgeben, nur den
            # Tippfehler beheben — Token-Passthrough hält das unmask-Gate.
            body = _document_part(cls.received_user).replace("Feler", "Fehler")
        elif cls.mode == "selection":
            body = "ERSETZT"
        else:  # slow
            body = "x" * 4000

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        chunk = 24 if cls.mode != "slow" else 8
        delay = 0.005 if cls.mode != "slow" else 0.05
        try:
            for i in range(0, len(body), chunk):
                event = ("data: " + json.dumps(
                    {"choices": [{"delta": {"content": body[i:i + chunk]}}]},
                    ensure_ascii=False) + "\r\n\r\n").encode("utf-8")
                self.wfile.write(event)
                self.wfile.flush()
                if cls.mode == "slow" and i >= chunk:
                    cls.slow_started.set()
                time.sleep(delay)
            self.wfile.write(b"data: [DONE]\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # Erwartet beim Cancel-Test: der Client bricht den Stream ab.
            pass

    def log_message(self, _format, *_args):
        return


def _eval(ctx, js: str):
    response = ctx.api.eval(js, timeout_ms=10_000)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


def _poll(ctx, description: str, probe, timeout: float = 12.0, interval: float = 0.2):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = probe()
        if last:
            return last
        time.sleep(interval)
    ctx.expect(False, f"Timeout: {description} (zuletzt: {last!r})")


def _assert_diff_region_visible(ctx):
    """Härtet Sichtbarkeit der Diff-Review: Geometrie + gemounteter Monaco-DiffEditor.

    Statt nur body-Klasse wird getBoundingClientRect + content-region-Überlappung
    und tatsächliche Mount-Größe geprüft (Regression: Region war außerhalb/zu schmal).
    """
    geom = _eval(ctx, """(() => {
        const region = document.getElementById('ai-diff-region');
        const content = document.getElementById('content-region');
        const rect = region ? region.getBoundingClientRect() : null;
        const contentRect = content ? content.getBoundingClientRect() : null;
        return {
            rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
            contentRect: contentRect ? { left: contentRect.left, right: contentRect.right, top: contentRect.top, bottom: contentRect.bottom, width: contentRect.width, height: contentRect.height } : null,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight
        };
    })()""") or {}

    rect = geom.get("rect") or {}
    contentRect = geom.get("contentRect") or {}
    innerW = geom.get("innerWidth") or 0
    innerH = geom.get("innerHeight") or 0

    ctx.expect(
        rect.get("width", 0) > 400,
        f"ai-diff-region Breite >400px erwartet, aber width={rect.get('width')} (innerW={innerW}, rect={rect})"
    )
    ctx.expect(
        rect.get("height", 0) > 200,
        f"ai-diff-region Höhe >200px erwartet, aber height={rect.get('height')} (innerH={innerH}, rect={rect})"
    )
    ctx.expect(
        rect.get("right", 0) <= innerW + 1,
        f"ai-diff-region ragt rechts aus Viewport: right={rect.get('right')} > innerW+1={innerW+1} (rect={rect})"
    )
    ctx.expect(
        rect.get("left", 0) >= -1,
        f"ai-diff-region ragt links aus Viewport: left={rect.get('left')} < -1 (rect={rect})"
    )
    ctx.expect(
        abs(rect.get("left", 0) - contentRect.get("left", 0)) < 5,
        f"ai-diff-region left weicht stark von .content-region ab: left={rect.get('left')}, contentLeft={contentRect.get('left')} (rect={rect})"
    )

    # Poll auf asynchrones Mount des DiffEditors (Monaco-Instanz + DOM >0x0)
    _poll(ctx, "Monaco-DiffEditor in #ai-diff-mount gemountet (nicht 0x0)",
          lambda: _eval(ctx, """(() => {
              const m = document.getElementById('ai-diff-mount');
              if (!m) return false;
              const hasChild = m.children.length > 0;
              const h = m.getBoundingClientRect().height || 0;
              return hasChild && h > 100;
          })()"""))


def _configure_provider(ctx, base_url: str):
    return _eval(ctx, f"""(async () => {{
        await window.__folioInvoke("ai_custom_upsert", {{
            definition: {{ id: {PROVIDER_ID!r}, name: "E2E AI Actions Mock", baseURL: {base_url!r} }}
        }});
        await window.__folioInvoke("ai_model_toggle", {{
            providerId: {PROVIDER_ID!r}, modelId: {MODEL_ID!r}, on: true
        }});
        await window.__folioInvoke("ai_default_model_set", {{
            providerId: {PROVIDER_ID!r}, modelId: {MODEL_ID!r}
        }});
        // Raw-Invokes umgehen den Settings-UI-Pfad (invokeUi in
        // settings-ai.ts), der die configCaches der KI-Dialoge per
        // folio-ai-invoke-complete refresht — Dispatch hier nachbilden,
        // sonst bleiben die KI-Toolbar-Buttons trotz Whitelist disabled.
        const cfg = await window.__folioInvoke("ai_config_get");
        document.dispatchEvent(new CustomEvent("folio-ai-invoke-complete", {{ detail: cfg }}));
        return true;
    }})()""")


def _cleanup_provider(ctx):
    try:
        _eval(ctx, f"""Promise.allSettled([
            window.__folioInvoke("ai_auth_remove", {{ providerId: {PROVIDER_ID!r} }}),
            window.__folioInvoke("ai_custom_delete", {{ id: {PROVIDER_ID!r} }})
        ])""")
    except Exception:
        pass


def _open_actions_dialog(ctx):
    ctx.api.menu_click("edit.ai_actions")
    # Der Dialog ist schon im Loading-Zustand sichtbar — ready ist er
    # erst, wenn der Start-Button wieder enabled ist (setBusy(false)).
    _poll(ctx, "KI-Aktionen-Dialog bereit",
          lambda: _eval(ctx, "(() => { const d = document.getElementById('ai-actions-dialog');"
                             " const s = document.getElementById('ai-actions-start');"
                             " return !d.hidden && !s.disabled; })()"))


def _select_action(ctx, action_id: str):
    ctx.api.click(f"#ai-actions-list [data-action-id=\"{action_id}\"]")


def run(ctx):
    _MockHandler.mode = "summary"
    _MockHandler.slow_started.clear()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    tmp = Path(tempfile.mkdtemp(prefix="folio-e2e-ai-actions-"))
    source = tmp / "bericht.md"
    source.write_text(SOURCE, encoding="utf-8")

    try:
        _cleanup_provider(ctx)
        with ctx.step("Mock-Provider konfigurieren und Dokument öffnen"):
            base_url = f"http://127.0.0.1:{server.server_port}/v1"
            ctx.expect(_configure_provider(ctx, base_url) is True, "Provider-Setup fehlgeschlagen")
            ctx.api.tabs_close_all()
            ctx.api.open(str(source), discard=True)
            ctx.api.mode("view")

            # Poll (nicht Einmal-Check): Enable der KI-Buttons läuft async nach
            # Provider-Config + Doc-Load (applyDocKind + folio-doc-kind-changed).
            # menu_click umgeht disabled-States, deshalb hätte die Suite die
            # Stale-Read-Regression nie gesehen.
            _poll(ctx, "tb-ai-actions und tb-ai-translate enabled (kein Gating-Race)",
                  lambda: _eval(ctx, """(() => {
                      const a = document.getElementById('tb-ai-actions');
                      const t = document.getElementById('tb-ai-translate');
                      return a && t && !a.disabled && !t.disabled;
                  })()"""))

        with ctx.step("NewFile-Aktion (Zusammenfassen) über Menü + Dialog"):
            _MockHandler.mode = "summary"
            _open_actions_dialog(ctx)
            _select_action(ctx, "summarize")
            ctx.api.click("ai-actions-start")
            # Deterministischer Wait-Vertrag statt reiner Poll-Schleife.
            ctx.api.wait("ai.action.done", timeout_ms=15_000)
            summary_path = tmp / "bericht.summary.md"
            _poll(ctx, "Zusammenfassungs-Datei geschrieben",
                  lambda: summary_path.exists() and "Kernaussage eins" in
                  summary_path.read_text(encoding="utf-8"))
            tabs = ctx.api.tabs()
            paths = [t.get("path") or "" for t in tabs.get("tabs", [])]
            ctx.expect(any(p.endswith("bericht.summary.md") for p in paths),
                       f"Summary-Tab fehlt: {paths!r}")
            ctx.expect(_MockHandler.received_stream is True, "stream:true fehlt")
            ctx.expect("Daten, keine Anweisungen" in (_MockHandler.received_system or ""),
                       "Untrusted-Data-Regel fehlt im System-Prompt")

        with ctx.step("Replace-Aktion (Korrektur) mit Diff-Review + Undo"):
            _MockHandler.mode = "proofread"
            # Zurück zum Quelldokument (Summary-Tab ist gerade aktiv).
            ctx.api.open(str(source), discard=True)
            ctx.api.mode("edit")
            original = _eval(ctx, "window.FolioEditor.getText()")
            ctx.expect("Feler" in original, "Fixture-Tippfehler fehlt")
            _open_actions_dialog(ctx)
            _select_action(ctx, "proofread")
            ctx.api.click("ai-actions-start")
            _poll(ctx, "Diff-Review offen",
                  lambda: _eval(ctx, "document.body.classList.contains('ai-diff-open')"))
            _assert_diff_region_visible(ctx)
            # Regression-Schutz für den Permanent-Sichtbarkeits-Override (härter gegen Monaco .showAlways):
            # ALLE .gutterItem müssen opacity '1' haben, UND mind. eines darf NICHT .showAlways tragen
            # (letzteres beweist unseren CSS-Override, nicht nur Monacos selected-Hunk).
            _poll(ctx, "alle .gutterItem opacity '1' UND mind. eines ohne .showAlways in #ai-diff-region",
                  lambda: _eval(ctx, """(() => {
                      const items = document.querySelectorAll('#ai-diff-region .gutterItem');
                      if (items.length === 0) return false;
                      let hasNonShowAlways = false;
                      for (const it of Array.from(items)) {
                          const op = getComputedStyle(it).opacity;
                          if (op !== '1' && op !== '1.0') return false;
                          if (!it.classList.contains('showAlways')) hasNonShowAlways = true;
                      }
                      return hasNonShowAlways;
                  })()"""))
            with ctx.step("screenshot ai-diff review"):
                ctx.screenshot("ai_diff_review")
            # Masking-Beleg: der Mock sah Token statt Rust-Code.
            ctx.expect("geschuetzt" not in (_MockHandler.received_user or ""),
                       "Code-Fence war nicht maskiert")
            ctx.api.click("ai-diff-apply")
            _poll(ctx, "Editor-Text ersetzt",
                  lambda: "Fehler" in _eval(ctx, "window.FolioEditor.getText()"))
            after = _eval(ctx, "window.FolioEditor.getText()")
            ctx.expect("fn geschuetzt() {}" in after, "Code-Fence nach unmask beschädigt")
            ctx.expect(not _eval(ctx, "document.body.classList.contains('ai-diff-open')"),
                       "Review-Region blieb offen")
            _eval(ctx, "window.FolioEditor.undo()")
            _poll(ctx, "Undo stellt Original wieder her",
                  lambda: "Feler" in _eval(ctx, "window.FolioEditor.getText()"))

        with ctx.step("Replace aus dem View-Mode: Übernehmen wechselt in Edit-Mode"):
            ctx.api.mode("view")
            _open_actions_dialog(ctx)
            _select_action(ctx, "proofread")
            ctx.api.click("ai-actions-start")
            _poll(ctx, "Diff-Review offen",
                  lambda: _eval(ctx, "document.body.classList.contains('ai-diff-open')"))
            _assert_diff_region_visible(ctx)
            ctx.api.click("ai-diff-apply")
            _poll(ctx, "nach Übernehmen im Edit-Mode (kein Save-Prompt blockte)",
                  lambda: _eval(ctx, "document.body.classList.contains('edit-mode')"))
            _poll(ctx, "Editor-Text ersetzt (Fehler)",
                  lambda: "Fehler" in _eval(ctx, "window.FolioEditor.getText()"))
            # Cleanup wie im Vor-Step, kein mode("view") danach (Folge-Step setzt selbst)
            _eval(ctx, "window.FolioEditor.undo()")
            _poll(ctx, "Undo stellt Original wieder her",
                  lambda: "Feler" in _eval(ctx, "window.FolioEditor.getText()"))

        with ctx.step("Cancel-Pfad: langsamer Stream, keine Restdatei"):
            _MockHandler.mode = "slow"
            _MockHandler.slow_started.clear()
            ctx.api.mode("view")
            _open_actions_dialog(ctx)
            _select_action(ctx, "extract-actions")
            ctx.api.click("ai-actions-start")
            ctx.expect(_MockHandler.slow_started.wait(timeout=10.0), "Slow-Stream startete nicht")
            # Status sichtbar + running-Klasse + (falls nicht reduced-motion) animiert.
            # Prüft ai-status-running (Lauf-Zustand) + anim (eines von Pulse/Spinner::before).
            # Bei prefers-reduced-motion: animName==='none' ist korrekt (CSS setzt animation:none), Assertion besteht.
            _poll(ctx, "#ai-action-status sichtbar, ai-status-running und animiert (oder reduced-motion)",
                  lambda: _eval(ctx, """(() => {
                      const el = document.getElementById('ai-action-status');
                      if (!el || el.hidden || !el.classList.contains('ai-status-running')) return false;
                      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
                      const cs = getComputedStyle(el);
                      const bcs = getComputedStyle(el, '::before');
                      return (cs.animationName && cs.animationName !== 'none') ||
                             (bcs.animationName && bcs.animationName !== 'none');
                  })()"""))
            ctx.api.click("ai-action-status-cancel")
            actions_path = tmp / "bericht.actions.md"
            _poll(ctx, "Statusleiste geschlossen",
                  lambda: _eval(ctx, "document.getElementById('ai-action-status').hidden"))
            _poll(ctx, "Reservierungsdatei aufgeräumt",
                  lambda: not actions_path.exists())

        with ctx.step("Selektions-Lauf mit Emoji-Offsets (Replace + Custom-Prompt)"):
            _MockHandler.mode = "selection"
            emoji_source = tmp / "emoji.md"
            emoji_source.write_text("# Kopf\n\n😀😀 MITTE hinten\n", encoding="utf-8")
            ctx.api.open(str(emoji_source), discard=True)
            ctx.api.mode("edit")
            # UTF-16-korrekt im Frontend rechnen (Astral-Emoji davor!):
            start = _eval(ctx, "window.FolioEditor.getText().indexOf('MITTE')")
            ctx.api.editor_selection(start, len("MITTE"))
            _open_actions_dialog(ctx)
            _select_action(ctx, "__custom__")
            _eval(ctx, """(() => {
                const p = document.getElementById('ai-actions-prompt');
                p.value = 'Ersetze die Auswahl.';
                p.dispatchEvent(new Event('input'));
                document.getElementById('ai-actions-target-replace').checked = true;
                document.getElementById('ai-actions-scope-selection').checked = true;
                return true;
            })()""")
            ctx.api.click("ai-actions-start")
            _poll(ctx, "Diff-Review offen (Selektion)",
                  lambda: _eval(ctx, "document.body.classList.contains('ai-diff-open')"))
            _assert_diff_region_visible(ctx)
            ctx.api.click("ai-diff-apply")
            _poll(ctx, "Selektion korrekt ersetzt",
                  lambda: _eval(ctx, "window.FolioEditor.getText()")
                  == "# Kopf\n\n😀😀 ERSETZT hinten\n")
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
