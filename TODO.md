# TODO

## Hohe Priorität

- **Theme-System-Ausbau** (beschlossen 2026-07-06, vollständige Spec mit
  Etappen-Checkliste in [`docs/spec-theme-system.md`](docs/spec-theme-system.md)):
  In-App-Theme-CRUD + Monaco-Editor mit Live-Preview (eigener virtueller
  Tab), Verzeichnis-Paketformat mit Deckblatt/Kopf-Fußzeile/Logo-Assets/
  Frontmatter-Template-Variablen, 8 neue Built-in-Vorlagen, KI-Theme-Autor
  (Draft→Review→Save über die bestehende KI-Infrastruktur). Etappen E1–E6;
  PDF-Live-Seitenzahlen (CDP-Migration) und dynamischer Per-Export-KI-Modus
  bewusst verschoben (siehe Spec).

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
  - **Ctrl+Shift+Tab (Tab-Rueckwaertswechsel) kommt unter Linux nicht
    an** (User-Report 2026-07-04): Handler-Pfad ist verifiziert
    (synthetische Events inkl. ISO_Left_Tab-Guard funktionieren) —
    vermutlich schluckt WebKitGTK die Kombination vor der Seite.
    Niedrige Prio, Ctrl+Tab rotiert zyklisch.
  - **Restpunkt**: WebView2-`accelerator_handler`-Config existiert
    Rust-seitig noch nicht — die DOM-Capture-Handler bleiben bis dahin
    die Wahrheit (`toolbar-actions.ts:155-282`). Undo-Stack-Fix
    (`pushUndoStop` in `editor/text.ts:187,193`) ist erledigt; beim
    nächsten Windows-E2E-Run (`09_undo_redo`) nur noch validieren.

- **Settings-Ausbau — Reste** (das Theme-System ist komplett: Tab-
  Control + Etappen 3a View-Theme-Auswahl, 3b Custom-Themes, 3c
  Favoriten, 3d Export-Code-Highlighting via syntect):
  - Fonts als Theme-Bestandteile (Body-Font, Mono-Font, Schriftgröße).
  - Kleinere offene Ausbaustufen aus dem alten Settings-Eintrag:
    **macOS-Terminal-Wahl** (`open_terminal_at` öffnet fix
    `Terminal.app`); **Theme-Reihe als Aggregations-UI** (Persistenz
    bleibt in `theme.rs`/`theme_get`/`theme_set`).

- **Tabs — Folgepunkte** (Kernfeature 2026-07-04 komplett, siehe
  [`docs/spec-multi-tabs.md`](docs/spec-multi-tabs.md)): Tab-Drag-
  Reorder (Pointer-Muster aus `vault/tree.ts` als Vorlage); optional
  „Neues Fenster"-Command (Tauri-Multi-Window) für echtes
  Nebeneinander; Monaco-Model-Cache ohne Cap (bei sehr vielen Tabs
  LRU erwägen).

## Niedrige Priorität

- **KI-Integration — Folgepunkte** (Kernfeature und Dokumentübersetzung
  umgesetzt, Architektur in [`docs/spec-ki-tab.md`](docs/spec-ki-tab.md)):
  zusätzliche E2E-/Desktop-Verifikation auf macOS und Windows sowie weitere
  KI-Funktionen erst nach konkretem Bedarf. (Chunking sehr großer Dokumente
  bewusst verworfen, 2026-07-05 — kein erwarteter Bedarf.)

