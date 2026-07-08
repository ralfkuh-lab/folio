# Spec: Ctrl+Klick auf interne Markdown-Links öffnet im neuen Tab

Kleines Feature als Release-Nachschub. Erwartung: In der Markdown-View
(View-/Split-Mode) öffnet Ctrl+Klick (macOS: Cmd) auf einen Link zu
einer anderen Datei das Ziel in einem **neuen Tab** — gleiche Konvention
wie im Vault (Ctrl/Cmd-Klick + Mittelklick → `tab_open`). Mittelklick
auf Links soll sich genauso verhalten.

## Ist-Zustand

- Frontend: `view/markdown.ts::initMarkdownView` fängt Klicks auf `<a>`
  im Content per Capture-Handler, postet `{type:'linkClick', href}`
  über die shell-event-Bridge (`post`), davor `requestSaveIfDirty`.
- Backend: `commands/events/router.rs` dispatcht `linkClick` →
  `navigation.rs::link_click(href, …)`. Der `link_interceptor`
  klassifiziert in `OpenExternal` / `Navigate{path, anchor}` /
  `Missing`; `Navigate` lädt via `document_service::open` in den
  **aktiven** Tab.
- `commands/tabs.rs` hat die interne Transition `open(&state, &handle,
  path)` (von `tab_open` genutzt): dedupliziert bereits offene Pfade
  (aktiviert statt öffnet), recycelt leere aktive Tabs, danach
  `emit_navigation_changed`.

## Änderungen

### Frontend (`view/markdown.ts`)

- Click-Handler: `const newTab = e.ctrlKey || e.metaKey;` und das Flag
  in den Payload aufnehmen: `post({ type: 'linkClick', href, newTab })`.
- Bei `newTab` den `requestSaveIfDirty`-Umweg **überspringen** — der
  aktive Tab (und seine ungespeicherten Änderungen) bleibt unberührt,
  der Dirty-Prompt wäre falscher Alarm.
- Zusätzlich `auxclick`-Handler (nur `e.button === 1`, Mittelklick) auf
  demselben Capture-Pfad: wie Ctrl+Klick (`newTab: true`), inkl.
  `preventDefault`.
- Nur die Markdown-View; HTML-View-iframe-Links bleiben außen vor.

### Backend

- `router.rs`: `linkClick` um optionales Bool-Feld `newTab` erweitern
  (fehlend → `false`); bestehende Aufrufer ohne Feld (HTML-View,
  About-Dialog) funktionieren unverändert.
- `navigation.rs::link_click(href, new_tab, state, handle)`:
  - `LinkAction::Navigate { path, .. }` + `new_tab == true` →
    `commands::tabs::open(state, handle, path)` +
    `emit_navigation_changed` (identisch zum `tab_open`-Command;
    ggf. Sichtbarkeit der internen Helfer anpassen). Der `anchor` wird
    im newTab-Fall bewusst ignoriert (Ziel-Tab startet oben; die
    Dedupe-Aktivierung eines bereits offenen Pfads soll keinen
    Scroll-Sprung erzwingen).
  - `OpenExternal` / `Missing`: unverändert, Flag wird ignoriert
    (externe Links öffnen auch mit Ctrl im System-Browser).
  - Ohne Flag: bestehender Pfad 1:1.

## Tests

- **jsdom** (neu `tests/view/markdown-links.test.ts`, `post` aus der
  Bridge mocken): normaler Klick → Payload ohne/`newTab:false` und
  `requestSaveIfDirty` wird gewartet; Ctrl-Klick → `newTab:true` ohne
  Dirty-Prompt; Cmd (metaKey) ebenso; `auxclick` button 1 →
  `newTab:true`; Klick auf Nicht-Link → kein Post.
- **Rust**: Test für das Router-Parsing (`newTab` fehlt/`true`), falls
  der Router testbar aufgebaut ist; sonst Unit-Test an der Stelle, an
  der sich das Flag am billigsten verifizieren lässt.
- **E2E** (neues Szenario `41_link_new_tab.py`; vorher
  `docs/e2e-headless-caveats.md` lesen): `sample.md` enthält bereits
  einen relativen Beispiel-Link. Öffnen im View-Mode →
  `POST /tabs/close_all`-Hygiene, dann per `/eval` einen synthetischen
  `click` mit `ctrlKey:true` auf das erste `.markdown-body a[href$=".md"]`
  dispatchen → `GET /tabs` zeigt zwei Tabs, der neue ist aktiv und
  trägt den Zielpfad; der Ausgangstab ist unverändert. Aufräumen im
  `finally` mit `tabs_close_all`. Falls `sample.md` keinen Link auf
  eine echte existierende `.md`-Fixture hat, temporäre Fixture-Dateien
  im tmp-Verzeichnis erzeugen (Muster aus `40_find_code_view.py`).

## Gates

- `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- `cd src-tauri/web && npm test && npm run build` (dist-Bundles gehören
  zum Diff)
- **Nicht committen.**
