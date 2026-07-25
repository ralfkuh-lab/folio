# Spec: Statusleisten-Ausbau — Cursor-Position, Selektions-Stats, EOL-Umschalter

Stand: 2026-07-25. Quelle: `docs/feature-ideen.md` (Top-Konsens #9),
Rest-Scope nach Abgleich mit dem Ist-Zustand. **Bewusst NICHT im Scope**:
Lesezeit (User-Entscheid 2026-07-25), Encoding-*Umschalter* (nur Anzeige
existiert seit `db0d553`; Umschalter ggf. Folgepunkt), Selektions-Stats
für die View-Mode-Browser-Selektion (nur Editor).

## Ist-Zustand (relevant)

- Statusleiste in `dist/index.html` (Zeilen ~519–525): `#status-path`,
  `#status-wordcount`, `#status-encoding` (hidden, nur Nicht-UTF-8),
  `#status-image-zoom`, `#status-mode`, `#status-language` (Button),
  `#status-theme-toggle` (Button).
- Wortzählung: `state/document.ts::updateWordCount(text)` — Template-Keys
  `statusBar.wordCount.*` (words/chars/lines, `tPlural`).
- Cursor/Selektion: `editor/events.ts::onDidChangeCursorSelection` postet
  `editorSelection { start, length, line }` (UTF-16-Offsets) über die
  Bridge → `commands/events/router.rs` (History-Capture + Automation-State
  + Re-Emit `editor:selection`). **Column wird bisher nirgends erhoben.**
- EOL: `document_store.rs` normalisiert intern auf `\n`;
  `LineEnding { Lf, Crlf }` (Feld `line_ending`) entscheidet beim Save
  (`disk_text`). Mixed wird beim Load als `Crlf` klassifiziert (Test
  vorhanden). `document:loaded` trägt seit `db0d553` `encoding`, aber
  **kein** EOL-Feld; Muster `document:encoding_changed` + `#status-encoding`
  (JS-gesteuertes `hidden`) existiert als Vorlage.
- Dirty-Logik: `update_text` setzt `is_dirty = (text != clean_text)`.

## Feature 1 — Cursor-Position `#status-cursor`

- Neue Zelle (span) in `dist/index.html` **zwischen** `#status-wordcount`
  und `#status-encoding`.
- Quelle: `editor/events.ts::onDidChangeCursorSelection` dispatcht
  zusätzlich (RAF-debounced, analog Scroll-Listener) ein in-window
  CustomEvent `folio-editor-selection` mit
  `{ line, column, selChars, selWords }`:
  - `line`/`column` = `getPosition()` (Cursor-Ende, 1-basiert, Monaco-Konvention).
  - `selChars` = UTF-16-Länge der Selektion, `selWords` = `\S+`-Matches
    auf `model.getValueInRange(sel)`; bei leerer Selektion beide `0`
    (dann `getValueInRange` **nicht** aufrufen).
  - Der bestehende `post({type:'editorSelection',...})`-Pfad bleibt
    unverändert (History/Automation hängen dran).
- Konsument: `state/document.ts` (oder neues kleines Modul) rendert
  `t('statusBar.cursor.template', { line, column })`.
- Sichtbarkeit rein per CSS über Body-Klassen (Konvention „keine
  Frontend-Endungs-Heuristik"): nur `body.edit-mode` oder
  `body.split-mode`; in View-Mode/Settings/ohne Dokument ausgeblendet.
  Zusätzlich JS-`hidden` bis zum ersten Event nach `document:loaded`
  bzw. wieder `hidden` bei `document:closed`/Tab ohne Editorinhalt.

## Feature 2 — Selektions-Stats in `#status-wordcount`

- Bei `selChars > 0` (aus demselben CustomEvent) zeigt die Zelle
  stattdessen `statusBar.wordCount.selectionTemplate` mit
  `wordsPart`/`charsPart` (bestehende Plural-Keys wiederverwenden),
  de sinngemäß: `{wordsPart} · {charsPart} ausgewählt`.
- Bei `selChars == 0` zurück zu den Dokument-Stats. Dafür merkt sich
  `state/document.ts` die zuletzt gerenderten Dokument-Stats
  (Modul-State), statt den Text neu zu holen.
- `document:loaded`/`saved`/`closed` und Tab-Wechsel setzen auf
  Dokument-Stats zurück (Selektion ist danach ohnehin leer/ungültig).

## Feature 3 — EOL-Anzeige + Klick-Umschalter `#status-eol`

- Neuer **Button** (Muster `#status-language`) zwischen
  `#status-encoding` und `#status-mode`. Anzeige-Werte `LF`/`CRLF`
  (technische Labels, NICHT übersetzen); Tooltip-Key
  `statusBar.eol.tooltip` (de: „Zeilenenden umschalten (LF ↔ CRLF)").
- Sichtbar für `kind` markdown/text (JS-`hidden`-Pfad wie
  `#status-encoding`, inkl. `document:closed`-Aufräumen); versteckt für
  image/binary/kein Dokument.
- **Backend**:
  - `document:loaded`-Payload (`commands/file/types.rs` +
    `state.rs::emit_document_loaded` + alle Aufrufer inkl.
    `save_as`/`tabs`) bekommt `lineEnding: "lf" | "crlf"`.
  - Neuer Tauri-Command `set_line_ending(eol: "lf"|"crlf")` auf den
    **aktiven Tab**: setzt `document_store.line_ending`, aktualisiert
    Dirty (s. u.), feuert neues Event
    `document:eol_changed { eol, tabId }` (Muster `encoding_changed`)
    und den `dirty_changed`-Callback. No-op bei unverändertem Wert.
    Kein Umschalter für Opaque-Docs (image) — Command lehnt ab bzw.
    Frontend bietet ihn nicht an (Button hidden reicht, Command muss
    trotzdem defensiv sein).
  - **Dirty-Semantik**: `DocumentStore` erhält `clean_line_ending`
    (analog `clean_text`, gesetzt bei load/save/discard). Dirty ist ab
    jetzt `text != clean_text || line_ending != clean_line_ending` —
    sowohl in `set_line_ending` als auch in `update_text` (sonst
    resettet ein Tipp-Revert das EOL-Dirty fälschlich auf clean).
    Save schreibt wie bisher mit `self.line_ending` und setzt danach
    `clean_line_ending = line_ending`. Unit-Tests im `document_store`
    für: Toggle→dirty, Toggle+Save→Datei enthält neue EOL + clean,
    Toggle+Tipp-Revert→bleibt dirty, Doppel-Toggle zurück→clean.
  - Encoding-Interaktion: Save kodiert weiterhin ins Original-Encoding;
    EOL-Toggle ändert daran nichts (CRLF in UTF-16/1252 ist über die
    bestehenden Encoder-Pfade abgedeckt).
- **Frontend**: Zelle aktualisiert aus `document:loaded.lineEnding` und
  `document:eol_changed` (tabId-Guard gegen `getActiveTabId()` wie bei
  `saved`/`dirty_changed`; Alt-Payloads ohne Feld → Zelle hidden).
  Klick ruft `set_line_ending` mit dem jeweils anderen Wert über
  `safeInvoke` (Level `warn`).

## i18n

Neue Keys (alle 9 Kataloge + `locales/context/keys.json` +
`tests/fixtures/locales/fr.json`, alphabetisch einsortiert, identische
Key-Mengen — Katalog-Gates sind hart):

- `statusBar.cursor.template` (de: `Zeile {line}, Spalte {column}`;
  en: `Ln {line}, Col {column}`; übrige Sprachen sinngemäß kurz)
- `statusBar.cursor.tooltip` (de: „Cursorposition")
- `statusBar.eol.tooltip`
- `statusBar.wordCount.selectionTemplate`

## Automation & E2E

- `GET /state`: Dokument-Sektion um `lineEnding` ergänzen (für Asserts);
  `docs/automation-contract.md` additiv nachziehen (auch
  `document:eol_changed` + `set_line_ending` dokumentieren).
- Neues Szenario `tests/e2e/scenarios/52_statusbar.py`:
  1. CRLF-Fixture öffnen (Save-Roundtrip-Fixtures existieren) →
     `#status-eol` zeigt `CRLF` (via `/dom`).
  2. Edit-Mode → Selektion via `POST /editor/selection` setzen →
     `#status-wordcount` zeigt Selektions-Stats, `#status-cursor`
     plausible Ln/Sp (via `/dom`; Achtung: `/editor/selection` löst
     `onDidChangeCursorSelection` aus — falls nicht, `/eval`-Fallback).
  3. EOL-Toggle via `/click` auf `#status-eol` → dirty wird true
     (`/state`), Save → Datei-Bytes enthalten LF-only (Python-seitig
     lesen), Zelle zeigt `LF`.
  4. Aufräumen: Fixture-Restore übernimmt `run.py`; Mode-Reset beachten
     (jedes Szenario setzt seinen Mode explizit).
- **Bestehende Baselines**: `#status-cursor` erscheint in Edit-/Split-
  Szenarien, `#status-eol` in praktisch allen Text-Doc-Szenarien →
  betroffene Baselines nach Sichtprüfung mit `--update-baselines`
  erneuern; danach Voll-Lauf `bash scripts/run-e2e.sh` (2× grün wie
  üblich). `--lang-smoke` für den englischen Boot.
- vitest: `web/tests/state/document.test.ts` um Selektions-/EOL-Zellen-
  Fälle ergänzen (Muster Encoding-Tests aus `db0d553`);
  Editor-Event-Test für das neue CustomEvent, falls mit jsdom sinnvoll
  machbar (Monaco-Mock existiert in `tests/editor/find.test.ts`).

## Gates

`cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt
--check`, `cd src-tauri/web && npm test && npm run build` (Bundles
einchecken), i18n-/Referenz-Gates laufen in `cargo test` mit. E2E wie
oben.
