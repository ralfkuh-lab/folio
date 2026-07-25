# Spec: Wikilinks + Backlinks + Autocomplete + Tag-Browser (Obsidian-kompatibel)

Status: **W1–W6 umgesetzt 2026-07-25**, Kreuz-Review (codex gpt-5.6-sol high
+ kimi K3) konsolidiert und Fixes F1–F10 eingearbeitet, Endabnahme mit
grünem E2E-Voll-Lauf (54 Szenarien) am selben Tag.

## Ziel & Designprinzip

folio wird vom Einzeldatei-Editor zum vernetzten Vault:

1. **Wikilinks** `[[Name]]` in Markdown-Dokumenten werden in View/Split/
   Live-Preview/Export als klickbare Links gerendert und vaultweit aufgelöst.
2. **Backlinks-Panel**: das aktuelle Dokument zeigt, wer auf es verlinkt.
3. **`[[`-Autocomplete** im Editor (Dateien + Überschriften).
4. **Tag-Browser**: `#tags` (Text + Frontmatter) vaultweit sammeln und browsen.

**Designprinzip Obsidian-Kompatibilität**: Ein bestehender Obsidian-Vault soll
in folio gepinnt und parallel mit beiden Tools benutzt werden können. Wir
erfinden keine eigene Semantik, sondern folgen Obsidians Auflösungsregeln.
Wo wir (bewusst) abweichen, steht es hier unter „Bewusste Abweichungen".

## Syntax (Obsidian)

| Form | Bedeutung |
|---|---|
| `[[Name]]` | Link auf Datei `Name.md`, vaultweit per Dateiname aufgelöst |
| `[[Name\|Anzeigetext]]` | wie oben, anderer Linktext (comrak: `wikilinks_title_after_pipe`) |
| `[[Name#Überschrift]]` | Link + Sprung zur Überschrift (folio-Slugifier, `heading_anchor.rs`) |
| `[[Ordner/Name]]` | Pfad-qualifiziert (nötig bei mehrdeutigen Namen) |
| `![[bild.png]]` | **Embed**: Bild wird eingebettet (wie `![](...)`) |
| `![[Notiz]]` | Notiz-Embed — V1: als Link mit `wikilink-embed`-Klasse (s. Abweichungen) |
| `[[Name#^blockid]]` | Block-Referenz — V1: tolerant = Link auf die Datei, `^blockid` wird ignoriert |

## Auflösungsregeln

- **Suchraum** = Vault wie bei der Volltextsuche: Union der gepinnten Ordner
  (rekursiv, hidden/gitignore-gefiltert wie `search::resolve_scope` +
  `collapse_overlapping_dirs`) + explizit gepinnte Einzeldateien.
- **Match per Dateiname** (Basename ohne `.md`), **case-insensitiv** (Obsidian-
  Verhalten). Für Embeds zählen auch Nicht-MD-Dateien (Bilder) mit Extension:
  `![[foo.png]]` matcht per vollem Dateinamen.
- **Mehrdeutigkeit**: existieren mehrere Kandidaten, gewinnt bei
  pfad-qualifizierten Links (`[[a/b/Name]]`) das Suffix-Match; ein bloßes
  `[[Name]]` löst deterministisch auf den Kandidaten mit dem **kürzesten
  Vault-relativen Pfad** auf (Tiebreak: lexikografisch). Kein Fehler, kein Dialog.
- **`.md` im Link** (`[[Name.md]]`): wird akzeptiert und wie `[[Name]]` behandelt.
- **Fehlendes Ziel**: Link wird als `wikilink-missing` gerendert; Klick öffnet
  den „Datei anlegen?"-Dialog (W2). Anlage-Ort: **Verzeichnis des aktuellen
  Dokuments** (einfachste Regel; Obsidian-Default „Vault-Root" ergibt bei
  folios Multi-Pin-Vault keinen eindeutigen Root).
- **Ohne Vault-Kontext** (keine Pins, oder Datei außerhalb der Pins geöffnet):
  Auflösung läuft trotzdem über die Pins; schlägt alles fehl → missing.

### Bewusste Abweichungen von Obsidian (V1)

- **Notiz-Embeds** `![[Notiz]]` rendern NICHT den Inhalt, sondern einen
  normalen Wikilink mit Klasse `wikilink-embed` (Folgepunkt).
