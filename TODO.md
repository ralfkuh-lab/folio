# TODO

## Mittlere Priorität

- **Windows-Dev-Umgebung: `cargo test --lib` startet nicht**
  (`STATUS_ENTRYPOINT_NOT_FOUND` 0xc0000139 beim Laden des
  Test-Binaries, reproduziert auch auf unverändertem HEAD, 2026-07-15).
  Integrationstests (`tests/`) und `--test i18n_ref` laden dagegen
  normal. Bis zum Fix laufen Lib-Unit-Tests nur auf Linux;
  `cargo test --lib --no-run` taugt als Kompilier-Check.
  - **Root Cause identifiziert 2026-07-19** (GUI-Fehlerdialog beim
    Startversuch des Test-Binaries): Der Loader findet den
    Prozedureinsprungpunkt **`TaskDialogIndirect`** nicht — die API
    existiert nur in **comctl32.dll v6**, die Windows nur lädt, wenn das
    Binary ein Application-Manifest mit der Common-Controls-6.0-
    Dependency einbettet. Das echte `folio.exe` bekommt das Manifest von
    Tauri beim Build; das `cargo test --lib`-Binary (`folio_lib-*.exe`)
    nicht → comctl32 v5 → 0xc0000139. Import kommt vermutlich über eine
    Dialog-Dependency (rfd/tauri-plugin-dialog). Fix-Idee: Manifest per
    Linker-Flag auch in Test-Binaries einbetten, z. B. `.cargo/
    config.toml` mit `-C link-arg=/MANIFESTDEPENDENCY:...` (+
    `/MANIFEST:EMBED`) für das MSVC-Target.

- **E2E `30_tabs_ui` flaky — Fix 2026-07-09, Beobachtung offen**: dreimal
  im Voll-Lauf gefailt („Undo-Stack hat den Tab-Wechsel nicht ueberlebt",
  2026-07-06/08/09), nie im Einzellauf. Race-Analyse (codex+agy+Claude):
  zwei komplementäre Mechanismen derselben Klasse — (a) die Test-Polls
  lesen den Backend-Store, der beim `tab_activate` sofort umschaltet,
  während Monacos Model-Swap asynchron folgt (ein zu früh eintreffendes
  `undo` träfe das falsche Model); (b) ein verspätet zugestelltes
  `document:loaded` nimmt bei bereits aktivem Tab den Same-Tab-Pfad in
  `editor/mount.ts` und löscht via `setValue` still den Undo-Stack
  (`withProgrammaticWrite` unterdrückt den Backend-Sync — Frontend und
  Store divergieren dann unbemerkt). Fix: `document:loaded` trägt eine
  monotone `seq`; `state/document.ts` verwirft veraltete/duplizierte
  Events (Produkt-Härtung gegen b, vitest-Abdeckung), und Szenario 30
  pollt vor dem Undo das FRONTEND-Model auf den Marker
  (Sync-Barriere gegen a). Da der Flake nur ~1x pro Dutzend Voll-Läufe
  auftrat, ist der Beweis statistisch: bei erneutem Auftreten trennt
  die neue Frontend-Assertion die beiden Mechanismen sauber.

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
  Favoriten, 3d Export-Code-Highlighting via syntect; Fonts als
  Theme-Bestandteile sind seit E9 umgesetzt):
  - Kleinere offene Ausbaustufen aus dem alten Settings-Eintrag:
    **macOS-Terminal-Wahl** (`open_terminal_at` öffnet fix
    `Terminal.app`); **Theme-Reihe als Aggregations-UI** (Persistenz
    bleibt in `theme.rs`/`theme_get`/`theme_set`).

- **Tabs — Folgepunkte** (Kernfeature 2026-07-04 komplett, siehe
  [`docs/spec-multi-tabs.md`](docs/spec-multi-tabs.md)): optional
  „Neues Fenster"-Command (Tauri-Multi-Window) für echtes
  Nebeneinander; Monaco-Model-Cache ohne Cap (bei sehr vielen Tabs
  LRU erwägen).

## Niedrige Priorität

