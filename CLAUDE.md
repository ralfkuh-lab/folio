# CLAUDE.md

## Projekt

**folio** — Markdown-Viewer/-Editor auf Tauri 2 + Rust. Live-Vorschau,
Vault-Navigation, Workspace-Pins, HTTP-Automation-API für E2E-Tests.

Offene Aufgaben werden in [`TODO.md`](TODO.md) gepflegt (priorisiert: hoch /
mittel / niedrig). Vor Vorschlägen, was als nächstes ansteht, dort nachsehen.

## Tech-Stack

- Rust 2021, Tauri 2
- comrak 0.35 (GFM-Markdown)
- axum 0.8 (Automation-API auf `127.0.0.1:9876`, Loopback-only, CORS für WebView-POSTs)
- Vanilla TypeScript Frontend in `src-tauri/dist/`
- notify 7.0 (File-Watching), xcap (Screenshots)

## Build & Test

Cargo-Befehle aus `src-tauri/`:

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo tauri build      # Linux: braucht libwebkit2gtk-4.1-dev
```

Frontend-Assets vor `cargo tauri build` bauen: `cd src-tauri/dist && npm install && npm run build`.

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

## GitHub

Remote: `ralfkuh-lab/folio`.
