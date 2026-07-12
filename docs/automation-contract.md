# Automation- und Frontend-Vertrag

Diese Notiz hält die stabilen Integrationspunkte fest, die E2E-Tests,
Frontend-Module und Backend-Automation gemeinsam nutzen. Sie ersetzt alte
Refactoring-Audits; Historie gehört ins Git-Log, nicht in die laufende
Arbeitsdoku.

## Cross-Bundle-Surface

- `window.FolioEditor` kommt aus `src-tauri/web/editor/index.ts` und ist
  die Monaco-Editor-Surface für `app.bundle.js`.
- `window.FolioCodeView` stellt die read-only Monaco-Instanz für
  Nicht-Markdown-Dateien im View-Mode bereit. Die gemeinsame Folio-
  Find-Bar routet `POST /find/text`, Toolbar-/Menüsuche und DOM-
  Shortcuts auch auf diese Surface; Treffer werden über denselben
  `folio-find-state`-Pfad wie Editor/View-Suche gemeldet.
- `window.__TAURI__` kommt von der Tauri-Runtime.
- `window.__folioInvoke` und `window.openDocument` bleiben als bewusste
  DevTools-Debug-Surface erhalten.

Neue Frontend-Module sollen regulär über Imports kommunizieren. Neue
`window.*`-Exports nur ergänzen, wenn sie wirklich bundle- oder runtime-
übergreifend gebraucht werden.

## Tauri-Events

Diese Event-Namen sind Integrationsvertrag und dürfen nicht nebenbei
umbenannt werden:

- Backend zu Frontend: `document:loaded`, `document:dirty_changed`,
  `document:closed`, `document:saved`, `document:external_changed`,
  `tabs:changed`,
  `app:set_mode`, `app:set_theme`, `vault:refresh`,
  `vault:dir_changed`, `navigation:changed`, `navigation:toc_click`,
  `editor:load_text`, `editor:apply_replace`, `editor:open_find`,
  `editor:set_find_term`, `shell:command`, `panel:rail_changed`,
  `panel:split_mid_changed`, `automation:click`, `automation:rightclick`,
  `automation:key`, `automation:dom_query`, `automation:editor_command`,
  `automation:eval`,
  `automation:set_editor_text`, `automation:set_editor_selection`,
  `automation:open_document`, `automation:sync_render`, `cli:open`,
  `menu:*`.
- Frontend zu Backend: `shell:event` und `editor:event`.

Ack-fähige Automation-Pfade bestätigen über den Tauri-Command
`automation_ack({ id })`, nachdem der Frontend-Handler seine DOM-Mutation
abgeschlossen hat. Von Automation und normalen App-Pfaden gemeinsam
genutzte Events tragen dafür nur im Automation-Fall ein optionales
`requestId`: `app:set_theme`, `panel:rail_changed`,
`navigation:changed`, `panel:split_mid_changed` und `vault:refresh`.
`POST /sync/render` nutzt denselben Ack-Mechanismus
für einen reinen Render-Roundtrip ohne DOM-Mutation: der Handler
emittiert `automation:sync_render`, das Frontend wartet Microtask + zwei
Frames + laufende CSS-Transitions (capped) ab und ackt dann. Die E2E-
Suite ruft das vor jedem Screenshot statt eines fixen Sleeps.

## DOM-Vertrag

Die Automation-API klickt Elemente über diese Reihenfolge:

1. `document.getElementById(name)`
2. `document.querySelector('[data-name="' + name + '"]')`
3. `document.querySelector(name)`

IDs, `data-name` und zentrale `data-path`-Attribute in
`src-tauri/dist/index.html` und im Vault-Markup sind deshalb Testvertrag.
Beim Umbau von UI-Markup die E2E-Szenarien mitdenken und Selektoren nur
bewusst ändern.

Wichtige stabile Selektor-Gruppen:

