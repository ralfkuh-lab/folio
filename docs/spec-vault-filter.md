# Spec: Vault-Tree-Filter (Sicht-Filter über dem Lazy-Baum)

Status: **Revision 4, beschlossen 2026-10-09** (R3 vom 2026-07-21 gilt
weiter, R4 ergänzt den Tiefenfilter und den Ordnerbereich). Ursprung: `docs/feature-ideen.md` → „Vault-Tree-Filter".

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
- **R4 (2026-10-09)**: Opt-in-**Tiefenfilter** (Chip `**`) und
  **Ordnerbereich** („In diesem Ordner filtern"). Anlass: Eine Datei ist
  nach Namensteil bekannt, aber nicht ihr Unterordner; R3 findet nur, was
  schon aufgeklappt ist. R4 holt den Backend-Walk zurück, aber **ohne die
  R1/R2-Fehler**: Deckel auf **Treffer** statt auf besuchte Einträge,
  Zeitbudget, kein separater Render-Modus — Aufklappen und Ausblenden
  laufen über den echten Lazy-Baum wie beim Git-Filter. Gitignore wird
  bewusst NICHT angewandt (siehe R4-Abschnitt).
- **R4.1 (2026-10-09)**: Bereich + `.md` klappt auch **ohne Suchbegriff**
  auf; Bereich + `git` begrenzt den Git-Filter auf den Ordner
  (User-Feedback nach dem ersten Test).
- **R4.2 (2026-10-09)**: Bereich wirkt sofort (ohne Query/Chip); Ordner-
  Sichtbarkeit im Tiefenmodus aus der Trefferliste statt aus dem DOM
  (User-Report: nach Zu-/Aufklappen waren Treffer unerreichbar).
- **R4.3 (dieses Dokument)**: vierter Chip „versteckte" (`.*`,
  `#vault-filter-hidden`, persistiert `vault_filter_hidden`, Default
  aus). Getrennt vom Baum-Setting `vaultShowHidden`: der Chip steuert
  nur die Filtertreffer und aktiviert keinen Filter allein. Tiefenmodus:
  wirksames `show_hidden` = Chip **UND** `vaultShowHidden`.
- **R5 (2026-10-10, Volltextsuche S9)**: Such- und Filterbereich
  zusammengelegt. Der Funnel öffnet `#vault-filter` ganz oder gar nicht
  (`aria-expanded`); unter dem Namensfeld liegt das Inhaltsfeld der
  Volltextsuche, die Chip-Zeile trägt zusätzlich Zahnrad und Bereichs-Chip
  (vorher eigene Zeile über dem Feld). Das Zeilen-✕ `#vault-filter-close`
  entfällt — Schließen per Funnel oder Escape im leeren Feld. Neue Exporte:
  `getSearchSpace()` (einzige Quelle des Suchraums: ohne Namensbegriff Walk
  über Vault/Bereich mit `.md`/`.*`, mit Namensbegriff die Trefferliste von
  `vault_filter_find`), `isVaultFilterBarVisible`, `openVaultFilterBar`,
  `closeVaultFilterBar` und das In-Window-Event `folio-vault-filter-changed`
  bei jeder Änderung von Name, Bereich, Chips, `vaultShowHidden`, Schließen
  und Reset. Details: [`spec-vault-search.md`](spec-vault-search.md), Etappe S9.

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

