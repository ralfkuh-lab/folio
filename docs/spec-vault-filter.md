# Spec: Vault-Tree-Filter (Namensfilter + „nur Markdown")

Status: **beschlossen 2026-07-20**, Umsetzung in 2 Etappen (F1 Backend,
F2 Frontend/UI). Ursprung: `docs/feature-ideen.md` → „Vault-Tree-Filter"
`[S]`, erweitert um Typ-Filter + Ordner-Pruning (damit `[M]`).

## Ziel

Den Vault-Baum nach zwei Kriterien einschränken:

1. **Namensfilter**: Eingabefeld, case-insensitive Substring-Match auf
   Datei- **und Ordnernamen** (nicht auf den vollen Pfad).
2. **„Nur Markdown"-Toggle**: zeigt nur `FileKind::Markdown`-Dateien;
   Ordner ohne (rekursiv) mindestens eine Markdown-Datei werden
   ausgeblendet.

Beide Kriterien sind kombinierbar. Der Filter formt ausschließlich die
**Baum-Anzeige** — er ist bewusst getrennt von der Volltextsuche
(`spec-vault-search.md`), teilt aber deren Walk-Infrastruktur.

## Nicht-Ziele

- Kein Filter auf die **Recent-Liste** (analog Gitignore-Dimming: Recents
  bleiben unberührt). Während ein Namensfilter aktiv ist, wird die
  Recent-Section komplett ausgeblendet (Filteransicht = reine Pin-Sicht).
- Kein Inhalts-Match (das ist die Volltextsuche).
- Kein Persistieren des Namensfilter-Texts über den App-Neustart
  (flüchtig wie die Such-Query). Der „nur Markdown"-Toggle persistiert.
- Kein Live-Nachführen der Filteransicht durch den VaultWatcher (V1:
  `vault:dir_changed`/`vault:refresh` werden im Filtermodus ignoriert
  bzw. erst beim Verlassen wirksam; siehe F2).

## Architektur-Entscheidungen

### A1 — Zwei Mechanismen, ein Modell

Der Typ-Toggle und der Namensfilter arbeiten unterschiedlich, damit der
Lazy-Tree-Charakter erhalten bleibt:

- **„Nur Markdown" ohne Namensfilter** bleibt im normalen
  **Lazy-Tree-Modus**: `build_dir_children_html` filtert die Kinder des
  jeweils expandierten Ordners (Dateien: nur `FileKind::Markdown`;
  Ordner: nur wenn `dir_contains_markdown` true). Expand/Collapse, Watcher,
  Refresh — alles läuft unverändert.
- **Namensfilter aktiv** (mit oder ohne Typ-Toggle) schaltet in einen
  **Filter-Render-Modus**: das Backend walkt die Pins rekursiv und
  liefert einen **gestutzten, voll aufgeklappten** Baum als HTML. Der
  echte `Vault`-State (`expanded_dirs`) wird dabei **nicht verändert**.

### A2 — Pruning-Regeln (Filter-Render-Modus)

Für jeden Knoten unterhalb der Pin-Wurzeln:

- **Datei**: drin, wenn Name den Filter matcht UND (Typ-Toggle aus ODER
  `FileKind::Markdown`).
