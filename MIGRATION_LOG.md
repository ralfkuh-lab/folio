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
| WebViewBridge | 200 | Phase 4: Tauri Command/Event-System — JS-Queue, PostJson, Theme-Propagation, Accelerator-Key-Disable |

**Tests:** 12 Dateien, 2043 Zeilen. Jeder Service hat äquivalente Rust-`#[test]`-Pendants.

**Frontend-Assets (verbatim übernommen):**
- `src/Folio/web/src/editor.ts` → `web/src/editor.ts`
- `src/Folio/Resources/shell-template.html` → `src-tauri/assets/shell-template.html`

**Goldfiles (nach Fix: nur Pipeline-Ausgabe, kein Shell-Template/Bundle/RewriteImages):**
- `goldfiles/expected/index.html` (1.851 bytes, 53 lines)
- `goldfiles/expected/frontmatter-example.html` (1.122 bytes, 15 lines)
- `goldfiles/expected/large-document.html` (164.941 bytes, 2.282 lines)

### Risikoeinschätzung

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| comrak hat kein GenericAttributes-Äquivalent | Hoch | Mittel | AST-Postprocess oder eigenes Plugin |
| **comrak Slugifier vs. Markdig AutoIdentifier** (Umlaute, Non-ASCII) | **Hoch** | **Hoch** | **Eigener Slugifier statt comrak-Default** |
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
- [x] T1.1 comrak-Setup (S) — **Implemented-By: codex**
- [x] T1.2 GenericAttributes-Plugin / AST-Postprocess (M) — **Implemented-By: codex**
- [ ] T1.3 HeadingAnchorPreprocessor-Port (S)
- [ ] T1.4a FrontmatterExtractor.Extract (YAML → Entries) (S)
- [ ] T1.4b FrontmatterExtractor.RenderHtml (Entries → HTML-Box) (S)
- [ ] T1.5 TocExtractor-Port (S)
- [ ] T1.6 RewriteImages-Port (S) — **Phase-5-Checkpoint (nicht Phase-1)**
- [ ] T1.7 Goldfile-Diff-Validation (M) — **Phase-1-Done-Gate**
- [ ] T1.8 Rust-Tests für alle obigen Module (M)

### Diskussion
- Auto-Identifiers: Markdig's AutoIdentifier übernimmt `heading.content` (bereinigter Text)...[truncated]
`frontmatterHtml + Markdown.ToHtml(preprocessed, pipeline)`.
**Nicht** enthalten: Shell-Template, Editor-Bundle, RewriteImages (WebView2-spezifisch).

---

## Phase 4 — Tauri-Shell & Frontend-Asset-Migration (Vorschau)
Status: pending
Komplexität: M

### WebViewBridge-Lifecycle-Pendants (aus C# → Rust/Tauri)
Die WebView selbst ersetzt Tauri, aber die Lifecycle-Logik braucht explizite Rust-Pendants:

- **T4.1** JS-Dispatch-Queue (Pending-JS vor WebView-Ready) — `tauri::async_runtime` + Event-Queue
- **T4.2** PostJson-Äquivalent — Tauri `emit` für große/strukturierte Payloads (nicht `invoke`)
- **T4.3** NavigationStarting-Sicherheitsnetz — Tauri `on_navigation` Hook, Cancel für non-about:/data:-URIs
- **T4.4** Theme-Propagation (PreferredColorScheme + html.className) — Tauri Command + JS-Injection
- **T4.5** Accelerator-Key-Disable (F3, Ctrl+F, F5, Ctrl+P) — Tauri `disable_browser_shortcuts` oder JS `preventDefault`
- **T4.6** Message-Routing (ShellBridge → Tauri invoke-handler Tabelle)

