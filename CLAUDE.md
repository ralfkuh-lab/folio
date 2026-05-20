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
  `state/`, `view/`, `editor/`, `vault/`, `ui/`, `automation/`), CSS in
  `src-tauri/web/styles/`, Monaco-Editor-Adapter als Modul-Verzeichnis
  `src-tauri/web/editor/` (`mount.ts`, `text.ts`, `find.ts`, `state.ts`,
  `events.ts`, `bridge.ts`, `index.ts` als Surface-Composer). esbuild
  bündelt zu `dist/app.bundle.js`, `dist/app.css`, `dist/editor.bundle.js`;
  `dist/index.html` ist HTML-Shell + 3 `<script src>`-Tags + 1 `<link>`.
  `dist/monaco/` wird von `copy-monaco.js` aus
  `node_modules/monaco-editor/min/` befüllt.
- notify 7.0 (File-Watching), tauri-plugin-screenshots 2.2 (Monitor-Capture)

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
  `editorSelection`/`editorScroll`-Events aus den `editor/`-Modulen.
  Restore passiert ausschließlich im `navigation:changed`-Handler
  (Back/Forward); `openDocument`-Pfade (Vault-Klick, Datei-Dialog, Recent,
  Pin) erzeugen frische Entries und laden ohne Sprung.
  `commands::nav::move_history` und `automation/handlers/ui.rs::history_move`
  haben jeweils ein `can_go_back`/`can_go_forward`-Gate vor dem
  go_back/go_forward-Call — am Stack-Edge wird Ok(None) bzw.
  `{moved: false, entry: null}` geliefert, statt unnötig current() zu
  re-loaden.
- **UI-Toggle-Persistenz**: alle UI-Schalter mit Memo (Vault-Rail,
  TOC-Rail, Editor-Minimap, Cheatsheet-Position, Window-Geometrie,
  Pinned/Recent-Section-Expansion) sitzen in
  `panel_state.rs::PanelStateData` und werden in `panel-state.json`
  unter dem App-Config-Verzeichnis persistiert. Neue Toggles dort
  ergänzen, nicht eigene JSON-Files erfinden.
- **Editor-`applyReplace`**: nutzt `editor.executeEdits(...)` (nicht
  `setValue`!) — letzteres clearet Monacos Undo-Stack und macht
  Bold-Wrap/Heading-Toggle/etc. destruktiv. Bei Erweiterungen rund um
  programmatic Editor-Writes diese Konvention beibehalten.
- **Code-View (Read-Only Monaco im View-Mode)**: Non-Markdown-Text-
  Dateien (JSON, XML, YAML, Code, …) bekommen im View-Mode eine
  eigene Monaco-Instanz neben dem Edit-Editor. Surface
  `window.FolioCodeView` (Bundle `editor/view-code.ts`,
  `editor/index.ts`), Container `#code-view-mount`. Auto-Format laeuft
  fuer ALLE Sprachen einheitlich ueber Monacos
  `editor.action.formatDocument` (gesteuert vom Setting
  `viewAutoFormat`, default an) — keine JSON-Sonderbehandlung.
  Sprachen ohne registrierten Formatter zeigen den Rohinhalt; ebenso
  wenn das Setting aus ist. Theme-Sync laeuft ueber `setEditorTheme`
  (in `editor/shell.ts`), das beide Surfaces aktualisiert. Code-View
  hat sein eigenes Find-Widget (Strg+F) — die Folio-Find-Bar
  uebersetzt den Capture-Listener bei `kind=text + !edit-mode` an
  Monaco. **Beide Monaco-Instanzen teilen einen einzigen AMD-Loader**
  ueber `editor/mount.ts::whenMonacoLoaded` — `loadMonaco()` wird
  exakt einmal beim Bundle-Init gerufen. Wer Monaco erweitert oder
  Worker konfiguriert, muss beide Pfade beruecksichtigen.
- **MonacoEnvironment.getWorkerUrl**: in `editor/mount.ts::loadMonaco`
  wird vor `require.config(...)` ein Worker-Bootstrap via `data:`-URI
  registriert (`origin + /monaco/vs/base/worker/workerMain.js`). Ohne
  diesen Hook starten Monacos Sprach-Worker (JSON/TS/CSS/HTML/...) im
  AMD-Setup nicht, weshalb fruehere Versionen z. B. „Format Document"
  auf JSON still fehlschlugen. Bei einem Update der Monaco-Dependency
  pruefen, ob `workerMain.js` noch unter diesem Pfad liegt.
