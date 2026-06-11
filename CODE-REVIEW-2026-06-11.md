# Code-Review — Gesamtprojekt (Stand 2026-06-11, HEAD `d1f05e5`)

Review-Methodik: vier parallele Review-Agenten (Rust-Core, Automation-API,
Frontend, Tests/Build), High-Findings anschließend manuell am Code verifiziert.
`cargo clippy --all-targets -- -D warnings` und `cargo fmt --check`: **sauber**.

Status-Legende: `[ ]` offen · `[x]` erledigt · `[-]` verworfen/akzeptiert.

---

## Kritisch

### [x] K1 — Automation-API: CORS `*`, kein Host-Check, aktiv im Release-Build
**Behoben (2026-06-11):** `security_guard`-Middleware mit Host-Allowlist,
Origin-Allowlist (gespiegelt statt `*`, `Origin: null` → 403, keine
CORS-Header für Origin-lose Requests), optionalem Token
(`FOLIO_AUTOMATION_TOKEN`); Release-Gate via `FOLIO_AUTOMATION=1`
(run-e2e.sh/run.py setzen es). 6 neue Smoke-Tests + 3 Middleware-Unit-Tests.
Codex-Zweitmeinung eingeholt und eingearbeitet.
**Verifiziert.** `automation/middleware.rs:27-45` setzt
`Access-Control-Allow-Origin: *`, prüft weder Origin noch Host-Header; der
Server startet in `lib.rs` unkonditioniert (kein `cfg(debug_assertions)`,
kein Opt-in). Der Loopback-Filter (`middleware.rs:17`) schützt nicht gegen
den Browser des Users: jede besuchte Webseite kann per
`fetch('http://127.0.0.1:9876/eval', …)` beliebiges JS im WebView ausführen,
`/editor/text` exfiltrieren, Dateien speichern oder die App per `/quit`
killen — und dank `*` die Antworten auch lesen. DNS-Rebinding umgeht
zusätzlich jede CORS-Schranke.
**Fix:** Origin-/Host-Allowlist statt `*`; Server hinter Opt-in
(Env-Var/Feature, Release default-aus); optional Token pro Lauf.

### [ ] K2 — History-Back/Forward auf Bild-Einträge bricht und desynct die History
**Verifiziert.** `commands/nav.rs:165-170` ruft `document_store.load()` ohne
die `FileKind::Image`-Verzweigung aus `document_service::open`
(`load_opaque`). Bilder erzeugen aber History-Einträge. Back über ein PNG →
`String::from_utf8` schlägt fehl; weil `go_back()` schon vorher lief, zeigt
der History-Index aufs Bild, die UI aufs alte Dokument — alle weiteren
Navigationen arbeiten ab dem falschen Index. SVG (gültiges UTF-8) wird als
Textdokument geladen. Zusätzlich clampt `NavEntry::from` (nav.rs:27-33)
Images auf `"edit"`, obwohl Edit für Images gesperrt ist.
**Fix:** Load-Verzweigung in gemeinsamen Helper ziehen (`classify()` →
`load_opaque` für Image), Index erst nach erfolgreichem Load committen;
`NavEntry::from` clampt Images auf `"view"`.

### [ ] K3 — `initExportDialog` doppelt initialisiert → Doppel-Export + Keydown-Leak
**Verifiziert.** `main.ts:88` **und** `toolbar-actions.ts:42` rufen beide
`initExportDialog`; kein Guard (`export-dialog.ts:129`). Alle Listener
doppelt → „Speichern" startet zwei Exporte; `openExportDialog` registriert
zwei `keydown`-Handler auf `document`, `closeExportDialog` entfernt nur den
letzten — der erste leakt permanent. `selectedLayoutId` wird beim Close nie
genullt → danach kann jede Enter-Taste app-weit `doExportSave` auslösen.
**Fix:** Aufruf in `toolbar-actions.ts` entfernen (main.ts kanonisch);
`selectedLayoutId = null` in `closeExportDialog`.

