# folio — Feature-Ideen (Brainstorming 2026-07-12)

Konsolidiertes Brainstorming aus vier unabhängigen Quellen: **codex** (GPT-5.6-sol,
high), **agy** (Gemini 3.5), **grok** (Grok Build) und **Claude** (Opus 4.8, Synthese
+ eigene Ergänzungen). Jede Idee lief zunächst separat; hier dedupliziert, gruppiert
und priorisiert.

**Lesehilfe:** `[Aufwand]` grob S/M/L. `(Quelle: …)` zeigt, wer's vorschlug — je mehr
Quellen unabhängig dieselbe Idee nannten, desto stärker das Signal. ⭐ = besonders
lohnend. **Nichts hiervon ist beschlossen** — reine Ideensammlung.

---

## 🏆 Top-Konsens — von mehreren unabhängig genannt (stärkste Signale)

Diese Ideen kamen von 2–4 Quellen unabhängig. Das ist der beste Startpunkt.

1. **⭐ Vault-weite Volltextsuche** — ✅ **umgesetzt (S1–S3, 2026-07-12)**,
   siehe [`spec-vault-search.md`](spec-vault-search.md): Rust-Walk +
   on-demand-Suche, Treffer-Snippets, Klick öffnet die Stelle, Ordner-Scope
   via Kontextmenü, Strg+Shift+F. *Höchster Produktivitätsgewinn für große
   Vaults.* `[M–L]` (Quelle: **alle 3** — codex/agy/grok, alle mit ⭐)
2. **⭐ Wikilinks `[[Name]]` + Backlinks-Panel** — ✅ **umgesetzt (W1–W6,
   2026-07-25)**, siehe [`spec-wikilinks.md`](spec-wikilinks.md): Vault-
   Index + Render, Anlegen-Dialog, Fragment-Nav, Backlinks-Rail,
   `[[`-Autocomplete, Tag-Browser, Export-Sanitize, E2E 53/54.
   `[M–L]` (Quelle: **alle 3**)
3. **⭐ Command Palette (Strg+P)** — ✅ **umgesetzt (2026-07-22, Overnight)**,
   siehe [`spec-command-palette.md`](spec-command-palette.md): Fuzzy-Suche
   über Dateien/Tabs/Recents, `>`-Befehle, `#`-Überschriften.
   *(Quelle: codex, grok)*
4. **Aufgaben-Dashboard** — alle `- [ ]`/`- [x]` vaultweit aggregieren, nach
   Datei/Tag/Alter filtern, direkt abhaken. `[M–L]` (Quelle: **alle 3**)
5. **⭐ Zen-/Fokus-Modus + Typewriter-Scrolling** — Rails/Toolbar ausblenden,
   aktive Zeile vertikal zentrieren, Umfeld dimmen. `[S–M]` (Quelle: **alle 3**)
6. **Präsentations-/Slide-Modus** — Dokument an `---`/H1 in Folien teilen,
   Vollbild-Navigation, optional HTML-Slides-Export. `[M–L]` (Quelle: **alle 3**)
7. **~~Lokale KI via Ollama~~ — GEHT SCHON HEUTE.** agy/grok kannten das Setup nicht:
   der generische Custom-Provider (Settings → KI-Anbieter → „Anbieter hinzufügen" →
   URL `http://localhost:11434/v1` + Name) macht Ollama-Modelle sofort verfügbar
   (`config.rs::custom_upsert` mit freier `base_url`). *Kein neues Feature nötig.*
   Höchstens optional: ein **Ein-Klick-Ollama-Preset** als Bequemlichkeit (Auto-
   Discovery laufender Modelle). `[S]`, aber niedriger Zusatznutzen.
8. **Lokale Snapshots / Crash-Recovery** — ungespeicherte Stände periodisch in ein
   lokales Journal, Restore nach Absturz; optional benannte Versionen pro Datei
   (`.folio/versions/`). `[M–L]` (Quelle: **alle 3**)
