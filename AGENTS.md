# AGENTS.md

Gemeinsame Projektanweisungen für alle Coding-Agenten (Claude Code liest sie
über `CLAUDE.md` → `@AGENTS.md`). Diese Datei ist bewusst ein **Index**:
Detailwissen zu einzelnen Bereichen steht in `docs/` und wird bei Arbeit am
jeweiligen Bereich gelesen (Tabelle „Themen“ unten). Neue Konventionen dort
eintragen, hier höchstens eine Zeile im Index bzw. bei den harten Regeln.

## Projekt

**folio** — Markdown-Viewer/-Editor auf Tauri 2 + Rust. Live-Vorschau,
Vault-Navigation, Workspace-Pins, HTTP-Automation-API für E2E-Tests.
Remote: `ralfkuh-lab/folio`.

Offene Aufgaben stehen in [`TODO.md`](TODO.md) (hoch / mittel / niedrig),
Optionen in [`docs/feature-ideen.md`](docs/feature-ideen.md). `TODO.md` =
Verpflichtungen, `feature-ideen.md` = Optionen; „was steht an?" meint beides.
Historie steckt im Git-Log, nicht in der Doku.

## Tech-Stack

- Rust 2021, Tauri 2, comrak 0.35 (GFM), notify 7.0 (File-Watching),
  tauri-plugin-screenshots 2.2 (Monitor-Capture).
- axum 0.8: Automation-API auf `127.0.0.1:9876`, Loopback-only + Host-/
  Origin-Allowlist; im Release-Build nur mit `FOLIO_AUTOMATION=1`.
- Frontend: TypeScript in `src-tauri/web/app/` (`state/`, `view/`, `editor/`,
  `vault/`, `ui/`, `automation/`), CSS in `src-tauri/web/styles/`,
  Monaco-Adapter in `src-tauri/web/editor/`, `src-tauri/web/shared/` als
  einziges Verzeichnis, aus dem app- **und** editor-Bundle importieren.
  esbuild bündelt nach `src-tauri/dist/` (`app.bundle.js`, `app.css`,
  `editor.bundle.js`, `mermaid.bundle.js`); `dist/monaco/` füllt
  `copy-monaco.js`.

## Build & Test

