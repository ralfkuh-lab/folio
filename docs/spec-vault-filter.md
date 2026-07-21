# Spec: Vault-Tree-Filter (Sicht-Filter über dem Lazy-Baum)

Status: **Revision 3, beschlossen 2026-07-21** (User-Feedback aus zwei
Test-Runden). Ursprung: `docs/feature-ideen.md` → „Vault-Tree-Filter".

## Revisions-Historie (Kurzfassung)

- **R1 (2026-07-20)**: Backend-Rekursiv-Walk über alle Pins
  („Filter-Render-Modus" mit gestutztem Voll-Baum), Ordner-Subtree-Regel,
  Walk-/Render-Caps. Probleme: Ordner-Match zog riesige Subtrees rein.
- **R2 (2026-07-20)**: Subtree-Regel raus, Treffer-Highlight,
  „Schließen = Aufräumen", Match-Art-Chips 📄/📁. Probleme blieben
  strukturell: blinder Tiefen-Walk über gepinnte Repos/dev-Ordner
  (node_modules, Backups) → Walk-Deckel schlug zu, „Too many matches"
  ohne einen sichtbaren Treffer; doppeltes ✕.
- **R3 (dieses Dokument)**: Der Filter ist eine **clientseitige Sicht**
  über dem echten Lazy-Baum. Kein Backend-Walk, keine Caps, kein
  separater Render-Modus. Suchraum steuert der User über Aufklappen —
  unterstützt durch „eine Ebene tiefer" und „alles einklappen".

## Modell (R3)

1. **Filter = Ausblenden im echten Baum.** Der Namensfilter (Eingabe,
   debounced 150 ms, case-insensitive Substring via `toLowerCase`, kein
   Unicode-Case-Folding) blendet **Datei-Zeilen** aus, deren Name nicht
   matcht. **Ordner bleiben immer sichtbar** (sie sind der aufklappbare
   Suchraum). Matchende Datei- UND Ordnernamen bekommen ein
   Treffer-Highlight (`span.vf-hit`, erstes Vorkommen, Text-Node-sicher,
   Find-Bar-Farben + Dark-Variante).
2. **Der Baum bleibt der Baum.** Expand/Collapse, VaultWatcher,
   `vault:refresh`, Pin-Drag, Kontextmenüs — alles funktioniert
   unverändert, weil es keinen separaten Filter-Baum mehr gibt. Nach
   jeder DOM-Änderung des Baums (Expand, Refresh) wird der Filter
   re-appliziert (MutationObserver auf `#vault-tree` mit
   Reentranz-Guard — die eigene Highlight-/Hide-Arbeit darf den
   Observer nicht triggern).
3. **Beide Sektionen.** Der Filter wirkt auf Pinned UND Recent
   (einheitliche „Sicht-Filter"-Semantik); die Recent-Section wird
   nicht mehr ausgeblendet.
4. **„Nur Markdown"-Toggle** bleibt unverändert Backend-Lazy
   (`build_dir_children_html` filtert pro Expand; Pin-Wurzeln
   eingeschlossen; `dir_contains_markdown`-Probe: Early-Exit,
   2k-Visit-Cap fail-open, kein Abstieg in Link-Dirs, `.git`-Skip).
5. **Leere Ordner** (ohne sichtbare matchende Dateien) bleiben bei
   aktivem Filter sichtbar — bewusst: sie sind der Suchraum.

## Baum-Operationen (neu, filter-unabhängig nutzbar)

Zwei Buttons in der `vault-header`-Zeile (neben dem Funnel,
`.vault-cmd`-Stil):

- **„Eine Ebene tiefer" (`#vault-expand-level`, ⊞)**: expandiert alle
  aktuell **sichtbaren, zugeklappten** Ordner (Pin-Wurzeln + Kinder
  bereits expandierter Ordner) um genau eine Ebene. Backend-Command
  `vault_expand_level` → nutzt den bestehenden `on_expand`-Pfad
  (Watcher-Registrierung inklusive), **Soft-Cap ~1 000 neu geöffnete
  Ordner pro Klick** — danach bricht der Vorgang ab und die Antwort
  trägt `capped: true`; das Frontend zeigt einen transienten Hinweis
  (kein stilles Kappen). Antwort ist der neu gerenderte Baum (bzw.
  Refresh-Delta) + Persistenz wie bei jedem Expand.
- **„Alles einklappen" (`#vault-collapse-all`, ⊟)**: Backend-Command
  `vault_collapse_all` → `on_collapse` für alle Pin-Wurzeln
  (deregistriert Watches rekursiv, leert `expanded_dirs` bis auf
  nichts), Baum-Rebuild.

Watcher-Risiko: `vault_expand_level` registriert Watches über den
Normalpfad; der 1 000er-Cap pro Klick begrenzt das Wachstum. Sollte
inotify-Erschöpfung praktisch auftreten, ist `watch_non_fatal`-Verhalten
gefordert (Expand funktioniert, Watch fehlt, warn-Log) — kein Abbruch.

## UI (R3)

- **Funnel-Button** togglet die Filterzeile (persistiert
  `vault_filter_bar_visible`). Badge `filter-active` NUR noch für den
  `.md`-Toggle (einzige verbleibende persistente Präferenz).
- **Filterzeile**: Input (mit **eingebettetem** Text-Lösch-✕ rechts im
  Feld, nur bei Text sichtbar) + `.md`-Chip + **ein** Zeilen-X
  (`#vault-filter-close`, immer sichtbar). Schließen (X, Funnel,
  Escape bei leerem Input) leert die Query — „Schließen = Aufräumen"
  aus R2 bleibt. Escape bei Text leert erst den Text.
- **Match-Art-Chips 📄/📁 sind ENTFERNT** (R3: Ordner sind immer
  sichtbar, Match-Art-Semantik gegenstandslos). Panel-State-Felder
  `vault_filter_match_files`/`vault_filter_match_dirs` werden entfernt
  (alte JSON-Werte werden von serde ignoriert).
- **Truncation-Banner ist ENTFERNT** (keine Caps mehr im Filter);
  das Element wird zum generischen transienten Hinweis für den
  Expand-Level-Cap umgewidmet (`#vault-tree-notice`).

## Persistenz

`panel_state.rs::PanelStateData`:

- `vault_filter_markdown_only: bool` (bleibt)
- `vault_filter_bar_visible: bool` (bleibt)
- `vault_filter_match_files`/`vault_filter_match_dirs`: **entfernt**

Query flüchtig. Expand-Zustand wie bisher im `Vault`-State.

## Backend-Änderungen (R3)

- **Entfernt**: `run_vault_filter`, `VaultFilterOptions`,
  `VaultFilterResult`, `FilterNode`, Walk-/Render-Caps, Command
  `vault_filter` samt Response-Typ und Registrierung. Die zugehörigen
  Tests entfallen (Feature existiert nicht mehr); `vault_filter.rs`
  schrumpft auf die Lazy-Bausteine (`dir_contains_markdown` + Tests)
  oder wird nach `vault.rs` gefaltet — Implementierer entscheidet.
- **Bleibt**: Lazy-Typ-Filter inkl. Pin-Wurzeln,
  `markdown_only`-Spiegel + `compute_refresh_delta_synced`,
  `vault_filter_options_get/set` (nur noch zwei Felder).
- **Neu**: `vault_expand_level` (Soft-Cap 1 000, `capped`-Flag),
  `vault_collapse_all`. Beide persistieren/emittieren wie die
  bestehenden Expand-/Collapse-Pfade (Panel-/Vault-State + Tree-HTML).

## Tests (R3)

- **Rust**: `expand_level` expandiert genau eine Ebene (zweimaliger
  Aufruf = zwei Ebenen), respektiert den Cap (`capped`), lässt
  `markdown_only`-Lazy-Filterung intakt; `collapse_all` leert
  `expanded_dirs` und deregistriert Watches; Lazy-/Probe-Tests bleiben.
- **vitest**: Client-Filter blendet nur Datei-Zeilen aus (Ordner nie),
  Highlight auf Datei- und Ordnernamen, Re-Apply nach DOM-Mutation
  (simuliertes insertVaultChildren), Observer-Reentranz (kein
  Endlos-Loop), Escape-/Close-Kaskade, Badge nur bei md-only,
  eingebettetes Text-✕ nur bei Text.
- **E2E 49**: umgeschrieben auf R3 — Filter tippen → Nicht-Treffer-
  Dateien weg, Ordner sichtbar, Highlight da; Ebene-tiefer-Button
  erweitert den Suchraum (neuer Treffer erscheint); Alles-einklappen;
  Zeilen-X räumt auf. Baselines erneuert der Orchestrator.

## Abnahme-Gates

cargo test (voll) · clippy -D warnings · fmt --check · npm run build ·
npx vitest run · `bash scripts/run-e2e.sh` (Orchestrator).
