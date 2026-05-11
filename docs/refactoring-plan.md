# Refactoring-Plan: Modularisierung & Aufräumen

Status: **Phase 3 abgeschlossen** · Letzte Aktualisierung: 2026-05-11

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

- [x] **`src/automation.rs` (770 LOC)** → `src/automation/` ✓ Commit
  - `mod.rs` — `AutomationServer/Handle` + Re-Exports (Public-API stabil)
  - `context.rs` — `AutomationContext`
  - `router.rs` — `build_router`, `build_mock_router`
  - `types.rs` — Request/Response-DTOs
  - `error.rs` — `ApiError`, `ApiResult`, `ok`, `json_payload`, `IntoResponse`-Impl
  - `middleware.rs` — `loopback_only`, CORS, `preflight`, Fallbacks
  - `helpers.rs` — `emit`, `main_window`
  - `mock.rs` — `MockAutomationState` (Default)
  - `handlers/{state,document,ui,screenshot}.rs` — Route-Handler nach Domäne
  - Sichtbarkeit: `pub(super)` / `pub(in crate::automation)`. Tests
    (`tests/smoke_automation.rs`, 7 Tests) grün ohne Anpassung.

- [x] **`src/menu/mod.rs` (416 LOC)** → erweitere `src/menu/` ✓ Commit
  - `mod.rs` — Public-Surface (`build`, `on_menu_event`, `refresh_recent_from_workspace`,
    `rebuild_recent_submenu`, `menu_set_enabled`, `menu_set_checked`, `pub mod strings`)
  - `ids.rs` — alle Item-ID-Konstanten (`pub(super)`)
  - `build.rs` — `build()` mit Menü-Konstruktion
  - `events.rs` — `on_menu_event` Dispatcher
  - `recent.rs` — `rebuild_recent_submenu`, `refresh_recent_from_workspace`, `recent_label`
  - `lookup.rs` — `find_menu_item`, `find_submenu`, `find_check_menu_item`

### Phase 3 — State-Choreografie aufräumen, dann splitten

Rename-Choreografie konsolidiert; weitere Open-/Close-Konsolidierungen
sind kleiner und können bei Bedarf später angefasst werden, sobald
Schmerz konkret wird.

- [x] **Rename-Konsolidierung** ✓ Commit
  `rename_file` (Tauri-Command) und `run_rename_dialog` (Datei-Menü)
  teilten ~25 LOC identischer State-Synchronisation. Beide rufen jetzt
  `fn perform_rename(old, new, state, handle)`, das auch Validierung
  (Zieldatei existiert) und `fs::rename` kapselt.

- [ ] **Open-Konsolidierung** (offen, nicht prioritär)
  `read_file` (commands/file/read), Automation `post_open`, und
  `commands::events::vault::open_document` machen alle den gleichen
  3-Schritt: `document_store.load`, `navigation.navigate`,
  `vault.set_active`. ~4 LOC Duplikation pro Stelle. Konsolidierung in
  `document::open(path, state)` wäre sauber, lohnt aber erst, wenn sich
  ein 4. Caller einreiht oder das Trio sich auseinanderentwickelt.

- [x] **`src/commands/file.rs` (411 LOC)** → `src/commands/file/` ✓ Commit
  - `mod.rs` — Re-Exports (`FileData`, `FileEntry`, `run_save_as`,
    `run_rename_dialog`, `list_dir`)
  - `types.rs` — `FileData`, `FileEntry`
  - `read.rs` — `read_file`, `write_file`
  - `rename.rs` — `rename_file`, `run_rename_dialog`, `perform_rename`
  - `save_as.rs` — `run_save_as`, `save_as` (cmd-Wrapper)
  - `close.rs` — `close_document`
  - `list.rs` — `file_list`, `list_dir`, `file_name`
  - `util.rs` — `file_path_to_string` (shared)
  - **Stolperstein**: `tauri::generate_handler!` findet `__cmd__*`-Companions
    nicht via `pub use`. lib.rs nutzt jetzt explizite Submodul-Pfade
    (`commands::file::read::read_file` etc.).

- [x] **`src/commands/shell.rs` (379 LOC)** umbenennen + splitten ✓ Commit
  Datei ist kein Shell-Modul, sondern ein Event-Gateway — umbenannt zu
  `src/commands/events/`. Tauri-Command-Namen (`shell_event`/`editor_event`)
  und IPC-Event-Strings (`shell:event`/`editor:event`) bleiben stabil.
  - `mod.rs` — Tauri-Commands `shell_event`/`editor_event` (thin wrapper)
  - `router.rs` — `route_shell_event` + `route_editor_event` (Dispatch)
  - `payload.rs` — `payload_type`, `string_field`, `number_field`,
    `bool_field`, `usize_field` (alle `pub(super)`)
  - `navigation.rs` — `link_click`, `visible_heading`, `scroll_position`,
    `toc_click`, `rail_resize`
  - `vault.rs` — `toggle_section`, `expand_dir`, `collapse_dir`,
    `open_document`, `context`, `add_file`, `add_folder`,
    `emit_vault_refresh`
  - Editor-Event-Handler bleiben inline im `router.rs` (5 kurze Arms,
    Extraktion wäre Over-Engineering).
  - Dead-Code-Entfernung: `pub fn document_payload` (unbenutzt) raus.

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
| 2: mittlere Rust-Splits | ✅ abgeschlossen | `automation`-Split, `menu`-Split |
| 3: State-Refactor + Splits | ✅ abgeschlossen | Rename-Konsolidierung, `commands/file`-Split, `commands/shell` → `commands/events`-Split |
| 4: Frontend-Build-Umbau | ⏸ wartet | — |
