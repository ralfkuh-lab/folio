# Spec: Vault-Volltextsuche

> **Arbeitsdokument mit Fortschritts-Checkliste.** Checkboxen werden
> pro abgeschlossener, grün getesteter Etappe abgehakt und committet.
> Grundlage: Top-Konsens #1 aus [`feature-ideen.md`](feature-ideen.md)
> (von allen drei Quellen ⭐) + User-Anforderung: Suche muss auch auf
> **einzelne Ordner** startbar sein.

## Ziel

Volltextsuche über alle Markdown-/Text-Dateien des Vaults mit
Treffer-Snippets; Klick auf einen Treffer öffnet die Datei an der
Fundstelle. Suchbar ist wahlweise der **gesamte Vault** oder ein
**einzelner Ordner** (Kontextmenü „In diesem Ordner suchen“). UI als
Such-Panel im linken Vault-Rail (Obsidian-/VS-Code-Muster), Shortcut
**Strg+Shift+F**.

## Begriffs-/Scope-Modell

folio hat keinen einzelnen Vault-Root — der „Vault“ ist die Menge der
angepinnten Einträge. Daraus folgt:

- **Scope „Gesamter Vault“** (Default): Union aller **angepinnten
  Ordner** (rekursiv) plus aller **angepinnten Einzeldateien**.
  Die „Zuletzt geöffnet“-Liste ist **bewusst nicht** Teil des Scopes
  (verstreute Einzeldateien → Überraschungstreffer außerhalb dessen,
  was der User als „seinen Vault“ versteht).
- **Scope „Ordner“**: ein beliebiger Ordner aus dem Baum (auch nicht
  selbst gepinnte Unterordner eines Pins), rekursiv.
- **Overlap-Dedup**: gepinnter Ordner + gepinnter Unterordner →
  verschachtelte Ordner eingeklappt; jede Datei wird genau einmal
  durchsucht (Dedup über `seen` + normalisierte absolute Pfade,
  Forward-Slashes wie überall). Explizit gepinnte Einzeldateien unter
  einem gepinnten Elternordner werden in den Roots **behalten** (nur
  exakte Duplikat-Pins fallen weg), damit der Pin-Bypass greift, wenn
  der Walk sie wegen hidden/gitignore überspringt.
- **Explizit gepinnte Einzeldateien werden immer durchsucht** — hidden-/
  gitignore-Filter gelten nur für den Verzeichnis-Walk (bewusst: Pin =
  Nutzer-Intention; der Vault-Baum zeigt gepinnte Dateien ebenfalls
  unabhängig von diesen Filtern). Kind-/Größen-/NUL-Filter greifen weiterhin.
- Nichts Durchsuchbares (keine Pins **oder** nur Binärdateien) + kein
  Ordner-Scope → leeres Ergebnis mit Hinweistext („Keine durchsuchbaren
  Dateien im Vault — pinne einen Ordner oder starte die Suche per
  Rechtsklick auf einen Ordner“). Erkennbar an `filesScanned == 0` bei
  Vault-Scope (kein Backend-Flag in V1).

## Architektur-Entscheidungen (verbindlich)

1. **Backend-Suchmodul `search.rs`** (neben `vault.rs`), Command-Layer
   in `commands/` + Automation-Handler. Verzeichnis-Walk über
   `ignore::WalkBuilder` (Crate ist bereits Dependency — die
   „kein WalkBuilder“-Notiz in CLAUDE.md betraf nur das Dimming-
   Feature). Standard-Filter des Walkers: **gitignorierte und hidden
   Einträge werden übersprungen** (konsistent mit dem Dimming; `.git`
   & Co. fallen damit automatisch raus). Opt-in-Toggle
   `includeHidden` (Default aus, persistiert in `panel_state` als
   `search_include_hidden`, Dialog-Checkbox `#vsd-include-hidden`)
   schaltet per `WalkBuilder::standard_filters(false)` hidden/parents/
   ignore/git_ignore/git_global/git_exclude als Gruppe ab (ein Schalter,
   nicht zwei; `require_git` unangetastet). **Bewusste Ausnahme:**
   Verzeichnisse namens `.git` bleiben per `filter_entry` draußen
   (Object-Store/hooks/logs wären Kosten + Rausch-Treffer). Beide
   Walk-Pfade (sequenziell + parallel) teilen dieselbe
   Filterkonfiguration. `sort_by_file_name` für deterministische
   Reihenfolge (E2E-Baselines). Seit S6 (2026-07-16) laufen
   Verzeichnis-Scopes über `run_search_parallel` (`build_parallel`,
   Completion-Order); die sequenzielle Pipeline bleibt als geteilter
   Kern erhalten (historisch: V1 startete single-threaded).
2. **Datei-Filter über `file_kind::classify`**: nur
   `FileKind::Markdown` und `FileKind::Text`. Zusätzlich Größen-Cap
   (Konstante `MAX_FILE_SIZE = 2 MiB`, größere Dateien werden
   übersprungen und gezählt) und NUL-Byte-Sniff in den ersten 8 KiB
   gegen falsch benannte Binärdateien. Gelesen wird mit
   `String::from_utf8_lossy` (Suche ist read-only; keine
   DocumentStore-Encoding-Detection nötig).
3. **Matching über das `regex`-Crate** (neue direkte Dependency, ist
   ohnehin transitive Dep von `ignore`): Suchbegriff wird escaped als
   Literal kompiliert, Optionen `caseSensitive` (Default aus →
   `(?i)`) und `wholeWord` (`\b…\b`). Begründung: korrekte
   Unicode-Case-Faltung ohne Byte-Offset-Drift (naives
   `to_lowercase` verschiebt Offsets, z. B. bei „ß“) — und der
   Regex-Toggle aus Feature-Idee #10 ist später ein Einzeiler.
   Mindestlänge Suchbegriff: 2 Zeichen.
4. **Ergebnis-Datenmodell**: ein Eintrag **pro Zeile** mit allen
   Match-Ranges dieser Zeile, gruppiert pro Datei.
   `{ path, fileName, hits: [{ line (1-based), colUtf16 (1-based),
   lenUtf16, snippet, snippetOffsetUtf16, ranges: [[startUtf16, lenUtf16]] }],
   truncated }`. Spalten in **UTF-16-Code-Units** (Monaco-Konvention;
   Backend rechnet aus Byte-Offsets um, Muster analog
   `utf16_to_byte_offset_strict` aus `ai/`). `snippet` ist die Zeile,
   bei Überlänge auf ~240 Zeichen um den ersten Treffer gefenstert.
   Caps: `MAX_HITS_PER_FILE = 50`, `MAX_HITS_TOTAL = 500`; Truncation
   wird pro Datei und global geflaggt und in der UI angezeigt („…
   weitere Treffer, Suchbegriff verfeinern“) — **kein stilles
   Abschneiden** (Projekt-Regel „No silent caps“).
