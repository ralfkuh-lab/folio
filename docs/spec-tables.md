# Spec: Tabellen — Formatieren im Editor, breite Tabellen, Sortieren und Filtern in der View

Stand: 2026-10-18 — **umgesetzt** (T1–T4, inkl. Review-Korrekturen; Abweichungen
im Abschnitt „Umsetzung“ am Ende). Quelle: `docs/feature-ideen.md` („Tabellen-
Auto-Format“) plus User-Wunsch 2026-10-18: breite Tabellen sind in der View
schlecht lesbar (die waagerechte Scrollbar sitzt am Tabellenende und ist bei
langen Tabellen nur mühsam erreichbar), dazu Sortieren per Klick auf die
Kopfzeile und Filtern.

**Bewusst NICHT im Scope**: Tabellen in der HTML-View (`.html`-Dateien im
Sandbox-iframe — fremdes Markup, nicht unseres), Sortieren/Filtern im Export,
Zurückschreiben einer Sortierung in die Datei, Format-on-Save, Spalten
umsortieren/ausblenden, CSV-Konverter (eigene Idee, kombiniert später gut mit
T1).

## Grundsätze

1. **Sortieren und Filtern ändern nur die Anzeige, nie die Datei.** Kein
   Dirty, kein Undo-Eintrag. Wer die Reihenfolge dauerhaft ändern will, macht
   das im Editor.
2. **Interaktivität nur in der App-View** (View, Split, Live-Preview). Der
   Renderer bedient auch HTML-/PDF-Export, Export-Vorschau und Theme-Editor —
   dort gibt es keine Handler, Sortierpfeile und Filterfeld würden
   Bedienbarkeit vortäuschen. Gleiche Begründung wie bei den Task-Checkboxen:
   Der Backend-HTML bleibt unverändert, alles passiert clientseitig an den
   bestehenden Post-Render-Stellen.
3. **Der Zustand überlebt Re-Renders.** Die Live-Preview ersetzt
   `.markdown-body.innerHTML` bei jedem Tippen; ohne Wiederanwendung spränge
   eine Sortierung im Split-Mode bei jedem Tastendruck zurück.
4. **Kein neuer Backend-Pfad.** Alles ist Frontend (View) bzw. editor-Bundle
   (T1).

## Ist-Zustand (relevant)

- comrak rendert GFM-Tabellen (`extension.table`) mit `data-sourcepos` und
  `data-line` auf `table`, `tr`, `th`, `td` (`renderer.rs`, Test
  `test_gfm_table`). Spaltenausrichtung kommt als `align="…"`-Attribut (nicht als `style`).
- Post-Render-Hooks laufen an **drei** Stellen identisch:
  `state/document.ts` (zweimal: `document:loaded`-Pfad und Tab-Pfad) und
  `view/preview.ts::applyToDom` — jeweils `highlightCodeBlocks` →
  `addCodeCopyButtons` → `renderMermaidBlocks` → `prepareMarkdownView`.
  `editor/shell.ts` (Theme-Wechsel) ruft nur Highlight + Mermaid neu.
- Vorbild für idempotentes, delegiertes Post-Processing: `view/code-copy.ts`
  (Mark-Attribut, ein delegierter Listener beim Boot, kein Listener pro
  Re-Render).
- Tabellen-CSS:
  - App-Default (`styles/content.css`, nur beim Theme „standard“):
    `display: block; width: max-content; max-width: 100%; overflow: auto`
    → die Tabelle scrollt selbst, Scrollbar am Tabellenende.
  - GitHub-Theme: dasselbe Muster.
  - Alle anderen Themes: `width: 100%` als echte Tabelle → eine breite
    Tabelle läuft **aus dem Blatt heraus**, und es scrollt die ganze
    `#view-content` waagerecht (Scrollbar ganz unten im Dokument).
    `brand`/`pastel` setzen zusätzlich `overflow: hidden` (vermutlich für
    runde Ecken) — in E2E prüfen, ob dort abgeschnitten wird.
  - Export: `layouts/base.css` setzt im Print `display: table; width: 100%`.
- Scroll-Sync (`view/scroll-sync.ts::lineElements`) sammelt alle
  `[data-line]`, sortiert nach Zeile und interpoliert über die
  Element-Positionen — setzt also voraus, dass Zeilennummer und vertikale
  Lage gleich laufen.
- View-Suche (`view/markdown.ts::ViewFinder`, `buildWalker`) läuft über alle
  Textknoten außer `script`/`style`, unabhängig von Sichtbarkeit.
