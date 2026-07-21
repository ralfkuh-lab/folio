# Spec: Tab-Kontextmenü (Schließen-Varianten + Wiederherstellen)

Status: beschlossen 2026-07-21. Ursprung: `docs/feature-ideen.md` →
„Tab-Kontextmenü-Ausbau" `[S]`. Implementierungs-Testlauf für agy
(Gemini 3.6 Flash) als Implementierer.

## Ziel

Rechtsklick auf einen **Dokument-Tab** in `#tab-bar` öffnet ein
Kontextmenü:

1. **Schließen** — wie der bestehende ✕-Klick (gleicher Pfad).
2. **Alle anderen schließen** — schließt alle anderen Dokument-Tabs.
3. **Tabs rechts schließen** — schließt alle Dokument-Tabs rechts vom
   geklickten.
4. *(Separator)* **Zuletzt geschlossenen Tab wiederherstellen** —
   öffnet den zuletzt geschlossenen Dokument-Tab erneut.

Virtuelle Tabs (⚙ Einstellungen, Theme-Editor, ai-diff) bekommen KEIN
Kontextmenü und werden von 2./3. nicht angefasst (sie sind
frontend-only und liegen außerhalb der Backend-Tab-Liste).

## Verhalten im Detail

- **Dirty-Handling (2./3.)**: Das Frontend orchestriert seriell über den
  BESTEHENDEN Einzel-Close-Pfad (derselbe, den der ✕-Klick nimmt,
  inklusive Dirty-Bestätigungsdialog pro Tab). Bricht der User einen
  Dirty-Dialog ab, stoppt die restliche Serie (VS-Code-Verhalten).
  Kein neuer Backend-Bulk-Close.
- **Closed-Stack (4.)**: `TabManager` führt einen Session-only-Stack
  `recently_closed: Vec<String>` (Pfade, Cap 10, kein Persistieren).
  Push bei JEDEM Schließen eines Tabs mit Dokument-Pfad
  (`document_path` oder `pending_path`) — Einzel-Close, Serie,
  Ctrl+W; NICHT bei `close_all` aus der E2E-Isolation
  (`/tabs/close_all` ist Test-Aufräumen, kein User-Schließen).
  Duplikate: derselbe Pfad wird vor dem Push aus dem Stack entfernt
  (ein Eintrag pro Pfad, jüngster gewinnt).
- **Wiederherstellen**: neuer Command `tab_restore_last` → poppt vom
  Stack; nicht mehr existierende Pfade werden übersprungen (weiter
  poppen); ist der Pfad bereits offen, wird der Tab nur aktiviert
  (bestehende `tab_open`-Dedup-Konvention — Restore läuft über den
  `tab_open`-Pfad). Leerer Stack → Ok(No-op).
- **Disabled-Zustände** im Menü: „Alle anderen" bei nur einem
  Dokument-Tab; „Tabs rechts" ohne rechte Nachbarn; „Wiederherstellen"
  bei leerem Stack (Stand kommt als `recentlyClosedCount` im
  `tabs:changed`-Payload mit — kein Extra-Roundtrip beim Menü-Öffnen).

## Umsetzung

- **Frontend**: neues Modul `web/app/ui/tab-context-menu.ts` nach dem
  Muster von `vault/context-menu.ts` (eigenes Menü-Element
  `#tab-ctx-menu` in `dist/index.html`, gleiche CSS-Klassen
  `ctx-item`/`ctx-sep` — Styles wiederverwenden). `contextmenu`-Listener
  delegiert auf `#tab-bar` (nur `li` mit `data-tab-id`, keine
  virtuellen). Serien-Close nutzt die in `state/tabs.ts` bereits
  vorhandene Close-Routine (ggf. dafür exportieren), Reihenfolge:
  erst Ziel-Liste aus dem aktuellen `tabs:changed`-Snapshot einfrieren,
  dann seriell schließen.
- **Backend**: `TabManager::{push_recently_closed, pop_recently_closed,
  recently_closed_count}` + Integration in `close()`-Aufrufer (Command-
  Ebene, wo der Pfad noch bekannt ist); Command `tab_restore_last`;
  `TabSummary`/`tabs:changed`-Payload um `recentlyClosedCount`
  erweitern (additiv). Automation: `POST /tabs/restore_last` (dünner
  Wrapper, wie die anderen /tabs-Endpunkte).
- **i18n**: Keys `tabs.contextMenu.{close,closeOthers,closeRight,
  restoreLast}` in ALLEN 9 Katalogen (alphabetisch, identische
  Key-Mengen) + Kontextsätze in `locales/context/keys.json`.
- **Kein neuer Shortcut** (Ctrl+Shift+T wartet auf die
  Accelerator-Baustelle, siehe TODO).

## Tests

- **Rust** (`tab_manager.rs`-Tests): Stack-Push mit Dedup + Cap 10;
  restore überspringt tote Pfade; close_all pusht nicht;
  `recently_closed_count` im Summary-Payload.
- **vitest** (`tests/state/` bzw. neues `tests/ui/tab-context-menu.test.ts`):
  Menü öffnet nur auf Dokument-Tabs; Item-Liste + Disabled-Zustände
  (1 Tab / kein rechter Nachbar / leerer Stack); „Alle anderen" ruft
  Close für genau die anderen IDs in Reihenfolge; Abbruch stoppt Serie;
  „Wiederherstellen" ruft `tab_restore_last`.
- **E2E**: neues Szenario `50_tab_context.py`: drei Dateien in Tabs
  öffnen, Rechtsklick auf mittleren Tab (contextmenu-Event via /eval),
  „Tabs rechts schließen" → Tab-Leiste prüfen (`GET /tabs`),
  „Alle anderen schließen" → nur einer übrig,
  `POST /tabs/restore_last` → geschlossener Tab wieder da (aktiviert),
  Screenshot der offenen Menü-UI. Aufräumen im finally
  (`/tabs/close_all`-Konvention). Baselines legt der Orchestrator an.

## Abnahme-Gates

cargo test (voll) · clippy -D warnings · fmt --check · npm run build ·
npx vitest run · E2E (Orchestrator).
