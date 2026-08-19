# Spec — Vault-Dateioperationen vervollständigen

**Status**: V1 ✅ und V2 ✅ umgesetzt (2026-08-17, je mit Kreuz-Review durch
codex + agy und E2E-Voll-Lauf); V3 zurückgestellt
**Ausgangspunkt**: [`docs/feature-ideen.md`](feature-ideen.md) Top-Konsens #15
(„Vault-Dateioperationen vervollständigen", `[M]`, Quelle codex)

## Ziel

Der Vault-Baum kann heute Dateien anlegen, umbenennen und löschen —
Ordner nicht, und Verschieben/Duplizieren gibt es gar nicht. Diese Spec
schließt die Lücke, sodass der Baum ohne Umweg über den OS-Dateimanager
benutzbar ist.

## Scope-Entscheidungen (getroffen 2026-08-17)

- **Verschieben läuft über Ausschneiden/Einfügen**, nicht über
  Drag & Drop. Begründung: Cut/Copy/Paste deckt Verschieben *und*
  Kopieren-woandershin mit einem Modell ab, ist über die Automation-API
  testbar und teilt sich kein `pointerdown` mit dem bestehenden
  Pin-Reorder-Drag in `vault/tree.ts`. DnD bleibt als möglicher
  Folgepunkt (V3) offen, nicht als Verpflichtung.
- **Mehrfachauswahl ist zurückgestellt** (V3). Grund ist ein echter
  Gestenkonflikt: Einfachklick öffnet, `Ctrl`+Klick ist mit „In neuem
  Tab öffnen" belegt — die Standardgeste für Mehrfachauswahl ist also
  vergeben. Welche Ersatzgeste (Alt+Klick, expliziter Auswahlmodus)
  richtig ist, lässt sich nach Praxiserfahrung mit den Einzel-Operationen
  besser entscheiden.

- **Auf Pin-Wurzeln gibt es kein „Löschen", wohl aber „Ausschneiden"**
  (Entscheid 2026-08-17). Löschen ist destruktiv: ein Fehlklick auf der
  Wurzelzeile eines gepinnten Projektverzeichnisses schöbe den ganzen
  Ordner in den Papierkorb, und gemeint ist dort fast immer „Aus Vault
  entfernen" (unpin), das bereits existiert. Ausschneiden ist **nicht**
  destruktiv — `perform_move` migriert den Pin sauber mit, das Projekt
  bleibt ein Top-Level-Pin mit neuem Pfad. Die Analogie zwischen beiden
  trägt also nicht; ein Cut-Verbot nähme dem Nutzer nur die einzige
  Möglichkeit, ein gepinntes Verzeichnis über die UI zu verschieben.
  Gepinnte **Einzeldateien** bleiben löschbar: dort ist der Schaden
  lokal und das Verhalten stammt aus der Zeit vor V1.

## Nicht-Ziele

- Kein Überschreiben bestehender Ziele. Kollision ist immer ein Fehler
  mit Meldung, nie ein stiller Ersatz.
- Kein Verfolgen von Symlinks beim rekursiven Kopieren (Zyklusgefahr).
- Keine Undo-Historie für Dateioperationen. Löschen geht in den
  Papierkorb (`trash`), der Rest ist bewusst endgültig.
- Keine Fortschrittsanzeige für große Kopien in V1/V2.

---

## Der eigentliche Kern: Pfad-Migration

Die Datei-IO ist der einfache Teil. Der Aufwand steckt darin, dass ein
Pfad an vielen Stellen im State gehalten wird. `perform_rename`
(`commands/file/rename.rs`) migriert heute **genau einen** Pfad; bei
Ordner-Operationen müssen dieselben Halter **präfixweise** wandern.

### Betroffene Pfad-Halter

| Ort | Feld | Anmerkung |
|---|---|---|
| `TabManager` | `document_store.path` | aktiver Tab `rename_to` (emittiert `document:loaded` mit neuem `kind`/`language`), inaktive `rename_to_silent` |
| `TabManager` | `Tab::pending_path` | Restore-Tab ohne Load — nur `retarget_pending_path`, kein Watcher, kein Datei-IO |
| `NavigationController` | Entry-Pfade pro Tab | heute nur `navigate(new_path)` = neuer Eintrag. Für den Ordnerfall eine Methode `rewrite_prefix(old, new)` ergänzen, die bestehende Einträge umschreibt |
| `Workspace` | `pinned` | Pin auf den Ordner selbst *und* auf Nachfahren |
| `Workspace` | `recent` | |
| `Workspace` | `image_dirs` | **Key und Value** sind Pfade — beide migrieren |
| `Workspace` | `last_export_dir` | |
| `Vault` | `active_path` | |
| `Vault` | `expanded_dirs` | plus Watcher: alte Pfade `unwatch`, neue `watch` (`vault_watcher`) |
| Wikilink-Index | — | `state.invalidate_wikilink_index()` — **vor** dem Tab-Remap, sonst rendert das synchrone `document:loaded` mit dem alten Index |
| Git-Status | — | `git_status::refresh_for_paths([old, new], …)` |
| `GitHeadWatcher` | `watched` | zeigt sonst weiter aufs alte `.git`; Sync-Helfer in `commands/workspace_cmd.rs` (Kreuz-Review 2026-08-17) |
| `TabManager` | `recently_closed` | Rename remappt, Löschen muss entfernen — sonst füllt sich der Stack mit toten Pfaden |
| Vault-Clipboard (V2) | `clip.path` | Frontend-Halter (`vault/clipboard.ts`): Rename remappt präfixweise, Löschen unterhalb und `sourceMissing` beim Paste leeren — sonst bleibt „Einfügen" im Menü und schlägt dauerhaft fehl |
| Menü | Recent-Submenü | `menu::refresh_recent_from_workspace` |

### Präfix-Match auf Segmentgrenze — Pflicht

```rust
fn is_under(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}
```

Ein nacktes `starts_with(root)` zieht `/a/notizen-alt` mit, wenn `/a/notizen`
verschoben wird. Dieselbe Falle steht schon beim Git-Filter in `CLAUDE.md`
und ist dort aus einem Kreuz-Review hervorgegangen — sie gilt hier
genauso.

### Vorschlag zur Ablage

Neues Modul `src/path_migration.rs` (top-level, neben `file_kind.rs`) mit
**Tauri-freier**, rein stringbasierter Kernlogik:

```rust
/// Liefert den migrierten Pfad, falls `path` unter `old_root` liegt.
pub fn remap(path: &str, old_root: &str, new_root: &str) -> Option<String>;
```

Darauf setzt in `commands/file/` eine Choreografie-Funktion auf, die
`perform_rename` ablöst bzw. verallgemeinert:

```rust
fn perform_move(old: &str, new: &str, state: &State<AppState>, handle: &AppHandle)
    -> Result<(), String>;
```

Alle Pfade werden wie überall auf Forward-Slashes normalisiert, bevor
verglichen wird (`CLAUDE.md` → Pfad-Normalisierung).

---

## Etappe V1 — Ordner-Parität + Neuer Ordner

### V1.1 Backend

**Neu: `create_directory(path) -> String`** (`commands/file/dir.rs`)
- Nach dem Muster von `create_file_at`: `\` → `/`, `..`-Komponenten
  ablehnen, `fs::create_dir` (**nicht** `create_dir_all` — ein Tippfehler
  im Namen soll keine Zwischenordner anlegen).
- Existiert das Ziel → `errors.file.alreadyExists` mit Basename als
  `{detail}`.
- Danach `compute_refresh_delta_synced` + `vault:refresh` wie
  `create_file`. Wikilink-Invalidierung ist hier **nicht** nötig (leerer
  Ordner ist kein Kandidat), Git-Status auch nicht (git kennt keine
  leeren Ordner).

**Erweitert: `rename_file` akzeptiert Verzeichnisse.**
- `perform_rename` → `perform_move` (siehe oben) mit vollständiger
  Präfix-Migration.
- Zusätzliche Validierung: Ziel darf kein Nachfahre der Quelle sein
  (`is_under(new, old)` → Fehler, sonst schiebt `fs::rename` einen Ordner
  in sich selbst).
- Cross-Device: `fs::rename` schlägt bei `EXDEV` fehl (im Vault real, wenn
  Pins über Mountpoints liegen). Fallback: rekursiv kopieren, danach
  Quelle löschen — nur wenn die Kopie vollständig durchlief.

**Neu: `trash_path(path)`** — `trash_file` verallgemeinern, nicht daneben
kopieren.
- Ordner rekursiv in den Papierkorb.
- **Alle** Tabs unterhalb des Ordners schließen (heute: genau einer per
  `find_by_path`), gleiche Fehler-Toleranz wie heute: nach dem
  unwiderruflichen `trash::delete` darf ein Fehler beim Tab-Close die
  Aufräumarbeit **nicht** per `?` abbrechen — nur `tracing::warn!`.
- Pins/Recents unterhalb entfernen, `expanded_dirs` + Watches darunter
  aufräumen.

**Nachtrag 2026-08-18 — Watcher-Suspend vor `trash::delete` (Windows).**
Auf Windows scheiterte das Löschen eines **Ordners** zuverlässig mit
`Unknown { description: "Some operations were aborted" }`, sobald ein Tab
auf eine Datei darunter offen war. Ursache ist kein Pfad- oder
Rechteproblem: `notify` nutzt auf Windows `ReadDirectoryChangesW` und hält
damit ein offenes Verzeichnis-Handle — beim Tab-Watcher
(`DocumentStore::watch`) auf dem **Elternverzeichnis** der beobachteten
Datei, beim `VaultWatcher` auf jedem aufgeklappten Ordner, beim
`GitHeadWatcher` auf dem aufgelösten `.git`. Die Windows-Shell
(`IFileOperation`, vom `trash`-Crate benutzt) bricht den Move in den
Papierkorb bei einem solchen Handle ab. Isoliert funktionieren einzelne
Datei, Ordner ohne offene Tabs, Ordner mit Junction und Junction direkt —
nur die Kombination „Ordner + offener Tab darunter" bricht.

Deshalb legt `suspend_watches_under` **vor** `trash::delete` alle Watcher
unterhalb des Pfads still: Tab-Watcher über `TabManager::ids_under` +
`DocumentStore::unwatch` (State bleibt unberührt), `VaultWatcher` über
`watched_under` + `unwatch`, `GitHeadWatcher` über `unwatch_under`. Die
Reihenfolge „erst löschen, dann State aufräumen" bleibt davon unberührt —
suspendiert wird nur das Handle, nicht der Zustand. Schlägt
`trash::delete` fehl, stellt `restore_watches` alles wieder her
(`DocumentStore::rewatch`, `VaultWatcher::watch`, erneutes
`sync_git_head_watcher`) und der bestehende Fehler-Return bleibt; im
Erfolgsfall bleibt es beim Suspend, weil die Tabs gleich geschlossen, die
Vault-Pfade gepruned und der GitHeadWatcher ohnehin neu gesynct werden
(`VaultWatcher::unwatch` ist für nicht-registrierte Pfade ein No-op).
Bewusst **ohne** `cfg(windows)`: ein Codepfad, auf Linux harmlos. Der
EXDEV-Move-Pfad (`rename.rs`/`fs_copy.rs`) bleibt unverändert — er nutzt
`fs::rename`/`fs`-Löschung und ist von der Shell-Semantik nicht betroffen.

Der Restore spielt den Vault-Snapshot **nicht blind** zurück: `trash::delete`
läuft lockfrei, in der Zeit kann der User einen Ordner zuklappen: dessen
`unwatch` ist wegen des Suspends ein No-op, und ein blindes Re-Watch
hinterließe einen Watch, den `expanded_dirs` nicht kennt und den niemand mehr
deregistriert. `restore_watches` filtert die Kandidaten deshalb über
`Vault::is_expanded` gegen den aktuellen State — Lock-Reihenfolge wie in
`rename.rs::remap_vault_and_watchers`: erst `vault`, freigeben, dann
`vault_watcher`, nie beide gleichzeitig.

Zwei bewusst offene Restfenster. (1) Zwischen Suspend und `trash::delete`
kann ein parallel laufender Command (Tab-Open unter dem Pfad,
Ordner-Expand) ein neues notify-Handle anlegen; bei konkurrierender
Bedienung bleibt der Windows-Fehler damit möglich. Eine globale
Dateioperations-Sperre wird dafür **nicht** gebaut — das ist dieselbe
akzeptierte Klasse wie das Residual-TOCTOU in `rename.rs::perform_move`
(„der Nutzer ist im Vault der einzige Akteur"), und der Fehlerfall heilt
sich mit einer sichtbaren Meldung und einem zweiten Klick. (2) Eine externe
Änderung im Suspend-Fenster bleibt unbemerkt: `DocumentStore::rewatch`
registriert nur neu und gleicht nicht ab. Ein Abgleich hätte keinen
billigen Hook (der Store trackt nur `file_size`, kein mtime/Hash;
`reload_if_changed` würde ungespeicherte Änderungen verwerfen; der
`external_changed`-Callback nimmt selbst den `tabs`-Lock, unter dem der
Restore läuft → Selbst-Deadlock). Der Pfad ist Fehlerpfad-only, das nächste
FS-Event heilt ihn; Begründung steht am `rewatch`-Doc-Kommentar. (3) Beim
Fehler-Restore bleibt zwischen der `still_expanded`-Prüfung und dem
`vault_watcher`-Lock ein Mikrofenster für ein paralleles Collapse — dasselbe
Fenster hat by design jeder Pfad, der Watch-Listen unter dem `vault`-Lock
berechnet und erst danach anwendet (`remap_vault_and_watchers`). Schaden:
ein Zombie-Watch, der sich beim nächsten Expand/Collapse selbst heilt.

### V1.2 Frontend

`vault/context-menu.ts`:
- Für `isDir`: **„Neuer Ordner…"**, **„Umbenennen"**, **„Löschen"**
  ergänzen. Löschen bleibt unten, durch Separator abgesetzt, mit
  `ctx-item-danger`.
- Für Dateien: **„Neuer Ordner…"** neben „Neue Datei…" (legt im
  Elternordner an — gleiche `dir`-Herleitung wie beim bestehenden
  `new-file`-Zweig).
- Zwei neue Icons im `ICONS`-Record (`new-folder`, ggf. `duplicate`/
  `cut`/`paste` erst in V2). Stil: 16×16, `stroke="currentColor"`,
  kein `width`/`height`.

`startInlineRename`:
- Der `data-kind !== 'dir'`-Filter fällt weg. Bei Ordnern wird der
  **ganze Name** vorselektiert (kein Endungs-Split am letzten Punkt).

Lösch-Bestätigung:
- Eigener Text für Ordner. Wenn unterhalb des Ordners **ungespeicherte**
  Tabs liegen, muss der Dialog das benennen — die Tabs werden mit
  `DirtyPolicy::Discard` geschlossen, das darf nicht überraschen.

### V1.3 i18n

Neue Keys unter `vault.contextMenu.*` und `errors.file.*`, in **allen**
Katalogen unter `src-tauri/locales/` (alphabetisch sortiert, identische
Key-Mengen) plus je ein englischer Kontextsatz in
`locales/context/keys.json`. Die Referenz- und Markup-Gates sind hart.

### V1.4 Tests

- **Rust-Unit**: `path_migration::remap` — Segmentgrenze (`/a/notizen`
  zieht `/a/notizen-alt` **nicht** mit), Identität, Nicht-Treffer,
  Backslash-Eingabe. `create_directory`: Erfolg, Kollision,
  `..`-Ablehnung, kein `create_dir_all`-Verhalten.
- **Rust-Unit**: Ordner-Move migriert Pins/Recents/`image_dirs`
  (Key *und* Value) präfixweise.
- **vitest**: Kontextmenü-Aufbau für `isDir` (welche Items erscheinen),
  Inline-Rename-Selektion bei Ordnern.
- **E2E** `59_vault_fileops.py`: eigene Fixture unter einem **festen**
  Temp-Pfad (`/tmp/folio-e2e-fileops`) — begründet wie bei 56/57: der
  Pfad steht im Vault-Baum und in der Statusleiste und ist damit Teil
  der Visual-Baseline. Deckt ab: Neuer Ordner, Ordner umbenennen (Pin
  darunter wandert mit), Ordner löschen mit offenem Tab darunter.

---

## Etappe V2 — Duplizieren + Ausschneiden/Kopieren/Einfügen

### V2.1 Backend

**`duplicate_entry(path) -> String`**
- Kollisionsfreier Name nach Muster `name copy.md`, dann
  `name copy 2.md`, … Der Zähler zählt hoch, bis `create_new` bzw. das
  Zielverzeichnis frei ist; die Endung bleibt hinten (`a.tar.gz` →
  `a.tar copy.gz` ist akzeptabel, `stem`/`extension` von `std::path`).
- Ordner werden rekursiv kopiert.

**`copy_entry(src, dest_dir) -> String`** und
**`move_entry(src, dest_dir) -> String`**
- `move_entry` teilt sich `perform_move` mit dem Rename — es *ist* ein
  Rename mit anderem Elternverzeichnis.
- Validierung für beide: `dest_dir` existiert und ist ein Verzeichnis;
  Ziel darf nicht existieren; `dest_dir` darf kein Nachfahre von `src`
  sein; `src`-Elternordner == `dest_dir` bei `move_entry` → No-op-`Ok`.

**Rekursives Kopieren** (geteilter Helfer)
- Symlinks werden **nicht** verfolgt: als Symlink kopieren wo möglich,
  sonst überspringen und im Ergebnis vermerken. Nie durchlaufen.
- Bei Fehler mitten im Kopieren: bereits Kopiertes stehen lassen und den
  Fehler melden. Kein Rollback-Versuch (halbes Aufräumen ist gefährlicher
  als ein sichtbarer Teilzustand).

### V2.2 Frontend

Neues Modul `vault/clipboard.ts` — reiner Modul-State, keine Persistenz:

```ts
type VaultClip = { path: string; mode: 'cut' | 'copy' } | null;
```

- Kontextmenü Datei **und** Ordner: „Ausschneiden", „Kopieren",
  „Duplizieren".
- Kontextmenü Ordner zusätzlich: „Einfügen" — nur wenn der Clip gefüllt
  ist, sonst Item weglassen (nicht `disabled` zeigen; das Menü ist heute
  durchgängig ohne Dead-Items gebaut).
- Nach erfolgreichem `move_entry` wird der Clip geleert, nach
  `copy_entry` bleibt er (mehrfaches Einfügen ist üblich).
- Ausgeschnittener Eintrag bekommt bis zum Einfügen eine CSS-Klasse
  (`vault-cut`, gedimmt wie `ignored`) — sonst ist der Zustand unsichtbar.
- Tastatur (`Strg+X`/`C`/`V`) erst, wenn Vault-Fokus modelliert ist —
  in V2 **nicht** enthalten, damit die Kürzel nicht global den Editor
  beschneiden.

### V2.3 Tests

- **Rust-Unit**: Namensfindung beim Duplizieren (`a.md` → `a copy.md` →
  `a copy 2.md`), Ablehnung „Ordner in eigenen Nachfahren", rekursives
  Kopieren inklusive Symlink-Verhalten.
- **vitest**: Clipboard-Zustandsmaschine, Menüaufbau mit/ohne Clip.
- **E2E**: Erweiterung von `59_vault_fileops.py` um Duplizieren und
  Ausschneiden→Einfügen (Pin/Tab wandert mit).

---

## V3 — zurückgestellt

- **Mehrfachauswahl** im Baum samt Sammel-Operationen (Gestenkonflikt,
  siehe oben).
- **Drag & Drop** als zweiter Eingang fürs Verschieben. Muss sich das
  `pointerdown` mit dem Pin-Reorder teilen und braucht Auto-Expand beim
  Hovern über geschlossenen Ordnern.
- **Tastenkürzel** `Strg+X`/`C`/`V` im Vault, sobald es einen
  modellierten Vault-Fokus gibt.
- **Fortschritt/Abbruch** bei großen Kopien.
- **Stale Frontend-Caches nach einem Ordner-Move** (Befund Kreuz-Review
  2026-08-17, bewusst nicht in V1): Offene Suchergebnisse
  (`vault/search.ts`: `scopePath`, Treffer- und Jump-Pfade), der
  Tag-Browser-Cache (`vault/tags.ts::lastResult`) und das Backlink-Panel
  halten Pfade, die kein Modul migriert — ein Klick landet danach auf
  einem toten Pfad. Bewusst zurückgestellt, weil Suchergebnisse in folio
  ohnehin ein Snapshot sind (dasselbe passiert heute bei externen
  Dateiänderungen). Sauber wäre eine Invalidierung auf `vault:refresh`.
- **Atomarer No-Replace beim Rename selbst.** `Path::exists()` +
  `fs::rename` ist ein TOCTOU-Paar, und bei einem *dangling* Symlink als
  Ziel ist `exists()` sogar deterministisch `false`. Portabel lösen lässt
  sich das nicht: `renameat2(RENAME_NOREPLACE)` ist Linux-spezifisch und
  nicht auf jedem Dateisystem verfügbar, macOS kennt es nicht, Windows
  ist über `MoveFileEx` ohnehin no-replace. Akzeptiertes Restrisiko —
  das Fenster ist mikroskopisch und der Nutzer ist im Vault der einzige
  Akteur. Der praktisch gefährliche Teil, der Kopierpfad, ist über
  `create_new` atomar.
- **Inline-Rename verliert das Rennen gegen einen Tree-Rebuild** (Befund
  beim E2E-Voll-Lauf 2026-08-17, Produktseite — nicht nur Test):
  `startInlineRename` sucht die Zeile im DOM und ist ein **stiller No-op**,
  wenn sie gerade nicht dasteht. Ein vorangegangenes `tab_open` stößt über
  `vault:refresh` → `refreshVault` einen asynchronen Rebuild an, der die
  Zeile kurz ersetzt; wer eine Datei öffnet und sofort im Baum umbenennt,
  klickt „Umbenennen" und es passiert nichts. Das E2E-Szenario umgeht das
  mit Retry (`_rename_via_context`). Sauber wäre, dass der Aufruf den
  Rebuild abwartet statt aufzugeben — oder wenigstens eine sichtbare
  Rückmeldung gibt. Bestand schon vor V1 (Dateien), fällt bei Ordnern nur
  häufiger auf.
- **Pfad-Migration ist case-sensitiv** (Befund Kreuz-Review 2026-08-17,
  bewusst nicht in V2): `is_under`/`remap` vergleichen nach der
  Slash-Normalisierung bytegenau. Auf case-insensitiven Dateisystemen
  (Windows, viele macOS-Volumes) kann ein Tab als `C:/Vault/Dir/a.md`
  offen sein, während der Tree-Knoten `c:/vault/dir` als Move-Quelle
  liefert: Der Move gelingt, die Halter mit abweichender Schreibweise
  bleiben aber auf dem alten Pfad. Zurückgestellt, weil das
  Plattformsemantik quer durch `path_migration`, Workspace, Vault und
  Tabs zieht und auf Linux nicht auslösbar ist — gehört zur ohnehin
  offenen Windows-Verifikation (siehe `TODO.md`). Achtung beim Umbau:
  Das Suffix darf nicht über Indizes eines case-gefalteten Strings
  berechnet werden.
