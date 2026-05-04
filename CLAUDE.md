# CLAUDE.md

## Projektkontext

**folio-rs** ist eine frische Portierung der WPF/.NET-App [Folio](https://github.com/fsrakul/Folio)
auf **Tauri 2 + Rust**. Markdown-Viewer/-Editor mit Live-Vorschau, Vault-Navigation,
Workspace-Pins und HTTP-Automation-API für E2E-Tests.

Migration ist abgeschlossen (Phasen 0–7, siehe `MIGRATION_LOG.md`). Codebase ist jung —
beim Lesen/Ändern bitte beachten, dass viele Module 1:1-Ports von C#-Services sind
(siehe Mapping in `MIGRATION_LOG.md`, z. B. `MarkdownRenderer` → `renderer.rs`).

## Tech-Stack

- Rust 2021, Tauri 2 (Backend)
- comrak 0.35 für GFM-Markdown
- axum 0.8 für Automation-HTTP-API (Loopback `127.0.0.1:9876`)
- Vanilla TypeScript Frontend (in `src-tauri/dist/`)
- notify 7.0 für File-Watching, xcap für Screenshots

## Verzeichnisstruktur (Kurz)

- `src-tauri/src/` — Rust-Backend, ein Modul pro ehemaligem C#-Service
- `src-tauri/src/commands/` — Tauri-IPC-Commands (`app`, `editor`, `file`, `nav`, `shell`,
  `vault_cmd`, `workspace_cmd`)
- `src-tauri/dist/` — Frontend-Assets (HTML/TS/CSS), 1:1 aus dem WPF-Resources-Ordner übernommen
- `src-tauri/tests/` — Integration, Smoke, Goldfile-Diffs
- `goldfiles/expected/` — HTML-Fixtures aus dem C#-Generator (`tools/goldfile-gen/`),
  dienen als Regressionsanker für Pipeline-Parität
- `MIGRATION_LOG.md` — Phasen-Doku inkl. Service-Mapping, Risiken, Entscheidungen

## Build & Test

Arbeitsverzeichnis für Cargo-Befehle: `src-tauri/`.

```bash
cd src-tauri
cargo build                              # Dev-Build (~2–3 min initial)
cargo test                               # 120 Tests (Unit + Goldfile + Integration)
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo tauri build                        # Release-Bundle (Linux: braucht libwebkit2gtk-4.1-dev)
```

Frontend-Assets (in `src-tauri/dist/`) werden via `npm install && npm run build` gebaut,
bevor `cargo tauri build` läuft.

## Konventionen / Hinweise für Änderungen

- **Goldfiles sind heilig**: Renderer-Output muss byte-genau zu `goldfiles/expected/*.html`
  passen. Bei beabsichtigten Änderungen Goldfiles über `tools/goldfile-gen` neu erzeugen
  und Diff bewusst commiten.
- **Slugifier**: comrak-Default wird bewusst nicht benutzt — eigener Slugifier in
  `heading_anchor.rs` repliziert Markdig-`AutoIdentifier`. Nicht ohne Goldfile-Update ändern.
- **AST-Postprocess** in `renderer.rs` ersetzt das fehlende `GenericAttributes`-Feature
  von Markdig.
- **CRLF/LF/BOM**: Roundtrip-Erhalt ist getestet (`document_store.rs`). Beim Schreiben
  immer Original-Encoding/Line-Endings beibehalten.
- **IPC-Payloads**: Große Payloads (gerendertes HTML) gehen über Tauri-Events, nicht über
  Command-Returns.
- **Automation-API**: nur Loopback. Keine externen Bind-Adressen einführen.

## GitHub

- Remote: `ralfkuh-lab/folio-rs` (privat-Account von Ralf)
- Source-Repo (Original WPF): `fsrakul/Folio`
