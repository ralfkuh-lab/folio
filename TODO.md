# TODO

## Mittlere Priorität

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
    (sample.md hatte nach dem Run `ctrl-s-test\n` angehängt) — das
    `document.saved`-Event wird vom `/wait`-API aber nicht eingefangen.
    Das ist ein anderer Befund als „Keybinding greift nicht" und gehört
    zum getrennten `document.saved`-Event-Race-Eintrag weiter unten.
    Native Tauri-Menübar (z. B. echter Strg+W aus dem Menü) wurde nicht
    getestet, weil aus dem WebView nicht erreichbar.
  - **Update 2026-05-19 (2)**: Strg+Z / Strg+Shift+Z DOM-Capture
    nachgezogen. Anders als bei Strg+B/I/K greift der Fallback nur,
    wenn der Fokus NICHT im `#editor-mount` liegt — Monacos
    eingebautes Undo bleibt im Editor-Fokus unangetastet. Ohne Fokus
    im Editor (z. B. Vault-Tree aktiv) ruft der Handler
    `FolioEditor.undo()` / `.redo()`.

- **~~`document.saved`-Event greift Wait-Poll nicht~~** — **gefixt
  2026-05-19**: `automation::wait` hat jetzt einen last-emitted-Buffer
  in `AppState.recent_events`. `signal()` aktualisiert den
  Timestamp; `already_satisfied()` greift fuer `document.loaded` und
  `document.saved` innerhalb `RECENT_EVENT_TTL_MS` (2 s) auf den
  Buffer zu — Late-Subscribers binnen TTL bekommen das Event noch.
  Tests in `wait.rs` decken den Fall ab (`already_satisfied_uses_recent_buffer_for_transient_events`,
  `recently_emitted_respects_ttl`). Auf Windows verifizieren beim
  naechsten E2E-Run.

- **Undo-Stack wird in `09_undo_redo` gecleared (Windows)** —
  **Hypothese-Fix 2026-05-20**: `applyReplace` in `editor/text.ts`
  ruft jetzt `editor.pushUndoStop()` direkt vor und nach dem
  `executeEdits`. Ohne das verschmilzt Monaco unter bestimmten Timings
  den vorhergehenden Type-Edit (`insertText("X")` via `trigger('type')`)
  mit dem darauf folgenden Voll-Range-Replace zu einem einzigen Undo-
  Eintrag — Undo entfernte dann beides auf einmal. Live-Verifikation
  auf Windows ist mit der aktuellen Dev-Setup-Lage umständlich; der
  Fix folgt Monacos Best-Practice (Stack-Stops trennen Edits) und ist
  defensiv. Beim nächsten Windows-E2E-Run validieren.

- **~~Pin → Vault-Tree-Eintrag erscheint nicht im DOM (Windows)~~** —
  **gefixt 2026-05-20**: Ursache war NICHT der `notify`-Watcher (wie
  vermutet), sondern eine Pfad-Konsistenz-Frage. Auf Windows kommen
  Pfade mit Backslashes ins Backend; der CSS-Selector
  `[data-path="C:\Users\..."]` im E2E-Test scheitert dann, weil
  Backslashes in CSS als Escape-Char interpretiert werden (`\U` =
  Unicode-Sequenz). Fix: `Workspace::pin/unpin/is_pinned/add_recent/
  remove_recent/image_dir/set_image_dir` und `Vault::set_active/
  on_expand/is_expanded` normalisieren Pfade intern auf Forward-
  Slashes; `Vault::item_html` rendert `data-path` ebenfalls mit
  Forward-Slashes; `Workspace::load_from` migriert bestehende
  Backslash-Pfade beim ersten Boot. E2E-Szenarien `16_vault_tree` und
  `19_context_menus` bauen den Selektor jetzt aus dem normalisierten
  Pfad. Windows-APIs akzeptieren beide Schreibweisen, daher rein
  Frontend/DOM-relevant. Verifiziert mit Backslash-Pin →
  Forward-Slash-Selektor matcht 1 Element.

