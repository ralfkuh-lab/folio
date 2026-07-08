# Spec: Link-Klick dedupliziert gegen bereits offene Tabs

Follow-up zu `docs/spec-link-newtab.md` (Release-Nachschub). Bug: Ist
das Link-Ziel bereits in einem **anderen** Tab offen, laedt ein normaler
Klick (ohne Ctrl) auf einen internen Markdown-Link die Datei zusaetzlich
in den aktiven Tab — dieselbe Datei ist dann doppelt offen.

## Soll-Verhalten

Normaler Klick auf einen internen Link in der Markdown-View:

- Ziel-Pfad ist in einem **anderen** Tab offen → diesen Tab
  **aktivieren** (Transition wie `tab_activate`), nichts in den aktiven
  Tab laden. Der Anker des Links wird dabei ignoriert (gleiche
  Entscheidung wie im newTab-Fall).
- Ziel-Pfad ist der **aktive** Tab (insbesondere Anker-only-Links wie
  `#abschnitt-b`) → bestehender Pfad unveraendert
  (`document_service::open` mit `ReloadPolicy::IfPathChanged`, Anker
  scrollt im aktiven Tab). Dieser Fall darf NICHT vom Dedupe
  abgefangen werden.
- Ziel nirgends offen → bestehender Pfad unveraendert (im aktiven Tab
  laden).
- `OpenExternal`/`Missing`: unveraendert.

Der Ctrl/Cmd-/Mittelklick-Pfad (`newTab: true` → `tabs::open`)
dedupliziert bereits und bleibt unveraendert. Der Vault-Klick-Pfad
(`openDocument` → „ersetzt im aktiven Tab") bleibt bewusst
unveraendert — nur der Link-Klick-Pfad aendert sich.

## Umsetzung

In `commands/events/navigation.rs::link_click`, Fall
`LinkAction::Navigate { path, anchor }` ohne `new_tab`:

1. Aktive Tab-ID und `TabManager::find_by_path(&path)` unter demselben
   Lock ermitteln (Pfad-Normalisierung beachten: `find_by_path`
   normalisiert Backslashes bereits; der Interceptor-Pfad sollte vor dem
   Vergleich genauso normalisiert sein wie in
   `document_service::open_inner`, d. h. `\\` → `/`).
2. `Some(id)` mit `id != active_id` → `commands::tabs::activate`-
   Transition + `emit_navigation_changed` (analog zum `tab_activate`-
   Command; Sichtbarkeit der internen Helfer ggf. anpassen) und return.
3. Sonst bestehender `document_service::open`-Pfad.

## Tests

- **Rust**: Unit-Test auf der guenstigsten Ebene (z. B. ein pure-Helper
  „soll aktiviert werden?" aus aktiver ID + find_by_path-Ergebnis, oder
  Test ueber TabManager direkt), plus ein Test, der absichert, dass
  Anker-only auf den aktiven Tab NICHT als Aktivierungs-Fall
  klassifiziert wird.
- **E2E**: `tests/e2e/scenarios/41_link_new_tab.py` um zwei Schritte
  erweitern (nach dem bestehenden Ctrl-Klick-Schritt ist target.md als
  zweiter Tab offen und aktiv):
  1. `tab_activate` zurueck auf source.md, dann **normaler** Klick
     (ohne Ctrl) auf den target-Link → Tab-Anzahl bleibt 2, der
     target-Tab (gleiche Tab-ID wie vorher) ist aktiv, der source-Tab
     traegt weiterhin source.md.
  2. Regression Anker-Link: in source.md einen Anker-Link auf eine
     eigene Ueberschrift ergaenzen (Fixture-Text anpassen), normaler
     Klick darauf → Tab-Anzahl und aktiver Tab unveraendert (source
     bleibt aktiv).
  Achtung `/eval`-Contract: Scripts sind EXPRESSIONS
  (`new Function('return (' + js + ')')`) — mehrzeilige Logik in eine
  IIFE packen, kein nacktes `return`.

## Gates

- `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- `cd src-tauri/web && npm test` (Frontend aendert sich nicht; wenn doch,
  `npm run build` und dist-Bundles in den Diff)
- E2E-Lauf uebernimmt der Reviewer ausserhalb der Sandbox — nicht
  selbst versuchen.
- **Nicht committen.**
