# Spec: Command Palette (Strg+P)

Status: beschlossen 2026-07-22 (Overnight-Umsetzung, Branch
`feat/command-palette`). Ursprung: `docs/feature-ideen.md` →
„Command Palette" `[M]` (codex, grok, ⭐).

## Ziel

Ein zentrales Schnellzugriff-Overlay (VS-Code-Quick-Open-Muster):
Strg+P öffnet ein Eingabefeld mittig oben; Tippen filtert unscharf.
Drei Modi über Präfix im selben Feld:

| Präfix | Quelle | Aktion bei Enter |
|--------|--------|------------------|
| *(keins)* | Dateien: offene Tabs, Recents, Vault-Dateien (Pins rekursiv) | öffnen im aktiven Tab (wie Vault-Klick); **Strg+Enter / Strg+Klick → neuer Tab** (`tab_open`) |
| `>` | App-Befehle (kuratierte Registry über `menu_dispatch`) | Befehl ausführen |
| `#` | Überschriften des aktiven Dokuments (TOC) | zum Anker springen (bestehende TOC-Navigation) |

Esc schließt (erst Auswahl/Feld, dann Overlay — einstufig reicht: Esc
schließt immer das Overlay). Pfeiltasten navigieren, Maus-Klick wählt,
Strg+Klick öffnet Datei im neuen Tab. Kein Persistieren von Zustand.

## UI

- Overlay `#cmd-palette` in `dist/index.html` (Vollflächen-Backdrop
  `.cmd-palette-backdrop` mit zentriertem Panel oben, max-width ~560px;
  Klick auf Backdrop schließt). Body-Klasse `palette-open` (schließt
  sich mit anderen Modals nicht aus — Palette öffnet nicht, wenn ein
  echtes Modal offen ist; Heuristik: `#unsaved-dialog`/Dialoge sichtbar).
- Input `#cmd-palette-input` + Liste `#cmd-palette-list`
  (`role="listbox"`, aktive Zeile `aria-selected`), Zeile: Icon/Typ-
  Badge, Label mit **Match-Highlight** (`.cp-hit`, Muster `vf-hit` aus
  dem Vault-Filter — Text-Node-sicher), rechts gedimmt der Kontext
  (relativer Pfad bzw. Shortcut des Befehls, falls vorhanden).
- Max. ~50 gerenderte Zeilen (darunter Hinweiszeile „weiter tippen…" —
  i18n); leere Treffer → „Keine Treffer"-Zeile.
- CSS in bestehende Overlay-Styles (`styles/overlays.css`), Dark-Variante.

## Trigger

- **Strg+P** über den bestehenden DOM-Capture-Handler-Block in
  `ui/toolbar-actions.ts` (capture:true, wie Strg+S/W/…; auch bei
  Monaco-Fokus). Kein natives Menü-Item in V1 (Accelerator-Baustelle).
- Export `window.__folioOpenPalette(prefill?: string)` als Test-/
  Automation-Hook (Muster `__folioVaultFilterReset`) — synthetische
  Strg+P-Events sind unter Xvfb fragil (e2e-headless-caveats).

## Fuzzy-Matcher (pur, eigenes Modul)

`web/app/util/fuzzy.ts`, DOM-frei, vitest-abgedeckt:

- Subsequence-Match, case-insensitive (`toLowerCase`, kein Case-Folding
  — Konvention wie Vault-Filter).
- Score: Bonus für zusammenhängende Folgen, Wortanfänge
  (`/[ _\-./]/`-Grenzen) und Match am Namensanfang; Malus für Pfadtiefe
  und späten Match-Start. Bei Dateien matcht die Query gegen
  `name` UND `relativePath` (bestes Ergebnis zählt).
- Rückgabe: Score + Match-Positionen (fürs Highlight).
- Sortierung: Score desc, dann Quelle (offene Tabs > Recents >
  Vault-Walk), dann Name.

## Quellen

### Dateien (Default-Modus)

- **Frontend-seitig sofort**: offene Tabs (aus `tabs:changed`-Snapshot)
  und Recents (bereits im DOM/Workspace — über neuen leichten Command
  oder mitgeliefert, Implementierer entscheidet).
- **Backend-Command `palette_files()`** (neu, `commands/vault_cmd.rs`
  oder eigenes Modul): walkt beim **Öffnen der Palette** einmal alle
  Pin-Wurzeln rekursiv (read_dir, hidden sichtbar, `.git` skip,
  Link-Dirs nicht betreten — Konventionen wie `dir_contains_markdown`),
  liefert `{ files: [{path, name, relative}], truncated }` mit
  **Deckel 20 000 Einträge** (truncated → Hinweiszeile, kein stilles
  Kappen). Kein Cache über Öffnungen hinweg (frisch wie der Baum).
  `relative` = Pfad relativ zur Pin-Wurzel (POSIX-Slashes).
- Dedup: offene Tabs/Recents, die auch im Walk vorkommen, erscheinen
  EINMAL (Priorität: Tab > Recent > Walk; Badge zeigt die Quelle).