5. **Streaming über Events + runId** (Muster: Translate-Streaming +
   `renderGen`-Generation-Token): Command `vault_search_start
   { query, scope?, caseSensitive, wholeWord }` → `runId`; Events
   `search:hits { runId, files: [...] }` (gebündelt pro Datei),
   `search:done { runId, stats: { filesScanned, filesMatched, hits,
   skippedLarge, truncated, elapsedMs } }`; Command
   `vault_search_cancel { runId }` (AtomicBool-Flag, Walk prüft
   kooperativ). Der Walk läuft in einem `spawn_blocking`-Task.
   Frontend: Debounce 250 ms auf Eingabe, neue Suche cancelt die
   alte, Events mit fremder `runId` werden verworfen (exakt das
   `renderGen`-Muster aus `view/preview.ts`).
6. **UI = Such-Panel im Vault-Rail** (kein virtueller Tab, kein
   Modal): Suchfeld + Options-Toggles (Aa / W) + Scope-Chip zwischen
   Vault-Header und Baum (`#vault-search` in `dist/index.html`). Bei
   nicht-leerem Suchbegriff wird `#vault-tree` ausgeblendet und
   `#vault-search-results` gezeigt (Datei-Gruppen auf-/zuklappbar,
   Treffer-Zeilen mit `<mark>`-Highlight — Snippet-Text wird
   escaped eingefügt, Markup nur um die Ranges). Escape/Leeren →
   Baum zurück. Keyboard: ↑/↓ durch Treffer, Enter öffnet,
   Strg+Enter öffnet im neuen Tab. **Strg+Shift+F** fokussiert das
   Suchfeld (öffnet das Vault-Rail, falls zu); dazu bekommt der
   Capture-Handler der Find-Bar (`find-bar.ts:316`) einen
   `!e.shiftKey`-Guard — heute schluckt er Strg+Shift+F mit.
   Menü-Eintrag „Bearbeiten → Im Vault suchen…“ über den
   bestehenden `menu_dispatch`-Pfad.
7. **Treffer öffnen**: Klick öffnet im aktiven Tab (Öffnen-Konvention
   wie Vault-Klick), Strg/Cmd+Klick bzw. Strg+Enter via `tab_open`.
   Sprung zur Stelle nach `document:loaded`: in **Edit/Split** präzise
   via Monaco (`revealLineInCenter` + Selection auf
   line/colUtf16/lenUtf16); im **View-Mode** wird die Find-Bar mit dem
   Suchbegriff + Optionen geöffnet (`openEditorFind`/
   `setEditorFindTerm`) und der N-te Treffer aktiviert (N =
   Quelltext-Treffer-Index; Aktivierung über Finder-API bzw.
   `findNext`-Iteration, Cap 200). Bekannte, akzeptierte Abweichung:
   gerenderte Treffer-Reihenfolge kann vom Quelltext abweichen
   (Frontmatter/HTML) → Fallback ist der erste Treffer. Kein
   erzwungener Mode-Wechsel.
8. **Ordner-Scope über das Kontextmenü**: neues Item „In diesem
   Ordner suchen“ für Verzeichnisse (in `vault/context-menu.ts`,
   Icon-Konvention wie bestehende Items). Setzt den Scope-Chip
   (Ordnername, Tooltip = voller Pfad, „ד entfernt ihn → zurück auf
   Gesamt-Vault), fokussiert das Suchfeld und re-triggert eine
   laufende Suche. Scope wird **nicht** persistiert.
9. **Persistenz**: die Options-Toggles (Aa/W/`includeHidden`) wandern nach
   Projekt-Konvention in `panel_state.rs`/`panel-state.json`
   (UI-Toggle-Persistenz-Regel). Suchbegriff, Scope und Ergebnisse
   sind flüchtig. **Keine neuen `settings.json`-Keys** in V1.
10. **Automation-API**: `POST /search { query, scope?, caseSensitive?,
    wholeWord?, timeoutMs? }` — synchron, wartet backendseitig auf
    `done` und liefert das komplette Ergebnis + Stats (E2E braucht
    kein Streaming). Eintrag in `docs/automation-contract.md`.

## Etappen & Checkliste

### Etappe S1 — Backend-Engine + API (ohne UI)

API-first → testbar wie bei den Tabs (T2). **TDD-Zusatz (vereinbart
2026-07-12): S1 läuft test-first in zwei getrennten Läufen.**

- [x] **S1a — Tests zuerst** ✅ (2026-07-12, Opus 4.8 + Orchestrator-
      Nachschärfung: Zeichen-vs-Byte-Mindestlänge, tote Pins im
      Vault-Scope werden still verworfen, Snippet-Fensterungs-
      Invarianten — 25 Tests rot, Build/fmt/clippy grün):
      öffentliche API-Signatur von `search.rs`
      (Typen + Funktions-Stubs mit `todo!()`, kompilierend) + die
      komplette Unit-Testdatei: Umlaute/Emoji-UTF-16-Spalten, CRLF,
      Caps/Truncation-Flags, Overlap-Dedup, gitignore/hidden-Skip,
      NUL-Sniff, Größen-Cap, Mindestlänge, caseSensitive/wholeWord
      (Unicode-Wortgrenzen), Ordner- vs. Vault-Scope, Pin-Einzeldatei,
      Cancel-Flag. Tests sind rot, `cargo build` grün. **Kein
      Implementierungscode.** Abnahme der Testfälle gegen die Spec
      durch den Orchestrator, BEVOR S1b startet.
- [x] **S1b — Implementierung gegen die Tests** ✅ (2026-07-12, Opus
      4.8; kein fixierter Test angefasst): `search.rs` (Scope-Auflösung,
      Walk + Filter + Matching + Caps + UTF-16-Spalten).
- [x] Commands `vault_search_start`/`vault_search_cancel`, Events
      `search:hits`/`search:done` (runId-Korrelation), Cancel-Test.