Cargo-Befehle aus `src-tauri/`:

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo tauri build                   # Linux: deb + rpm + appimage in target/release/bundle/
cargo tauri build --bundles deb     # einzelnes Bundle-Target
```

Frontend: `cd src-tauri/web && npm install && npm run build` (startet mit
`tsc --noEmit`), Tests mit `npx vitest run`.

- **Bundles sind eingecheckt** und werden zur Compile-Zeit ins Binary
  eingebettet. Nach Änderungen in `web/` immer `npm run build` — ein bereits
  gebautes `target/release/folio` sieht neue Bundles erst nach
  `cargo build --release`. **Bundle-Drift ist ein Gate**:
  `bash scripts/check-bundles.sh` (Exit 1 = Drift, 2 = nicht prüfbar);
  `run-e2e.sh` bricht bei Drift ab. `tsc`, vitest und cargo lesen nur die
  Quellen und bemerken vergessene Bundles nicht.
- `tsconfig.json` hat `noUnusedLocals`/`noUnusedParameters` an: Ungenutztes
  ist ein Build-**Fehler**. Beim Auskommentieren mit aufräumen.
- Ladereihenfolge im HTML: `monaco/loader.js` → `editor.bundle.js` →
  `app.bundle.js`, ohne `defer`, am Body-Ende (Top-Level-`getElementById`
  verlässt sich darauf). `dist/` darf keine npm-Artefakte enthalten.
- **Tests schlank halten** (Benutzerentscheidung 2026-11-28): nur Tests, die
  wirklich nötig sind — riskante Kernlogik und Sicherheitsaspekte (z. B.
  Escaping), mehrere Fälle in wenigen Testfunktionen gebündelt. Triviales
  (serde-Defaults, ID-Vergabe, Textsäuberung) nicht eigens testen. Kein neues
  E2E-Szenario mit Baselines ohne Not; für eine Sichtprüfung reicht ein
  einmaliger nativer Prüflauf mit Screenshots außerhalb des Repos, die
  bestehenden Szenarien bleiben das Regressions-Gate.

## E2E-Suite (Kurzfassung)

70 Szenarien in `tests/e2e/` (Python + Pillow), Linux + Xvfb, Visual-Baselines
als Monitor-Capture (an Linux 1280×800 gebunden). Details, Fixture-Regeln und
Szenario-Konventionen: [`docs/e2e-testing.md`](docs/e2e-testing.md);
**Pflichtlektüre vor neuen Szenarien**:
[`docs/e2e-headless-caveats.md`](docs/e2e-headless-caveats.md).

- `bash scripts/run-e2e.sh [szenario…] [--update-baselines] [--no-visual]`;
  `--lang-smoke` prüft den englischen Boot. Der Wrapper bricht ab, wenn eine
  Folio des Benutzers läuft (single-instance). Isoliert trotzdem laufen:
  Kopie des Wrappers ohne pgrep-Block über `dbus-run-session -- bash …`.
- Vor jedem Szenario läuft ein kanonischer Reset (`lib/reset.py`) und die
  Fixtures werden wiederhergestellt. Jedes Szenario setzt seinen View-Mode
  selbst (`api.mode(...)`) und räumt eigenen Zustand (Tabs, Pins, Workspace)
  im `finally` auf, sonst wandert er in spätere Baselines.
- Pfade, die im Baum oder in der Statusleiste sichtbar sind, sind Teil der
  Baseline: Fixtures mit festem `/tmp/folio-e2e-…`-Pfad statt `mkdtemp`.

## Harte Regeln (gelten überall)

- **Logging**: keine `eprintln!`/`println!` im Produktionscode (Ausnahme
  `logging.rs::init`), sondern `tracing::*!` mit `target: "folio::<bereich>"`.
  Frontend: `folioLog.*` und `safeInvoke(...)` statt
  `invoke(...).catch(() => {})`.
- **Pfade**: alles, was in `data-path`, `workspace.json` oder Pin-Vergleiche
  geht, auf Forward-Slashes normalisieren. „Dieselbe Datei?" nur über
  `path_identity` (`same_file`/`identity_key` mit IO oder
  `lexical_paths_equal` ohne IO) — bewusst wählen. Präfix-Operationen
  (Umbenennen/Verschieben) ausschließlich über `path_migration`
  (Segmentgrenze!) und den einen Migrationspfad `perform_move`.
- **Editor-Schreibzugriffe** über `executeEdits` zwischen zwei
  `pushUndoStop`, **nie** `setValue` (löscht den Undo-Stack).
- **IPC**: gerendertes HTML geht über Tauri-Events, nicht über
  Command-Returns (einzige Ausnahme: `render_markdown_preview`).
  `document:*`-Events tragen einen gemeinsamen seq-Counter; das Frontend
  verwirft veraltete.
- **Persistenz**: UI-Schalter in `panel_state.rs` (`panel-state.json`),
  Workspace-Daten in `workspace.rs` (`workspace.json`), Settings in
  `settings.json` — keine eigenen JSON-Dateien. Neue Felder immer mit
  `#[serde(default)]`.
- **Dateityp**: `file_kind.rs` ist die Quelle; das Frontend schaltet nur über
  `body.kind-<typ>`, keine eigene Endungs-Heuristik.
- **Sicherheit**: Automation nur Loopback. Der assetProtocol-Scope ist `**`,
  damit ist der HTML-Sanitizer die einzige Barriere zwischen einer fremden
  `.html` und lokalen Dateien. KI-Schlüssel nie in Logs, Fehlern, DOM oder
  Automation.
- **Eigene DOM-Umbauten unter einem `MutationObserver`**: `takeRecords()` im
  `finally`, sonst Endlosschleife.
- **Vault-Baum**: DOM-ersetzende Setter respektieren ein offenes
  Inline-Rename (`vault/rename-guard.ts`). Ziehen ist Pointer-basiert, nie
  HTML5-Drag&Drop (auf Windows/WebView2 tot).
- **Editor vor dem Mount**: Schreibaufrufe über `deferUntilMounted` (genau
  ein Retry), nie unbedingte Selbst-Rekursion auf `mountReady`.
- **Monaco**: genau ein AMD-Loader (`whenMonacoLoaded`) für alle Instanzen;
  Worker brauchen `MonacoEnvironment.getWorkerUrl`.
- **Markdown-Render**: eigener Slugifier in `heading_anchor.rs` (kein
  comrak-Default); der AST-Postprocess in `renderer.rs` ergänzt fehlendes
  `GenericAttributes`.
