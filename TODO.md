# TODO

> **Ideensammlung**: Was hier steht, ist das *Beschlossene*. Die offene
> Wunschliste liegt in [`docs/feature-ideen.md`](docs/feature-ideen.md)
> (Brainstorming aus vier Quellen, mit Aufwandsschätzung und Vermerk,
> was bereits umgesetzt ist). Beim Beantworten von „was steht an?" beide
> Dateien ansehen — hier die Verpflichtungen, dort die Optionen.

## Hohe Priorität

- **Hex-Ansicht verriegelt sich still bei Revisions-Versatz** (Befund
  macOS-Verifikationslauf 2026-08-19, reproduzierbar; E2E `61_hex_view`,
  Schritt „Dokumentwechsel setzt die offene Suche auf das neue Dokument").
  Nach einem Dokumentwechsel mit offener Hex-Suche bleibt die Ansicht
  **dauerhaft** auf `status: "loading"`, `loadedChunks: []` — ohne
  Fehlermeldung und ohne Retry. Auch nach 30 s unverändert.

  **Mechanik** (im Stall-Moment direkt am Backend gemessen):

  ```
  read_file_chunk(rev=27) -> ERR stale:revision 27 != 28
          rev=28          -> OK
  ```

  Das Frontend hält Revision 27, das Backend steht auf 28; jeder Chunk-Read
  wird abgelehnt. Der Stale-Zweig in `view/hex.ts:620-625` setzt daraufhin
  `fetchPaused = true`, leert die Queue und kehrt **vor** `setStatus('error',
  …)` zurück. Danach steigen `requestChunk`, `pumpQueue` und der
  `finally`-Zweig alle sofort bei `fetchPaused` aus — der Zustand ist still
  verriegelt.

  **Nur Neu-Öffnen heilt** (gemessen): Scrollen → bleibt `loading`, Suche
  schließen → bleibt `loading`, Datei erneut öffnen → `ready`. Grund:
  `mountHexView` ist der einzige Pfad, der `bumpGeneration()` ruft, und nur
  dort wird `fetchPaused` zurückgesetzt.

  **Zwei Defekte, getrennt zu beheben**:
  1. Die Revision des Hex-Views läuft bei diesem Wechsel dem Backend
     hinterher (Ursache noch offen — Verdacht: der Wechsel mit aktiver
     Suche bumpt die Revision erneut, nachdem das `document:loaded`-Payload
     raus ist).
  2. Wichtiger: Der Stale-Zweig darf keinen Zustand ohne Ausweg
     hinterlassen. Aktuelle Revision neu ziehen und den Fetch fortsetzen —
     und als Fallback einen sichtbaren, retry-baren Fehler setzen. Sonst
     wird aus jedem Revisions-Versatz ein toter Tab.

  **Nicht neu**: identische Signatur schon vor dem Pfad-Fix (`fcc0560`).
  Unter Linux läuft das Szenario grün; ob macOS-spezifisch oder nur ein
  Timing, das dort zuverlässig getroffen wird, ist offen.

## Mittlere Priorität

- **Hex-Ansicht: Härtungspaket** (aus dem Kreuz-Review, bewusst vertagt) —
  `/state` nimmt Pfad/Kind/Größe unter dem Tabs-Lock, die Hex-Felder danach
  asynchron aus der Surface; bei einem Tabwechsel dazwischen fehlt der
  Identitätsvergleich (betrifft nur Automation). Prev/Next brauchen
  lokalisierte `aria-label` — die `title`-Attribute ersetzen den aus „◀/▶"
  gebildeten Accessible Name nicht. E2E `61_hex_view` akzeptiert beim
  History-Schritt noch zwei Ziele, prüft die Gate-Matrix nur teilweise und den
  Inhalt nach einem Truncate gar nicht; Resize-, RAF- und Tastaturtests fehlen.

- **Windows-Verifikationsdurchgang — DURCHGEFÜHRT 2026-08-18** (per
  Automation-API gegen das Release-Binary, 18/21 Checks grün; die
  E2E-Suite selbst läuft auf Windows weiterhin nicht, siehe eigener
  Eintrag unter „Niedrige Priorität"). Ergebnis der sechs Punkte:

  1. ✅ **Git-Pipe-Deadlock**: Repo mit 1 500 geänderten/untrackten
     Einträgen (73 KB porcelain-Output, weit über Windows' 4-KiB-Puffer)
     — Dots nach 1,3 s, der Reader-Thread-Fix in
     `wait_child_with_timeout` greift auch auf Windows.
  2. ⚠️ **Verzeichnis-Junctions beim Kopieren** (`fs_copy.rs`): Junction
     wird als `is_symlink_dir` erkannt, beim Duplizieren NICHT verfolgt
     (kein Rekursions-Leak ins Junction-Ziel), Fehler
     `copySkippedSymlinks` sichtbar, Quelle intakt. **Restpunkt**: der
     Erfolgs-Zweig (Junction wird als Symlink-Kopie angelegt) und der
     `remove_entry`-Zweig (Junction via `remove_dir` löschen) brauchen
     Developer Mode / Symlink-Privileg und bleiben unverifiziert.
  3. ✅ **EXDEV + skipped_symlinks behält die Quelle**: Move D:→C: ohne
     Links läuft durch (Fehlercode-17-Erkennung greift, Tab wandert
     mit); Move mit Junction schlägt sichtbar fehl, Quelle vollständig
     erhalten — kein Datenverlust. **Restpunkt**: die partielle
     Zielkopie bleibt nach dem Fehlschlag am Ziel liegen (kein Cleanup
     in `rename_or_copy`) — abwägen, ob aufräumen oder dokumentieren.
  4. ✅ **Case-only-Rename** `Foo` → `foo`: gelingt (kein
     `targetAlreadyExists`), Verzeichnis trägt die neue Schreibweise,
     Tab migriert — `is_case_only_same_entry` greift.
  5. ✅ **Case-insensitive Pfad-Migration**: bekannter Befund exakt wie
     in [`docs/spec-vault-fileops.md`](docs/spec-vault-fileops.md)
     dokumentiert reproduziert (Rename über abweichende Schreibweise
     gelingt auf der Platte, Tab bleibt auf dem alten Pfad zurück).
     Bewusst nicht gefixt, Eintrag bleibt dort bestehen.
  6. ✅ **Ordner in den Papierkorb**: Backslash-Konvertierung und
     Verzeichnisse an sich funktionierten von Anfang an (Datei, Ordner,
     Ordner mit Junction, Junction einzeln alle grün) — mit offenem Tab
     unterhalb schlug es fehl (Watcher-Handle blockierte den Shell-Move).
     **Behoben 2026-08-19**: `trash_path` suspendiert vor `trash::delete`
     alle Watcher mit Handles unter dem Pfad (Tab-DocumentStore,
     VaultWatcher, GitHeadWatcher) und stellt sie nur im Fehlerfall
     wieder her — Restore gegen den aktuellen Vault-State gefiltert.
     Auf Windows verifiziert; bewusst offene Restfenster stehen in
     [`docs/spec-vault-fileops.md`](docs/spec-vault-fileops.md).

- **Wikilink-W7-Unit-Tests schlagen auf Windows fehl** (Befund beim
  Windows-Durchgang 2026-08-19, vorbestehend und unabhängig vom
  Papierkorb-Fix): `cargo test --lib` → 6 Failures, alle
  `wikilink::tests::w7_*` — auf dem sauberen HEAD reproduzierbar
  (`7 passed; 6 failed`). Vermutlich Pfad-/Case-Annahmen der
  W7-Lokalitäts-Tests, die nur auf Linux gelten. Dazu passend meldet
  `cargo clippy --all-targets -- -D warnings` auf Windows 7 vorbestehende
  Errors in `#[cfg(unix)]`-gerahmtem Test-Code (unused imports/Variablen in
  `transfer.rs`, `fs_copy.rs`, `unreachable statement` in `palette.rs:256`)
  — auf Linux unsichtbar, bricht aber jedes Windows-Gate.

- **E2E `42_mermaid` flaky — Fix 2026-07-25, Beobachtung**: erneut
  aufgetreten (2026-07-21 + 2026-07-25, „mermaid svg nicht gefunden").
  Ursache verstanden: `/dom`-`timeoutMs` wartet nur auf die
  Snapshot-Antwort des Frontends, NICHT auf das Erscheinen des
  Selektors — das vermeintliche 5-s-Fenster war wirkungslos, der
  Lazy-Bundle-Load (3,3 MB) unter Xvfb-Last verlor das Rennen. Fix:
  echter Retry-Poll (15 s svg / 5 s error-Hinweis) im Szenario;
  Voll-Lauf danach 2x grün. Bei erneutem Auftreten trotz Poll →
  Bundle-Load selbst untersuchen (Script-Injection-Fehlerpfad).

- **E2E `30_tabs_ui` flaky — Fix 2026-07-09, Beobachtung offen**: dreimal
  im Voll-Lauf gefailt („Undo-Stack hat den Tab-Wechsel nicht ueberlebt",
  2026-07-06/08/09), nie im Einzellauf. Race-Analyse (codex+agy+Claude):
  zwei komplementäre Mechanismen derselben Klasse — (a) die Test-Polls
  lesen den Backend-Store, der beim `tab_activate` sofort umschaltet,
  während Monacos Model-Swap asynchron folgt (ein zu früh eintreffendes
  `undo` träfe das falsche Model); (b) ein verspätet zugestelltes
  `document:loaded` nimmt bei bereits aktivem Tab den Same-Tab-Pfad in
  `editor/mount.ts` und löscht via `setValue` still den Undo-Stack
  (`withProgrammaticWrite` unterdrückt den Backend-Sync — Frontend und
  Store divergieren dann unbemerkt). Fix: `document:loaded` trägt eine
  monotone `seq`; `state/document.ts` verwirft veraltete/duplizierte
  Events (Produkt-Härtung gegen b, vitest-Abdeckung), und Szenario 30
  pollt vor dem Undo das FRONTEND-Model auf den Marker
  (Sync-Barriere gegen a). Da der Flake nur ~1x pro Dutzend Voll-Läufe
  auftrat, ist der Beweis statistisch: bei erneutem Auftreten trennt
  die neue Frontend-Assertion die beiden Mechanismen sauber.

- **Menu-Keybindings (Accelerators) greifen oft nicht**: Viele der nativen
  Tauri-Menü-Accelerators (Ctrl+S Speichern, Ctrl+Z Undo, Ctrl+W Schließen,
  Ctrl+1/2/3 Mode, …) feuern nicht zuverlässig — User-Bericht 2026-05-19.
  Ursache liegt vermutlich darin, dass WebView2 die Tasten verschluckt,
  bevor sie das Tauri-Menü erreichen (das Frontend hat heute für Ctrl+1/2/
  S/O/Shift+S/W/Q/B/I/K eigene DOM-Capture-Handler in
  `toolbar-actions.ts`, der Workaround dort bestätigt das Pattern).
  Saubere Lösung: prüfen, ob WebView2-spezifische Config
  (`accelerator_handler`) die OS-Bar früher dranlassen kann — bis dahin
  bleiben die DOM-Capture-Handler die Wahrheit.
  - **Update 2026-05-19**: DOM-Capture-Handler ergänzt um
    **Ctrl+Shift+S** (Speichern unter), **Ctrl+W** (Schließen),
    **Ctrl+Q** (Beenden) sowie die MD-Editor-Shortcuts **Ctrl+B**
    (Bold), **Ctrl+I** (Italic), **Ctrl+K** (Link). Die Menü-Pfade
    laufen über einen neuen `menu_dispatch`-Tauri-Command, der
    `dispatch_menu_action` wiederverwendet — gleicher Code wie nativer
    Menü-Klick / Automation-API (`POST /menu/click`). Bold/Italic/Link
    rufen `applyCmd` nur wenn `body.edit-mode` UND `body.kind-markdown`
    aktiv sind. Der gesamte Listener läuft jetzt mit `capture:true`,
    weil Monaco u. a. Strg+K als Chord-Prefix bindet und sonst frisst.
  - **Windows-E2E-Run 2026-05-18 (`tests/e2e/scenarios/15_keybindings.py`)**:
    Im DOM-Capture-Pfad sind **Ctrl+1, Ctrl+2, Ctrl+F grün** (isolierter
    Sub-Run alle drei Steps in 0.27 s). **Ctrl+S triggert Save tatsächlich**
    (sample.md hatte nach dem Run `ctrl-s-test\n` angehängt). Der damals
    beobachtete `/wait`-Race für `document.saved` ist inzwischen behoben.
    Native Tauri-Menübar (z. B. echter Strg+W aus dem Menü) wurde nicht
    getestet, weil aus dem WebView nicht erreichbar.
  - **Update 2026-05-19 (2)**: Strg+Z / Strg+Shift+Z DOM-Capture
    nachgezogen. Anders als bei Strg+B/I/K greift der Fallback nur,
    wenn der Fokus NICHT im `#editor-mount` liegt — Monacos
    eingebautes Undo bleibt im Editor-Fokus unangetastet. Ohne Fokus
    im Editor (z. B. Vault-Tree aktiv) ruft der Handler
    `FolioEditor.undo()` / `.redo()`.
  - **Ctrl+Shift+Tab (Tab-Rueckwaertswechsel) kommt unter Linux nicht
    an** (User-Report 2026-07-04): Handler-Pfad ist verifiziert
    (synthetische Events inkl. ISO_Left_Tab-Guard funktionieren) —
    vermutlich schluckt WebKitGTK die Kombination vor der Seite.
    Niedrige Prio, Ctrl+Tab rotiert zyklisch.
  - **Restpunkt**: WebView2-`accelerator_handler`-Config existiert
    Rust-seitig noch nicht — die DOM-Capture-Handler bleiben bis dahin
    die Wahrheit (`toolbar-actions.ts:155-282`). Undo-Stack-Fix
    (`pushUndoStop` in `editor/text.ts:187,193`) ist erledigt; beim
    nächsten Windows-E2E-Run (`09_undo_redo`) nur noch validieren.

- **Settings-Ausbau — Reste** (das Theme-System ist komplett: Tab-
  Control + Etappen 3a View-Theme-Auswahl, 3b Custom-Themes, 3c
  Favoriten, 3d Export-Code-Highlighting via syntect; Fonts als
  Theme-Bestandteile sind seit E9 umgesetzt):
  - Kleinere offene Ausbaustufen aus dem alten Settings-Eintrag:
    **macOS-Terminal-Wahl** (`open_terminal_at` öffnet fix
    `Terminal.app`); **Theme-Reihe als Aggregations-UI** (Persistenz
    bleibt in `theme.rs`/`theme_get`/`theme_set`).

- **Tabs — Folgepunkte** (Kernfeature 2026-07-04 komplett, siehe
  [`docs/spec-multi-tabs.md`](docs/spec-multi-tabs.md)): optional
  „Neues Fenster"-Command (Tauri-Multi-Window) für echtes
  Nebeneinander; Monaco-Model-Cache ohne Cap (bei sehr vielen Tabs
  LRU erwägen).

## Niedrige Priorität

- **Wikilink-Index-TTL: gemessen und ENTSCHIEDEN 2026-08-13 — bleibt bei
  30 s.** Die offene Frage von 2026-07-26 (TTL hoch + Fokus-Invalidierung?)
  ist damit erledigt und soll nicht neu aufgerollt werden.
  **Messung** (`bench_real_workspace_index`, `#[ignore]`-Test in
  `wikilink.rs` — liest die realen Pins aus `workspace.json`, daher
  jederzeit wiederholbar): realer Workspace mit 17 Pins und ~8 200
  Dateien, Median **328 ms** vor der Parallelisierung, **205 ms**
  danach; Max von 739 auf 255 ms.
  **Warum der TTL trotzdem bleibt**: der Cache ist rein pull-basiert
  (`get_at`) — im Leerlauf läuft kein Timer, Kosten entstehen nur bei
  aktiver Nutzung. Der Rebuild läuft stale-while-revalidate im
  Hintergrund-Thread und blockiert den Render-Hot-Path nicht. Der
  einzige synchrone Pfad (`CacheAction::BuildSync`) greift nur ohne
  Cache-Eintrag oder bei Pin-Fingerprint-Wechsel — und genau der hat
  von der Parallelisierung am meisten profitiert. Eine
  Fokus-Invalidierung wäre zusätzliche Mechanik mit eigenen
  Fehlerquellen ohne belegten Nutzen.
  **Weiterhin gültig**: **keine** rekursiven Watcher auf die
  Pin-Wurzeln — läuft auf Linux bei mehreren Projektverzeichnissen
  gegen `fs.inotify.max_user_watches` und scheitert dann still.
  **Falls das Thema doch wiederkommt** (spürbar veraltete Wikilinks
  nach `git pull` o. ä.): der unangenehme Fall ist nicht der fehlende
  Link, sondern dass ein Klick auf eine extern angelegte Datei den
  „Notiz anlegen?"-Dialog zeigt. Dann zuerst den Bench erneut fahren.

- **Frontmatter-`aliases`** (Obsidian-Feature, Design 2026-07-26
  durchdacht — Umsetzung bewusst zurückgestellt): `aliases: [Zweitname]`
  in der YAML-Frontmatter macht eine Notiz unter weiteren Namen
  auflösbar. Nutzen im Multi-Projekt-Setup: Repo-Dateien mit generischen
  Namen unter sprechendem Namen erreichbar machen, ohne sie umzubenennen
  (`~/dev/folio/TODO.md` → `[[folio-roadmap]]`); Umbenennen ohne
  Linkbruch (alter Name als Alias); Abkürzungen/Sprachvarianten.
  **Kostenpunkt**: der Wikilink-Index baut sich heute rein aus
  Dateinamen auf, ohne eine Datei zu öffnen — Aliases erzwingen einen
  Inhalts-Scan aller MD-Dateien bei jedem Rebuild (TTL 30 s). Nötig
  wären Kopf-only-Lesen (Frontmatter steht oben, wenige KB) plus
  mtime-Cache; `frontmatter::extract` existiert bereits (Tags), der
  Tag-Scan liest ohnehin schon Inhalte. **Vorab zu entscheiden**:
  (a) echter Dateiname gewinnt gegen Alias bei Kollision
  (Obsidian-Verhalten); (b) Verhältnis zur W7-Lokalität — Vorschlag:
  erst Dateinamen nach Lokalität, dann Aliases nach Lokalität, damit
  ein lokaler Alias keinen fremden echten Namen schlägt;
  (c) mehrdeutige Aliases folgen derselben deterministischen Rangfolge
  wie Dateinamen, kein Dialog. **Erst nach Praxiserfahrung bewerten**:
  ggf. reichen sprechende Dateinamen im Notiz-Vault plus gelegentliches
  `[[projekt/TODO]]`.

- **Wikilinks — weitere Folgepunkte** (W1–W7 abgeschlossen, Spec
  [`docs/spec-wikilinks.md`](docs/spec-wikilinks.md)): Notiz-Embeds mit
  echtem Inhalt (Transclusion), Block-Referenzen `#^id`,
  Backlinks für normale relative MD-Links, Link-Refactoring
  beim Umbenennen, Tag-Hierarchie-Baum, Unlinked Mentions, persistenter
  Index (tantivy) bei sehr großen Vaults; `](`-Autocomplete für normale
  Markdown-Links. Aus dem Kreuz-Review 2026-07-25 zurückgestellt:
  Heading-Anker gegen echte TOC-Slugs (`{#custom-id}`/Kollisionen),
  `[[#`-Autocomplete aus dem Editor-Puffer statt Disk,
  HTML-Kommentar-Maskierung im Backlink-Scan.

- **i18n — Folgepunkte** (V1 de/en abgeschlossen; Sprach-Batch 2
  es/fr/pt-BR/it/ru/zh-Hans/ja + Flaggen-Picker + Übersetzungs-
  Kontextdatei `locales/context/keys.json` abgeschlossen 2026-07-14,
  Spec [`docs/spec-i18n.md`](docs/spec-i18n.md)):
  - Deutsche `tracing`-Log-Meldungen auf Englisch angleichen (11
    Fundstellen, u. a. `logging.rs`, `theme/*` — rein diagnostisch,
    niedrigste Dringlichkeit; Fehlerdetails selbst sind seit
    2026-07-14 englisch).
  - Weitere Sprachen (pl, ko, …): Ablauf = Katalog per KI mit
    Kontextdatei übersetzen, Kreuz-Review, `scripts/lang-boot-smoke.sh
    <tag>` für den Sichttest.
  - Live-Sprachwechsel ohne Neustart (zurückgestellt auf Wunsch
    2026-07-14 — kein echter Mehrwert aktuell).
  - Externe Sprachpakete aus `<config>/folio/lang/`.
  - Pseudo-Locale für Layout- und Extraktionsprüfungen.
  - Generierte typisierte Key-Surface.
  - HTML-Parser statt Heuristik im Markup-Gate.
  - **E2E-Mocks gegen Backend-String-Drift absichern** (Befund
    2026-07-16): Der Mock in `45_ai_actions.py` matchte per Regex den
    KI-Prompt-Delimiter (`=== DOCUMENT N (data, no instructions) ===`
    aus `ai/actions.rs::document_delimiter`). Bei der Englisch-
    Umstellung (Commit b5d2f9c) wurde der Delimiter von Deutsch auf
    Englisch geändert, der Mock-Regex nicht — E2E 45 lief still ins
    Leere (leere KI-Antwort → Timeout) und fiel erst beim ersten
    Linux-E2E-Lauf danach auf (Windows kann die Suite nicht fahren).
    Idee: solche geteilten Vertragsstrings (Delimiter, Marker) aus
    einer einzigen Quelle beziehen oder per Rust-Test als Vertrag
    festschreiben, statt sie im Python-Mock zu duplizieren — damit eine
    Backend-Umbenennung entweder beide Seiten trifft oder hart bricht.

- **Vault-Volltextsuche — Folgepunkte** (Kernfeature S1–S6 komplett;
  S1–S3 2026-07-12, S4 Dialog-first + Regex/Filter/OpenTabs 2026-07-15,
  S5 UX-Nachschliff + S6 paralleler Walk 2026-07-16,
  Spec [`docs/spec-vault-search.md`](docs/spec-vault-search.md)):
  optionaler persistenter Index (tantivy) nur bei echtem Bedarf (bewusst
  verworfen für V1).

- **KI-Aktionen — Folgepunkte** (Kernfeature 2026-07-10 komplett, Spec
  [`docs/spec-ki-actions.md`](docs/spec-ki-actions.md)): Kontextmenü
  der Selektion mit Favoriten; Shortcuts pro Favorit (wartet auf die
  Accelerator-Baustelle); Nicht-Markdown-Dateien als Quelle;
  Template-Editor-UI (heute Dateien + „Als Vorlage speichern").

- **KI-Integration — Folgepunkte** (Kernfeature und Dokumentübersetzung
  umgesetzt, Architektur in [`docs/spec-ki-tab.md`](docs/spec-ki-tab.md)):
  zusätzliche E2E-/Desktop-Verifikation auf macOS und Windows sowie weitere
  KI-Funktionen erst nach konkretem Bedarf. (Chunking sehr großer Dokumente
  bewusst verworfen, 2026-07-05 — kein erwarteter Bedarf.)

- **Live-Preview Rest** (Hauptfeature 2026-05-22; Code-View-Live + adaptive
  Debounce 2026-07-18):
  - **Heading-Anchor-Restore**: bewusst verworfen 2026-07-18 — zeilenbasierter
    Scroll-Sync deckt den Alltag ab; Heading-Restore wäre M-Aufwand ohne
    spürbaren Mehrwert im Split-Mode.
  - **Settings-Toggle für Debounce-Delay**: bewusst verworfen 2026-07-18 —
    adaptive Debounce (`clamp(150, measured*2, 600)`) macht manuelle
    Delay-Wahl überflüssig.

- **Image-Insert Folgepunkte** (Hauptfeature 2026-05-19 implementiert,
  siehe `commands/file/image.rs`, `ui/image-dialog.ts`,
  `ui/paste-handler.ts`):
  - **Drag-and-Drop** auf den Editor-Bereich als dritter Eingang neben
    Strg+V und Toolbar-Button. Drop-Position-zu-Cursor-Mapping über
    Monacos `editor.getTargetAtClientPoint(x,y)`.
  - **Bild-Resize / Qualitätswahl** im Dialog (gerade wird Clipboard
    immer als verlustfreies PNG re-encoded; größere Screenshots werden
    dadurch unnötig groß).
  - **JPEG/WebP-Re-Encoding** für Clipboard-Bilder als optionale Format-
    Auswahl im Dialog (image-Crate hat die Features schon aktiv).
  - **Auto-Anlegen von `images/`/`assets/`-Unterordnern** mit Konvention,
    falls der User das im Settings-Panel auswählt — wartet auf das
    Settings-Panel (Eintrag oben).
  - **E2E-Szenario** `23_image_paste.py`: Datei-wählen-Pfad lässt sich
    automatisieren; Clipboard-Pfad braucht echten Display, daher
    Xvfb-Skip-Marker oder `--include-desktop-only`.

- **E2E-Suite auf Windows lauffähig machen**: Aus dem Windows-Run 2026-05-18
  bleibt ein Stolperstein: **Visual-Baselines an Linux 1280×800
  gebunden** — 6 Szenarien (01–06) liefern auf einem 1920×1080-Monitor
  `size mismatch` und brechen am ersten Screenshot ab, obwohl ihre
  funktionalen Asserts grün waren. Optionen: vor dem Capture per
  `/resize` auf eine feste Größe, oder ein zweites Baseline-Set pro
  Plattform, oder Visual-Tests im `--attach`-Mode standardmäßig skippen.
  (Der zweite Stolperstein — `/open` blockte mit 409 bei dirty
  Recent-Datei — ist über das `discard`-Flag im `/open`-Body gelöst.)

- **Image-View Folgepunkte** (Hauptfeature 2026-05-21 implementiert,
  siehe `view/image.ts`, `file_kind.rs::FileKind::Image`,
  `document_store.rs::load_opaque`; Image-Watcher/Live-Reload bei
  externen Änderungen ist seit 2026-07-08 umgesetzt; Zoom/Pan seit
  2026-07-18 in `view/image-transform.ts` + `view/image.ts`):
  - **PDF-View**: WebView2 (Windows) hat einen eingebauten PDF-Viewer;
    WebKitGTK (Linux) **nicht** — bräuchte PDF.js (~2 MB extra Bundle).
    Plattform-Split ist unschön; abwägen ob lohnt.
  - **Audio/Video-View**: `<audio>`/`<video>` läuft cross-platform out
    of the box, analog zum Image-Pfad. Sinnvoll, wenn Bedarf entsteht.
