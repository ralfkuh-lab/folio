# CLAUDE.md

## Projekt

**folio** — Markdown-Viewer/-Editor auf Tauri 2 + Rust. Live-Vorschau,
Vault-Navigation, Workspace-Pins, HTTP-Automation-API für E2E-Tests.

Offene Aufgaben werden in [`TODO.md`](TODO.md) gepflegt (priorisiert: hoch /
mittel / niedrig). Vor Vorschlägen, was als nächstes ansteht, dort nachsehen —
**und gleich mit in [`docs/feature-ideen.md`](docs/feature-ideen.md)**: Dort
liegt die Ideensammlung (vier Quellen, Aufwandsschätzung, Vermerk zu bereits
Umgesetztem). `TODO.md` = Verpflichtungen, `feature-ideen.md` = Optionen; die
Frage „was steht an?" meint in der Regel beides.

Abgeschlossene Refactoring-Pläne sind aus der laufenden Doku entfernt.
Historie steckt im Git-Log; aktuelle Architektur- und Arbeitsregeln stehen
hier, im README, in [`TODO.md`](TODO.md) und in den thematischen Dateien
unter `docs/`.

## Tech-Stack

- Rust 2021, Tauri 2
- comrak 0.35 (GFM-Markdown)
- axum 0.8 (Automation-API auf `127.0.0.1:9876`, Loopback-only + Host-/
  Origin-Allowlist; Release-Build nur mit `FOLIO_AUTOMATION=1`)
- Frontend: TypeScript-Module in `src-tauri/web/app/` (Bootstrap +
  `state/`, `view/`, `editor/`, `vault/`, `ui/`, `automation/`), CSS in
  `src-tauri/web/styles/`, Monaco-Editor-Adapter als Modul-Verzeichnis
  `src-tauri/web/editor/` (`mount.ts`, `text.ts`, `find.ts`, `state.ts`,
  `events.ts`, `bridge.ts`, `index.ts` als Surface-Composer). esbuild
  bündelt zu `dist/app.bundle.js`, `dist/app.css`, `dist/editor.bundle.js`;
  `dist/index.html` ist HTML-Shell + 3 `<script src>`-Tags + 1 `<link>`.
  `dist/monaco/` wird von `copy-monaco.js` aus
  `node_modules/monaco-editor/min/` befüllt.
- notify 7.0 (File-Watching), tauri-plugin-screenshots 2.2 (Monitor-Capture)

## Build & Test

Cargo-Befehle aus `src-tauri/`:

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo tauri build                   # Linux: deb + rpm + appimage in target/release/bundle/
cargo tauri build --bundles deb     # einzelnes Bundle-Target
```

Frontend-Bundles (`app.bundle.js`, `app.css`, `editor.bundle.js`,
`mermaid.bundle.js`) sind eingecheckt und müssen nur neu gebaut werden,
wenn die jeweiligen Quellen geändert wurden:
`cd src-tauri/web && npm install && npm run build`.
Outputs landen in `../dist/`. Reihenfolge im `package.json`-Build-Script:
monaco-copy → editor.bundle → app.bundle → mermaid.bundle → app.css.
**Achtung beim Testen gegen das Release-Binary**: Tauri bettet `dist/`
zur Compile-Zeit ins Binary ein — nach einem Bundle-Rebuild sieht ein
bereits gebautes `target/release/folio` die Änderung NICHT; erst
`cargo build --release` (bzw. der run-e2e.sh-Wrapper, der das immer tut)
liefert den neuen Frontend-Stand aus.

Die `tsconfig.json` hat `noUnusedLocals`/`noUnusedParameters` an (Gate im
Build, weil `npm run build` mit `tsc --noEmit` startet): ungenutzte
Variablen, modul-private Funktionen und Importe sind **Fehler**, keine
Warnungen. Das hält toten Frontend-Code draußen, den ein export-basierter
Scan nicht sieht — beim Auskommentieren von Code also mit-aufräumen statt
den Rest stehen zu lassen. Test-Dateien sind vom `include` ausgenommen.

Im HTML werden die Bundles in dieser Reihenfolge geladen
(`monaco/loader.js` → `editor.bundle.js` → `app.bundle.js`), ohne
`defer` und am Body-Ende — Top-Level-`getElementById`-Aufrufe greifen
nur, weil der DOM-Body zu diesem Zeitpunkt schon geparst ist.

Frontend-Quellen liegen in `src-tauri/web/`, ausgeliefert wird über
`src-tauri/dist/` — `dist/` darf keine npm-Artefakte mehr enthalten,
sonst lehnt Tauri den Build ab.

## Konventionen

### i18n

- Kataloge liegen in `src-tauri/locales/<tag>.json`; Registry und eingebettete
  Kataloge werden durch `src-tauri/build.rs`/`src-tauri/src/i18n/catalog.rs` erzeugt.
  Katalogdateien bleiben alphabetisch sortiert und haben identische Key-Mengen.
- Keys benennen die Funktion auf Englisch in `camelCase` unter einem
  kanonischen Namespace (`errors.<modul>.<fall>`, kein freies `common.*`).
- Jeder Katalog-Key hat in `src-tauri/locales/context/keys.json` einen
  nichtleeren englischen Kontextsatz; neue Keys ergänzen ihn im selben Zug.
- Frontend verwendet `t()`/`tPlural()`, Rust `t()`/`t_args()`/`t_plural()`.
  Übersetzte Fehler umschließen technische Details mit `{detail}`, statt den
  Detailtext selbst als Katalogwert zu behandeln.
- Der Bootstrap läuft `booting → i18nReady → uiReady`; frontendabhängige
  Automation darf erst nach `frontendReady` bzw. dem Ready-Gate arbeiten.
- Der E2E-Voll-Lauf ist mit `FOLIO_LANG=de` baseline-stabilisiert;
  `bash scripts/run-e2e.sh --lang-smoke` prüft einen separaten englischen Boot.
- Referenz- und Markup-Gates sind hart: neue Keys müssen referenziert,
  Referenzen katalogisiert und `data-i18n-*`-Ziele leaf-safe sein.
- Neue Sprache: vollständige `src-tauri/locales/<tag>.json` kopieren.
- `@meta` (`tag`, Eigenname, Format-Locale, Flaggen-Emoji `flag`) anpassen und
  Werte übersetzen.
- Katalog-/Referenztests ausführen; Produktcode bleibt unverändert.

Vollständiger Vertrag und Architektur: [`docs/spec-i18n.md`](docs/spec-i18n.md).

### Weitere Konventionen

- **Slugifier**: eigener in `heading_anchor.rs` (kein comrak-Default).
- **AST-Postprocess** in `renderer.rs` ergänzt fehlendes `GenericAttributes`-Feature.
- **CRLF/LF/BOM + Encoding**: Roundtrip ist getestet (`document_store.rs`).
  Beim Schreiben Original-Encoding/Line-Endings beibehalten. `read_and_decode`
  erkennt in dieser Reihenfolge: BOM (`EF BB BF` → UTF-8-BOM, `FF FE` →
  UTF-16 LE, `FE FF` → UTF-16 BE) → striktes UTF-8 → **Windows-1252-Fallback**
  (deterministisch, kann nie fehlschlagen; keine Rate-Heuristik). BOM-loses
  UTF-16 wird bewusst NICHT erkannt und landet im 1252-Fallback. Das Encoding
  wird als `TextEncoding`-Enum im `DocumentStore` gehalten (`encoding_rs` für
  1252 + UTF-16-Decode; UTF-16-**Encode** über std `str::encode_utf16`, weil
  encoding_rs keinen UTF-16-Encoder hat) und beim Save zurückkodiert. Bei
  Windows-1252 nicht darstellbare Zeichen (z. B. Emoji) sind ein **Fehler**
  (`SaveError::Unmappable`, i18n-Key `errors.file.encodingUnmappable`) — die
  Datei wird NICHT geschrieben, statt Zeichen still durch HTML-Entities zu
  ersetzen. `document:loaded`/`read_file` liefern additiv ein `encoding`-Label
  (`utf8`|`utf8-bom`|`utf16le`|`utf16be`|`windows1252`); die Statusleiste
  (`#status-encoding`) zeigt es nur, wenn es NICHT reines UTF-8 ohne BOM ist
  (sonst würden alle E2E-Baselines wandern).
- **IPC-Payloads**: gerendertes HTML geht über Tauri-Events, nicht über Command-Returns.
  *Bewusste Ausnahme*: `render_markdown_preview` (Live-Preview im
  View-/Split-Mode) liefert HTML+TOC als Command-Return. Frontend
  treibt den Roundtrip aktiv (Debounce + Generation-Token-
  Invalidierung in `view/preview.ts`); das passt nicht ins
  Push-Event-Modell der kanonischen `document:loaded`/`saved`-Pfade.
- **Document-Lifecycle-Events**: gemeinsamer monotoner seq-Counter
  (`next_doc_seq` in state.rs) fuer `document:loaded|closed|saved|dirty_changed`.
  Frontend (`state/document.ts`) verwirft via `isStaleLifecycleEvent` alle
  Events mit seq <= lastApplied (inkl. cross-Tab-Races); zusaetzlich
  tabId-Validierung fuer saved/dirty_changed gegen `getActiveTabId()`.
  loaded/closed werden nur per seq geschuetzt. Alt-Payloads ohne seq
  laufen durch.
