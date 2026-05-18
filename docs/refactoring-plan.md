# Refactoring-Plan: Modularisierung & Aufräumen

Status: **abgeschlossen** (alle Phasen durch, inkl. 5.3c `editor.ts`-Split) · Letzte Aktualisierung: 2026-05-18

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
    `/open` heute silenter Datenverlust möglich.
- [x] **Automation-Reject-Folgecommit** ✓ Commit
  - `automation::post_open` nutzt jetzt `DirtyPolicy::Reject` — Loopback-API hat keinen
    User-Prompt, ungespeicherte Aenderungen dürfen nicht silent verworfen werden.
  - `ApiError::conflict` (HTTP 409) ergänzt; `OpenDocumentError::DirtyRejected` mappt
    darauf, andere Service-Fehler bleiben 500. Automation-Clients können den
    Dirty-Konflikt damit vom internen Fehler unterscheiden.
  - Mock-Pfad (`mock_post_open`) spiegelt das Verhalten; neuer Smoke-Test
    `post_open_rejects_with_conflict_when_state_dirty` (8/8 grün).
  - Frontend-Pfade (`read_file`, `link_click`, `vault::open_document`) bleiben auf
    `Discard`, weil dort `requestSaveIfDirty` im Frontend vorher greift.
- [x] **Dead Code raus**: `commands/nav.rs::link_click` (Tauri-Command, nie invoked) ✓ Commit
- [x] **Dead Code raus**: `DocumentStore::mark_external_changed` + `has_external_changes`-Feld ✓ Commit

#### 5.2 — Frontend-Type-Safety ✅ abgeschlossen

`@ts-nocheck` war flächendeckend in `src-tauri/web/app/**.ts`; dadurch
rutschte `main.ts:418` (ReferenceError auf `currentPath`/`cleanText`)
am Build vorbei. Build-Script hatte keinen Typecheck-Schritt.

- [x] **TS-Setup** ✓ Commit
  - `typescript@^5.6.3` als devDep, `tsconfig.json` mit lockerem Mode
    (target ES2018, module ESNext, kein `strict`/`noImplicitAny`).
    Ziel: "Cannot find name"-Fehler abfangen, nicht volle Strict-Migration.
  - `globals.d.ts` deklariert die `window.*`-Surface zentral
    (`FolioEditor`, `__TAURI__`, `__folioInvoke`, `openDocument`,
    `monaco`, `require`). Quelle: `docs/frontend-globals.md`.
  - `tsc --noEmit` läuft vor esbuild in `package.json::build` —
    Typfehler brechen den Build sofort ab. Zusätzliches `typecheck`-Script.
  - `editor.ts`s lokaler `declare global { interface Window {...} }`-Block
    raus (sonst Konflikt mit `globals.d.ts` durch inkompatible
    `__TAURI__`-Type-Literale).
- [x] **`@ts-nocheck` schrittweise raus** ✓ Commit — alle 13 Dateien:
    `state/document.ts`, `main.ts`, `editor/shell.ts`, `vault/tree.ts`,
    `ui/find-bar.ts`, `view/markdown.ts`, `vault/context-menu.ts`,
    `ui/rails.ts`, `ui/export-dialog.ts`, `ui/dialogs.ts`,
    `ui/language-picker.ts`, `ui/zoom.ts`, `ui/cheatsheet.ts`.
  - 4 echte Type-Bugs/Inkonsistenzen gefunden + gefixt:
    `FolioEditor.setText`-Signatur (Language-Argument fehlte),
    `applyReplace`-Object-Shape (`{fullText, selectionStart, selectionLength}`
    statt erfundenem `{start, length, text}`), `listLanguages`-Return-Typ
    (`Array<{id,label,aliases}>` statt `string[]`),
    `main.ts:429` CustomEvent-Cast statt `Event.detail`.
  - 8 weitere Dateien gingen trivial durch (war nur prophylaktisch
    nocheck-markiert).

#### 5.3 — Frontend-Splits

`main.ts` ist nach Phase 4.6 weiterhin Orchestrator mit ~470 LOC,
zwei IIFEs, vielen inline-Listenern. `editor.ts` ist ~550 LOC monolitischer
Monaco-Adapter.

