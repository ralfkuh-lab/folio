# Folio

Plattformübergreifender Markdown-Viewer und -Editor auf **Tauri 2 + Rust**.

## Features

- **Live-Vorschau** mit GitHub-Flavored Markdown (Tasklisten, Tabellen, Frontmatter)
- **Split-View-Editor** mit Syntax-Highlighting und WYSIWYG-Shortcuts
- **Vault-Navigation** mit Ordnerbaum, Workspace-Pins und Recent-Dateien
- **Dateityp-bewusste Toolbar**: Markdown-spezifische Buttons und TOC-Rail
  blenden sich für Nicht-Markdown-Dateien automatisch aus
- **Browser-artige History** mit Zurück/Vorwärts: stellt View/Edit-Mode,
  Scroll-Position und Cursor pro Eintrag wieder her
- **Automatisierungs-API** für E2E-Tests (HTTP auf `127.0.0.1:9876`)
- **Cross-Platform** dank Tauri 2 (WebView2 / WebKitGTK)

## Tech-Stack

| Komponente | Technologie |
|---|---|
| Backend | Rust 2021, Tauri 2 |
| Markdown-Engine | comrak 0.35 |
| Frontend | Vanilla TypeScript, Monaco Editor |
| HTTP-API | axum 0.8 |
| Screenshots | xcap |
| File-Watching | notify 7.0 |

## Projektstruktur

```
folio/
├── src-tauri/
│   ├── src/                     # Rust-Backend
│   │   └── commands/            # Tauri-IPC-Commands
│   ├── tests/                   # Unit- und Integration-Tests
│   ├── web/                     # Editor-Bundle-Quellen (editor.ts, package.json,
│   │                            #   copy-monaco.js)
│   ├── dist/                    # Ausgelieferte Frontend-Assets (index.html,
│   │                            #   editor.bundle.js, monaco/)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── scripts/                     # Linux-Helper (Icon-Install)
├── test-docs/                   # Beispiel-Markdown für manuelle Tests
├── CLAUDE.md
└── README.md
```

## Build

### Voraussetzungen

- [Rust](https://rustup.rs/) 1.75+
- [Node.js](https://nodejs.org/) 18+ (nur, wenn `editor.ts` geändert wird —
  `editor.bundle.js` ist eingecheckt)
- Linux: `libwebkit2gtk-4.1-dev`
- Tauri-CLI: `cargo install tauri-cli`

### Editor-Bundle (Monaco Editor)

Nur nötig nach Änderungen an `src-tauri/web/editor.ts`:

```bash
cd src-tauri/web
npm install                # einmalig bzw. nach package.json-Änderung
npm run build              # kopiert Monaco-Assets nach ../dist/monaco/
                           # und bündelt ../dist/editor.bundle.js
```

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
```

## Automation-API

Loopback-HTTP-Server auf `127.0.0.1:9876` für E2E-Tests:

| Route | Methode | Beschreibung |
|---|---|---|
| `/state` | GET | Aktueller App-Zustand |
| `/screenshot` | GET | PNG-Screenshot |
| `/open` | POST | Datei öffnen (Backend-Pfad, setzt Vault-Active) |
| `/open-ui` | POST | Datei via UI-Flow öffnen (Dirty-Check etc.) |
| `/mode` | POST | ViewMode setzen |
| `/theme` | POST | Theme setzen |
| `/rail` | POST | Rail-Sichtbarkeit |
| `/click` | POST | Element klicken (ID, `data-name`, CSS-Selector) |
| `/toc/activate` | POST | TOC-Eintrag aktivieren |
| `/focus` | POST | Fenster fokussieren |
| `/find` | POST | Find-Dialog öffnen |
| `/find/text` | POST | Suchbegriff setzen |
| `/editor/text` | POST | Editor-Inhalt setzen |
| `/resize` | POST | Fenstergröße ändern |
| `/save` | POST | Speichern |
| `/quit` | POST | App beenden |

CORS/OPTIONS-Preflight ist aktiv, damit Toolbar/Statusbar aus der WebView dieselben
Endpunkte nutzen wie externe Tests.

## Lizenz

MIT — siehe [LICENSE](LICENSE), falls vorhanden.
