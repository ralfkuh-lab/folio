# TODO

## Hohe Priorität

- **Toolbar/Statusbar-Icons überarbeiten**: Aktuell minimalistisch
  schwarz-weiß; sollen weg zu farbigen, modernen Icons (schnellere
  Erkennbarkeit). Designvorschlag professionell generieren lassen
  (z. B. via Codex-imagegen-Skill); dann konsistent durch Toolbar,
  Vault-Header und Kontextmenüs ziehen. App-Icon (Marky-MD) ist
  erledigt; Vault-File-Icons kommen aus dem System-Theme.

## Mittlere Priorität

- **Edit-Toolbar dateityp-spezifisch**: Markdown-spezifische Buttons (Bold, Italic,
  Heading, Tabelle, Link, Bild, Codeblock, …) nur bei Markdown-Dateien zeigen.
  Für Nicht-MD-Text-Dateien stattdessen ggf. nur generische Edit-Aktionen.
- **Config-/Einstellungen-Bereich**: Eigener Settings-Dialog/-Panel für
  Anwendungs-Einstellungen (Theme, Font/Schriftgröße, Editor-Optionen,
  Vault-Pfade, Automation-Port, …). Persistenz analog zur Window-State-
  Speicherung; Aufruf über Menü oder Statusbar.
- **Klassische Menüleiste**: Aufklappbares Menü (File, Edit, View, Help, …)
  zusätzlich zur bestehenden Toolbar. Standard-Punkte (Öffnen, Speichern,
  Speichern unter, Beenden / Rückgängig, Suchen / Theme, Rails / About).
  Über Tauri-Native-Menu oder eigenes HTML/CSS-Menü; Shortcuts mit den
  bestehenden Toolbar-Aktionen synchron halten.
- **WebView-Zoom (Ctrl+Mausrad)**: `document.documentElement.style.zoom`-basiert,
  Skalar in `localStorage` persistieren. Ctrl+Wheel ±0.1, Ctrl+0 reset, Ctrl+± als
  Bonus. Clamp ca. `[0.5, 3.0]`. Wegen 4K-Monitoren.


- **HTML im View-Mode rendern**: `.html`/`.htm` als Datei-Klasse "richtig" anzeigen,
  Skripte/inline-Event-Handler beim Render rauspatchen (Sandbox-iframe oder
  serverseitige Sanitization). Aktuell öffnet der Edit-Mode den Source.
- **JSON / XML Pretty-View**: für `.json`, `.xml`, ggf. `.yaml`/`.toml` im
  View-Mode formatiert + syntaxgehighlighted anzeigen (CodeMirror-Renderer
  read-only oder eigener Renderer).
- **Syntax-Highlighting im Edit-Mode** für die Text-Klasse: CodeMirror-Lang-Plugins
  per Extension auswählen (lang-json, lang-html, lang-yaml, …).

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
