# Folio

Plattformübergreifender Markdown-Viewer und -Editor auf **Tauri 2 + Rust**.

## Features

- **Drei Modi** (View / Edit / Split via Ctrl+1/2/3) — im Split-Mode
  Editor links, Live-Vorschau rechts; ungespeicherte Änderungen sind
  sofort sichtbar, ohne Save
- **Live-Vorschau** mit GitHub-Flavored Markdown (Tasklisten, Tabellen, Frontmatter)
- **Multi-Datei-Tabs** mit Session-Restore, Drag-Reorder und
  Ctrl-/Mittelklick-Öffnen; Undo-Stack überlebt den Tab-Wechsel
- **WYSIWYG-Toolbar** mit Bold/Italic/Heading/Listen/Link/Tabellen + Cheat-Sheet
- **Vault-Navigation** mit Ordnerbaum, Workspace-Pins (sortierbar per
  Drag), Recent-Dateien und Gitignore-Dimming
- **Theme-System**: View-Themes und Export-Layouts mit In-App-Theme-Editor
  (Live-Preview), Custom-Themes als Verzeichnis-Pakete inkl. Fonts/Logos,
  `.mdtheme`-Import/Export und KI-Theme-Autor
- **HTML-/PDF-Export** mit Deckblatt, Kopf-/Fußzeilen,
  Frontmatter-Template-Variablen und syntect-Code-Highlighting
- **Mermaid-Diagramme** in der Vorschau und im Export
- **Dateityp-bewusste Toolbar**: Markdown-spezifische Buttons und TOC-Rail
  blenden sich für Nicht-Markdown-Dateien automatisch aus
- **Mehrere Vorschau-Pfade**: Markdown (HTML-Render), Code/Text
  (Read-Only-Monaco mit Syntax-Highlighting), HTML (Sandbox-iframe mit
  Link-Routing) und Bilder (PNG/JPG/GIF/WebP/SVG/BMP/ICO/AVIF,
  zentriert und proportional skaliert)
- **Browser-artige History** mit Zurück/Vorwärts: stellt View/Edit-Mode,
  Scroll-Position und Cursor pro Eintrag wieder her
- **Toggle-Bare Editor-Minimap** (Monaco-Übersicht am rechten Editor-Rand),
  persistiert pro App-Profil
- **Automatisierungs-API** für E2E-Tests (HTTP auf `127.0.0.1:9876`)
- **KI-Integration nach opencode-Muster** mit models.dev-Katalog,
  getrennt gespeicherten Provider-Schlüsseln und Markdown-Übersetzung in
  eine oder mehrere neue Dateien (Code-Fragmente deterministisch maskiert)
- **E2E-Test-Suite** mit 44 Szenarien, visueller Regression und auto-
  angelegten Baselines — siehe Abschnitt *Tests*
- **Cross-Platform** dank Tauri 2 (WebView2 / WebKitGTK)

## Tech-Stack

| Komponente | Technologie |
|---|---|
| Backend | Rust 2021, Tauri 2 |
| Markdown-Engine | comrak 0.35 |
| Frontend | Vanilla TypeScript, Monaco Editor |
| HTTP-API | axum 0.8 |
| Screenshots | tauri-plugin-screenshots 2.2 (Monitor-Capture) |
| File-Watching | notify 7.0 |

## Projektstruktur

```
folio/
├── src-tauri/
│   ├── src/                     # Rust-Backend (commands/, automation/, menu/, …)
│   ├── tests/                   # Unit- und Integration-Tests
│   ├── web/                     # TypeScript-Quellen
│   │   ├── app/                 #   App-Module (state, view, vault, ui,
│   │   │                        #   editor-Shell, automation-Bridge)
│   │   ├── editor/              #   Monaco-Adapter (mount, text, find, …)
│   │   ├── styles/              #   CSS-Quellen
│   │   ├── tests/               #   Vitest (jsdom)
│   │   ├── globals.d.ts         #   Cross-Bundle-Window-Surface
│   │   ├── package.json
│   │   └── copy-monaco.js       #   Monaco-Vendor-Sync nach dist/monaco/
│   ├── dist/                    # Ausgelieferte Frontend-Assets
│   │                            #   (index.html, app.bundle.js, app.css,
│   │                            #    editor.bundle.js, mermaid.bundle.js,
│   │                            #    monaco/)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── tests/e2e/                   # Python + Pillow E2E-Suite (44 Szenarien)
├── docs/                        # E2E, Automation-Vertrag, Release,
│                                #   Headless-Caveats, Linux-MD-Icon
├── scripts/                     # Linux-Helper (Icon-Install, run-e2e.sh)
├── CLAUDE.md
└── README.md
```

