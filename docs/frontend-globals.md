# Frontend-Global-Contract (Stand Plan-Phase 4.2b)

Inventar aller Cross-Bundle-Brücken, Tauri-Event-Namen und Automation-API-
DOM-Selektoren, gegen die die Modul-Extraktion in Plan-Phase 4.3–4.5 läuft.
Read-only-Audit; keine Code-Änderungen. Quellen: `src-tauri/web/app/main.ts`,
`src-tauri/web/editor.ts`, `src-tauri/src/automation/`.

## 1. Cross-Bundle-Brücke (permanent global)

Wird zwischen `app.bundle.js` und `editor.bundle.js` (bzw. der Tauri-Runtime)
ausgetauscht. **Darf in Phase 4.6 nicht entfernt werden.**

| Name | Setter | Reader | Zweck |
|---|---|---|---|
| `window.FolioEditor` | `editor.bundle.js` (`editor.ts:587+`) | `app.bundle.js` (`main.ts:221, 322, 325, 336, 347, 351, 353, 355, 360, 363, 367, …`) | Monaco-Editor-Surface: `mount`, `setText`, `setSelection`, `setScroll`, `setTheme`, `layout`, `focus`, `getSelection`, `applyReplace`, `openFind`, `closeFind`, `setFindTerm`, `findNext`, `findPrev` |
| `window.__TAURI__` | Tauri-Runtime | beide Bundles | IPC: `core.invoke`, `event.emit`, `event.listen` |
| `window.monaco`, `window.require` | Monaco-AMD-Loader | `editor.bundle.js` | AMD-Loader-Globals (Monaco-Distribution) |
| `window.dispatchEvent` ↔ `folio-find-state` (CustomEvent) | `editor.bundle.js` (`editor.ts:37, 235`) | `app.bundle.js` (Find-Counter-UI) | Cross-Bundle-Push der Find-State-Updates aus Monaco |

## 2. Bundle-intern (Kandidaten für Module-Imports in 4.3–4.6)

Heute auf `window.*` gesetzt, aber **niemand außerhalb des Bundles greift
darauf zu** (Audit `editor.ts` und `src-tauri/src/automation/`). In Phase 4.6
auf `import { … } from "./modul"` umstellbar.

### TOC / View / Markdown (→ `view/markdown.ts` in 4.5)

`setTocActive`, `setTocList`, `scrollViewToAnchor`, `scrollViewTo`,
`rewriteRelativeAssets`, `ViewFinder` (Objekt mit `open/close/find/next/prev`).

### Editor-Bridge (→ `editor/shell.ts` in 4.5)

`loadEditorText`, `focusEditor`, `layoutEditor`, `setEditorTheme`,
`requestEditorSelection`, `applyEditorReplace`, `setEditorLanguageDisplay`,
`setEditMode`, `afterModeSwitch`.

### Find-Bar-Bridge (→ `ui/find-bar.ts` in 4.3)

`openEditorFind`, `closeEditorFind`, `setEditorFindTerm`, `findNext`,
`findPrev`.

### Vault (→ `vault/tree.ts` + `vault/context-menu.ts` in 4.4)

`setVaultPinned`, `setVaultRecent`, `insertVaultChildren`, `setVaultActive`,
`reapplyVaultActive`, `startInlineRename`.

### Cheatsheet (→ `ui/cheatsheet.ts` in 4.3)

`showCheatSheet`, `hideCheatSheet`, `cheatsheetSyncMode`,
`cheatsheetWantsVisible`, `syncCheatsheetMenu`, `__cheatSheetRows`.

### Dialoge (→ `ui/dialogs.ts` in 4.3)

`showRenameDialog` (Unsaved-Dialog ist nicht auf `window`).

### Rails (→ `ui/rails.ts` in 4.3)

`setRailVisibility`, `setTocWidth`, `setVaultWidth`.

### State (→ `state/document.ts` in 4.5)

`openDocument` (im Bundle gesetzt + intra-bundle gerufen; **kein** externer
Reader gefunden — könnte Bundle-intern werden, defensiv erstmal beibehalten).

### IPC-Wrapper

`__folioInvoke` (gesetzt in `main.ts:1192`, ausschließlich Bundle-intern
gerufen — kein externer Reader). Codex-Empfehlung: defensiv auf window
belassen, weil als Debug-Surface in DevTools nützlich.

## 3. Tauri-Event-Vertrag

**Stabile API-Namen — beim Modul-Split nicht umbenennen.**

### Backend → Frontend (Frontend hört via `listen`)

