# Spec: Wikilinks + Backlinks + Autocomplete + Tag-Browser (Obsidian-kompatibel)

Status: **W1–W8 umgesetzt** — W1–W6 am 2026-07-25, W7 am 2026-07-26,
W8 am 2026-08-19.

Erste Runde (W1–W6): Kreuz-Review (codex gpt-5.6-sol high + kimi K3)
konsolidiert und Fixes F1–F10 eingearbeitet, Endabnahme mit grünem
E2E-Voll-Lauf (54 Szenarien) am selben Tag.

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

- **Suchraum** = Union der Wikilink-Wurzeln, aufgelöst wie bei der
  Volltextsuche (rekursiv, hidden/gitignore-gefiltert wie
  `search::resolve_scope` + `collapse_overlapping_dirs`) + explizit gepinnte
  Einzeldateien. **Seit W8 sind die Wurzeln Opt-in** (`wikilink_roots`,
  Teilmenge der Pins, Default leer) — nicht mehr automatisch alle Pins;
  Begründung und Vertrag unter „W8“.
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
- **Ohne Vault-Kontext** (keine Wikilink-Wurzel freigeschaltet, oder Datei
  außerhalb der Wurzeln geöffnet): Auflösung läuft trotzdem über die Wurzeln;
  schlägt alles fehl → missing. Bei leerer Wurzelliste ist der Index leer,
  also rendert alles als missing — das ist der Opt-in-Default aus W8.

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
- zusätzlich **TTL-Fallback** — der Vault-Watcher beobachtet nur
  aufgeklappte Ordner, externe Änderungen tiefer im Baum wären sonst
  unsichtbar. **Seit W8**: Basis 5 Minuten, adaptiv auf
  `10 × letzte Builddauer` angehoben, plus gedrosselte Invalidierung bei
  Fenster-Fokus.
- Rebuild lazy beim nächsten Zugriff (Renderer/Autocomplete/Backlinks), nie
  im Hot-Path eines Tastendrucks: Live-Preview-Renders greifen auf den Cache.
  **Seit W8** läuft auch der Cold-Start-Build im Hintergrund — kein
  Render-Pfad wartet auf einen Index-Build.

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
| **W7** | Lokalitäts-Priorität bei der Auflösung + Insert-Verkürzung | Opus | ✅ |
| **W8** | Opt-in-Wurzeln (`wikilink_roots`), Cold-Start entkoppelt, adaptive TTL, Fokus-Invalidierung | Opus | ✅ |

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

## W7: Lokalitäts-Priorität bei der Auflösung (2026-07-26)

### Problem (belegt)

`WikilinkIndex::sort_candidates` (wikilink.rs) ordnet die Kandidaten eines
Namens **global** nach `Pfadtiefe → relative → absoluter Pfad`, und
`resolve_name` nimmt `candidates.first()`. Das Kontextdokument spielt keine
Rolle. Folge im realen Nutzungsmodell (mehrere **Projektverzeichnisse**
gepinnt, jedes mit `README.md`, `TODO.md`, `CLAUDE.md`, `docs/…`): `[[README]]`
löst — egal in welchem Projekt der Link steht — immer auf dasselbe README auf,
nämlich das mit dem alphabetisch ersten absoluten Pfad. Deterministisch, aber
praktisch immer die falsche Datei.

Das widerspricht auch Obsidian, das bei gleichnamigen Dateien die im selben
Ordner bevorzugt, und es widerspricht dem eigenen Autocomplete, das seit
`ccb26e1` schon nach Nähe rankt — die Auflösung hinkt dem Ranking hinterher.

### Regel

Neue Rangfolge auf der Kandidatenliste eines Namens, bezogen auf ein
**Kontextdokument**:

1. Datei im **selben Verzeichnis** wie das Kontextdokument.
2. Datei unter demselben **Pin-Root** wie das Kontextdokument; darin die
   bisherige Rangfolge. Bei verschachtelten Pins gilt der **längste** passende
   Root als Heimat des Kontextdokuments.
3. Alle übrigen Kandidaten in der bisherigen Rangfolge.