- **Block-Referenzen** `#^id` werden ignoriert (Link auf Datei).
- **Frontmatter-`aliases`** werden in V1 nicht aufgelöst (Folgepunkt).
- **Heading-Anker**: wir slugifizieren mit folios eigenem Slugifier statt
  Obsidians rohem Heading-Text — innerhalb von folio konsistent, beim
  HTML-Export identisch mit den TOC-Ankern.

## Architektur

### Namens-Index (`src-tauri/src/wikilink.rs`)

In-Memory-Index `Name(lowercase) → Vec<AbsPath>` über den Vault-Walk
(Wiederverwendung `search::resolve_scope`, `collapse_overlapping_dirs`,
`WalkBuilder`-Pipeline mit hidden/gitignore-Filter, `.git`-Skip). Gehalten im
`AppState` hinter einem Lock, **Cache mit Invalidierung**:

- explizit bei Pin-Änderungen, `create_file`/Rename/Delete/Save-neuer-Datei,
  `vault:dir_changed` (Watcher);
- zusätzlich **TTL-Fallback 30 s** — der Vault-Watcher beobachtet nur
  aufgeklappte Ordner, externe Änderungen tiefer im Baum wären sonst unsichtbar.
- Rebuild lazy beim nächsten Zugriff (Renderer/Autocomplete/Backlinks), nie
  im Hot-Path eines Tastendrucks: Live-Preview-Renders greifen auf den Cache.

### Render-Integration (`renderer.rs`)

- `options.extension.wikilinks_title_after_pipe = true` (Obsidian-Reihenfolge
  `[[url|title]]`; comrak-AST-Node `NodeValue::WikiLink { url }`, HTML-Output
  `<a href="…" data-wikilink="true">`).
- **AST-Postprocess** nach `parse_document` (analog zum bestehenden
  GenericAttributes-Postprocess): jeder WikiLink-Node wird gegen den Index
  aufgelöst und die `url` **auf den relativen Pfad zum aktuellen Dokument**
  umgeschrieben (`file_resolver::make_relative`, POSIX-Slashes) + `#anchor`
  bei Heading-Teil. Damit funktioniert die Klick-Navigation über den
  **bestehenden** Interceptor-Pfad (`view/markdown.ts` → `link_click` →
  `file_resolver::resolve`) ohne Sonderweg.
- **Missing**: `url` wird auf das Schema `folio-new:<urlencoded name>` gesetzt;
  ein String-Postprocess (analog `normalize_tasklist_html`) ergänzt auf
  `data-wikilink`-Anchors die Klasse `wikilink` bzw. `wikilink-missing`.
- **Embeds**: `!` + WikiLink-Nachbarschaft im AST erkennen (comrak parst `!`
  als eigenen Text-Node). Ist das aufgelöste Ziel ein Bild
  (`FileKind::Image`), werden beide Nodes durch einen Image-Node mit dem
  relativen Pfad ersetzt → läuft über das bestehende
  `rewriteRelativeAssets`/`convertFileSrc`-Rewriting im Frontend. Nicht-Bild
  → Link mit Klasse `wikilink-embed`.
- Der Render braucht dafür Kontext (aktueller Dokumentpfad + Index-Handle):
  Signatur-Erweiterung der Render-Pipeline um einen optionalen
  `WikilinkContext`; Aufrufer ohne Kontext (z. B. Theme-Editor-Vorschau)
  rendern Wikilinks als tote Links (missing-Optik ohne Dialog).

### Klick-Verhalten (W2)

- Aufgelöste Links: bestehender Pfad (`LinkAction::Navigate`), inkl.
  Ctrl/Cmd-Klick + Mittelklick → `tab_open` (Konvention Multi-Tabs).
  **Fragment-Navigation**: `[[Name#H]]` muss nach dem Open zum Anker scrollen —
  prüfen, ob `link_interceptor`/Frontend das für relative `x.md#anchor`-Links
  heute schon tut; sonst nachrüsten (Anchor nach `document:loaded` anfahren).
- `folio-new:`-Links: Frontend-Interceptor fängt das Schema ab und öffnet den
  Anlegen-Dialog (Muster `showRenameDialog`, `ui/dialogs.ts`): Titel „Notiz
  anlegen?", vorausgefüllter Dateiname `<Name>.md`, Zielverzeichnis =
  Verzeichnis des aktuellen Dokuments (im Dialog sichtbar). OK →
  `create_file` (existiert, atomar, `vault:refresh`) → `openDocument`.
  Abbrechen → nichts. i18n-Keys für alle Texte.

