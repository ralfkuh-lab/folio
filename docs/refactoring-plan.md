# Refactoring-Plan: Modularisierung & Aufräumen

Status: **Phase 5 in Arbeit** · Letzte Aktualisierung: 2026-05-12

Architektur-/Strukturreview vom 2026-05-11 (Claude + Codex als 2. Meinung)
ergab klare Splitting-Kandidaten und Smells. Plan ist in vier Phasen
gegliedert, niedriges Risiko zuerst. Jede Phase = ein bis mehrere
abgrenzbare Commits, jeweils mit `cargo test + clippy + fmt` grün.

Phasen 1-4 sind durch. **Phase 5** (2026-05-12) sammelt die Restbefunde aus
dem zweiten Review nach Refactoring-Ende — kleinere Konsolidierungen +
Type-Safety + Frontend-Tests. Vier echte Bugs aus diesem Review wurden
vorher (Commit unmittelbar vor Phase-5-Start) bereits gefixt:
`main.ts:418`-ReferenceError, `find-bar.ts`-`window.focusEditor`-Bridge,
Link-Klick-Dirty-Prompt, `reload_if_changed`-Format-Metadaten.

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

- [x] **Authored Frontend nach `src-tauri/web/app/`** mit Build über bestehende npm-Pipeline ✓ Commits 5e81f32 … e771633
  - `app/main.ts` — Bootstrap, Tauri-Invoke/Event-Wiring
  - `app/state/document.ts` — `currentPath`, `dirty`, `kind`, `title`, save/close/open, fusionierter `document:loaded`-Handler
  - `app/view/markdown.ts` — TOC, Anchor-Scroll, relative Assets, ViewFinder
  - `app/editor/shell.ts` — Mount/Layout/Load-Bridge zu `window.FolioEditor`, fusionierter `app:set_mode`-Handler
  - `app/vault/tree.ts` — Tree-Interaktion, Active-State, Lazy-Children, fusionierter `vault:refresh`-Handler
  - `app/vault/context-menu.ts` — Kontextmenü + Inline-Rename
  - `app/ui/{find-bar, rails, dialogs, export-dialog, language-picker, zoom, cheatsheet}.ts`
  - `styles/{base, toolbar, statusbar, vault, content, toc, find-bar, dialogs, overlays, scrollbar}.css` + `index.css`-Entry
  - Sub-Phasen 4.1 CSS → 4.2 Verbatim-JS-Move → 4.2b Global-Contract-Audit
    (`docs/frontend-globals.md`) → 4.3 7 Leaf-Module → 4.4 Vault + Listener-
    Fusion → 4.5 Core + 2 Listener-Fusionen → 4.6 Bridge-Reduktion +
    `--minify` → 4.7 Sweep.

- [x] **Smells #1 + #2 aufgelöst** — siehe unten.

**Phase-4-Ergebnis:** `dist/index.html` schrumpft von 3676 LOC auf 174
(95% Reduktion); `app.bundle.js` minified bei 46.6 KB; alle drei
Doppel-Listener (`document:loaded`, `vault:refresh`, `app:set_mode`) sind
fusioniert; `window.*`-Bridge reduziert auf `window.FolioEditor` (Cross-
Bundle zu `editor.bundle.js`) + `window.__folioInvoke` + `window.openDocument`
(beide defensive DevTools-Surface). Smoke-Test um drei Marker-Assertions
erweitert (app.bundle.js carries `__folioInvoke` + `openDocument`,
app.css exists, index.html ohne `<style>`).

## Architektur-Smells (Referenz, jenseits Dateigröße)

Diese Beobachtungen aus dem Review sind **Background-Awareness**, nicht
unbedingt eigene Tasks — sie informieren die Splits.

1. **~~Frontend als globaler Bus~~** ✅ Phase 4.6 hat die ~80 `window.*`-
   Setter auf 3 reduziert (Cross-Bundle + 2 defensive DevTools-Surfaces).
   Modul-interne Kommunikation läuft über ESM-Imports.
2. **~~Doppelte Event-Handler~~** ✅ Phase 4.4 (`vault:refresh`) und
   Phase 4.5 (`document:loaded`, `app:set_mode`) haben die jeweils
   komplementären Hälften zu je einem Handler im fachlich passenden
   Modul fusioniert.
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