- **Image-Insert (Toolbar `tb-image` + Strg+V)**: Anders als die anderen
  Inline-Editor-Commands (Bold/Italic/Link über `apply_editor_command`)
  hat `tb-image` einen eigenen Frontend-Pfad — siehe `ui/image-dialog.ts`
  und `ui/paste-handler.ts`. Der Dialog liefert ein Bild aus
  Zwischenablage (Browser-Clipboard-API über `navigator.clipboard.read()`
  oder den ClipboardEvent aus dem Capture-Paste-Handler) oder einer
  Datei, schreibt es über `save_clipboard_image` / `save_file_image` ins
  Doc-Verzeichnis (oder ein gemerktes Per-Doc-Verzeichnis), und der
  Frontend baut den Markdown-Tag mit dem zurückgegebenen relativen Pfad
  und fügt ihn via `FolioEditor.applyReplace` ein (Cursor-Position
  eingefroren beim Dialog-Open). Per-Doc-Verzeichnis liegt in
  `WorkspaceData.image_dirs: HashMap<DocPath, Dir>`. Relativer Pfad
  über `file_resolver::make_relative` (Wrapper um `pathdiff::diff_paths`,
  POSIX-Slashes für Markdown-Konvention). Clipboard-RGBA → PNG-Encoding
  passiert im Backend mit dem `image`-Crate.
- **Pre-Mount-Editor-Optionen**: Editor-Optionen, die schon beim Boot
  gesetzt werden (heute nur Minimap aus dem persistierten Panel-State),
  laufen über eine `pendingMinimapEnabled`-Variable in `editor/mount.ts`,
  die `mount()` in die initialen `monaco.editor.create()`-Options zieht.
  KEIN `mountReady.then(...)`-Defer für Pre-Mount-Calls: `mountReady` ist
  bis zum ersten Mount `Promise.resolve()`, ein Defer wäre eine
  Endlos-Microtask-Schleife (war der Bug, der bei Folio-Start ohne offene
  Datei das gesamte Frontend killte; siehe Fix-Commit `f4ef8f1`).

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

- **Hintergrund-Test-Strategie**: "Unsichtbares" Ausführen für
  Automation-Tests ist **nur unter Linux via Xvfb** vorgesehen — die
  App läuft auf `DISPLAY=:99`, der interaktive User auf `:0`, kein
  Fenster auf seinem Schirm, `/screenshot` liefert sichtbares Monaco
  über Monitor-Capture im Xvfb-Framebuffer. Ein `--headless`-Flag für
  Windows ist **nicht gebaut** (Stand 2026-05-18): `xcap` filtert in
  `is_valid_window` Fenster des **eigenen Prozesses** raus
  (Deadlock-Vermeidung bei `GetWindowText*`) und blockiert damit jeden
  Window-Capture-Pfad von Folio auf sich selbst — egal ob `visible:
  false`, `set_skip_taskbar`, off-screen. Echtes Hidden-Headless auf
  Windows bräuchte einen direkten Win32-`PrintWindow`-Bypass; der
  Aufwand ist gegenüber dem Linux+Xvfb-Pfad nicht gerechtfertigt.

## E2E-Test-Suite

Vollständige UI-Coverage in `tests/e2e/` (21 Szenarien, Python +
Pillow): Boot, View-/Edit-/Split-Mode, Theme, Vault, Find, Workspace,
Save-Roundtrip durch alle BOM/EOL-Kombis, Undo/Redo, Toolbar-Commands
(Bold/Italic/Heading), Menü-Coverage (File/Edit/View/Help), DOM-
Keybindings, Vault-Tree-Klicks, Pin/Unpin, History-Back/Forward,
Rechtsklick-Kontextmenüs, echter TOC-DOM-Klick.

Wrapper: `bash scripts/run-e2e.sh` (Linux+Xvfb). Visual-Baselines in
`tests/e2e/baselines/`, Artefakte (gitignored) in
`tests/e2e/artifacts/<timestamp>/`. Bei fehlender Baseline wird sie beim
ersten Run automatisch angelegt.

Xvfb-spezifische Eigenheiten (scrollY-Sync, Monaco-Canvas-Capture,
synthetic-keyboard-Fragilität bei Monaco-Shortcuts, native Tauri-Menüs
aus WebView unerreichbar, `alert()`-Blockade, `applyReplace`/
`history`-Historie der Bugfixes etc.) sind in
[`docs/e2e-headless-caveats.md`](docs/e2e-headless-caveats.md)
zusammengefasst — Pflichtlektüre vor dem Schreiben neuer Szenarien.

Szenarien können `DESKTOP_ONLY = True` als Modul-Konstante exportieren;
der Orchestrator skipt sie standardmäßig, `--include-desktop-only`
schaltet sie ein. Heute hat kein Szenario den Marker — die Infrastruktur
ist Vorhaltung für zukünftige Dialog-/OS-Eingang-Tests.

## GitHub

Remote: `ralfkuh-lab/folio`.
