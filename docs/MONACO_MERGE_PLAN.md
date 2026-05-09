# Monaco-Merge per Cherry-Pick

> **Live-Plan für die laufende Migration.** Stand und nächster Schritt
> stehen unter [Resume-Marker](#resume-marker). Diese Datei wird nach
> Abschluss der Migration gelöscht (siehe Schritt 9).

## Context

CodeMirror-Pilot mit lang-json war eine Sackgasse — `setLanguage`
schaltete die Sprache nicht effektiv um, Markdown-Parser leakte in alle
anderen Datei-Typen (visuell verifiziert mit `test-docs/syntax/*`).
Parallel existiert auf `origin/monaco` eine vollständige Migration zu
Monaco; die liefert sauberes Multi-Lang-Highlighting out-of-the-box,
+2,5 MB Binary, keine spürbare Startup-Verzögerung.

Der Monaco-Branch zweigt aber von `364ea91` ab und hat **fünf
main-Commits NICHT**: Terminal-Kontextmenü, toolbar/toc-md-only-Logik,
History per-Entry (mode/scroll/cursor), Docs-Update, Test-Fixtures. Die
müssen einzeln auf den Monaco-Branch gepickt werden, bevor wir zurück
nach main mergen — sonst gehen die Features verloren.

Backup: Branch `pre-monaco` (= `bd6c122`) existiert lokal und auf
`origin`. Notausgang ist `git reset --hard origin/pre-monaco`.

## Strategie

Cherry-Pick statt Merge: 5 Commits einzeln auf `monaco-merge`-Branch
applyen, jeweils mit `cargo build`/`test` + visuellem Quick-Check.
Editor-API-Erweiterungen aus dem History-Commit (`setSelection`,
`getScroll`, `setScroll`) auf Monaco-APIs portieren.

## Resume-Marker

**Aktueller Stand:** Schritt 0 abgeschlossen — Plan ins Repo kopiert,
CLAUDE.md mit Migration-Banner versehen.

**Nächster Schritt:** Schritt 1 — Working-Branch `monaco-merge` von
`origin/monaco` ausgelöst auschecken und Sauber-Build verifizieren.

## Schrittliste

### 0. Setup (vor erstem Pick) ✅
- [x] Plan nach `docs/MONACO_MERGE_PLAN.md` kopiert
- [x] CLAUDE.md mit Migrations-Banner ganz oben
- [x] Beides committen + pushen

### 1. Working-Branch
- [ ] `git checkout -b monaco-merge origin/monaco`
- [ ] `cd src-tauri/web && npm install` (Monaco-Deps laden)
- [ ] `cd src-tauri && cargo build && cargo test` — sauberer Ausgangspunkt

### 2. Cherry-Pick `00b6ba3` — Terminal-Kontextmenü
- [ ] `git cherry-pick 00b6ba3`
- Erwartete Konflikte:
  - `commands/app.rs`: keiner (Monaco rührt das nicht an)
  - `lib.rs`: Mini-Konflikt am invoke_handler
  - `dist/index.html`: kleiner Konflikt im Context-Menu-Bereich
- [ ] Build/Test/visueller Check (Vault → Rechtsklick → „Terminal hier öffnen")
- [ ] Resume-Marker hier updaten

### 3. Cherry-Pick `572494c` — toolbar/toc Markdown-only
- [ ] `git cherry-pick 572494c`
- Erwartete Konflikte:
  - `state.rs`: leicht — `kind` in document:loaded-Payload
  - `dist/index.html`: mittel — body.kind-* CSS, md-only-Toolbar-Klassen,
    `applyDocKind`-Funktion, TOC-Hide-Regel, Auto-Switch-Logik in
    `openDocument`. Monaco-Mount-Bereich orthogonal — sollte sauber
    danebenpassen
- [ ] Build/Test/Check (z. B. `.json` öffnen → keine MD-Toolbar, kein TOC)
- [ ] Resume-Marker updaten

### 4. Cherry-Pick `61e5a4b` — History per-Entry (DICKER BROCKEN)
- [ ] `git cherry-pick 61e5a4b`
- Erwartete Konflikte:
  - **Backend** (`navigation.rs`, `commands/nav.rs`, `commands/app.rs`,
    `commands/shell.rs`, `lib.rs`): konfliktfrei applybar — Monaco
    rührt Backend nicht an
  - **`web/editor.ts`**: KOMPLETTER KONFLIKT. Lösung:
    - main's editor.ts-Änderungen verwerfen (sind für CodeMirror)
    - In Monacos editor.ts NEU IMPLEMENTIEREN und exportieren:
      - `setSelection(start, length)` → `editor.setSelection(new Range(...))`,
        Position-Konvertierung via `model.getPositionAt(offset)` und
        `model.getPositionAt(offset+length)`
      - `getScroll()` → `editor.getScrollTop()`
      - `setScroll(y)` → `editor.setScrollTop(Math.max(0, y))`
    - Neuer Scroll-Event analog editor.ts main:
      `editor.onDidScrollChange(...)` → RAF-debounced
      `post({ type: 'editorScroll', y: editor.getScrollTop() })`
  - **`dist/editor.bundle.js`**: binär. „theirs" (Monaco-Version) nehmen,
    dann nach editor.ts-Anpassung mit `npm run build` neu erzeugen
  - **`dist/index.html`**: navigation:changed-Handler mit Restore-Sequenz
    (mode + view-scroll + editor-scroll + editor-cursor) und
    Editor-Capture-Hooks. Der Restore-Pfad wartet auf Editor-Mount —
    in Monaco ist Mount async, also evtl. setTimeout statt RAF
- [ ] Build/Test/Check: lange MD-Datei in Edit, scrollen, weg, zurück →
      Cursor + Scroll restored. Mode-Restore: `.json` → `.md` → Back →
      JSON wieder in Edit-Mode
- [ ] Resume-Marker updaten

### 5. Cherry-Pick `418a35a` — Docs-Update
- [ ] `git cherry-pick 418a35a`
- Erwartete Konflikte:
  - `CLAUDE.md`: mittel — Monaco hat ggf. eigene Sektion. Beides
    zusammenführen, Migration-Banner aus Schritt 0 erstmal stehen lassen
  - `README.md`: mittel — Feature-Liste mergen
  - `TODO.md`: keiner
- [ ] Build/Test (sollte trivial sein)
- [ ] Resume-Marker updaten

### 6. Cherry-Pick `bd6c122` — Test-Fixtures
- [ ] `git cherry-pick bd6c122`
- Erwartete Konflikte: keine (reine Adds in `test-docs/syntax/`)
- [ ] Resume-Marker updaten

### 7. Vollverifikation
- [ ] `cargo build --release && cargo test`
- [ ] Visueller Audit der `test-docs/syntax/`-Matrix in beiden Themes:
      JSON, TXT, HTML, XML, SQL, YAML, plus eine MD-Datei
- [ ] Feature-Smoketest:
      - Terminal-Kontextmenü öffnet Terminal im richtigen Verzeichnis
      - History-Back stellt Mode/Scroll/Cursor wieder her
      - TOC nur bei MD sichtbar, MD-Toolbar nur bei MD
- [ ] `git push origin monaco-merge`

### 8. Merge nach main
- [ ] `git checkout main`
- [ ] `git merge --no-ff monaco-merge -m "merge: Monaco-Editor-Migration + main-Features"`
- [ ] `git push origin main`

### 9. Aufräumen
- [ ] CLAUDE.md: Migrations-Banner aus Schritt 0 entfernen
- [ ] `docs/MONACO_MERGE_PLAN.md` löschen (Migration abgeschlossen)
- [ ] Beides committen + pushen
- [ ] Branches löschen: `git branch -d monaco-merge`,
      `git push origin --delete monaco-merge`
      (`monaco`-Branch zur Sicherheit lassen, später aufräumen;
      `pre-monaco` als Backup behalten bis Migration produktiv läuft)

## Verifikations-Checkliste (Final)

| Feature                              | Wo testen                                         |
|--------------------------------------|---------------------------------------------------|
| Monaco JSON-Highlight (Vergleich CM) | `test-docs/syntax/sample.json`                    |
| Monaco YAML, TXT plain, etc.         | `test-docs/syntax/sample.{yaml,txt,html,xml,sql}` |
| Terminal-Kontextmenü                 | Vault → Rechtsklick auf Ordner                    |
| History: Mode-Restore                | `.md` → `.json` → Back → JSON in Edit-Mode        |
| History: Scroll-Restore (Edit)       | Lange MD scrollen, weg, zurück                    |
| History: Scroll-Restore (View)       | Lange MD im View scrollen, weg, zurück            |
| History: Cursor-Restore              | Cursor in Mitte, weg, zurück                      |
| TOC nur bei MD                       | `.json` öffnen → TOC ausgeblendet                 |
| MD-Toolbar nur bei MD                | `.json` Edit-Mode → keine Bold/Italic-Buttons     |
| Test-Fixtures vorhanden              | `ls test-docs/syntax/`                            |
| Cargo-Tests grün                     | `cargo test`                                      |
| Release-Bundle baut                  | `cargo tauri build --bundles deb`                 |