- **Config-/Einstellungen-Bereich** (Phase 1 gefixt 2026-05-20):
  Settings-Panel mit Persistenz in `settings.json` unter dem App-Config-
  Dir, Aufruf über `Bearbeiten → Einstellungen…` (Strg+,). Architektur:
  Rust `settings::SettingsService` analog `theme.rs`/`panel_state.rs`,
  Patch-Command `settings_update` mit typisierten Optional-Feldern,
  Event `settings:changed { settings, changed: [...] }`. Codex-Review
  hat den ursprünglichen Plan an mehreren Stellen korrigiert
  (typisierter Patch statt generischem set, Menü unter Bearbeiten statt
  Datei, konservativer Sprach-Switch). Offene Punkte als Phase 2:
  - **~~Englisches Menü-Set~~** — **gefixt 2026-05-20**:
    `menu/strings.rs::en()` hat echte Übersetzungen. Sprachwahl wirkt
    bewusst erst beim nächsten Start (Codex-Review: Live-Menü-Rebuild
    verliert den vom Frontend nachgepflegten checked/enabled-State).
    Sobald Frontend-i18n eingezogen ist, wäre ein gezielter
    `menu_rebuild`-Pfad mit Wiederherstellung der dynamischen States
    machbar.
  - **~~Per-Typ-Default-Mode~~** — **gefixt 2026-05-20**:
    `defaultModeMarkdown` / `defaultModeText` in den Settings mit drei
    Werten: `view` (immer Anzeige), `edit` (immer Bearbeiten), `current`
    (Default — der aktuelle Body-Mode bleibt; entspricht dem Verhalten
    vor dem Settings-Panel). Greift nur auf frischem `openDocument`-
    Pfad — History-Restore (`navigation:changed`) gewinnt immer, Reload
    und Save defaulten nicht.
  - **~~Auto-Format im View-Mode~~** — **gefixt 2026-05-20**: Toggle
    `viewAutoFormat` (default an). Bei Aktivierung läuft für **alle**
    Sprachen (inkl. JSON) Monacos `editor.action.formatDocument` best-
    effort nach dem Mount — keine Sonderpfade. Sprachen ohne
    registrierten Formatter zeigen den Rohinhalt, ebenso wenn das
    Setting aus ist. Damit ist `MonacoEnvironment.getWorkerUrl` (siehe
    `editor/mount.ts`) Voraussetzung für Pretty-Output.
  - **~~Vault-Tree-Auto-Refresh + Tooltip + Reload-Button~~** —
    **gefixt 2026-05-20**: Drei zusammenhängende UX-Punkte:
    - `Vault::item_html` rendert jetzt ein `title="<absolute_path>"`-
      Attribut auf jedem Tree-Eintrag → Browser-Tooltip mit komplettem
      Pfad beim Hover.
    - Neues Modul `vault_watcher.rs` (NonRecursive `notify`-Watcher
      pro aufgeklappten Ordner). `Vault::on_expand` registriert, das
      `on_collapse` deregistriert. Bei FS-Event emit
      `vault:dir_changed { path }` → Frontend triggert `expand-dir`-
      Pfad nur für den betroffenen Ordner (kein Full-Tree-Rebuild).
    - Setting `vaultAutoRefresh` (default an): Toggle schaltet den
      Watcher live ein/aus + re-watcht beim Enable alle aktuell
      aufgeklappten Ordner.
    - Setting `documentAutoReload` (default an): bei `false` wird die
      geöffnete Datei nicht mehr automatisch nachgeladen, stattdessen
      erscheint `tb-reload` in der Toolbar. Sinnvoll für Log-Dateien
      o. ä. mit ständigen Schreibvorgängen.
    Verifiziert: Tooltip-Anzeige, beta.md erscheint nach extern Create
    im aufgeklappten Tree, tb-reload visible/hidden korreliert mit
    Setting + pending external change.
  - **macOS: Terminal-Wahl im Settings-Panel** — `open_terminal_at`
    öffnet auf macOS aktuell immer `Terminal.app`. Settings-Panel
    bietet noch keine Auswahl an; Default funktioniert zuverlässig.
  - **Markdown-Preview-Themes / Fonts** — Layout/Theming der View-
    Region anpassbar machen: Body-Font, Mono-Font für Code-Blöcke,
    Schriftgröße, ggf. Farbschema-Auswahl getrennt von App-Theme.
    Charme der Sache: die HTML/PDF-Export-Layouts in
    `commands/export.rs::export_layouts` haben bereits ein Theme-/
    Layout-Konzept (per Layout eigenes CSS, gerendert ins iframe-
    Preview). Vereinheitlichung wäre ein Theme/Layout, das sowohl die
    Markdown-Preview im View-Mode als auch den Export steuert.
  - **Theme im Settings-Panel** — Theme bleibt in `theme.rs` /
    `theme_get`/`theme_set` (separate Persistenz). Settings-Dialog
    könnte als reine Aggregations-UI eine zusätzliche Theme-Reihe
    anzeigen, ohne den Persistenz-Ort zu verschieben.