### Phase 5 — Konsolidierung & Type-Safety nach Post-Refactoring-Review

Restbefunde aus dem zweiten Review (2026-05-12). Niedriges bis mittleres
Risiko; jeder Punkt ist ein eigener Commit-Kandidat.

#### 5.1 — Backend: Dokument-Öffnen konsolidieren ✅ abgeschlossen

`document_store.load + navigation.navigate + vault.set_active` waren
an vier Stellen separat choreografiert — Ursache wiederkehrender Link-Klick-Bugs.

- [x] **Service-Funktion** `src/document_service.rs::open(state, path, options)` ✓ Commit
  - `OpenDocumentOptions { anchor, reload: Always | IfPathChanged, dirty: Reject | Discard }`
  - Reihenfolge: Load → Navigate → Vault (vorher in `link_click`: Navigate-vor-Load → bei
    IO-Fehler History auf nie geladenem Ziel).
  - `OpenDocumentOutcome { loaded: Option<LoadedDocument>, nav_entry: Entry }` —
    `loaded` ist `None` beim Anker-only-Sprung (`IfPathChanged` mit gleichem Pfad).
  - Callsites umgestellt: `commands/file/read::read_file` (Always/Discard),
    `commands/events/vault::open_document` (Always/Discard),
    `commands/events/navigation::link_click` (IfPathChanged/Discard),
    `automation/handlers/document::post_open` (Always/Discard).
  - 5 Unit-Tests (open_loads…, open_skips_load…, open_reloads…, open_rejects_dirty…,
    open_discards_dirty…) + alle Smoke-Tests grün.
  - **Architektur-Konsultation Codex** (Synthese der zweiten Meinung) lieferte zwei latente
    Befunde: (a) `link_click`-Reihenfolge-Bug (Navigate vor Load) — strukturell behoben,
    (b) `DocumentStore::load` setzt `is_dirty=false` ohne Schutz → bei `read_file` und
    `/open` heute silenter Datenverlust möglich. **Nicht** in diesem Commit gefixt
    (Scope-Konservativ: alle vier Callsites bleiben `DirtyPolicy::Discard` =
    heutiges Verhalten). `DirtyPolicy::Reject` ist bereits da; Aktivierung für
    Automation/`read_file` ist separater Folgecommit.
- [x] **Dead Code raus**: `commands/nav.rs::link_click` (Tauri-Command, nie invoked) ✓ Commit
- [x] **Dead Code raus**: `DocumentStore::mark_external_changed` + `has_external_changes`-Feld ✓ Commit

#### 5.2 — Frontend-Type-Safety

`@ts-nocheck` ist flächendeckend in `src-tauri/web/app/**.ts`; dadurch
rutschte `main.ts:418` (ReferenceError auf `currentPath`/`cleanText`)
am Build vorbei. Build-Script hat keinen Typecheck-Schritt.

- [ ] **`@ts-nocheck` schrittweise raus**, Reihenfolge nach Hebel:
  - `state/document.ts` (zentraler State, viele Importer)
  - `main.ts` (Orchestrator, viele Cross-Modul-Aufrufe)
  - `editor/shell.ts`, `vault/tree.ts`, `ui/find-bar.ts`
  - Rest folgt automatisch
- [ ] **`tsc --noEmit` in `package.json::build` ergänzen** — vor esbuild,
      Build bricht bei Typfehlern ab.
- [ ] **`window.*`-Surface typisieren** über eigene `.d.ts` oder
      `declare global` in `globals.d.ts`. Aktueller Stand: `window.FolioEditor`,
      `window.__folioInvoke`, `window.openDocument`, `window.setVaultPinned`/
      `setVaultRecent` etc. — siehe `docs/frontend-globals.md`.

#### 5.3 — Frontend-Splits

`main.ts` ist nach Phase 4.6 weiterhin Orchestrator mit ~470 LOC,
zwei IIFEs, vielen inline-Listenern. `editor.ts` ist ~550 LOC monolitischer
Monaco-Adapter.