- **Automation-API**: nur Loopback. Keine externen Bind-Adressen.
  Security-Middleware (`automation/middleware.rs::security_guard`):
  Host-Header-Allowlist (gegen DNS-Rebinding), Origin-Allowlist (nur
  Tauri-WebView-Origins, gespiegelt statt `Access-Control-Allow-Origin: *`;
  Requests ohne Origin wie curl/Python sind erlaubt, bekommen aber keine
  CORS-Header; fremde Origins/`null` → 403), optionales Token via
  `FOLIO_AUTOMATION_TOKEN`. Im **Release-Build startet der Server nur mit
  `FOLIO_AUTOMATION=1`** (Debug: immer) — `run-e2e.sh`/`run.py` setzen das;
  wer das Release-Binary manuell automatisiert, muss es selbst setzen.
  WebView-POSTs brauchen CORS/OPTIONS-Preflight; `/click` akzeptiert IDs,
  `data-name` und CSS-Selektoren.
  Stabiler Automation-/Frontend-Vertrag: [`docs/automation-contract.md`](docs/automation-contract.md).
  `POST /eval { js }` führt beliebiges JS im WebView aus und liefert
  das Ergebnis zurück (sync + async/Promise, Fehler werden gefangen,
  konfigurierbarer Timeout via `timeoutMs`, Default 5 s). Pattern
  analog zu `/dom`: Event `automation:eval` → Frontend `new Function`
  → Tauri-Command `automation_eval_response` → oneshot-Channel.
  `POST /find/text` öffnet die Find-Bar automatisch (`editor:open_find`
  vor `editor:set_find_term`), ein separater `/find`-Aufruf ist nicht
  mehr nötig.
  `POST /sync/render` ist ein deterministischer Render-Roundtrip für
  E2E-Screenshots: Handler emittiert `automation:sync_render` und ackt
  über das `ack.rs`-Muster (`automation_ack`), nachdem das Frontend
  (`settleRender` in `automation/events.ts`) einen Microtask + zwei
  `requestAnimationFrame` + laufende CSS-Transitions (`getAnimations()`,
  300-ms-Cap gegen Endlos-Animationen) abgewartet hat. `report.py`
  ruft das vor jedem Screenshot statt des früheren `time.sleep(0.20)`. `GET /console/errors` liefert per Frontend-Hook
  gesammelte Console-Errors (Ringpuffer, max 200); `?clear=true`
  leert den Puffer. Der `unhandledrejection`-Teil des Hooks
  (`automation/events.ts::installConsoleHook`) filtert **Monaco-
  Cancellation-Rejections** (`name`/`message === 'Canceled'`) heraus:
  beim Model-Wechsel (`mount.ts::doSetText`, Sprachwechsel →
  `setModel`+`dispose`) bricht Monaco laufende async-Ops über
  CancellationToken ab; die resultierende Rejection ist erwartet und
  harmlos, würde aber sonst als False-Positive im Puffer landen
  (`preventDefault()` unterdrückt zusätzlich die DevTools-Warnung).
  `GET/POST /settings` lesen bzw. patchen die App-Settings über denselben
  Service- und Side-Effect-Pfad wie die Tauri-Commands; `POST /split`
  setzt den persistierten Split-Teiler. Geteilte Backend-Events erhalten
  nur für Automation ein optionales `requestId` und acken nach Anwendung.
- **assetProtocol-Scope `["**"]`** (tauri.conf.json): bewusste
  Entscheidung — der Image-View rendert Bilder von beliebigen Pfaden via
  `convertFileSrc`, ein engerer Scope würde jeden Ordner außerhalb einer
  Whitelist brechen. Konsequenz: die WebView kann jede lokale Datei
  **lesen**; in Kombination mit der HTML-View
  (`sandbox="allow-same-origin allow-scripts"`) ist der HTML-Sanitizer
  die einzige Barriere zwischen einer fremden `.html`-Datei und lokalen
  Dateien. Bei Änderungen an HTML-View/Sanitizer mitdenken.
- **Vault-Markup**: Frontend erwartet Baum-Markup mit `.section`, `.node`, `.row`,
  `.caret`, `ul.children`. Jedes `.node` hat `data-path="<abs-path>"`
  und `title="<abs-path>"` (Tooltip).
