# TODO

## Hohe Priorität

- **Icons überarbeiten**: App-Icon fehlt komplett, im Arbeitsbereich sind einige
  Vault-Icons defekt, Toolbar/Statusbar sollen weg vom minimalistischen
  Schwarz-Weiß hin zu farbigen, modernen Icons (schnellere Erkennbarkeit).
  Designvorschlag professionell generieren lassen (z. B. via Codex-imagegen-Skill);
  dann konsistent durch Toolbar, Vault-Header, Kontextmenüs und das App-Icon
  (Linux `.png`/`.svg`, Windows `.ico`, macOS `.icns`) ziehen.
- **Export Markdown → HTML / PDF**: Aktuelles Dokument exportieren. HTML kann der
  vorhandene Renderer liefern (Standalone-Datei mit eingebettetem CSS). Für PDF:
  über das WebView drucken (Tauri-WebView print → "Save as PDF") oder einen Rust-
  Renderer anbinden (z. B. `printpdf`/`weasyprint`-CLI). Menü/Toolbar-Eintrag
  inklusive Datei-Pfad-Dialog.

## Mittlere Priorität

- **Edit-Toolbar dateityp-spezifisch**: Markdown-spezifische Buttons (Bold, Italic,
  Heading, Tabelle, Link, Bild, Codeblock, …) nur bei Markdown-Dateien zeigen.
  Für Nicht-MD-Text-Dateien stattdessen ggf. nur generische Edit-Aktionen.
- **Save-Button in der Edit-Toolbar**: Nur im Edit-Mode sichtbar, enabled wenn die
  Datei dirty ist; ruft `editor_save_requested` auf, deaktiviert sich nach Save.
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

- **Editor-Minimap**: CodeMirror 6 hat keine eingebaute Minimap. Optional
  `@replit/codemirror-minimap` einbinden — Toggle in der Edit-Toolbar,
  ggf. Suchtreffer in die Minimap mappen (analog zur View-Marker-Lane).
