# Refactoring-Plan: Modularisierung & Aufräumen

Status: **Phase 1 abgeschlossen** · Letzte Aktualisierung: 2026-05-11

Architektur-/Strukturreview vom 2026-05-11 (Claude + Codex als 2. Meinung)
ergab klare Splitting-Kandidaten und Smells. Plan ist in vier Phasen
gegliedert, niedriges Risiko zuerst. Jede Phase = ein bis mehrere
abgrenzbare Commits, jeweils mit `cargo test + clippy + fmt` grün.

## Phasen

### Phase 1 — risikoarme Rust-Splits

Pure-Function-Module ohne Tauri-Coupling. Tests existieren und greifen
ohne Anpassung weiter (Public-API über `mod.rs` re-exportiert).

- [x] **`src/editor_commands.rs` (639 LOC)** → `src/editor_commands/` ✓ Commit
  - `mod.rs` — `EditResult` + Re-Exports der `pub fn` Commands
  - `inline.rs` — `toggle_wrap` (bold/italic/code/strike), `insert_link`, `insert_image`
  - `lines.rs` — `toggle_line_prefix`, `toggle_numbered_list_prefix`, `cycle_heading`
  - `blocks.rs` — `insert_table`, `insert_code_block`
  - `util.rs` — Range-/UTF-8-/Line-Helper (alle `pub(super)`)
  - Tests: 22 Unit-Tests + 5 Integration-Tests grün, Public-API unverändert.

- [x] **`src/file_icon.rs` (405 LOC)** → `src/file_icon/` ✓ Commit
  - `mod.rs` — Public-API (`IconBytes`, `icon_for_extension`, Cache, Markdown-Pfad),
    OS-Auswahl per `#[cfg(target_os = …)] mod …` an der Modul-Deklaration
  - `linux.rs` — Linux-`compute_icon` + `LINUX_ICON_THEME`-Detection (`pub(super)`)
  - `windows.rs` — Windows-`compute_icon` + `icon_via_assoc_query`,
    `icon_via_shgetfileinfo`, `hicon_to_png`. Modulname kollidiert nicht mit
    der `windows`-Crate (Extern-Prelude vs. Self-Scope).
  - `fallback.rs` — `None`-Pfad für andere Plattformen
  - Tests: 3 generische Unit-Tests grün (Markdown + Cache); Linux-Tests bleiben
    `#[cfg(target_os = "linux")]`-gegated und laufen nur auf Linux.

**Phase-1-Abschluss:** Build + 128 Tests + Clippy + Fmt grün auf Windows.

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
| 1: risikoarme Splits | ✅ abgeschlossen | `editor_commands`-Split + Plan, `file_icon`-Split |
| 2: mittlere Rust-Splits | ⏸ wartet | — |
| 3: State-Refactor + Splits | ⏸ wartet | — |
| 4: Frontend-Build-Umbau | ⏸ wartet | — |
