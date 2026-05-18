# TODO

## Hohe Priorität

- **Automation-API für E2E-Tests vervollständigen** ✅ — Kern + alle
  offenen Hebel implementiert (Stand 2026-05-12). Hermes-Agent hat
  jetzt das vollständige API-Inventar (POST /key, GET /editor/text,
  POST /editor/selection, POST /wait, ACK-Semantik auf /click + /key +
  /toc/activate + /mode + /open-ui + /editor/selection, GET /dom,
  Console-Error-Capture, Scroll-/Workspace-State in /state,
  POST /rightclick). Schritte 1-5 der Codex-Synthese (2026-05-12):
  - ✅ **`POST /key`** (Commit `3e9bf18`) — Tastatur-Events. Payload `{ key, modifiers?: {ctrl,shift,alt,meta}, target?: 'document'|'editor' }`.
    Pattern wie `automation:click`: Backend emittet `automation:key`, Frontend
    dispatcht synthetischen `KeyboardEvent` aufs Ziel. `preventDefault`-Listener
    (Strg+S, F3, Strg+F, Alt+←/→, Strg+1/2) sind damit testbar. Monaco-eigene
    Shortcuts (Strg+Z, Tab-Indent) später über separaten `POST /editor/command {command}`,
    der `editor.trigger('keyboard', cmdId)` ruft — synthetische Events sind dafür
    fragil.
  - ✅ **`GET /editor/text`** (Commit `cb8a0d1`) — kompletter Editor-Inhalt. Nicht in `/state` aufnehmen
    (Markdown kann groß sein, `/state` ist Polling-Snapshot).
  - ✅ **`POST /editor/selection {start, length}`** (Commit `cb8a0d1`) — Selection setzen, damit
    Formatierungs-Commands (Bold-Wrap etc.) deterministisch getestet werden können.
  - ✅ **`POST /wait`** (Commit `0b4abda`) — `{ event, timeoutMs }`.
    Allowlist `editor.ready` (Latch) + `document.loaded` (Future-Event).
    Backend hält Verbindung bis Event feuert oder Timeout. Trigger-Punkte:
    `editor_ready`-Command + `DocumentEvents.loaded`-Callback. Default-
    Timeout 5000 ms.
  - ✅ **Ack-Semantik für Event-Aktionen** (`/click`, `/key`, `/toc/activate`) —
    Commit `f3225e0`. Endpoints warten via oneshot bis Frontend-Handler
    durch ist (Default 1000 ms, per Query `?ackTimeoutMs` überschreibbar),
    Response `{ ok, acked, requestId }`. Frontend ackt nach Microtask + rAF
    via `invoke('automation_ack', {id})`.
    Lösung-Design (mit Codex synthetisiert, 2026-05-12):
    - Backend: `AppState.pending_acks: Mutex<HashMap<u64, oneshot::Sender<()>>>`
      + `AtomicU64 next_ack_id`. Handler legt Sender ab, emittet
      `automation:click` (etc.) mit zusätzlichem `requestId`, wartet via
      `tokio::time::timeout` auf Receiver (Default 1000 ms, per Query
      `ackTimeoutMs` override), liefert `{ ok, acked: bool }`. Bei Timeout
      `remove(&id)` aus der Map. Spätes ACK → Sender weg → ignoriert.
    - Frontend: Helper `ackHandler(payload, work)` macht
      `await work(); await Promise.resolve(); await new Promise(r =>
      requestAnimationFrame(r)); invoke('automation_ack', { id })`. Microtask
      + RAF sind nötig, weil DOM-Mutationen + Listener-Kaskaden + Render
      sonst nicht durch sind. Neuer Tauri-Command `automation_ack` ruft
      `map.remove(&id)?.send(())`.
    - Datenstruktur-Wahl: `std::sync::Mutex<HashMap>` (kein Lock-Hold über
      await), kein `Notify` (kein Payload/ID, signal loss), kein
      `broadcast/watch` (Streams/State, nicht single-correlated-requests),
      kein `DashMap` (Loopback hat wenig Parallelität).
    - Frontend-ACK über `invoke` statt `emit`: gerichteter RPC, typisiert,
      validierbar — Event-Router-Pfad wäre semantisch Pub/Sub und indirekter.
    - Versions-Counter im `/state` als simpler Fallback verworfen: bewiesen
      nicht, dass *dieser* Request fertig ist; oneshot ist kausal sauberer.
    - Scope erste Runde: `/click`, `/key`, `/toc/activate`. Andere ACK-fähige
      Endpoints (`/editor/selection`, `/mode`, `/open-ui`) später.

  Alle Folge-Hebel erledigt:
  - ✅ Scroll-/Cursor-State in `/state` (Commit `3ad2101`)
  - ✅ `/wait`-Allowlist (`document.saved`, `document.dirty_clean`) (`3ad2101`)
  - ✅ Workspace-Inspektion in `/state` (`3ad2101`)
  - ✅ `GET /dom?selector=...` (`2d1521d`)
  - ✅ ACK-Wrapper auf `/mode`, `/open-ui`, `/editor/selection` (`9cb4116`)
  - ✅ Console-Error-Capture + `/state.consoleErrorCount` +
    `GET /console/errors?clear=true` (`400d41d`)
  - ✅ `POST /rightclick {name, coords?}` (`<pending commit>`)
