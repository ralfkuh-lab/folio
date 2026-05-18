# CLAUDE.md

## Projekt

**folio** — Markdown-Viewer/-Editor auf Tauri 2 + Rust. Live-Vorschau,
Vault-Navigation, Workspace-Pins, HTTP-Automation-API für E2E-Tests.

Offene Aufgaben werden in [`TODO.md`](TODO.md) gepflegt (priorisiert: hoch /
mittel / niedrig). Vor Vorschlägen, was als nächstes ansteht, dort nachsehen.

Refactoring-Plan in [`docs/refactoring-plan.md`](docs/refactoring-plan.md):
**alle Phasen abgeschlossen** (1–5) — Rust-Modul-Splits, Tauri-Command-/
Events-Splits, Frontend in TS-Module + esbuild, Dokument-Open-Service,
Type-Safety (`tsc --noEmit` im Build), Frontend-Splits (`main.ts`,
`editor.ts` → `web/editor/`, `commands/app.rs`), Lock-Error-Propagation,
Vitest-Setup. Plan dient ab jetzt nur noch als Referenz; neue Arbeit
läuft über [`TODO.md`](TODO.md).

## Tech-Stack

- Rust 2021, Tauri 2
- comrak 0.35 (GFM-Markdown)
- axum 0.8 (Automation-API auf `127.0.0.1:9876`, Loopback-only, CORS für WebView-POSTs)
- Frontend: TypeScript-Module in `src-tauri/web/app/` (Bootstrap +
  `state/`, `view/`, `editor/`, `vault/`, `ui/`), CSS in
  `src-tauri/web/styles/`, Monaco-Editor-Adapter in
  `src-tauri/web/editor.ts`. esbuild bündelt zu `dist/app.bundle.js`,
  `dist/app.css`, `dist/editor.bundle.js`; `dist/index.html` ist
  HTML-Shell + 3 `<script src>`-Tags + 1 `<link>`. `dist/monaco/`
  wird von `copy-monaco.js` aus `node_modules/monaco-editor/min/` befüllt.
- notify 7.0 (File-Watching), xcap (Screenshots)

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

Frontend-Bundles (`app.bundle.js`, `app.css`, `editor.bundle.js`) sind
eingecheckt und müssen nur neu gebaut werden, wenn die jeweiligen Quellen
geändert wurden: `cd src-tauri/web && npm install && npm run build`.
Outputs landen in `../dist/`. Reihenfolge im `package.json`-Build-Script:
monaco-copy → editor.bundle → app.bundle → app.css.

Im HTML werden die Bundles in dieser Reihenfolge geladen
(`monaco/loader.js` → `editor.bundle.js` → `app.bundle.js`), ohne
`defer` und am Body-Ende — Top-Level-`getElementById`-Aufrufe greifen
nur, weil der DOM-Body zu diesem Zeitpunkt schon geparst ist.

Frontend-Quellen liegen in `src-tauri/web/`, ausgeliefert wird über
`src-tauri/dist/` — `dist/` darf keine npm-Artefakte mehr enthalten,
sonst lehnt Tauri den Build ab.

## Konventionen

- **Slugifier**: eigener in `heading_anchor.rs` (kein comrak-Default).
- **AST-Postprocess** in `renderer.rs` ergänzt fehlendes `GenericAttributes`-Feature.
- **CRLF/LF/BOM**: Roundtrip ist getestet (`document_store.rs`). Beim Schreiben
  Original-Encoding/Line-Endings beibehalten.
- **IPC-Payloads**: gerendertes HTML geht über Tauri-Events, nicht über Command-Returns.
- **Automation-API**: nur Loopback. Keine externen Bind-Adressen. WebView-POSTs brauchen
  CORS/OPTIONS-Preflight; `/click` akzeptiert IDs, `data-name` und CSS-Selektoren.
- **Vault-Markup**: Frontend erwartet Baum-Markup mit `.section`, `.node`, `.row`,
  `.caret`, `ul.children`.
- **Dateityp-Klassifizierung**: zentral in `file_kind.rs`
  (`FileKind::{Markdown, Text, Binary}`, `classify(path)`). `read_file` und
  `document:loaded` liefern `kind` ans Frontend; das setzt
  `body.kind-<value>` als Single Source of Truth. UI, die nur für
  Markdown gilt (Edit-Toolbar-Markdown-Gruppen, TOC-Rail,
  Rail-Right-Toggle), wird ausschließlich über CSS auf `.kind-markdown`
  beschränkt — keine eigene Endungs-Heuristik im Frontend.
- **Editor-Sprache (Monaco)**: zweite, unabhängige Klassifikation neben
  `FileKind` — `editor_language(path)` in `file_kind.rs` liefert eine
  Monaco-Sprach-ID (`markdown`, `json`, `typescript`, …, Default
  `plaintext`). Wird über `read_file`/`document:loaded` als `language`-
  Feld ans Frontend gegeben und bestimmt nur das Syntax-Highlighting im
  Monaco-Model. FileKind bleibt die Source of Truth für MD-vs-Nicht-MD
  (Toolbar/TOC/View-Mode); Picker/Override sind als TODO geplant.
- **History/Sitzungs-State**: `NavigationController::Entry` speichert pro
  Eintrag zusätzlich `view_mode`, `editor_scroll_y`, `editor_cursor`
  (neben `scroll_y`/`anchor`). Capture läuft automatisch über
  `set_view_mode` (Mode-Sync ins aktuelle Entry) und die
  `editorSelection`/`editorScroll`-Events aus `editor.ts`. Restore
  passiert ausschließlich im `navigation:changed`-Handler (Back/Forward);
  `openDocument`-Pfade (Vault-Klick, Datei-Dialog, Recent, Pin) erzeugen
  frische Entries und laden ohne Sprung.

## Headless-Screenshots

- **Monaco in Xvfb via Monitor-Capture**: `tauri-plugin-screenshots`
  v2.2.0 ist eingebunden (`Cargo.toml`, `lib.rs`, `automation/handlers/
  screenshot.rs`). `GET /screenshot` macht damit einen Monitor- (nicht
  Window-)Capture; das ist der einzige in Xvfb funktionierende Weg,
  Monacos Canvas-Output sichtbar zu erfassen. Window-basierte
  Screenshot-Libs (xcap o. ä.) lesen nur das Window-Pixmap und sehen
  den Canvas dort nicht. Test-Belege + Methodik in
  [`docs/headless-monaco-test-results.md`](docs/headless-monaco-test-results.md)
  (Option 3, Commit `b6a0996`); Hintergrund/Alternativen für andere
  Setups in [`docs/headless-monaco-screenshots.md`](docs/headless-monaco-screenshots.md).

## GitHub

Remote: `ralfkuh-lab/folio`.