### [ ] K4 — `suppressActive`-Leak: View-/HTML-Find nach Split-Mode kaputt
**Verifiziert.** `find-bar.ts:37/47` setzt im Split-Mode
`setSuppressActive(true)`; `close()` (find-bar.ts:105-107) und
`afterModeSwitch()` (153-155) rufen die Finder aber direkt — nur der
Split-Wrapper (Zeile 42) setzt zurück. `suppressActive` bleibt `true` →
jede spätere Suche im View-Mode: kein aktiver Treffer, kein Scroll,
`findNext`/`findPrev` wirkungslos.
**Fix:** `closeFind` in `view/markdown.ts` und `view/html.ts` setzt
`suppressActive = false` selbst (deckt alle Aufrufpfade ab).

### [ ] K5 — E2E: Exceptions außerhalb `ctx.step()` → stilles PASS; kein try/finally
**Verifiziert.** `tests/e2e/run.py:189-192` schluckt jede Exception aus
`run_fn`; außerhalb eines Steps (Pre-Loop `18_history.py:38-41`, Setup in
16/17/19) wird `_aborted_with` nie gesetzt → Szenario PASS mit 0 Steps.
Außerdem kein try/finally um Szenario-Loop: Ctrl+C mitten in 11/15
hinterlässt verschmutzte Fixtures, die der nächste Run als „pristine"
snapshottet (run.py:155) → persistente Visual-Diffs.
**Fix:** Nicht-`ScenarioAbort`-Exceptions in `ctx` als Abort registrieren;
Loop + Teardown (`restore_fixtures`, `app.stop`) in try/finally.

---

## Mittel

### [ ] M1 — Quit ohne Dirty-Prompt
`menu/events.rs:44-46`: `FILE_QUIT` → direkt `app.exit(0)`; Fenster-X wird
gar nicht abgefangen (kein `CloseRequested`-Handler in lib.rs). Ungespeicherte
Änderungen weg; `file.close` hat dagegen einen Prompt.
**Fix:** `menu:file_quit`-Event ans Frontend (Prompt dort, dann exit) +
`CloseRequested`-Handler mit `prevent_close()`.

### [ ] M2 — Heading-Anchor-Preprocess schreibt in Fenced-Code-Blöcke
`heading_anchor.rs:37-43`: Regex läuft über den Rohtext ohne Fence-Erkennung.
`# Title <a id="x"></a>` in einem ```-Codeblock wird zu `# Title {#x}`
umgeschrieben — Codeblock-Inhalt verfälscht (View + TOC).
**Fix:** Fence-Tracker beim Zeilen-Scan oder Verlagerung in den
AST-Postprocess (wie das Explicit-ID-Stripping).

### [ ] M3 — `write_file`-Command umgeht BOM/CRLF-Konvention (toter Code)
`commands/file/read.rs:62-77`: schreibt roh via `fs::write`, ohne
`had_bom`/`line_ending`-Restauration; setzt bei offenem Dokument zusätzlich
`store.text` + `dirty=false`. Kein Aufrufer im Frontend.
**Fix:** Command entfernen oder auf DocumentStore-Semantik umstellen.

### [ ] M4 — `ensureEditorMounted` ohne In-Flight-Guard → Monaco-Doppel-Mount
`editor/shell.ts:37-53`: `document:loaded` (→ `loadEditorText`) und
`app:set_mode` (→ `focusEditor`) können parallel mounten — beide sehen
`editorMounted === false`. Der erste Mount konsumiert
`pendingMinimapEnabled` (mount.ts:116-118) → der überlebende zweite Editor
startet mit `minimap: false`; zudem Model-Leak (extern gesetzte Models
werden bei dispose nicht mit-disposed).
**Fix:** Laufendes Mount-Promise in Modul-Variable cachen.

### [ ] M5 — `loadEditorText` ohne `language` zerstört Sprache + Undo-Stack
`automation/events.ts:392` und `editor/shell.ts:151` rufen
`loadEditorText(text)` ohne language → Default `'plaintext'` → `doSetText`
erzeugt frisches Plaintext-Model, disposed das alte: Highlighting + kompletter
Undo-Stack weg, obwohl nur Text ersetzt werden sollte.
**Fix:** Bei fehlendem Argument aktuelle Model-Sprache beibehalten.

### [ ] M6 — Code-View zeigt nach Save veralteten Inhalt
`state/document.ts` (`document:saved`-Handler bzw. `renderDocumentPayload`):
`FolioCodeView` wird nur im `document:loaded`-Pfad gemountet/aktualisiert.
JSON-Datei editieren + speichern + auf View schalten → alter Stand.
**Fix:** Im saved-Pfad für `kind === 'text' && !isHtml` ebenfalls
`FolioCodeView.setText/mount` aufrufen.

