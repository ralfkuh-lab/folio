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

- **Undo-Stack wird in `09_undo_redo` gecleared**: Szenario schreibt
  zuerst „X" in den Editor, dann „**hallo**" als zweites Edit, danach
  Undo → erwartet wird, dass „**hallo**" verschwindet und „X" stehen
  bleibt. Beobachtet (Windows 2026-05-18): nach Undo steht da
  `'hallo welt\n'` — der gesamte vorherige Edit ist weg, der Undo-Stack
  wurde irgendwo zwischen den beiden Edits geclearet. Riecht stark nach
  einer Regression der CLAUDE.md-Konvention „`applyReplace` muss
  `editor.executeEdits` nutzen, nicht `setValue`". Verdächtige Stellen:
  `editor/text.ts`-`applyReplace`/`setText`-Pfade und alles, was beim
  Edit-Mode-Wechsel das Model neu setzt. Auf Linux+Xvfb war 09 zuletzt
  grün, also entweder OS-spezifisch oder Timing-bedingt.

- **Pin → Vault-Tree-Eintrag erscheint nicht im DOM (Windows)**:
  Sowohl `16_vault_tree` als auch `19_context_menus` failen nach
  `/workspace/pin` mit „`#vault-tree li.node[data-path=...]`
  exists=false, matchCount=0". Auf Linux+Xvfb grün. Datei wird unter
  `%TEMP%\folio-e2e-vault-*\…` angelegt und gepinnt — vermutlich
  triggert der `notify`-Watcher den Tree-Refresh nicht (anderer
  Volume? Pfad-Casing? CRLF-Path-Normalisierung?). Reproduktion ohne
  Test: manuell eine Datei außerhalb der aktuell expandierten Vault-
  Roots pinnen und schauen, ob sie im Tree auftaucht.

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

- **`navigation:changed` Payload-Case-Inkonsistenz**: Aus dem Tauri-
  Command-Pfad (`commands::nav::move_history` → `app.emit(...&NavEntry)`)
  kommt das Event mit snake_case-Feldern (`view_mode`, `scroll_y`,
  `editor_scroll_y`, `editor_cursor`). Aus dem Automation-API-Pfad
  (`automation::handlers::ui::history_move` → emit mit
  `HistoryEntryResponse` `#[serde(rename_all = "camelCase")]`) kommt es
  camelCase. Der Frontend-Handler in `web/app/main.ts:115` liest aber
  ausschließlich snake_case (`data.view_mode`, `data.scroll_y`, …) —
  beim API-History-Pfad greifen also Mode-Restore und Scroll-Restore
  nicht. Fix-Optionen: Backend-Pfade harmonisieren (beide camelCase
  oder beide snake) und Frontend-Handler entsprechend angleichen, ggf.
  defensiv beide Cases akzeptieren. Gefunden 2026-05-20 beim Settings-
  Live-Test, betrifft nur den Automation-API-Pfad und ist daher in der
  Praxis nur für E2E-Szenarien relevant.

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