- Editor: Smart-List (`editor/list-continue.ts` + `installSmartList`) ist das
  Muster für reine, vitest-getestete Logik plus Monaco-`addAction`.
  `isInsideCodeFence` aus `wikilink-complete.ts` ist geteilt.
  `editor_commands` (Rust, `apply_editor_command`) ersetzt den ganzen Text —
  für T1 bewusst **nicht** das Vorbild (siehe dort).

## T1 — Tabellen im Editor formatieren

**Verhalten**: Richtet GFM-Tabellen im Markdown-Quelltext aus — Spalten auf
gleiche Breite gepolstert, Trennzeile passend zur Breite und zur Ausrichtung.

```markdown
| Name | Wert | Notiz |
|:--|--:|:-:|
| Alpha | 1 | erste Zeile |
| B | 1000 | x |
```

wird zu (Stil wie Prettier: Trennzeile mit Leerzeichen, Spaltenbreite
mindestens 3, zentriert bei ungeradem Rest links abgerundet):

```markdown
| Name  | Wert |    Notiz    |
| :---- | ---: | :---------: |
| Alpha |    1 | erste Zeile |
| B     | 1000 |      x      |
```

**Einstiege**:
- Monaco „Dokument formatieren“ (Shift+Alt+F; Monacos Kontextmenü ist im
  Haupteditor abgeschaltet)
  über einen `DocumentFormattingEditProvider` für die Sprache `markdown`:
  formatiert **alle** Tabellen des Dokuments.
- Mit Selektion: `DocumentRangeFormattingEditProvider` („Auswahl
  formatieren“) — nur Tabellen, die die Auswahl berühren.
- Menü **Bearbeiten → Tabellen formatieren** (neue Menü-ID
  `edit.format_tables`, über `menu_dispatch` → Frontend ruft Monacos
  `editor.action.formatDocument` am Haupteditor). Damit erscheint es auch in
  der Command Palette. Enabled nur bei Markdown in Edit/Split (Sync analog
  `syncCheatsheetMenu`).
- **Kein Format-on-Save**: Das erzeugt ungefragt Diffs in fremden Dateien und
  in Git.

**Umsetzung**: neues Modul `editor/table-format.ts`, **rein** (Zeilen rein,
Edits raus) und vitest-getestet wie `list-continue.ts`. Die Provider liefern
pro Tabelle **ein** `TextEdit` nur über deren Zeilenbereich — kein Ersetzen
des ganzen Texts (Cursor, Undo-Granularität und Monaco-Decorations bleiben
heil). Monaco fasst die Edits eines Formatierlaufs zu einem Undo-Schritt
zusammen.

**Regeln**:
- Erkennung nach GFM: Kopfzeile, direkt darunter Trennzeile
  (`|? *:?-+:? *(| *:?-+:? *)* |?`), Kopf- und Trennzeile haben gleich viele
  Zellen; Datenzeilen bis zur ersten Leerzeile oder Zeile ohne `|`.
- Zellen trennen an **unmaskierten** `|`. `\|` bleibt Zellinhalt (auch in
  Inline-Code — so ist es in GFM). Zellinhalt wird getrimmt, sonst nicht
  angefasst.
- Ausgabe immer mit führendem und schließendem `|`, ein Leerzeichen
  Innenabstand. Trennzeile mindestens 3 Striche, Doppelpunkte nach
  Ausrichtung. Zellen links/zentriert/rechts gepolstert nach Ausrichtung der
  Spalte; ohne Angabe links.
- Zeilen mit weniger Zellen werden mit leeren Zellen aufgefüllt. Überzählige
  Zellen (GFM ignoriert sie beim Rendern) bleiben erhalten — Formatieren
  vernichtet keinen Text.
- **Präfixe**: Tabellen in Zitaten (`> `) oder eingerückt in Listen behalten
  ihr Präfix. Das Präfix der Kopfzeile gilt; weicht eine Zeile davon ab, wird
  die Tabelle nicht angefasst.
- Innerhalb von Code-Fences nie (`isInsideCodeFence`).
- **Zeichenbreite**: Monaco zeigt CJK-Zeichen und Emoji doppelt breit. Breite
  pro Zeichen über `Intl.Segmenter` (Grapheme) und eine kleine
  East-Asian-Wide-/Emoji-Tabelle (2 Spalten), sonst 1. Für Latin/ASCII exakt,
  für CJK/Emoji best effort (Monaco misst echte Glyphenbreiten; Fallback-
  Fonts sind nicht immer exakt doppelt breit). Keine neue Dependency.
- Bereits formatierte Tabellen erzeugen **keinen** Edit (idempotent, kein
  leerer Undo-Schritt).