9. **Statusleisten-Ausbau** — ✅ **umgesetzt (2026-07-25)**, siehe
   [`spec-statusbar.md`](spec-statusbar.md): Cursor Ln/Sp, Selektions-Stats,
   EOL-Anzeige mit LF↔CRLF-Klick-Toggle; Encoding-Anzeige kam bereits mit dem
   Encoding-Feature (`db0d553`). *Lesezeit bewusst verworfen (User-Entscheid);
   Encoding-Umschalter als möglicher Folgepunkt.* (Quelle: agy, grok)
10. **Regex + „Ersetzen" in der Find-Bar** — ✅ **umgesetzt (2026-08-15)**:
    Regex-Toggle in allen Surfaces (Editor/Code/MD/HTML/Split), Ersetzen +
    Alle-Ersetzen im Puffer des aktiven Tabs, Scope „In Auswahl" als
    explizites Toggle, Capture-Gruppen, ein Undo-Schritt, Ctrl+H. E2E 58.
    **Offen geblieben** (bewusst, siehe Scope-Entscheid): Ersetzen über
    *offene Tabs* und *vault-weit auf Disk*. Letzteres bleibt `[L]` — es
    braucht Preview vor dem Schreiben, Encoding-/EOL-Erhalt pro Datei und
    hat kein Undo. (Quelle: **alle 3**)
11. **Git-Status im Vault + einfaches Git-Panel** — Dots ✅ **umgesetzt
    (2026-08-14)**: modified/untracked als Punkte auf Vault-Nodes über
    `git status --porcelain=v1 -z`, asynchron mit Cache + Single-Flight,
    Ordner-Aggregation, Invalidierung bei Fokus/Save/TTL (`git_status.rs`).
    *(war als `[S]` geschätzt, real `[M]` — der synchrone Render-Pfad
    verträgt keine Prozess-Spawns.)* Das **Stage/Commit-Panel** `[L]`
    bleibt offen. (Quelle: agy, grok, codex)
12. **Templates + Snippets** — wiederverwendbare MD-Blöcke/Vorlagen mit Platzhaltern
    (Datum, Dateiname, Auswahl), Zugriff über Palette/Toolbar; bewusst kleines,
    nicht-ausführbares Format. `[S–M]` (Quelle: **alle 3**)
13. **Frontmatter-Formular-Editor** — YAML-Frontmatter als UI-Formular (Titel,
    Tags, Datum, freie Felder) parallel zur Rohansicht; Roundtrip-erhaltend. `[M]`
    (Quelle: agy, codex)
14. **Export-Presets & Batch-Export** — benannte Konfigs (Theme+Layout+Optionen),
    Mehrfachauswahl im Vault → Sammelexport. `[M]` (Quelle: codex, grok)
15. **Vault-Dateioperationen vervollständigen** — „Neuer Ordner", Duplizieren,
    Verschieben, Mehrfachauswahl; macht den Vault zum vollwertigen Dateibrowser.
    `[M]` (Quelle: codex; ergänzt das gerade gebaute Löschen/Neue-Datei)

---

## A) Verbesserungen bestehender Features

- **Bidirektionales Scroll-Sync härten** — Vorschau-Scroll zieht Editor mit;
  robuster gegen Re-Renders. Achtung: Feedback-Loop-Gating nötig. `[M]` (grok⭐, agy⭐)
- **Große-Dokumente-Strategie** — sehr große Dateien erkennen (>~100k Zeichen /
  langsame Renders) → „Live-Preview aus", reiner Text-/Read-Only-Fallback,
  progressives Rendern. Verhindert UI-Hänger. `[S–M]` (grok, agy)
- **Vault-Tree-Filter** — ✅ **umgesetzt (2026-07-20)**, siehe
  [`spec-vault-filter.md`](spec-vault-filter.md): Namensfilter über dem Baum
  (Backend-Walk statt clientseitig — greift damit auch in collapsed Nodes),
  erweitert um „nur Markdown"-Toggle inkl. Ausblenden MD-loser Ordner.
  *(ursprünglich `[S]`, durch die Erweiterung `[M]`; Quelle: grok)*
- **Tastaturnavigation im Vault** — Pfeile navigieren, Enter öffnet, Space klappt
  auf/zu; Maus minimieren. `[S]` (agy)
