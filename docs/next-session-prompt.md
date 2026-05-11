# Starter-Prompt für die nächste Session

Direkt in den Chat reinpasten:

---

Wir setzen Phase 5 aus `docs/refactoring-plan.md` fort. Stand: Bugfixes aus
dem zweiten Review sind durch (Commit unmittelbar vor Phase-5-Start),
Phase-5-Plan ist geschrieben, noch nichts davon umgesetzt.

Lies bitte zuerst:

1. `CLAUDE.md` (Projekt-Konventionen + Phase-5-Hinweis)
2. `docs/refactoring-plan.md`, Abschnitt **Phase 5** (Sub-Tasks 5.1–5.5)
3. Memory `feedback_codex_consultant.md` — Codex als zweite Meinung
   einsetzen, Sichten synthetisieren

Empfohlene Reihenfolge:

- **5.1 zuerst** — Backend-Konsolidierung Dokument-Öffnen + Dead-Code-Removal.
  Höchster Hebel: eine Service-Funktion ersetzt vier Hand-Choreografien,
  der heutige Link-Klick-Dirty-Bug wäre damit strukturell nicht mehr möglich.
  Dead Code (`nav.rs::link_click`, `mark_external_changed`/`has_external_changes`)
  fällt nebenbei mit raus.
- **dann 5.2** — `@ts-nocheck` schrittweise raus + `tsc --noEmit` in
  `package.json::build`. Fängt Klasse-1-Bugs (wie der `main.ts:418`-
  ReferenceError dieser Session) zukünftig im Build statt zur Laufzeit ab.
  Kann parallel zu 5.1 laufen, ist aber niedrigeres Risiko + kürzere
  Diffs — gute Aufwärmübung.
- **5.3** Splits danach in kleinen Häppchen pro Modul.
- **5.4 / 5.5** zum Schluss; 5.4 (Frontend-Tests) ist eigenständig und
  könnte vorgezogen werden, wenn Lust auf Test-Setup vor Code-Bewegung.

Pro Schritt: `cargo test --lib && cargo clippy --all-targets -- -D warnings`
+ `cd src-tauri/web && npm run build` grün, dann committen. Commit-Stil
analog vorhandener Phase-4-Commits (`refactor(scope): ..., Plan-Phase 5.x`).

Wenn du bei 5.1 anfängst: Codex parallel zur Architektur-Frage befragen
("Wie würdest du `document::open(path, anchor, options)` schneiden — auch
Frontend-Pfad über requestSaveIfDirty oder Backend dirty-aware?"). Sichten
synthetisieren, dann implementieren.