- `document:loaded` (UI-Render in IIFE #1, State-Update in IIFE #2 — werden in 4.5 fusioniert)
- `document:dirty_changed`, `document:closed`, `document:saved`
- `app:set_mode` (CSS-Toggle in IIFE #1, State in IIFE #2 — in 4.5 fusioniert)
- `app:set_theme`
- `vault:refresh` (Pinned/Recent in IIFE #1, Tree-Rebuild in IIFE #2 — in 4.4 fusioniert)
- `navigation:changed`, `navigation:toc_click`
- `editor:load_text`, `editor:apply_replace`, `editor:open_find`, `editor:set_find_term`
- `shell:command`
- `panel:rail_changed`
- `automation:click`, `automation:set_editor_text`,
  `automation:set_editor_selection`, `automation:open_document`,
  `automation:key`
- `cli:open`
- `menu:file_open`, `menu:file_save`, `menu:file_recent`, `menu:file_close`,
  `menu:edit_undo`, `menu:edit_redo`, `menu:edit_find`,
  `menu:help_cheatsheet`, `menu:help_about` *(letzteres als `menu:about`)*,
  `menu:view_mode_view`, `menu:view_mode_edit`, `menu:view_mode_split`,
  `menu:view_theme_light`, `menu:view_theme_dark`,
  `menu:view_rail_left`, `menu:view_rail_right`
- `tauri://drag-enter`, `tauri://drag-over`, `tauri://drag-leave`, `tauri://drag-drop`

### Frontend → Backend (Frontend ruft via `emit`)

- `shell:event` (über `post()`-Wrapper im IIFE #1 — Sammler für
  `linkClick`, `visibleHeading`, `scrollPosition`, `tocClick`, Drag/Drop etc.)
- `editor:event` (in `editor.ts`, Monaco-Lifecycle/Selection/Scroll)

Backend dispatcht beide über `commands/events/router.rs`.

### Frontend → Backend (Frontend ruft via `invoke`)

Tauri-Commands. Auswahl, vollstaendig in `commands/mod.rs` bzw.
`lib.rs::invoke_handler`:

- `automation_ack({ id })` — Frontend-Bridge bestaetigt nach Handler-Ende
  (Microtask + rAF), dass der Listener fuer `automation:click` /
  `automation:key` / `navigation:toc_click` durch ist. Backend nimmt den
  passenden oneshot-Sender aus `AppState.pending_acks` und gibt seinem
  HTTP-Endpoint frei. Siehe Abschnitt 5.

## 4. Automation-API-DOM-Vertrag

Backend-Code in `src-tauri/src/automation/` greift nicht direkt auf
`window.*`-Funktionen zu (kein `eval_script`). Kommunikation läuft
ausschließlich über Tauri-Events. **Aber:** der `automation:click`-Handler
im Frontend (`main.ts:2217-2228`) macht DOM-Lookup nach diesem Schema:

1. `document.getElementById(name)` — primärer Pfad.
2. `document.querySelector('[data-name="' + name + '"]')` — Fallback.
3. `document.querySelector(name)` — Selektor-Fallback.

**Implikation:** DOM-IDs und `data-name`-Attribute aus `dist/index.html`
sind Teil des Automation-Vertrags. Beim Modul-Split dürfen IDs/Attribute
**nicht umbenannt** werden. Bekannte stabile Selektoren (nicht erschöpfend,
Grep `id="tb-` / `id="view-region"` / `id="toc-region"` etc. für Vollbild):

- Toolbar-Buttons: `tb-back`, `tb-forward`, `tb-mode-view`, `tb-mode-edit`,
  `tb-mode-split`, `tb-find`, `tb-save`, `tb-cheatsheet`, `tb-zoom-*`,
  …
- Layout-Regionen: `view-region`, `editor-region`, `editor-mount`,
  `toc-region`, `vault-region`, `view-marker-lane`.
- Statusbar-Cells: `status-language`, `status-path`, `status-wordcount`,
  …
- Floating-UI: `cheatsheet-overlay`, `lang-picker`, `lang-picker-input`,
  `lang-picker-list`, `context-menu`, `dnd-overlay`, `zoom-indicator`,
  `rename-dialog`, `unsaved-dialog`, `export-dialog`.

## 5. Konsequenzen für Phase 4.3–4.6

- **4.3** (Leaf-Module): Pro extrahiertem Modul Imports statt `window.*`
  setzen. Window-Export nur dann beibehalten, wenn ein anderer (noch
  nicht extrahierter) Block in `main.ts` ihn liest. Sobald ALLE Reader
  Modul-intern sind, `window.*`-Assignment löschen.
- **4.4** (Vault): `vault:refresh`-Handler-Hälften aus beiden IIFEs in
  `vault/tree.ts` zusammenführen. Reihenfolge: pinned/recent → tree-rebuild.
- **4.5** (Core): `document:loaded`- und `app:set_mode`-Hälften analog
  fusionieren. Reihenfolge: State-Setup vor UI-Rendering.
- **4.6** (Bridge): Endzustand in `main.ts` ist ein einziger Re-Export-
  Block. Erwarteter Inhalt nach diesem Audit:
  ```ts
  // Cross-bundle / debug surface only. Everything else is module-internal.
  (window as any).__folioInvoke = __folioInvoke; // optional, defensiv
  (window as any).openDocument = openDocument;   // optional, defensiv
  ```
  Cheatsheet-, Vault-, Editor-, View-, Find-, Rails-, Dialog-`window.*`-
  Setter entfallen alle.

## Kein Bedarf für „use strict"

Sanity-Check Phase 4.2: `dist/app.bundle.js` enthält 0 `"use strict"`-
Direktiven. esbuild emittiert mit `--format=iife` non-strict-Code,
Original-Verhalten der zwei IIFEs bleibt erhalten. Codex' Risiko-Hinweis
hat sich nicht materialisiert.