- **Tab-Kontextmenü-Ausbau** — ✅ **umgesetzt (2026-07-22)**, siehe
  [`spec-tab-context-menu.md`](spec-tab-context-menu.md): „Alle anderen
  schließen", „Tabs rechts schließen", „Zuletzt geschlossenen Tab
  wiederherstellen" (Session-Stack, Cap 10). *(Quelle: grok, codex;
  zugleich A/B-Implementierungstest agy vs. grok)*
- **Preview-/Pin-Tabs** — Einfachklick = ersetzbarer Preview-Tab, Doppelklick/Edit
  fixiert; angeheftete bleiben links (VS-Code-Muster). `[M]` (codex⭐)
- **Tab-Overflow + Tab-Suche** — Dropdown aller offenen Tabs, filterbar. `[S–M]`
  (codex)
- **Interaktiver Outline-Modus** — TOC-Überschriften einklappen/umbenennen/samt
  Abschnitt verschieben; Risiko: Source-Range-Zuordnung im AST. `[L]` (codex)
- **Intelligenter Link-/Bild-Dialog** — beim Einfügen Vault-Dateien + Überschriften
  per Autocomplete, relative Pfade berechnen, Assets wiederverwenden. `[M]` (codex)
- **Mermaid-Fehlerdiagnose** — Syntaxfehler mit Zeilenangabe + visueller Markierung
  statt rohem Fehlertext. `[S]` (agy)
- **Drei-Wege-Merge bei externen Änderungen** — statt nur Neu laden/Verwerfen:
  Base/lokal/Disk vergleichen und zusammenführen. `[L]` (codex)
- **Vault-Watcher-Reconnect** — bei Netzlaufwerken den `notify`-Watch nach
  Verbindungsabbruch neu aufbauen. `[M]`, plattformabhängig (agy)
- **KI-Transparenz vor dem Start** — Prompt, geschützte Bereiche, geschätzte Tokens,
  Provider sichtbar; optional „nur lokale Provider"-Profil. `[S–M]` (codex)
- **Barrierefreiheit als Qualitätsmodus** — volle Keyboard-Nav, Fokusführung,
  Screenreader-Labels, High-Contrast, `prefers-reduced-motion`-Test. `[M]` (codex)
- **Page-Break im Export** — `<!-- page-break -->`/CSS-Klasse → harter Umbruch im
  HTML/PDF-Export. `[S]` (agy)

## B) Neue Features (produktiv)

- **Sicheres Link-Refactoring beim Umbenennen/Verschieben** — relative Links im
  Vault mitziehen, mit Vorschau; atomar + undo-fähig. `[L]` (codex)
- **Markdown-Diagnostik/Linting** — übersprungene Heading-Level, kaputte Tabellen,
  doppelte Anker, offene Fences, fehlende Bildziele — inline + Problems-Liste.
  `[M–L]` (codex)
- **Rechtschreibprüfung + Projektwörterbuch** — Sprache pro Doc/Frontmatter,
  Fachbegriffe im Vault-Wörterbuch, Marker im Editor. `[L]`, native Deps (codex)
- **Tabelle ↔ CSV-Konverter** — markierte Tabellendaten ⇄ Markdown-Tabelle per
  Toolbar. `[S]` (agy)
- **Orphan-Files-Finder** — MD-Dateien auflisten, auf die niemand verlinkt (Ordnung
  im persönlichen Wiki). `[S]` (agy)
- **Beliebige Dateien vergleichen** — Teil-Umsetzung ✅ **2026-08-14**:
  „Änderungen anzeigen" im Vault-Kontextmenü zeigt HEAD gegen den
  aktuellen Stand (read-only, `FolioDiffView` mitbenutzt, offene
  KI-Review hat Vorrang). **Offen bleiben**: zwei beliebige Tabs, zwei
  Vault-Dateien, Datei-vs-Disk als eigener Modus. `[M]` (codex, grok)