- **„Oberste Ebene aufklappen" (`#vault-expand-roots`, Chevron einfach
  nach unten, SVG-Stil der `vs-head-btn`-Buttons)**: expandiert
  ausschließlich die **zugeklappten Pin-Wurzel-Ordner** (erste Ebene) —
  bewusst NICHT tiefer (*R3.1, User-Feedback 2026-07-21: mehrstufiges
  „immer eine Ebene tiefer" macht große Bäume unübersichtlich*).
  Backend-Command `vault_expand_roots` über den bestehenden
  `on_expand`-Pfad (Watcher inklusive; bei aktivem md-only werden
  MD-lose Wurzeln übersprungen — sie sind ohnehin unsichtbar). Kein
  Cap nötig (Anzahl = Anzahl der Pins). **Disabled-Zustand**: sind alle
  sichtbaren Pin-Wurzel-Ordner bereits aufgeklappt, ist der Button
  `disabled`; das Frontend leitet den Zustand aus dem DOM ab
  (Pin-Section-Wurzeln mit `caret open`) und synct ihn über denselben
  MutationObserver, der auch den Filter re-appliziert.
- **„Alles einklappen" (`#vault-collapse-all`, Chevron doppelt nach
  oben — gleiche SVG wie `#vault-search-collapse-all`)**:
  Backend-Command `vault_collapse_all` → `on_collapse` für alle
  Pin-Wurzeln (deregistriert Watches rekursiv), Baum-Rebuild.

Der frühere `vault_expand_level`-Mehrstufen-Expand samt 1 000er-Cap,
`capped`-Flag und `#vault-tree-notice`-Hinweis ist **entfernt** (R3.1).
Watcher-Fehler bleiben non-fatal (`watch_non_fatal`-Verhalten).

## UI (R3)

- **Funnel-Button** togglet die Filterzeile (persistiert
  `vault_filter_bar_visible`). Badge `filter-active` bei jedem aktiven
  Filter: nichtleere Query, `.md`- oder Git-Toggle (seit 2026-10-09 zählt
  die Query wieder mit, damit der Button allein den aktiven Filter zeigt).
  Icon: SVG-Trichter (statt des früheren `▽`).
- **Filterzeile**: Input (mit **eingebettetem** Text-Lösch-✕ rechts im
  Feld, nur bei Text sichtbar) + `.md`-Chip + **ein** Zeilen-X
  (`#vault-filter-close`, immer sichtbar). Schließen (X, Funnel,
  Escape bei leerem Input) leert die Query — „Schließen = Aufräumen"
  aus R2 bleibt. Escape bei Text leert erst den Text.
  *Historisch (R3–R4.3):* Seit **R5** gibt es kein Zeilen-X mehr —
  geschlossen wird über den Funnel oder Escape im leeren Feld; die Zeile
  ist Teil des gemeinsamen Such-/Filterbereichs (siehe R5 oben).
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

## R4: Tiefenfilter und Ordnerbereich

### Anwendungsfall

„Ich kenne einen Teil des Dateinamens, nicht den Unterordner" — optional
mit „…aber ich weiß, in welchem Projekt". Referenzfall aus dem
User-Report: `~/dev/sgk/.herd/matrix-call-korr1-astra-prompt.md`, Pin
`~/dev`. `.herd/` ist **versteckt UND per globaler Git-Ignore-Datei
ignoriert** — ein gitignore-respektierender Walk fände die Datei nie.

### Bedienung

