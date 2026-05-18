# TODO

## Mittlere Priorität

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
