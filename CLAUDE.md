# CLAUDE.md

## Projekt

**folio** — Markdown-Viewer/-Editor auf Tauri 2 + Rust. Live-Vorschau,
Vault-Navigation, Workspace-Pins, HTTP-Automation-API für E2E-Tests.

Offene Aufgaben werden in [`TODO.md`](TODO.md) gepflegt (priorisiert: hoch /
mittel / niedrig). Vor Vorschlägen, was als nächstes ansteht, dort nachsehen.

Abgeschlossene Refactoring-Pläne sind aus der laufenden Doku entfernt.
Historie steckt im Git-Log; aktuelle Architektur- und Arbeitsregeln stehen
hier, im README, in [`TODO.md`](TODO.md) und in den thematischen Dateien
unter `docs/`.

## Tech-Stack

- Rust 2021, Tauri 2
- comrak 0.35 (GFM-Markdown)
- axum 0.8 (Automation-API auf `127.0.0.1:9876`, Loopback-only, CORS für WebView-POSTs)
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

Frontend-Bundles (`app.bundle.js`, `app.css`, `editor.bundle.js`) sind
eingecheckt und müssen nur neu gebaut werden, wenn die jeweiligen Quellen
geändert wurden: `cd src-tauri/web && npm install && npm run build`.
Outputs landen in `../dist/`. Reihenfolge im `package.json`-Build-Script:
monaco-copy → editor.bundle → app.bundle → app.css.

Im HTML werden die Bundles in dieser Reihenfolge geladen
(`monaco/loader.js` → `editor.bundle.js` → `app.bundle.js`), ohne
`defer` und am Body-Ende — Top-Level-`getElementById`-Aufrufe greifen
nur, weil der DOM-Body zu diesem Zeitpunkt schon geparst ist.

Frontend-Quellen liegen in `src-tauri/web/`, ausgeliefert wird über
`src-tauri/dist/` — `dist/` darf keine npm-Artefakte mehr enthalten,
sonst lehnt Tauri den Build ab.

## Konventionen

- **Slugifier**: eigener in `heading_anchor.rs` (kein comrak-Default).
- **AST-Postprocess** in `renderer.rs` ergänzt fehlendes `GenericAttributes`-Feature.
- **CRLF/LF/BOM**: Roundtrip ist getestet (`document_store.rs`). Beim Schreiben
  Original-Encoding/Line-Endings beibehalten.
- **IPC-Payloads**: gerendertes HTML geht über Tauri-Events, nicht über Command-Returns.
  *Bewusste Ausnahme*: `render_markdown_preview` (Live-Preview im
  View-/Split-Mode) liefert HTML+TOC als Command-Return. Frontend
  treibt den Roundtrip aktiv (Debounce + Generation-Token-
  Invalidierung in `view/preview.ts`); das passt nicht ins
  Push-Event-Modell der kanonischen `document:loaded`/`saved`-Pfade.
- **Automation-API**: nur Loopback. Keine externen Bind-Adressen. WebView-POSTs brauchen
  CORS/OPTIONS-Preflight; `/click` akzeptiert IDs, `data-name` und CSS-Selektoren.
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
  leert den Puffer.
- **Vault-Markup**: Frontend erwartet Baum-Markup mit `.section`, `.node`, `.row`,
  `.caret`, `ul.children`. Jedes `.node` hat `data-path="<abs-path>"`
  und `title="<abs-path>"` (Tooltip).