- **Chip `**`** (`#vault-filter-deep`, zwischen `git` und Zeilen-X;
  Tooltip „Auch in Unterordnern suchen"). Toggle, **persistiert**
  (`vault_filter_deep`, Default aus). An = Tiefenmodus für den
  Namensfilter über **alle Pins**.
- **Kontextmenü „In diesem Ordner filtern"** (`filter-folder`) auf jedem
  Ordner im Vault-Baum (direkt unter „In diesem Ordner suchen"). Öffnet
  die Filterzeile, setzt den **Ordnerbereich** und fokussiert das Input.
  Ein Ordnerbereich impliziert den Tiefenmodus, **unabhängig vom
  Chip-Zustand** (der persistierte Chip-Wert wird nicht verändert).
- **Bereichs-Chip** `#vault-filter-scope` links im Bar vor dem Input,
  nur sichtbar bei gesetztem Bereich: `📁 <Ordnername> ✕`, Tooltip =
  voller Pfad. ✕ entfernt den Bereich (zurück zu „alle Pins"; ob dann
  tief gefiltert wird, entscheidet wieder der Chip). Der Bereich ist
  **flüchtig**: Zeilen-X, Funnel-Toggle und Escape bei leerem Input
  (Schließen) entfernen ihn; Escape bei Text leert nur den Text.
- Ein erneutes „In diesem Ordner filtern" ersetzt den Bereich, behält
  aber die eingegebene Query.

### Semantik im Tiefenmodus

Aktiv, wenn `(chip an ODER Bereich gesetzt) UND Query ≥ 2 Zeichen`
(nach `trim`). Darunter gilt das R3-Verhalten unverändert.

1. Das Backend liefert die **Trefferliste** (Dateien, deren **Name**
   case-insensitive die Query enthält) und die Menge der
   **Vorfahren-Ordner** jedes Treffers bis einschließlich der Pin-Wurzel
   (bzw. bei Bereich: von der Pin-Wurzel über den Bereichsordner bis zum
   Treffer — der Pfad Pin-Wurzel → Bereich gehört dazu).
2. Das Frontend klappt diese Ordner über den bestehenden
   `vault_expand_paths` auf (Soft-Cap 1 000, Pin-Grenze,
   Hidden-/md-Regeln, `treeMutatedDuringExpand`-Muster wie beim
   Git-Filter) und merkt sich die **vom Filter neu aufgeklappten** Pfade.
3. Sichtbarkeit in der Pinned-Section: Datei sichtbar ⇔ in der
   Trefferliste (und ggf. git-geändert, wenn der Git-Chip an ist).
   Ordner sichtbar ⇔ Vorfahre einer sichtbaren Datei oder auf dem Pfad
   Pin-Wurzel → Bereich. **Alle anderen Knoten erhalten `vf-hidden`**,
   auch Pin-Wurzeln ohne Treffer. Highlight wie R3.
4. Recent-Section: R3-Regel (Namensmatch); bei gesetztem Bereich
   zusätzlich nur Einträge unterhalb des Bereichs.
5. **Leere Trefferliste** → Hinweis im `#vault-tree-notice`
   („Keine Treffer"), Baum zeigt in der Pinned-Section nichts außer dem
   Bereichspfad.
6. **Deckel**: max. **500 Treffer** oder **3 s Zeitbudget** → Antwort
   `truncated: true`, `reason: "cap" | "time"`. Hinweis „Viele Treffer –
   Suchbegriff eingrenzen" (cap) bzw. „Suche abgebrochen – Ordner zu
   groß, Bereich eingrenzen" (time). Die bis dahin gefundenen Treffer
   werden angezeigt. Kein stilles Teilergebnis.
7. **Aufräumen**: Sobald der Tiefenmodus endet (Query < 2 Zeichen,
   Chip aus, Bereich entfernt, Schließen, Reset), werden die vom Filter
   neu aufgeklappten Ordner wieder zugeklappt (neuer Command
   `vault_collapse_paths`, deregistriert Watches wie
   `vault_collapse_all`). Was der Nutzer vorher offen hatte, bleibt offen.
   Bekannte Grenze: Ein Ordner, den der Nutzer **während** des Filters
   unterhalb eines vom Filter geöffneten Ordners aufklappt, geht mit zu
   (`on_collapse` entfernt den Teilbaum). Bei Query-Änderung im
   Tiefenmodus wird NICHT zwischendurch zugeklappt; die gemerkte Menge
   wächst, Nicht-Treffer-Ordner sind ohnehin `vf-hidden`.
8. **Nebenläufigkeit**: Generation-Token pro Anfrage; ältere Antworten
   werden verworfen. Single-Flight: Während eine Anfrage läuft, wird nur
   die **letzte** neue Query vorgemerkt und danach ausgeführt (Muster
   `expandGitPending`). Debounce bleibt 150 ms.

### Walk-Regeln (Backend)

- Wurzeln: ohne Bereich alle Pins über `search::resolve_search_scope(...,
  SearchScope::Vault)` + `search::plan_walk_roots` — dieselbe
  Wurzelplanung wie die Volltextsuche: **jeder Ordner-Pin ist eigene
  Walk-Wurzel** (nur exakte Duplikate entfallen), Datei-Pins direkt, und
  derselbe Grenzfilter `search::is_foreign_root` läuft im `filter_entry`
  jedes Walks — ein verschachtelter Pin gehört nur seinem eigenen Walk.
  Damit ist ein Pin hinter einem versteckten oder gitignorierten
  Zwischensegment bzw. einem Verzeichnis-Symlink ohne
  Erreichbarkeitsvorhersage erreichbar (K-A2/K-A3, N1). Der Anker der
  Vorfahrenkette (`dirs`) ist die jeweilige Walk-Wurzel selbst: Treffer
  unter einem verschachtelten Pin `R/sub` liefern die Kette ab `R/sub`,
  nicht mehr ab `R`.
  Mit Bereich (`scope = Some`): nur der Bereichsordner als Einzel-Walk
  ohne Grenzen (mit der `pin_roots`-Ausnahme unten).
- **Gitignore wird NICHT angewandt** (`standard_filters(false)`): Der
  Vault-Baum zeigt ignorierte Dateien (gedimmt) — ein Filter darf nichts
  verschweigen, was der Baum zeigt. Der Schutz vor `node_modules` & Co.
  ist der Treffer-Deckel plus Zeitbudget, nicht ein Visit-Deckel (das war
  der R2-Fehler: Deckel griff vor dem ersten Treffer).
- Versteckte Einträge: im Tiefenmodus **Chip `.*` UND
  `settings.vaultShowHidden`** (`vault_filter.rs::filter_show_hidden`).
  `.git` bleibt **immer** draußen. Eine Pfadkomponente, die selbst eine
  Pin-Wurzel ist, zählt nicht als versteckt (ein Pin direkt auf
  `.name` zeigt seinen Inhalt — auch wenn er als verschachtelter Pin
  unter einer sichtbaren Wurzel mitgewandert wird, oder im Ordnerbereich
  als eigene Pin-Wurzel). Die `pin_roots`-Ausnahme ist deshalb nicht
  redundant: bei `scope = Some(R)` ist der Dot-Pin keine eigene
  Walk-Wurzel, und nur die Ausnahme lässt `.pinned` durch den
  Hidden-Filter.
  Symlink-Verzeichnisse werden **nicht** betreten (wie Palette).
- „Nur Markdown" an → nur `FileKind::Markdown`-Treffer (endungsbasiert,
  `classify`), konsistent mit dem Lazy-Typ-Filter.
- Match: `file_name.to_lowercase().contains(query.to_lowercase())`
  (entspricht `toLowerCase` im Frontend; kein Unicode-Case-Folding).
- Parallel über `ignore::WalkBuilder::build_parallel` (Muster
  `search.rs::run_search_parallel`), Treffer sortiert zurückgeben
  (deterministisch). Zeitbudget und Deckel brechen den Walk ab
  (`WalkState::Quit`).
- Bereich-Validierung: absolut, existiert, ist Verzeichnis — sonst
  Fehler (`errors.vault.filterScopeNotFound` / `…filterScopeInvalid`
  mit `{detail}`); das Frontend entfernt dann den Bereich, zeigt den
  Fehler transient und fällt auf den Chip-Zustand zurück.

### Schnittstellen

- `vault_filter_find { query: String, scope: Option<String>,
  hidden: Option<bool> }` →
  `{ files: string[], dirs: string[], truncated: bool, reason: "cap"|"time"|null }`.
  Pfade mit Forward-Slashes. `dirs` = Vorfahren (s. o.), dedupliziert,
  flach nach Tiefe sortiert. `hidden` ist der wirksame Chip-Wert des
  Frontends; ist er gesetzt, gilt er statt des persistierten
  `panel_state.vault_filter_hidden` (UND `vaultShowHidden` bleibt) — so
  gehoert jede Antwort eindeutig zu ihrem Anforderungsschluessel und
  haengt nicht am noch ausstehenden Options-Write. `markdownOnly`/
  `vaultShowHidden` liest der Command weiter selbst
  (`read_vault_list_options`). Lock-Regel wie `palette_files`: Pins
  klonen, Locks VOR dem Walk freigeben; Walk in `spawn_blocking`.
- `vault_expand_paths` liefert additiv `paths: string[]` (die neu
  expandierten Pfade aus `ExpandPathsResult.paths`).
- `vault_collapse_paths { paths: string[] }` → `{ html }` wie
  `vault_collapse_all`, nur für die übergebenen Pfade.
- `vault_filter_options_get/set`: additive Felder `deep: bool`
  (`panel_state.vault_filter_deep`) und `hidden: bool`
  (`panel_state.vault_filter_hidden`, serde-default `false`). Beim Set
  ist `hidden` optional: fehlt es, bleibt der bisherige Wert stehen.
- Automation/E2E: `window.__folioVaultFilterInFolder(path)` (Hook wie
  `__folioVaultFilterReset`, ruft denselben Pfad wie das Kontextmenü);
  der Reset-Hook setzt auch Chip und Bereich zurück und räumt auf.

### Badge

`filter-active` wie bisher (Query, md, git); zusätzlich bei gesetztem
Bereich.

### Tests (R4)

- **Rust** (`vault_filter.rs` o. ä., Tempdir-Fixtures, kein Netz):
  Treffer case-insensitive · nur Dateinamen (Ordnername matcht nicht als
  Treffer) · versteckte Dateien je nach Flag · `.git` nie · Symlink-Dir
  nicht betreten · Datei in gitignoriertem Ordner (mit `.gitignore` in
  einem `git init`-Repo) **wird gefunden** · md-only · Deckel →
  `truncated`+`cap` · Zeitbudget (Test-Variante mit injizierbarem
  Budget 0) → `time` · Datei-Pins · Bereich: nur darunter, Vorfahren
  inkl. Pfad Pin-Wurzel → Bereich · Bereich nicht existent / relativ /
  Datei → Fehler · `expand_paths` liefert `paths` ·
  `collapse_paths` entfernt nur die angegebenen Teilbäume.
- **vitest** (`tests/vault/filter.test.ts`): Chip togglet + persistiert
  `deep` · unter 2 Zeichen kein `vault_filter_find` · Antwort → genau
  Treffer + Vorfahren sichtbar, Rest `vf-hidden` · veraltete Antwort
  (alte Generation) wird verworfen · Single-Flight (nur letzte Query
  nachgeholt) · Aufräumen ruft `vault_collapse_paths` mit genau den
  vom Filter geöffneten Pfaden (nicht mit vorher offenen) · Bereich-Chip
  sichtbar/✕/flüchtig beim Schließen · Bereich impliziert Tiefe bei
  Chip aus · Bereich-Fehler entfernt Bereich · Badge bei Bereich ·
  Truncation-/Leer-Hinweis.
- **E2E `66_vault_filter_deep`**: feste Fixture
  `/tmp/folio-e2e-deepfilter` (Grund wie 56/57/59: Pfad steht in der
  Baseline), per `git init` mit `.gitignore` (`ignoriert/`), repo-lokale
  `core.excludesFile`. Gepinnt: `projekt/` mit
  `a/b/c/ziel-tief.md`, `.versteckt/ziel-versteckt.md`,
  `ignoriert/ziel-ignoriert.md`, `andere/ziel-anders.md`,
  `leer/nichts.md`. Prüft: Chip an + `ziel` → alle vier Treffer
  sichtbar und ihre Ordner aufgeklappt, `leer/` versteckt; Bereich
  `projekt/a` per Hook → nur `ziel-tief.md`; Schließen → vom Filter
  geöffnete Ordner wieder zu; `vaultShowHidden=false` →
  `ziel-versteckt.md` fehlt. Ein Screenshot (Chip an, Bereich gesetzt).

### R4.1: Bereich mit `.md` bzw. `git` ohne Suchbegriff

Anlass: „In diesem Ordner filtern“ und dann nur `.md` anklicken zeigte
nichts Sichtbares, weil der Tiefenmodus erst ab 2 Zeichen greift.

1. **Aktivierung erweitert**: Tiefenmodus aktiv, wenn
   `(Chip ODER Bereich) UND Query ≥ 2` **oder** `Bereich UND md-only`
   (Query leer oder kürzer als 2 Zeichen). Ohne Bereich bleibt die
   2-Zeichen-Regel — `**` + `.md` über alle Pins wäre ein willkürlicher
   500er-Ausschnitt.
2. **Backend**: `find_by_name` mit leerer Query liefert nur dann Treffer,
   wenn `scope` gesetzt UND `markdown_only` an ist — dann passt jeder
   Dateiname (alle Markdown-Dateien unterhalb des Bereichs, gleiche
   Walk-Regeln, Deckel und Budget). Sonst bleibt die leere Antwort
   (Schutz auch gegen fremde Aufrufer ohne Bereich).
3. Sicht, Aufräumen, Hinweise, Nebenläufigkeit: unverändert R4. Ohne
   Query kein Highlight. Recent: nur Einträge unterhalb des Bereichs.
4. **Bereich + `git`** (ohne Tiefenmodus, also ohne Query ≥ 2 und ohne
   `.md`): Der bestehende Git-Filter wird auf den Bereich begrenzt —
   Auto-Expand nur für geänderte Ordner **unterhalb des Bereichs** (statt
   aller sichtbaren Pin-Wurzeln), dazu die Kette Pin-Wurzel → Bereich;
   in der Pinned-Section sind Knoten außerhalb des Bereichs `vf-hidden`,
   außer den Vorfahren des Bereichs. Recent wie Punkt 3. Aufräumen beim
   Git-Filter bleibt wie bisher (kein Zuklappen) — bewusst nicht
   angefasst. Kombiniert mit Query ≥ 2 oder `.md` gilt der Tiefenmodus
   (Schnittmenge mit git wie R4).
5. **Tests**: Rust — leere Query + Bereich + md → alle `.md` darunter;
   leere Query + md ohne Bereich → leer; leere Query + Bereich ohne md →
   leer. vitest — Bereich + `.md` ohne Query ruft `vault_filter_find` mit
   `query: ''` und klappt auf; `.md` aus → Aufräumen; ohne Bereich kein
   Aufruf; Bereich + `git` expandiert nur Pfade unter dem Bereich und
   blendet Pin-Knoten außerhalb aus. E2E 66 um beide Fälle ergänzen.

### R4.2: Bereich wirkt sofort; Sichtbarkeit aus der Trefferliste

1. **Bereich sofort**: Sobald ein Bereich gesetzt ist, sind — auch ohne
   Query, `.md` oder `git` — in der Pinned-Section nur die Kette
   Pin-Wurzel → Bereich und alles darunter sichtbar; Dateien außerhalb
   des Bereichs sind in beiden Sektionen `vf-hidden`. Es wird dabei
   nichts gesucht und nichts aufgeklappt. Unterhalb des Bereichs gilt R3
   (Ordner immer sichtbar), mit `git` nur geänderte Ordner (R4.1).
2. **Ordner im Tiefenmodus**: sichtbar ⇔ Kette zum Bereich ODER Vorfahre
   eines Treffers aus der Backend-Trefferliste (mit `git` nur
   git-geänderter Treffer) — unabhängig davon, ob der Treffer gerade
   gerendert ist. Grund: Klappt der Nutzer einen Ordner zu und wieder
   auf, rendert der Lazy-Baum nur eine Ebene; trefferhaltige Unterordner
   blieben sonst unsichtbar und unerreichbar. Manuelles Zuklappen wird
   respektiert (kein automatisches Wiederaufklappen).
3. Wurzel-Pins `/` und `C:/` werden als Vorfahren korrekt erkannt
   (`pathIsUnder` mit Wurzeln, die auf `/` enden).

## R4.3: Chip „versteckte" (`.*`)

Anlass: Suchen lieferten massenhaft Treffer aus Agenten-Arbeitsordnern
wie `.herd/` (versteckt **und** global gitignoriert). Der Baum-Schalter
`vaultShowHidden` ist dafuer zu grob: er steuert die Anzeige, nicht die
Treffermenge des Filters.

1. **Chip** `#vault-filter-hidden` (vierter Chip nach `**`, Text `.*`,
   Tooltip/aria über `vault.filter.hidden.tooltip`/`…ariaLabel`).
   Persistiert als `panel_state.vault_filter_hidden`, **Default aus**,
   unabhaengig von `vaultShowHidden`. Der Reset-Hook
   (`__folioVaultFilterReset`) setzt ihn wie md/git/deep zurück.
2. **Wirkung nur auf Filterergebnisse**, nie auf den ungefilterten Baum
   (der folgt weiter `vaultShowHidden`). Ist der Chip aus, liefert der
   Filter keine Treffer, deren Pfad **unterhalb der Pin-Wurzel** ein
   Dot-Segment enthält. Im flachen Modus entscheidet das Frontend
   (`isHiddenBelowPin`) über die **längste sichtbare Pin-Wurzel**; im
   Tiefenmodus das Backend (`find_by_name`/`visit_entry`). Die Pin-Wurzel
   selbst zählt nicht: ein Pin direkt auf `.name` zeigt seinen Inhalt.
   Das gilt auch, wenn der Pin hinter einem versteckten/gitignorierten
   Zwischensegment oder einem Verzeichnis-Symlink
   liegt (Pin-Wurzel wird eigene Walk-Wurzel, K-A2/K-A3); ein **nicht**
   gepinnter Nachbar hinter demselben Segment bleibt ausgeblendet.
   Es gilt weiter „Ordner bleiben sichtbar" (R3) — der Chip blendet nur
   Datei-Zeilen aus. Die Pin-Zuordnung vergleicht **Windows-Schreibvarianten
   case-insensitiv** (Laufwerksbuchstabe `X:` oder UNC `\\`, `pathIsUnder` in
   `vault/git-status.ts`); Unix-Pfade bleiben case-sensitiv. Rein
   lexikalisch, ohne Dateisystem-IO.
3. **Kein Filter allein**: der Chip aktiviert den Filter nicht und zählt
   nicht fürs Funnel-Badge (anders als `.md`). Ohne Query/Chip/Bereich
   ändert er am Baum nichts.
4. **Tiefenmodus**: wirksames `show_hidden` =
   `filter_show_hidden(chip, vaultShowHidden)` = Chip **UND**
   `vaultShowHidden` (was der Baum nicht anzeigt, kann der Filter nicht
   zeigen). Der wirksame Chip-Wert geht **explizit** als `hidden` mit dem
   Find (siehe Schnittstellen); Chip **und** `vaultShowHidden` stehen im
   Tiefen-Schlüssel, damit ein Umschalten neu sucht. Eine Find-Antwort
   wird nur angewandt, wenn ihr Anforderungsschlüssel noch dem aktuellen
   `deepKey()` entspricht (sonst verwerfen und neu anfordern) — eine
   veraltete Treffermenge bleibt so nie stehen, unabhängig davon, ob der
   Panel-Write schon durch ist.
5. **Referenzfall** (Tests): Pin `R` mit `notes/spec-x.md`,
   `.herd/spec.md`, `.herd/sub/spec-z.md`, `a.md`; zweiter Pin direkt auf
   `R/.pinned-hidden` mit `spec-y.md`; Query `spec`:
   - Chip aus, `vaultShowHidden` an → `notes/spec-x.md`,
     `.pinned-hidden/spec-y.md` (Pin-Wurzel selbst nicht versteckt);
   - Chip an, `vaultShowHidden` an → zusätzlich `.herd/spec.md`,
     `.herd/sub/spec-z.md`;
   - Chip an, `vaultShowHidden` aus → wie Chip aus;
   - flach, `.herd` aufgeklappt, Chip aus → `.herd/spec.md` ausgeblendet;
     Chip an → sichtbar;
   - kein Filtertext/Chip → Baum unverändert.

## Abnahme-Gates

cargo test (voll) · clippy -D warnings · fmt --check · npm run build ·
npx vitest run · `bash scripts/run-e2e.sh` (Orchestrator).
