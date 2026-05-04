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
| WebViewBridge | 200 | (Tauri WebView übernimmt) |

**Tests:** 12 Dateien, 2043 Zeilen. Jeder Service hat äquivalente Rust-`#[test]`-Pendants.

**Frontend-Assets (verbatim übernommen):**
- `src/Folio/web/src/editor.ts` → `web/src/editor.ts`
- `src/Folio/Resources/shell-template.html` → `src-tauri/assets/shell-template.html`

**Goldfiles:**
- `goldfiles/expected/index.html` (613 KB)
- `goldfiles/expected/frontmatter-example.html` (613 KB)
- `goldfiles/expected/large-document.html` (777 KB)

### Risikoeinschätzung

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| comrak hat kein GenericAttributes-Äquivalent | Hoch | Mittel | AST-Postprocess oder eigenes Plugin |
| CSS Custom Highlight API nicht in WebKitGTK | Mittel | Hoch | Fallback-Strategie in `MIGRATION_LOG.md` dokumentieren |
| IPC-Payload-Größe (Tauri) | Mittel | Mittel | Events für große Payloads, nicht invoke |
| CRLF/LF/BOM-Roundtrip | Niedrig | Hoch | Dokumentation + Tests aus Source übernehmen |
| Screenshot cross-platform | Mittel | Niedrig | `xcap` als Default, Fehler tolerieren |

### Phasenplan

| Phase | Thema | Komplexität | Status |
|---|---|---|---|
| 0 | Inventory & Planning | S | **completed** |
| 1 | Markdown-Pipeline-Parität | L | pending |
| 2 | Pure-Logic-Services | M | pending |
| 3 | Persistenz | M | pending |
| 4 | Tauri-Shell & Frontend | M | pending |
| 5 | File-Watching & Automation | S | pending |
| 6 | Integration & Smoke | M | pending |
| 7 | Final-Review & Hand-Over | S | pending |

---

## Phase 1 — Markdown-Pipeline-Parität
Status: pending
Komplexität: L
Start: TBD

### Tasks
- [ ] T1.1 comrak-Setup (S)
- [ ] T1.2 GenericAttributes-Plugin / AST-Postprocess (M)
- [ ] T1.3 HeadingAnchorPreprocessor-Port (S)
- [ ] T1.4 FrontmatterExtractor-Port (S)
- [ ] T1.5 TocExtractor-Port (M)
- [ ] T1.6 MarkdownRenderer.RewriteImages-Port (S)
- [ ] T1.7 Goldfile-Diff (S)
- [ ] T1.8 Rust-Tests für alle obigen Module (M)