- **Pfad-Normalisierung**: alle Pfade, die in DOM-`data-path`-Attribute,
  workspace.json-Speicher oder `is_pinned`/`is_expanded`-Vergleiche
  gehen, werden auf Forward-Slashes normalisiert (`\` → `/`).
  Implementiert in `Workspace::pin/unpin/is_pinned/add_recent/
  remove_recent/image_dir/set_image_dir/set_last_export_dir`,
  `WorkspaceData::last_export_dir`, `Vault::set_active/
  on_expand/is_expanded` und `Vault::item_html`. Begründung: CSS-
  Selektoren `[data-path="C:\Users\..."]` schlagen sonst fehl
  (`\U` = Unicode-Escape). `Workspace::load_from` migriert bestehende
  Backslash-Pfade beim Boot. Windows-APIs akzeptieren beide
  Schreibweisen, daher bricht das keine Datei-IO.
- **Vault-Watcher** (`vault_watcher.rs`): pro aufgeklappten Vault-
  Ordner ein NonRecursive-`notify`-Watch. `Vault::on_expand`
  registriert, `on_collapse` deregistriert. Bei FS-Event emit
  `vault:dir_changed { path }` → Frontend triggert `expand-dir`-Pfad
  nur für diesen Ordner. Steuerbar via Setting `vaultAutoRefresh`
  (default an). Toggle live-aware: bei Re-Enable werden alle aktuell
  expanded_dirs erneut registriert (siehe `commands::app::settings::
  sync_vault_watcher`).
- **Pin-Reordering** (`vault/tree.ts`): das Umsortieren der angepinnten
  Top-Level-Einträge läuft **Pointer-basiert** (`pointerdown`/`move`/`up`,
  delegiert auf `#vault-tree`), **bewusst NICHT über HTML5-Drag&Drop**.
  Grund: auf Windows/WebView2 fängt Tauris OS-Level-Drag-Handler
  (`dragDropEnabled`, Default an — wird fürs Datei-Drop-zum-Öffnen in
  `ui/drag-drop.ts` gebraucht) sämtliche Drag-Operationen ab und liefert
  keine `dragover`/`drop`-Events mehr in die WebView; HTML5-DnD ist damit
  tot (auf Linux/WebKitGTK lief es, daher grün in der E2E-Suite). Die
  Pointer-Variante ist unabhängig vom OS-Handler. Bewusst **ohne**
  `setPointerCapture` (so ist `e.target` bei `pointermove` das Element
  unter dem Cursor → Drop-Ziel-Bestimmung + jsdom-testbar).
  Bewegungs-Threshold (4 px) trennt Klick (= öffnen) vom Drag; der dem
  Drag folgende synthetische Klick wird per Capture-Listener auf
  `#vault-region` geschluckt (`suppressNextClick`). Drag-**Quelle** nur
  die eigene `.row` des Root-Items (nicht aus verschachtelten Pin-Ordner-
  Kindern), Drop-**Ziel** der gesamte Subtree. Persistenz unverändert
  über `workspace_reorder_pinned`. Kein `draggable`-Attribut mehr.
- **Gitignore-Dimming im Vault**: Ignorierte Dateien/Verzeichnisse (Pins + Kinder aufgeklappter Ordner) bekommen `ignored`-Klasse auf `li.node`; nur eigene Row wird via `> .row` CSS gedimmt (opacity 0.55). Nutzt `ignore`-Crate (nur GitignoreBuilder + matched_path_or_any_parents; kein WalkBuilder, kein git-Binary, kein neuer Watcher — bestehende expand/refresh + VaultWatcher reichen). `repo_root` aus git_branch. Recent-Liste bleibt unberührt.
- **Git-Diff („Änderungen anzeigen")**: Kontextmenü nur bei `git-modified` + Textdatei (`data-text="1"` aus `FileKind`). Read-only Diff über dieselbe `FolioDiffView`-Surface/`#ai-diff-region` wie die KI-Review (`setContents(..., { readOnly: true })`, Default bleibt editierbar). Rechte Seite = offener Tab-Puffer (`getTextForTab`) sonst Disk. Offene KI-Review blockt den Git-Diff (`errors.ai.reviewOpen`). HEAD via `git show HEAD:<rel>` mit derselben Deadline/kill+reap wie der Status-Job.
- **Git-Status-Dots im Vault** (`git_status.rs` + Frontend `vault/git-status.ts`): modified/untracked als Klassen `git-modified`/`git-untracked` auf `li.node` (Punkt via `> .row::before`, kein Layout-Shift). Datenquelle `git status --porcelain=v1 -z --untracked-files=normal` (nicht libgit2, nicht `.git/index`); Fail-open ohne Dialog. Vault-Render bleibt frei davon — Hintergrund-Job pro Repo-Root, Single-Flight, Generation-Discard, Cache-TTL 15 s, Event `vault:git_status` (Payload trägt `generation`; Frontend verwirft ältere Snapshots wie den `document:*`-seq-Guard). `git status` hat eine 10-s-Deadline (`kill`+`wait`); `refreshing` wird per RAII-Guard freigegeben. **stdout MUSS in einem Reader-Thread geleert werden, WÄHREND auf den Prozess gewartet wird** (`wait_child_with_timeout`, gilt für beide git-Aufrufer): Wird die Pipe erst nach Prozessende gelesen, blockiert git bei Ausgaben über dem OS-Pipe-Puffer (Linux 64 KiB, Windows 4 KiB) im `write()` — und wir warten auf sein Ende. Deadlock bis zum Timeout, danach keine Dots (Befund Kreuz-Review 2026-08-14; trat ab ~1000 geänderten/untrackten Einträgen auf). Cache hält den vollen Snapshot und liefert ihn bei frischem Treffer erneut. Invalidierung bei Fenster-Fokus (Commit fasst keine Arbeitsdatei an; Root-Discovery nach Freigabe des Workspace-Locks), Save/create/rename/delete; **keine** Watcher auf `.git/index`. Ordner-Aggregation (Präfix) im Backend; Frontend wendet den letzten Snapshot nach Lazy-Expand erneut an (`MutationObserver` + `takeRecords()` im `finally`).
  **Zugänge zum Status** (Etappe 2026-08-14): Der `title` eines Knotens nennt den Status im Klartext (analog zum „gitignored"-Zusatz, idempotent gesetzt und rückstandsfrei entfernt). Der Tab trägt links einen 4-px-Balken (`.tab-git`, amber) — bewusst NICHT den dirty-Punkt eingefärbt, der rechts bleibt und Ungespeichertes meint; ein Marker mit zwei Bedeutungen wäre nicht unterscheidbar. Klick auf den Balken öffnet den Git-Diff (`preventDefault`+`stopPropagation`, aus dem Drag-Handler ausgenommen, Mittelklick abgefangen, `tabindex="-1"`). Toolbar-Button + Menüeintrag sind eine **Aktion mit Enabled-Zustand, kein vierter View-Mode** — Modes sind pro Tab, die DiffView-Surface ist ein Singleton, das passt strukturell nicht zusammen.
  **Git-Filter „nur geänderte"** (`vault/filter.ts`, kombinierbar mit Namensfilter und md-only): Zwei Fallen, beide aus dem Kreuz-Review 2026-08-14. (1) `--untracked-files=normal` meldet einen komplett neuen Ordner als EINEN Eintrag `?? neu/` — die Kinddateien stehen NICHT im Snapshot. Der Filter muss sie über Verzeichnis-Präfix (auf Segmentgrenze!) mitzählen, sonst bleibt ein aufgeklappter, scheinbar leerer Ordner zurück. (2) `git status` liefert das ganze Repo; der Auto-Expand darf nur Pfade unterhalb **sichtbarer Pin-Wurzeln** öffnen, sonst werden repo-fremde Ordner expandiert und gewatcht und der 1000er-Soft-Cap ist erschöpft, bevor der relevante Zweig drankommt.
- **Vault-Volltextsuche** (`search.rs` + `commands/search_cmd.rs` +
  `automation/handlers/search.rs`; Frontend `vault/search.ts` +
  `#vault-search`; Spec + Etappen in
  [`docs/spec-vault-search.md`](docs/spec-vault-search.md)):
  Backend-Suchkern `run_search`/`run_search_ex` läuft sequenziell über
  `ignore::WalkBuilder`, Verzeichnis-Scopes (Vault/Folder) seit S6 parallel
  über `run_search_parallel` (`build_parallel` + `mpsc`-Consumer, nur der
  Consumer ruft `on_file`, Completion-Order; OpenTabs-Puffer bleiben
  sequenziell) (hidden/gitignore-Filter; Opt-in `includeHidden` →
  `standard_filters(false)`, `.git`-Dirs bleiben per `filter_entry`
  draußen), Filter über `FileFilter`
  (`markdown` = nur `FileKind::Markdown` | `allText` = Markdown+Text |
  `custom` = Endungsliste mit bewusstem `classify`-Bypass) + 2-MiB-Cap
  (`skipped_large`) + NUL-Sniff (8 KiB); Literalsuche escaped `(?i)`/`\b…\b`
  ODER **Regex-Modus** (kein Whole-Word — Rust-`regex` hat keine Lookarounds;
  Zero-Width-Matches werden übersprungen, `probe_has_match` auch im
  Probe-Modus). **Scope-Modell** `SearchScopeEx { Vault, Folder, OpenTabs }`
  (Grenz-Validierung zentral in `build_scope_and_options`/`to_scope_ex`):
  Vault = Union angepinnter Ordner (rekursiv) + Einzeldateien mit Overlap-Dedup
  (**explizit gepinnte Einzeldateien umgehen hidden/gitignore bewusst**);
  Folder über Kontextmenü „In diesem Ordner suchen"
  (`RootNotFound`/`InvalidScope` bei totem/relativem Ordner, `scope:`-Präfix →
  Frontend-Fallback); OpenTabs durchsucht die offenen Tab-Puffer
  (`snapshot_open_tab_docs`: geladene Text-Tabs `InMemory` **auch leer** —
  geleerter Puffer schattet Disk —, `pending`/opaque via `FileKind` `OnDisk`;
  virtuelle Frontend-Tabs außen vor). Tote Vault-Pins werden STILL verworfen.
  **Caps**: 50 Zeilen-Hits/Datei, 500 gesamt (Probe-Modus, `truncated` nur bei
  realem Wegfall). Spalten/Ranges in **UTF-16-Code-Units**, Snippet ~240.
  **Frontend = Dialog-first** (`#vault-search-dialog`/`#vsd-*`; der linke Rail
  zeigt nur Summary-Button `#vault-search-summary` + Ergebnisse): Draft vs.
  committed strikt getrennt (Submit prüft via `vault_search_validate`, bei
  OpenTabs zwingend `syncEditorTextToStoreRequired`, committed State ändert
  sich nur bei gültigem Submit; Abbrechen verwirft nur den Draft, laufender
  Lauf bleibt). `vault_search_start`→`runId`, Events `search:hits`/`search:done`;
  Stale-Guard per Generation + `maxRunId`. **Spinner** `vs-running` auf
  `#vault-search-status` (zentrale `setRunning`, alle Endpfade räumen auf).
  **Auto-Collapse** als Modus `auto|collapsed|expanded`: >10 Treffergruppen →
  einmalig alles einklappen; Collapse-/Expand-All im
  `#vault-search-results-head` setzen den Modus. Sprung korreliert über
  `folio-doc-kind-changed` + `getCurrentPath()`; OpenTabs-Treffer springen über
  `findTabIdByPath`+`activateTab` (NICHT `openDocument` → dirty Puffer bleibt),
  Edit/Split via `FolioEditor.revealMatch`, View-Mode via Find-Bar nach
  Finder-Settle (Regex: `Jump.term` = konkret gematchter Text). `tab_open`
  überspringt `consumeNavRestoreSkip(path)` einmalig. Optionen (Aa/W/Regex/
  fileFilter/customExtensions roh/`includeHidden`) persistieren in
  `panel_state.rs` (`search_file_filter` default `allText`,
  `search_include_hidden` default aus); Scope + Query flüchtig.
  Automation: `POST /search` (synchron, additive Felder `regex`/`fileFilter`/
  `customExtensions`/`openTabs`/`includeHidden`; alle Client-Fehler → 400).
- **Vault-Tree-Filter (R3, Sicht-Filter)** (Frontend `vault/filter.ts`,
  Funnel-Button + Filterzeile `#vault-filter`; Spec
  [`docs/spec-vault-filter.md`](docs/spec-vault-filter.md) inkl.
  Revisions-Historie R1→R3): Der Namensfilter ist eine **rein
  clientseitige Sicht über dem echten Lazy-Baum** — kein Backend-Walk,
  kein separater Render-Modus (R1/R2-Konzepte entfernt). Datei-Zeilen
  ohne Match bekommen `vf-hidden`; **Ordner bleiben immer sichtbar**
  (sie sind der aufklappbare Suchraum); Treffer-Highlight `span.vf-hit`
  auf Datei- UND Ordner-Labels (Text-Node-sicher); wirkt auf Pinned und
  Recent. Match: case-insensitive Substring via `toLowerCase`, KEIN
  Unicode-Case-Folding. Re-Apply nach Baum-Änderungen per
  MutationObserver auf `#vault-tree` — **`takeRecords()` im finally von
  `applyClientFilter` ist PFLICHT**: die eigenen Highlight-Umbauten sind
  childList-Mutationen, der Observer-Callback feuert erst als Microtask
  nach dem Guard-Reset; ohne Drain entsteht ein Endlos-Loop (Befund
  Orchestrator-Review 2026-07-21, Churn-Test in
  `tests/vault/filter.test.ts`). „Schließen = Aufräumen": Zeilen-X
  (`#vault-filter-close`, immer sichtbar) / Funnel / Escape leeren die
  Query; Text-Lösch-✕ ist ins Input eingebettet; Funnel-Badge nur bei
  md-only. **Baum-Operationen im `vault-header`** (filter-unabhängig):
  `#vault-expand-level` (⊞, Command `vault_expand_level` — expandiert
  alle sichtbaren zugeklappten Ordner eine Ebene über den
  `on_expand`-Pfad inkl. Watcher, Soft-Cap 1 000 neue Ordner/Klick →
  `capped` + transienter Hinweis `#vault-tree-notice`) und
  `#vault-collapse-all` (⊟, Command `vault_collapse_all`).
  **„Nur Markdown"-Toggle** bleibt Backend-Lazy:
  `build_dir_children_html` filtert pro Expand (inkl. Pin-Wurzeln);
  `dir_contains_markdown`-Probe (Early-Exit, 2k-Visit-Cap fail-open,
  kein Abstieg in Link-Dirs, `.git`-Skip) in `vault_filter.rs`. Der
  Lazy-Typ-Filter lebt als Spiegel-State `Vault::markdown_only`
  (Quelle: `panel_state.vault_filter_markdown_only`); JEDER
  `compute_refresh_delta`-Aufruf läuft über
  `commands::vault_cmd::compute_refresh_delta_synced` (synct + rendert
  unter einem Lock; Boot-Init in `state.rs`). md-Toggle ohne Query
  wartet auf `vault_filter_options_set`, BEVOR `refreshVault()` läuft —
  sonst liest `vault_build_tree` den alten Toggle (Race, E2E-Befund
  2026-07-20). Persistenz: `vault_filter_markdown_only` +
  `vault_filter_bar_visible` in `panel_state.rs`; Query flüchtig.
  E2E-Reset räumt den Filter über den Hook `window.__folioVaultFilterReset()`.
- **Command Palette** (Strg+P; Spec
  [`docs/spec-command-palette.md`](docs/spec-command-palette.md)):
  Overlay `#cmd-palette` (`dist/index.html` + `styles/overlays.css`),
  Module `ui/command-palette.ts` + `ui/palette-commands.ts` +
  `util/fuzzy.ts`. Trigger im DOM-Capture-Block von
  `toolbar-actions.ts` (Toggle; Esc/Backdrop/Fokus-Restore). Drei
  Modi im selben Input: *(keins)* Dateien (offene Tabs >
  Recents aus Vault-DOM > `palette_files`-Pin-Walk, Cap 20 000 +
  `truncated`), `>` Befehle nur via `menu_dispatch` (disabled
  ausgeblendet), `#` TOC-Überschriften (`toc_click`). Enter:
  `openDocument`/`activateTab`; Strg+Enter/Strg+Klick: `tab_open`.
  Max. 50 Zeilen + „weiter tippen…"; Match-Highlight `.cp-hit`.
  Hooks `window.__folioOpenPalette(prefill?)` /
  `__folioClosePalette()` (E2E/Reset; synthetisches Strg+P unter
  Xvfb fragil). E2E `51_command_palette.py`; Reset schließt die
  Palette über den Close-Hook.
- **Statusleiste** (Spec [`docs/spec-statusbar.md`](docs/spec-statusbar.md)):
  `#status-cursor` (Ln/Sp, nur Edit/Split via CSS-Body-Klassen),
  Selektions-Stats in `#status-wordcount` (Rückfall auf gemerkte
  Dokument-Stats), `#status-eol`-Button (LF↔CRLF-Toggle, kind
  markdown/text). Quelle ist das RAF-debounced in-window CustomEvent
  `folio-editor-selection` aus `editor/events.ts` (Model wird vor dem
  RAF gecaptured — nachlaufender Frame nach Doc-Wechsel wird verworfen).
  EOL: `DocumentStore` hält `clean_line_ending` + `opaque`-Flag; Dirty =
  Text- ODER EOL-Abweichung (`is_content_dirty`, gespiegelt im Frontend
  via `cleanEol` in `refreshDirtyFromEditor` — sonst verwirft ein
  Dateiwechsel den EOL-Toggle still). Events: `document:loaded.lineEnding`,
  `document:eol_changed` (tabId-Guard; einziger Emit-Pfad ist der
  Store-Callback `events.eol_changed`, auch beim Format-only-External-
  Reload — dort gewinnt bewusst der Disk-Stand über einen In-App-Toggle).
  `set_line_ending` lehnt Opaque-Docs ab (Flag überlebt Rename Bild→.txt).
  `.statusbar button[hidden] { display:none }` ist Pflicht (Author-CSS
  überstimmt sonst das UA-hidden). Automation: `/state.lineEnding`
  (null ohne Doc/opaque), E2E `52_statusbar.py`.
- **main-Badge-Farbe**: `git-branch--main` (und dark) jetzt `var(--rail-accent)` statt `--rail-fg-muted` (Detached bleibt rot, Feature-Branches bernstein) — Unterscheidbarkeit zum Dimming.
- **Dateityp-Klassifizierung**: zentral in `file_kind.rs`
  (`FileKind::{Markdown, Text, Image, Binary}`, `classify(path)`).
  `read_file` und `document:loaded` liefern `kind` ans Frontend; das
  setzt `body.kind-<value>` als Single Source of Truth. UI, die nur
  für Markdown gilt (Edit-Toolbar-Markdown-Gruppen, TOC-Rail,
  Rail-Right-Toggle), wird ausschließlich über CSS auf `.kind-markdown`
  beschränkt — keine eigene Endungs-Heuristik im Frontend.
- **Split-Mode** (`tb-mode-split`, `body.split-mode` in `content.css`):
  drei Anzeigemodi (view/edit/split) sind sich gegenseitig ausschließende
  Body-Klassen. Im Split-Mode ist die View-Region und die Editor-Region
  gleichzeitig sichtbar (Editor links, View rechts via `flex-direction:
  row-reverse`, Trennlinie an der View-Seite). Cursor-Commands
  (`tb-bold`/`italic`/`heading`/...) sind gated auf
  `body.editor-focused` — die Klasse togglet via `focusin`/`focusout`
  in `ui/toolbar-actions.ts`, ein MutationObserver synct die
  `button.disabled`-States. `mousedown`-`preventDefault` auf den
  Cursor-Buttons verhindert Fokus-Diebstahl (Standard-Trick aus
  CodeMirror/Slate). Ctrl+1/2/3 laufen ueber `menu_dispatch` statt
  `button.click()` — robust gegen disabled-Buttons + gleicher Pfad wie
  Menue/Automation. Die Aufteilung Editor/View steuert ein **draggbarer
  Mid-Splitter** (`#splitter-mid`, `ui/rails.ts::initMidSplitter`):
  CSS-Variable `--split-mid` = Editor-Anteil in Prozent (Clamp 20–80,
  Default 50), persistiert als `split_mid_percent` in
  `panel_state.rs`/`panel-state.json` (Command `set_split_mid_percent`,
  Boot-Restore via `split_mid_get`). Backend-Sync-Events
  (`panel:split_mid_changed`) laufen ueber `applySplitMidFromBackend`,
  das waehrend eines aktiven Drags droppt — ein verspaetetes Event aus
  einem frueheren Drag darf den Live-Wert nicht ueberschreiben.
  Vorzeichen-Detail: der Editor liegt physisch links (row-reverse
  ordnet nur DOM-Kinder um), Drag nach rechts vergroessert ihn.
- **Live-Preview** (`view/preview.ts`, Backend-Command
  `render_markdown_preview`): im Split-/View-Mode rendert das Frontend
  den aktuellen Editor-Text debounced ohne Save. Debounce ist adaptiv:
  `clamp(150, gemessene_Renderdauer_ms * 2, 600)` — normale Docs bleiben
  bei effektiv 150 ms; grosse Docs strecken bis 600 ms, damit teure
  Roundtrips sich nicht stauen (Reset auf 150 ms bei document:loaded/closed).
  Trigger ist das in-window CustomEvent `folio-editor-text-updated` aus
  `editor/bridge.ts` (kein Tauri-IPC-Roundtrip pro Tastendruck).
  Race-Schutz per monoton steigender `renderGen`-Generation —
  verspätete Antworten alter Renders werden verworfen.
  `invalidatePreview()` wird bei `document:loaded`/`saved`/`closed`
  aufgerufen, sodass pending Renders aus altem Dirty-Text nie den
  kanonischen Backend-Render überschreiben. **Wichtig**: kein
  `isDirty`-Gate — wenn der User auf cleanText zurück-revertiert (z. B.
  Selection + Backspace), wuerde `markDirty(false)` den Re-Render
  sperren und die View bliebe auf dem Pre-Revert-Stand. Im Timer-Fire
  wird der aktuelle Editor-Stand live aus Monaco geholt, statt den am
  Schedule-Zeitpunkt closure-captured Text — robust gegen
  verlorengegangene `editorTextChanged`-Events.
  Analoges Muster (debounce 150 ms + renderGen + invalidate + KEIN isDirty-Gate +
  Scroll-Erhalt) gilt seit 2026-07-09 auch fuer HTML-Split-Live-Update
  (`html.ts`: scheduleHtmlLiveUpdate + run + mount + post-load HtmlFinder.refresh)
  und seit 2026-07-18 fuer die Code-View im Split-Mode (`view/code-live.ts`:
  `body.split-mode` + `kind-text` + nicht HTML + `FolioCodeView.isMounted()`;
  `setText(..., { autoFormat: false, preserveScroll: true })` — Auto-Format
  pro Tastendruck waere teuer und wuerde den Text unter dem User
  wegformatieren; der kanonische `viewAutoFormat`-Pfad greift weiter bei
  loaded/saved).
- **Mermaid** (`view/mermaid.ts` + `mermaid/index.ts`): ```mermaid`-Fences
  werden nur in der App-View (View/Split/Live-Preview) per Frontend-Post-
  Prozessor zu SVG-Diagrammen (`<div class="mermaid-diagram">`). Eigenes
  Lazy-Bundle (`dist/mermaid.bundle.js`, via Script-Injection beim ersten
  Vorkommen; analog whenMonacoLoaded). Idempotenz per (source+theme)-Cache,
  Theme-Re-Render, DOM-Connected-Race-Schutz, Fehler → Pre + .mermaid-error
  (stray SVGs von mermaid v11 werden aufgeraeumt). Export (HTML/PDF): Frontend
  rendert via `renderMermaidForExport` (immer light) vor; Command
  `export_mermaid_sources` (comrak-basiert) + gemeinsame Erkennungsfunktion
  liefert Quellen; Export-Commands erhalten optionales `mermaidSvgs`;
  Backend ersetzt i-ten Block durch `<div class="mermaid-diagram">svg</div>`
  (None → Code-Block-Fallback). Index-Match, Light-only, Theme-Editor-Vorschau
  (ohne Dialog-Kontext) bleibt Code-Block. `renderMermaidBlocks` wird parallel
  zu `highlightCodeBlocks` an denselben Stellen gerufen.
- **Wikilinks + Tags** (Spec [`docs/spec-wikilinks.md`](docs/spec-wikilinks.md),
  W1–W7): Obsidian-kompatible `[[Name]]`/`[[Name|Alias]]`/`[[Name#H]]`/
  `![[bild.png]]` in View/Split/Live-Preview/Export. Kern `wikilink.rs`
  (Index über Vault-Pins wie Suche, TTL 30 s + Invalidierung bei Pin/
  create/rename/delete/save_as/Watcher; `WikilinkContext` im Render).
  **Auflösung (W7)**: `resolve_name_from(name, context)` mit Lokalitäts-
  Rangfolge gleiches Verzeichnis → gleicher Pin-Root (längster Root) →
  Rest; `resolve_name` bleibt kontextfrei. Render nutzt `current_doc`,
  Backlink-Scan die **Quelldatei**, Heading-Complete `current_path`.
  Missing → `folio-new:`-Href + Klasse `wikilink-missing` (App: Anlegen-
  Dialog W2); Export ersetzt das Schema durch `href="#"` (`sanitize_
  export_missing_hrefs`, Styles in `layouts/base.css`). CSS-Klassen:
  `a.wikilink` / `.wikilink-missing` / `.wikilink-embed` (content.css).
  Backlinks: Command `backlinks_for` + `#backlinks-section` unter TOC
  (debounced refresh). `[[`-Autocomplete im editor-Bundle
  (`wikilink-complete.ts`, `wikilink_candidates` [Index-Scope,
  optional `currentPath`, lokalitätsbewusst verkürzter insert] +
  `wikilink_headings`; Fence-/Inline-Code-Gate).
  Tags: `tags.rs` / `vault_tags`, UI `#vault-tags-section` lazy on
  expand (`panel_state.tags_expanded`), Search-Präfill `#tag`.
  E2E: `53_wikilinks`, `54_tags`.
- **Klickbare Task-Checkboxen** (`view/task-toggle.ts` + `prepareMarkdownView`
  in `view/markdown.ts`): Ein Klick auf `- [ ]`/`- [x]` in View, Split und
  Live-Preview toggelt die **Quelle** über `FolioEditor.applyReplace` — kein
  eigener Backend-Schreibpfad, damit Undo/Redo, Dirty-State und Save-Pfad
  gratis erben. Das Dokument wird dadurch dirty wie bei einer
  Tastatureingabe (gewollt). Drei bewusste Entscheidungen:
  1. **`disabled` bleibt im Backend-HTML** (`normalize_tasklist_html`) und
     wird NUR clientseitig in `prepareMarkdownView` entfernt. Grund: der
     Renderer bedient auch HTML-/PDF-Export, Export-Vorschau und
     Theme-Editor — dort gibt es keinen Handler, aktive Checkboxen würden
     dem Leser Interaktivität vortäuschen. Interaktivität ist Eigenschaft
     der App, nicht des Dokuments.
  2. **Stale-Guard über Monacos `versionId`**, nicht über Textvergleich:
     `prepareMarkdownView` stempelt bei JEDEM HTML-Setzen (Live-Preview
     UND `document:loaded`) `data-render-version` auf den Content-Container;
     weicht sie beim Klick ab, ist das DOM veraltet → Abbruch. Nötig, weil
     Zeilennummer + Zustand keine Identität sind: Wird oberhalb eine Zeile
     eingefügt, während die debouncte Preview hinterherhinkt, träfe ein
     Klick sonst einen gleichzuständigen Nachbar-Task (Review-Befund
     2026-08-13). Fehlt die Version, gilt das DOM als stale.
  3. **Klickziel nur `li.task-list-item[data-line]`** — ein weiterer
     `closest`-Selektor würde bei fehlendem `data-line` auf die `ul`
     steigen und die Listen-Startzeile toggeln.
  Der Regex deckt `-`/`*`/`+`, geordnete (`1.`/`1)`) und Blockquote-Tasks
  ab (comrak rendert alle als Checkbox). Tastaturzugang bleibt bewusst
  erhalten (kein `tabindex="-1"`), dafür setzt die View ein `aria-label`
  aus dem Item-Text. E2E `55_task_checkboxes`.
- **View-Themes** (`view/theme.ts`, Backend-Commands `view_themes` /
  `view_theme_css`): Theme-CSS ist immer auf `.markdown-body` gescopt
  und wird ueber `#view-theme-style` als letztes Element in `head`
  injiziert. Die Export-Layouts sind in Content-CSS (`<id>.css`, fuer
  View + Export) und Seitenrahmen (`<id>.page.css`, nur Export)
  getrennt; der Export verwendet weiterhin ausschliesslich die
  Light-Variante. Dark-Overrides werden nach dem Light-CSS angehaengt.
  Fehlt eine Dark-Variante (bewusst bei `classic`), liefert das Backend
  auch fuer `dark=true` das Light-CSS; unbekannte gespeicherte IDs
  fallen im Frontend effektiv auf `standard` zurueck. Eigene Themes
  liegen unter `<config>/folio/themes/`: `<id>.css` ist Pflicht,
  `<id>.dark.css` und `<id>.page.css` sind optional. Fehlt das Page-CSS,
  verwendet der Export einen weissen, randlosen Seitenrahmen. In den
  ersten zehn Zeilen der Hauptdatei koennen `/* name: ... */` und
  `/* description: ... */` (Schluessel case-insensitive) stehen.
  `/* code: dark */` waehlt fuer den Export die dunkle syntect-Palette;
  `light` bzw. ein fehlender/ungueltiger Wert verwenden die helle Palette.
  Built-in-IDs gewinnen bei Kollisionen; ungueltige/verschwundene IDs
  folgen dem bestehenden Unknown-ID-/`standard`-Fallback. Die Theme-Liste
  und CSS-Dateien werden bei jedem Aufruf neu gelesen; es gibt in dieser
  Etappe keinen Cache oder File-Watcher. Export-Theme-Favoriten werden als
  geordnete ID-Liste `themeFavorites` in `settings.json` gespeichert und im
  Export-Dialog vor den weiteren Layouts angezeigt; `standard` ist kein
  Export-Layout und daher nicht favorisierbar. Verschwundene Custom-Theme-IDs
  bleiben beim Laden erhalten, werden in der UI aber ausgeblendet.
  HTML- und PDF-Export rendern Code-Fences backendseitig mit syntect und
  selbstenthaltenen Inline-Styles (`InspiredGitHub`, bei `code: dark`
  `base16-ocean.dark`). Die App-View bleibt davon getrennt und nutzt weiter
  `view/code-highlight.ts`/Monaco; `render_body` bleibt ohne Backend-
  Highlighting. Der Ausbau E1–E10 ist umgesetzt (In-App-Theme-Editor als
  virtueller Tab, Verzeichnis-Paketformat mit `theme.json`-Manifest inkl.
  Font-Feldern `fontBody`/`fontMono`/`fontSize`, Templates/Assets,
  `.mdtheme`-Import/Export, Settings-Theme-Browser mit Master-Detail und
  expliziter View-Auswahl, KI-Autor sowie dokumentspezifischer
  Per-Export-KI-Draft im Export-Dialog): Architektur und Etappen in
  [`docs/spec-theme-system.md`](docs/spec-theme-system.md).
- **Image-View** (`view/image.ts`, Surface `#image-view-mount` in
  `dist/index.html`): `FileKind::Image` (png/jpg/jpeg/gif/webp/svg/
  bmp/ico/avif) wird read-only über `<img src={convertFileSrc(path)}>`
  gerendert. Fit/Zoom/Pan laufen per CSS-`transform: translate+scale`
  (`transform-origin: 0 0`) auf dem `<img>`; Fit-Basis ist die
  per `naturalWidth/Height` vs. Container berechnete Pixelgröße
  (nicht `object-fit`, sonst mehrdeutige Transform-Mathe). Mathe
  DOM-frei in `view/image-transform.ts` (scale relativ zu Fit=1.0,
  Clamp `[1, 20]`, cursor-zentrierter Mausrad-Zoom, Drag-Pan bei
  scale>1 mit `setPointerCapture`, Doppelklick→Fit). Die Statusleiste
  zeigt unter `#status-image-zoom` den Zoomfaktor relativ zur
  Originalgröße (`fitScale × scale`, ganzzahlig „N %“; nur bei
  gemountetem Bild, Live-Update über `applyTransform`). Reset auf Fit
  bei `mountImageView`/`reloadImageView` (Dokumentwechsel bzw.
  externe Änderung). Edit-Mode ist für Image **gesperrt**
  (`applyDocKind` setzt `tb-mode-edit.disabled = true`,
  `menu_set_enabled view.mode.edit/file.save_as = false`); Backend
  zwingt beim Open via `document_service::apply_default_mode` auf
  View-Mode. `document_store::load_opaque(path)` setzt nur den Pfad,
  ohne die Datei zu lesen — keine MB-großen Bytes ins Memory, keine
  Encoding-Detection, startet aber den Datei-Watcher (`watch_non_fatal`):
  externe Änderungen laufen über die bestehende
  `document:external_changed`-Kette; das Frontend remountet bei
  `kind-image` nur das Bild (`reloadImageView`, Cache-Buster
  `?v=<Date.now()>` in `mountImageView`) statt den Text-Reload-Pfad
  zu nehmen.
- **Editor-Sprache (Monaco)**: zweite, unabhängige Klassifikation neben
  `FileKind` — `editor_language(path)` in `file_kind.rs` liefert eine
  Monaco-Sprach-ID (`markdown`, `json`, `typescript`, …, Default
  `plaintext`). Wird über `read_file`/`document:loaded` als `language`-
  Feld ans Frontend gegeben und bestimmt nur das Syntax-Highlighting im
  Monaco-Model. FileKind bleibt die Source of Truth für MD-vs-Nicht-MD
  (Toolbar/TOC/View-Mode); Picker/Override sind als TODO geplant.
- **History/Sitzungs-State**: `NavigationController::Entry` speichert pro
  Eintrag zusätzlich `view_mode`, `editor_scroll_y`, `editor_cursor`
  (neben `scroll_y`/`anchor`). Capture läuft automatisch über
  `set_view_mode` (Mode-Sync ins aktuelle Entry) und die
  `editorSelection`/`editorScroll`-Events aus den `editor/`-Modulen.
  Restore passiert ausschließlich im `navigation:changed`-Handler
  (Back/Forward); `openDocument`-Pfade (Vault-Klick, Datei-Dialog, Recent,
  Pin) erzeugen frische Entries und laden ohne Sprung.
  `commands::nav::move_history` und `automation/handlers/ui.rs::history_move`
  haben jeweils ein `can_go_back`/`can_go_forward`-Gate vor dem
  go_back/go_forward-Call — am Stack-Edge wird Ok(None) bzw.
  `{moved: false, entry: null}` geliefert, statt unnötig current() zu
  re-loaden.
- **Multi-Datei-Tabs** (Spec + Etappenhistorie:
  [`docs/spec-multi-tabs.md`](docs/spec-multi-tabs.md)): Backend ist
  Source of Truth — `tab_manager.rs::TabManager` haelt `Vec<Tab>` mit je
  eigenem `DocumentStore` (Datei+Watcher+Dirty) und
  `NavigationController` (History ist per Tab) plus `view_mode`.
  `document:*`-Events bleiben "aktiver Tab"-bezogen (mit `tabId`-Feld);
  `tabs:changed` traegt die Leisten-Sicht und triggert zugleich die
  Session-Persistenz. Frontend: `state/tabs.ts` rendert `#tab-bar` rein
  aus `tabs:changed`; `editor/mount.ts` cachet Monaco-Model+ViewState
  pro `tabId` (Undo-Stack ueberlebt Tab-Wechsel; Save-As/Rename behaelt
  das Model nur bei unveraendertem Inhalt — Ersetzen-Open im selben Tab
  setzt neuen Text). Oeffnen-Konventionen: Vault-Klick ersetzt im
  aktiven Tab, Ctrl/Cmd-Klick + Mittelklick + Kontextmenue "In neuem
  Tab oeffnen" nutzen `tab_open`; bereits offene Pfade werden aktiviert
  statt dupliziert; ein leerer aktiver Tab wird von `tab_open` recycelt.
  Extern geoeffnete Dateien (Single-Instance-Reinvoke) folgen dem
  Setting `openFileTarget` (`newtab` Default | `replace`), entschieden
  im Backend (`lib.rs`-single-instance-Callback). Quit-Gate (Strg+Q,
  Menue, Fenster-X) prueft `TabManager::any_dirty()`; das Frontend
  fragt jeden dirty Tab einzeln ab (`confirmAllDirtyTabs`).
  Shortcuts: Ctrl+Tab/Ctrl+Shift+Tab (Wechsel), Ctrl+W (schliessen).
  Automation: `GET /tabs`, `POST /tabs/open|close|activate|close_all|reorder`
  (Letzteres fuer E2E-Isolation — Tab-Szenarien raeumen damit im
  finally auf), `/state.tabs`.
  Tab-Drag-Reorder: Pointer-basiert exakt wie Pin-Reorder (vault/tree.ts),
  DRAG_THRESHOLD_PX=8 (quadratisch), Klick-Schlucken NUR bei echtem
  Reorder (Drop-Ziel), bewusst kein setPointerCapture. Backend:
  TabManager::reorder + tab_reorder + POST /tabs/reorder (nur
  Dokument-Tabs; virtuelle Tabs frontend-only ausgenommen). Reorder
  triggert emit_tabs_changed (inkl. Session-Persistenz).
  **Settings als virtueller Tab**: `#settings-dialog` ist kein Modal
  mehr, sondern eine Vollflaechen-Region in der `.content-region`
  (`body.settings-open` blendet die `.content-panes` aus). Der
  „⚙ Einstellungen"-Eintrag in der Tab-Leiste ist rein frontend-seitig
  (`state/tabs.ts::setSettingsTabOpen`, Hooks via
  `configureSettingsTab` — kein Backend-Tab, keine Persistenz).
  Klick auf einen Dokument-Tab oder Escape schliesst die Region;
  Enter schliesst bewusst NICHT mehr (Formular-Semantik).
- **Tab-Session-Persistenz**: Dokumenttragende Tabs werden in
  `workspace.json` als `open_tabs` plus `active_tab` (Index in dieser
  gefilterten Liste) gespeichert. Pfade sind wie alle Workspace-Pfade auf
  Forward-Slashes normalisiert. Beim Boot wird nur der aktive Tab geladen;
  inaktive Tabs halten `Tab.pending_path` und erzeugen bis zur ersten
  Aktivierung weder Datei-IO noch einen Watcher. Fehlende Restore-Pfade
  werden verworfen. Ein Boot-CLI-Pfad wird nach dem Restore als
  zusätzlicher aktiver Tab geöffnet beziehungsweise dedupliziert aktiviert.
- **UI-Toggle-Persistenz**: alle UI-Schalter mit Memo (Vault-Rail,
  TOC-Rail, Editor-Minimap, Cheatsheet-Position, Window-Geometrie,
  Pinned/Recent-Section-Expansion) sitzen in
  `panel_state.rs::PanelStateData` und werden in `panel-state.json`
  unter dem App-Config-Verzeichnis persistiert. Neue Toggles dort
  ergänzen, nicht eigene JSON-Files erfinden.
- **Fenster-Geometrie-Restore mit Off-Screen-Clamp**
  (`window_geometry.rs` + Boot-Pfad in `lib.rs`): die persistierte
  Position wird beim Boot nur angewendet, wenn ein greifbarer
  Titelleisten-Streifen (≥100×50 logische px) auf einer Monitor-
  **Work-Area** liegt; sonst Zentrierung auf dem primären Monitor bzw.
  (ohne Primary) OS-Default. Die Entscheidung fällt bewusst in
  **physischen** Pixeln — pro Monitor durch dessen Scale geteilte
  „logische" Rechtecke ergäben bei Mixed-DPI keine gemeinsame Fläche,
  und `set_position(LogicalPosition)` rechnet mit dem Scale des
  *Fensters*; Recenter wird deshalb als `PhysicalPosition` gesetzt.
  Save-Seite: `Moved`-Handler ignoriert minimierte Fenster,
  `set_window_position_in_memory` verwirft die Windows-Parkposition
  (≤ -30000, nur `cfg(windows)`) — sonst startete Folio nach
  Minimieren+Beenden bzw. Monitor-Abstecken unsichtbar
  (User-Report 2026-07-19).
- **Editor-`applyReplace`**: nutzt `editor.executeEdits(...)` (nicht
  `setValue`!) — letzteres clearet Monacos Undo-Stack und macht
  Bold-Wrap/Heading-Toggle/etc. destruktiv. Bei Erweiterungen rund um
  programmatic Editor-Writes diese Konvention beibehalten.
- **Code-View (Read-Only Monaco im View-Mode)**: Non-Markdown-Text-
  Dateien (JSON, XML, YAML, Code, …) bekommen im View-Mode eine
  eigene Monaco-Instanz neben dem Edit-Editor. Surface
  `window.FolioCodeView` (Bundle `editor/view-code.ts`,
  `editor/index.ts`), Container `#code-view-mount`. Auto-Format laeuft
  fuer ALLE Sprachen einheitlich ueber Monacos
  `editor.action.formatDocument` (gesteuert vom Setting
  `viewAutoFormat`, default an) — keine JSON-Sonderbehandlung.
  Sprachen ohne registrierten Formatter zeigen den Rohinhalt; ebenso
  wenn das Setting aus ist. Theme-Sync laeuft ueber `setEditorTheme`
  (in `editor/shell.ts`), das beide Surfaces aktualisiert. Die
  Folio-Find-Bar bedient den Code-View ueber eine zweite Monaco-
  Find-Controller-Instanz (`window.FolioCodeView.openFind/...`);
  Strg+F/F3 werden global von der Folio-Find-Bar abgefangen, Monacos
  internes Code-View-Find-Widget ist kein Nutzerpfad mehr.
  **Beide Monaco-Instanzen teilen einen einzigen AMD-Loader**
  ueber `editor/mount.ts::whenMonacoLoaded` — `loadMonaco()` wird
  exakt einmal beim Bundle-Init gerufen. Wer Monaco erweitert oder
  Worker konfiguriert, muss beide Pfade beruecksichtigen.
- **HTML-View-Suche** (`view/html.ts::HtmlFinder`): Fundstellen-
  Highlighting via CSS Custom Highlight API im Sandbox-iframe
  (`::highlight(folio-find)` / `::highlight(folio-find-active)`).
  Styles werden in `installPreviewDefaults` ins iframe-`<head>`
  injiziert; Farben identisch mit Markdown-View (`#FFD700` / `#FF8C00`).
  `activeHL.priority = 1` stellt sicher, dass der aktive Treffer
  (orange) immer über den normalen Treffern (gelb) gewinnt — auch in
  `markdown.ts::ViewFinder` so gesetzt. Scrollbar-Marker-Lane
  (`#html-marker-lane` in `dist/index.html`, CSS in `content.css`)
  zeigt Treffer-Positionen analog zu `#view-marker-lane` im Markdown-
  View; Koordinaten werden relativ zum iframe-`scrollingElement`
  berechnet. Im **Split-Mode** routen `SplitHtmlFinder`,
  `SplitCodeFinder` und `SplitFinder` (erzeugt von `makeSplitFinder(...)`
  in `find-bar.ts`) die Suche an **Editor + View-Seite** gleichzeitig;
  die View-Seite zeigt passive Highlights ohne aktiven Treffer. `getFinder()`
  in `find-bar.ts` entscheidet: `isEditMode()` → FolioEditor,
  `isSplitMode()` → SplitHtmlFinder/SplitCodeFinder/SplitFinder je nach
  Dokumenttyp, sonst → HtmlFinder/CodeViewFinder/ViewFinder.
- **MonacoEnvironment.getWorkerUrl**: in `editor/mount.ts::loadMonaco`
  wird vor `require.config(...)` ein Worker-Bootstrap via `data:`-URI
  registriert (`origin + /monaco/vs/base/worker/workerMain.js`). Ohne
  diesen Hook starten Monacos Sprach-Worker (JSON/TS/CSS/HTML/...) im
  AMD-Setup nicht, weshalb fruehere Versionen z. B. „Format Document"
  auf JSON still fehlschlugen. Bei einem Update der Monaco-Dependency
  pruefen, ob `workerMain.js` noch unter diesem Pfad liegt.
- **Image-Insert (Toolbar `tb-image` + Strg+V)**: Anders als die anderen
  Inline-Editor-Commands (Bold/Italic/Link über `apply_editor_command`)
  hat `tb-image` einen eigenen Frontend-Pfad — siehe `ui/image-dialog.ts`
  und `ui/paste-handler.ts`. Der Dialog liefert ein Bild aus
  Zwischenablage (Browser-Clipboard-API über `navigator.clipboard.read()`
  oder den ClipboardEvent aus dem Capture-Paste-Handler) oder einer
  Datei, schreibt es über `save_clipboard_image` / `save_file_image` ins
  Doc-Verzeichnis (oder ein gemerktes Per-Doc-Verzeichnis), und der
  Frontend baut den Markdown-Tag mit dem zurückgegebenen relativen Pfad
  und fügt ihn via `FolioEditor.applyReplace` ein (Cursor-Position
  eingefroren beim Dialog-Open). Per-Doc-Verzeichnis liegt in
  `WorkspaceData.image_dirs: HashMap<DocPath, Dir>`. Relativer Pfad
  über `file_resolver::make_relative` (Wrapper um `pathdiff::diff_paths`,
  POSIX-Slashes für Markdown-Konvention). Clipboard-RGBA → PNG-Encoding
  passiert im Backend mit dem `image`-Crate.
- **Pre-Mount-Editor-Calls**: `mountReady` in `editor/mount.ts` ist seit
  2026-07-04 bis zum ERSTEN erfolgreichen `mount()` ein pending Promise
  (vorher `Promise.resolve()` — damals war jeder `mountReady.then(...)`-
  Retry-Defer eine Endlos-Microtask-Schleife, die zweimal das gesamte
  Frontend gekillt hat: Fix-Commit `f4ef8f1` und T4-Boot-Bug). Die
  Write-Funktionen in `editor/text.ts` deferieren über
  `deferUntilMounted` (genau EIN Retry nach dem ersten Mount, nur wenn
  der Editor existiert — niemals unbedingte Selbst-Rekursion!).
  Pre-Mount-OPTIONEN (Minimap, initiales Dokument) laufen weiterhin über
  pending-Variablen (`pendingMinimapEnabled`, `pendingDocument`), die
  `mount()` direkt in die `monaco.editor.create()`-Options zieht.
- **Logging** (`logging.rs`): `tracing` + `tracing-subscriber` mit
  Stderr- und täglich rotierendem File-Sink. Logverzeichnis pro OS via
  `persist::log_dir()` (Windows: `%LOCALAPPDATA%\Folio\logs`, macOS:
  `~/Library/Logs/Folio`, Linux: `$XDG_STATE_HOME/folio/logs`). Init
  läuft in `lib.rs::run` **vor** dem Tauri-Builder, damit Setup-Fehler
  ebenfalls landen. Level-Hierarchie beim Boot: `RUST_LOG` >
  `cfg(debug_assertions)` (→ `debug`) > Setting `logLevel`
  (Default `info`). **Wenn `RUST_LOG` beim Boot gesetzt war, ist der
  Live-Reload aus dem Settings-UI gesperrt** (`set_level` wird
  No-op + warn-Log) — sonst könnte ein versehentlicher UI-Wechsel den
  Diagnose-Override aufheben. Live-Reload sonst via
  `tracing_subscriber::reload::Handle`; `settings_update`-Side-Effect
  ruft `logging::set_level`, ohne App-Restart.
  Robustheit: `set_global_default`-Fehler werden in `init` mit
  `eprintln!` sichtbar gemacht und `RELOAD_HANDLE`/`FILE_GUARD`
  bleiben in dem Fall leer (kein dangling Handle). Ein ungültiger
  `RUST_LOG`-Ausdruck wird vor dem Subscriber-Setup mit `eprintln!`
  geflaggt und auf `info` zurückgefallen.
  **Keine** `eprintln!`/`println!` in Production-Code mit Ausnahme
  von `logging.rs::init` (vor der Subscriber-Installation) — Tests
  dürfen. Sonst `tracing::{error,warn,info,debug}!` mit explizitem
  `target: "folio::*"`-Namespace (z. B. `folio::ipc`, `folio::vault`,
  `folio::automation`, `folio::menu`, `folio::settings`). Externe
  Crates (axum/tokio/notify) werden im `env_filter()` der
  `LogLevel`-Stufen bei `warn` gehalten, um Request-Spam zu vermeiden.
  Rotation: tägliche Dateinamen `YYYY-MM-DD.log` (kein Prefix —
  Folio-Kontext steckt im Verzeichnis, dafuer chronologisch
  sortierbar und von Folio selbst als `Text` klassifiziert/oeffenbar).
  Retention 7 Tage, Best-Effort-Prune beim Boot.
- **Frontend-Logging** (`util/log.ts` + `commands/app/log_bridge.rs`):
  `folioLog.{error,warn,info,debug,trace}(source, message, fields?)`
  ruft den Tauri-Command `frontend_log`, der mit `tracing::*!` ins
  selbe Logfile schreibt (Target `folio::frontend`, fixer Wert —
  `tracing` verlangt `'static str`, deshalb steckt der konkrete
  Sub-Bereich im `source`-Feld statt im Target-Pfad). Frontend
  **filtert vor**: `log.ts` cached den `logLevel` aus den Settings
  (`settings:changed`-Listener + `applyLogLevelFromSettings` aus dem
  Boot-`settings_get`) und verwirft Events unterhalb dieses Levels,
  bevor sie zum IPC-Roundtrip werden. Caveat: weil der Cache nur das
  **Setting** kennt, sind Frontend-Traces unter `RUST_LOG=folio=trace`
  trotzdem stumm — Devs müssen in DevTools
  `window.__folioSetLogLevel('trace')` ausführen, um sie sichtbar zu
  machen. Das Settings-UI bietet `trace` bewusst nicht an.
  Statt stillem `invoke(...).catch(()=>{})` benutzen Aufrufer
  `safeInvoke(cmd, args, op, level?)` aus `util/log.ts` — der
  Wrapper schluckt Fehler nicht, sondern loggt sie standardisiert
  unter `source=ipc`. Level-Konvention: `warn` für User-sichtbare
  Operationen (set_view_mode, save, open), `debug` für hochfrequente
  State-Sync-Calls (menu_set_*, set_window_title, …) **und für
  per-Operation-Diagnose mit überschaubarer Frequenz** (z. B. ein
  Eintrag pro Code-Block in `code-highlight.ts` — selten >50 pro
  Dokument), `trace` ist für DevTools-Sessions reserviert
  (Release-Build hat DevTools standardmäßig aus, daher ohne
  Custom-Build nicht erreichbar). In Tests (jsdom) ist die Bridge
  ein No-op, weil `__TAURI__` nicht installiert ist; Aufrufer
  bleiben framework-frei.

## KI-Integration

- Backend-Module liegen unter `src-tauri/src/ai/`: `catalog.rs` lädt den
  eingebetteten models.dev-Snapshot bzw. den explizit aktualisierten Cache,
  `config.rs` verwaltet Provider/Whitelists/Defaults, `auth.rs` ausschließlich
  Schlüssel und `client.rs` den OpenAI-kompatiblen Chat-Call.
- Persistenz ist bewusst getrennt und folgt opencode: `ai.json` enthält
  Provider-/Modell-Konfiguration und Übersetzungshistorie, `auth.json`
  ausschließlich API-Keys (0600), `ai-catalog.json` den optionalen
  models.dev-Cache. Keys dürfen nie in Logs, Fehlern, DOM oder Automation
  erscheinen.
- Die Settings-Bereiche `KI-Anbieter` und `KI-Modelle` kuratieren aktive
  Provider und Modell-Whitelists. Nur freigeschaltete Modelle aktivierter
  Provider erscheinen im Übersetzungsdialog.
- **KI-Button-Gating** (🌐/✨ + Menü-Items): `documentIsMarkdown` in
  `translate-dialog.ts`/`ai-actions-dialog.ts` wird über das in-window
  CustomEvent `folio-doc-kind-changed` synchronisiert, das `applyDocKind`
  (state/document.ts) NACH dem Setzen der `body.kind-*`-Klasse dispatcht.
  Bewusst KEINE eigenen `document:loaded/closed`-Listener in den
  Dialogen: deren Aufruf-Reihenfolge relativ zum state-Handler ist nicht
  deterministisch (async `listen`-Registrierung) — das war die
  Stale-Read-Race vom 2026-07-11 (Buttons hinkten dem Dokument-Zustand
  einen Event-Zyklus hinterher); außerdem erbt der CustomEvent-Weg den
  seq-Stale-Guard gratis. Config-Seite des Gatings: die Dialog-
  `configCache`s refreshen über `folio-ai-invoke-complete`, das nur der
  Settings-UI-Pfad (`invokeUi` in settings-ai.ts) dispatcht — wer
  KI-Config per Raw-Invoke ändert (Automation/E2E), muss den Dispatch
  nachbilden (siehe `_configure_provider` in E2E 45).
- „Bearbeiten → Mit KI übersetzen…“ synchronisiert zuerst den aktuellen
  Editorinhalt in den aktiven `DocumentStore` und ruft pro Zielsprache seriell
  `/chat/completions` mit `stream: true` auf. SSE-Deltas bauen die über den
  regulären Tab-Open-Pfad sofort angelegte Zieldatei live über den bestehenden
  Preview-/`renderGen`-Pfad auf; Provider mit `application/json` werden als
  Fallback weiterhin unterstützt. Die Statusleiste zeigt Sprache und
  Zeichenzahl und kann den Lauf abbrechen. Fertige Sprachen bleiben dabei
  erhalten, die gerade laufende leere Datei samt Tab wird aufgeräumt. Final
  schreibt der strikte Demaskierungs-Gate kollisionsfrei
  `<stem>.<lang>[-N].md` neben die Quelle und lädt den Tab kanonisch neu.
- **Deterministischer Code-Schutz** (`ai/mask.rs`): vor dem LLM-Call werden
  Frontmatter, Code-Blöcke (fenced + indented), Inline-Code sowie
  HTML-Blöcke/-Inlines per comrak-`sourcepos`-Byte-Ranges durch opake Token
  `⟦F<nonce>:<index>⟧` ersetzt und nach der Antwort wieder eingesetzt —
  Schutz hängt nicht mehr an der Prompt-Disziplin des Modells. Maskiert wird
  auf dem Original-String (kein AST-Roundtrip, keine Normalisierung); der
  Nonce ist deterministisch (Hochzählen bei Kollision, kein `rand`).
  `unmask` toleriert Whitespace/Backticks am Token; **fehlende Token sind
  ein Fehler pro Zielsprache** (kein stiller Codeverlust), Duplikate werden
  ersetzt + gewarnt. `unmask_partial` ersetzt für die Streaming-Anzeige nur
  bereits vollständig empfangene Token; `unmask` bleibt der finale
  Schreib-Gate. Lone-`\r`-Dokumente überspringen das Masking bewusst (Fallback
  auf reines Prompt-Verhalten). E2E-Szenario 34 verifiziert per SSE-Mock, dass
  geschützte Fragmente als Token ankommen und die Zieldatei die Original-Bytes
  1:1 enthält.
- **KI-Aktionen (✨)**: Toolbar-Split-Button + Ein-Dialog
  (Funktionsliste, editierbarer Prompt, Ziel/Scope/Modell) über der
  Template-Bibliothek `ai/actions.rs` (5 Built-ins eingebettet, eigene
  Templates als JSON unter `<config>/folio/prompts/`, Built-in-IDs
  gewinnen, frisch gelesen wie Themes). `ai_action_run` ist atomar an
  den Quell-Tab gebunden (sourceTabId + sha256-Snapshot + tab-gebundener
  `editor_text_changed`-Sync mit Lone-CR-Wächter) und läuft über den
  gemeinsamen atomaren KI-Admission-Guard (`ai_job_active` — Übersetzung/
  Theme-Autor/Aktionen schließen sich gegenseitig aus). Cancel/Events
  korrelieren über die runId aus dem `ai:action_started`-Handshake.
  Ziel „Neue Datei" folgt dem Übersetzungs-Muster (Reservierung → Tab →
  Stream-Preview → Ownership-geprüfter Write mit Conflict-Fallback-
  Reservierung; Cleanup discardet nie dirty Tabs); Ziel „Ersetzen"
  liefert Gate-and-Return und öffnet die **Diff-Review** (virtueller Tab
  `ai-diff`, Monaco-DiffEditor als vierte Surface `FolioDiffView`,
  modified editierbar): Die DiffEditor-Instanz ist **persistent** (wie der
  Haupteditor) — pro Review wird nur der Inhalt gewechselt (`setContents`/
  `clear`), NIE `dispose`/neu erstellt. Grund (Bug 2026-07-11 „Tasten zählen
  doppelt"): Monacos `createDiffEditor(...).dispose()` entfernt das Widget
  nicht aus `getDiffEditors()` und lässt seinen document-level Keybinding-
  Handler aktiv; pro mount/dispose-Zyklus akkumulierte ein weiterer Handler,
  sodass ab dem 2. Review jede Taste N-fach wirkte. `dispose` delegiert
  deshalb auf `clear` (Widget bleibt), `mount` ist idempotent. Übernehmen mit dreistufigem Guard (Quelltab
  existiert → aktiv → Snapshot; sonst Bestätigung), firstDiff-Cursor,
  ein Undo-Schritt via `applyReplace`. Revert-Buttons pro Änderungsblock
  sind permanent sichtbar (CSS-Override auf Monacos hover-only Gutter-Menü,
  gescopt auf `#ai-diff-region`; `renderMarginRevertIcon` ist bei aktivem
  `renderGutterMenu` inert und bewusst entfernt), Übernehmen wechselt aus dem
  View- in den Edit-Mode, `setMode`-Save-Gate gilt nur noch Richtung view
  (edit/split prompt-frei). Laufende Streams zeigen die Statusleisten
  (`.ai-translate-status`, Translate + Actions) mit Spinner + Akzent-Puls
  über die Klasse `ai-status-running` — Fehleranzeigen derselben Leiste
  animieren nicht; `prefers-reduced-motion`-Block muss die Zwei-Klassen-
  Spezifität spiegeln. Selektions-Scope nutzt strikte
  UTF-16→Byte-Konvertierung (`utf16_to_byte_offset_strict`, kein Clamp)
  und `mask_selection` (Grenzschnitt durch geschützte Ranges = Fehler);
  Prompt-Injection-Härtung über Nonce-Delimiter + Untrusted-Data-Regel.
  Favoriten: `aiActionFavorites`/`aiActionFavoriteHashes` in
  settings.json (Hash-Pinning — verändertes Custom-Template führt in
  den Dialog statt Direktausführung). Editierte Review zählt in allen
  Quit-Gates wie ein dirty Tab (`ai_review_state_set`); RunEvent::Exit
  cancelt aktive Läufe (≤2 s Cleanup-Wartefenster). Spec + Review-
  Historie: [`docs/spec-ki-actions.md`](docs/spec-ki-actions.md).
- Architektur, opencode-Parität und bewusste Folgepunkte stehen in
  [`docs/spec-ki-tab.md`](docs/spec-ki-tab.md).

## Headless-Screenshots

- **Monaco in Xvfb via Monitor-Capture**: `tauri-plugin-screenshots`
  v2.2.0 ist eingebunden (`Cargo.toml`, `lib.rs`, `automation/handlers/
  screenshot.rs`). `GET /screenshot` macht damit einen Monitor- (nicht
  Window-)Capture; das ist der einzige in Xvfb funktionierende Weg,
  Monacos Canvas-Output sichtbar zu erfassen. Window-basierte
  Screenshot-Libs (xcap o. ä.) lesen nur das Window-Pixmap und sehen
  den Canvas dort nicht. Test-Belege + Methodik in
  [`docs/headless-monaco-test-results.md`](docs/headless-monaco-test-results.md)
  (Option 3, Commit `b6a0996`); Hintergrund/Alternativen für andere
  Setups in [`docs/headless-monaco-screenshots.md`](docs/headless-monaco-screenshots.md).

- **Hintergrund-Test-Strategie**: "Unsichtbares" Ausführen für
  Automation-Tests ist **nur unter Linux via Xvfb** vorgesehen — die
  App läuft auf `DISPLAY=:99`, der interaktive User auf `:0`, kein
  Fenster auf seinem Schirm, `/screenshot` liefert sichtbares Monaco
  über Monitor-Capture im Xvfb-Framebuffer. Ein `--headless`-Flag für
  Windows ist **nicht gebaut** (Stand 2026-05-18): `xcap` filtert in
  `is_valid_window` Fenster des **eigenen Prozesses** raus
  (Deadlock-Vermeidung bei `GetWindowText*`) und blockiert damit jeden
  Window-Capture-Pfad von Folio auf sich selbst — egal ob `visible:
  false`, `set_skip_taskbar`, off-screen. Echtes Hidden-Headless auf
  Windows bräuchte einen direkten Win32-`PrintWindow`-Bypass; der
  Aufwand ist gegenüber dem Linux+Xvfb-Pfad nicht gerechtfertigt.

## E2E-Test-Suite

Vollständige UI-Coverage in `tests/e2e/` (51 Szenarien, Python +
Pillow): Boot, View-/Edit-/Split-Mode, Theme, Vault, Find (inkl.
Code-View), Workspace, Save-Roundtrip durch alle BOM/EOL-Kombis,
Undo/Redo, Toolbar-Commands (Bold/Italic/Heading), Menü-Coverage
(File/Edit/View/Help), DOM-Keybindings, Vault-Tree-Klicks, Pin/Unpin,
History-Back/Forward, Rechtsklick-Kontextmenüs, echter TOC-DOM-Klick,
HTML-View, Tabs (API/UI/Restore/Reorder), View-/Custom-Themes,
Theme-CRUD/-Browser/-Import-Export, Export-Highlighting, Mermaid
(View + Export), Link-in-neuem-Tab, Vault-Volltextsuche (API + UI),
Vault-Filter, Tab-Kontextmenü, Command Palette sowie KI-Settings,
KI-Übersetzung, KI-Theme-Autor, Export-KI-Draft und KI-Aktionen
(Mock-Provider). Der englische Boot ist über
`scripts/run-e2e.sh --lang-smoke` separat abgedeckt.

Wrapper: `bash scripts/run-e2e.sh` (Linux+Xvfb). Visual-Baselines in
`tests/e2e/baselines/`, Artefakte (gitignored) in
`tests/e2e/artifacts/<timestamp>/`. Bei fehlender Baseline wird sie beim
ersten Run automatisch angelegt. Der Wrapper bricht mit klarer Meldung
ab, wenn bereits eine Folio-Instanz des Users läuft (das
single-instance-Plugin würde die Test-Instanz sonst sofort still
beenden — Symptom: „Folio-Prozess ist gestorben", Log endet nach der
Logging-Init-Zeile).

**Kanonischer Reset pro Szenario**: `run.py` ruft vor jedem Szenario
`lib/reset.py::reset_canonical_state` auf — Tabs schließen, Settings
auf den Run-Start-Snapshot zurück, Theme light, Find-Bar zu, Mode view
(best effort), linke Rail sichtbar, Split 50 %, Recent-Liste leeren
(`POST /workspace/clear_recents`), danach `/sync/render`. Damit kodiert
jede Baseline nur noch den Zustand ihres eigenen Szenarios; der Reset
läuft in Voll- wie Auswahl-Läufen identisch.

**Einzelszenario-Läufe**: `bash scripts/run-e2e.sh 21_split_mode`
(Name oder Präfix, mehrere möglich) — vergleicht wie der Voll-Lauf
gegen die Baselines. Einzelne Baselines lassen sich direkt erneuern:
`bash scripts/run-e2e.sh 21_split_mode --update-baselines`.

**Screenshot-Sync**: `report.py::screenshot` ruft vor jeder Aufnahme
`POST /sync/render` (deterministischer rAF-Roundtrip-Ack, siehe
Automation-API oben) statt eines fixen Sleeps — das WebView-Reflow nach
Backend-State-Wechsel ist sonst nicht synchron. Bei Visual-Mismatch gibt
es **einen** Retry (erneut sync + Recapture): der rAF-Ack garantiert
nicht, dass WebKits Frame schon im Xvfb-Framebuffer angekommen ist
(Monitor-Capture liest den X-Server, nicht die Page) — ein veralteter
Frame verschwindet beim Recapture, eine echte Regression failt auch im
zweiten Versuch.

**Fixture-Isolation**: Schreibende Szenarien (03/08/10/11/15) modifizieren
Fixtures in place. `run.py` snapshottet `tests/e2e/fixtures/` beim Start
(als pristine angenommen) und stellt den Zustand **vor jedem Szenario +
am Ende** wieder her — am Original-Pfad, weil der in der Statusleiste
sichtbare Dateipfad Teil der Visual-Baseline ist. Ohne das leckte z. B.
die von 11/15 an `sample.md` angehängte Zeile in spätere Szenarien
(21_split). Konsequenz für neue Szenarien: Fixtures dürfen frei
beschrieben werden, aber **jedes Szenario muss seinen benötigten
View-Mode explizit setzen** (`api.mode(...)`) statt sich auf den
Vorzustand zu verlassen — `default_mode_{markdown,text}` ist `Current`
(behält den aktuellen Mode), sodass ein Mode aus dem Vorszenario sonst
leckt (war der 22_html_view-Folgefehler).

Xvfb-spezifische Eigenheiten (scrollY-Sync, Monaco-Canvas-Capture,
synthetic-keyboard-Fragilität bei Monaco-Shortcuts, native Tauri-Menüs
aus WebView unerreichbar, `alert()`-Blockade, `applyReplace`/
`history`-Historie der Bugfixes etc.) sind in
[`docs/e2e-headless-caveats.md`](docs/e2e-headless-caveats.md)
zusammengefasst — Pflichtlektüre vor dem Schreiben neuer Szenarien.

Szenarien können `DESKTOP_ONLY = True` als Modul-Konstante exportieren;
der Orchestrator skipt sie standardmäßig, `--include-desktop-only`
schaltet sie ein. Heute hat kein Szenario den Marker — die Infrastruktur
ist Vorhaltung für zukünftige Dialog-/OS-Eingang-Tests.

## GitHub

Remote: `ralfkuh-lab/folio`.