## Installation

Fertige Installer gibt es auf der
[Releases-Seite](https://github.com/ralfkuh-lab/folio/releases):

| Plattform | Datei |
|---|---|
| macOS | `Folio_<version>_x64.dmg` |
| Windows | `Folio_<version>_x64-setup.exe` oder `.msi` |
| Linux (Debian/Ubuntu) | `Folio_<version>_amd64.deb` |
| Linux (Fedora/openSUSE) | `Folio-<version>-1.x86_64.rpm` |
| Linux (portabel) | `Folio_<version>_amd64.AppImage` |

### macOS: Gatekeeper-Hinweis

Die macOS-Builds sind **ad-hoc-signiert und nicht notarisiert** (kein
Apple-Developer-Programm). Beim ersten Start blockiert Gatekeeper die App
mit „Folio ist beschädigt" bzw. „kann nicht überprüft werden". Workaround —
eine der beiden Varianten:

- Rechtsklick auf `Folio.app` → **Öffnen** → Dialog mit **Öffnen** bestätigen, oder
- Quarantäne-Flag entfernen:

  ```bash
  xattr -d com.apple.quarantine /Applications/Folio.app
  ```

Das ist nur beim ersten Start nötig. Windows zeigt aus demselben Grund
(unsignierter Installer) eine SmartScreen-Warnung — über „Weitere
Informationen" → „Trotzdem ausführen" fortfahren.

## Build

### Voraussetzungen

- [Rust](https://rustup.rs/) 1.80+
- [Node.js](https://nodejs.org/) 18+ (nur, wenn Frontend-TS geändert wird —
  Bundles in `src-tauri/dist/` sind eingecheckt)
- Linux: `libwebkit2gtk-4.1-dev`
- Tauri-CLI: `cargo install tauri-cli`

### Frontend-Bundles

Nur nötig nach Änderungen in `src-tauri/web/` (Editor- oder App-Module,
Styles). Eingecheckte Bundles unter `src-tauri/dist/` werden vom
Tauri-Build verwendet.

```bash
cd src-tauri/web
npm install                # einmalig bzw. nach package.json-Änderung
npm run build              # copy-monaco → tsc --noEmit (Typecheck) →
                           # editor.bundle.js → app.bundle.js →
                           # mermaid.bundle.js → app.css
```

Reihenfolge im Build-Script ist wichtig: `editor.bundle.js` wird vor
`app.bundle.js` geladen (Surface `window.FolioEditor`).

### Entwicklung

```bash
cd src-tauri
cargo build                # Debug-Binary unter target/debug/folio
cargo run                  # baut + startet
cargo tauri dev            # mit Hot-Reload-Setup
```

### Release-Pakete

`cargo tauri build` erzeugt auf Linux DEB, RPM und AppImage in einem Rutsch:

```bash
cd src-tauri
cargo build --release          # nur das Release-Binary
cargo tauri build              # Release-Binary + alle Bundle-Targets
cargo tauri build --bundles deb       # nur DEB
cargo tauri build --bundles rpm       # nur RPM
cargo tauri build --bundles appimage  # nur AppImage
```

Output:

```
src-tauri/target/release/
├── folio                                                # Standalone-Binary
└── bundle/
    ├── deb/Folio_<version>_amd64.deb
    ├── rpm/Folio-<version>-1.x86_64.rpm
    └── appimage/Folio_<version>_amd64.AppImage
```

### Linux: .md-Icon im Datei-Manager

Optional, läuft ohne `sudo` (nur User-Profile, `XDG_DATA_HOME`):

```bash
scripts/install-folio-icons.sh
```

Hintergrund: [`docs/linux-md-icon.md`](docs/linux-md-icon.md).

### Tests & Lint

```bash
cd src-tauri
cargo test                                # Unit + Integration
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cd web && npm test                        # Vitest (jsdom) für app/editor-Module
```

### E2E-Suite

Headless unter Linux+Xvfb. Wrapper startet Xvfb + Folio + Suite und
räumt anschließend auf:

```bash
bash scripts/run-e2e.sh
```

Visual-Baselines liegen in `tests/e2e/baselines/`. Beim ersten Run eines
neuen Szenarios wird die Baseline automatisch angelegt; ab dem zweiten
Run wird gegen sie geprüft. Run-Artefakte (Reports, Screenshots, Diffs)
landen in `tests/e2e/artifacts/<timestamp>/` und sind gitignored.

Xvfb-spezifische Caveats (scrollY-Sync, native Menüs, Monaco-Shortcut-
Fragilität, …) sind in
[`docs/e2e-headless-caveats.md`](docs/e2e-headless-caveats.md)
gesammelt — Pflichtlektüre für neue Szenarien.

## Automation-API

Loopback-HTTP-Server auf `127.0.0.1:9876` für E2E-Tests. Im Release-Build
startet er nur mit gesetzter Env-Var `FOLIO_AUTOMATION=1` (Debug-Builds:
immer an); die E2E-Wrapper setzen sie automatisch. Host- und Origin-Header
werden gegen Allowlists geprüft (Details:
[`docs/automation-contract.md`](docs/automation-contract.md)).

| Route | Methode | Beschreibung |
|---|---|---|
| `/state` | GET | Aktueller App-Zustand inkl. TOC, Workspace, Scroll |
| `/screenshot` | GET | PNG-Screenshot (Monitor-Capture für Monaco-Canvas) |
| `/dom` | GET | DOM-Snapshot zu CSS-Selektor (exists, attrs, innerHTML) |
| `/console/errors` | GET | Per Frontend-Hook gesammelte Console-Errors |
| `/settings` | GET / POST | App-Settings vollständig lesen / partiell aktualisieren |
| `/editor/text` | GET / POST | Editor-Inhalt lesen / setzen |
| `/open` | POST | Datei öffnen (Backend-Pfad) |
| `/open-ui` | POST | Datei via UI-Flow öffnen (Dirty-Check etc.) |
| `/mode` | POST | ViewMode setzen (view / edit / split, mit Ack) |
| `/theme` | POST | Theme setzen (light / dark / toggle) |
| `/rail` | POST | Rail-Sichtbarkeit (left / right) |
| `/split` | POST | Split-Teiler setzen (20–80 %, mit Ack) |
| `/click` | POST | Element klicken (ID, `data-name`, CSS-Selector, mit Ack) |
| `/rightclick` | POST | Rechtsklick mit optionalen Koords |
| `/key` | POST | Synthetischer KeyboardEvent (target document/editor, mit Ack) |
| `/toc/activate` | POST | TOC-Eintrag aktivieren (synthetisches navigation:toc_click) |
| `/menu/click` | POST | Native Menü-Item synthetisch klicken |
| `/editor/command` | POST | Monaco-Adapter-Methode rufen (undo, redo, insertText, …) |
| `/editor/selection` | POST | Editor-Selection setzen (mit Ack) |
| `/workspace/pin` / `/workspace/unpin` | POST | Pfad pinnen / unpinnen |
| `/tabs` | GET | Tab-Leiste (IDs, Pfade, aktiver Tab) |
| `/tabs/open` / `/tabs/close` / `/tabs/activate` / `/tabs/close_all` / `/tabs/reorder` | POST | Tab-Operationen |
| `/history/back` / `/history/forward` | POST | Navigation, am Stack-Edge moved:false |
| `/find` / `/find/text` | POST | Find-Bar öffnen / Suchbegriff setzen (auto-open) |
| `/eval` | POST | JS im WebView ausführen, Ergebnis zurückliefern |
| `/sync/render` | POST | Render-Roundtrip vor Screenshots (mit Ack) |
| `/focus` | POST | Fenster fokussieren |
| `/resize` | POST | Fenstergröße ändern |
| `/save` | POST | Speichern (DocumentStore-Roundtrip mit Encoding-Treue) |
| `/wait` | POST | Auf Backend-Event warten (`editor.ready`, `document.saved`, …) |
| `/quit` | POST | App beenden |

Ack-fähige Endpoints liefern `{ ok, acked, requestId }` — das Frontend
ruft nach Microtask + RAF ein `automation_ack`, damit Tests deterministisch
auf das Ende einer DOM-Mutation warten können. CORS/OPTIONS-Preflight ist
aktiv, damit Toolbar/Statusbar aus der WebView dieselben Endpunkte nutzen
wie externe Tests.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
