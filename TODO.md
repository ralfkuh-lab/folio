# TODO

## Mittlere Priorität

- **Find-Shortcuts im Monaco-Editor**: Ctrl+F und F3/Shift+F3 lösen die
  Shell-Find-Bar derzeit nicht aus, wenn der Fokus im Editor liegt — die
  Monaco-eigenen Shortcuts sind zwar disabled (`editor.ts:310-324`), aber
  der ersetzende Aufruf der Shell-Find-Bar fehlt. Stattdessen entweder
  die Shell-Bar direkt aus den Monaco-Commands öffnen oder die Shortcuts
  auf Window-Ebene abfangen (capture phase, bevor Monaco sie sieht).
- **Config-/Einstellungen-Bereich**: Eigener Settings-Dialog/-Panel für
  Anwendungs-Einstellungen (Theme, Font/Schriftgröße, Editor-Optionen,
  Vault-Pfade, Automation-Port, …). Persistenz analog zur Window-State-
  Speicherung; Aufruf über Menü oder Statusbar.
- **Klassische Menüleiste**: Aufklappbares Menü (File, Edit, View, Help, …)
  zusätzlich zur bestehenden Toolbar. Standard-Punkte (Öffnen, Speichern,
  Speichern unter, Beenden / Rückgängig, Suchen / Theme, Rails / About).
  Über Tauri-Native-Menu oder eigenes HTML/CSS-Menü; Shortcuts mit den
  bestehenden Toolbar-Aktionen synchron halten.
- **HTML im View-Mode rendern**: `.html`/`.htm` als Datei-Klasse "richtig" anzeigen,
  Skripte/inline-Event-Handler beim Render rauspatchen (Sandbox-iframe oder
  serverseitige Sanitization). Aktuell öffnet der Edit-Mode den Source.
- **JSON / XML Pretty-View**: für `.json`, `.xml`, ggf. `.yaml`/`.toml` im
  View-Mode formatiert + syntaxgehighlighted anzeigen (CodeMirror-Renderer
  read-only oder eigener Renderer).
- **Syntax-Highlighting im Edit-Mode** für die Text-Klasse: CodeMirror-Lang-Plugins
  per Extension auswählen (lang-json, lang-html, lang-yaml, …).
- **Editor-Sprache: Status-Leiste + Picker**: Aktive Monaco-Sprache (z. B.
  „Markdown", „JSON", „Plain Text") in der Status-Leiste anzeigen,
  klickbar → Auswahl-Popup mit allen verfügbaren Monaco-Sprachen. Setzt
  einen Per-Dokument-Override (in-session, ggf. pro History-Entry
  persistiert), der die Auto-Erkennung aus der Endung übersteuert.
  Beeinflusst nur das Highlighting — FileKind/MD-Toolbar/TOC bleiben
  unangetastet (siehe Modell-1-Architektur in der Monaco-Migration).
- **„Speichern unter"**: Aktuelles Dokument unter neuem Pfad/Namen ablegen
  (Save-As-Dialog), inkl. optionalem Endungs-Wechsel — z. B. `.txt` mit
  Notizen als `.md` weiterführen. Workspace-Recent updaten, document_store
  auf den neuen Pfad umhängen.
- **Datei-Typ ändern**: Bestehende Datei via Rename auf eine andere Endung
  umheben (z. B. `notes.txt` → `notes.md`), damit FileKind und Editor-
  Language automatisch nachziehen. Konflikt-Check (Zieldatei existiert),
  Vault refreshen, History-Eintrag aktualisieren.
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
  klären). Aufruf z. B. über Statusbar oder Menü.
- **Editor-Minimap**: CodeMirror 6 hat keine eingebaute Minimap. Optional
  `@replit/codemirror-minimap` einbinden — Toggle in der Edit-Toolbar,
  ggf. Suchtreffer in die Minimap mappen (analog zur View-Marker-Lane).