- [x] **`main.ts` aufteilen** ✓ Commit — vier neue Leaf-Module + Init-Router:
  - `ui/toolbar-actions.ts` (135 LOC) — `bind('tb-*')` + `applyCmd` + Tastatur-Shortcuts (Strg+1/2/S, Alt+←/→) + Statusbar-Theme-Toggle.
  - `ui/menu-router.ts` (87 LOC) — alle 14 `menu:*`-Listener (file_open/save/recent/close, edit_undo/redo/find, view_mode_*, view_theme_*, view_rail_*, help_cheatsheet, about). Nimmt `applyRailVisibility` als Dep.
  - `ui/drag-drop.ts` (25 LOC) — `tauri://drag-enter/over/leave/drop`.
  - `automation/events.ts` (61 LOC) — `automation:click`/`set_editor_text`/`open_document` + `folio-editor-text-updated`-CustomEvent (Editor-Text-Tracking, war im selben IIFE).
  - `main.ts` (175 LOC) ist jetzt Init-Router: Modul-Init in fester Reihenfolge + cross-modulare Backend-Event-Listener (shell:command/insertVaultChildren, navigation:changed-Restore, navigation:toc_click, panel:rail_changed-Sync, cli_pending_open/cli:open, Theme-Boot).
  - Beifang: `applyShellState` als Dead Code entfernt (war im alten main.ts definiert, nie aufgerufen). Bundle 46.9 → 46.2 KB.
- [x] **`editor.ts` splitten** in `web/editor/` ✓ Commit
  - `editor/state.ts` — Shared editor-/monaco-Instances + Suppression-Counter (`withProgrammaticWrite`, `isProgrammaticWrite`).
  - `editor/bridge.ts` — `post()` (Tauri-Event-Emit + synthetisches `folio-editor-text-updated`-CustomEvent).
  - `editor/find.ts` — Find-Subsystem: `findState`, `findOptions`, `matchDecorations`, `recomputeMatches`, `applyDecorations`/`clearDecorations`, `publishFindState`, `openFind`/`closeFind`/`setFindOptions`/`setFindTerm`/`findNext`/`findPrev`, `hasActiveTerm`.
  - `editor/events.ts` — `attachEditorListeners(editor, monaco)`: Find-Shortcuts (Ctrl+F/F3/Shift+F3), Save-Shortcut (Ctrl+S), `onDidChangeModelContent`, `onDidChangeCursorSelection`, RAF-debounced `onDidScrollChange`.
  - `editor/mount.ts` — Monaco-AMD-Load, `mount()`, `setText()`, `setTheme()`, `layout()`, `whenReady()`.
  - `editor/text.ts` — `getText`, `getLanguage`/`setLanguage`/`listLanguages`, `getSelection`/`setSelection`, `getScroll`/`setScroll`, `applyReplace`, `focus`, `undo`/`redo`.
  - `editor/index.ts` — Entry: assembliert `window.FolioEditor`.
  - **`suppressTextEvent`-Race aufgelöst**: Boolean ersetzt durch
    `programmaticWriteDepth`-Counter (nested-safe) in `state.ts`. Race
    zwischen `mount` und Programmatic Writes (`setText`, `setSelection`,
    `setScroll`, `setLanguage`, `applyReplace`) ist abgefangen — Pre-Mount-
    Calls deferren intern via `whenReady().then(...)` statt silent verloren
    zu gehen.
  - Build: `package.json::build` zeigt jetzt auf `editor/index.ts`; `tsconfig.json::include`
    auf `editor/**/*.ts`. Cargo-Smoke-Test (`smoke_frontend_assets.rs`) findet
    `window.FolioEditor=` im minified Bundle unverändert (Bundle-Size 7.6 KB,
    vorher ~ähnlich). 42 Vitest + alle Cargo-Tests grün, Clippy + Fmt sauber.
- [x] **`commands/app.rs` splitten** ✓ Commit
  - `commands/app/dialog.rs` — `pick_file`, `pick_folder`, `open_folder` + `file_path_to_string`-Helper + zwei Unit-Tests.
  - `commands/app/shell_opener.rs` — `show_in_file_manager`, `open_terminal_at` (Linux-Kandidatenliste, macOS `open -a Terminal`, Windows `wt`).
  - `commands/app/mod.rs` — Core-State-Commands: `set_view_mode`, `theme_get`/`theme_set`, `set_rail_visible`, `set_window_title`, `set_webview_zoom`, `open_find`, `cli_pending_open`.
  - `lib.rs::generate_handler!` nutzt jetzt explizite Submodul-Pfade (`commands::app::dialog::pick_file`, `commands::app::shell_opener::open_terminal_at`) — analog Phase-3-Stolperstein, `pub use` findet die `__cmd__*`-Companions nicht.
  - Beifang: trivialer No-Op-Test (`assert_eq!("open_folder", "open_folder")`) aus altem app.rs weggelassen.

#### 5.4 — Robustheit & Tests ✅ abgeschlossen