Innerhalb jeder Stufe bleibt die bestehende Sortierung — der Determinismus
(inkl. Tiebreak) ist unverändert. **Kein Setting, kein Schalter.**
Cross-Projekt-Verweise bleiben vollständig erhalten: Stufe 3 greift, sobald im
eigenen Projekt kein Kandidat existiert.

Bei **pfad-qualifizierten** Links (`[[a/b/Name]]`) bleibt der Suffix-Match das
erste Filter; die Lokalitätsrangfolge entscheidet erst **unter** den
Suffix-Treffern.

### Kontextdokument je Aufrufstelle (verbindlich)

Alle drei heutigen `resolve_name`-Aufrufer müssen die Regel konsistent nutzen,
sonst driften die Sichten auseinander:

| Aufrufer | Kontextdokument |
|---|---|
| `WikilinkContext::resolve` (Render/Export) | `current_doc` |
| Backlink-Scan (`find_backlinks`) | **die Quelldatei, in der der Link steht** — NICHT das Zieldokument |
| `wikilink_headings`-Helfer (`current_path: Option<&str>`) | das übergebene `current_path` |
| ohne Kontext (Theme-Editor-Vorschau u. ä.) | Verhalten unverändert = heutige globale Rangfolge |

Der Backlinks-Fall ist der subtile: nimmt der Scan das Zieldokument (oder
keinen Kontext), zeigt das Panel Quellen an, deren Link real woanders
hinzeigt, und übersieht echte Backlinks aus dem eigenen Projekt.

### API

- `IndexEntry` erhält den Pin-Root (`root: String`), gesetzt beim `insert`:
  der **längste passende Ordner-Pin**, unter dem die Datei liegt; nur wenn es
  keinen gibt (reiner Datei-Pin außerhalb aller Ordner-Pins), das
  **Elternverzeichnis** der Datei. Diese Regel gilt **unabhängig davon**, ob
  die Datei über den Ordner-Walk oder über den Datei-Pin in den Index kam —
  eine Datei, die zugleich gepinnt und Teil eines gepinnten Projekts ist, hat
  dieses Projekt als Heimat. Sonst hinge das Ergebnis an der Walk-Reihenfolge
  bzw. am gitignore-Status derselben Datei (Review-Befund 2026-07-26).
- `relative` bleibt gegen die **kollabierte Walk-Wurzel** aus `resolve_scope`
  berechnet — unverändert zu vor W7. `root` ist ein **separates** Feld und
  darf `relative` nicht beeinflussen, sonst kippt bei verschachtelten Pins die
  globale Rangfolge (`sort_candidates` zählt Pfadkomponenten von `relative`)
  und die Zusage „ohne Kontext = altes Verhalten" ist gebrochen.
- `resolve_name` bleibt als kontextfreie Variante bestehen (Aufrufer ohne
  Kontext); neu `resolve_name_from(&self, name, context: &Path)`.

### Insert-Verkürzung (zweiter Schritt, gleiche Etappe)

Weil die Auflösung lokal wird, darf der Autocomplete-Insert kürzer werden:
`[[README]]` genügt, wenn es **aus dem Kontextdokument heraus** eindeutig ist,
auch wenn der Name global mehrdeutig ist. Das ist genau Obsidians
„shortest path when possible" und erhöht die Portabilität.

- `collect_wikilink_candidates` bekommt das Kontextdokument optional durch;
  `compute_insert_text` wählt den **kürzesten** Insert-String, der aus diesem
  Kontext heraus wieder **genau diese Datei** auflöst.
- Command `wikilink_candidates` nimmt optional `currentPath`;
  `editor/wikilink-complete.ts` übergibt den aktiven Dokumentpfad.
- **Invariante als Property-Test:** für jeden Kandidaten muss
  `resolve_name_from(candidate.insert, ctx) == candidate.path` gelten. Diese
  Invariante ist das eigentliche Sicherheitsnetz der Etappe — ohne sie kann ein
  verkürzter Insert auf eine andere Datei zeigen als die ausgewählte.
  **Sie gilt für ALLE auflösbaren Kandidaten, auch Bilder/Nicht-Markdown**
  (`![[logo.png]]`): auch dort wird der kürzeste verifizierte Suffix gesucht,
  statt den Basename ungeprüft einzusetzen. Ein Property-Test, der Nicht-MD
  überspringt, verdeckt genau den Fall gleichnamiger Bilder in zwei Pins
  (Review-Befund 2026-07-26).