**HTML als Markdown einfügen** (`ui/html-to-markdown.ts`, User-Wunsch
2026-10-18): Tabellen aus dem Paste kommen **gleich formatiert** an. Das ist
keine nachträgliche Änderung an der Datei, der Text wird ohnehin neu
eingefügt. Ist-Zustand (geprüft 2026-10-18): turndown-plugin-gfm liefert
`| --- | --- |` und polstert uneinheitlich (`| Alpha | 1   |` /
`| B   | 1000 |`), die Ausrichtung aus `style="text-align: right"` geht
verloren. Umsetzung: `htmlToMarkdown` jagt sein Ergebnis durch denselben
Formatierer (fence-bewusst, wie die bestehende Nachbearbeitung). Ausrichtung
aus dem HTML zu übernehmen ist ein eigener kleiner Schritt in der
turndown-Regel (Trennzeile `:--`/`--:`/`:-:` aus `text-align` bzw. `align`
der Kopfzellen).

Dafür muss der Formatierer **von beiden Bundles** nutzbar sein (app:
Paste-Pfad, editor: Monaco-Provider). Er bleibt deshalb ein reines Modul ohne
DOM und Monaco. Bisher importiert kein Bundle aus dem Verzeichnis des anderen;
der Ort (z. B. ein gemeinsames `web/shared/`, im `tsconfig`-`include`) wird
bei T1 festgelegt. esbuild bündelt das Modul dann in beide Bundles — bei der
Größe unerheblich.

**Tests**: vitest für Erkennung, Pipes/Escapes, Ausrichtung, Auffüllen,
Präfixe, Fence, CJK/Emoji, Idempotenz; in `html-to-markdown.test.ts` eine
gepolsterte Tabelle samt Rechtsausrichtung als exaktes Ergebnis. E2E: Fixture mit unformatierter
Tabelle, `menu_dispatch edit.format_tables`, Text per `/eval` vergleichen,
Undo stellt das Original wieder her (ein Schritt).

## T2 — Breite Tabellen in der View

**Verhalten**:
1. **Ausbrechen**: Ist eine Tabelle breiter als die Textspalte, darf sie die
   volle Breite der View nutzen (minus Seitenabstand), mittig. Der Fließtext
   bleibt schmal. Schmale Tabellen bleiben, wie das Theme sie setzt.
2. Ist sie auch dafür zu breit, scrollt sie **innerhalb** ihres Rahmens
   waagerecht — nie mehr die ganze `#view-content`.
3. **Vergrößern**: Jede Tabelle bekommt oben rechts einen Button (sichtbar
   bei Hover/Fokus wie der Code-Copy-Button). Er öffnet die Tabelle in einem
   großen Overlay: fast die ganze Fensterfläche, eigene Scrollbereiche in
   beide Richtungen, **feste Kopfzeile** (`position: sticky`). Damit sind
   Scrollbars immer im Blick. Escape, Klick auf den Hintergrund oder ✕
   schließen.

**Umsetzung**: neues Modul `view/tables.ts`, Aufruf `prepareTables(body)` an
den drei Post-Render-Stellen (neben `addCodeCopyButtons`).
- Jede `table` bekommt einen Wrapper `div.folio-table` (idempotent per
  Mark-Attribut) — der Wrapper scrollt, nicht die Tabelle und nicht die View.
- `#view-content` wird Size-Container (`container-type: inline-size`).
  Breite Tabellen bekommen per JS die Klasse `folio-table--wide`; CSS:
  `width: calc(100cqi - 2 * <gutter>)`, `margin-inline: calc(50% - 50cqi +
  <gutter>)`, `overflow-x: auto`. Gemessen wird `table.scrollWidth` gegen die
  Breite der Textspalte; neu gemessen per `ResizeObserver` auf
  `#view-content` (rAF-gebündelt) — Rails, Splitter und „volle Breite“
  ändern die Spalte.
- Die Theme-Regeln für die Tabelle bleiben, wie sie sind. Innerhalb des
  Wrappers neutralisiert die App nur das Scrollen der Tabelle selbst
  (`display: table` statt `block` für das App-Default und GitHub), damit
  genau **ein** Element scrollt. Spezifität wie beim Breiten-Toggle über
  `.view-content .folio-table > table`; kein `!important`.
- Overlay: natives `<dialog>` (`showModal`: Escape, Fokusfalle und
  `::backdrop` gratis), Markup in `dist/index.html`, Styles in
  `styles/overlays.css`. Die Tabelle wird **verschoben**, nicht geklont
  (Sortier-/Filterzustand und Listener bleiben dran), ein Platzhalter hält
  ihre Stelle; Schließen setzt sie zurück. Fokus zurück auf den Button.