- Toolbar: `tb-back`, `tb-forward`, `tb-mode-view`, `tb-mode-edit`,
  `tb-mode-split`, `tb-find`, `tb-save`, `tb-export`, `tb-cheatsheet`,
  `tb-image`.
- Layout: `view-region`, `editor-region`, `editor-mount`,
  `code-view-mount`, `html-view-frame`, `toc-region`, `vault-region`.
- Floating UI: `find-bar`, `cheatsheet-overlay`, `context-menu`,
  `rename-dialog`, `unsaved-dialog`, `export-dialog`, `image-dialog`.
- Settings-Tabs: `settings-tab-<slug>` und
  `[data-settings-tab="<slug>"]`.
- KI-Settings: `#settings-panel-ki-anbieter`,
  `#settings-panel-ki-modelle`, `#ai-provider-list` (enthält Katalog-
  UND Custom-Provider in einer Liste, sortiert aktiv → verwendbar →
  Rest), `#ai-model-list`, `#ai-model-search`, `#ai-default-model`,
  `#ai-catalog-refresh` und `#ai-catalog-updated`.
- KI-Provider-Zeilen: `[data-ai-provider-id="<providerId>"]`,
  `#ai-provider-enabled-<providerId>`,
  `[data-ai-auth-provider="<providerId>"]`,
  `#ai-auth-edit-<providerId>`, `#ai-auth-key-<providerId>`,
  `#ai-auth-save-<providerId>`, `#ai-auth-remove-<providerId>` sowie
  bei eigenen Providern `#ai-custom-edit-<providerId>` und
  `#ai-custom-delete-<providerId>`.
- KI-Custom-Dialog: `#ai-custom-dialog`, `#ai-custom-add`,
  `#ai-custom-form`, `#ai-custom-id`, `#ai-custom-name`,
  `#ai-custom-base-url`, `#ai-custom-key`, `#ai-custom-error`,
  `#ai-custom-save` und `#ai-custom-cancel`.
- KI-Modell-Zeilen: `[data-ai-model-provider="<providerId>"]`,
  `[data-ai-model-id="<modelId>"]`,
  `#ai-model-toggle-<providerId>-<modelId>`, für eigene Provider
  `#ai-models-fetch-<providerId>` sowie bei freigeschalteten Modellen
  `#ai-model-test-<providerId>-<modelId>`.
- KI-Chat-Test-Dialog: `#ai-chat-test-dialog`, `#ai-chat-test-meta`,
  `#ai-chat-test-messages`, `#ai-chat-test-input`,
  `#ai-chat-test-send`, `#ai-chat-test-close` und
  `#ai-chat-test-error`.
- KI-Übersetzung: `#ai-translate-dialog`, `#ai-translate-start`,
  `#ai-translate-cancel`, `#ai-translate-error`, `#ai-translate-model`,
  `#ai-translate-lang-<code>` für die Presets
  (`en,de,fr,es,it,pt,nl,pl,ja,zh`) und
  `#ai-translate-langs-extra`. Der Automation-Menüpfad verwendet die ID
  `edit.ai_translate`.
- KI-Aktionen (✨): Toolbar `#tb-ai-actions` + Split-Button-Caret
  `#tb-ai-actions-menu` (Popover `#ai-actions-fav-menu` mit
  `[data-ai-fav-run="<id>"]`); Dialog `#ai-actions-dialog`,
  `#ai-actions-list` mit `[data-action-id="<id>"]`
  (Custom-Eintrag `__custom__`), `[data-ai-action-fav="<id>"]`
  (★-Toggle), `[data-ai-action-delete="<id>"]`, `#ai-actions-prompt`,
  `#ai-actions-target-newfile`/`#ai-actions-target-replace`,
  `#ai-actions-scope-selection`/`#ai-actions-scope-document`,
  `#ai-actions-model`, `#ai-actions-error`, `#ai-actions-start`,
  `#ai-actions-cancel`, `#ai-actions-save-template` + Overlay
  `#ai-actions-save-overlay` (`#ai-actions-save-name`,
  `#ai-actions-save-id`, `#ai-actions-save-ok`,
  `#ai-actions-save-cancel`, `#ai-actions-save-error`); Statusleiste
  `#ai-action-status` + `#ai-action-status-cancel`; Diff-Review
  `#ai-diff-region` (Body-Klasse `ai-diff-open`), `#ai-diff-apply`,
  `#ai-diff-discard`, `#ai-diff-hint`; generischer
  Bestätigungsdialog `#confirm-dialog` (`#confirm-ok`/
  `#confirm-cancel`). Der Automation-Menüpfad verwendet die ID
  `edit.ai_actions`; Events: `ai:action_started` (runId+requestId),
  `ai:action_stream` (runId, chars, bei NewFile tabId+text),
  `ai:action_done` (runId, ok, error?).
