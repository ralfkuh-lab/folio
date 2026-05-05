# Folio RS

Plattformübergreifender Markdown-Viewer und -Editor auf **Tauri 2 + Rust**.

## Features

- **Live-Vorschau** mit GitHub-Flavored Markdown (Tasklisten, Tabellen, Frontmatter)
- **Split-View-Editor** mit Syntax-Highlighting und WYSIWYG-Shortcuts
- **Vault-Navigation** mit Ordnerbaum, Workspace-Pins und Recent-Dateien
- **Automatisierungs-API** für E2E-Tests (HTTP auf `127.0.0.1:9876`)
- **Cross-Platform** dank Tauri 2 (WebView2 / WebKitGTK)

## Tech-Stack

| Komponente | Technologie |
|---|---|
| Backend | Rust 2021, Tauri 2 |
| Markdown-Engine | comrak 0.35 |
| Frontend | Vanilla TypeScript |
| HTTP-API | axum 0.8 |
| Screenshots | xcap |
| File-Watching | notify 7.0 |

## Projektstruktur

```
folio-rs/
├── src-tauri/
│   ├── src/                     # Rust-Backend
│   │   └── commands/            # Tauri-IPC-Commands
│   ├── tests/                   # Unit-, Integration-, Goldfile-Tests
│   ├── dist/                    # Frontend-Assets (HTML/TS/CSS)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── goldfiles/expected/          # Renderer-Regressionsfixtures
├── test-docs/                   # Beispiel-Markdown für manuelle Tests
├── CLAUDE.md
└── README.md
```

## Build

### Voraussetzungen

- [Rust](https://rustup.rs/) 1.75+
- [Node.js](https://nodejs.org/) 18+
- Linux: `libwebkit2gtk-4.1-dev`

### Schritte

```bash
git clone https://github.com/ralfkuh-lab/folio-rs.git
cd folio-rs

cargo install tauri-cli

cd src-tauri/dist && npm install && npm run build && cd ..

cargo tauri build      # Release-Bundle
# oder:
cargo tauri dev        # Entwicklung
```

### Tests

```bash
cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Automation-API

Loopback-HTTP-Server auf `127.0.0.1:9876` für E2E-Tests:

| Route | Methode | Beschreibung |
|---|---|---|
| `/state` | GET | Aktueller App-Zustand |
| `/screenshot` | GET | PNG-Screenshot |
| `/open` | POST | Datei öffnen |
| `/mode` | POST | ViewMode setzen |
| `/theme` | POST | Theme setzen |
| `/rail` | POST | Rail-Sichtbarkeit |
| `/click` | POST | Element klicken (ID, `data-name`, CSS-Selector) |
| `/toc/activate` | POST | TOC-Eintrag aktivieren |
| `/focus` | POST | Fenster fokussieren |
| `/find` | POST | Find-Dialog öffnen |
| `/find/text` | POST | Suchbegriff setzen |
| `/resize` | POST | Fenstergröße ändern |
| `/save` | POST | Speichern |
| `/quit` | POST | App beenden |

CORS/OPTIONS-Preflight ist aktiv, damit Toolbar/Statusbar aus der WebView dieselben
Endpunkte nutzen wie externe Tests.

## Lizenz

MIT — siehe [LICENSE](LICENSE), falls vorhanden.