- **Encoding**: Original-Encoding und Zeilenenden beim Speichern beibehalten;
  nicht darstellbare Zeichen in Windows-1252 sind ein Fehler, kein stilles
  Ersetzen.

## i18n

- Kataloge in `src-tauri/locales/<tag>.json` (9 Sprachen), alphabetisch
  sortiert, identische Key-Mengen. Neue Keys außerdem in
  `src-tauri/tests/fixtures/locales/fr.json` (zwei Tests verlangen gleiche
  Key-Mengen) und mit englischem Kontextsatz in
  `src-tauri/locales/context/keys.json`.
- Keys: Funktion auf Englisch in `camelCase` unter kanonischem Namespace
  (`errors.<modul>.<fall>`, kein freies `common.*`).
- Frontend `t()`/`tPlural()`, Rust `t()`/`t_args()`/`t_plural()`. Technische
  Details als `{detail}` einsetzen, nicht als Katalogwert.
- Bootstrap `booting → i18nReady → uiReady`; frontendabhängige Automation erst
  nach dem Ready-Gate. Referenz- und Markup-Gates sind hart.
- Vollständiger Vertrag: [`docs/spec-i18n.md`](docs/spec-i18n.md).

## Themen

Vor Arbeit an einem Bereich das zugehörige Dokument lesen.

| Bereich | Dokument |
| --- | --- |
| Dokumente, Encoding, IPC- und Lifecycle-Events, assetProtocol, Dateityp, Fenster-Geometrie, UI-Persistenz, Logging | [`docs/architektur-app.md`](docs/architektur-app.md) |
| Vault-Markup, Pfad-Normalisierung und -Identität, Vault-Watcher, versteckte Einträge, Pin-Reordering, Pin-Trenner, Git-Status/-Diff/-Dimming | [`docs/architektur-vault.md`](docs/architektur-vault.md) |
| Editor und Ansicht: Split-Mode, Live-Preview, Mermaid, Callouts, Smart-List, Task-Checkboxen, Image-View, Code-View, HTML-View-Suche, Find-Bar, Einfügen (Bild, HTML), Breiten-Toggle, History | [`docs/architektur-editor-view.md`](docs/architektur-editor-view.md) |
| Automation-API, DOM- und Event-Vertrag | [`docs/automation-contract.md`](docs/automation-contract.md) |
| Vault-Volltextsuche | [`docs/spec-vault-search.md`](docs/spec-vault-search.md) |
| Vault-Filter (Namens-, Tiefenfilter, Bereich) | [`docs/spec-vault-filter.md`](docs/spec-vault-filter.md) |
| Vault-Dateioperationen | [`docs/spec-vault-fileops.md`](docs/spec-vault-fileops.md) |
| Vault-Tastatur | [`docs/spec-vault-keyboard.md`](docs/spec-vault-keyboard.md) |
| Wikilinks und Tags | [`docs/spec-wikilinks.md`](docs/spec-wikilinks.md) |
| Tabs, Session-Restore | [`docs/spec-multi-tabs.md`](docs/spec-multi-tabs.md), [`docs/spec-tab-context-menu.md`](docs/spec-tab-context-menu.md) |
| Tabellen | [`docs/spec-tables.md`](docs/spec-tables.md) |
| View-Themes, Export-Layouts, Theme-Editor | [`docs/spec-theme-system.md`](docs/spec-theme-system.md) |
| Command Palette | [`docs/spec-command-palette.md`](docs/spec-command-palette.md) |
| Statusleiste | [`docs/spec-statusbar.md`](docs/spec-statusbar.md) |
| Zen-Modus | [`docs/spec-zen-mode.md`](docs/spec-zen-mode.md) |
| Hex-Ansicht | [`docs/spec-hex-view.md`](docs/spec-hex-view.md) |
| KI-Integration (Provider, Übersetzung, Masking) | [`docs/spec-ki-tab.md`](docs/spec-ki-tab.md) |
| KI-Aktionen und Diff-Review | [`docs/spec-ki-actions.md`](docs/spec-ki-actions.md) |
| E2E-Suite, Headless-Screenshots, README-Screenshots | [`docs/e2e-testing.md`](docs/e2e-testing.md), [`docs/e2e-headless-caveats.md`](docs/e2e-headless-caveats.md) |
