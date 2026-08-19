# Spec: Hex-Ansicht für Binärdateien

Stand: 2026-08-19 · Status: Entwurf zur Umsetzung (Fassung 2, nach
Plan-Review durch codex und agy)

## Ziel

Binärdateien lassen sich in Folio öffnen und werden read-only als Hex-Dump
angezeigt (Offset, 16 Bytes je Zeile, ASCII-Spalte). Heute endet ein Klick auf
eine `.bin` oder `.zip` in `errors.file.unsupportedType` — die Datei ist in
Folio schlicht nicht erreichbar.

### Nicht-Ziele (V1)

- **Kein Editieren.** Hex-Editieren braucht Byte-Undo, eine eigene
  Save-Semantik und ein Overwrite-vs-Insert-Modell — ein eigenes Produkt.
- **Keine Hex-Ansicht für Text-/Markdown-Dateien.** Encoding und Zeilenende
  stehen bereits in der Statusleiste; erst Binärdateien lösen, dann bewerten.
- **Keine Suche im Hex-Dump.** Die Find-Bar sperrt bei `kind-binary` bereits ab
  (`ui/find-bar.ts:47`); das bleibt so.
- **Keine Positions-Wiederherstellung über einen App-Neustart hinweg.** Beim
  Restore beginnt die Ansicht definiert bei Byte 0. Innerhalb der Sitzung
  bleibt die Position dagegen pro Tab **und Pfad** erhalten (siehe
  „Laden, Races, Zustände").

## Vorbedingung: Opaque-Dokumente sind schreibgeschützt

Eigene, vorgeschaltete Teiletappe — nicht Teil dieser Spec, aber Bedingung für
sie. Belegt gegen eine laufende Instanz: `editor_text_changed` +
`editor_save_requested` auf einem geöffneten Bild überschreibt die Datei
(73-Byte-PNG → 6 Byte Text). `DocumentStore::update_text`/`save`/`save_as`
kennen `opaque` nicht; das heutige Gate sitzt allein im Frontend. Mit regulär
geöffneten Binärdateien wäre dieser Pfad alltäglich erreichbar. Das Gate
gehört in den Store, die Command-Schicht reicht den Fehler durch,
`set_view_mode` clampt opaque Dokumente auf `view`.

## Architektur-Entscheidungen

### 1. Hex ist kein vierter View-Mode

Die drei Modes (`view`/`edit`/`split`) sind orthogonal zum Dokumenttyp und
stecken in jeder Gate-Matrix: Body-Klassen, Ctrl+1/2/3, `default_mode_*`,
History-Restore, Find-Bar-Routing, Statusleisten-Sichtbarkeit, Live-Preview.
Ein vierter Mode müsste überall mitgeführt werden und erzeugt sinnlose
Kombinationen (Split aus Hex und Preview?).

Stattdessen folgt Hex dem **Image-View**: eine kind-basierte Surface im
View-Mode.

| | Image-View | Hex-View (neu) |
|---|---|---|
| Kind | `FileKind::Image` | `FileKind::Binary` |
| Body-Klasse | `kind-image` | `kind-binary` (im Frontend vorhanden) |
| Region/Mount | `#image-view-region` | `#hex-view-region` / `#hex-view-mount` |
| Modul | `view/image.ts` | `view/hex.ts` (+ DOM-freies `view/hex-format.ts`) |
| Store | `load_opaque` | `load_opaque` |
| Edit | gesperrt | gesperrt |

### 2. Ein Dokumenttyp wird genau einmal aufgelöst

Heute klassifiziert `read_file` tief, `load_by_kind` flach, `apply_default_mode`
erneut tief und `emit_document_loaded` noch einmal. Vier Sniffs derselben Datei
sind nicht nur Verschwendung — zwischen ihnen kann die Datei wechseln, und dann
meldet `document:loaded` Text, während der Store opaque ist (oder umgekehrt).

**Vertrag:** Der Öffnen-Service löst den Typ **einmal** mit `classify_deep` auf
und legt einen Deskriptor im Store/Tab ab:

```rust
struct DocumentDescriptor {
    kind: FileKind,     // aufgelöst, nicht neu berechenbar
    file_size: u64,     // letzte adressierbare Größe, nie über der Grenze
    revision: u64,      // monoton je Tab, überlebt Close
    too_large: bool,    // letzte beobachtete Größe über MAX_ADDRESSABLE
}
```

`tooLarge` geht additiv in `document:loaded` und `document:external_changed`.
Das Frontend darf `fileSize` dann nicht als aktuelle Länge behandeln: keine
neuen Chunk-Fenster jenseits der letzten adressierbaren Größe, Hex-Ansicht
zeigt den expliziten Übergrößen-Zustand statt eines abgeschnittenen Dumps.

Alles Weitere liest diesen Deskriptor, statt erneut zu klassifizieren:
`FileData`, `document:loaded`/`saved`, Default-Mode, History-Mode,
Tab-Aktivierung, `focus_existing_tab` und die Chunk-Autorisierung.
`load_by_kind` entscheidet anhand des aufgelösten `kind` zwischen `load` und
`load_opaque` — **mit `classify_deep`, nicht `classify`**: sonst landet eine
endungslose Textdatei (`INSTALL`, `untitled`) als leeres Binärdokument in der
Hex-Ansicht und die Inhaltserkennung der Vor-Etappe wäre im Lade-Pfad wieder
ausgehebelt. Bis Etappe 3 wird `Binary` dort abgelehnt statt opaque geladen.

Damit ist zugleich das **zentrale Gate** gebaut, das `TODO.md` fordert: die
drei Load-Funnels `document_service::open`, `load_active_pending` und
`move_history` decken Vault-Klick, `tab_open`, Command Palette, Drag&Drop,
Recent/Menü, CLI-Argument, Single-Instance-Reinvoke, `tab_restore_last`,
Session-Restore, History und die Automation-Endpunkte ab — ohne Binary-
Sonderfall an jedem einzelnen Einstieg.

**Stufenvertrag:** Etappe 1+2 lehnen `FileKind::Binary` in `load_by_kind`
ab, **bevor** Store, History oder Events mutieren (`errors.file.unsupportedType`).
`read_file` hat kein eigenes Gate. Etappe 3 entfernt genau diesen Zweig
und lädt Binary opaque in die Hex-Ansicht.

### 3. Der aufgelöste Typ bleibt für die Lebensdauer des Tabs stabil

Ein offenes Binärdokument, das nach `.txt` umbenannt wird, bleibt binär; ein
Textdokument bleibt Text. Grund: Ein Event, das nur das Kind umschaltet, ohne
den Store im selben Übergang neu zu laden, erzeugt widersprüchliche Zustände —
Frontend zeigt Editor, Store hat keinen Text (oder umgekehrt Hex-Ansicht auf
einem dirty Textpuffer). Rename aktualisiert Pfad, Größe und Revision, nicht
den Typ. Wer den Typ neu auflösen will, schließt den Tab und öffnet erneut.

### 4. Daten kommen gechunkt und revisionsgebunden

Das Dokument läuft über `load_opaque`: nur Pfad, kein Inhalt im Speicher,
Watcher aktiv. Die Bytes holt die Ansicht bedarfsweise.

Damit ist Öffnen unabhängig von der Dateigröße billig — **deshalb gibt es
bewusst keinen „Wirklich öffnen?"-Dialog**. Ein Dialog bei jeder Binärdatei ist
ab dem zweiten Mal nur Klickarbeit; die Sorge dahinter („das könnten 4 GB
sein") erledigt das Chunking.

## Backend

### Command `read_file_chunk`

```rust
#[tauri::command]
pub async fn read_file_chunk(
    tab_id: u64, revision: u64, offset: u64, len: u32, state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String>
```

- **Kein freier Pfad im Parameter.** Das Backend nimmt den Pfad aus dem Tab —
  ein Pfad vom Frontend wäre nach Rename oder Tab-Wechsel eine andere Datei als
  gemeint, und ein Generation-Token im Frontend verhindert nur das *Rendern*
  einer alten Antwort, nicht das Lesen der falschen Datei.
- Unter Lock wird geprüft: Tab existiert, Deskriptor ist binär, `revision`
  stimmt. Danach wird der Pfad kopiert und **der Lock vor dem I/O freigegeben**.
  Bei Revision-Mismatch antwortet der Command mit einem Fehler, dessen Text mit
  einem stabilen Präfix (`stale:`) beginnt — `Result<Response, String>` trägt
  keinen Fehlertyp, und das Frontend muss „veraltet" (still verwerfen) von
  „kaputt" (Fehlerzustand zeigen) unterscheiden können.
- I/O läuft in `spawn_blocking` — `std::fs` im async-Command blockiert sonst
  einen Runtime-Thread, und genau hier wird sichtbar lange gelesen.
- Metadaten kommen vom **geöffneten Handle**; nur reguläre, seekbare Dateien
  werden bedient (FIFO, Verzeichnis, Gerät → lokalisierter Fehler). Symlinks
  auf reguläre Dateien sind erlaubt.
- Gelesen wird in einer Schleife bzw. `take(...).read_to_end(...)` — ein
  einzelnes `read` darf laut `Read`-Vertrag kurz liefern.
- Die Revisionsprüfung **vor** dem Read schließt eine Änderung **währenddessen**
  nicht aus. Das ist bewusst „best effort bis zum nächsten Watcher-Event": ein
  Chunk kann Bytes einer bereits ersetzten Datei zeigen, bis das Event die
  Revision hochzieht und die Ansicht verwirft. Eine Nach-Read-Validierung von
  Größe und mtime ist die Alternative — für V1 nicht umgesetzt, aber hier
  notiert, damit die Lücke bekannt ist.
- `len` wird auf `MAX_CHUNK_BYTES` = 1 MiB geklemmt; `len == 0`, Offset
  jenseits EOF und überlaufende Offset-Rechnung liefern eine leere Antwort,
  keinen Fehler.
- Antwort sind rohe Bytes über `tauri::ipc::Response::new(Vec<u8>)`
  (verifiziert in Tauri 2.11: `Vec<u8>` wird `Raw`-Body, im Frontend
  `ArrayBuffer`). **Kein** JSON-Array von Zahlen.

### Deskriptor-Aktualisierung durch den Watcher

`document:external_changed` trägt heute nur Pfad und Tab-ID. Für Binärdokumente
aktualisiert das Backend Größe und Revision und gibt beides im Event mit, plus
einen Verfügbarkeitszustand (`available: false` bei gelöscht, nicht regulär
oder nicht lesbar — `regular_file_size` prüft Metadaten **und** `File::open`)
sowie `tooLarge`, wenn die Datei über der Adressierungsgrenze gewachsen ist.

Ohne das zeigt die Ansicht nach einem Truncate in einen Bereich, den es nicht
mehr gibt, liefert leere Chunks und scrollt ins Nichts; nach Wachstum bleibt
der neue Bereich unerreichbar.

### Größengrenze der Adressierung

Alle Offset-Rechnungen müssen innerhalb von `Number.MAX_SAFE_INTEGER`
(2^53 − 1 Bytes, rund 8 PiB) bleiben. Die Grenze gilt **nicht** für `fileSize`
allein: `windowStart + windowBytes` darf sie ebenfalls nicht überschreiten.
Deshalb prüft das Backend gegen `MAX_SAFE_INTEGER − MAX_WINDOW_BYTES` und
lehnt darüber mit lokalisierter Meldung ab; Grenzrechnungen im Frontend laufen
subtraktiv (`fileSize − windowStart`), nie additiv über die Grenze hinaus.
BigInt an der IPC-Grenze wäre die Alternative; für V1 ist die Grenze die
ehrlichere Lösung.

### Was **nicht** passiert

`errors.file.unsupportedType` bleibt im Katalog: Etappe 1+2 nutzen ihn als
zentrales Binary-Gate im Loader, `commands/git_cmd.rs` weiterhin für den
gesperrten Binär-Git-Diff. Erst wenn die letzte Referenz fällt, wird der Key
aus allen neun Katalogen und `locales/context/keys.json` entfernt (hartes
Referenz-Gate).

## Frontend

### Surface und Gates

- `dist/index.html`: Region `#hex-view-region` mit `#hex-view-mount`.
- `styles/content.css`: sichtbar **nur** im View-Mode
  (`body.kind-binary:not(.edit-mode):not(.split-mode)`) — `:not(.edit-mode)`
  allein würde im Split-Mode mitmatchen. Konkurrierende Content-Surfaces
  (Markdown, Code, HTML, Image) sind bei `kind-binary` ausgeblendet.
- `view/hex.ts` mit derselben Oberfläche wie `view/image.ts`:
  `mountHexView(...)`, `reloadHexView()`, `clearHexView()`, plus
  `getHexViewState()` (Pfad, fileSize, windowStart, geladene Blöcke,
  Fehlerzustand) für Vitest und E2E — unter Xvfb ist DOM-Polling auf
  asynchron gefüllte Zeilen fragil.
- Reine Rechenlogik (Offsets, ASCII-Spalte, Zeilenaufbau, Fenster- und
  Chunk-Mathematik) in `view/hex-format.ts`, DOM-frei, Vitest-getestet.

**Gate-Matrix für `kind-binary`** (heute wird Binary durchweg als „kein
Dokument" behandelt; alle folgenden Stellen sind betroffen):

| Aktion | erlaubt | Stelle |
|---|---|---|
| Öffnen, Schließen, Umbenennen | ja | `applyDocKind::hasDoc`, `palette-commands::hasDoc()` |
| View-Mode (Button, Menü, Häkchen) | ja | `hasViewMode`, `syncViewModeMenuChecks`, `palette-commands::hasViewMode()` |
| Edit, Split, Save, Save As, EOL | nein | `canEdit` (bleibt ohne Binary) |
| Export, Find, Git-Diff | nein | bestehende Markdown-/Text-Gates |

### Zeilenformat

```
00000000  4d 5a 90 00 03 00 00 00  04 00 00 00 ff ff 00 00  |MZ..............|
```

- Offset hex, Kleinbuchstaben, Breite = mindestens 8 Stellen, bei größeren
  Dateien so breit wie `fileSize` es verlangt (feste Breite pro Dokument, damit
  die Spalten nicht bei 4 GiB springen).
- 16 Bytes je Zeile, Gruppentrenner nach 8 Bytes; letzte Zeile mit Leerraum
  aufgefüllt, damit die ASCII-Spalte stehen bleibt.
- ASCII-Spalte: `0x20`–`0x7E` direkt, alles andere `.` — kein Unicode-Raten.
- Drei Spans je Zeile (`.hex-offset`, `.hex-bytes`, `.hex-ascii`), damit
  `user-select: none` den Offset aus der Markierung hält und ein Mausdrag
  kopierbare Bytes liefert.
- Zeilenhöhe als ganzzahliger Pixelwert, `height` = `line-height`,
  `box-sizing: border-box`. Gebrochene Höhen (`1.4em`) akkumulieren gegenüber
  `scrollTop` einen Fehler, der nach hunderttausend Zeilen sichtbar wird. CSS
  und TypeScript beziehen den Wert aus **einer** Quelle (gemessen, nicht
  dupliziert), und ein `ResizeObserver` rechnet bei Zoom/Resize neu.

### Fenster- und Chunk-Mathematik (verbindlich)

**Fensterwahl und Sprünge** gehen immer vom globalen Byte-Offset aus, nie von
der Scrollposition. Innerhalb eines Fensters bestimmt `scrollTop` dagegen sehr
wohl die sichtbare Zeile — das ist die Virtualisierung. Die Trennung: global
navigieren über Offsets, lokal rendern über `scrollTop`.

```
maxLines        = floor(SAFE_HEIGHT_PX / lineHeightPx)      // SAFE_HEIGHT_PX = 8_000_000
windowBytes     = min(MAX_WINDOW_BYTES, maxLines * 16)      // MAX_WINDOW_BYTES = 4 MiB
windowStart     = floor(target / windowBytes) * windowBytes // feste, nicht überlappende Seiten
windowEndExcl   = min(windowStart + windowBytes, fileSize)
rowOffset(i)    = windowStart + i * 16
chunkStart(o)   = floor(o / CHUNK_BYTES) * CHUNK_BYTES      // CHUNK_BYTES = 64 KiB
```

WebKits `LayoutUnit` deckelt Elementhöhen bei rund 33,5 Mio. px; ein naiver
Spacer über eine 1-GB-Datei kollabiert still, danach stimmt Scrollposition
gegen Offset nicht mehr. Das Höhenbudget statt einer festen Bytezahl hält die
Rechnung auch bei vergrößerter Schrift heil.

Explizit definiert und getestet: `fileSize == 0`, Ziel genau auf `fileSize`,
letzte Teilzeile, Prev/Next an den Rändern (deaktiviert statt No-op), und ob
die Anzeige „Bytes X–Y" inklusive oder exklusive Grenzen meint (inklusiv,
1-basiert für den Leser).

### Laden, Races, Zustände

- **Generation-Token** wird erhöht bei Mount, Clear, Tabwechsel, Fenstersprung
  und Revisionswechsel. Der Cache-Key ist `(tabId, revision, chunkStart)` —
  Revisionen sind nur **pro Tab** monoton, derselbe Zahlenwert kann in zwei
  Tabs verschiedene Dateien meinen. Verworfen werden veraltete **Erfolgs-
  und Fehlerantworten**, sofern die aktuelle Generation den Read nicht
  weiter nachfragt.
- **Dedup + Drosselung**: identische Blockanfragen werden zusammengefasst,
  höchstens 4 Reads laufen gleichzeitig — sonst startet schnelles Scrollen
  Dutzende 64-KiB-Aufträge. Ein Generationswechsel, der denselben Schlüssel
  noch braucht, hängt sich an den laufenden Read (Interessenten), statt
  dessen Ergebnis zu verwerfen und das Fenster leer zu lassen.
- **Position pro Tab und Pfad**: der oberste sichtbare globale Byte-Offset
  wird je `(tabId, path)` im Modul gehalten. Tabwechsel und History-Rückkehr
  zur **gleichen** Datei stellen die Stelle wieder her; ein *anderes*
  Dokument startet bei Byte 0, damit die Position nicht auf eine fremde
  Datei überspringt. Einträge verschwinden, wenn der Tab geschlossen wird
  (kein unbegrenztes Wachstum). Über einen App-Neustart hinweg wird nicht
  restauriert (Nicht-Ziel), History-Einträge tragen den Offset in V1 nicht.
- **In-Surface-Zustände** statt stiller Leere: *Laden*, *leer* (0 Bytes),
  *nicht verfügbar* (gelöscht/Rechte weg, mit Wiederholen-Aktion) und
  *Lesefehler*. Hinweise mit `aria-live`, das Offset-Feld mit `aria-invalid`
  und zugeordnetem Fehlertext.
- **Tastatur**: Container fokussierbar (`tabindex="0"`), Pfeile/PageUp/PageDown
  scrollen, Home/End springen an Anfang/Ende **der Datei** (nicht des
  Fensters). Solange der Fokus im Offset-Feld steht, greifen diese Tasten
  dort — der Container darf nicht mitscrollen.

### Leere Dateien

Eine leere Datei ohne bekannte Endung bleibt **Text** (so entscheidet
`classify_deep` heute, und eine neue leere Datei soll editierbar sein). Der
Hex-Empty-State gilt deshalb für ein Dokument, das als Binärdatei geöffnet
wurde und **danach** auf 0 Bytes schrumpft — nicht für `empty.bin` beim
Öffnen. Eine Endungs-Provenienz („bekannt binär" vs. „unbekannt") wäre die
Alternative; sie lohnt den Aufwand in V1 nicht.

## Kanten, die erfahrungsgemäß brechen

1. **Watcher-Pfad.** Bei `kind-binary` darf `document:external_changed` nicht
   den Text-Reload nehmen, sondern verwirft Cache und In-flight-Zuordnungen,
   übernimmt die neue Größe und klemmt Fenster und Scrollposition ans neue
   Ende.
2. **Tab-Wechsel und History.** Ein erneutes `document:loaded` bei
   Tab-Aktivierung baut die Ansicht neu auf; die Stelle kommt aus dem
   `(tabId, path)`-Speicher. Ohne Eintrag (anderes Dokument, Tab gerade
   geschlossen) startet sie bei Byte 0. Ein falsch angewandter
   Markdown-Scroll landet in der falschen Region.
3. **Statusleiste.** Cursor-, EOL-, Encoding- und Wortzähler-Zellen sind für
   Binärdokumente sinnlos und bleiben ausgeblendet.
4. **Session-Restore.** Ein Binär-Tab überlebt den Neustart (`open_tabs`);
   beim Restore greift `pending_path` + `load_opaque`, kein Text-Load.
5. **Zen-Modus.** Nur Chrome verschwindet, aber verfügbare Höhe und Fokus
   ändern sich — die Zeilenzahl muss neu berechnet werden.

## Tests

- **Rust**: `read_file_chunk` (Offset mittig, jenseits EOF, `len == 0`,
  Clamping, Revision-Mismatch, Verzeichnis/FIFO/nicht-seekbar, Short Read);
  der zentrale Loader für sniffed Text vs. Binary über alle drei Funnels
  (`open`, pending Restore, `move_history`); Deskriptor bleibt bei Rename und
  Tab-Aktivierung stabil; Opaque-Schreibschutz als Negativtest mit
  Byte-Vergleich.
- **Vitest** (`hex-format.ts` + `hex.ts` mit kontrolliert verzögerten
  Chunk-Promises): Zeilenaufbau inkl. letzter Teilzeile, ASCII-Grenzwerte
  (0x1F/0x20/0x7E/0x7F), Offsetbreite bei 0xffffffff und 0x100000000,
  Fenster-Mathematik (Alignment, letztes Fenster, Datei < Fenster),
  Offset-Parser (dezimal, `0x`, Müll, negativ, jenseits EOF), stale success
  **und** stale error, Dedup/Concurrency, Shrink/Grow/Delete.
- **E2E** `61_hex_view.py` mit fester Fixture unter `/tmp/folio-e2e-hex`
  (Pfad ist in Statusleiste und Vault sichtbar und damit Teil der Baseline —
  wie 56/57/59): kleine Binärdatei mit NUL-Bytes und druckbaren Anteilen, dazu
  eine **sparse** Datei über der Fenstergröße für Prev/Next und das letzte
  Fenster. Geprüft werden: Öffnen ohne Fehlerdialog, `body.kind-binary`, erste
  Zeile byteweise, Edit-Button disabled, Tab- und History-Wechsel, externer
  Truncate, und als Negativtest, dass ein ausgelöster Save die Bytes **nicht**
  verändert.
- **Automation-Vertrag**: `/state` liefert additiv `kind`, `fileSize` und bei
  gemounteter Hex-Ansicht `hex: { windowStart, windowLen, error }` — DOM-Text
  allein ist für asynchron gefüllte Zeilen kein belastbarer Testvertrag.

## Reihenfolge der Umsetzung

Vier Etappen, jede einzeln reviewbar und für sich committfähig. Der Schnitt
folgt einem Rat aus dem Plan-Review: Der Deskriptor-Umbau betrifft **alle**
Dokumenttypen und soll unabhängig von der Hex-UI geprüft werden können.

0. **Opaque-Schreibschutz** im Store (vorgeschaltet, eigene Etappe — behebt
   den belegten Datenverlust und gilt sofort für Bilder).
1. **Deskriptor-Umbau**: `DocumentDescriptor` in Store/Tab, einmalige
   Typauflösung mit `classify_deep` in den drei Load-Funnels, stabile
   Kind-Semantik über Rename, Watcher-/Event-Vertrag mit Größe und Revision,
   Größengrenze. **Binary wird zentral im Loader abgelehnt** (nicht in
   `read_file`) — nach außen ändert sich nichts, innen ist das Gate an
   der Stelle, die Etappe 3 wieder öffnet.
2. **Chunk-Command** `read_file_chunk` plus `view/hex-format.ts` (DOM-frei)
   mit Rust- und Vitest-Tests. Weiterhin ohne sichtbare UI.
3. **Öffnen freischalten**: Binary läuft durch, `view/hex.ts` + Region + CSS +
   Gate-Matrix, `/state`-Felder, i18n-Keys, E2E-Szenario.

## i18n

Neue Keys in **allen neun** Katalogen plus nichtleerer Kontextsatz in
`locales/context/keys.json`:

- `hexView.goToOffset`, `hexView.invalidOffset`, `hexView.windowRange`
  („Bytes {start}–{end} von {total}"), `hexView.previousWindow`,
  `hexView.nextWindow`, `hexView.emptyFile`, `hexView.unavailable`,
  `hexView.retry`
- `errors.file.readChunk` (Backend, mit `{detail}`),
  `errors.view.hexLoadFailed` (Surface-Fehler, analog
  `errors.view.imageLoadFailed`), `errors.file.tooLargeToAddress`

Für die sieben Sprachen jenseits von de/en sorgfältig übersetzen; Kataloge
bleiben alphabetisch sortiert und key-gleich.

## V2 (bewusst später)

Hex-Toggle für Text-/Markdown-Dateien (als Umschalter im View-Mode, nicht als
Mode), „als Hex kopieren" und Bereichsselektion, Suche nach Byte-Mustern,
Editieren, Positions-Restore über Neustarts.

---

# Nachtrag: Suche in der Hex-Ansicht

Stand: 2026-08-19 · Status: Entwurf zur Umsetzung

## Ziel

In einem geöffneten Binärdokument nach **Text** oder nach **Hex-Bytes** suchen,
mit Weiter/Zurück-Navigation und hervorgehobenem Treffer. Damit fällt das
Nicht-Ziel „keine Suche im Hex-Dump" aus der Hauptspec.

## Architektur-Entscheidungen

### 1. Die Suche läuft im Backend, nicht über die geladenen Chunks

Das Frontend hält nur das aktuelle Fenster und einen kleinen Chunk-Cache. Eine
Suche über die geladenen Blöcke fände nur, was ohnehin sichtbar ist. Gesucht
wird deshalb serverseitig über die Datei — gestreamt in Blöcken mit einem
Überlappungsbereich von `pattern.len() - 1`, sonst geht jeder Treffer verloren,
der auf einer Blockgrenze liegt.

### 2. Bestehende Find-Bar statt eigener Leiste

Strg+F ist die erwartete Taste, und das Projekt hat für jede Surface bereits
einen `Finder` (Editor, ViewFinder, HtmlFinder, CodeViewFinder, Split-Varianten).
Die Hex-Ansicht bekommt einen `HexFinder` im selben `getFinder()`-Routing;
`isSearchableKind()` lässt `kind-binary` künftig zu.

Der Zähler der Find-Bar kennt in seinem Event bereits `scanning`, `total`,
`capped` und `invalidRegex` — eine asynchrone Suche passt ohne Umbau hinein.

**Gesperrt bleibt in dieser Surface**: Ersetzen (read-only), Regex und
„Ganzes Wort". Neu ist ein Umschalter **Text | Hex**, nur bei `kind-binary`
sichtbar.

### 3. Weiter/Zurück statt „n von m"

Anders als in Textdokumenten zeigt der Zähler **keine Gesamtzahl**, sondern den
Offset des aktuellen Treffers (z. B. `0x00600012`). Eine Gesamtzahl über eine
Mehr-Gigabyte-Datei kostet einen vollständigen Scan und sagt wenig; die Position
ist hier die nützlichere Information. Die Suche liefert deshalb pro Aufruf genau
den nächsten Treffer ab einem Offset.

Bewusst kein Cap-Modell wie in der Vault-Suche: dort ist die Trefferliste das
Produkt, hier ist es die Navigation.

## Backend

```rust
#[tauri::command]
pub async fn hex_find(
    tab_id: u64, revision: u64, pattern: Vec<u8>, from: u64,
    backwards: bool, case_insensitive: bool, state: State<'_, AppState>,
) -> Result<Option<u64>, String>
```

- Autorisierung exakt wie `read_file_chunk`: Tab, opaquer Deskriptor und
  Revision unter dem Tabs-Lock prüfen, Pfad kopieren, Lock **vor** dem I/O
  freigeben, `stale:`-Präfix bei Revision-Mismatch.
- I/O in `spawn_blocking`, Vorprüfung auf reguläre Datei **vor** `File::open`
  (FIFO-Falle, siehe Chunk-Command), Leseschleife mit kurzen Reads.
- Blockweise (64 KiB) mit Overlap `pattern.len() - 1`; rückwärts analog von
  hinten.
- `case_insensitive` gilt **nur für ASCII-Buchstaben** (byteweises Falten von
  `A-Z`/`a-z`). Alles andere wäre bei roher Byte-Suche geraten.
- Leeres Pattern → `Ok(None)`, kein Fehler.
- **Wrap-around macht der Aufrufer**, nicht der Command: Findet er ab `from`
  nichts, fragt das Frontend erneut ab 0 (bzw. ab EOF rückwärts). So bleibt der
  Command eine reine Funktion und die UI entscheidet über das Umlaufen.
- **Abbrechbarkeit**: Ein laufender Scan über eine sehr große Datei muss enden,
  wenn der Nutzer weitertippt oder den Tab wechselt. Generation im State wie bei
  den Suchläufen der Vault-Suche; abgebrochene Läufe liefern `stale:`.

## Frontend

- `view/hex-find.ts` (oder als Teil von `hex.ts`, wenn es dort natürlicher
  sitzt): implementiert das `Finder`-Interface asynchron und meldet den
  Zählerzustand über dasselbe Event wie die übrigen Finder — `scanning: true`
  während der Backend-Lauf läuft.
- **Pattern-Parser, DOM-frei und testbar** (gehört zu `hex-format.ts` oder
  einem Geschwistermodul):
  - Text → UTF-8-Bytes der Eingabe.
  - Hex → tolerant: Leerzeichen, Kommas und `0x`-Präfixe erlaubt, Groß-/
    Kleinschreibung egal. Ungerade Ziffernzahl oder Nicht-Hex-Zeichen sind ein
    **sichtbarer** Fehler (Input-Markierung + Hinweis im Zähler, wie
    `invalidRegex`), niemals „0 Treffer".
- **Sprung zum Treffer**: Fenster ggf. wechseln, Zeile ins Bild scrollen,
  Treffer-Bytes **und** die zugehörigen Zeichen in der ASCII-Spalte
  hervorheben. Farben wie in den anderen Surfaces (`#FFD700` passiv, `#FF8C00`
  aktiv). Ein Treffer, der über eine Zeilengrenze läuft, wird in beiden Zeilen
  markiert.
- Der Umschalter Text|Hex merkt sich seinen Zustand für die Sitzung (nicht
  persistiert), Umschalten löst eine neue Suche mit demselben Eingabetext aus.

## i18n

Neue Keys in allen neun Katalogen plus Kontextdatei: `find.bar.modeText`,
`find.bar.modeHex`, `find.bar.invalidHex`, `find.bar.matchAt` („Treffer bei
{offset}"), `find.bar.noMatch`.

## Tests

- **Rust**: Treffer am Dateianfang, am Ende, **exakt auf einer Blockgrenze**
  (der Overlap-Fall — ohne ihn ist die Suche still unvollständig), rückwärts,
  ASCII-case-insensitive, leeres Pattern, Pattern länger als die Datei,
  Revision-Mismatch, Verzeichnis/FIFO, abgebrochener Lauf.
- **Vitest**: Pattern-Parser in allen Zweigen (Text, Hex mit/ohne Trenner,
  ungerade Länge, Müll), Zählerzustände (scanning → Treffer → kein Treffer),
  Wrap-around-Logik, Markierung über Zeilengrenzen.
- **E2E** (`61_hex_view.py` erweitern): Textsuche findet einen bekannten String
  in der Fixture, Hex-Suche findet dieselbe Stelle über ihre Bytes, Weiter
  springt zum zweiten Vorkommen, ungültige Hex-Eingabe zeigt den Fehler.