- Der absolute-Pfad-Fallback in `compute_insert_text` bleibt als letzte Stufe
  erhalten (in folio auflösbar, weil `resolve_name` Suffixe gegen den
  absoluten Pfad matcht), wird durch die Lokalität aber noch seltener.

### Tests

Unit-Tests in `wikilink.rs`: gleiches Verzeichnis gewinnt; gleicher Pin-Root
gewinnt vor fremdem Root; Cross-Root-Fallback greift, wenn lokal kein
Kandidat; verschachtelte Pins (längster Root); pfad-qualifiziert + Lokalität;
Kontextdokument außerhalb aller Pins; Backlink-Konsistenz (`[[README]]` in
Projekt A erzeugt keinen Backlink auf `B/README.md`); Insert-Roundtrip-Invariante.

### Nicht in W7

Frontmatter-`aliases` (eigene Etappe), Unlinked Mentions, Link-Refactoring
beim Umbenennen.

## W8: Opt-in-Wurzeln + entkoppelter Index-Build (2026-08-19)

Kreuz-Review (gpt-5.6-sol) am selben Tag: Gesamturteil positiv, drei Befunde
eingearbeitet — Signal + Wiederanlauf für verworfene Builds (MAJOR),
`wikilink:roots_changed` fürs Wurzel-Toggle (MAJOR) und Panic-Sicherheit des
`refreshing`-Flags (MINOR). Alle drei sind unten an ihrer Sachstelle
beschrieben.

### Problem (belegt, Log + Nutzer-Vault)

`WikilinkIndex::build` walkt **alle** Vault-Pins. Im Vault des Nutzers sind
das ~1.000.000 Dateien; ein Rebuild dauert dort **20–26 s**. Daraus folgten
drei Fehler, alle im Log belegt:

1. **Boot blockiert.** `state.rs::wikilink_context` ruft
   `wikilink_index.get(&pinned)`. Beim Cold Start (leerer Cache) nahm `get_at`
   den `CacheAction::BuildSync`-Zweig — das `document:loaded` des
   wiederhergestellten Tabs wartete damit ~25 s auf einen Vault-Walk.
2. **Kein Single-Flight im Cold-Pfad.** Das `refreshing`-Flag deckte nur den
   Stale-Pfad ab; zwei parallele Cold-`get()` bauten denselben Index doppelt
   (im Log: zwei Rebuilds à 22 s direkt hintereinander beim Boot).
3. **TTL kürzer als die Buildzeit.** `INDEX_TTL` war 30 s. Bei 20–26 s
   Buildzeit war der Eintrag praktisch immer abgelaufen, sobald er
   veröffentlicht war → Rebuild-Dauerschleife und permanente CPU-Last durch
   `build_parallel`.

Der Kern ist nicht die Cache-Mechanik, sondern die **Suchraum-Annahme**:
„Vault = alle Pins" ist für die Volltextsuche richtig (sie läuft auf
Anforderung), für einen Index, der bei jedem Render gebraucht wird, aber
nicht. Ein automatisch mitlaufendes Feature darf keinen Suchraum erben, den
der Nutzer für einen ganz anderen Zweck gepinnt hat.

### Teil A: Opt-in-Wurzeln (`wikilink_roots`)

- Neues persistiertes Feld `wikilink_roots: Vec<String>` in `WorkspaceData`
  (`workspace.json`, `#[serde(default)]`, Forward-Slash-normalisiert wie alle
  Workspace-Pfade; die Backslash-Migration in `Workspace::load_from` deckt es
  mit ab).
- **Semantik**: ein Eintrag entspricht **genau einem Pin-Pfad** (Verzeichnis
  ODER Einzeldatei). Der Suchraum ist `pinned ∩ wikilink_roots`. Wurzeln ohne
  passenden Pin werden **still verworfen** — wie tote Vault-Pins in der Suche.