### Befehle (`>`)

Kuratierte Registry im Frontend (`ui/palette-commands.ts`): Einträge
`{ id, labelKey, menuAction, enabled() }` — Ausführung ausschließlich
über den bestehenden `menu_dispatch`-Command (gleicher Pfad wie Menü/
Automation). Startumfang: Datei öffnen/speichern/Speichern unter,
Mode view/edit/split (nur wo erlaubt — enabled() prüft die bekannten
Body-Klassen wie `kind-markdown`, analog CSS-Gating), Export HTML/PDF,
Find öffnen, Einstellungen, Theme hell/dunkel, Tab schließen /
zuletzt geschlossenen wiederherstellen, Vault-Suche öffnen. Disabled-
Einträge werden ausgeblendet (nicht gegraut) — die Palette zeigt nur
Ausführbares.

> **Revision (Review-Fix FXP5):** Kein Theme-„System"-Eintrag in V1 —
> das Backend (`theme_set`) kennt nur `light`/`dark`/`toggle`.

### Überschriften (`#`)

Quelle: der bereits gerenderte TOC des aktiven Dokuments (DOM
`#toc-list` bzw. die Datenquelle dahinter — Implementierer nimmt den
vorhandenen Weg mit dem wenigsten neuen Code). Enter springt über den
bestehenden Anchor-Klick-Pfad. Nur bei `kind-markdown` verfügbar;
sonst zeigt `#` eine Hinweiszeile. Sortierung: **Dokumentreihenfolge**
bei Score-Gleichstand (stabiler Sort ohne Label-Tiebreaker) — der
alphabetische Tiebreaker der anderen Modi wäre für ein TOC falsch
(Fix 2026-07-23, jsdom- + E2E-Assert).

## Verhalten / Kanten

- Öffnen bei bereits offener Palette: Strg+P togglet zu (schließt).
- Query bleibt NICHT erhalten (jedes Öffnen startet leer).
- Enter auf Datei: `openDocument`-Pfad (ersetzt aktiven Tab; dirty-
  Handling wie Vault-Klick heute). Strg+Enter/Strg+Klick: `tab_open`
  (dedupe/aktivieren wie überall).
- Fokus: beim Öffnen ins Input; beim Schließen zurück zum vorherigen
  Fokus-Element (best effort, `document.activeElement` merken).
- Palette-Rendering debounced NICHT nötig (reine In-Memory-Filterung);
  der `palette_files`-Roundtrip läuft einmal beim Öffnen asynchron —
  bis dahin filtern Tabs/Recents, Walk-Ergebnisse werden nachgemischt
  (kein Flackern: Liste stabil neu sortieren, aktive Auswahl per Pfad
  beibehalten falls noch vorhanden).

## Automation / E2E

- `POST /palette` (dünn): `{ action: "open"|"close", prefill? }` über
  das Event-Muster der bestehenden UI-Endpunkte ODER schlicht via
  bestehendem `/eval` + `__folioOpenPalette` — Implementierer wählt den
  kleineren Weg, dokumentiert ihn im Automation-Contract-Doc NICHT
  (V1: Test-Hook reicht, kein stabiler Vertrag).
- E2E `51_command_palette.py`: Fixture-Ordner pinnen; Hook öffnet
  Palette; Tippen per /eval (Wert + input-Event); Asserts: Datei-Treffer
  mit Highlight, Enter öffnet im aktiven Tab (GET /state Pfadwechsel),
  Strg+Enter-Variante über zweiten Treffer → `GET /tabs` zeigt neuen
  Tab; `>`-Modus führt „Mode: Edit" aus (body.edit-mode via /dom);
  `#`-Modus springt zu Überschrift (scroll/anchor-Assert wie TOC-
  Szenario); Esc schließt. Screenshots: offene Palette mit Treffern,
  `>`-Modus. Aufräumen im finally (unpin, tabs_close_all,
  Temp-Verzeichnis).
- Kanonischer Reset (`lib/reset.py`): Palette schließen (Hook), falls
  offen.

## Etappen

- **P1**: Overlay + Fuzzy-Modul (mit vitest) + Quellen Tabs/Commands
  (`>`), Strg+P-Capture, Esc/Fokus-Verhalten. Gates grün.
- **P2**: `palette_files`-Backend (Rust-Tests: Walk-Deckel, .git/Link-
  Skip, relative Pfade) + Datei-Modus inkl. Dedup/Nachmischen +
  `#`-Überschriften. Gates grün.
- **P3**: i18n-Vervollständigung (9 Kataloge + Kontexte), Feinschliff
  (Highlight, Badges, truncated-Hinweis), E2E 51 + reset.py, Doku
  (CLAUDE.md-Eintrag). Gates + E2E.

Kreuz-Review (codex+kimi) über den Gesamt-Diff nach P3, danach
Orchestrator-Endabnahme mit zwei E2E-Voll-Läufen.

## Abnahme-Gates

cargo test (voll) · clippy -D warnings · fmt --check · npm run build ·
npx vitest run · bash scripts/run-e2e.sh (2× voll).
