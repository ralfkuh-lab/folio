# Spec: Find-Bar bedient den Code-View + Find-Invalidierung bei Dokumentwechsel

**Prio: kritisch (Release-Nachschub).** Reine Frontend-Änderung
(`src-tauri/web/`), kein Rust-Code betroffen.

## Problem (Ist-Zustand)

Die Suche ist für Non-Markdown-Text-Dateien (Code-View = Read-Only-Monaco
im View-Mode) funktional kaputt:

1. **Find-Bar sucht ins Leere**: `find-bar.ts::getFinder()` kennt nur
   `FolioEditor` (Edit-Mode), `ViewFinder` (Markdown-DOM) und `HtmlFinder`
   (HTML-iframe). Bei `kind=text` im View-Mode liefert er `ViewFinder`,
   der im leeren `.markdown-body` sucht → Counter „0/0", obwohl der
   Begriff im Code-View sichtbar ist. Betroffen sind alle Wege, die die
   Find-Bar öffnen: Toolbar-Lupe (`tb-find` → Backend `open_find` →
   Event `editor:open_find`), Menü „Bearbeiten → Suchen"
   (`menu-router.ts`), Automation `POST /find/text`.
2. **Strg+F/F3 verpuffen fokusabhängig**: der Capture-Listener in
   `find-bar.ts` lässt Strg+F und F3 bei aktivem Code-View bewusst durch
   (`isCodeViewActive()`), damit Monacos eingebautes Find-Widget öffnet.
   Das funktioniert aber nur, wenn der Monaco-Editor den Fokus hat. Liegt
   der Fokus auf Tab-Leiste/Vault/Body (typisch direkt nach Tab-Klick),
   passiert **gar nichts** — auf Windows als „Strg+F öffnet kein
   Suchfenster" gemeldet.
3. **Kein Invalidieren bei Dokument-/Tab-Wechsel**: `document:loaded`
   (Tab-Wechsel, Vault-Klick, Open) fasst die Find-Bar nicht an. Eine
   offene Bar behält Match-State/Counter/Highlights des alten Dokuments;
   Next/Prev arbeiten auf stalem State.

## Ziel-Design

**Eine Find-Bar für alles.** Die Folio-Find-Bar bedient künftig auch den
Code-View vollwertig; das „Durchreichen" an Monacos eingebautes Widget
entfällt ersatzlos. Beim Dokumentwechsel wird eine offene Suche auf dem
neuen Dokument neu ausgeführt (Bar bleibt offen, Term bleibt stehen —
analog zum bestehenden `afterModeSwitch`).

### 1. Find-Controller-Factory (`src-tauri/web/editor/`)

`editor/find.ts` enthält die komplette Monaco-Find-Logik (Match-Scan,
Decorations, Overview-Ruler, active-Match, `folio-find-state`-Event),
hängt aber fest an `state.getEditor()` (Edit-Instanz). Diese Logik zu
einer Factory generalisieren:

```ts
createFindController(opts: {
    getEditor: () => any;          // liefert die jeweilige Monaco-Instanz
    getMonaco: () => any;
    source: 'editor' | 'code-view'; // geht ins folio-find-state-Detail
    postToBridge?: boolean;         // editorFindState-post() nur für die Edit-Instanz
})
```

- Rückgabe: Objekt mit der bestehenden öffentlichen API
  (`openFind/closeFind/setFindTerm/setFindOptions/findNext/findPrev/
  recomputeMatches/hasActiveTerm`) plus **neu** `setSuppressActive(on)`
  (siehe Split-Mode unten): bei `true` bekommt kein Match die
  active-Klasse/-Farbe und es wird nicht zum aktiven Match gescrollt.
- Die bestehende Edit-Editor-Instanz (`source: 'editor'`,
  `postToBridge: true`) muss sich exakt wie heute verhalten —
  `window.FolioEditor`-Surface unverändert.
- Verhalten (Decorations-Klassen `folio-find-match[-active]`, Farben
  `#FFD700`/`#FF8C00`, revealActive-Semantik, wholeWord/caseSensitive)
  unverändert übernehmen, nicht neu erfinden.

### 2. Code-View-Finder (`editor/view-code.ts`)

- Zweite Controller-Instanz mit `getEditor` = Code-View-Editor,
  `source: 'code-view'`, ohne Bridge-Post.
- Über die `FolioCodeView`-Surface exportieren (`editor/index.ts`):
  `openFind/closeFind/setFindTerm/setFindOptions/findNext/findPrev/
  setSuppressActive`.
- `closeFind` darf den Code-View **nicht** fokussieren (kein
  `editor.focus()`-Zwang wie im Edit-Pfad nötig).
- Nach `mount()`/`applyContent()` (neues Model!) muss ein aktiver
  Find-Term auf dem neuen Model re-computed werden — Decorations des
  alten Models sind weg, der Controller darf keinen stalen Match-State
  behalten. (Model-Wechsel via `setModel` beachten: `deltaDecorations`-
  IDs des alten Models sind ungültig.)
- Auto-Format (`runAutoFormat`) läuft asynchron und ändert den Text
  nach dem Mount — nach erfolgreichem Format ebenfalls re-computen,
  sonst zeigen Decorations auf verschobene Offsets.

### 3. Routing in `ui/find-bar.ts`

- Neuer Mode-Check `isCodeViewMode()` =
  `kind-text && !edit-mode && !html-preview-mode` (Split zählt extra).