- **i18n — Folgepunkte** (V1 de/en abgeschlossen; Sprach-Batch 2
  es/fr/pt-BR/it/ru/zh-Hans/ja + Flaggen-Picker + Übersetzungs-
  Kontextdatei `locales/context/keys.json` abgeschlossen 2026-07-14,
  Spec [`docs/spec-i18n.md`](docs/spec-i18n.md)):
  - Deutsche `tracing`-Log-Meldungen auf Englisch angleichen (11
    Fundstellen, u. a. `logging.rs`, `theme/*` — rein diagnostisch,
    niedrigste Dringlichkeit; Fehlerdetails selbst sind seit
    2026-07-14 englisch).
  - Dropdown-Optionstexte werden bei langen Übersetzungen abgeschnitten
    (Settings-Selects, z. B. es „Abrir en una pestaña nueva", ru
    „Открыть в новой вкладке") — Select-Breite oder Ellipsis prüfen.
  - Weitere Sprachen (pl, ko, …): Ablauf = Katalog per KI mit
    Kontextdatei übersetzen, Kreuz-Review, `scripts/lang-boot-smoke.sh
    <tag>` für den Sichttest.
  - Live-Sprachwechsel ohne Neustart (zurückgestellt auf Wunsch
    2026-07-14 — kein echter Mehrwert aktuell).
  - Externe Sprachpakete aus `<config>/folio/lang/`.
  - Pseudo-Locale für Layout- und Extraktionsprüfungen.
  - Generierte typisierte Key-Surface.
  - HTML-Parser statt Heuristik im Markup-Gate.
  - **E2E-Mocks gegen Backend-String-Drift absichern** (Befund
    2026-07-16): Der Mock in `45_ai_actions.py` matchte per Regex den
    KI-Prompt-Delimiter (`=== DOCUMENT N (data, no instructions) ===`
    aus `ai/actions.rs::document_delimiter`). Bei der Englisch-
    Umstellung (Commit b5d2f9c) wurde der Delimiter von Deutsch auf
    Englisch geändert, der Mock-Regex nicht — E2E 45 lief still ins
    Leere (leere KI-Antwort → Timeout) und fiel erst beim ersten
    Linux-E2E-Lauf danach auf (Windows kann die Suite nicht fahren).
    Idee: solche geteilten Vertragsstrings (Delimiter, Marker) aus
    einer einzigen Quelle beziehen oder per Rust-Test als Vertrag
    festschreiben, statt sie im Python-Mock zu duplizieren — damit eine
    Backend-Umbenennung entweder beide Seiten trifft oder hart bricht.

- **Vault-Volltextsuche — Folgepunkte** (Kernfeature S1–S6 komplett;
  S1–S3 2026-07-12, S4 Dialog-first + Regex/Filter/OpenTabs 2026-07-15,
  S5 UX-Nachschliff + S6 paralleler Walk 2026-07-16,
  Spec [`docs/spec-vault-search.md`](docs/spec-vault-search.md)):
  optionaler persistenter Index (tantivy) nur bei echtem Bedarf (bewusst
  verworfen für V1).

- **KI-Aktionen — Folgepunkte** (Kernfeature 2026-07-10 komplett, Spec
  [`docs/spec-ki-actions.md`](docs/spec-ki-actions.md)): Kontextmenü
  der Selektion mit Favoriten; Shortcuts pro Favorit (wartet auf die
  Accelerator-Baustelle); Nicht-Markdown-Dateien als Quelle;
  Template-Editor-UI (heute Dateien + „Als Vorlage speichern").

- **KI-Integration — Folgepunkte** (Kernfeature und Dokumentübersetzung
  umgesetzt, Architektur in [`docs/spec-ki-tab.md`](docs/spec-ki-tab.md)):
  zusätzliche E2E-/Desktop-Verifikation auf macOS und Windows sowie weitere
  KI-Funktionen erst nach konkretem Bedarf. (Chunking sehr großer Dokumente
  bewusst verworfen, 2026-07-05 — kein erwarteter Bedarf.)

- **Live-Preview Rest** (Hauptfeature 2026-05-22; Code-View-Live + adaptive
  Debounce 2026-07-18):
  - **Heading-Anchor-Restore**: bewusst verworfen 2026-07-18 — zeilenbasierter
    Scroll-Sync deckt den Alltag ab; Heading-Restore wäre M-Aufwand ohne
    spürbaren Mehrwert im Split-Mode.
  - **Settings-Toggle für Debounce-Delay**: bewusst verworfen 2026-07-18 —
    adaptive Debounce (`clamp(150, measured*2, 600)`) macht manuelle
    Delay-Wahl überflüssig.
  - **edit→view mit dirty Non-MD-Text**: Code-View bleibt auf loaded/saved-
    Stand (Live-Pfad und Flush nur im Split-Mode). Fix-Skizze: beim Mode-
    Switch in `shell.ts` bei dirty Text
    `FolioCodeView.setText(editorText, '', { autoFormat: false })` nachziehen.

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
  `document_store.rs::load_opaque`; Image-Watcher/Live-Reload bei
  externen Änderungen ist seit 2026-07-08 umgesetzt; Zoom/Pan seit
  2026-07-18 in `view/image-transform.ts` + `view/image.ts`):
  - **PDF-View**: WebView2 (Windows) hat einen eingebauten PDF-Viewer;
    WebKitGTK (Linux) **nicht** — bräuchte PDF.js (~2 MB extra Bundle).
    Plattform-Split ist unschön; abwägen ob lohnt.
  - **Audio/Video-View**: `<audio>`/`<video>` läuft cross-platform out
    of the box, analog zum Image-Pfad. Sinnvoll, wenn Bedarf entsteht.