- **Default leer → Feature effektiv aus, und es läuft gar kein Walk.**
  `WikilinkIndex::build(&[])` kehrt sofort mit einem leeren Index zurück
  (explizite `pinned.is_empty()`-Vorprüfung, damit garantiert kein
  `WalkBuilder` startet). Backlinks-Sektion, `[[`-Autocomplete und
  Tag-Sektion verhalten sich dann wie „keine Treffer" (kein Spinner, kein
  Fehler).
- **Eine zentrale Quelle**: `Workspace::wikilink_pins()` bzw.
  `AppState::wikilink_pins()`. Alle Konsumenten stellen darauf um:
  `state.rs::wikilink_context`, die drei `cache.get(&pinned)`-Stellen in
  `commands/wikilink_cmd.rs` (candidates/headings/backlinks) **und
  `tags::collect_vault_tags`** — der Tag-Browser hängt am selben Walk und
  hatte dasselbe Kostenproblem.
- Die Filterung passiert **vor** `WikilinkIndexCache::get`. Damit erkennt
  `fingerprint_of` einen Wurzel-Wechsel automatisch als neuen Suchraum; der
  Cache selbst bleibt von der Opt-in-Logik unberührt.
- `resolve_name_from` (W7-Lokalitätsrangfolge) ist **unverändert** — sie
  arbeitet nur auf einem kleineren Index.
- **Pfad-Migration**: `wikilink_roots` läuft in `Workspace::remap_prefix` und
  `Workspace::remove_under` mit (Segmentgrenzen-Matching aus
  `path_migration.rs`, kein zweiter Migrationspfad). Damit zieht die Wurzel
  bei Rename/Move mit dem Pin um, statt tot zurückzubleiben.
- **Unpin räumt auf**: `Workspace::unpin` entfernt den passenden
  `wikilink_roots`-Eintrag. Sonst würde ein erneutes Pinnen desselben Ordners
  das Feature stillschweigend wieder einschalten.
- **UI**: Kontextmenü-Toggle auf Pin-Wurzeln (Verzeichnis wie Einzeldatei),
  `vault.contextMenu.wikilinkRootEnable` / `…Disable`. Zustand kommt aus dem
  Backend-Markup: `Vault::item_html` setzt `data-wikilink-root="1"` (analog
  `data-text`), gesetzt ausschließlich in `pinned_children_html`. Command
  `workspace_wikilink_root_set { path, enabled }` → Wurzel setzen,
  Index invalidieren, `vault:refresh`. Zwei Labels statt eines Häkchens, weil
  das Kontextmenü keinen Checked-Zustand kennt.
  *Bekannte Grenze*: bei einem gepinnten `.lnk`-Shortcut trägt der Knoten den
  **aufgelösten** Zielpfad in `data-path`, der Toggle würde also eine Wurzel
  ohne passenden Pin speichern (→ still ignoriert). Solche Pins sind für den
  Index schon vorher wirkungslos (`resolve_scope` prüft `is_dir()` auf dem
  `.lnk`-Pfad), es geht damit nichts verloren.

### Teil B: Cold-Start entkoppeln + Single-Flight

- Der `None`-Zweig von `WikilinkIndexCache::get_at` baut **nicht mehr
  synchron**: er liefert sofort einen leeren Index und startet den Build über
  den bestehenden `start_refresh`-Pfad. **Kein Render-Pfad wartet mehr auf
  einen Index-Build** — das gilt für alle `get()`-Aufrufer.