- **Pfad-Normalisierung**: alle Pfade, die in DOM-`data-path`-Attribute,
  workspace.json-Speicher oder `is_pinned`/`is_expanded`-Vergleiche
  gehen, werden auf Forward-Slashes normalisiert (`\` → `/`).
  Implementiert in `Workspace::pin/unpin/is_pinned/add_recent/
  remove_recent/image_dir/set_image_dir`, `Vault::set_active/
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
  Menue/Automation.
- **Live-Preview** (`view/preview.ts`, Backend-Command
  `render_markdown_preview`): im Split-/View-Mode rendert das Frontend
  den aktuellen Editor-Text debounced 150 ms ohne Save. Trigger ist das
  in-window CustomEvent `folio-editor-text-updated` aus
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
- **Image-View** (`view/image.ts`, Surface `#image-view-mount` in
  `dist/index.html`): `FileKind::Image` (png/jpg/jpeg/gif/webp/svg/
  bmp/ico/avif) wird read-only über `<img src={convertFileSrc(path)}>`
  gerendert. CSS in `content.css` zentriert das Bild und skaliert
  größere Bilder via `max-width/height: 100%` proportional runter;
  kleinere Bilder bleiben in Originalgröße. Edit-Mode ist für Image
  **gesperrt** (`applyDocKind` setzt `tb-mode-edit.disabled = true`,
  `menu_set_enabled view.mode.edit/file.save_as = false`); Backend
  zwingt beim Open via `document_service::apply_default_mode` auf
  View-Mode. `document_store::load_opaque(path)` setzt nur den Pfad,
  ohne die Datei zu lesen — keine MB-großen Bytes ins Memory, keine
  Encoding-Detection. Image-Watcher ist heute nicht angeschlossen;
  externe Änderungen erfordern einen Re-Open.
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
- **UI-Toggle-Persistenz**: alle UI-Schalter mit Memo (Vault-Rail,
  TOC-Rail, Editor-Minimap, Cheatsheet-Position, Window-Geometrie,
  Pinned/Recent-Section-Expansion) sitzen in
  `panel_state.rs::PanelStateData` und werden in `panel-state.json`
  unter dem App-Config-Verzeichnis persistiert. Neue Toggles dort
  ergänzen, nicht eigene JSON-Files erfinden.
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
  (in `editor/shell.ts`), das beide Surfaces aktualisiert. Code-View
  hat sein eigenes Find-Widget (Strg+F) — die Folio-Find-Bar
  uebersetzt den Capture-Listener bei `kind=text + !edit-mode` an
  Monaco. **Beide Monaco-Instanzen teilen einen einzigen AMD-Loader**
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
  berechnet. Im **Split-Mode** routet `SplitHtmlFinder` (erzeugt von
  `makeSplitFinder(HtmlFinder)` in `find-bar.ts`) die Suche an
  **Editor + HtmlFinder** gleichzeitig — analog zu `SplitFinder` für
  Markdown. `getFinder()` in `find-bar.ts` entscheidet:
  `isEditMode()` → FolioEditor, `isSplitMode()` →
  SplitHtmlFinder/SplitFinder je nach `isHtmlPreviewMode()`,
  sonst → HtmlFinder/ViewFinder.
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
- **Pre-Mount-Editor-Optionen**: Editor-Optionen, die schon beim Boot
  gesetzt werden (heute nur Minimap aus dem persistierten Panel-State),
  laufen über eine `pendingMinimapEnabled`-Variable in `editor/mount.ts`,
  die `mount()` in die initialen `monaco.editor.create()`-Options zieht.
  KEIN `mountReady.then(...)`-Defer für Pre-Mount-Calls: `mountReady` ist
  bis zum ersten Mount `Promise.resolve()`, ein Defer wäre eine
  Endlos-Microtask-Schleife (war der Bug, der bei Folio-Start ohne offene
  Datei das gesamte Frontend killte; siehe Fix-Commit `f4ef8f1`).
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

Vollständige UI-Coverage in `tests/e2e/` (22 Szenarien, Python +
Pillow): Boot, View-/Edit-/Split-Mode, Theme, Vault, Find, Workspace,
Save-Roundtrip durch alle BOM/EOL-Kombis, Undo/Redo, Toolbar-Commands
(Bold/Italic/Heading), Menü-Coverage (File/Edit/View/Help), DOM-
Keybindings, Vault-Tree-Klicks, Pin/Unpin, History-Back/Forward,
Rechtsklick-Kontextmenüs, echter TOC-DOM-Klick, HTML-View.

Wrapper: `bash scripts/run-e2e.sh` (Linux+Xvfb). Visual-Baselines in
`tests/e2e/baselines/`, Artefakte (gitignored) in
`tests/e2e/artifacts/<timestamp>/`. Bei fehlender Baseline wird sie beim
ersten Run automatisch angelegt.

**Screenshot-Sync**: `report.py::screenshot` ruft vor jeder Aufnahme
`POST /sync/render` (deterministischer rAF-Roundtrip-Ack, siehe
Automation-API oben) statt eines fixen Sleeps — das WebView-Reflow nach
Backend-State-Wechsel ist sonst nicht synchron.

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
