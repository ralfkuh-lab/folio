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
  - **Noch offen / nicht abgedeckt**: Strg+Z / Strg+Shift+Z (Undo/Redo)
    sind weiterhin reiner Menü-Accelerator + Monaco-Internal. Bisher
    keine User-Beschwerde — wenn das auch nicht greift, denselben
    Pfad wie Strg+B/I/K nachziehen.

- **`document.saved`-Event greift Wait-Poll nicht**: Sowohl
  `tests/e2e/scenarios/08_save_roundtrip.py` (über `/save`) als auch
  `15_keybindings.py` (über DOM-Ctrl+S) bekommen nach erfolgreichem
  Speichern einen 5-s-Timeout auf `expect_event("document.saved")`. Auf
  Disk ist die Mutation da, das Event scheint also vor der Wait-
  Registrierung gefeuert worden zu sein (Race im `/wait`-Mechanismus
  oder im Event-Re-Broadcast). Auf Linux+Xvfb lief die Suite zuletzt
  grün — möglicherweise nur unter WebView2/Windows-Timing fragil.
  Prüfen: `automation/events.rs` (oder wo die Event-Subscription
  sitzt) — ein „last-emitted"-Buffer pro Event-Topic mit kurzer TTL
  würde solche Late-Subscribers entkoppeln.

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

- **Config-/Einstellungen-Bereich**: Eigener Settings-Dialog/-Panel für
  Anwendungs-Einstellungen (Theme, Font/Schriftgröße, Editor-Optionen,
  Vault-Pfade, Automation-Port, …). Persistenz analog zur Window-State-
  Speicherung; Aufruf über Menü oder Statusbar.
  - **macOS: Terminal-Wahl im Settings-Panel** — `open_terminal_at` öffnet
    auf macOS aktuell immer `Terminal.app`. Sobald der Settings-Bereich
    existiert, dort eine Auswahl anbieten (Terminal.app, iTerm2, Warp, …
    oder freies Eingabefeld für den App-Namen). Bis dahin funktioniert
    der Default zuverlässig.
  - **Englisches Menü-Set** — `src-tauri/src/menu/strings.rs::en()` ist
    aktuell ein Platzhalter (gibt deutsche Strings zurück). Sobald die
    Sprachwahl im Settings-Panel landet, hier die englische Übersetzung
    ergänzen — der Builder zieht sie automatisch über `labels(lang)`.
- **HTML im View-Mode rendern**: `.html`/`.htm` als Datei-Klasse "richtig" anzeigen,
  Skripte/inline-Event-Handler beim Render rauspatchen (Sandbox-iframe oder
  serverseitige Sanitization). Aktuell öffnet der Edit-Mode den Source.
- **JSON / XML Pretty-View**: für `.json`, `.xml`, ggf. `.yaml`/`.toml` im
  View-Mode formatiert + syntaxgehighlighted anzeigen (CodeMirror-Renderer
  read-only oder eigener Renderer).
- **Linux-Paket: `.md`-Icon im Datei-Manager**: Aktuell muss
  [`scripts/install-folio-icons.sh`](scripts/install-folio-icons.sh)
  manuell laufen, damit Nemo/Nautilus & Co. das Folio-Icon für `.md`
  zeigen. Reproduzierbare Lösung im `.deb`-Build wäre schöner —
  Hintergrund, bisherige Erkenntnisse und mögliche Wege in
  [`docs/linux-md-icon.md`](docs/linux-md-icon.md).

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

- **Rail-Toggle-Button-State beim Boot synchronisieren**: Aktuell starten
  `tb-rail-left` und `tb-rail-right` immer mit `class="active"` (hartcodiert
  im HTML). Wenn der User vorher per Toolbar eine Rail versteckt hat,
  bleibt das im `panel-state.json` persistiert (Body bekommt
  `vault-hidden`/`toc-hidden`) — der Button zeigt aber visuell „aktiv".
  Frontend braucht beim Boot ein `invoke('panel_state_get')` o. ä., das
  die initialen Rail-Werte liefert, dann `setRailVisibility` + `setRailButton`
  rufen. Der `panel:rail_changed`-Listener feuert heute nur auf User-
  Klick, nicht beim Boot.

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
- **About-Dialog**: Versions-/Autor-Info anzeigen, ggf. Lizenz und Build-Hash.
  Idee: Spendenmöglichkeit für den Autor einbinden (Plattform/Form später
  klären). Aktuell zeigt **Hilfe → Über folio** nur ein simples
  `alert("folio v…")` als Stub. Wenn das mal ein echter Dialog wird, kann
  der `help.about`-Step in `tests/e2e/scenarios/14_menu_help.py` (heute
  übersprungen, weil `alert()` die WebView blockiert) reaktiviert werden.