- **HTML im View-Mode rendern**: `.html`/`.htm` als Datei-Klasse "richtig" anzeigen,
  Skripte/inline-Event-Handler beim Render rauspatchen (Sandbox-iframe oder
  serverseitige Sanitization). Aktuell zeigt der View-Mode den Source mit
  Monaco-Highlighting (Code-View-Pfad).
- **~~JSON / XML Pretty-View~~** — **gefixt 2026-05-19**: Read-Only
  Monaco-Instanz `FolioCodeView` zeigt Non-Markdown-Text-Dateien im
  View-Mode mit Syntax-Highlighting. JSON wird via
  `JSON.parse + stringify(_, null, 2)` pretty-geprinted. View-Mode ist
  jetzt auch fuer `kind=text` aktivierbar (Default bleibt Edit-Mode).
  Beim selben Zug der MonacoEnvironment-Worker-URL-Bug behoben — Format
  Document (Shift+Alt+F) auf JSON funktioniert jetzt im Edit-Mode.
- **Linux-Paket: `.md`-Icon im Datei-Manager**: Aktuell muss
  [`scripts/install-folio-icons.sh`](scripts/install-folio-icons.sh)
  manuell laufen, damit Nemo/Nautilus & Co. das Folio-Icon für `.md`
  zeigen. Reproduzierbare Lösung im `.deb`-Build wäre schöner —
  Hintergrund, bisherige Erkenntnisse und mögliche Wege in
  [`docs/linux-md-icon.md`](docs/linux-md-icon.md).

- **~~`navigation:changed` Payload-Case-Inkonsistenz~~** — **gefixt
  2026-05-20**: `NavEntry` in `commands/nav.rs` hat jetzt
  `#[serde(rename_all = "camelCase")]` — sowohl der Tauri-Command-Pfad
  (`go_back_and_emit`/`go_forward_and_emit`) als auch der Automation-
  API-Pfad (`POST /history/back`/`/history/forward`, schon vorher
  camelCase) schicken `navigation:changed` mit identischer Field-Case.
  Frontend-Handler in `web/app/main.ts` auf `data.viewMode` /
  `data.scrollY` / `data.editorCursor` / `data.editorScrollY`
  angepasst. Tauri-Konvention ist camelCase fürs Frontend; die
  bisherige snake_case-Variante von `NavEntry` war ein Ausreißer.

- **Strukturiertes Logging mit Log-Levels**: Heute schreibt Folio nur
  `eprintln!`/`println!` auf stdout/stderr (gemischt mit `cargo run`-
  Cargo-Output, hart filterbar; bei einer `bundle`-Variante landet das
  in einer .log-Datei je nach OS). Für Diagnose-Sessions wie
  „Frontend startet nicht durch" wäre ein echtes Logging-Setup nützlich.
  Rust-seitig naheliegend: das `tracing`-Crate mit `tracing-subscriber`
  (Konfiguration via `RUST_LOG=folio=debug` o. ä.). Frontend-seitig:
  `console.error`/`console.warn` werden schon vom Automation-Hook
  durchgereicht, aber das fängt nur Errors — `console.log`/`debug` per
  Log-Level filterbar an Tauri zu spiegeln wäre ein zusätzliches
  Diagnose-Werkzeug. Persistenz: Rotierende Logfiles im
  app-config-Verzeichnis (`~/.config/folio/logs/` auf Linux, analog
  Win/macOS). NLog ist .NET-spezifisch — in Rust hat `tracing` die
  gleiche Rolle.

