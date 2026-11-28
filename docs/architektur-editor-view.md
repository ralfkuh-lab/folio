# Architektur: Editor und Ansicht

Monaco-Editor, View-/Split-Mode, Live-Preview, Suche in der Ansicht und Einfügen. Ausgelagert aus der früheren `CLAUDE.md`; [`AGENTS.md`](../AGENTS.md) enthält nur noch den Index.

- **Breiten-Toggle „volle Breite"** (`tb-content-width`, Body-Klasse
  `content-wide`, persistiert als `content_wide` in `panel_state.rs`): hebt
  `max-width` auf `.markdown-body` auf. Bewusst **kein vierter View-Mode** —
  Modes schließen sich gegenseitig aus und sind pro Tab, die Breite ist dazu
  orthogonal und in View wie Split sinnvoll (gleiche Begründung wie beim
  Git-Diff-Button). Drei Punkte, die die Umsetzung klein halten:
  (1) Der Selektor `body.content-wide .markdown-body` (0,2,1) schlägt die
  `max-width`-Regeln **aller** View-Themes (0,1,0), obwohl deren CSS als
  letztes in den `<head>` injiziert wird — kein `!important`, aber auch kein
  Verlass darauf, falls ein künftiges Theme mit höherer Spezifität setzt.
  (2) Editor und Export brauchen **keine** Ausnahme: Monaco war nie
  breitenbegrenzt (`#editor-mount` ist `flex: 1 1 auto`), der Export rendert
  in ein eigenes Dokument mit der Papierbreite aus `<id>.page.css`, und die
  Theme-Editor-Vorschau hängt in einem `iframe` mit eigenem `body`. Deshalb
  reicht **eine** CSS-Zeile. (3) Sichtbarkeit über `md-only view-only`
  (`body.edit-mode .toolbar .view-only { display: none }` als Gegenstück zu
  `.edit-only`); den Enabled-Zustand des Menüeintrags `view.content_width`
  synct `syncCheatsheetMenu` mit — bewusst mit **anderer** Bedingung als
  Cheatsheet/Minimap (Markdown, aber NICHT Edit-Mode).
  Wirkt erst, wenn die View-Region breiter als die Lesebreite ist — bei
  offenen Rails auf 1280 px ist sie ~670 px breit und der Toggle bleibt
  folgenlos (kein Bug; genau deshalb blendet E2E `63_content_width` beide
  Rails aus und stellt den Splitter auf 20 %). Der kanonische E2E-Reset
  schaltet ihn zurück, weil er sonst in jede spätere Baseline mit sichtbarem
  Markdown wandert.
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
- **Callouts** (GitHub-Alerts `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`,
  case-insensitive): comrak `extension.alerts` in `markdown_options()`. Titel
  bleiben comraks englische Defaults (keine i18n, wie GitHub); ein eigener
  Titel (`> [!WARNING] Achtung`) ist **Klartext** — comrak hält ihn als String
  ohne Inline-Knoten, `[[…]]`/`` `…` ``/`**…**` darin werden nicht gerendert
  (Backlink-/Tag-Scan zählen sie zeilenbasiert trotzdem mit; bewusst so
  gelassen). Obsidian-Faltmarker `[!x]-`/`[!x]+` entfernt
  `renderer.rs::strip_alert_fold_markers` (kein Einklappen); unbekannte Typen
  (`[!todo]`) bleiben `blockquote`. **`ai/mask.rs` parst bewusst mit
  `alerts = false`**: genau wegen des Titel-Strings ginge Code/HTML auf der
  Markerzeile sonst unmaskiert ans LLM (Review-Befund 2026-10-09, Regression
  `alert_title_code_and_html_are_masked`). Optik: App in `content.css` über
  Tokens `--alert-<typ>[-bg]` aus `styles/base.css` (hell/dunkel); `classic`
  setzt die hellen Tokens selbst, weil sein Blatt im Dark-Mode weiß bleibt
  (gilt analog für Custom-Themes ohne Dark-Variante, siehe
  `docs/spec-theme-system.md`). Export fest hell in `layouts/base.css` inkl.
  `print-color-adjust`/`break-inside: avoid`. Icons sind CSS-Masken
  (`data:`-SVG). **Kontrastvertrag**: Titel ≥ 4,5:1, Boxtext ≥ 7:1 gegen den
  **komponierten** Boxhintergrund (Tönung ist halbtransparent) — E2E
  `64_callouts` misst das über alle 12 Themes hell/dunkel.
