# TODO

## Mittlere Priorität

- **Menu-Keybindings (Accelerators) greifen oft nicht**: Viele der nativen
  Tauri-Menü-Accelerators (Ctrl+S Speichern, Ctrl+Z Undo, Ctrl+W Schließen,
  Ctrl+1/2/3 Mode, …) feuern nicht zuverlässig — User-Bericht 2026-05-19.
  Ursache liegt vermutlich darin, dass WebView2 die Tasten verschluckt,
  bevor sie das Tauri-Menü erreichen (das Frontend hat heute für Ctrl+1/2/
  S/O eigene DOM-keydown-Capture-Handler in `toolbar-actions.ts:117`, der
  Workaround dort bestätigt das Pattern). Saubere Lösung: für jeden
  Menü-Accelerator entweder einen DOM-Capture-Listener am Frontend nachziehen
  ODER prüfen, ob WebView2-spezifische Config (`accelerator_handler`) die
  OS-Bar früher dranlassen kann. Tracking: nach dem Settings-Panel
  systematisch durchgehen.

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