- `refreshing` deckt jetzt **beide** Pfade ab (Single-Flight im Cold-Pfad).
- **Re-Render nach jedem beendeten Build**: der Cache hat einen optionalen
  `IndexPublishCallback` (in `lib.rs::setup` mit dem `AppHandle` verdrahtet),
  der `wikilink:index_ready` emittiert. Semantik ist bewusst **„der
  Index-Zustand hat sich geändert — bitte neu ziehen"**, nicht „ein Build
  wurde veröffentlicht": das Signal feuert auch für einen **verworfenen**
  Build (siehe Wiederanlauf unten).
  Der Callback läuft **nie unter dem Cache-Mutex** (eigenes `OnceLock`).
  Unterdrückt wird er **nur im Erfolgs-Zweig**, und dort nur, wenn weder der
  neue noch der gecachte Index Inhalt hat — der Default-Fall „keine
  Opt-in-Wurzel" löst also keinen Re-Render aus. Beim **Discard feuert er
  bedingungslos** (siehe Wiederanlauf).
- **Zweites Event `wikilink:roots_changed`**: das Wurzel-Toggle
  (`workspace_wikilink_root_set`) invalidiert nur und rendert den Vault-Baum
  neu — eine bereits sichtbare Markdown-View würde davon nichts mitbekommen
  und, weil der Cold-Build erst beim nächsten `get()` startet, wäre die neue
  Wurzel bis zum nächsten Tipp-/Mode-/Dokument-Ereignis **wirkungslos** (beim
  Deaktivieren blieben aufgelöste Links stehen). Das Command emittiert deshalb
  bei echter Änderung zusätzlich `wikilink:roots_changed`. Der erste Render
  danach startet den Build, `index_ready` zieht nach dessen Abschluss final
  nach. `index_ready` bleibt damit den beendeten Builds vorbehalten.
- **Ein Frontend-Handler für beide Events** (`view/wikilink-refresh.ts`,
  `initWikilinkRefresh()`): `flushPreviewRender()` — der scroll-erhaltende
  Live-Render-Pfad mit eigenem `renderGen`-Stale-Guard — plus
  `refreshBacklinksAfterIndexReady()`. **Bewusst kein Re-Emit von
  `document:loaded`** (Scroll- und Seiteneffekte). Eigenes Modul statt zweier
  Kopien im Bootstrap, und damit unit-testbar.
- **Wiederanlauf verworfener Builds**: ein `publish` verwirft das Ergebnis,
  wenn seit dem Build-Start invalidiert wurde — und genau das trifft den
  20–26-s-Cold-Build leicht (Alt-Tab → Fokus-Invalidierung, Watcher-Event,
  Datei-CRUD). Ohne Signal gäbe es **keinen** Wiederanlauf: die sichtbare View
  bliebe auf dem leeren Index, bis zufällig ein Render kommt. Deshalb feuert
  der Callback auch beim Discard. Der ausgelöste Re-Render ruft `get()` mit
  dem **aktuellen** Suchraum — bewusst kein cache-interner Restart, der mit
  dem alten Pin-Snapshot arbeiten würde.
  **Die Leer-Unterdrückung gilt hier ausdrücklich nicht** (Sol-Nachprüfung):
  Läuft ein Build mit leerem Suchraum — weil noch keine Wurzel frei war oder
  die Wurzel keine indexierbaren Dateien enthält — und schaltet der Nutzer
  währenddessen eine Wurzel ein, dann trifft der `roots_changed`-Render den
  laufenden Single-Flight (`refreshing == true`) und bekommt nur den leeren
  Index; danach wird der leere Build verworfen. Sind Build **und** Cache leer,
  hätte eine Leer-Heuristik genau hier das Retry-Signal geschluckt und die
  neue Wurzel wäre bis zum nächsten zufälligen Render wirkungslos geblieben.
  **Schleifenfrei**, weil ein Discard `state.generation !=
  snapshot_generation` voraussetzt: jede weitere Runde braucht eine **neue**
  Invalidierung von außen; der Callback kann sich nicht selbst nachfüttern.
  Der vom Retry ausgelöste Folge-Build wird entweder veröffentlicht (und ist
  dann bei leer→leer still) oder braucht für einen weiteren Discard eine
  abermals neue Invalidierung. Nach einem erfolgreichen Publish trifft der
  Re-Render einen frischen Eintrag und startet gar keinen Build.
