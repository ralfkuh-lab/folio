# Folio

Plattformübergreifender Markdown-Viewer und -Editor auf **Tauri 2 + Rust**.

## Features

- **Live-Vorschau** mit GitHub-Flavored Markdown (Tasklisten, Tabellen, Frontmatter)
- **Split-View-Editor** mit Syntax-Highlighting und WYSIWYG-Shortcuts
- **Vault-Navigation** mit Ordnerbaum, Workspace-Pins und Recent-Dateien
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
- **E2E-Test-Suite** mit 22 Szenarien, visueller Regression und auto-
  rotiertem Baseline-Mechanismus — siehe Abschnitt *Tests*
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
│   │                            #    editor.bundle.js, monaco/)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── tests/e2e/                   # Python + Pillow E2E-Suite (22 Szenarien)
├── docs/                        # E2E, Automation-Vertrag, Release,
│                                #   Headless-Caveats, Linux-MD-Icon
├── scripts/                     # Linux-Helper (Icon-Install, run-e2e.sh)
├── CLAUDE.md
└── README.md
```

## Build

### Voraussetzungen

- [Rust](https://rustup.rs/) 1.75+
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
npm run build              # tsc --noEmit (Typecheck) → copy-monaco →
                           # editor.bundle.js → app.bundle.js → app.css
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

Loopback-HTTP-Server auf `127.0.0.1:9876` für E2E-Tests:

| Route | Methode | Beschreibung |
|---|---|---|
| `/state` | GET | Aktueller App-Zustand inkl. TOC, Workspace, Scroll |
| `/screenshot` | GET | PNG-Screenshot (Monitor-Capture für Monaco-Canvas) |
| `/dom` | GET | DOM-Snapshot zu CSS-Selektor (exists, attrs, innerHTML) |
| `/console/errors` | GET | Per Frontend-Hook gesammelte Console-Errors |
| `/editor/text` | GET / POST | Editor-Inhalt lesen / setzen |
| `/open` | POST | Datei öffnen (Backend-Pfad) |
| `/open-ui` | POST | Datei via UI-Flow öffnen (Dirty-Check etc.) |
| `/mode` | POST | ViewMode setzen (view / edit / split, mit Ack) |
| `/theme` | POST | Theme setzen (light / dark / toggle) |
| `/rail` | POST | Rail-Sichtbarkeit (left / right) |
| `/click` | POST | Element klicken (ID, `data-name`, CSS-Selector, mit Ack) |
| `/rightclick` | POST | Rechtsklick mit optionalen Koords |
| `/key` | POST | Synthetischer KeyboardEvent (target document/editor, mit Ack) |
| `/toc/activate` | POST | TOC-Eintrag aktivieren (synthetisches navigation:toc_click) |
| `/menu/click` | POST | Native Menü-Item synthetisch klicken |
| `/editor/command` | POST | Monaco-Adapter-Methode rufen (undo, redo, insertText, …) |
| `/editor/selection` | POST | Editor-Selection setzen (mit Ack) |
| `/workspace/pin` / `/workspace/unpin` | POST | Pfad pinnen / unpinnen |
| `/history/back` / `/history/forward` | POST | Navigation, am Stack-Edge moved:false |
| `/find` / `/find/text` | POST | Find-Bar öffnen / Suchbegriff setzen |
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

MIT — siehe [LICENSE](LICENSE), falls vorhanden.
