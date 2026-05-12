# Starter-Prompt für die nächste Session

Direkt in den Chat reinpasten:

---

Der **Automation-API-Ausbau ist abgeschlossen** (Stand 2026-05-12). Der
naheliegende nächste Schritt ist die **E2E-Test-Routine + Baseline-
Screenshots**, weil das API-Inventar jetzt vollständig steht.

## Stand zum Start

- **Automation-API vollständig** — Hermes hat alle Bausteine:
  - Eingaben: `POST /click`, `POST /rightclick`, `POST /key`,
    `POST /toc/activate` (alle ack-gewrappt).
  - Editor: `GET /editor/text`, `POST /editor/text`,
    `POST /editor/selection`, `POST /find`, `POST /find/text`.
  - UI: `POST /mode` (ack), `POST /theme`, `POST /rail`, `POST /focus`,
    `POST /resize`.
  - Dokumente: `POST /open`, `POST /open-ui` (ack), `POST /save`,
    `POST /quit`.
  - Synchronisation: `POST /wait` (allowlist: `editor.ready`,
    `document.loaded`, `document.saved`, `document.dirty_clean`).
  - Inspektion: `GET /state` (inkl. editor.scrollY/cursorOffset,
    view.scrollY/anchor, workspace.{pinned,recent,expandedDirs},
    consoleErrorCount), `GET /screenshot`, `GET /dom?selector=...`,
    `GET /console/errors?clear=true`.
- **Ack-Semantik** läuft über oneshot-Channel + Tauri-Command
  `automation_ack({id})`. Frontend wartet Microtask + rAF nach
  Handler-Arbeit, bevor es ackt (Codex-Synthese 2026-05-12 in
  `TODO.md` dokumentiert).
- **`/screenshot`-Endpoint** läuft über `tauri-plugin-screenshots`
  (Monitor-Capture, fängt auch Monaco in Xvfb). Details in
  `docs/headless-monaco-test-results.md` Option 3.
- **Tests**: cargo test --lib 151, smoke_automation 19,
  Vitest 42, clippy + fmt sauber.

## Lies zuerst

1. `CLAUDE.md` (Projekt-Konventionen).
2. `TODO.md` — Item **"E2E-Test-Routine + Baseline-Screenshots"** unter
   Hohe Priorität.
3. Memory `feedback_codex_consultant.md` — Codex als zweite Meinung
   bei Architektur-/Design-Fragen einsetzen.
4. `docs/frontend-globals.md` Abschnitt 4-5 — Automation-DOM-Vertrag
   + Tauri-Commands.
5. `src-tauri/src/automation/` als Übersicht der API-Module
   (`ack.rs`, `wait.rs`, `dom.rs`, `handlers/`).

## E2E-Routine — empfohlene Struktur

1. **Treiber-Sprache wählen** (Python mit `requests` / Node mit
   `node-fetch` / Bash mit `curl + jq`). Python ist pragmatisch,
   weil `Pillow` + `pixelmatch-py` da sind.
2. **Test-Vault**: kleines `tests/e2e/fixtures/`-Verzeichnis mit
   2-3 Markdown-Files (Headings, Tabelle, Codeblock, TOC-fähig).
3. **Aktions-Sequenz** als YAML/JSON-Skript:
   - Start: `POST /focus`, `POST /wait { event: 'editor.ready' }`.
   - File-Open via `POST /open-ui` + `POST /wait { event:
     'document.loaded' }`.
   - Mode-Wechsel via `POST /mode { mode: 'edit' }` (ack).
   - Editor-Aktionen: `POST /editor/selection`, `POST /key`,
     `GET /editor/text` für Assertions.
   - Visual-Diff: `GET /screenshot` → Pixelmatch gegen
     `tests/e2e/baseline/<step>.png`.
4. **Baseline-Generation-Mode**: Skript-Flag `--update-baselines`
   überschreibt die PNGs statt zu vergleichen.
5. **CI-Skelett**: Linux-Build (`cargo tauri build --bundles deb`)
   + Xvfb-Start + Routine. Initial reicht ein lokales `run.sh`,
   bevor wir es in CI gießen.

## Risiken / Codex-Konsult-Kandidaten

- **Pixelmatch-Toleranzen**: AA, Subpixel-Rendering, Font-Hinting.
  Schwellwerte definieren (z. B. `max-diff-pixels: 200`,
  `threshold: 0.1`).
- **Determinismus**: Mauszeiger-Position, Caret-Blink (Monaco hat
  einen optionalen `cursorBlinking: 'solid'`), Zeitstempel im UI.
- **Headless-Monaco** auf VPS: `docs/headless-monaco-screenshots.md`
  + `headless-monaco-test-results.md` haben Workarounds gesammelt.

## Andere offene Themen

Falls die E2E-Routine zu groß für eine Session ist, sind mittlere
Prio-Items in `TODO.md`:
- **Settings-Panel** (Theme/Font/Vault-Pfade/Automation-Port).
- **HTML-View** (`.html`/`.htm` sicher rendern).
- **JSON/XML/YAML/TOML Pretty-View**.
- **Linux: `.md`-Icon im Datei-Manager** reproduzierbar im `.deb`.

## Convention-Reminder

Pro Schritt grün:

```bash
cd src-tauri && cargo test --lib && \
  cargo clippy --all-targets -- -D warnings && \
  cargo test --test smoke_automation && cd web && \
  npm run build && npm run test
```

Commit-Stil: `feat(e2e): ..., Plan-TODO: E2E-Routine`. Bei
größeren Design-Fragen (Pixelmatch-Strategie, Test-Skript-Format)
Codex parallel konsultieren und Sichten synthetisieren.