### [ ] M7 — Ctrl+Z/Ctrl+Shift+Z im View-Mode editiert unsichtbar
`ui/toolbar-actions.ts:244-259`: Kommentar behauptet, undo/redo seien im
View-Mode No-Ops — stimmt nicht, der Editor bleibt nach erstem
`document:loaded` gemountet. Undo am versteckten Editor → `markDirty` +
Live-Preview rendert den rückgängig gemachten Text.
**Fix:** Fallback auf `edit-mode || split-mode` gaten.

### [ ] M8 — `HtmlFinder`-States ohne `source: 'view'` → Counter-Korruption im Split-HTML-Mode
`view/html.ts:399-415` dispatcht ohne `source`; der Filter in
`find-bar.ts:268` (`isSplitMode() && s.source === 'view'`) greift nicht →
View-State kann den Monaco-Zähler überschreiben.
**Fix:** `source: 'view'` in `dispatchState`/`dispatchProgress` ergänzen
(analog `markdown.ts:215/229`).

### [ ] M9 — E2E-Isolation-Leaks (13, 20, 16/19)
- `13_menu_view.py`: endet mit Theme=light und versteckter rechter Rail —
  leakt in alle Folgeszenarien, Baselines kodieren das.
  **Fix:** am Ende `theme("dark")` + `rail("right", visible=True)`.
- `20_toc_click.py:23-25`: setzt View-Mode nicht explizit
  (`default_mode_markdown = Current`) — exakt das dokumentierte
  22_html_view-Fehlermuster. **Fix:** `ctx.api.mode("view")` nach open.
- `16_vault_tree.py` / `19_context_menus.py`: Cleanup (unpin) als regulärer
  Step → läuft nach Step-Fail nie; Pin leakt in workspace.json des
  Test-Profils. **Fix:** Cleanup in try/finally bzw. `ctx.defer(...)`.

### [ ] M10 — `Cargo.lock` ist gitignored
`.gitignore:2`. Für eine Binary-App gehört der Lockfile eingecheckt
(package-lock.json ist getrackt). Ohne ihn sind E2E-Binary und
Visual-Baselines nicht reproduzierbar.
**Fix:** aus .gitignore nehmen, einchecken.

### [ ] M11 — `view/preview.ts` ohne Testabdeckung
Genau die in CLAUDE.md als regressionsträchtig dokumentierten Invarianten
(renderGen-Verwurf verspäteter Antworten, `invalidatePreview` bei
loaded/saved/closed, bewusst kein isDirty-Gate, Live-Fetch im Timer) sind
ungetestet.
**Fix:** jsdom-Test mit gemocktem `render_markdown_preview`.

---

## Niedrig

### [ ] L1 — `DocumentStore::load` mutiert State vor `watch()`
`document_store.rs:67-88` (analog `save_as`, `rename_to`): schlägt der
notify-Watch fehl, ist der Store auf dem neuen Dokument, aber der
`loaded`-Callback hat nie gefeuert; bei `save_as` ist die Datei schon
geschrieben, der Caller bekommt trotzdem Err.
**Fix:** Watch-Fehler nicht-fatal (warn-Log), Callback immer feuern.

### [ ] L2 — TOC dedupliziert explizite Heading-IDs nicht
`toc.rs:46-53` vs. `renderer.rs:303-309`: Renderer schickt alle IDs durch
`unique_slug`, toc.rs nicht → bei Kollision (`Foo` + `{#foo}`) springt der
TOC-Klick zum falschen Heading.
**Fix:** explizite IDs in toc.rs ebenfalls über `unique_slug`/`used_slugs`.

### [ ] L3 — Oneshot-Map-Leak bei Client-Disconnect vor Timeout
`automation/ack.rs:44-59` (analog eval/dom/wait): Future-Drop bei
Client-Abbruch überspringt den Cleanup im Timeout-Zweig → Map-Einträge
wachsen unbegrenzt.
**Fix:** RAII-Guard (Drop entfernt ID aus der Map).

### [ ] L4 — Drei `serde_json::to_value(...).unwrap()` auf Request-Pfaden
`automation/handlers/ui.rs:367/398/480`.
**Fix:** `.map_err(ApiError::internal)?`.