- [x] Automation `POST /search` (sync) + Contract-Doku.
- [x] `cargo test`/`clippy`/`fmt` grün (523 Tests, davon 29 search::).
- [x] E2E `46_vault_search_api.py`: Treffer in Fixtures, Ordner-Scope,
      caseSensitive/wholeWord, Truncation-Stats (per-File + global >500),
      gitignore-Respekt, UTF-16-Koordinaten (Umlaut+Emoji) über JSON.
- [x] **Kreuz-Review codex (gpt-5.6-sol, high) + agy** → EIN Fix-Paket,
      umgesetzt: globale Cap-Semantik (Deckel-Check vor IO, Probe-Modus,
      `truncated` nur bei realem Wegfall), Snippet-Fenster deckt ersten
      Match immer ab, `SearchError::InvalidScope` (relativ/falscher
      Typ → 400), RAII-`SearchRunGuard` (Cleanup + Error-Event bei
      Panic), Cancel pro Zeile, Perf (classify vor seen-Insert,
      Byte→UTF-16-Präfix-Map), api.py-Transport-Timeout. Abgelehnt
      (dokumentiert): gepinnte Einzeldateien umgehen hidden/gitignore
      bewusst. Orchestrator-Endabnahme: Gates + E2E 46 nachgefahren.

### Etappe S2 — Such-Panel UI ✅ FERTIG (2026-07-12)

- [x] `#vault-search` + `#vault-search-results` in `dist/index.html`,
      CSS in `vault.css`-Bereich (Light + Dark, Fokus-Stil).
- [x] Neues Modul `vault/search.ts`: Debounce/Cancel/runId- +
      maxRunId-Guard (Event-Puffer für Hits vor Start-Antwort),
      Ergebnis-Rendering (escaped + `<mark>` über UTF-16-Ranges),
      Gruppen-Toggle, Truncation-Hinweis, Statuszeile.
- [x] Treffer-Klick → Öffnen + Sprung: Edit/Split präzise via
      `FolioEditor.revealMatch`; View via Find-Bar mit
      Finder-Settle-Wartung (`folio-find-state`-Quiesce) statt
      synchroner findNext-Iteration. Sprung-Korrelation über das
      seq-geschützte `folio-doc-kind-changed` + `getCurrentPath`;
      Navigation-Restore-Konflikt über `consumeNavRestoreSkip`
      (nur tab_open-Pfad, Back/Forward unberührt).
      Strg+Klick/Mittelklick/Strg+Enter → neuer Tab.
- [x] Keyboard-Nav (↑/↓/Enter, überspringt zugeklappte Gruppen),
      Strg+Shift+F inkl. `!e.shiftKey`-Guard in `find-bar.ts`,
      Menü „Bearbeiten → Im Vault suchen…“.
- [x] Aa/W-Toggles persistiert in `panel-state.json`
      (`search_options_get`/`set_search_options`).
- [x] jsdom-Tests (292 gesamt, 15 fürs Suchmodul: Marks/Emoji,
      Debounce/stale-runId, Escape-während-Start-Race, Event-Puffer,
      Options-Retrigger, Keyboard, Dispose-Hygiene).
- [x] Bundles eingecheckt; E2E `47_vault_search_ui.py` (Deadline-
      Polling, Aa-Toggle über UI, Ctrl+Klick-Sprung in neuen Tab,
      View-Mode-Sprung auf Treffer N, echter Escape-Pfad) + Baselines:
      15 reseedet (Suchfeld im linken Rail) + 2 neue; zwei
      aufeinanderfolgende volle Läufe 47/47 + 15/15 visuell grün.
- [x] **Kreuz-Review codex (gpt-5.6-sol high) + grok + agy** → EIN
      Fix-Paket (10 Punkte), umgesetzt; abgelehnt mit Beleg: groks
      camelCase-Payload-Befund (Tauri-Auto-Konvertierung, empirisch
      durch Aa-Toggle-E2E bestätigt). Orchestrator-Endabnahme: Gates
      nachgefahren, Fix-Stichproben, Screenshot-Sichtprüfung.

### Etappe S3 — Ordner-Scope + Feinschliff ✅ FERTIG (2026-07-12)

- [x] Kontextmenü-Item „In diesem Ordner suchen“ (nur Verzeichnisse)
      → Scope-Chip, Fokus, Re-Trigger; Chip entfernen → Gesamt-Vault.
- [x] Scope-Validierung (Ordner existiert nicht mehr → Chip entfernen
      + Statushinweis).
- [x] Leere-Pins-Hinweistext; `search:done`-Stats in der Statuszeile
      (inkl. übersprungene Groß-Dateien).
- [x] Doku: CLAUDE.md-Abschnitt (Konventionen), automation-contract
      final, TODO.md-Abgleich, feature-ideen.md-Eintrag als „✅ umgesetzt“
      markiert.
- [x] E2E-Erweiterung: Ordner-Scope über echtes Kontextmenü-Klicken
      (mit aktiver Query = Re-Trigger-Pfad, Exklusivitäts-Asserts);
      voller Suiten-Lauf grün.
- [x] **Kreuz-Review codex (gpt-5.6-sol high)** (agy: OAuth abgelaufen,
      für die kleine Etappe bewusst nur ein Zweit-Reviewer) → Fix-Paket
      umgesetzt: Scope-Fehler-Klassifikation (`scope:`-Präfix, Fallback
      nur bei echtem Scope-Fehler), finalStatus-Reihenfolge
      (skippedLarge bei 0 Treffern sichtbar), neutraler
      Leere-Vault-Text, E2E-Härtung, CLAUDE.md-Probe-Formulierung.
      Orchestrator-Endabnahme: Gates nachgefahren, Diff-Review.

**Status: Feature komplett — S1–S3 abgeschlossen (2026-07-13).**

### ✅ Etappe S4 — Dialog-first + Regex/Filter/OpenTabs (2026-07-15)

Sechs Erweiterungen aus User-Feedback (Rev. 2 nach Sol-Review). Harte
Randbedingung: `search.rs::mod tests` bleibt **additiv-only** — `run_search`/
`SearchOptions` unverändert, alle Erweiterungen über neue Typen/Funktionen, die
alten Symbole delegieren.

#### ✅ Dialog-first-Flow (statt Inline-Zeile)