- [x] **`commands/file/save_as.rs` und `commands/file/rename.rs`**: ✓ Commit
      Lock-Fehler werden jetzt propagiert statt mit `if let Ok(...)`
      geschluckt. rename.rs zieht die drei separaten workspace-Lock-Blocks
      (was_in_recent → remove_recent → add_recent) in einen einzigen Take
      zusammen — vorher konnte ein Halb-Update entstehen, wenn der Lock
      zwischen den Blocks gepoisoned wurde. Auch die io::Result-Fehler
      aus `add_recent`/`remove_recent` (Persist auf Disk) werden
      propagiert statt via `let _ = …` geschluckt.
- [x] **`DocumentStore::load` + `reload_if_changed` DRY** ✓ Commit
      Privater Helper `fn read_and_decode(path) -> io::Result<(String, LineEnding, bool)>`
      extrahiert. BOM-/CRLF-/UTF-8-Decode-Logik liegt jetzt an einer Stelle.
- [x] **Frontend-Tests eingeführt** ✓ Commit — Vitest-Setup + 19 Tests:
  - Tooling: `vitest@2.1` als devDep, `jsdom@25` als DOM-Backend (happy-dom
    fiel raus, weil es `:scope >`-Selektoren nicht unterstützt, die in
    `vault/tree.ts` flächendeckend benutzt werden).
  - `vitest.config.ts` + `tests/setup.ts` (Default-`__TAURI__`-Mock pro
    Test) + `tests/helpers.ts` (`installTauriMock` mit Listener-Map +
    `emitEvent()`).
  - `state/document.test.ts` (7 Tests): `markDirty`/`updateWordCount`/
    `setStatusPath` Setter-Verhalten, fusionierter `document:loaded`-
    Handler, `document:closed`-Reset, `document:dirty_changed`-Forward,
    `document:external_changed` (reload bei clean, Warnung bei dirty).
  - `vault/tree.test.ts` (5 Tests): `setVaultActive`-Marker mit Cleanup,
    `toggleDir`-Expand/Collapse via Click + emitted `shell:event`,
    `insertVaultChildren`-DOM-Patch (caret, icon, data-loaded).
  - `ui/find-bar.test.ts` (5 Tests): `openEditorFind` View vs. Edit
    (FolioEditor vs. ViewFinder), `setEditorFindTerm` Term-Persistenz
    (input + setFindTerm bei offener Bar, open() bei geschlossener),
    `closeEditorFind` schliesst beide Finder (Race-Schutz).
  - `package.json::test` (`vitest run`) + `test:watch` Scripts.

#### 5.5 — Polish ✅ abgeschlossen

- [x] **`Vault::on_section_toggle`-Stub + `data-loaded`-Attribut raus** ✓ Commit
  - No-Op-Methode entfernt; die zwei Caller in
    `commands/events/vault::toggle_section` und
    `commands/vault_cmd::vault_toggle_section` machen jetzt nur noch
    `panel_state.set_section_expanded(...)` (die eigentliche Persistierung).
  - `data-loaded` aus `Vault::item_html` (Backend) und
    `app/vault/tree.ts::insertVaultChildren` (Frontend) entfernt — wurde
    seit Phase-~4.4-Auto-Refresh von niemandem mehr gelesen. Vitest-
    Assertion entsprechend angepasst.
- [x] **`commands/events/router.rs` Unknown-Event-Type loggen** ✓ Commit
  - `_ => Ok(())` durch `other => { eprintln!(...); Ok(()) }` ersetzt
    (für beide Channels). Modul-Doc um die kanonischen Event-Namen
    ergänzt — dient als Referenz beim Hinzufügen neuer Events.
- [x] **DevTools-Bridge dokumentieren** ✓ Commit
  - `window.__folioInvoke` und `window.openDocument` haben jetzt einen
    ausführlichen Kommentar in `main.ts` (Beispiel-Aufrufe für den
    Inspector + Hinweis "nicht versehentlich als unused entfernen").
    Eigenes `debug-bridge.ts`-Modul ist Overkill bei zwei Zuweisungen.
- [x] **`Cargo.toml` CRLF-Phantom-Diff** — bereits durch `2fc0ff1`
      (`.gitattributes` mit LF-Default) erledigt. `git ls-files --eol`
      zeigt alle Text-Files mit `i/lf w/lf`; kein Renormalize nötig.

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
| 5: Konsolidierung & Type-Safety | ✅ abgeschlossen | 5.1 ✓ + 5.1+ ✓, 5.2 ✓, 5.3a ✓ + 5.3b ✓ + 5.3c ✓ (`editor.ts`-Split + Suppression-Counter), 5.4 ✓, 5.5 ✓ |