- **~~Rail-Toggle-Button-State beim Boot synchronisieren~~** — **gefixt
  2026-05-19**: Neuer Tauri-Command `panel_rails_get` liefert die
  persistierten `leftRailVisible`/`rightRailVisible`-Werte; `main.ts`
  zieht sie beim Boot analog zu `editor_minimap_get` und ruft
  `applyRailVisibility` fuer beide Seiten. Hartcodiertes `class="active"`
  im HTML bleibt als Initial-Vorbeleg, wird aber spaetestens nach dem
  Async-Boot-Call durch den persistierten State ueberschrieben.

## Niedrige Priorität

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
  - **E2E-Szenario** `22_image_paste.py`: Datei-wählen-Pfad lässt sich
    automatisieren; Clipboard-Pfad braucht echten Display, daher
    Xvfb-Skip-Marker oder `--include-desktop-only`.



- **E2E-Suite auf Windows lauffähig machen**: Aus dem Windows-Run 2026-05-18
  zwei Stolpersteine, die die Suite dort heute praktisch unbrauchbar machen,
  obwohl die Library `--attach` explizit unterstützt:
  1. **Visual-Baselines an Linux 1280×800 gebunden** — 6 Szenarien (01–06)
     liefern auf einem 1920×1080-Monitor `size mismatch` und brechen am
     ersten Screenshot ab, obwohl ihre funktionalen Asserts grün waren.
     Optionen: vor dem Capture per `/resize` auf eine feste Größe, oder
     ein zweites Baseline-Set pro Plattform, oder Visual-Tests im
     `--attach`-Mode standardmäßig skippen.
  2. **`/open` blockt mit HTTP 409, solange Folio aus der letzten Session
     eine dirty Recent-Datei restauriert hat** (`document_service.rs:64`
     `DirtyRejected`). Heute nur lösbar, indem man
     `%APPDATA%\Folio\workspace.json` wegmoved. Wünschenswert: optionaler
     `force`/`discard`-Flag im `/open`-Body oder ein eigener
     `/document/discard`-Endpoint, den die Test-Suite vor jedem Run
     aufruft.

- **KI-Funktionen (Ideen sammeln)**: Sinnvolle Integrationen prüfen, z. B.
  Zusammenfassung des aktuellen Dokuments, Übersetzung, Rechtschreib-/
  Grammatik-Check, Markdown-Reformatierung, Linkvorschläge im Vault,
  TOC/Heading-Vorschläge, Cheat-Sheet-„Frag mich"-Modus. Erst Ideen
  sammeln, dann eine konkrete priorisieren (Provider/Datenschutz klären).
- **~~About-Dialog~~** — **gefixt 2026-05-19**: Echter Modal-Dialog
  `#about-dialog` (`ui/about-dialog.ts`) statt `alert("folio v…")`.
  Zeigt Version, Build-Datum, Git-Hash (Hash + Datum kommen via
  `build.rs` über `cargo:rustc-env=FOLIO_GIT_HASH/BUILD_DATE`).
  Spendenlink ist noch Platzhalter — sobald du dich für eine Plattform
  entschieden hast, einfach den `#about-donate`-Absatz austauschen.
  Lizenz-Eintrag bewusst weggelassen, weil das Repo aktuell keine
  LICENSE-Datei und keine Lizenz-Angabe in `Cargo.toml` hat — da
  möchte ich nichts erfinden.
  `14_menu_help.py::help.about`-Step reaktiviert (Klick → sichtbar →
  Schließen-Button → versteckt).