- **Selbstheilung bei Fingerprint-Wechsel**: trifft ein `get()` mit anderem
  Fingerprint auf einen laufenden Build, wird kein zweiter Build gestartet
  (Single-Flight). Der Callback löst aber einen Re-Render aus, dessen `get()`
  dann den passenden Build anstößt — Kosten: eine zusätzliche Runde, nie ein
  dauerhaft falscher Zustand.
- **Panic-Sicherheit** (`RefreshingGuard`, Muster aus `git_status.rs`):
  panickt `WikilinkIndex::build` im Hintergrund-Thread, würde `refreshing`
  dauerhaft stehen bleiben und es gäbe **bis zum Neustart nie wieder einen
  Build**. Der Guard gibt das Flag beim Unwind frei und panickt selbst nicht
  (toleriert einen vergifteten Mutex). Er wird **entschärft**, sobald
  `publish` die Freigabe übernimmt — sonst könnte sein späteres `drop` das
  Flag eines inzwischen gestarteten *anderen* Builds löschen und den
  Single-Flight-Schutz aushebeln.

### Teil C: TTL entschärfen + Fokus-Invalidierung

- `INDEX_TTL` (Basis) **30 s → 5 Minuten**.
- **Adaptive TTL**: der Cache merkt sich die Dauer des letzten Builds (auch
  eines verworfenen — die Kostenmessung gilt trotzdem); effektive TTL =
  `max(Basis, 10 × letzte Builddauer)`. Damit kann kein Suchraum der Welt
  eine Rebuild-Schleife erzeugen.
- **Fokus-Invalidierung**: `WindowEvent::Focused(true)` in `lib.rs`
  invalidiert zusätzlich den Wikilink-Index (dort tut der Git-Status genau
  dasselbe) — externe Änderungen passieren typischerweise, während Folio den
  Fokus nicht hat, und der VaultWatcher sieht nur aufgeklappte Ordner.
  **Gedrosselt**: übersprungen, wenn der letzte Build jünger als 30 s ist
  (`FOCUS_INVALIDATE_MIN_AGE`), sonst rebuildet jedes Alt-Tab den Vault.
  Explizite Invalidierungen (CRUD/Watcher/Pin) bleiben ungedrosselt.

### Tests

Unit (`wikilink.rs`): leere Wurzeln → leerer Index ohne Walk; Cold-`get`
liefert sofort leer und published im Hintergrund (`RefreshMode::Inline`);
Single-Flight im Cold-Pfad; adaptive TTL (Formel + „kein Rebuild-Loop" über
`get_at`-Zeitinjektion); Fokus-Debounce; Callback beim **Publish** nur bei
nicht-leerem Übergang; **Discard signalisiert und der Folge-`get()` startet
den Ersatz-Build** (inkl. Nachweis, dass danach nicht weitergebaut wird);
**Discard signalisiert auch bei leer→leer** (Wurzel-Einschalten während eines
leeren Builds — mit Nachweis, dass der Folge-Build die neue Wurzel
indexiert); `RefreshingGuard` gibt `refreshing` beim Panic frei und lässt
entschärft ein fremdes Flag stehen; Fingerprint-Wechsel beim Wurzel-Toggle.
Unit (`workspace.rs`): `wikilink_pins` = Pins ∩ Wurzeln (inkl. toter Wurzel),
Idempotenz von `set_wikilink_root`, Unpin-Aufräumen, `remap_prefix` auf
Segmentgrenze, `remove_under`. Unit (`vault.rs`): `data-wikilink-root` nur am
freigeschalteten Pin. Frontend (vitest): Kontextmenü-Toggle (Sichtbarkeit,
Label-Richtung, Datei-Pins, Command-Argumente),
`refreshBacklinksAfterIndexReady` und `view/wikilink-refresh.ts` (beide
Events routen identisch, Listener nur einmal registriert). E2E: `53_wikilinks` und `54_tags` schalten
ihre Wurzeln im Setup frei (`api.workspace_wikilink_root`).

### Nicht in W8

Ein UI zum Verwalten der Wurzelliste in den Einstellungen (heute nur das
Kontextmenü), ein Fortschrittsindikator während des Hintergrund-Builds und
ein persistenter Index (tantivy) bleiben Folgepunkte.

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
