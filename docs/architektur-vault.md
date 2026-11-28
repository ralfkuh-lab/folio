# Architektur: Vault-Baum

Markup, Pfadregeln, Watcher, Pins und Git-Anzeige im Vault. Suche, Filter, Dateioperationen, Tastatur und Wikilinks haben eigene Specs. Ausgelagert aus der früheren `CLAUDE.md`; [`AGENTS.md`](../AGENTS.md) enthält nur noch den Index.

- **Vault-Markup**: Frontend erwartet Baum-Markup mit `.section`, `.node`, `.row`,
  `.caret`, `ul.children`. Jedes `.node` hat `data-path="<abs-path>"`
  und `title="<abs-path>"` (Tooltip).
- **Pfad-Normalisierung**: alle Pfade, die in DOM-`data-path`-Attribute,
  workspace.json-Speicher oder `is_pinned`/`is_expanded`-Vergleiche
  gehen, werden auf Forward-Slashes normalisiert (`\` → `/`).
  Implementiert in `Workspace::pin/unpin/is_pinned/add_recent/
  remove_recent/image_dir/set_image_dir/set_last_export_dir/
  is_wikilink_root/set_wikilink_root`,
  `WorkspaceData::last_export_dir`, `WorkspaceData::wikilink_roots`,
  `Vault::set_active/
  on_expand/is_expanded` und `Vault::item_html`. Begründung: CSS-
  Selektoren `[data-path="C:\Users\..."]` schlagen sonst fehl
  (`\U` = Unicode-Escape). `Workspace::load_from` migriert bestehende
  Backslash-Pfade beim Boot. Windows-APIs akzeptieren beide
  Schreibweisen, daher bricht das keine Datei-IO.
- **Pfad-Identität vs. lexikalischer Vergleich** (`path_identity.rs`):
  Forward-Slash-Normalisierung allein beantwortet nicht „ist das dieselbe
  Datei?" — ein Symlink-Verzeichnis, macOS' `/tmp`→`/private/tmp` oder
  eine abweichende Schreibweise auf case-insensitiven Volumes erzeugen für
  eine Datei zwei Strings (und damit zwei Tabs mit je eigenem Puffer).
  Es gibt deshalb genau zwei Vergleichsfunktionen, und jede Aufrufstelle
  wählt bewusst: `same_file`/`identity_key` **mit** Datei-IO
  (`fs::canonicalize`, Windows-UNC-Präfix in **beiden** Zweigen gestrippt,
  Fallback auf den lexikalisch normalisierten Pfad, wenn die Datei nicht
  existiert — kein Cache) und `lexical_paths_equal` **ohne** Datei-IO (FS-Case-Regeln auf
  den Strings, für Pfade aus demselben Walk; früher `wikilink::paths_equal`).
  Der Identitäts-Schlüssel ist **nur** ein Vergleichswert: gespeichert,
  angezeigt und ins DOM gegeben wird weiterhin die Schreibweise, mit der
  der Nutzer navigiert hat. Identitätsbasiert vergleichen: `find_by_path`,
  `tab_to_focus_for_path`, `push_recently_closed`, `navigation::navigate`,
  `ReloadPolicy::IfPathChanged` + Kind-Cache, der Watcher-Filter
  `document_store::same_path` sowie in `workspace.rs` Pin-Doppelprüfung,
  `unpin`, `reorder_pinned`, Recent-Dedup und `image_dir`-Lookup. Bewusst
  **nicht**: Render- und Walk-Pfade (`Workspace::is_pinned` als
  Lese-Prädikat, `vault.rs::is_expanded`/`item_html`, Wikilink-/Tag-/
  Such-/Palette-Dedup) — dort wäre `canonicalize` ein IO-Aufschlag pro
  Knoten bzw. pro Datei. Präfix-Operationen bleiben komplett bei
  `path_migration` (lexikalisch, Segmentgrenze).
  Zwei Fallen aus dem Kreuz-Review: (1) `lexical_normalize` behandelt die
  **Wurzel als unteilbar** — `/`, Laufwerk (`C:/`) und UNC-Freigabe
  (`//server/share/`); ohne das machte `C:/a/../../b.md` aus einem absoluten
  einen relativen Pfad, und zwar auf Windows im Produktionspfad jedes
  Link-Klicks (`resolve_existing_path` normalisiert damit). Laufwerksrelative
  Pfade (`C:a/b`) bleiben bewusst relativ. (2) Jede Dedup-Schleife nutzt
  `FileMatcher` statt beidseitigem `identity_key`: gleiche Schreibweise wird
  ohne Syscall entschieden, der Schlüssel entsteht erst beim ersten
  abweichenden Kandidaten (`reorder_pinned` war sonst O(n·m) `canonicalize`
  pro Pin-Drag).
  Gegenstück dazu: `file_resolver::resolve_existing_path` kanonisiert
  **nicht mehr** (nur Existenzprüfung, Case-Korrektur und lexikalische
  Normalform) — der Link-Klick war die einzige Stelle, die physisch
  auflöste, und genau daraus entstand die Asymmetrie. **Reihenfolge ist
  dort Vertrag**: erst normalisieren, dann die Existenz genau dieses Pfads
  prüfen. Andersherum liefert ein Link über ein Symlink-Verzeichnis
  (`link/../x.md`) einen Pfad, den es gar nicht gibt.
- **Vault-Watcher** (`vault_watcher.rs`): pro aufgeklappten Vault-
  Ordner ein NonRecursive-`notify`-Watch. `Vault::on_expand`
  registriert, `on_collapse` deregistriert. Bei FS-Event emit
  `vault:dir_changed { path }` → Frontend triggert `expand-dir`-Pfad
  nur für diesen Ordner. Steuerbar via Setting `vaultAutoRefresh`
  (default an). Toggle live-aware: bei Re-Enable werden alle aktuell
  expanded_dirs erneut registriert (siehe `commands::app::settings::
  sync_vault_watcher`).
- **Versteckte Vault-Einträge** (`settings.vaultShowHidden`, Default
  `true`): folgt dem `includeHidden`-Modell der Suche. „Versteckt"
  heißt name-basiert `Name beginnt mit .` (Dateien und Verzeichnisse;
  das Windows-Hidden-Attribut wird bewusst nicht ausgewertet). `.git`
  bleibt **immer** ausgeblendet, auch bei aktivem Schalter. Explizite
  Pins bleiben sichtbar (Filter greift auf Kinder in
  `Vault::build_dir_children_html`, nicht auf Pin-Wurzeln; ein direkt
  gepinntes `.git` wäre abwegig und folgt derselben Pin-Regel).
  Live-Toggle ohne Neustart; unsichtbar gewordene aufgeklappte Ordner
  werden aus `expanded_dirs` und ihren NonRecursive-Watches entfernt.
  Der Filter-Chip „versteckte" (`#vault-filter-hidden` `.*`) **ist**
  dieser Schalter (seit R5.1): Baum, Filter und Suche folgen einem Wert.
- **Pin-Reordering** (`vault/tree.ts`): das Umsortieren der angepinnten
  Top-Level-Einträge läuft **Pointer-basiert** (`pointerdown`/`move`/`up`,
  delegiert auf `#vault-tree`), **bewusst NICHT über HTML5-Drag&Drop**.
  Grund: auf Windows/WebView2 fängt Tauris OS-Level-Drag-Handler
  (`dragDropEnabled`, Default an — wird fürs Datei-Drop-zum-Öffnen in
  `ui/drag-drop.ts` gebraucht) sämtliche Drag-Operationen ab und liefert
  keine `dragover`/`drop`-Events mehr in die WebView; HTML5-DnD ist damit
  tot (auf Linux/WebKitGTK lief es, daher grün in der E2E-Suite). Die
  Pointer-Variante ist unabhängig vom OS-Handler. Bewusst **ohne**
  `setPointerCapture` (so ist `e.target` bei `pointermove` das Element
  unter dem Cursor → Drop-Ziel-Bestimmung + jsdom-testbar).
  Bewegungs-Threshold (4 px) trennt Klick (= öffnen) vom Drag; der dem
  Drag folgende synthetische Klick wird per Capture-Listener auf
  `#vault-region` geschluckt (`suppressNextClick`). Drag-**Quelle** nur
  die eigene `.row` des Root-Items (nicht aus verschachtelten Pin-Ordner-
  Kindern), Drop-**Ziel** der gesamte Subtree. Persistenz unverändert
  über `workspace_reorder_pinned`. Kein `draggable`-Attribut mehr.
- **Gitignore-Dimming im Vault**: Ignorierte Dateien/Verzeichnisse (Pins + Kinder aufgeklappter Ordner) bekommen `ignored`-Klasse auf `li.node`; nur eigene Row wird via `> .row` CSS gedimmt (opacity 0.55). Nutzt `ignore`-Crate (nur GitignoreBuilder + matched_path_or_any_parents; kein WalkBuilder, kein git-Binary, kein neuer Watcher — bestehende expand/refresh + VaultWatcher reichen). `repo_root` aus git_branch. Recent-Liste bleibt unberührt.
- **Git-Diff („Änderungen anzeigen")**: Kontextmenü nur bei `git-modified` + Textdatei (`data-text="1"` aus `FileKind`). Read-only Diff über dieselbe `FolioDiffView`-Surface/`#ai-diff-region` wie die KI-Review (`setContents(..., { readOnly: true })`, Default bleibt editierbar). Rechte Seite = offener Tab-Puffer (`getTextForTab`) sonst Disk. Offene KI-Review blockt den Git-Diff (`errors.ai.reviewOpen`). HEAD via `git show HEAD:<rel>` mit derselben Deadline/kill+reap wie der Status-Job.
- **Git-Status-Dots im Vault** (`git_status.rs` + Frontend `vault/git-status.ts`): modified/untracked als Klassen `git-modified`/`git-untracked` auf `li.node` (Punkt via `> .row::before`, kein Layout-Shift). Datenquelle `git status --porcelain=v1 -z --untracked-files=normal` (nicht libgit2, nicht `.git/index`); Fail-open ohne Dialog. Vault-Render bleibt frei davon — Hintergrund-Job pro Repo-Root, Single-Flight, Generation-Discard, Cache-TTL 15 s, Event `vault:git_status` (Payload trägt `generation`; Frontend verwirft ältere Snapshots wie den `document:*`-seq-Guard). `git status` hat eine 10-s-Deadline (`kill`+`wait`); `refreshing` wird per RAII-Guard freigegeben. **stdout MUSS in einem Reader-Thread geleert werden, WÄHREND auf den Prozess gewartet wird** (`wait_child_with_timeout`, gilt für beide git-Aufrufer): Wird die Pipe erst nach Prozessende gelesen, blockiert git bei Ausgaben über dem OS-Pipe-Puffer (Linux 64 KiB, Windows 4 KiB) im `write()` — und wir warten auf sein Ende. Deadlock bis zum Timeout, danach keine Dots (Befund Kreuz-Review 2026-08-14; trat ab ~1000 geänderten/untrackten Einträgen auf). Cache hält den vollen Snapshot und liefert ihn bei frischem Treffer erneut. Invalidierung bei Fenster-Fokus (Commit fasst keine Arbeitsdatei an; Root-Discovery nach Freigabe des Workspace-Locks), Save/create/rename/delete; **keine** Watcher auf `.git/index`. Ordner-Aggregation (Präfix) im Backend; Frontend wendet den letzten Snapshot nach Lazy-Expand erneut an (`MutationObserver` + `takeRecords()` im `finally`).
  **Zugänge zum Status** (Etappe 2026-08-14): Der `title` eines Knotens nennt den Status im Klartext (analog zum „gitignored"-Zusatz, idempotent gesetzt und rückstandsfrei entfernt). Der Tab trägt links einen 4-px-Balken (`.tab-git`, amber) — bewusst NICHT den dirty-Punkt eingefärbt, der rechts bleibt und Ungespeichertes meint; ein Marker mit zwei Bedeutungen wäre nicht unterscheidbar. Klick auf den Balken öffnet den Git-Diff (`preventDefault`+`stopPropagation`, aus dem Drag-Handler ausgenommen, Mittelklick abgefangen, `tabindex="-1"`). Toolbar-Button + Menüeintrag sind eine **Aktion mit Enabled-Zustand, kein vierter View-Mode** — Modes sind pro Tab, die DiffView-Surface ist ein Singleton, das passt strukturell nicht zusammen.
  **Git-Filter „nur geänderte"** (`vault/filter.ts`, kombinierbar mit Namensfilter und md-only): Zwei Fallen, beide aus dem Kreuz-Review 2026-08-14. (1) `--untracked-files=normal` meldet einen komplett neuen Ordner als EINEN Eintrag `?? neu/` — die Kinddateien stehen NICHT im Snapshot. Der Filter muss sie über Verzeichnis-Präfix (auf Segmentgrenze!) mitzählen, sonst bleibt ein aufgeklappter, scheinbar leerer Ordner zurück. (2) `git status` liefert das ganze Repo; der Auto-Expand darf nur Pfade unterhalb **sichtbarer Pin-Wurzeln** öffnen, sonst werden repo-fremde Ordner expandiert und gewatcht und der 1000er-Soft-Cap ist erschöpft, bevor der relevante Zweig drankommt.
- **main-Badge-Farbe**: `git-branch--main` (und dark) jetzt `var(--rail-accent)` statt `--rail-fg-muted` (Detached bleibt rot, Feature-Branches bernstein) — Unterscheidbarkeit zum Dimming.
- **Pin-Trenner** (`workspace.rs::PinSeparator`, `vault.rs::separator_html`):
  Linien mit optionaler, mittig zentrierter Beschriftung im Abschnitt
  „Angepinnt“. Modell `pinned_separators` (`id`, `label`, `position`)
  **neben** `pinned`, nicht darin: die Pin-Liste lesen Suche, Filter,
  Wikilinks, Git usw., die von Trennern nichts sehen sollen. `position` =
  Anzahl der Pins davor (`0..=len`), gleiche Position in Vec-Reihenfolge,
  Vec stets sortiert; Pins werden **nur** über `retain_pins` entfernt (zieht
  die Positionen nach). `workspace_reorder_pinned` nimmt Pin-Pfade und
  `sep:<id>`-Tokens (Frontend: `tree-keyboard.ts::vaultEntryOf`). Das Markup
  `li.pin-separator` hat bewusst **weder `.node` noch `.row`** — daran hängen
  pfadbasierte Handler, Klick-Routing und Section-Toggle. Hinzufügen nur
  über das Menü der Überschrift „Angepinnt“ (Benutzerwunsch: Datei-/
  Ordnermenüs bleiben ohne Trenner-Eintrag). Die Inline-Beschriftung nutzt
  den Rename-Guard und darf deshalb nie in einer unsichtbaren Zeile öffnen
  (ohne Blur bliebe der Baum angehalten); eine offene Eingabe hat Vorrang
  vor der automatisch geöffneten nach „Hinzufügen“. Namensfilter, git-Chip
  und Bereich blenden Trenner aus, md-only nicht — deshalb nicht an
  `isVaultFilterActive()` hängen (das schließt md-only ein).
