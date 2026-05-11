# Refactoring-Plan: Modularisierung & Aufräumen

Status: **Phase 1 in Arbeit** · Letzte Aktualisierung: 2026-05-11

Architektur-/Strukturreview vom 2026-05-11 (Claude + Codex als 2. Meinung)
ergab klare Splitting-Kandidaten und Smells. Plan ist in vier Phasen
gegliedert, niedriges Risiko zuerst. Jede Phase = ein bis mehrere
abgrenzbare Commits, jeweils mit `cargo test + clippy + fmt` grün.

## Phasen

### Phase 1 — risikoarme Rust-Splits

Pure-Function-Module ohne Tauri-Coupling. Tests existieren und greifen
ohne Anpassung weiter (Public-API über `mod.rs` re-exportiert).

- [ ] **`src/editor_commands.rs` (639 LOC)** → `src/editor_commands/`
  - `mod.rs` — `EditResult` + Re-Exports der `pub fn` Commands
  - `inline.rs` — `toggle_wrap` (bold/italic/code/strike), `insert_link`, `insert_image`
  - `lines.rs` — `toggle_line_prefix`, `toggle_numbered_list_prefix`, `cycle_heading`
  - `blocks.rs` — `insert_table`, `insert_code_block`
  - `util.rs` — Range-/UTF-8-/Line-Helper (`clamp_range`, `clamp_to_char_boundary`,
    `line_start_of`, `line_end_of`, `trim_eol`, `split_keep_endings`,
    `numbered_prefix_length`, `touched_line_range`, `replace_lines`,
    `heading_hash_count`, `insert_snippet`, `replace_selection`,
    `insertion_newline_prefix/suffix`, `table_insertion_newline_suffix`)
  - Verifizieren: `tests/integration_editor.rs` (5 Tests) bleibt grün.

- [ ] **`src/file_icon.rs` (405 LOC)** → `src/file_icon/`
  - `mod.rs` — Public-API (`icon_for_extension` / Cache-Wrapper), OS-Auswahl per
    `#[cfg(target_os = …)] pub mod …` an der Modul-Deklaration
  - `linux.rs` — Linux-Implementierung + `LINUX_ICON_THEME`-Detection
  - `windows.rs` — Windows-Implementierung
  - `fallback.rs` — Default-Pfad für andere Plattformen
  - `markdown.rs` — Markdown-spezifischer eingebetteter Icon-Asset (falls vorhanden)
  - `cache.rs` — Cache-Layer (falls separierbar)
  - Verifizieren: existierende Tests in `file_icon.rs` (Linux- und Windows-Zweige) bleiben grün.