- View-Theme: `#view-theme-style`, `body[data-view-theme="<id>"]`,
  `#settings-theme-list`, `#settings-theme-hint` und
  `[data-view-theme="<id>"]`, `[data-view-theme-fav="<id>"]`.
- Export-Layouts: `#export-cards`, `[data-layout-id="<id>"]`,
  `#export-more-toggle` und `#export-more-cards`.
- Vault: `.section`, `.node`, `.row`, `.caret`, `ul.children`,
  `data-path="<normalized-absolute-path>"`.

## Automation-API

Die HTTP-API läuft nur auf Loopback (`127.0.0.1:9876`). Die aktuelle Route-
Übersicht steht im README; die Szenario-Details in `tests/e2e/README.md`
und `docs/e2e-testing.md`.

`GET/POST /settings` transportiert unter anderem die persistierten Felder
`viewTheme` und `themeFavorites`. Erlaubte Theme-IDs kommen aus dem
Tauri-Command `view_themes`; das sind die Built-ins sowie die bei jedem
Aufruf frisch aus `<config>/folio/themes/` gelesenen Custom-Theme-IDs.
`themeFavorites` ersetzt beim Patch die gesamte geordnete Liste;
`standard` ist darin nicht erlaubt. `openFileTarget`
(`newtab` Default | `replace`) steuert, ob extern geoeffnete Dateien
(Single-Instance-Reinvoke) einen neuen Tab bekommen oder das Dokument im
aktiven Tab ersetzen. Unbekannte oder ungueltige Werte werden
beim Patch mit HTTP 400 abgelehnt.

### Tabs

`GET /tabs` liefert
`{ "tabs": [{ "id", "path", "dirty", "active" }], "activeIndex": 0 }`.
`tabs:changed` verwendet dasselbe Payload. Dieselbe Liste steht in
`GET /state` unter `tabs`. Pfade sind wie im restlichen Backend auf
Forward-Slashes normalisiert.

- `POST /tabs/open { "path": "..." }` öffnet die Datei in einem neuen,
  aktiven Tab direkt hinter dem bisher aktiven Tab. Ist der normalisierte
  Pfad bereits offen, wird nur dessen Tab aktiviert.
- `POST /tabs/activate { "id": 2 }` aktiviert einen vorhandenen Tab.
- `POST /tabs/close { "id": 2, "discard": false }` schließt einen Tab.
  Dirty-Tabs werden ohne explizites `discard: true` mit HTTP 409 abgelehnt.
- `POST /tabs/close_all {}` verwirft alle Dirty-Zustände und hinterlässt
  genau einen aktiven, leeren Tab. Der Endpunkt ist ausschließlich für
  E2E-Isolation vorgesehen.
- `POST /tabs/reorder { "ids": [3, 1, 2] }` sortiert die Dokument-Tabs
  (nur IDs dokumenttragender Tabs) exakt in die angegebene Reihenfolge
  um. Muss eine Permutation aller aktuellen Dokument-Tab-IDs sein,
  sonst 400. Virtuelle Tabs (Settings, Theme-Editor) sind ausgenommen
  und kein Drop-Ziel. Kein Ack-Response (reiner Order-Change, tabs:changed
  wird emittiert und persistiert die Session).