- **Workspace-Profile** — getrennte Profile für Pins/Recents/Tabs/Presets/Layout
  („Arbeit", „Doku", „Privat"). `[M]` (codex)
- **Untitled Buffers** — sofort unbenannten MD-Tab öffnen, Pfad erst beim Speichern;
  ideal für spontane Notizen. `[M]` (codex)
- **OS-Drag-Import in den Vault** — Dateien/Ordner aus dem Explorer auf den Baum
  ziehen → kopieren/verschieben mit Konflikt-Handling. `[S]`, baut auf
  `ui/drag-drop.ts` (grok)
- **Mehrere Vaults / Schnell-Wechsel** — zusätzliche Root-Ordner öffnen bzw.
  zwischen Workspaces wechseln. `[M]` (grok)
- **Inline-Mathematik (KaTeX)** — `$…$`/`$$…$$` in Vorschau + Export. `[M]`,
  Bundle-Größe beachten (grok)
- **Admonitions/Callouts** — `> [!NOTE]`/`> [!WARNING]` mit Icon + farbiger Box in
  allen Themes + Export. `[S]` (grok)
- **Auto-Export-Watcher** — bei jedem Save optional PDF/HTML im selben Verzeichnis
  regenerieren. `[S]` (agy)

## C) Coole / Nice-to-have / experimentell

- **Als Rich Text kopieren** — Auswahl/Doc gleichzeitig als HTML+Plaintext in die
  Zwischenablage → formatiertes Einfügen in Mail/Office/Chat. `[S–M]`, Clipboard-API
  plattformabhängig (codex)
- **Link-Graph** — virtueller Tab mit Liste/Canvas der Dokument-Verknüpfungen;
  kann als schlanke Liste starten. `[L]` (grok)
- **Editor-Snippets mit Tabstops** — echte Monaco-Snippets (Prefix+Tab,
  `${1:…}`-Platzhalter). `[M]` (grok)
- **Reading-Progress in der View** — dezente „X % gelesen"/„Abschnitt 3/12"-Anzeige
  bei langen Docs. `[S]` (grok)
- **Bessere Bild-Handhabung in der Vorschau** — Zoom/Pan für eingebettete Bilder,
  Caption aus alt-Text, Klick-to-Open-in-OS. `[S]` (grok; überlappt Image-View-TODO)
- **Private Randnotizen (Sidecar)** — Kommentare/Markierungen in `.folio-notes`
  ohne das MD zu verändern; Anker müssen Textänderungen überleben. `[L]` (codex)
- **Git-Revisions-Zeitleiste** — Slider über Commits einer Datei, im Diff-Editor
  ansehen + wiederherstellen. `[M]` (agy)
- **Excalidraw-/SVG-Zeichenbrett** — minimales Offline-Board, SVG in den Vault +
  als Bild-Link einbetten. `[M]` (agy)
- **Audio-Diktat (lokales Whisper)** — Sprache → Text an Cursorposition. `[M]`,
  Audio-Capture-APIs plattformabhängig (agy)
- **Lokaler Review-/Preview-Server (LAN)** — Export temporär über zufällige lokale
  URL bereitstellen, QR-Code, explizites Start/Stop. `[M–L]`, Firewall/Bind sehr
  konservativ (codex)
- **LAN-Kollaboration (P2P, CRDT/Yjs)** — gemeinsames Schreiben im LAN ohne Server.
  `[L]`, hohes Risiko (CRDT-Komplexität, Ports/Firewall) (agy)

---

## 🧠 Claudes eigene Ergänzungen

Dinge, die in den drei Sets fehlten oder die ich für besonders wirkungsvoll halte:

- **⭐ Klickbare Checkboxen in der gerenderten View** — ✅ **umgesetzt
  (2026-08-13)**: Klick auf die Box in View/Split/Live-Preview toggelt die
  Quelle über `applyReplace` (Undo-fähig, dirty wie ein Tastatur-Edit).
  Stale-Guard über Monacos `versionId`, `disabled` wird nur clientseitig
  entfernt (Export bleibt read-only), geordnete + Blockquote-Tasks
  unterstützt, `aria-label` gesetzt. E2E 55. *(ursprünglich `[S–M]`; die
  Toggle-Logik war klein, die Folgefragen — Export-Vertrag, stale DOM,
  GFM-Varianten, A11y — machten den Großteil der Arbeit aus.)*
- **⭐ „Als sauberes Markdown einfügen"** — HTML aus der Zwischenablage (Browser/Word/
  Confluence) beim Einfügen automatisch zu sauberem MD konvertieren (turndown-artig,
  im Frontend). Spart massives Nachputzen. `[M]` (Gegenstück zu codex' „als Rich Text
  kopieren")
- **Inline-Autovervollständigung für Links/Wikilinks** — ✅ **teilweise umgesetzt
  (W4, 2026-07-25)**: `[[`/`![[` + `[[Name#` Headings im Monaco-Provider;
  `](`-Markdown-Links bleiben Folgepunkt. `[M]`
- **Smart-List-Fortsetzung** — Enter in Listen setzt automatisch `- `/`1.`/`- [ ]`
  fort, leere Zeile bricht ab; Tab/Shift-Tab rückt ein/aus. Reine Editor-QoL. `[S–M]`
- **Tabellen-Auto-Format** — Command/On-Save richtet MD-Tabellen sauber aus
  (Spalten-Padding). Kombiniert gut mit dem CSV-Konverter. `[S]`
- **Tag-Browser** — ✅ **umgesetzt (W5, 2026-07-25)** in der linken Rail
  (`#vault-tags-section`, lazy Scan, Search-Präfill); Spec
  [`spec-wikilinks.md`](spec-wikilinks.md). Hierarchie-Baum bleibt Folgepunkt. `[M]`
- **View-Theme folgt OS/Uhrzeit** — automatischer Hell/Dunkel-Wechsel nach
  `prefers-color-scheme` bzw. Tageszeit. `[S]`
- **Emoji-/`:shortcode:`-Picker** im Editor. `[S]`

---

## 🎯 Claudes Empfehlung — was ich zuerst angehen würde

Meine Engineering-Einschätzung zur Reihenfolge (Nutzen ÷ Aufwand, plus wie gut es
zum Offline-First-Charakter passt):

**Sofort-Quick-Wins (S, hoher gefühlter Mehrwert):**
1. **Statusleisten-Ausbau** (Cursor/Encoding/EOL/Lesezeit) — klein, sichtbar,
   nutzt vorhandenen Roundtrip-Code.
2. **Regex-Toggle in der Find-Bar** — klein, die Infrastruktur steht schon.
3. **Klickbare Checkboxen in der View** — kleiner Wow-Effekt für Task-Nutzer.

*(Ollama war ursprünglich hier gelistet — entfällt, weil bereits per Custom-Provider
möglich, siehe Top-Konsens #7.)*

**Nächste Ausbaustufe (das „Wissens-Werkzeug"-Paket, hoher Nutzen):**
5. **Vault-weite Volltextsuche** — mit Abstand die meistgenannte Idee; der größte
   Einzel-Sprung Richtung „ernsthaftes Notiz-/Wiki-Tool".
6. **Command Palette** — hebt die gesamte Bedienbarkeit, entkoppelt Features von
   Toolbar/Shortcuts (profitiert von 5 mit).
7. **Wikilinks + Backlinks + Link-Autocomplete** — zusammen der Obsidian-artige
   Kern; macht folio zum vernetzten Vault statt Einzeldatei-Editor.

**Danach nach Lust & Laune:** Zen-Modus, Präsentationsmodus, Templates/Snippets,
Frontmatter-Formular, Crash-Recovery-Snapshots, Git-Status-Dots.

**Bewusst hinten anstellen (hoher Aufwand/Risiko, Nischennutzen):** LAN-P2P-Collab,
Rechtschreibprüfung mit nativem Wörterbuch, Drei-Wege-Merge, Audio-Diktat,
Excalidraw-Board.

> Meine Kurzfassung in einem Satz: **Volltextsuche + Command Palette + Wikilinks**
> würden folio am spürbarsten von „sehr gutem MD-Editor" zu „vollwertigem lokalem
> Wissens-Werkzeug" heben — der Rest ist Kür. (Lokale KI via Ollama gibt's schon.)