- **Ordner, dessen Name matcht**: wird als Knoten angezeigt, zieht aber
  **NICHT** seinen Subtree mit — die Kinder bleiben ganz normal dem
  Namensfilter unterworfen. *(Revision 2026-07-20 auf User-Feedback: die
  ursprüngliche VS-Code-Subtree-Regel produzierte mit
  Substring-Matching mitten im Wort — „ext" ∈ „next-…" — große,
  scheinbar zusammenhanglose Treffermengen. Wer den Ordnerinhalt sehen
  will, deaktiviert den Filter oder pinnt den Ordner.)* Ein matchender
  Ordner ohne matchende Nachfahren erscheint als leerer, aufgeklappter
  Knoten. **Der Typ-Filter gewinnt**: enthält ein namens-gematchter
  Ordner bei aktivem „nur Markdown" rekursiv kein Markdown, wird er
  ausgeblendet — das Toggle-Versprechen („Ordner ohne MD verschwinden")
  gilt ausnahmslos.
- **Treffer-Hervorhebung**: das Frontend markiert im Filter-Render-Modus
  in jedem `.label` das erste Vorkommen der Query (case-insensitive)
  mit `<span class="vf-hit">…</span>` — Farben analog Find-Bar
  (`#FFD700`, Dark-Variante gedämpft). Rein clientseitige
  Nachbearbeitung in `applyPinnedHtml` (Text-Node-sicher, kein
  innerHTML-String-Replace über Markup), Backend-HTML bleibt
  unverändert.
- **Leere Query** bedeutet in `run_vault_filter` **Match-all** (kein
  Namensfilter; es filtert dann nur der Typ-Filter). Das Frontend ruft
  den Filter-Render-Modus zwar nur mit nichtleerer Query auf (A1), der
  Backend-Vertrag ist aber so definiert und getestet.
- **Namensmatch**: case-insensitive Substring über `to_lowercase` auf den
  **Dateiname/Ordnernamen** (nicht den vollen Pfad). Bewusst **kein**
  volles Unicode-Case-Folding und keine NFC-Normalisierung (kein
  `ß`/`SS`-Äquivalenz o. ä. — Randfall ohne Extra-Dependency).
- **Ordner, dessen Name nicht matcht**: drin genau dann, wenn er
  (rekursiv) mindestens einen enthaltenen Treffer hat — sonst gestutzt.
- **Angepinnte Einzeldateien**: normaler Datei-Match.
- **Pin-Wurzeln selbst**: werden immer angezeigt, wenn sie Treffer
  enthalten; eine Pin-Wurzel ohne Treffer wird ausgeblendet.

### A3 — Walk-Verhalten = Baum-Verhalten, nicht Such-Verhalten

Der normale Baum zeigt Hidden-Dateien und gitignorierte Einträge (letzte
gedimmt). Der Filter-Walk übernimmt das: rekursives `read_dir` mit
Hidden sichtbar, `.git`-Verzeichnisse per Namensfilter draußen.
Gitignore-**Dimming** bleibt erhalten, weil das Filter-HTML über denselben
`item_html`-Pfad mit `git_ignore::matcher_for` rendert.
Symlink-/`.lnk`-Klassifikation läuft wie im Baum über `classify_entry`.
**Ordner-Links** (inkl. als Pin-Wurzel) sind im Filtermodus **Blatt-Knoten**
— nicht expandiert, kein rekursiver Walk in den Link hinein (Loop-sicher
ohne visited-Set; im Zweifel als Knoten sichtbar, wenn ihr **Name**
matcht). Datei-Links bleiben normale Datei-Knoten.

### A4 — `dir_contains_markdown`-Probe mit Kostendeckel

Für den Lazy-Modus („nur Markdown" ohne Namensfilter) braucht jeder
Ordner-Kandidat eine rekursive Probe „enthält (irgendwo) Markdown?" mit
Early-Exit beim ersten Fund. Deckel gegen pathologische Fälle
(`node_modules` u. ä.): nach **max. 2 000 besuchten Einträgen** bricht
die Probe ab und liefert `true` (Ordner wird angezeigt — falsches
Anzeigen ist harmlos, falsches Verstecken nicht). `.git` und
**Link-Verzeichnisse** werden übersprungen (kein Abstieg in Symlink-Loops;
Visit-Cap bleibt zweite Verteidigung). Die Probe cached **nicht** über
Aufrufe hinweg im Lazy-Modus (Baum wird bei jedem Expand ohnehin frisch
gelesen). Im Filter-Render-Lauf (`run_vault_filter`) werden
Probe-Ergebnisse pro Lauf in einer lokalen Map gememoized.

### A5 — Caps + Stale-Guard im Filter-Render-Modus

- Debounce im Frontend: 150 ms (Konvention wie Preview/Suche).
- Pro Filterlauf eine **runId**; das Frontend verwirft Antworten mit
  `runId < maxRunId` (Muster aus `vault/search.ts`). Der Command ist
  synchron-request/response (kein Event-Stream nötig — Baumaufbau ist
  ein Roundtrip), die runId läuft als Echo-Feld mit.
- **Zweiphasig**: (1) gestutzte Zwischenstruktur ohne Render-Cap; Walk-
  Sicherheitsdeckel **50 000** besuchte Einträge → `truncated` + Abbruch.
  (2) HTML-Render mit **Node-Cap 2 000** tatsächlich gerenderter Knoten
  → `truncated: true`. Damit kein sticky `truncated` durch spekulativ
  reservierte, später verworfene Ahnen; trefferlose Tiefe → leeres
  Ergebnis ohne Truncation-Flag. Frontend-Hinweis (i18n-Key) bei
  `truncated` — „No silent caps".
- Kooperativer Cancel wie in der Suche ist **nicht** nötig (ein
  Roundtrip, gedeckelt); ein neuer Lauf überschreibt per runId.

### A6 — Persistenz

`panel_state.rs::PanelStateData` (UI-Toggle-Konvention):

- `vault_filter_markdown_only: bool` (`#[serde(default)]`, Default aus)
- `vault_filter_bar_visible: bool` (`#[serde(default)]`, Default aus) —
  Sichtbarkeit der Filterzeile.
- `vault_filter_match_files: bool` / `vault_filter_match_dirs: bool`
  (serde-default **true**) — Match-Art (A7). Beide-aus wird im Frontend
  verhindert; liest das Backend dennoch beide false, behandelt es das
  wie beide true (fail-open, kein leerer Baum durch kaputten State).

Der Namensfilter-Text ist flüchtig.

### A7 — UX-Modell (Revision 2 · 2026-07-20, User-Feedback)

Die erste Fassung hielt Filterzustand und Zeilen-Sichtbarkeit
unabhängig — Ergebnis: gefilterte Ansicht ohne sichtbares
Bedienelement (Zeile zu, Filter aktiv) = unbedienbarer Baum. Neu:

- **Schließen = Aufräumen**: Zeile schließen (Funnel-Toggle, das
  X am Zeilenende, Escape bei leerem Input) leert IMMER die Query und
  verlässt den Filter-Render-Modus → Lazy-Baum. Ein aktiver
  Namensfilter ohne sichtbare Zeile kann nicht mehr existieren.
- **Zwei X**: das Zeilen-X (`#vault-filter-close`, immer sichtbar)
  schließt die Zeile; das Text-Lösch-✕ (`#vault-filter-clear`, nur bei
  nichtleerem Input) leert nur die Query, Zeile bleibt offen.
- **Persistente Präferenzen vs. flüchtiger Filter**: `.md`-Toggle und
  Match-Art überleben das Schließen (sie wirken im Lazy-Baum bzw. beim
  nächsten Öffnen) — NUR sie erzeugen das `filter-active`-Badge am
  Funnel. Die Query ist flüchtig.
- **Match-Art-Chips**: zwei Toggle-Chips „Dateien" (📄) / „Ordner" (📁)
  neben `.md`, beide default an. Sie steuern, was **matchen** darf —
  Ordner erscheinen bei „nur Dateien" weiterhin als Ahnen von
  Datei-Treffern, matchen aber nicht selbst (und umgekehrt erscheinen
  Dateien bei „nur Ordner" gar nicht, da sie weder matchen noch Ahnen
  sein können). Beide-aus wird abgefangen: der Klick, der den letzten
  aktiven Chip deaktivieren würde, aktiviert stattdessen den anderen
  (Umschalt-Geste).
- **Expand/Collapse im Filtermodus**: erlaubt, aber rein clientseitig —
  der Caret-Klick togglet nur die `collapsed`-Klasse im Filter-HTML;
  es gibt weiterhin KEIN `expand-dir`/`collapse-dir`-Post und keine
  Änderung an `expanded_dirs`.

## Backend (Etappe F1)

Neues Modul `src-tauri/src/vault_filter.rs` (DOM-frei testbar) +
Command-Anbindung in `commands/vault_cmd.rs`.

```rust
pub struct VaultFilterOptions {
    pub query: String,          // roher Filtertext; leer = kein Namensfilter
    pub markdown_only: bool,
    pub match_files: bool,      // A7: dürfen Dateien matchen? (Default true)
    pub match_dirs: bool,       // A7: dürfen Ordner matchen? (Default true)
}

pub struct VaultFilterResult {
    pub html: String,           // children-HTML der Pinned-Section (gestutzt, aufgeklappt)
    pub truncated: bool,
    pub node_count: usize,
}

pub fn run_vault_filter(
    pinned: &[PinnedItem],
    vault: &Vault,              // für item_html-Rendering (active-Marker etc.)
    opts: &VaultFilterOptions,
) -> VaultFilterResult;

pub fn dir_contains_markdown(dir: &Path) -> bool;  // A4-Probe
```

- Scope-Auflösung über `search::resolve_scope(pinned, SearchScope::Vault)`
  wiederverwenden (Overlap-Dedup gratis). Achtung Reihenfolge: die
  Anzeige folgt der **Pin-Reihenfolge**, nicht der Walk-Order — pro Pin
  ein eigener Walk, Ergebnisse in Pin-Reihenfolge konkateniert.
- Rendering über die bestehenden `Vault::item_html`-Bausteine
  (ggf. Sichtbarkeit modulintern anpassen / `pub(crate)`); im
  Filtermodus sind alle Ordner-Knoten `caret open` + Kinder inline.
- `build_dir_children_html` bekommt den Typ-Filter-Parameter für den
  Lazy-Modus (A1); Aufrufer-Signaturen (`on_expand`,
  `vault_expand_dir`-Command, `item_html`-Expanded-Pfad) reichen ihn
  durch. Quelle des Werts: `panel_state.vault_filter_markdown_only`.
- Neue/angepasste Commands:
  - `vault_filter(query, markdownOnly, matchFiles, matchDirs, runId) ->
    { html, truncated, nodeCount, runId }`
  - `vault_filter_options_get/set` für die vier Panel-State-Felder
    (bzw. in bestehende Panel-State-Commands integrieren, falls dort ein
    generisches Muster existiert — Implementierer entscheidet, aber
    KEINE neuen JSON-Dateien).
- Sortierung im Filterbaum wie im Baum: Ordner vor Dateien, dann Name.

### Tests F1 (TDD — Tests zuerst, Abnahme, dann Implementierung)

Rust-Unit-Tests in `vault_filter.rs` (TempDir-Fixtures):

1. Namensmatch case-insensitive auf Dateiname; Nicht-Treffer gestutzt.
2. Ordner-Name-Match zeigt den Ordner-Knoten, zieht aber NICHT den
   Subtree — Kinder bleiben namensgefiltert; matchender Ordner ohne
   matchende Nachfahren erscheint leer (Revision 2026-07-20).
3. Ordner ohne Treffer verschwindet; verschachtelte Treffer halten die
   gesamte Ahnenkette sichtbar.
4. `markdown_only` filtert Nicht-MD-Dateien; Ordner ohne MD verschwindet
   (kombiniert mit und ohne Query).
5. Pin-Einzeldateien: Match/Nicht-Match; Pin-Reihenfolge bleibt.
6. Hidden-/gitignorierte Dateien erscheinen (A3), `.git` nie.
7. Node-Cap: > 2 000 Knoten → `truncated`, HTML endet sauber.
8. `dir_contains_markdown`: Early-Exit-Fund, Kostendeckel liefert true,
   `.git`-Skip.
9. Lazy-Modus: `build_dir_children_html` mit Typ-Filter blendet
   MD-lose Ordner + Nicht-MD-Dateien aus.
10. `expanded_dirs` bleibt durch einen Filterlauf unverändert.

## Frontend (Etappe F2)

Neues Modul `src-tauri/web/app/vault/filter.ts` + Markup in
`dist/index.html` + CSS in `styles/` (bestehende Vault-Dateien).

### UI

- **Funnel-Button** im `vault-header` (neben `addFile`/`addFolder`,
  `.vault-cmd ti-emoji`): togglet die Filterzeile, Zustand →
  `vault_filter_bar_visible`. Bei aktivem Filter (Query nichtleer ODER
  markdown_only) trägt der Button eine Akzent-Markierung (Klasse
  `filter-active`), damit ein wirksamer Filter bei eingeklappter Zeile
  sichtbar bleibt.
- **Filterzeile** `#vault-filter` zwischen `#vault-search` und
  `#vault-tree`: Text-Input `#vault-filter-input` (Placeholder i18n),
  Toggle-Chip `#vault-filter-md` („.md", `aria-pressed`), Clear-Button
  `#vault-filter-clear` (nur sichtbar bei nichtleerem Input). Escape im
  Input leert ihn (Filtermodus endet), zweites Escape schließt die Zeile.
- Alle neuen Strings über `data-i18n-*` + Katalog-Keys (Namespace
  `vault.filter.*`), Kontextsätze in `locales/context/keys.json`,
  **alle 9 Kataloge** alphabetisch ergänzt, identische Key-Mengen
  (Referenz- und Markup-Gates sind hart).

### Verhalten

- Input debounced 150 ms → `vault_filter`-Command; Antwort ersetzt die
  Kinder der Pinned-Section im `#vault-tree` und blendet die
  Recent-Section aus (Klasse `filtering` auf `#vault-tree`; CSS regelt
  das Ausblenden). runId-Stale-Guard nach Suchmuster.
- Klicks im Filterbaum laufen über die bestehende delegierte
  Klick-Logik in `tree.ts` (data-path/Markup identisch) — Datei öffnen
  funktioniert unverändert. **Expand/Collapse-Klicks sind im
  Filtermodus inert** (Baum ist voll aufgeklappt; kein
  `expand-dir`-Post, sonst verschmutzt `expanded_dirs`).
- Filter leeren / Zeile schließen mit leerem Filter → Rückkehr in den
  Lazy-Modus über den bestehenden Rebuild-Pfad (`refreshVault()` →
  `vault_build_tree`), der `expanded_dirs`/Sections wiederherstellt.
- `markdown_only`-Toggle ohne Query: kein Filter-Render-Modus, sondern
  `vault_filter_options_set` + `refreshVault()` (Lazy-Modus rendert
  gefiltert, A1). Mit Query: neuer `vault_filter`-Lauf.
- Im Filtermodus eingehende `vault:refresh`/`vault:dir_changed`-Events:
  nicht auf den Filterbaum anwenden; stattdessen merken und beim
  Verlassen des Filtermodus einen `refreshVault()` fahren. (Der
  Lazy-Modus mit markdown_only behandelt beide Events normal.)
- `truncated: true` → Hinweiszeile über dem Baum (i18n-Key
  `vault.filter.truncated`).
- Pin-Reorder per Drag bleibt im Filtermodus **deaktiviert**
  (Pointer-Handler prüft `filtering`-Klasse) — die gefilterte Ansicht
  ist keine verlässliche Reorder-Basis.

### Tests F2

- vitest (jsdom, Muster `tests/vault/*.test.ts`): Debounce + runId-Guard
  (stale Antwort verworfen), Escape-Kaskade, Chip-Toggle ruft
  options_set + refresh, Filtermodus blendet Recent aus,
  Expand-Klick inert im Filtermodus, truncated-Hinweis, Rückkehr stellt
  Lazy-Baum wieder her (refreshVault-Aufruf), Funnel-Badge-Logik.
- E2E-Szenario `48_vault_filter.py` (Nummer nach aktuellem Stand
  vergeben): Fixture-Ordner mit MD/Nicht-MD/Unterordnern; Filterzeile
  öffnen (Klick), Query per `/eval` setzen + `input`-Event, Baum-DOM
  via `/dom` asserten (Treffer sichtbar, Nicht-Treffer weg, Ordner
  gestutzt), `.md`-Chip toggeln, Reset prüfen (Lazy-Baum + Recents
  wieder da). Screenshot-Baseline über den kanonischen Reset-Pfad;
  Reset muss den Filter räumen (Erweiterung von `lib/reset.py`:
  Filterzeile zu + Query leer + markdown_only aus).

## Abnahme-Gates (beide Etappen)

```bash
cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cd src-tauri/web && npm run build && npx vitest run
bash scripts/run-e2e.sh            # F2; mindestens das neue Szenario + Reset-relevante
```

i18n-Gates (Katalog-Sortierung, Key-Mengen, Referenzen, Markup-Leaf-
Safety) laufen in `cargo test` mit.