- `getFinder()`:
  - Edit-Mode → `window.FolioEditor` (unverändert)
  - Split-Mode → HTML? `SplitHtmlFinder` : `kind-text`?
    **`SplitCodeFinder`** : `SplitFinder`
  - View-Mode → HTML? `HtmlFinder` : `kind-text`? **CodeView-Finder**
    : `ViewFinder`
- `SplitCodeFinder` = `makeSplitFinder(<CodeView-Finder>)` — im
  Split-Mode treibt die Bar Editor + Code-View parallel; der Code-View
  bekommt via `setSuppressActive(true)` nur passive Highlights (gleiches
  Muster wie ViewFinder/HtmlFinder im Split).
- **Capture-Listener: `isCodeViewActive()`-Bypass komplett entfernen.**
  Strg+F und F3 öffnen jetzt in jedem Mode die Folio-Find-Bar
  (preventDefault+stopPropagation verhindern zugleich, dass Monacos
  eingebautes Widget im Code-View je aufgeht). Damit ist auch das
  fokusabhängige Windows-Problem weg.
- `close()` und `afterModeSwitch()`: zusätzlich den Code-View-Finder
  closen (gleiche „alle Finder closen"-Robustheit wie heute).
- `open()`: der `ensureEditorMounted`-Pfad gilt nur für Edit/Split;
  der reine Code-View-Fall braucht kein Edit-Editor-Mount.

### 4. Invalidierung bei Dokument-/Tab-Wechsel

- Neuer Export `afterDocumentSwitch()` in `find-bar.ts` (Muster =
  `afterModeSwitch`): wenn die Bar offen ist → alle Finder closen, dann
  den per `getFinder()` aktuellen Finder mit `input.value` + Optionen
  neu öffnen. `setTimeout(0)`, damit Rendering/Mount-Promises des neuen
  Dokuments zuerst drankommen. **Fokus nicht stehlen**: anders als
  `afterModeSwitch` kein `input.focus()/select()` — der User hat gerade
  Tab/Vault geklickt, nicht die Suche bedient.
- Aufruf am Ende des `document:loaded`-Handlers in
  `state/document.ts::initDocumentState`.
- Der Code-View-Mount ist promise-basiert — der Re-Compute nach Mount
  aus Punkt 2 fängt den Fall ab, dass `afterDocumentSwitch` vor dem
  fertigen Mount feuert.

### 5. Tests

**jsdom** (bestehende Infrastruktur, `src-tauri/web/tests/`):

- `tests/ui/find-bar.test.ts` erweitern:
  - Routing: `kind-text` + View-Mode → Code-View-Finder wird bedient
    (openFind/setFindTerm laufen dort auf, nicht im ViewFinder);
    Split + `kind-text` → Editor **und** Code-View-Finder.
  - Strg+F-Capture bei `kind-text` im View-Mode öffnet die Bar
    (Bypass weg); F3 ebenso.
  - `afterDocumentSwitch`: offene Bar → Finder wird auf neuem Dokument
    mit altem Term re-geöffnet; geschlossene Bar → no-op; Fokus bleibt
    unangetastet.
- Neue Tests für die Controller-Factory (Monaco-Mock wie in
  `tests/editor/mount.test.ts`): Matches/active/wholeWord/case,
  `setSuppressActive`, Re-Compute nach Model-Wechsel.

**E2E** (`tests/e2e/scenarios/`, neues Szenario `40_find_code_view.py`):

- Vor dem Schreiben `docs/e2e-headless-caveats.md` lesen (Pflicht).
- Ablauf: Text-Fixture öffnen (z. B. eine `.json`/`.rs` aus
  `tests/e2e/fixtures/`, ggf. Fixture ergänzen) → View-Mode explizit
  setzen (`api.mode(...)`) → `POST /find/text` mit sicher vorhandenem
  Begriff → Find-State über `/eval`/DOM prüfen: Counter zeigt `n/m` mit
  `m > 0`; `findNext` schaltet weiter.
- Multi-Dokument: zweites Dokument in neuem Tab öffnen
  (`POST /tabs/open`), Bar offen lassen, Tab wechseln → Counter/Matches
  gehören zum neuen Dokument (Begriff wählen, der in Doc A und B
  unterschiedliche Trefferzahl hat).
- Aufräumen im `finally`: Find-Bar schließen, `POST /tabs/close_all`
  (Konvention der Tab-Szenarien). Kein Baseline-Vergleich nötig —
  funktionale Asserts reichen; wenn Screenshots aufgenommen werden,
  Auto-Seed beim Voll-Lauf beachten.

### 6. Doku

- `docs/automation-contract.md`: falls dort Find-Verhalten beschrieben
  ist, um den Code-View-Fall ergänzen.
- `CLAUDE.md`: der Absatz „Code-View hat sein eigenes Find-Widget
  (Strg+F) — die Folio-Find-Bar uebersetzt den Capture-Listener …" ist
  nach dieser Änderung falsch → auf das neue Verhalten umschreiben
  (Folio-Find-Bar bedient den Code-View über einen zweiten
  Find-Controller; Monacos internes Widget ist nicht mehr erreichbar).

## Gates

- `cd src-tauri/web && npm test` grün (bestehende + neue Tests).
- `npm run build` läuft durch (Bundles neu bauen, Outputs in
  `../dist/` — sind eingecheckt und gehören zum Diff).
- Keine Rust-Änderungen; `cargo test`/E2E fährt der Reviewer.
- **Nicht committen.**

## Bewusst außen vor

- Kein Ersatz/Umbau von ViewFinder/HtmlFinder.
- Kein Picker/keine Options-UI-Änderung.
- Image-/Binary-Kinds: Bar darf aufgehen und „0/0" zeigen (wie heute) —
  kein Sonderpfad.