**Phase-1-Abschluss:** Commit pro Datei. `cargo build && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.

### Phase 2 — mittlere Rust-Splits

Mehr Bewegung, aber klare fachliche Grenzen. Public-API bleibt stabil.

- [ ] **`src/automation.rs` (770 LOC)** → `src/automation/`
  - `mod.rs` — `AutomationServer`, `AutomationServerHandle`, Public-Surface
  - `router.rs` — `build_router`, `build_mock_router`
  - `types.rs` — Request/Response-DTOs
  - `error.rs` — `ApiError`, `ApiResult`, `IntoResponse`-Impl
  - `middleware.rs` — `loopback_only`, CORS, `preflight`
  - `handlers/state.rs` — `get_state`, `mock_get_state`
  - `handlers/document.rs` — `post_open`, `post_save`, `post_editor_text`, `post_quit` (+ Mocks)
  - `handlers/ui.rs` — `post_mode`, `post_theme`, `post_rail`, `post_click`, `post_focus`, `post_find`, `post_find_text`, `post_resize`, `post_toc_activate`
  - `screenshot.rs` — `get_screenshot`, `capture_png`
  - `mock.rs` — `MockAutomationState`, Mock-Router
  - Verifizieren: `tests/smoke_automation.rs` (7 Tests) bleibt grün.

- [ ] **`src/menu/mod.rs` (416 LOC)** → erweitere `src/menu/`
  - `mod.rs` — Public-Surface
  - `ids.rs` — alle Item-ID-Konstanten
  - `build.rs` — `build()` mit Menü-Konstruktion
  - `events.rs` — `on_menu_event` Dispatcher
  - `recent.rs` — `rebuild_recent_submenu`, `refresh_recent_from_workspace`, `recent_label`
  - `lookup.rs` — `find_menu_item`, `find_submenu`, `find_check_menu_item`
  - Verifizieren: Menü-Funktionalität manuell durchklicken (Save-As, Recent, Toggle-Items).

### Phase 3 — State-Choreografie aufräumen, dann splitten

**Vorab-Refactor erforderlich**, bevor Split sinnvoll ist.

- [ ] **Zentrale Dokument-Operationen einführen**
  Mehrere Pfade synchronisieren Workspace.recent + Vault.active + Recent-Menü +
  Vault.refresh + DocumentStore manuell. Eine `pub fn` pro Operation, alle Pfade rufen sie:
  - `document::open(path, …)` — gerufen von `read_file`, `commands/shell::open_document`,
    Automation `/open`, Navigation-Link-Klicks
  - `document::rename(old, new, …)` — gerufen von Tauri-Command `rename_file` und
    `run_rename_dialog`
  - `document::close(…)` — gerufen von Tauri-Command und Menü-Event

- [ ] **`src/commands/file.rs` (411 LOC)** → `src/commands/file/` (nach Refactor)
  - `mod.rs` — Tauri-Command-Exports
  - `types.rs` — `FileData`, `FileEntry`
  - `read.rs` — `read_file`, `write_file`, `list_dir`
  - `dialogs.rs` — `run_save_as`, `run_rename_dialog`
  - `rename.rs` — `rename_file` (nutzt `document::rename`)
  - `lifecycle.rs` — `close_document`

- [ ] **`src/commands/shell.rs` (379 LOC)** umbenennen + splitten
  Datei ist kein Shell-Modul, sondern ein Event-Gateway. Umbenennen zu
  `src/commands/events/` (oder `src/event_gateway/`):
  - `mod.rs` — Public-Tauri-Commands (`shell_event`, `editor_event`)
  - `router.rs` — Dispatch nach `type`-Feld
  - `payload.rs` — `payload_type`, `string_field`, `number_field`, `bool_field`, `usize_field`
  - `editor.rs` — Editor-bezogene Events
  - `navigation.rs` — Link-Klick, Scroll, TOC-Klick, Visible-Heading, Rail-Resize
  - `vault.rs` — Vault-Sektion-Toggle, Dir-Expand/Collapse, Vault-Context, Add-File/Folder
  - `document.rs` — Open-Document, Document-Payload

### Phase 4 — Frontend-Build-Umbau (eigener Sprint)

`dist/index.html` (3676 LOC) ist der größte Hebel, aber **hohes Risiko**.
Nicht mechanisch zerschneiden — neu strukturieren mit klarer Bridge.

- [ ] **Authored Frontend nach `src-tauri/web/app/`** mit Build über bestehende npm-Pipeline
  - `app/main.ts` — Bootstrap, Tauri-Invoke/Event-Wiring
  - `app/state/document.ts` — `currentPath`, `dirty`, `kind`, `title`, save/close/open-Bridge
  - `app/view/markdown.ts` — TOC, Anchor-Scroll, relative Assets, View-Find
  - `app/editor/shell.ts` — Mount/Layout/Load-Bridge zu `window.FolioEditor`
  - `app/vault/tree.ts` — Tree-Interaktion, Active-State, Lazy-Children
  - `app/vault/context-menu.ts` — Kontextmenü + Inline-Rename
  - `app/ui/find-bar.ts`, `ui/rails.ts`, `ui/dialogs.ts`, `ui/export-dialog.ts`,
    `ui/language-picker.ts`, `ui/zoom.ts`, `ui/cheatsheet.ts`
  - `styles/base.css`, `styles/vault.css`, `styles/toolbar.css`, `styles/dialogs.css`, …

- [ ] **Vorbedingung: Smells #1+#2 auflösen** (siehe unten)

## Architektur-Smells (Referenz, jenseits Dateigröße)

Diese Beobachtungen aus dem Review sind **Background-Awareness**, nicht
unbedingt eigene Tasks — sie informieren die Splits.

1. **Frontend als globaler Bus** — viele `window.*`-APIs (`openDocument`,
   `setTocList`, `FolioEditor`, `ViewFinder`, `__folioInvoke`,
   `startInlineRename`). Reihenfolge und Ownership implizit. Wird in Phase 4
   durch echte Module mit klaren Imports/Exports adressiert.
2. **Doppelte Event-Handler** — `document:loaded`, `vault:refresh`,
   `app:set_mode` werden in beiden `<script>`-Blöcken in `index.html` separat
   registriert. Risiko für State-Drift. Phase 4 räumt das beim Modul-Schnitt
   auf.
3. **Backend-Duplikation beim "Dokument öffnen"** — `read_file`,
   `commands/shell::open_document`, Automation `/open`, Link-Klick im
   View-Modus aktualisieren Store/Navigation/Vault auf je eigenem Weg.
   Adressiert in Phase 3 (`document::open`).
4. **Mehrfache Rename/Save-As-State-Choreografie** — Workspace.recent,
   Vault.active, Recent-Menü, Vault.refresh, DocumentStore. Adressiert in
   Phase 3 (`document::rename`).
5. **Stringly-typed IPC** — viele `serde_json::Value`/String-Felder. Für
   externe Automation OK, für interne Shell-/Editor-Events mittelfristig
   typisieren (eigene Tasks in Phase 3-Refactor).

## Was NICHT angefasst werden soll

- `src-tauri/dist/editor.bundle.js`, `src-tauri/dist/monaco/**` — Build-/Vendor-Artefakte.
- `src-tauri/web/editor.ts` — funktional kohärent als Monaco-Adapter. Erst nach Phase 4.
- `src/file_kind.rs` — laut CLAUDE.md zentrale Source of Truth.
- `src/document_store.rs` — CRLF/LF/BOM-Roundtrip sensibel, explizit getestet.
- **Event-Namen** (`document:loaded`, `app:set_mode`, `shell:command`,
  `editor:event`) — Integrationsvertrag, nicht beim Split "aufräumen".

## Fortschritt

| Phase | Status | Commits |
|---|---|---|
| 1: risikoarme Splits | ⏳ in Arbeit | — |
| 2: mittlere Rust-Splits | ⏸ wartet | — |
| 3: State-Refactor + Splits | ⏸ wartet | — |
| 4: Frontend-Build-Umbau | ⏸ wartet | — |