Strg+Shift+F / Menü / Summary-Klick / Kontextmenü öffnen `#vault-search-dialog`
(Muster `.unsaved-dialog__panel`). Der linke Rail zeigt nur noch den
Summary-Button `#vault-search-summary` (committed Begriff + Options-Glyphen)
plus die Ergebnisse mit `#vault-search-results-head` (Collapse-/Expand-All).
**Draft vs. Committed strikt getrennt** [Sol#7]: Der Dialog arbeitet auf den
DOM-Feldern; committed State (`activeQuery`, Optionen, Scope) ändert sich NUR
bei gültigem Submit. `openVaultSearchDialog()` ist idempotent (re-populiert +
fokussiert), Abbrechen verwirft nur den Draft und lässt einen laufenden Lauf
unangetastet. Submit läuft: Feld-Validierung (`vault_search_validate`) → bei
OpenTabs zwingend `syncEditorTextToStoreRequired()` → alten Lauf canceln →
committed State setzen → `set_search_options` persistieren → Dialog zu →
`runSearch()`. Keyboard-Nav (↑/↓/Enter/Escape) hängt jetzt an der
fokussierbaren Ergebnisliste, nicht mehr am Inline-Input.

#### ✅ Spinner

Zentrale `setRunning(bool)` an den adoptierten Lauf gekoppelt, Klasse
`vs-running` auf `#vault-search-status` (CSS analog `.ai-status-running::before`
inkl. `prefers-reduced-motion`). Alle Endpfade räumen auf (`applyDone`, Fehler,
Start-Rejection, Scope-Fallback, Cancel-vor-Adoption, neuer Submit,
`exitSearch`); stale Events ändern den Zustand nicht. [Sol#14]

#### ✅ Auto-Collapse als expliziter Modus (`auto | collapsed | expanded`)

Jeder Lauf startet in `auto` (Reset von Modus + `collapsed`-Set + aktiver
Selektion). Beim **ersten Überschreiten von 10 Treffergruppen**
(`AUTO_COLLAPSE_THRESHOLD = 10`, streng `> 10`) wird einmalig alles eingeklappt;
weitere gestreamte Gruppen kommen dann ebenfalls eingeklappt. Collapse-All →
Modus `collapsed`, Expand-All → `expanded`; danach folgen auch später
gestreamte Gruppen der Nutzerwahl. `toggleCollapse`/`rebuildFlat`/`.vs-caret`
wiederverwendet. [Sol#8]

#### ✅ Dateityp-Filter (`FileFilter`)

`enum FileFilter { Markdown, AllText, Custom(Vec<String>) }`. `Markdown` → nur
`FileKind::Markdown`; `AllText` → wie S1 (`Markdown | Text`); `Custom` →
direkter lowercase-`Path::extension()`-Match. `parse_custom_extensions(raw)` ist
die **einzige** Zerlegungsstelle (UI/Tauri/HTTP laufen durch — Tauri/HTTP
akzeptieren daher den Roh-Feldtext, nicht vorzerlegte Listen) [Sol-Rev2#5].
Grammatik: Trennung an **Komma, Semikolon und Whitespace**; pro Token trimmen,
führenden Punkt entfernen, lowercase, deduplizieren; erlaubte Zeichen
`[a-z0-9_-]` (sonst `InvalidCustomExtension`). Nur `Path::extension()` (letzte
Endung, keine Globs/Compound-Suffixe). Leere Liste ist NUR bei aktivem
`Custom`-Filter ein Fehler (`EmptyCustomExtensions`). Der `classify()`-**Bypass
ist bewusstes Opt-in** [Sol#9] (Zweck: unbekannte Textendungen wie `.foobar`
suchbar machen); bekannte Bild-/Binärendungen werden zugelassen (User hat
explizit gewählt), Schutz sind das 2-MiB-Cap + NUL-Sniff — **Best-Effort-
Binärerkennung**, in Kauf genommen.

#### ✅ Scope „alle offenen Dateien" (OpenTabs) + Snapshot-Semantik

`snapshot_open_tab_docs(state)` [Sol#4] lockt **nur** `state.tabs`, klont pro Tab
Pfad + ggf. Text und gibt den Lock vor jedem IO frei. Die per-Tab-Auswahl ist
in die freie Funktion `buffer_doc_for_tab(&Tab) -> Option<BufferDoc>`
ausgelagert (der Helper delegiert + ergänzt nur Lock + Pfad-Dedup), damit der
Kern ohne `AppState` als Rust-Unit-Test läuft [Sol-Impl#4]. **FileKind (nicht
Textleere) entscheidet** über die Quelle [Sol-Rev2#1]: jeder geladene
`Markdown`/`Text`-Store → `BufferSource::InMemory(text)` **auch bei leerem
Puffer** (ein bewusst geleertes dirty Dokument darf nicht auf den alten Disk-
Inhalt zurückfallen → „geleerter Puffer schattet Disk"); opaque/Image-Stores →
`OnDisk` (via `FileKind`); `pending_path`-Tabs → `OnDisk` (lazy von Platte);
Dedup über normalisierte Pfade. **Virtuelle Frontend-Tabs** (Settings, Theme-
Editor, Diff-Review) existieren im Backend-TabManager nicht → automatisch außen
vor. Gemeinsames Content-Gate `inspect_content` (2-MiB-Cap + NUL-Sniff) für
Disk **und** Puffer [Sol#5]; der Disk-Pfad behält die Metadaten-Größenprüfung
**vor** `fs::read`. Zwischen Snapshot und Scan verschwundene Dateien werden
still übersprungen (zählen nicht in `filesScanned`); `skippedLarge` zählt auch
gecappte Puffer. **Treffer-Sprung** [Sol#2]: OpenTabs-Treffer öffnen NICHT über
`openDocument` (Save-Prompt + Reload würden den dirty Puffer zerstören), sondern
mappen Pfad → Tab-ID (`findTabIdByPath`) + `activateTab`; beim bereits aktiven
Tab direkt `performJump`. Pending Tabs lädt `tab_activate` kanonisch lazy.
Liefert `findTabIdByPath` **null** (Tab seit dem Snapshot geschlossen / Tabliste
kurz nicht synchron), fällt der Zweig **NICHT** in `tab_open`/`openDocument`
zurück (das würde ein Ergebnis aus einem verworfenen dirty Puffer über den
Disk-Inhalt öffnen bzw. einen Save-Prompt auslösen), sondern räumt Sprung/
Nav-Skip auf und zeigt `search.status.hitStale` [Sol-Impl#1]. Andere Scopes
behalten den `openDocument`-Pfad.

#### ✅ Regex-Modus (ohne Whole-Word)

Regex-Toggle an → `compile_regex` ohne `regex::escape`. **Regex + Whole-Word
schließen sich aus** (`RegexWholeWordConflict`, UI disabled die Wort-Checkbox,
Backend lehnt die Kombination ab statt sie still umzudeuten). Grund: Rust-
`regex` hat **keine Lookarounds**; ein `\b`-Wrap liefert bei Satzzeichen-/
Anchor-/Alternations-Patterns überraschende Semantik. **Zero-Width-Matches**
(z. B. `a*`) werden beim Scan übersprungen (kein Hit mit `lenUtf16 == 0`) —
**auch im Probe-Modus**: `probe_has_match` prüft `find_iter().any(|m| m.start()
< m.end())` statt `is_match`, sonst setzt ein Zero-Width-only-Kandidat nach dem
Cap fälschlich `truncated=true` [Sol-Rev2#2]. `MIN_QUERY_LEN = 2` gilt auch für
Patterns. Ungültiges Pattern → `InvalidPattern` (Key `errors.search.invalidQuery`).
**View-Mode-Jump** [Sol#3]: `Jump.term` trägt bei Regex-Läufen den konkret
gematchten Text (aus Snippet + erster Range) und wird als Literal (ohne
Whole-Word) gesucht; Edit/Split nutzen weiter die Backend-Koordinaten
(`revealMatch`).

#### ✅ Scope-Modell `SearchScopeEx` + Grenzvalidierung

Getaggter Scope statt Flag-Kombination [Sol#6]: intern
`SearchScopeEx { Vault, Folder(String), OpenTabs }`. Flache Tauri-/HTTP-Args
(`scope: Option<String>`, `openTabs: bool`) werden in **genau einer** Funktion
(`build_scope_and_options`, geteilt zwischen Command und HTTP-Handler) validiert
und konvertiert (`to_scope_ex`). Client-Fehler: `openTabs=true` **und**
`scope!=null` → `ScopeConflict`; unbekannter `fileFilter` → `UnknownFileFilter`;
leere Custom-Liste bei `fileFilter="custom"` → `EmptyCustomExtensions`;
Regex+WholeWord → `RegexWholeWordConflict`; ungültiges Pattern →
`InvalidPattern`. Toter/relativer Ordner-Scope bleibt `RootNotFound`/
`InvalidScope` (Command-Pfad mit `scope:`-Präfix für den Frontend-Fallback).

#### ✅ Schmale öffentliche API [Sol#11]

Statt vier `_ex`-Helfern: `ExtendedSearchOptions { base: SearchOptions, regex:
bool, filter: FileFilter }`. `compile_regex`/Query-Validierung bleiben privat;
`run_search` delegiert an die gemeinsame private Candidate-/Content-Pipeline.
Öffentlich neu: `run_search_ex`, `run_search_buffers`, `validate_query_ex`
(roots-frei; Root-Validierung separat), `to_scope_ex`,
`parse_custom_extensions`, `FileFilter::from_raw`, Typen `BufferSource`/
`BufferDoc`. Neue Commands: `vault_search_start` additiv erweitert (`open_tabs`,
`regex`, `file_filter`, `custom_extensions` alle optional → altes Verhalten bei
Weglassen) und `vault_search_validate` (Dialog-Vorabprüfung vor Submit).

#### ✅ Neue Fehler-Keys (i18n, alle 9 Kataloge)

`errors.search.regexWholeWord`, `errors.search.invalidCustomExtension`
(`{detail}`), `errors.search.emptyCustomExtensions`,
`errors.search.unknownFileFilter` (`{detail}`), `errors.search.scopeConflict`.
Wiederverwendet: `errors.search.invalidQuery` (InvalidPattern),
`errors.search.queryTooShort`, `…rootNotFound`, `…invalidScope`. UI-Keys neu im
Namespace `search.dialog.*` (Titel/Query/Checkboxen/fileType/customExt/scope/
submit), `search.summary.*`, `search.results.{collapseAll,expandAll}.tooltip`,
`search.status.noOpenFiles` (OpenTabs-Leerfall), `search.status.hitStale`
(OpenTabs-Treffer, dessen Tab seit dem Snapshot geschlossen wurde) [Sol-Impl#1].

#### ✅ Persistenz (`panel_state.rs`)

Neue Felder: `search_regex: bool` (`#[serde(default)]`), `search_file_filter:
String` mit `#[serde(default = "default_search_file_filter")]` → `"allText"`
[Sol#12], `search_custom_extensions: String` (**roher** Feldtext, roh
persistiert, damit der Dialog das Feld 1:1 vorbefüllen kann). `set_search_options`
prüft beim Setzen **denselben Vertrag wie Suchstart/Submit** über
`FileFilter::from_raw(&file_filter, &custom_extensions)` [Sol-Impl#2]: Custom-
Rohtext wird nur bei aktivem `custom`-Filter geparst/abgelehnt (verbotene
Zeichen bzw. leere aktive Liste → Err); unbekannter Filterwert → Err; inaktiver
Custom-Rohtext bleibt unverändert roh gespeichert. Unbekannter/leerer
**gespeicherter** Filterwert fällt beim Lesen (`normalized_file_filter` in
`search_options_get`) auf `allText` zurück. **Scope bleibt flüchtig**
(Decision 8). Tests: Laden alter JSON ohne die neuen Felder, Roundtrip,
unbekannter gespeicherter Filterwert (roh geladen) + `normalized_file_filter`-
Fallback, `FileFilter::from_raw`-Persistenzvertrag.

#### ✅ Automation / E2E

`POST /search` additiv (`regex`, `fileFilter`, `customExtensions`, `openTabs`);
`SearchError` → HTTP 400 (inkl. `InvalidPattern`, früher 500). E2E 46 (API)
deckt Regex (Match/invalid/+WholeWord), FileFilter-Varianten (`.foobar` außer
TEXT_EXT, NUL-Skip), OpenTabs mit dirtem/geleertem Puffer + `openTabs+scope`-
Konflikt ab; **Pending-/Snapshot-Semantik** (`buffer_doc_for_tab`) sowie die
**Buffer-Global-Cap-/Probe-Parität** (`run_search_buffers`: echter Zusatztreffer
nach Cap → `truncated`; Zero-Width-only nach Cap → nicht) sind **Rust-Unit-Tests**
(Harness hat keinen Restart-Pfad) [Sol#10, Sol-Impl#4]. jsdom deckt zusätzlich
die Spinner-Endpfade (Start-Rejection, Cancel-vor-Adoption, Escape/Exit) und den
OpenTabs-Sprung bei geschlossenem Tab (kein Nachladen) ab. E2E 47 (UI, Dialog-first) deckt Dialog öffnen/
füllen/submitten, Cancel/Reopen (Draft verworfen), Folder-Draft via
Kontextmenü, Regex-View-Jump (Term = gematchter Text), Auto-Collapse (>10) +
Collapse-/Expand-All, Spinner (`vs-running` gesetzt→entfernt) und dirty-Tab-
Sprung ohne Save-Prompt ab. Neuer Screenshot `47_search_dialog`.

### ✅ Etappe S5 — UX-Nachschliff nach User-Test (2026-07-16)

Fünf Feinschliff-Punkte, rein Frontend + Persistenz (Suchkern `search.rs`
unverändert):

1. **Suche beenden**: ×-Button in der Summary-Zeile (`#vault-search-exit`,
   Geschwister des Summary-Buttons in `.vault-search-bar`, nur im Suchmodus
   sichtbar) ruft `exitSearch()`. Zusätzlich ein Escape-Handler auf
   `#vault-region` (`onRegionKeydown`), der bei aktiver `vault-searching`-Klasse
   beendet — greift auch mit Fokus auf Summary/Exit/Ergebnis-Header. Guards:
   kein Feuern bei offenem Dialog (eigenes Escape) und nur im Suchmodus; die
   Ergebnisliste behält ihren eigenen Escape-Handler (`onListKeydown`) und
   entfernt die Klasse zuerst, sodass der Region-Handler nicht doppelt
   ausführt. Die Find-Bar behandelt Escape nur am eigenen Input → keine
   Interferenz. Liegt der Fokus beim Beenden im gleich ausgeblendeten Exit-/
   Ergebnisbereich, verschiebt `exitSearch()` ihn auf den weiterhin sichtbaren
   Summary-Button (kein Fokus auf display:none) [Sol-S5#2].
2. **Collapse-/Expand-All-Icons**: statt `−`/`+` zwei gestapelte
   Doppel-Chevron-SVGs (`currentColor`, Muster `FOLDER_SEARCH_SVG`),
   aria-Labels/Tooltips unverändert.
3. **Pfadanzeige-Toggle** (`#vault-search-paths`, `aria-pressed`): gedimmter
   `<span class="vs-fpath">` mit dem Verzeichnisanteil hinter dem Dateinamen.
   Relativierung: Folder-Scope gegen `scopePath`, Vault-Scope gegen die längste
   passende Pin-Wurzel (`pinRoots()` liest die Top-Level-`li.node[data-path]`
   der Pinned-Section aus `#vault-tree`), OpenTabs/kein Treffer → voller Pfad.
   CSS-Kürzung linksseitig (`direction:rtl`-Trick) → Pfad-Ende bleibt sichtbar.
   **Durch S7 ersetzt**: die inline hinter dem Dateinamen gerenderte Pfad-
   Zeichenkette (nur Verzeichnisanteil relativ zur Wurzel, ohne Wurzelnamen)
   ist einem zweizeiligen Kopf gewichen (Pin-Name + Rest, siehe S7); der
   Toggle selbst blendet weiterhin die Pfadzeile ein/aus.
4. **Sortierung** (`#vault-search-sort`, ein durchcyclender Button
   none→name→path): locale-aware + numerisch (`Intl.Collator`, `numeric:true`),
   Dateiname sekundär nach Pfad (deterministisch bei gleichnamigen Dateien).
   Auch beim Streaming nach jedem `applyHits` stabil einsortiert; der aktive
   Treffer bleibt über (Pfad, Hit-Index) erhalten (`activeAnchor`/
   `restoreActive`), das pfadbasierte `collapsed`-Set bleibt korrekt.
   Die Fundreihenfolge wird als frontend-vergebene Ankunftssequenz
   (`FileResult.arrival`, Reset pro Lauf) festgehalten; `none` sortiert
   explizit danach — der Rückweg aus name/path stellt sie damit wieder her,
   auch für Streaming-Nachzügler [Sol-S5#1].
5. **Dauer-Anzeige**: `search.status.done` trägt statt `{ms} ms` einen
   vorformatierten `{duration}`-Platzhalter (alle 9 Kataloge + keys.json,
   Platzhalter-Parität). `formatDuration`: unter 1 s `<n> ms`, ab 1 s Sekunden
   mit einer Nachkommastelle in Locale-Schreibweise (z. B. „30,1 s"); Einheiten
   als SI-Symbole (Muster `fmtBytes`).

Persistenz (`panel_state.rs` / `set_search_options` / `search_options_get`):
neue Felder `search_show_paths: bool` (`#[serde(default)]`) und `search_sort:
String` (`#[serde(default = "default_search_sort")]` → `"none"`; unbekannt →
`none` via `normalized_sort` beim Lesen). `set_search_options` (Tauri) nimmt
`show_paths`/`sort` optional (fehlend → bisheriger Wert). Frontend persistiert
über den gemeinsamen `persistSearchOptions()` (Dialog-Submit **und** die beiden
Header-Toggles). Neue i18n-Keys: `search.exit.{ariaLabel,tooltip}`,
`search.paths.toggle.{ariaLabel,tooltip}`, `search.sort.ariaLabel`,
`search.sort.mode.{none,name,path}`, `search.sort.tooltip`. Tests: vitest
(×/Escape-Exit, Sortierung inkl. Streaming + README-Duplikate, Pfad-Toggle,
Dauer-Format) + Rust-Unit (`panel_state`-Roundtrip, `normalized_sort`).

### ✅ Etappe S6 — Paralleler Such-Walk (2026-07-16)

Motivation: vault-weite Suche über mehrere große Pins dauerte beim User ~30 s;
der Kern lief strikt single-threaded.

- **Neue Funktion `search::run_search_parallel(roots, query, o, cancel, on_file)`**
  mit **identischem Vertrag** wie `run_search_ex` (Streaming über `on_file`,
  Caps, Cancel, `SearchStats`-Rückgabe). `run_search`/`run_search_ex`/
  `run_search_buffers` und die sequenzielle Pipeline bleiben unverändert; die
  31 additiv-only `mod tests` behalten ihre deterministische Reihenfolge.
- **Architektur**: pro Root-Ordner ein `WalkBuilder::build_parallel()` (gleiche
  Filterkonfiguration wie sequenziell — hidden/gitignore-Defaults bzw.
  `includeHidden`-Opt-in, ignore-Default-Threadzahl). Ein Producer-Thread
  (`std::thread::scope`) treibt die Walks; die Worker-Visitoren machen Filter +
  `worker_read_disk` (Content-Gate) + `build_file_hits` selbst und senden
  fertige `WalkEvent`s (`NoHit`/`Matched`/`SkippedLarge`/`ProbeHit`) über
  `std::sync::mpsc`. Der aufrufende Thread ist **Consumer** und einziger
  `on_file`-Aufrufer; er dedupliziert (`seen`, normalisierte Pfade über beide
  Phasen), zählt `files_scanned`/`skipped_large`/`hits` exakt und erzwingt die
  Caps (per-Datei-50 klemmen die Worker, den globalen 500er der Consumer —
  Cap-/Probe-/`truncated`-Semantik gespiegelt aus `process_content`). Der
  `&mut dyn FnMut`-Vertrag wandert nie in einen Worker-Thread. Content-Gate
  geteilt via `gate_bytes` (statistikfrei) unter `inspect_content` (sequenziell)
  und `worker_read_disk` (parallel); die Einzeldatei-Phase (`scan_pinned_files`)
  ist aus `run_over_roots` ausgelagert und wird von beiden Läufen geteilt.
- **Overlap-Collapse vor dem Walk** (Sol-Rev S6#2): `walk_dirs_parallel` klappt
  überlappende Dir-Roots über `collapse_overlapping_dirs` ein (Kind-Root entfällt
  unter einem Eltern-Root; separator-grenzen-sicher via `PathBuf::starts_with`,
  gemeinsam mit `resolve_scope`). Damit trifft jede Datei höchstens einen Walk und
  der worker-seitige Näherungszähler zählt sie nie doppelt gegen den Deckel — der
  Consumer-`seen` bleibt nur noch Netz für die geteilte Pinned-Phase.
- **Early-Stop/Probe**: globaler `AtomicUsize`-Hit-Zähler als Näherung — Worker
  addieren ihre (gekappten) Treffer und schalten ab Erreichen des Deckels in den
  Probe-Modus (`probe_str`, Zero-Width zählt nie); die exakte Buchführung bleibt
  beim Consumer. `cancel`/interner `stop_flag` → `WalkState::Quit`; unbounded
  Channel, damit Worker beim Consumer-Stop nie blockieren. Der Consumer prüft
  `cancel` **vor jedem** gepufferten Event und kehrt bei Abbruch sofort mit
  „stopped" zurück (kein Anwenden nachlaufender Events, kein weiterer `on_file`,
  keine Einzeldatei-Nachlaufphase) — Sol-Rev S6#1.
- **Reihenfolge = Completion-Order (nichtdeterministisch)** — bewusste
  Entscheidung: das Frontend behandelt Ankunft als „Fundreihenfolge" (S5-`none`-
  Sortiermodus), Sortiermodi Name/Pfad existieren; **keine** End-Sortierung,
  weil sie das Streaming der Treffer zunichtemachen würde. Konsequenz: bei
  aktiver Truncation kann der parallele Lauf wegen der nur näherungsweise
  gekoppelten Deckel-Erkennung **bis zu** (ggf. minimal weniger als) 500 Treffer
  melden; `truncated` wird genau dann gesetzt, wenn real Treffer weggefallen
  sind. `SearchStats` (Summen), Treffer-Menge pro Datei und die Hit-Reihenfolge
  **innerhalb** einer Datei bleiben deterministisch.
- **Aufrufer**: `vault_search_start` (Vault/Folder-Scope) und `POST /search`
  nutzen `run_search_parallel`; OpenTabs-Puffer laufen unverändert über
  `run_search_buffers`.
- **Tests**: additive `mod tests`-Fälle (parallel-vs-sequenziell-Parität auf
  reichem Baum ordnungs-insensitiv, FileFilter parallel, Dedup überlappender
  Roots, Cap/`truncated`-Invarianten, Cancel vor Start, leerer Baum) plus zwei
  Sol-Rev-Regressionstests: Mid-Run-Cancel (erster `on_file` setzt das Flag →
  exakt kein weiterer Callback, S6#1) und Kind→Eltern-Overlap nahe am Cap mit
  einer nur im Eltern-Root liegenden Trefferdatei, Ergebnismenge+`truncated`
  gegen den sequenziellen Referenzlauf, ≥20× als Stress (S6#2). **Funktionale**
  E2E-46/47-Asserts sind ordnungs-insensitiv (46 `sorted(...)`, 47 gruppenweise
  per Dateiname); der **Visual-Screenshot** `47_search_results` ist es jedoch
  nicht — seit S6 ist die Completion-Order (Sort `none`) nichtdeterministisch,
  deshalb schaltet das Szenario vor der Aufnahme deterministisch auf Sort `name`
  (alphabetisch: inner/more/notes) und wartet auf Spinner-Ende (S6#3; Baseline
  unter Linux neu zu erzeugen). Lokale Verifikation über einen temporären
  Integrationstest (`cargo test --lib` startet auf der Windows-Dev-Maschine
  nicht, STATUS_ENTRYPOINT_NOT_FOUND); die permanenten Unit-Tests laufen in der
  Linux-CI.

### ✅ Etappe S7 — Pfad-Darstellung zweizeilig (2026-07-16)

Rein Frontend + ein neues App-Setting (Suchkern `search.rs` unverändert).

1. **Zweizeilige Treffergruppen-Köpfe** (`vault/search.ts::renderResults`):
   der Kopf (`.vs-group-head`, `align-items:center`) enthält Caret, einen
   gestapelten Textblock (`.vs-main`, flex-column: Zeile 1 `.vs-fname`, Zeile 2
   `.vs-fpath`) und den Zähler-Badge (`.vs-count`, dadurch vertikal über beide
   Zeilen zentriert). Die Pfadzeile ist kein Inline-Span mehr. `displayPath()`
   liefert den Verzeichnisanteil (Dateiname steht separat in Zeile 1, deshalb
   nie mitgeführt): im Modus `relative` **Pin-/Scope-Wurzel-Basisname + relativer
   Rest** (Datei direkt in der Wurzel → nur der Basisname, nie leer), ohne
   Root-Match (OpenTabs/kein Pin) den vollen Verzeichnispfad. Der absolute
   Dateipfad bleibt im `title`-Tooltip des Kopfes. Linksseitige Kürzung
   (`direction:rtl`) unverändert. Der S5-Pfad-Toggle blendet die Pfadzeile weiter
   ein/aus.
2. **Sortierschlüssel = angezeigte Pfad-Zeichenkette**: `sortFiles()` nutzt für
   `sort=path` (und als Sekundärschlüssel bei `sort=name`) `displayPath(path)`
   statt des absoluten Pfads — die Pfadsortierung ist damit visuell
   nachvollziehbar und divergiert bei mehreren Pins bewusst vom absoluten Pfad.
   Memoisiert pro Sortierdurchlauf (eine `displayPath`/`pinRoots`-Auswertung je
   Datei).
3. **Emphasis-Swap bei `sort=path`**: Modifier-Klasse `vs-sort-path` auf
   `#vault-search-list` (Toggle in `renderResults`). CSS tauscht per `order` die
   Zeilenreihenfolge (Pfad nach oben) UND die Betonung (Pfad normal, Dateiname
   gedimmt); bei none/name das heutige Muster. Kein DOM-Umbau pro Modus.
4. **Setting `searchPathDisplay`** (`relative` | `absolute`, Default `relative`,
   unbekannt → `relative`): echtes App-Setting in `settings.rs`
   (`SearchPathDisplay`-Enum, `#[serde(default)]`, Patch-Feld + `apply_patch`),
   Settings-UI-Dropdown im neuen Bereich „Suche" (`#settings-search-path-display`,
   `settings-dialog.ts`). i18n-Keys `settings.search.sectionTitle` +
   `settings.search.pathDisplay.{label,optionRelative,optionAbsolute,hint}` in
   allen 9 Katalogen + `context/keys.json`. `search.ts` liest den Wert beim Boot
   über `settings_get` und reagiert live auf `settings:changed`
   (`onSettingsChanged` → `setPathDisplay`, re-sort + re-render mit Anker-Erhalt).
   `absolute` zeigt den vollen Verzeichnispfad; der Sortierschlüssel bleibt in
   beiden Modi die angezeigte Zeichenkette. Automation `GET/POST /settings` trägt
   das Feld generisch mit (SettingsData/-Patch-Serde), keine Extra-Route.
5. **Tests**: vitest (Pin-Name-Pfadzeile, Datei in Pin-Wurzel → nur Pin-Name,
   sort=path folgt Anzeige-String mit absolut-divergierendem Zwei-Pin-Fixture,
   Emphasis-Klasse nur bei sort=path, Toggle blendet aus, `absolute` ändert
   Anzeige+Sortierung, `settings:changed`-Livewechsel) + Rust-Unit
   (`search_path_display`-Roundtrip/Unknown-Fallback/camelCase-Patch). E2E 47
   unberührt (referenziert `.vs-fname`, nicht `.vs-fpath`).

## Risiken / bewusste Entscheidungen

- **Kein Index in V1** — jede Suche ist ein frischer Walk. Für
  realistische Vaults (SSD, tausende MD-Dateien) im 100-ms-Bereich;
  Caps + Cancel + Debounce fangen den Rest. Ein persistenter Index
  (tantivy o. ä.) wäre massiver Overkill und ein Cache-Invalidierungs-
  Problem (externe Änderungen). Paralleler Walk (`build_parallel`) ist
  seit S6 umgesetzt (`run_search_parallel`).
- **Hidden/gitignorierte Files werden standardmäßig übersprungen**,
  obwohl der Vault-Baum Dotfiles anzeigt. Opt-in-Toggle `includeHidden`
  (Dialog + Persistenz + Automation) schaltet `standard_filters` ab;
  **`.git`-Verzeichnisse bleiben auch dann ausgeschlossen** (bewusst,
  kein Object-Store-Rauschen).
- **Dateien ohne Endung** (LICENSE, Makefile) klassifiziert
  `file_kind` als Binary → nicht durchsucht. Konsistent mit dem
  restlichen App-Verhalten; kein Sonderfall in V1.
- **View-Mode-Sprung ist Best-Effort** (Entscheidung 7): Quelltext-
  Index vs. gerenderte Reihenfolge können divergieren; Edit/Split ist
  präzise. Akzeptiert, weil kein Mode-Wechsel erzwungen werden soll.
- **Recents nicht im Scope** — wer eine Nicht-Vault-Datei durchsuchen
  will, hat Strg+F im Dokument.
- **Lossy-UTF-8 bei Nicht-UTF-8-Dateien**: Treffer-Spalten können in
  exotischen Encodings vom Editor-Inhalt abweichen; Fallback ist der
  Find-Bar-Sprung. Kein Encoding-Roundtrip für die Suche.
- **Ergebnis-Payload über Events statt Command-Return** folgt der
  IPC-Konvention; die Automation-Route bündelt synchron (kein
  SSE-Nachbau in Python-Tests nötig).

## Verifikation pro Etappe

Aus `src-tauri/`: `cargo test`, `cargo clippy --all-targets --
-D warnings`, `cargo fmt --check`; bei TS-Änderungen `cd web && npm
run build && npm test` + Bundles einchecken; `bash scripts/run-e2e.sh`
komplett. Pro grüner Etappe: Commit auf `main` + Checkboxen hier
abhaken.

## Vorgehen / Delegation

Festgelegt (2026-07-12): **Implementierung durch Opus 4.8**
(Claude-Subagent in sichtbarem herdr-Pane), pro Etappe ein Lauf gegen
diese Spec. **Kreuz-Review wie gewohnt parallel durch codex
(gpt-5.6-sol, Effort high) und agy**; Befunde konsolidiert als EIN
Fix-Paket zurück in die offene Implementierer-Session. Endabnahme
durch den Orchestrator: eigener Diff-Review gegen die Spec + Gates
nachfahren. **S1 zusätzlich test-first** (S1a/S1b oben): Testdatei
wird vor der Implementierung geschrieben und vom Orchestrator
abgenommen; der Implementierungs-Lauf darf Tests nicht anpassen.