- [ ] **`main.ts` aufteilen** in Leaf-Module:
  - `ui/toolbar-actions.ts` — `bind('tb-*')` + `applyCmd` aus IIFE #2
  - `ui/menu-router.ts` — `menu:*`-Listener (file_open, file_save,
    file_recent, view_mode_*, view_theme_*, view_rail_*, edit_*, help_*, about)
  - `ui/drag-drop.ts` — `tauri://drag-*`-Listener
  - `automation/events.ts` — `automation:click`, `automation:set_editor_text`,
    `automation:open_document`
  - `main.ts` wird reiner Init-Router (~100 LOC Ziel)
- [ ] **`editor.ts` splitten** in `web/editor/`:
  - `editor/mount.ts` — Monaco-Init, `mount`, `setText`, `setTheme`, `layout`
  - `editor/find.ts` — Find-State (Decorations, openFind/closeFind/setFindTerm)
  - `editor/events.ts` — Selection-/Scroll-Capture, `editorReady`-Post
  - `editor/index.ts` — `window.FolioEditor`-Assembly
  - **`suppressTextEvent` durch Promise-Queue ersetzen** — globaler Boolean
    ist race-anfällig zwischen `mount` und `setText`
- [ ] **`commands/app.rs` splitten** (~270 LOC, 13 Verantwortungen):
  - `commands/app/dialog.rs` — `pick_file`, `pick_folder`, `open_folder`
  - `commands/app/shell_opener.rs` — `show_in_file_manager`, `open_terminal_at`
  - `commands/app/mod.rs` — Theme/Rail/View-Mode/Window/Zoom (Core-State)

#### 5.4 — Robustheit & Tests

- [ ] **`commands/file/save_as.rs:87` und `commands/file/rename.rs:119`**:
      Lock-Fehler werden mit `if let Ok(...)` geschluckt, Command meldet
      trotzdem `Ok`. Bei Mutex-Poisoning driften Store/Workspace/Vault/
      Navigation auseinander. → Fehler propagieren oder als bewusste
      best-effort markieren + vollständigen Refresh emittieren.
- [ ] **`DocumentStore::load` + `reload_if_changed` DRY**: BOM-/CRLF-/
      Decode-Logik ist zweimal vorhanden. Private
      `fn read_and_decode(path) -> io::Result<(String, LineEnding, bool)>`
      extrahieren, beide Methoden nutzen sie.
- [ ] **Frontend-Tests einführen** — Vitest minimal-Setup (kein Playwright).
      Lohnendste Kandidaten:
  - `state/document.ts` Listener-Logik (document:loaded / dirty_changed /
    external_changed-Pfade mit mock Tauri-API)
  - `vault/tree.ts::toggleDir` + Recursive-Collapse
  - `ui/find-bar.ts` Mode-Wechsel (View↔Edit) + Term-Persistenz

#### 5.5 — Polish (niedriges Risiko, kleine Diffs)

- [ ] **`Vault::on_section_toggle`-Stub** (vault.rs:93) ist No-Op. Entweder
      Pin/Recent-Section-State im Vault persistieren oder Stub entfernen
      (DOM-classList reicht).
- [ ] **`data-loaded`-Attribut** in `Vault::item_html` (vault.rs:101): seit
      Auto-Refresh im Frontend ignoriert. Aus dem HTML-Output entfernen.
- [ ] **`commands/events/router.rs` Unknown-Event-Type**: `_ => Ok(())`
      schluckt Frontend-Typos silent. Mindestens `eprintln!`-Log oder
      Comment-Block mit kanonischen Event-Namen.
- [ ] **`window.openDocument` / `window.__folioInvoke`** als DevTools-Surface
      bewusst dokumentieren (eigenes `debug-bridge.ts` mit Kommentar) oder
      entfernen, wenn niemand sie konsumiert.
- [ ] **`Cargo.toml` CRLF-Phantom-Diff** nach `.gitattributes`-Einführung:
      `git add --renormalize src-tauri/Cargo.toml && git commit`.

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
| 4: Frontend-Build-Umbau | ✅ abgeschlossen | CSS-Extraktion, JS-Verbatim-Move, Global-Contract-Audit, 7 Leaf-Module, Vault-Module + `vault:refresh`-Fusion, Core-Module + `document:loaded`/`app:set_mode`-Fusion, Bridge-Reduktion + Minify |
| 5: Konsolidierung & Type-Safety | 🚧 in Arbeit | 5.1 ✓ (`document_service::open` + Dead-Code); 5.2-5.5 offen |