- **Smart-List im Markdown-Editor** (`editor/list-continue.ts` +
  `editor/events.ts::installSmartList`): Enter setzt Bullet-, Nummern-, Task-
  (`[x]` → `[ ]`) und Zitatzeilen fort, ein leeres Item beendet die Liste;
  Tab/Shift+Tab rücken Listenzeilen über `editor.action.indentLines`/
  `outdentLines` ein bzw. aus. Logik rein und vitest-getestet; Monaco-seitig
  drei `addAction`s nur am Haupteditor (nicht Code-View/Diff/Theme-Editor).
  Die `precondition` (`!editorReadonly && editorLangId == 'markdown'`) gilt
  auch für `editor.trigger` (so testet E2E `65_smart_list`, synthetische
  Tasten erreichen Monaco nicht); Fokus, Suggest-Widget (Wikilink-
  Autocomplete!), Snippet, Selektion und Mehrfach-Cursor stehen im
  `keybindingContext`, damit Monacos natives Verhalten dort unberührt bleibt.
  Jede Änderung ist **ein** `executeEdits` zwischen zwei `pushUndoStop`.
  Fences über `wikilink-complete.ts::isInsideCodeFence` (geteilt mit dem
  Autocomplete; CommonMark-Schließer, Zitat-Tiefe, Container-Ende). Keine
  Neunummerierung, kein Settings-Schalter. Bekannte Grenze siehe `TODO.md`.
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
- **Find-Bar: Regex und Ersetzen**. Der Options-Beutel hat zwei Typen —
  `FindOptions` (alle Felder optional) nur am **Eingang**
  (`setEditorFindTerm`, Automation), `ResolvedFindOptions` mit
  **Pflichtfeldern** an der `setFindOptions`-Grenze. Grund: ViewFinder/
  HtmlFinder setzten fehlende Felder auf `false`, Monaco patchte nur —
  zwei Semantiken hinter einem Aufruf. Mit Pflichtfeldern kompiliert ein
  unvollständiger Beutel nicht mehr.
  *Regex* gilt in allen Surfaces; die DOM-Finder kompilieren mit `gu`/`giu`
  wie Monaco (sonst weichen gültige Muster auseinander) und überspringen
  Zero-Width-Matches **codepoint-weise** (Surrogatpaar +2, nicht `++`) —
  analog `search.rs`. Ungültige Regex ist sichtbar (`invalidRegex` →
  Input-Klasse + Zähler), nie stilles „0 Treffer". *„Ganzes Wort" ist bei
  Regex deaktiviert*, weil die Vault-Suche Whole-Word im Regex-Modus
  prinzipbedingt nicht kann (Rust-`regex` ohne Lookarounds) — derselbe
  Begriff soll nicht zwei Bedeutungen haben.
  *Ersetzen* wirkt nur im Monaco-Puffer des aktiven Tabs; die Zeile ist
  ausschließlich über `body.edit-mode`/`body.split-mode` gegated (im
  View-Mode gibt es keinen Puffer). „Alle ersetzen" ist **ein** Undo-Schritt
  (ein `executeEdits` zwischen zwei `pushUndoStop`, nie `setValue`) und
  **lehnt oberhalb `REPLACE_ALL_CAP` sichtbar ab, statt still partiell zu
  ersetzen**. Scope „In Auswahl" ist ein **explizites Toggle**, keine
  Heuristik: Die Find-Bar selektiert den aktiven Treffer selbst, eine
  Herkunftserkennung per Offset-Vergleich hielte eine Handauswahl für die
  eigene. Alle Ersetzungs- **und** Navigationsaktionen rufen zuerst
  `flushPendingInputTerm()` — der Input ist 150 ms debounced, sonst wird
  mit dem vorherigen Term gearbeitet.
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
- **HTML als Markdown einfügen** (`ui/paste-handler.ts` +
  `ui/html-to-markdown.ts`, Surface `FolioEditor.pasteText`; Abhängigkeiten
  `turndown` + `@joplin/turndown-plugin-gfm`): Strg+V im Markdown-Editor
  wandelt `text/html` in Markdown um, Strg+Umschalt+V fügt reinen Text ein
  (Einmal-Flag aus dem keydown, nur im Editor gesetzt, jeder Paste verbraucht
  es, 1 s TTL). Vier Regeln, alle aus Review-Befunden: (1) **Ohne
  Markdown-Struktur** (nur `div`/`span`/`br`/`p` — VS Code, Terminals) liefert
  `htmlToMarkdown` `null` und Monaco fügt `text/plain` ein; sonst escapt
  turndown eingefügten Markdown-Quelltext. (2) **Im HTML-Fall nie der
  Bild-Dialog** — Word/Excel legen ein Vorschaubild daneben; jeder
  Fehler-/Ablehnungspfad (Exception, Fence, Mehrfach-Cursor, readOnly) lässt
  Monacos Default greifen, sonst geht der Text verloren. Nur HTML aus genau
  einem `img` (oder kein HTML) führt zum Bild-Dialog. (3) **Code byte-genau**:
  eigene `pre`-Regel (Fence-Länge über *alle* Backtick-Läufe, auch `<pre>`
  ohne `<code>`), Nachbearbeitung fence-bewusst auch hinter `> `-Präfixen.
  (4) `pasteText` ist **ein** `executeEdits` zwischen zwei `pushUndoStop`,
  Caret aus der inversen Operation (CRLF-Modelle). Inertes Parsen über
  `createHTMLDocument`; `javascript:`-Links bleiben im Markdown stehen und
  werden von comrak beim Rendern entschärft. Bekannte Grenze: Word-
  Pseudolisten (`MsoListParagraph`) bleiben Absätze. Nativ verifiziert
  2026-10-14 (WebKitGTK unter Xvfb, echte X-Zwischenablage über einen
  python-xlib-Selection-Owner, Tasten per xdotool: Strg+V, Strg+Umschalt+V,
  Undo/Redo, Quelltext-HTML, Fence, Word-HTML+Bild); kein E2E-Szenario.
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