### [ ] L5 — `/eval` umgeht den einheitlichen JSON-Fehler-Wrapper
`automation/handlers/eval.rs:35`: nimmt `Json<EvalRequest>` direkt statt
`Result<Json<T>, JsonRejection>` + `json_payload` → Plaintext-400 statt
`ErrorResponse{error}`.

### [ ] L6 — Panel-State bei jedem Resize-/Move-Tick synchron auf Disk
`lib.rs:92-127` + `panel_state.rs:123-139`: `save_json_atomic` pro Tick im
UI-Thread-Eventhandler.
**Fix:** Debounce (~250 ms) oder Persist bei Fokusverlust/Exit.

### [ ] L7 — Pfad-Normalisierung endet am Workspace/Vault
`DocumentStore.path` und NavigationController-Einträge übernehmen rohe
Pfade (Datei-Dialog liefert Backslashes) → Dedupe/`ReloadPolicy::
IfPathChanged`/`store.path == path`-Vergleiche greifen bei gemischter
Öffnungsart nicht.
**Fix:** Normalisierung am Eingang von `document_service::open` (+
`perform_rename`).

### [ ] L8 — Image-Paste im Split-Mode tot
`ui/paste-handler.ts:17`: `isInEditorScope` verlangt `edit-mode`.
**Fix:** `edit-mode || split-mode`.

### [ ] L9 — Dialog-Keydown-Zombie bei fehlgeschlagenem Open
`ui/settings-dialog.ts:128-147` (Muster auch about-dialog.ts:29,
image-dialog.ts:511): Handler vor Anzeige registriert; `close` returnt bei
`dlg.hidden` vor dem `removeEventListener`.
**Fix:** Handler erst nach erfolgreichem Anzeigen registrieren / Removal vor
den Early-Return.

### [ ] L10 — `suppressNextClick` kann hängenbleiben
`vault/tree.ts:483-511`: pointerup außerhalb der Vault-Region → Capture-
Listener feuert nie, Flag bleibt true; nächster Klick auf Header-Buttons
(addFile/addFolder) wird geschluckt.
**Fix:** Flag im pointerup per `setTimeout(0)` zurücksetzen oder Listener
auf `document`.