- **Jeder Re-Render schließt das Overlay zuerst** (Hook vor dem
  `innerHTML`-Ersetzen). Sonst hielte der Dialog eine veraltete Tabelle,
  deren Platzhalter es nicht mehr gibt. Der Zustand (T3/T4) wird danach auf
  die neue Tabelle angewandt, nichts geht verloren. Im View-Mode passiert das
  nur bei externer Änderung oder Save.
- Das Overlay übernimmt die Theme-Optik: Es liegt in einem Container mit
  Klasse `markdown-body`, damit das Theme-CSS greift.

**Tests**: E2E mit einer Fixture-Tabelle aus vielen Spalten und Zeilen, je
ein Theme mit `display: block` (GitHub) und eines mit `width: 100%` (Clean):
`#view-content` hat keinen waagerechten Überlauf
(`scrollWidth <= clientWidth`), der Wrapper schon; Overlay öffnen (Screenshot
hell/dunkel), Escape schließt, Tabelle wieder an Ort und Stelle. Prüfen, ob
`brand`/`pastel` mit `overflow: hidden` etwas abschneiden.

## T3 — Sortieren per Klick auf die Kopfzeile

**Verhalten**: Klick auf eine Spaltenüberschrift schaltet durch:
aufsteigend → absteigend → Originalreihenfolge. Nur eine Spalte zugleich.
Pfeil in der Überschrift (▲/▼); `aria-sort` am `th`.

**Umsetzung** (in `view/tables.ts`):
- Der Inhalt jedes `th` wird in einen `button.folio-th-sort` gesetzt
  (Tastaturzugang ohne eigenes Key-Handling). Button-Styles auf `inherit`
  zurückgesetzt, damit das Theme die Überschrift weiter gestaltet; der Pfeil
  per `::after`.
- Delegierter Klick-Listener auf `#view-content` (einmal beim Boot, wie
  `initCodeCopy`).
- Jede Zeile merkt sich ihre Originalposition (`data-folio-row`); sortiert
  werden die `tr` im `tbody` per DOM-Verschieben (Knoten bleiben, also auch
  Wikilinks, Links und Code-Highlighting in den Zellen).
- **Vergleich**: Ist jede nicht leere Zelle der Spalte eine Zahl, wird
  numerisch sortiert. Als Zahl gilt, was nach Entfernen von
  Tausendertrennzeichen und Einheiten-/Prozentzeichen am Rand eine Zahl
  ergibt; Dezimal- und Tausendertrenner nach der Format-Locale der
  UI-Sprache (`@meta.locale`), zusätzlich immer der Punkt als Dezimaltrenner,
  wenn eindeutig. Sonst `Intl.Collator(locale, { numeric: true, sensitivity:
  'base' })` (also „Datei 2“ vor „Datei 10“). ISO-Daten sortieren damit
  ohnehin richtig. **Leere Zellen immer ans Ende**, in beiden Richtungen.
  Sortierung stabil.
- **Scroll-Sync**: Sortierte (und gefilterte, T4) Tabellen brechen die
  Annahme „Zeilennummer steigt nach unten“. `lineElements()` lässt deshalb
  `tr`/`td`/`th` in Tabellen mit Zustand weg und nimmt nur das `table`
  selbst; nach jeder Sortierung `invalidateLineElements()`.

## T4 — Filtern

**Verhalten**: Ein Filterfeld über der Tabelle grenzt die Zeilen auf die ein,
deren Text den Begriff enthält (alle Spalten, Groß-/Kleinschreibung egal,
Teilstring wie der Vault-Namensfilter). Daneben die Anzeige „12 von 40“.
Escape im Feld leert es. Kopfzeile bleibt immer sichtbar.

**Sichtbarkeit** (Empfehlung): Das Feld steht in einer kleinen Leiste über
der Tabelle zusammen mit dem Vergrößern-Button und erscheint **bei Hover oder
Fokus** auf der Tabelle — und immer, solange ein Filter aktiv ist. Für
Tabellen unter 6 Datenzeilen gibt es kein Filterfeld (Sortieren reicht da).
So bleibt ein Dokument mit vielen kleinen Tabellen ruhig.

**Umsetzung**: Nicht passende Zeilen bekommen `hidden`. Die View-Suche
(`buildWalker`) überspringt Textknoten in versteckten Zeilen — sonst zählt die
Find-Bar Treffer, zu denen sie nicht scrollen kann. Scroll-Sync wie in T3.

## Zustand und Wiedererkennung