Open, Aktivierung und das Schließen des aktiven Tabs antworten im
Ack-Format `{ ok, acked, requestId, tab }`. Das Ack kommt über das
anschließende `navigation:changed` und bestätigt damit, dass der bestehende
`document:loaded`- bzw. `document:closed`-Frontend-Pfad einschließlich
Mode-/Scroll-/Cursor-Restore verarbeitet wurde. Beim Schließen eines
inaktiven Tabs ist kein Frontend-Dokumentwechsel nötig (`acked: false`,
`requestId: null`). Unbekannte IDs liefern HTTP 404, Dirty-Reject HTTP 409
und ungültige oder nicht existente Dateipfade HTTP 400.

### Find

- `POST /find` öffnet die Find-Bar (ohne Term/Optionen).
- `POST /find/text { "term": "Suchbegriff", "caseSensitive": true, "wholeWord": false }`
  öffnet die Find-Bar, setzt den Term und (optional) die Flags `caseSensitive`/`wholeWord`
  deterministisch. Fehlende optionale Felder ändern den UI-Checkbox-Zustand nicht
  (Kompatibilität). Der Aufruf emittiert `editor:open_find` dann `editor:set_find_term`
  mit dem vollen Payload; kein Ack (wie andere reine UI-Öffner). Die Find-Bar
  ignoriert Aufrufe bei `kind-image`/`kind-binary`.

### Vault-Suche

`POST /search` durchsucht die angepinnten Vault-Einträge (bzw. einen Ordner)
und liefert das **komplette** Ergebnis synchron zurück (kein Streaming, kein
Frontend-Roundtrip — die Route ruft den Suchkern direkt in einem
Blocking-Task).

Request:

```json
{
  "query": "needle",
  "scope": "/abs/pfad/zum/ordner",
  "caseSensitive": false,
  "wholeWord": false,
  "timeoutMs": 5000
}
```

- `query` (Pflicht): Suchbegriff, wird als Literal gematcht (kein Regex).
  Mindestlänge **2 Zeichen** (Zeichen, nicht Bytes) → sonst HTTP 400.