### Backlinks (W3)

- Backend-Command `backlinks_for(path)` → Scan über den Such-Walk (gleiche
  Filter/Caps-Philosophie: 2-MiB-Cap, NUL-Sniff): findet `[[…]]`-Vorkommen
  in Vault-MD-Dateien, löst sie über den Index auf und behält die, die auf
  `path` zeigen. Rückgabe gruppiert pro Quelldatei mit Zeilen-Snippets
  (Struktur an `SearchHit` angelehnt), Cap 200 Quellen / 50 Zeilen pro Datei.
  V1 zählt nur Wikilinks (normale relative MD-Links: Folgepunkt).
- UI: neue Sektion **unter dem TOC** in `#toc-region` (`dist/index.html`):
  Header „Verlinkt von (N)" + Liste (Dateiname, Snippet). Klick öffnet die
  Quelle (`openDocument`), Ctrl-Klick → `tab_open`. Sichtbarkeit erbt die
  CSS-Beschränkung der TOC-Rail (`.kind-markdown`). Refresh bei
  `document:loaded`/`saved` (debounced, kein Watcher-Spam).

### `[[`-Autocomplete (W4)

- `monaco.languages.registerCompletionItemProvider('markdown', …)` im
  `editor/`-Bundle (dort lebt Monaco; bisher gibt es keinen Provider).
  Trigger `[`; aktiv nur, wenn vor dem Cursor `[[…` ohne schließendes `]]`
  steht. Datenquelle: `window.__TAURI__.core.invoke('palette_files')`
  (liefert `{path, name, relative}` mit Overlap-Dedup + 20k-Cap), gefiltert
  auf `.md` (+ Bilder, wenn Prefix `![[`), Kurz-Cache ~5 s.
- Insert-Text: eindeutiger Basename ohne `.md`; bei Mehrdeutigkeit der
  kürzeste eindeutige Vault-relative Pfad (Konsistenz mit Auflösung).
- `[[Name#` → zweiter Schritt: Überschriften des Ziels via neuem Command
  `wikilink_headings(path)` (Heading-Extraktion aus dem bestehenden
  TOC-/Renderer-Pfad wiederverwenden).

### Tag-Browser (W5)

- **Syntax**: `#tag` im Fließtext (Obsidian-Regeln: `[A-Za-z0-9_/-]`,
  mindestens ein Nicht-Ziffer-Zeichen; nested Tags `#a/b` zählen als voller
  Tag; V1 ohne Hierarchie-Baum) + Frontmatter `tags:` (Array oder
  Komma-String; via `frontmatter::extract`). Code-Bereiche werden
  **zeilenbasiert** ausgenommen: Fence-Tracking + Inline-Code-Spans
  best effort (bewusst kein voller comrak-Parse pro Datei im Scan).
- Backend `vault_tags()` → Walk über Vault-MD-Dateien, Rückgabe
  `[{tag, count, files}]` (Files gecappt auf 100/Tag, `truncated`-Flag),
  case-preserving anzeigen, case-insensitiv aggregieren.
- **UI**: neue Sektion „Tags" in der **linken Rail** unter Pinned/Recent
  (Backend-`section_html`-Muster, Collapse-State in `panel_state.rs` wie
  `pinned_expanded`). Tag-Zeile „#tag (N)"; Klick klappt die Datei-Liste
  des Tags inline auf, Klick auf Datei öffnet sie. Refresh: beim Aufklappen
  der Sektion + manueller Refresh-Button; kein Live-Watcher in V1.
- **Suche nach Tag**: Kontextmenü/Icon am Tag → öffnet den
  Vault-Such-Dialog mit vorausgefüllter Query `#tag` (Präfill-Hook der
  Suche). Exakte Tag-Suche (ohne Präfix-Falsch-Treffer) bleibt über die
  Datei-Liste des Browsers abgedeckt.

### Export (W6)

- Gleiche Render-Pipeline → Wikilinks sind im HTML/PDF-Export als relative
  Links enthalten (funktionieren, wenn die Zieldateien daneben liegen —
  gleiche Semantik wie heutige relative MD-Links). Missing-Links rendern als
  gestylter toter Link (Theme-CSS: dezente Kennzeichnung, kein
  `folio-new:`-Schema im Export — String-Postprocess ersetzt es durch
  `href="#"` + Klasse).