- **E2E-Test-Routine + Baseline-Screenshots** ✅ — `tests/e2e/`
  (Python + Pillow, 7 Szenarien) + Wrapper `scripts/run-e2e.sh`
  (startet Xvfb + Folio + Suite + Cleanup). Agent-Einstieg:
  [`docs/e2e-testing.md`](docs/e2e-testing.md) — eine Anweisung
  (`bash scripts/run-e2e.sh`) genügt. Fehler werden in `errors.md`
  protokolliert und automatisch als TODO-Eintrag oben hier ergänzt.

## Mittlere Priorität

- **Config-/Einstellungen-Bereich**: Eigener Settings-Dialog/-Panel für
  Anwendungs-Einstellungen (Theme, Font/Schriftgröße, Editor-Optionen,
  Vault-Pfade, Automation-Port, …). Persistenz analog zur Window-State-
  Speicherung; Aufruf über Menü oder Statusbar.
  - **macOS: Terminal-Wahl im Settings-Panel** — `open_terminal_at` öffnet
    auf macOS aktuell immer `Terminal.app`. Sobald der Settings-Bereich
    existiert, dort eine Auswahl anbieten (Terminal.app, iTerm2, Warp, …
    oder freies Eingabefeld für den App-Namen). Bis dahin funktioniert
    der Default zuverlässig.
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

## E2E-Test Ergebnisse (2026-05-18)

- **E2E-Run 2026-05-18 12:38: Alle Szenarien PASS (7/7)** — Details in
  [`tests/e2e/artifacts/20260518-123827/report.md`](tests/e2e/artifacts/20260518-123827/report.md).
  Keine Fehler, Exit-Code 0.

- **E2E-Run 2026-05-18 12:37: 1 Fehler** — Details in
  [`tests/e2e/artifacts/20260518-123705/errors.md`](tests/e2e/artifacts/20260518-123705/errors.md). Run-Report:
  [`tests/e2e/artifacts/20260518-123705/report.md`](tests/e2e/artifacts/20260518-123705/report.md).

- **E2E-Run 2026-05-18 11:38: 6 Fehler** — Details in
  [`tests/e2e/artifacts/20260518-113816/errors.md`](tests/e2e/artifacts/20260518-113816/errors.md). Run-Report:
  [`tests/e2e/artifacts/20260518-113816/report.md`](tests/e2e/artifacts/20260518-113816/report.md).

- **E2E-Run 2026-05-18 11:37: 1 Fehler** — Details in
  [`tests/e2e/artifacts/20260518-113727/errors.md`](tests/e2e/artifacts/20260518-113727/errors.md). Run-Report:
  [`tests/e2e/artifacts/20260518-113727/report.md`](tests/e2e/artifacts/20260518-113727/report.md).
