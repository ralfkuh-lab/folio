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
    (sample.md hatte nach dem Run `ctrl-s-test\n` angehängt). Der damals
    beobachtete `/wait`-Race für `document.saved` ist inzwischen behoben.
    Native Tauri-Menübar (z. B. echter Strg+W aus dem Menü) wurde nicht
    getestet, weil aus dem WebView nicht erreichbar.
  - **Update 2026-05-19 (2)**: Strg+Z / Strg+Shift+Z DOM-Capture
    nachgezogen. Anders als bei Strg+B/I/K greift der Fallback nur,
    wenn der Fokus NICHT im `#editor-mount` liegt — Monacos
    eingebautes Undo bleibt im Editor-Fokus unangetastet. Ohne Fokus
    im Editor (z. B. Vault-Tree aktiv) ruft der Handler
    `FolioEditor.undo()` / `.redo()`.

- **Undo-Stack wird in `09_undo_redo` gecleared (Windows)** —
  **Hypothese-Fix 2026-05-20**: `applyReplace` in `editor/text.ts`
  ruft jetzt `editor.pushUndoStop()` direkt vor und nach dem
  `executeEdits`. Ohne das verschmilzt Monaco unter bestimmten Timings
  den vorhergehenden Type-Edit (`insertText("X")` via `trigger('type')`)
  mit dem darauf folgenden Voll-Range-Replace zu einem einzigen Undo-
  Eintrag — Undo entfernte dann beides auf einmal. Live-Verifikation
  auf Windows ist mit der aktuellen Dev-Setup-Lage umständlich; der
  Fix folgt Monacos Best-Practice (Stack-Stops trennen Edits) und ist
  defensiv. Beim nächsten Windows-E2E-Run validieren.

- **Config-/Einstellungen-Bereich Folgepunkte**: Basis-Settings-Panel
  ist vorhanden. Offene Ausbaustufen:
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
