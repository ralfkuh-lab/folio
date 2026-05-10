# TODO

## Mittlere Priorität

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
- **Editor-Minimap aktivierbar machen**: Monaco hat eine Minimap eingebaut
  (in `editor.ts` aktuell `minimap: { enabled: false }`). Toggle in der
  Edit-Toolbar oder Statusbar, Persistenz analog zu Theme/RailVisibility.
  Suchtreffer landen schon in der Minimap-Position-Inline.