- Bild-Embeds laufen über den bestehenden Relativpfad-Mechanismus
  (PDF-Export rendert im Quellverzeichnis).

## CSS-/Vertrags-Klassen

- `a.wikilink` (aufgelöst), `a.wikilink-missing` (tot, gedimmt/gestrichelt),
  `a.wikilink-embed` (Nicht-Bild-Embed). Styling in `content.css` +
  Theme-tauglich (auf `.markdown-body` gescopt, Light/Dark).
- Rail: `#backlinks-section` (rechte Rail), Tag-Sektion im Vault-Baum-Markup
  (`.section[data-section="tags"]`).

## i18n

Neue Keys unter `wikilinks.*` / `tags.*` (Dialog, Rail-Header, Fehler) in
**allen 9 Katalogen** + `locales/context/keys.json`, alphabetisch, Referenz-
und Markup-Gates beachten (Vertrag `docs/spec-i18n.md`).

## Etappen & Zuordnung

| Etappe | Inhalt | Implementierer | Status |
|---|---|---|---|
| **W1** | `wikilink.rs` (Index+Auflösung), Renderer-Integration (AST-Postprocess, Embeds, missing-Schema), Unit-Tests | **Opus 5.0 (high)** | ✅ |
| **W2** | Klick-Navigation (inkl. Fragment), `folio-new:`-Interceptor + Anlegen-Dialog, CSS, i18n | grok | ✅ |
| **W3** | `backlinks_for` + Rail-Sektion | grok | ✅ |
| **W4** | Autocomplete-Provider + `wikilink_headings` | grok | ✅ |
| **W5** | Tag-Scan + Tag-Browser-Sektion + Such-Präfill | grok | ✅ |
| **W6** | Export-Feinschliff, E2E-Szenarien (`53_wikilinks`, `54_tags`), Doku (CLAUDE.md, automation-contract falls API-Zusätze) | grok | ✅ |

Gates pro Etappe: `cargo test`, `cargo clippy --all-targets -- -D warnings`,
`cargo fmt --check`; bei Frontend-Anteil `npm run build` + vitest; E2E in W6.
Kreuz-Review (codex gpt-5.6-sol high + kimi K3) über den Gesamtdiff nach W6,
danach Orchestrator-Endabnahme.

## Kreuz-Review-Ergebnis (2026-07-25)

Reviewer: codex (gpt-5.6-sol, high) + kimi K3, unabhängig über den
Gesamtdiff; beide ohne Sicherheitsbefund (Encoding, Escaping,
Export-Sanitizing, Path-Traversal geprüft). 17 Befunde → 10 umgesetzt
(F1–F5 Backend via Opus: Cache-Generation+Fingerprint gegen Pin-Snapshot-
Race, stale-while-revalidate statt synchronem Rebuild im Hot-Path,
Anker-Durchreichung durch `tabs::open` statt Doppel-History, escaped
`\[[…]]` + `paths_equal` im Backlink-Scan, Embed-Label ohne Anker;
F6–F10 Frontend via grok: Backlinks-Refresh nur aktiver Tab +
Single-Flight + Save-Heuristik, `wikilink_candidates` aus dem Index mit
backend-disambiguiertem insert, Dialog-Reentranz-Guard + flaches Anlegen,
Tag-Fehlerzustand mit Retry, Autocomplete-Fence-/Inline-Code-Gate).

## Folgepunkte (bewusst nicht V1)

- Notiz-Embeds mit echtem Inhalt (Transclusion), Block-Referenzen `#^id`,
  Frontmatter-`aliases`, Backlinks für normale relative MD-Links,
  Link-Refactoring beim Umbenennen (zieht Wikilinks nach — wird durch
  Namens-Referenzierung einfacher), Tag-Hierarchie-Baum, Unlinked Mentions,
  persistenter Index (tantivy) bei sehr großen Vaults.
- Aus dem Kreuz-Review zurückgestellt: Heading-Anker gegen echte
  TOC-Slugs auflösen (`{#custom-id}`, Slug-Kollisionen `-1` — bräuchte
  Heading-Map-Cache pro Zieldatei); `[[#`-Heading-Autocomplete aus dem
  ungespeicherten Editor-Puffer statt Disk; HTML-Kommentar-Maskierung im
  Backlink-Scan.