- **Live-Preview Folgepunkte** (Hauptfeature 2026-05-22 implementiert,
  siehe `view/preview.ts`, Backend-Command `render_markdown_preview`):
  - **Adaptive Debounce für große Docs**: 150 ms ist bei >10k-Zeilen-MD
    spürbar. render-on-idle (`requestIdleCallback`) oder messen +
    dynamisch erhöhen.
  - **Heading-Anchor-Restore statt scrollTop**: bei Mitten-Edits springt
    scrollTop um. Sauberer wäre, das nächstgelegene Heading vor dem
    Re-Render zu merken und nach dem Render dorthin scrollen.
  - **Live-Preview für HTML-iframe** (kind=text + .html): iframe-srcdoc
    Update bei Editor-Change, debounced wie der MD-Pfad.
  - **Live-Preview für Code-View** (kind=text mit Monaco read-only):
    setText auf der Code-View-Instanz bei Editor-Change.
  - **Settings-Toggle** für Debounce-Delay (z. B. 100/150/300 ms).

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
  - **E2E-Szenario** `23_image_paste.py`: Datei-wählen-Pfad lässt sich
    automatisieren; Clipboard-Pfad braucht echten Display, daher
    Xvfb-Skip-Marker oder `--include-desktop-only`.



- **E2E: Zustands-Leaks zwischen Szenarien beseitigen** (Befund
  2026-07-04 beim Bau der Einzelszenario-Läufe): Szenarien hinterlassen
  Zustand, der in die Visual-Baselines *späterer* Szenarien einfließt —
  04_theme lässt Dark-Theme aktiv, 06_find die Find-Bar offen, dazu
  wächst die Recent-Liste über den Lauf. Im festen Voll-Lauf ist das
  deterministisch, aber fragil: ein neu einsortiertes Szenario
  verschiebt die Baselines aller nachfolgenden, und Einzelläufe können
  visuell nicht verglichen werden (deshalb heute `record_only` bei
  Szenario-Auswahl). Sauberer Fix: Reset auf kanonischen Zustand vor
  jedem Szenario (Theme light, Find-Bar zu, View-Mode; Recents wären
  per Automation-API zu leeren oder aus dem Capture-Bereich zu nehmen)
  + einmalige Baseline-Neuaufnahme mit Sichtprüfung. Danach könnten
  auch Einzelläufe wieder visuell vergleichen.

- **E2E-Suite auf Windows lauffähig machen**: Aus dem Windows-Run 2026-05-18
  bleibt ein Stolperstein: **Visual-Baselines an Linux 1280×800
  gebunden** — 6 Szenarien (01–06) liefern auf einem 1920×1080-Monitor
  `size mismatch` und brechen am ersten Screenshot ab, obwohl ihre
  funktionalen Asserts grün waren. Optionen: vor dem Capture per
  `/resize` auf eine feste Größe, oder ein zweites Baseline-Set pro
  Plattform, oder Visual-Tests im `--attach`-Mode standardmäßig skippen.
  (Der zweite Stolperstein — `/open` blockte mit 409 bei dirty
  Recent-Datei — ist über das `discard`-Flag im `/open`-Body gelöst.)

- **Image-View Folgepunkte** (Hauptfeature 2026-05-21 implementiert,
  siehe `view/image.ts`, `file_kind.rs::FileKind::Image`,
  `document_store.rs::load_opaque`):
  - **Image-Watcher**: heute keine Live-Reaktion auf externe Änderungen
    am offenen Bild. Analog zu `DocumentStore::watch` einen
    File-Watcher für den Image-Pfad, der bei FS-Change das `<img>` neu
    lädt (Cache-Buster `?v=<mtime>` an die `convertFileSrc`-URL).
  - **Zoom / Pan** für große Bilder. Heute wird via `max-width/max-height`
    proportional runterskaliert; ein Mausrad-Zoom + Drag-Pan wäre
    sinnvoll. Achtung: muss mit `<img>` und CSS-Transform laufen, da
    der `#image-view-mount` keinen Editor mitbringt.
  - **PDF-View**: WebView2 (Windows) hat einen eingebauten PDF-Viewer;
    WebKitGTK (Linux) **nicht** — bräuchte PDF.js (~2 MB extra Bundle).
    Plattform-Split ist unschön; abwägen ob lohnt.
  - **Audio/Video-View**: `<audio>`/`<video>` läuft cross-platform out
    of the box, analog zum Image-Pfad. Sinnvoll, wenn Bedarf entsteht.