- `scope` (optional): absoluter Ordnerpfad → durchsucht genau diesen Ordner
  rekursiv. Fehlt/`null` → **gesamter Vault** (Union aller angepinnten Ordner
  rekursiv + angepinnter Einzeldateien; „Zuletzt geöffnet" ist nicht Teil des
  Scopes). Ein nicht existenter Ordner-Scope → HTTP 400. Tote Pins im
  Vault-Scope werden still übersprungen. In der WebView entspricht `scope`
  dem Ordner-Scope-Chip (Kontextmenü „In diesem Ordner suchen" → `vault/search.ts`);
  ein relativer/gelöschter Scope liefert im Command-Pfad `InvalidScope`/`RootNotFound`,
  worauf das Frontend den Chip entfernt und vault-weit weitersucht.
- `caseSensitive`/`wholeWord` (optional, Default `false`): Groß-/Kleinschreibung
  bzw. ganze Wörter (Unicode-Wortgrenzen). Case-insensitive nutzt Unicode
  *simple* case folding (`ß` faltet auf sich selbst, nicht auf `ss`).
- `timeoutMs` (optional): Zeitlimit; danach wird der Lauf abgebrochen und
  HTTP 500 geliefert.

Filter (wie die Vault-Engine): nur `FileKind::Markdown`/`Text`, gitignorierte
und versteckte (Dotfile-)Einträge werden übersprungen, Dateien > 2 MiB und
solche mit NUL-Bytes in den ersten 8 KiB ebenfalls (Letztere in `stats`
gezählt bzw. gar nicht gelesen). **Explizit gepinnte Einzeldateien werden immer
durchsucht** — hidden-/gitignore-Filter gelten nur für den Verzeichnis-Walk
(bewusst: Pin = Nutzer-Intention); Kind-/Größen-/NUL-Filter bleiben.

Response:

```json
{
  "files": [
    {
      "path": "/abs/pfad/note.md",
      "fileName": "note.md",
      "hits": [
        {
          "line": 12,
          "colUtf16": 6,
          "lenUtf16": 6,
          "snippet": "äß😀 needle …",
          "snippetOffsetUtf16": 0,
          "ranges": [[5, 6]]
        }
      ],
      "truncated": false
    }
  ],
  "stats": {
    "filesScanned": 3,
    "filesMatched": 1,
    "hits": 1,
    "skippedLarge": 0,
    "truncated": false,
    "elapsedMs": 4
  }
}
```

Feldsemantik:

- Ein `hit` entspricht **einer Treffer-Zeile** mit allen Match-Ranges dieser
  Zeile. `line` ist 1-basiert.
- **Spalten in UTF-16-Code-Units** (Monaco-Konvention): `colUtf16` (1-basiert)
  und `lenUtf16` beziehen sich auf den ersten Treffer der Zeile.
- `snippet` ist die Zeile ohne `\r`; überlange Zeilen werden um den ersten
  Treffer gefenstert. `snippetOffsetUtf16` ist der UTF-16-Offset, an dem der
  Snippet in der Originalzeile beginnt (0, wenn nicht gefenstert).
- `ranges` sind `[startUtf16, lenUtf16]`-Paare, **0-basiert relativ zum
  `snippet`** (für `<mark>`-Markup: `snippetOffsetUtf16 + range.start ==
  colUtf16 - 1` für den ersten Treffer).
- Caps: max. 50 Treffer-Zeilen pro Datei (`file.truncated`), max. 500
  Treffer gesamt (`stats.truncated`) — kein stilles Abschneiden.
- Pfade sind Forward-Slash-normalisiert.

Die WebView nutzt für die Live-Suche stattdessen die Tauri-Commands
`vault_search_start { query, scope?, caseSensitive, wholeWord } → runId` und
`vault_search_cancel { runId }` mit den Events `search:hits { runId, files }`
und `search:done { runId, stats }` (bzw. `{ runId, error }`). `POST /search`
bündelt diesen Ablauf synchron für die Tests.

### Security-Gates (Middleware `security_guard`)

Alle Requests durchlaufen vier Prüfungen (`automation/middleware.rs`):

1. **Loopback-Peer**: Nicht-Loopback-IPs → 403.
2. **Host-Header-Allowlist** (`127.0.0.1:9876`, `localhost:9876`,
   `[::1]:9876`): blockt DNS-Rebinding. Fehlender/fremder Host → 403.
3. **Origin-Allowlist**: Requests **ohne** Origin-Header (curl, Python
   requests) sind erlaubt, bekommen aber keine CORS-Header. Mit Origin sind
   nur die Tauri-WebView-Origins erlaubt (`http(s)://tauri.localhost`,
   `tauri://localhost`) — der erlaubte Origin wird im
   `Access-Control-Allow-Origin`-Header gespiegelt (kein `*` mehr, plus
   `Vary: Origin`). Fremde Origins und `Origin: null` → 403; damit kann
   keine Webseite im Browser des Users die API per `fetch` nutzen oder
   Antworten lesen.
4. **Optionales Token**: Ist die Env-Var `FOLIO_AUTOMATION_TOKEN` beim
   App-Start gesetzt, muss jeder Nicht-OPTIONS-Request denselben Wert im
   Header `x-folio-automation-token` mitschicken.

**Release-Gate**: Im Release-Build startet der Server nur, wenn die Env-Var
`FOLIO_AUTOMATION=1` gesetzt ist (Debug-Builds: immer an).
`scripts/run-e2e.sh` und `tests/e2e/run.py` setzen sie automatisch; wer das
Release-Binary manuell für Automation startet, muss sie selbst setzen.
