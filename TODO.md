# TODO

## Mittlere Priorität

- **Menü-Vollausbau**: Vollständige Anfangs-Skizze als Soll, was bereits
  drin ist mit ✅ markiert. Offene Punkte am besten in einem Schwung
  (Undo/Redo + Schließen + Recent-Submenü) — der Rest steht schon.

  ```
  Datei                Bearbeiten          Ansicht                Hilfe
  ├─ Öffnen…       ✅  ├─ Rückgängig        ├─ View            ✅  ├─ Cheat-Sheet
  ├─ Recent ▶          ├─ Wiederholen       ├─ Edit            ✅  ├─ Über folio    ✅
  ├─ Speichern     ✅  ├─ ─────             ├─ Split           ✅(Stub)
  ├─ Save As…      ✅  ├─ Suchen…       ✅  ├─ ─────
  ├─ ─────             └─ Cheat-Sheet   ✅  ├─ Theme hell/dunkel ✅(Toggle)
  ├─ Schließen                              └─ Vault/TOC ein-/aus ✅
  └─ Beenden       ✅
  ```

  Konkret offen:
  - **Datei → Schließen**: aktuelles Dokument zumachen (mit Dirty-
    Prompt), document_store leert, Editor-Mount disposed, Status zurück
    auf „Bereit". Eigene close_document-Command nötig.
  - **Datei → Recent ▶** (separat schon als Item gelistet): dynamisches
    Submenü aus workspace.recent.
  - **Bearbeiten → Rückgängig / Wiederholen**: an Monaco's Undo/Redo
    durchreichen. Im View-Mode disabled. Editor-API-Erweiterung im
    `editor.ts` (`undo()`, `redo()`), neuer Command oder Frontend-Hop.
  - **Hilfe → Cheat-Sheet (Duplikat)**: Skizze hatte Cheat-Sheet sowohl
    unter Bearbeiten als auch unter Hilfe. Aktuell nur unter Bearbeiten.
    Klären, ob das Duplikat sinnvoll ist (analog VS Code: nur unter
    Help) oder verzichtbar.
  - **Ansicht → Theme hell/dunkel**: aktuell ein „Theme umschalten"-
    Toggle. Skizze impliziert ein Submenü mit zwei Items
    (Hell / Dunkel) + Häkchen am aktiven. Optional, der Toggle reicht
    funktional.
- **Config-/Einstellungen-Bereich**: Eigener Settings-Dialog/-Panel für
  Anwendungs-Einstellungen (Theme, Font/Schriftgröße, Editor-Optionen,
  Vault-Pfade, Automation-Port, …). Persistenz analog zur Window-State-
  Speicherung; Aufruf über Menü oder Statusbar.
- **HTML im View-Mode rendern**: `.html`/`.htm` als Datei-Klasse "richtig" anzeigen,
  Skripte/inline-Event-Handler beim Render rauspatchen (Sandbox-iframe oder
  serverseitige Sanitization). Aktuell öffnet der Edit-Mode den Source.
- **JSON / XML Pretty-View**: für `.json`, `.xml`, ggf. `.yaml`/`.toml` im
  View-Mode formatiert + syntaxgehighlighted anzeigen (CodeMirror-Renderer
  read-only oder eigener Renderer).
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
  klären). Aktuell zeigt **Hilfe → Über folio** nur ein simples
  `alert("folio v…")` als Stub.
- **Recent-Files-Submenü**: Im Menü „Datei" eine dynamische Liste der
  zuletzt geöffneten Dateien (analog Workspace-Recents). Refresh nach
  Open/Save-As; macht den ohnehin gepflegten `workspace.recent`-State
  über die Tastatur erreichbar.
- **Englisches Menü-Set**: `src-tauri/src/menu/strings.rs::en()` ist
  aktuell ein Platzhalter (gibt deutsche Strings zurück). Wenn das
  Settings-Panel die Sprachwahl bekommt, hier die englische Übersetzung
  ergänzen — der Builder zieht sie automatisch über `labels(lang)`.
- **Editor-Minimap aktivierbar machen**: Monaco hat eine Minimap eingebaut
  (in `editor.ts` aktuell `minimap: { enabled: false }`). Toggle in der
  Edit-Toolbar oder Statusbar, Persistenz analog zu Theme/RailVisibility.
  Suchtreffer landen schon in der Minimap-Position-Inline.