- Pro Tabelle: `{ sortCol, sortDir, filter }`, im Speicher pro
  **Dokumentpfad**, nicht persistiert (nach Neustart ist alles wieder
  original — passt zu „nur Anzeige“).
- Schlüssel einer Tabelle: laufende Nummer im Dokument + Signatur der
  Kopfzeile (Texte der `th`). Nach einem Re-Render wird der Zustand auf die
  Tabelle mit gleichem Schlüssel angewandt. Ändert sich die Kopfzeile oder
  verschiebt sich die Tabellenanzahl davor, verfällt der Zustand still —
  lieber original als falsch zugeordnet.
- `document:closed` bzw. Tab-Schließen räumt den Eintrag des Pfads.

## i18n

Neue Keys (alle 9 Kataloge + Kontextsatz in `locales/context/keys.json`),
Namespace `view.table.*` bzw. Menü:
- `view.table.expand.tooltip`, `view.table.expand.ariaLabel`
- `view.table.overlay.close`, `view.table.overlay.ariaLabel`
- `view.table.sort.ariaLabel` (mit `{column}`)
- `view.table.filter.placeholder`, `view.table.filter.ariaLabel`
- `view.table.filter.count` (`{shown}`/`{total}`)
- Menü-Label für `edit.format_tables`

## Etappen

| Etappe | Inhalt | Aufwand |
|---|---|---|
| T1 | Tabellen im Editor formatieren, HTML-Paste formatiert mit | S |
| T2 | Breite Tabellen: Ausbrechen, Scrollen im Rahmen, Overlay | M |
| T3 | Sortieren | S–M |
| T4 | Filtern | S |

T1 ist unabhängig. T2 legt Wrapper und Modul an, auf denen T3/T4 aufbauen.
Jede Etappe einzeln lieferbar und per `.deb` testbar.

## Offene Punkte / bewusst später

- Format-on-Save als Setting — erst, wenn jemand danach fragt.
- Mehrspaltiges Sortieren (Shift+Klick).
- Filter pro Spalte statt über alle.
- Sortierung als „in Datei übernehmen“ (würde den Grundsatz 1 bewusst
  durchbrechen, deshalb eigener, expliziter Befehl).

## Umsetzung (2026-10-18) — Abweichungen und Ergänzungen zur Spec

- **Formatierer** liegt in `web/shared/markdown-table.ts` (beide Bundles),
  `isInsideCodeFence` dafür nach `web/shared/code-fence.ts` verschoben; sie
  erkennt jetzt auch Fence-Öffner hinter Listenmarkern (`- ```js`) samt
  Listen-Containerende. Tabellenende zusätzlich an Blockbeginn (Fence, ATX,
  Listenpunkt) und bei Präfixwechsel, wenn dort eine neue Tabelle beginnt
  (comrak-geprüft); sonst bleibt eine Tabelle mit abweichendem Präfix
  unverändert. HTML-Paste übernimmt die Ausrichtung der Kopfzeile, nicht die
  Mehrheit der Spalte (wie das GFM-Plugin).
- **Breite Tabellen**: „breit“ = passt auch gestaucht nicht in die Spalte.
  Im Scroll-Zustand und im Overlay `width: max-content`, kurze Zellen brechen
  nicht um; Zellen über 48 Zeichen (`folio-cell-long`) bekommen 24em Breite.
  Verschachtelte Tabellen (Liste/Zitat) scrollen nur, brechen nicht aus.
  Neumessen nur bei Breitenänderung und Theme-Wechsel.
- **Leiste**: Tabellen ab 6 Datenzeilen haben einen festen Platz für die
  Leiste im Fluss (die schwebende Leiste überdeckte sonst Text); kleinere
  behalten den schwebenden Vergrößern-Button.
- **Overlay**: Der ganze Rahmen (inkl. Leiste) wandert ins `<dialog>`; die
  Link-/Checkbox-Handler aus `initMarkdownView` hängen auch am Overlay, ein
  Link schließt es vor dem Routing. `document:closed` schließt es ebenfalls.
- **Sortieren**: Kopfzellen mit interaktivem Inhalt (Link) behalten ihn und
  bekommen einen eigenen kleinen Sortier-Button. Numerisch nur, wenn alle
  Zellen dieselbe Einheit/Währung tragen.
- **Suche**: Sortieren/Filtern zählen eine laufende View-Suche neu
  (`ViewFinder.refresh()`, ohne Sprung); Filtern hängt keine Zeilen um.
- **Farben** der App-UI im Dokument über `--folio-ui-fg`/`--folio-ui-accent`
  (an `:root` aufgelöst), weil Themes `--fg`/`--accent` auf `.markdown-body`
  überschreiben.
