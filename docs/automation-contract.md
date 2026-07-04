# Automation- und Frontend-Vertrag

Diese Notiz hält die stabilen Integrationspunkte fest, die E2E-Tests,
Frontend-Module und Backend-Automation gemeinsam nutzen. Sie ersetzt alte
Refactoring-Audits; Historie gehört ins Git-Log, nicht in die laufende
Arbeitsdoku.

## Cross-Bundle-Surface

- `window.FolioEditor` kommt aus `src-tauri/web/editor/index.ts` und ist
  die Monaco-Editor-Surface für `app.bundle.js`.
- `window.FolioCodeView` stellt die read-only Monaco-Instanz für
  Nicht-Markdown-Dateien im View-Mode bereit.
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
- Vault: `.section`, `.node`, `.row`, `.caret`, `ul.children`,
  `data-path="<normalized-absolute-path>"`.

## Automation-API

Die HTTP-API läuft nur auf Loopback (`127.0.0.1:9876`). Die aktuelle Route-
Übersicht steht im README; die Szenario-Details in `tests/e2e/README.md`
und `docs/e2e-testing.md`.

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
