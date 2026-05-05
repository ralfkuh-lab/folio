# TODO

## Mittlere Priorität

- **HTML im View-Mode rendern**: `.html`/`.htm` als Datei-Klasse "richtig" anzeigen,
  Skripte/inline-Event-Handler beim Render rauspatchen (Sandbox-iframe oder
  serverseitige Sanitization). Aktuell öffnet der Edit-Mode den Source.
- **JSON / XML Pretty-View**: für `.json`, `.xml`, ggf. `.yaml`/`.toml` im
  View-Mode formatiert + syntaxgehighlighted anzeigen (CodeMirror-Renderer
  read-only oder eigener Renderer).
- **Syntax-Highlighting im Edit-Mode** für die Text-Klasse: CodeMirror-Lang-Plugins
  per Extension auswählen (lang-json, lang-html, lang-yaml, …).

## Niedrige Priorität

- **Editor-Minimap**: CodeMirror 6 hat keine eingebaute Minimap. Optional
  `@replit/codemirror-minimap` einbinden — Toggle in der Edit-Toolbar,
  ggf. Suchtreffer in die Minimap mappen (analog zur View-Marker-Lane).
