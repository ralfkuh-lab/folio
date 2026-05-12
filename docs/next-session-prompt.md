# Starter-Prompt für die nächste Session

Direkt in den Chat reinpasten:

---

Wir bauen die Automation-API auf E2E-Test-Tauglichkeit aus. Ziel: Hermes-
Agent kann die App komplett durchtesten (Keybindings, Editor-Commands,
Visual-Diff über `/screenshot`).

Stand zum Start:

- **Phase 5 ist durch** (bis auf 5.3c `editor.ts`-Split, bewusst
  zurückgestellt). Siehe `docs/refactoring-plan.md` Fortschritts-Table.
- **`/screenshot`-Endpoint** läuft seit Commit `caf9805` über
  `tauri-plugin-screenshots` (Monitor-Capture, fängt auch Monaco in Xvfb).
  Details in `docs/headless-monaco-test-results.md` Option 3.
- **Vitest-Setup** steht (`src-tauri/web/tests/`, 19 Tests, jsdom). Neue
  Frontend-Logik dort testen.
- **TODO.md** Sektion "Hohe Priorität" listet die offenen API-
  Ergänzungen mit Codex-Synthese.

Lies bitte zuerst:

1. `CLAUDE.md` (Projekt-Konventionen).
2. `TODO.md` — die zwei Items unter **Hohe Priorität**:
   "Automation-API für E2E-Tests vervollständigen" + "E2E-Test-Routine".
3. Memory `feedback_codex_consultant.md` — Codex als zweite Meinung
   einsetzen, Sichten synthetisieren.
4. `src-tauri/src/automation/{router.rs, types.rs, handlers/}` als
   Architektur-Übersicht der aktuellen API.
5. `src-tauri/web/app/automation/events.ts` — Frontend-Side der
   Bridge (`automation:click`/`set_editor_text`/`open_document`).

Empfohlene Reihenfolge (aus Codex-Synthese 2026-05-12):

1. **`POST /key`** — Tastatur-Events. Payload `{ key, modifiers?:
   {ctrl,shift,alt,meta}, target?: 'document'|'editor' }`. Pattern wie
   `automation:click`: Backend emittet `automation:key`, Frontend
   dispatcht synthetischen `KeyboardEvent` aufs Ziel. Test-fähig über
   Mock-Router + smoke_automation. Monaco-eigene Shortcuts (Strg+Z,
   Tab-Indent) **nicht** über `/key`, sondern später über
   `POST /editor/command {command}` mit `editor.trigger('keyboard', cmdId)`
   — synthetische Events sind dafür fragil.
2. **`GET /editor/text` + `POST /editor/selection {start, length}`** —
   Inhalt + Selektion lesen/setzen. Notwendig für deterministische
   Tests von `apply_editor_command` (Bold-Wrap etc.).
3. **Ack-Semantik** (Codex-Fund) für `/click`, `/key`, `/toc/activate` —
   aktuell bestätigt der Endpoint nur "Event emittiert", nicht "Handler
   fertig". CI wird sonst flaky. Frontend acked nach Handler-Ende über
   ein Event, Backend wartet via oneshot-Channel (mit Timeout) drauf.
4. **`POST /wait`** — `{ event: 'editor.ready'|'document.loaded'|...,
   timeoutMs }`. Eliminiert Polling-Flakes.
5. **`GET /dom?selector=...`**, Console-Error-Capture, Scroll-State
   in `/state` — mittlerer Hebel, kommen danach.

Empfehlung: mit (1) `/key` anfangen — kleinster Scope, ~80 LOC + Tests,
sofort spürbarer Test-Nutzen (Strg+S/F3/Alt+←/→ etc. werden testbar).

Pro Schritt: `cargo test --lib && cargo clippy --all-targets -- -D warnings
&& cargo test --test smoke_automation && cd src-tauri/web && npm run build
&& npm run test` grün, dann committen. Commit-Stil:
`feat(automation): ..., Plan-TODO: API-Erweiterung`.

Bei größeren Design-Fragen (z. B. Ack-Semantik-Mechanismus, oneshot-Channel
vs. Promise-Bridge) Codex parallel als zweite Meinung einsetzen
(siehe Memory) und Sichten synthetisieren.
