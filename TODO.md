# TODO

## Hohe Priorität

- **Automation-API für E2E-Tests vervollständigen** — Voraussetzung für eine
  vollautomatische Hermes-Test-Routine. Nach Codex-Synthese (2026-05-12)
  fehlen primär Test-Blocker:
  - **`POST /key`** — Tastatur-Events. Payload `{ key, modifiers?: {ctrl,shift,alt,meta}, target?: 'document'|'editor' }`.
    Pattern wie `automation:click`: Backend emittet `automation:key`, Frontend
    dispatcht synthetischen `KeyboardEvent` aufs Ziel. `preventDefault`-Listener
    (Strg+S, F3, Strg+F, Alt+←/→, Strg+1/2) sind damit testbar. Monaco-eigene
    Shortcuts (Strg+Z, Tab-Indent) später über separaten `POST /editor/command {command}`,
    der `editor.trigger('keyboard', cmdId)` ruft — synthetische Events sind dafür
    fragil.
  - **`GET /editor/text`** — kompletter Editor-Inhalt. Nicht in `/state` aufnehmen
    (Markdown kann groß sein, `/state` ist Polling-Snapshot).
  - **`POST /editor/selection {start, length}`** — Selection setzen, damit
    Formatierungs-Commands (Bold-Wrap etc.) deterministisch getestet werden können.
  - **`POST /wait`** — `{ event: 'editor.ready'|'document.loaded'|..., timeoutMs }`.
    Eliminiert Polling-Flakes. Backend hält die Verbindung, bis das Event feuert
    oder Timeout.
  - **Ack-Semantik für Event-Aktionen** (`/click`, `/key`, `/toc/activate`) —
    aktuell bestätigt der Endpoint nur "Event emittiert", nicht "Handler durch".
    Lösung: Frontend acked nach Handler-Ende über ein eigenes Event; Backend
    wartet drauf (z. B. via oneshot-Channel) bis zum Timeout.
  - Mittlerer Hebel: **`GET /dom?selector=...`** (Status-Text + View-Body ohne
    Screenshot/OCR), **Console-Error-Capture** (Frontend abfangen + an Backend
    streamen), **Scroll-State in `/state`** (Werte bereits im NavEntry).
  - Niedriger Hebel: Right-Click/Context-Menu, Workspace-Inspektion
    (pinned/recent/expanded dirs).
- **E2E-Test-Routine + Baseline-Screenshots** — Skript, das die App in Xvfb
  startet, eine Aktions-Sequenz fährt und über `/screenshot` + Pixelmatch
  gegen Baseline-PNGs verifiziert. Voraussetzung sind die Automation-API-
  Ergänzungen oben. Setup: Linux-Build (`cargo tauri build --bundles deb`)
  + Xvfb-Display, Python/Bash-Treiber, `compare -metric AE` o. ä.
  Hermes-Agent kann die Routine dann eigenständig fahren.

## Mittlere Priorität

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
- **Englisches Menü-Set**: `src-tauri/src/menu/strings.rs::en()` ist
  aktuell ein Platzhalter (gibt deutsche Strings zurück). Wenn das
  Settings-Panel die Sprachwahl bekommt, hier die englische Übersetzung
  ergänzen — der Builder zieht sie automatisch über `labels(lang)`.
- **Editor-Minimap aktivierbar machen**: Monaco hat eine Minimap eingebaut
  (in `editor.ts` aktuell `minimap: { enabled: false }`). Toggle in der
  Edit-Toolbar oder Statusbar, Persistenz analog zu Theme/RailVisibility.
  Suchtreffer landen schon in der Minimap-Position-Inline.