### [ ] L11 — Mixed Line-Endings still vereinheitlicht + ungetestete Save-Kombis
`document_store.rs:330-336` + `save()`: CRLF+LF-Mix wird als CRLF
klassifiziert, Save vereinheitlicht alles; lone-`\r` bleibt stehen. Unit-Tests
decken nur BOM+CRLF; BOM+LF / noBOM+CRLF / noBOM+LF („Save fügt kein BOM
hinzu") nur im Linux-only-E2E.
**Fix:** vier Kombis als parametrisierte Unit-Tests; Mixed-Verhalten
dokumentieren oder Mehrheitsentscheid.

### [ ] L12 — E2E-Kleinkram
- `08_save_roundtrip.py:44`: `eol == b'\\r\\n'` (4-Byte-Literal, immer
  False) → Step-Labels falsch (Assertions selbst korrekt).
- `18_history.py:38-41`: `while True`-Pre-Loop ohne Cap → Regression am
  Stack-Edge hängt die Suite. **Fix:** `for _ in range(100)`.
- `lib/visual.py:162-166`: Luminanz-Diff blind für reine
  Blaukanal-Änderungen; 1 %-Schwelle (~10 240 px) schluckt Statuszeilen-Text.
- `scripts/run-e2e.sh` + `run.py:124-129`: Folio-Konsole landet nicht im
  Artefaktordner (nur Platzhalter), `/tmp/folio-stdout.log` wird überschrieben.

### [ ] L13 — Stille Fehler / Konventionsverstöße
- `workspace.rs:94-96`: `let _ = workspace.save();` bei Boot-Migration ohne Log.
- `vault.rs:366`: `unwrap_or_default()` rendert expandierten Ordner leer ohne warn.
- `automation/events.ts:458`: `invoke('editor_text_changed', …).catch(function(){})`
  statt `safeInvoke(..., 'debug')`; `vault/tree.ts:250-253` nutzt `console.warn`
  statt `folioLog`.
- `state/document.ts:273` + `view/html.ts:319`: `/\.html?$/i`-Endungs-Fallback
  im Frontend (Verstoß gegen „kind ist Source of Truth" — ggf. als bewusster
  Backstop dokumentieren).

### [ ] L14 — Renderer-Kleinigkeiten
- `renderer.rs:123-141`: Tasklist-Normalisierung per nicht-nesting-aware
  Regex → äußere normale `<ul>` mit Task-Subliste bekommt
  `contains-task-list` (nur kosmetisch).

### [ ] L15 — `vault_expand_dir`/`vault_collapse_dir`-Commands ohne Watcher-Sync
`commands/vault_cmd.rs:5-22`: mutieren nur `expanded_dirs`, registrieren
keinen Watch (der Event-Pfad in `events/vault.rs` tut beides). Aufrufer ist
nur ein vermutlich toter `.vault-item`-Klickpfad in `vault/tree.ts:350`.
**Fix:** auf Event-Handler delegieren; toten Frontend-Pfad entfernen.

### [ ] L16 — Sonstiges
- `file_icon/mod.rs:120-124`: Test ohne Assertion (prüft nur „panict nicht").
- `tauri.conf.json`: `assetProtocol.scope: ["**"]` = voller FS-Lesezugriff
  aus der WebView; in Kombination mit HTML-View-iframe
  (`allow-same-origin allow-scripts`) ist der Sanitizer die einzige Barriere.
  Mindestens als bewusste Entscheidung dokumentieren.
- `editor/mount.ts` Pre-Mount-Pfad (f4ef8f1-Bug) ohne Regressionstest.

### [x] L17 — `integration_file.rs`: zwei Tests schlagen auf Windows fehl (vorbestehend)
**Behoben (2026-06-11):** Erwartungswerte auf Forward-Slashes normalisiert.
**Beim Umsetzen von K1 entdeckt, am unveränderten HEAD verifiziert.**
`tests/integration_file.rs:53` und `:89` asserten `current.to_string_lossy()`
(Windows: Backslashes) gegen `workspace.recent()[0].path` — der ist per
Konvention auf Forward-Slashes normalisiert (`Workspace::add_recent`). Auf
Linux grün, auf Windows rot → `cargo test` ist auf Windows-Dev-Maschinen
nie sauber durchgelaufen.
**Fix:** Erwartungswert im Test normalisieren (`replace('\\', "/")`) bzw.
über `file_resolver::paths_equal` vergleichen.

---

## Explizit sauber (geprüft, keine Findings)

`view/preview.ts` (Implementierung vorbildlich, nur ungetestet),
`editor/mount.ts` (Pre-Mount-Muster, Single-AMD-Loader), `applyReplace`
(executeEdits + pushUndoStop), Pin-Pointer-Drag inkl. vollständiger
jsdom-Tests, `navigation.rs`-Gates, BOM/CRLF-Kern in `document_store.rs`,
`vault_watcher.rs` (watch/unwatch symmetrisch, dispose sauber),
`workspace.rs`-Pfad-Normalisierung inkl. Boot-Migration, `panel_state.rs`,
`logging.rs` (RUST_LOG-Sperre, Fallbacks), `editor_commands/`
(UTF-16↔Byte-Konvertierung, clamps), oneshot/Ack-Mechanik (Timeouts,
idempotentes deliver, keine Locks über await), Mutex-Hygiene im gesamten
Backend, Console-Hook-Canceled-Filter, `getFinder()`-Routing-Matrix,
Build-Pipeline (package.json-Reihenfolge, copy-monaco.js, dist/ ohne
npm-Artefakte, .gitattributes), `lib/api.py`/`lib/app.py` der E2E-Suite,
`/sync/render`-Verdrahtung vor jedem Screenshot.

---

## Empfohlene Reihenfolge

1. ~~**K1** — Security-Paket Automation-API~~ ✓ erledigt 2026-06-11
2. **K2–K4** — verifizierte Bugs (nav-Image-History, Export-Doppel-Init,
   suppressActive-Leak) + **M1** (Quit-Prompt).
3. **K5, M9, M10** — E2E-Vertrauen (run.py-Fixes, Isolation-Leaks,
   Cargo.lock).
4. Mittel-Findings M2–M8, M11; danach Niedrig nach Gelegenheit.
