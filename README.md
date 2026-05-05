# Folio RS

Plattformübergreifender Markdown-Viewer und Editor, portiert von WPF/.NET auf **Tauri 2 + Rust**.

## Überblick

Folio RS ist eine vollständige Neuimplementierung der [Folio](https://github.com/fsrakul/Folio)-App für Windows, Linux und macOS. Die App bietet:

- **Live-Vorschau** von Markdown mit GitHub-Flavored Markdown (GFM), Tasklisten, Tabellen und Frontmatter
- **Split-View-Editor** mit Syntax-Highlighting und WYSIWYG-Shortcuts
- **Datei-Navigation** mit Ordnerbaum (Vault), Workspace-Pins und Recent-Dateien
- **Automatisierungs-API** für End-to-End-Tests (HTTP-Server auf Port 9876, inkl. WebView-CORS/Preflight)
- **Cross-Platform** dank Tauri 2 und WebView2/WebKitGTK

## Tech-Stack

| Komponente | Technologie |
|---|---|
| Backend | Rust 2021, Tauri 2 |
| Markdown-Engine | comrak 0.35 (GFM, Tasklisten, Tabellen) |
| Frontend | Vanilla TypeScript, Tauri IPC |
| HTTP-API | axum 0.8 |
| Screenshots | xcap |
| File-Watching | notify 7.0 |

## Projektstruktur

```
folio-rs/
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs              # Tauri-App-Setup, Event-Handler
│   │   ├── main.rs             # Binary-Einstiegspunkt
│   │   ├── automation.rs       # axum HTTP-API für Tests
│   │   ├── document_store.rs   # Datei-Laden, Speichern, Watcher
│   │   ├── editor_commands.rs  # Markdown-Editor-Commands (Bold, Italic, etc.)
│   │   ├── file_resolver.rs    # Relatives/absolute Pfad-Auflösung
│   │   ├── frontmatter.rs      # YAML-Frontmatter-Extraktion
│   │   ├── heading_anchor.rs   # Slug-Generierung für Überschriften
│   │   ├── link_interceptor.rs # Link-Klick-Handling (extern vs. intern)
│   │   ├── navigation.rs       # Vor/Zurück-History mit Scroll-Positionen
│   │   ├── panel_state.rs      # UI-Panel-Zustand (Rails, Sektionen)
│   │   ├── renderer.rs         # Markdown → HTML (comrak + Postprocess)
│   │   ├── state.rs            # AppState (DocumentStore, Workspace, etc.)
│   │   ├── text_statistics.rs  # Zeichen-/Wort-/Zeilenzählung
│   │   ├── toc.rs              # Table-of-Contents-Extraktion und HTML
│   │   ├── vault.rs            # Ordnerbaum-Logik
│   │   ├── workspace.rs        # Recent-Dateien, Pins
│   │   └── commands/           # Tauri-Commands
│   │       ├── app.rs          # pick_folder, pick_file, open_folder
│   │       ├── editor.rs       # editor_text_changed, editor_ready, etc.
│   │       ├── file.rs         # read_file, write_file, file_list
│   │       ├── nav.rs          # navigate, go_back, go_forward, etc.
│   │       ├── shell.rs        # Shell/Event-Routing
│   │       ├── vault_cmd.rs    # Vault-Tree-Commands
│   │       └── workspace_cmd.rs # Workspace-Commands
│   ├── tests/
│   │   ├── goldfile_diff.rs    # Goldfile-Diffs (3 Tests)
│   │   ├── integration_editor.rs
│   │   ├── integration_file.rs
│   │   ├── integration_nav.rs
│   │   ├── integration_pipeline.rs
│   │   └── smoke_automation.rs
│   ├── dist/                   # Frontend-Assets (HTML, JS, CSS)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── goldfiles/                  # Goldfile-Fixtures für Regression-Tests
├── tools/goldfile-gen/         # C# Goldfile-Generator
└── MIGRATION_LOG.md            # Detaillierte Migrations-Dokumentation
```

## Build

### Voraussetzungen

- [Rust](https://rustup.rs/) 1.75+
- [Node.js](https://nodejs.org/) 18+ (für Tauri-Build)
- Linux: `libwebkit2gtk-4.1-dev` (Debian/Ubuntu) oder äquivalent

### Schritte

```bash
# 1. Repo klonen
git clone https://github.com/ralfkuh-lab/folio-rs.git
cd folio-rs

# 2. Tauri-CLI installieren (falls nicht vorhanden)
cargo install tauri-cli

# 3. Frontend-Assets bauen
cd src-tauri/dist
npm install
npm run build
cd ../..

# 4. Tauri-App bauen
cd src-tauri
cargo tauri build

# 5. Tests ausführen
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Testabdeckung

- **121 Tests total**
  - 96 Unit-Tests (Renderer, TOC, Frontmatter, Editor-Commands, Navigation, FileResolver, Workspace, Vault, PanelState)
  - 3 Goldfile-Regressionstests
  - 22 Integration/Smoke-Tests (Navigation, Editor, Pipeline, File-Operations, Automation-API)

## Automation-API

Für End-to-End-Tests läuft ein HTTP-Server auf `127.0.0.1:9876` (Loopback-only):

| Route | Methode | Beschreibung |
|---|---|---|
| `/state` | GET | Aktueller App-Zustand |
| `/screenshot` | GET | PNG-Screenshot |
| `/open` | POST | Datei öffnen |
| `/mode` | POST | ViewMode setzen |
| `/theme` | POST | Theme setzen |
| `/rail` | POST | Rail sichtbarkeit |
| `/click` | POST | Element klicken |
| `/toc/activate` | POST | TOC-Eintrag aktivieren |
| `/focus` | POST | Fenster fokussieren |
| `/find` | POST | Find-Dialog öffnen |
| `/find/text` | POST | Suchbegriff setzen |
| `/resize` | POST | Fenstergröße ändern |
| `/save` | POST | Speichern |
| `/quit` | POST | App beenden |

Die API akzeptiert `OPTIONS`-Preflight-Requests und setzt CORS-Header, damit Toolbar- und
Statusbar-Aktionen aus der Tauri-WebView heraus dieselben JSON-POST-Endpunkte verwenden
können wie externe E2E-Tests.

## Migration

Detaillierte Migrations-Dokumentation in [MIGRATION_LOG.md](MIGRATION_LOG.md).

## Lizenz

MIT — siehe [LICENSE](LICENSE) (wenn vorhanden).
