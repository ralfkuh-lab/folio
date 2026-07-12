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
- **Overlap-Dedup**: gepinnter Ordner + gepinnter Unterordner/Datei
  darin → jede Datei wird genau einmal durchsucht (Dedup über
  normalisierte absolute Pfade, Forward-Slashes wie überall).
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
   & Co. fallen damit automatisch raus). `sort_by_file_name` für
   deterministische Reihenfolge (E2E-Baselines), **single-threaded
   Walk in V1** — paralleler Walk ist ein benannter Folgepunkt, kein
   V1-Ziel.
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
9. **Persistenz**: die Options-Toggles (Aa/W) wandern nach
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

## Risiken / bewusste Entscheidungen

- **Kein Index in V1** — jede Suche ist ein frischer Walk. Für
  realistische Vaults (SSD, tausende MD-Dateien) im 100-ms-Bereich;
  Caps + Cancel + Debounce fangen den Rest. Ein persistenter Index
  (tantivy o. ä.) wäre massiver Overkill und ein Cache-Invalidierungs-
  Problem (externe Änderungen). Folgepunkt: paralleler Walk
  (`build_parallel`), falls große Pins spürbar werden.
- **Hidden Files werden übersprungen**, obwohl der Vault-Baum
  Dotfiles anzeigt — bewusste Abweichung (`.git`-Traversal wäre
  sonst Pflicht-Sonderfall). Falls es stört: später Opt-in-Toggle.
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
