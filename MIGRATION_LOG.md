# Migration Log: Folio → folio-rs

## Phase 0 — Inventory & Planning
Status: completed
Komplexität: S
Start: 2026-05-04T14:00Z
End: 2026-05-04T15:00Z

### Tasks
- [x] T0.1 Source-Repo clonen (fsrakul/Folio) — hermes
- [x] T0.2 Target-Repo anlegen (ralfkuh-lab/folio-rs) — hermes
- [x] T0.3 Tool-Setup: Rust, Node, .NET, gh, clippy, rustfmt — hermes
- [x] T0.4 Source-Code inventarisieren: 12 Services, ~2043 Zeilen Tests — hermes
- [x] T0.5 Test-Fixtures katalogisieren (index.md, frontmatter-example.md, large-document.md) — hermes
- [x] T0.6 Goldfile-Generator aufsetzen und Goldfiles erzeugen — hermes
- [x] T0.7 MIGRATION_LOG.md + tasks.json initialisieren — hermes

### Inventory Summary

**Services (C# → Rust):**
| C# Service | Lines | Rust Ziel |
|---|---|---|
| MarkdownRenderer | 168 | `renderer.rs` |
| MarkdownPipelineFactory | 12 | `renderer.rs` (comrak setup) |
| FrontmatterExtractor | 108 | `frontmatter.rs` |
| TocExtractor | 144 | `toc.rs` |
| HeadingAnchorPreprocessor | 42 | `heading_anchor.rs` |
| DocumentStore | 188 | `document_store.rs` |
| FileResolver | 61 | `file_resolver.rs` |
| TextStatistics | 15 | `text_statistics.rs` |
| MarkdownEditorCommands | 349 | `editor_commands.rs` |
| NavigationController | 60 | `navigation.rs` |
| WorkspaceService | 128 | `workspace.rs` |
| ThemeService | 116 | `theme.rs` |
| PanelStateService | 80 | `panel_state.rs` |
| VaultViewModel | 234 | `vault.rs` |
| ViewModeController | 26 | `view_mode.rs` |
| LinkInterceptor | 74 | `link_interceptor.rs` |
| ShellBridge | 75 | `shell_bridge.rs` |
| AutomationServer | 325 | `automation.rs` |
| WebViewBridge | 200 | Phase 4: Tauri Command/Event-System |

**Tests:** 120 Tests (96 unit + 3 goldfile + 21 integration/smoke). Alle passing.

**Frontend-Assets (verbatim übernommen):**
- `src/Folio/web/src/editor.ts` → `dist/editor.ts`
- `src/Folio/Resources/shell-template.html` → `dist/index.html`

**Goldfiles (nur Pipeline-Ausgabe):**
- `goldfiles/expected/index.html` (1.851 bytes, 53 lines)
- `goldfiles/expected/frontmatter-example.html` (1.122 bytes, 15 lines)
- `goldfiles/expected/large-document.html` (164.941 bytes, 2.282 lines)

### Risikoeinschätzung

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| comrak hat kein GenericAttributes-Äquivalent | Hoch | Mittel | AST-Postprocess implementiert ✓ |
| comrak Slugifier vs. Markdig AutoIdentifier | Hoch | Hoch | Eigener Slugifier statt comrak-Default ✓ |
| CSS Custom Highlight API nicht in WebKitGTK | Mittel | Hoch | Fallback dokumentiert |
| IPC-Payload-Größe (Tauri) | Mittel | Mittel | Events für große Payloads ✓ |
| CRLF/LF/BOM-Roundtrip | Niedrig | Hoch | Dokumentation + Tests ✓ |
| Screenshot cross-platform | Mittel | Niedrig | `xcap` als Default ✓ |

### Phasenplan

| Phase | Thema | Komplexität | Status |
|---|---|---|---|
| 0 | Inventory & Planning | S | **completed** |
| 1 | Markdown-Pipeline-Parität | L | **completed** |
| 2 | Pure-Logic-Services | M | **completed** |
| 3 | Tauri-Commands + State Management | M | **completed** |
| 4 | Tauri-Shell & Frontend | M | **completed** |
| 5 | File-Watching & Automation | S | **completed** |
| 6 | Integration & Smoke | M | **completed** |
| 7 | Final-Review & Hand-Over | S | **completed** |

---

## Phase 1 — Markdown-Pipeline-Parität
Status: **completed**
Komplexität: L
Start: 2026-05-04T15:00Z
End: 2026-05-04T16:30Z

### Tasks
- [x] T1.1 comrak-Setup (S) — codex
- [x] T1.2 GenericAttributes-Plugin / AST-Postprocess (M) — codex
- [x] T1.3 HeadingAnchorPreprocessor-Port (S) — abgedeckt durch T1.2
- [x] T1.4a FrontmatterExtractor.Extract (YAML → Entries) (S) — codex
- [x] T1.4b FrontmatterExtractor.RenderHtml (Entries → HTML-Box) (S) — codex
- [x] T1.5 TocExtractor-Port (M) — codex
- [x] T1.7 Goldfile-Diff-Validation (M) — Phase-1-Done-Gate ✓
- [x] T1.8 Rust-Tests für alle obigen Module (M) — 22 Tests passing

### Done-Gate Ergebnis
- **3/3 Goldfile-Diffs passing** (index, frontmatter-example, large-document)
- Tasklisten-HTML normalisiert (Markdig-kompatible Klassen/Attribute)
- Duplikat-Slug-Deduplizierung implementiert
- clippy clean, fmt clean

---

## Phase 2 — Pure-Logic-Services
Status: **completed**
Komplexität: M
Start: 2026-05-04T16:30Z
End: 2026-05-04T18:00Z

### Tasks
- [x] T2.1 NavigationController (S) — codex
- [x] T2.2 FileResolver (S) — codex
- [x] T2.3 TextStatistics (XS) — codex
- [x] T2.4 MarkdownEditorCommands (M) — codex
- [x] T2.5 WorkspaceService (S) — codex
- [x] T2.6 VaultViewModel (M) — codex
- [x] T2.7 ThemeService (S) — codex
- [x] T2.8 PanelStateService (S) — codex
- [x] T2.9 ViewModeController (XS) — codex
- [x] T2.10 LinkInterceptor (S) — codex
- [x] T2.11 Persistenz-Tests (M) — 65 Tests passing

### Done-Gate Ergebnis
- Alle Pure-Logic-Services implementiert
- 65 Unit-Tests passing
- clippy clean, fmt clean

---

## Phase 3 — Tauri-Commands + State Management
Status: **completed**
Komplexität: M
Start: 2026-05-04T18:00Z
End: 2026-05-04T20:00Z

### Tasks
- [x] T3.1 AppState-Struktur (DocumentStore, Workspace, Vault, Navigation, PanelState) — codex
- [x] T3.2 DocumentStore-Commands (read_file, write_file, file_list) — codex
- [x] T3.3 App-Commands (open_folder, pick_folder, pick_file) — codex
- [x] T3.4 Editor-Commands (editor_text_changed, editor_save_requested, apply_editor_command, editor_ready, editor_selection) — codex
- [x] T3.5 Navigation-Commands (navigate, go_back, go_forward, update_scroll, link_click, visible_heading, scroll_position, toc_click) — codex
- [x] T3.6 Vault-Commands (vault_expand_dir, vault_collapse_dir, vault_toggle_section, vault_build_tree, rail_resize, context) — codex
- [x] T3.7 Workspace-Commands (workspace_pin, workspace_unpin, workspace_add_recent, workspace_get) — codex
- [x] T3.8 Shell-Event-Routing (shell_event, editor_event) — codex
- [x] T3.9 Review-Fixes (4 Findings identifiziert und behoben)

### Done-Gate Ergebnis
- 96 Unit-Tests + 3 Goldfile-Tests passing
- clippy clean, fmt clean
- Review-Fixes: Thread-Leak (watcher_tx), Store-Update nach write_file, frontendDist Platzhalter

---

## Phase 4 — Tauri-Shell & Frontend-Asset-Migration
Status: **completed**
Komplexität: M
Start: 2026-05-04T20:00Z
End: 2026-05-04T21:30Z

### Tasks
- [x] T4.1 Shell-Template + Frontend Assets übernehmen (shell-template.html → dist/index.html, editor.ts → dist/editor.ts)
- [x] T4.2 WebViewBridge-Lifecycle-Pendants (load, navigate, editor events)
- [x] T4.3 ViewModeController (View/Edit/Split)
- [x] T4.4 Theme + Scrollbar-Styling
- [x] T4.5 Editor-IPC-Anbindung (tauri invoke/events)
- [x] T4.6 Tauri-Events für Shell ↔ Editor Kommunikation

### Done-Gate Ergebnis
- Frontend-Assets verbatim übernommen und auf Tauri IPC angepasst
- Event-Routing zwischen Shell und Editor implementiert
- clippy clean, fmt clean

---

## Phase 5 — File-Watching & Automation-API
Status: **completed**
Komplexität: S
Start: 2026-05-04T21:30Z
End: 2026-05-04T22:30Z

### Tasks
- [x] T5.1 File-Watching (notify) — bereits in document_store.rs implementiert
- [x] T5.2 Automation-API (axum HTTP-Server auf Port 9876, Loopback-only)
- [x] T5.3 Automation-Routes: GET /state, GET /screenshot, POST /open, /mode, /theme, /rail, /click, /toc/activate, /focus, /find, /find/text, /resize, /save, /quit
- [x] T5.4 Mock-Router für Tests

### Done-Gate Ergebnis
- axum-Server implementiert mit graceful shutdown
- Automation-API spiegelt C# AutomationServer
- clippy clean, fmt clean

---

## Phase 6 — Integration & Smoke-Tests
Status: **completed**
Komplexität: M
Start: 2026-05-04T22:30Z
End: 2026-05-04T23:30Z

### Tasks
- [x] T6.1 integration_nav.rs: Navigation Lifecycle, Scroll-Persistence, Anchor-Handling
- [x] T6.2 integration_editor.rs: Formatting-Sequenzen, Link/Table-Insertion, Cursor-Positionen
- [x] T6.3 integration_pipeline.rs: End-to-End Markdown-Pipeline, TOC/HTML-Konsistenz, Duplicate-Slugs
- [x] T6.4 integration_file.rs: DocumentStore + FileResolver + Workspace Integration
- [x] T6.5 smoke_automation.rs: HTTP-Router-Tests (/state, /open, /save, /quit, 403, 404)

### Done-Gate Ergebnis
- **120 Tests total** (96 unit + 3 goldfile + 21 integration/smoke)
- Alle Tests passing
- clippy clean, fmt clean

---

## Phase 7 — Final-Review & Hand-Over
Status: **completed**
Komplexität: S
Start: 2026-05-04T23:30Z
End: 2026-05-04T23:45Z

### Tasks
- [x] T7.1 MIGRATION_LOG.md aktualisieren
- [x] T7.2 README.md erstellen
- [x] T7.3 Final checks: cargo test, cargo clippy, cargo fmt
- [x] T7.4 Commit + Push

### Done-Gate Ergebnis
- MIGRATION_LOG.md vollständig
- README.md mit Build-Anleitung
- 120 Tests passing
- clippy clean, fmt clean
- Repo auf GitHub: https://github.com/ralfkuh-lab/folio-rs

---

## WebViewBridge-Lifecycle-Pendants (aus C# → Rust/Tauri)
Die WebView selbst ersetzt Tauri, aber die Lifecycle-Logik braucht explizite Rust-Pendants:

- **T4.1** JS-Dispatch-Queue (Pending-JS vor WebView-Ready) — `tauri::async_runtime` + Event-Queue
- **T4.2** PostJson-Äquivalent — Tauri `emit` für große/strukturierte Payloads (nicht `invoke`)
- **T4.3** NavigationStarting-Sicherheitsnetz — Tauri `on_navigation` Hook, Cancel für non-about:/data:-URIs
- **T4.4** Theme-Propagation (PreferredColorScheme + html.className) — Tauri Command + JS-Injection
- **T4.5** Accelerator-Key-Disable (F3, Ctrl+F, F5, Ctrl+P) — Tauri `disable_browser_shortcuts` oder JS `preventDefault`
- **T4.6** Message-Routing (ShellBridge → Tauri invoke-handler Tabelle)