# E2E-Suite — Headless-Caveats

Die Folio-E2E-Suite läuft standardmäßig unter Linux mit Xvfb (siehe
`tests/e2e/README.md` und `CLAUDE.md` Abschnitt „Headless-Screenshots"
+ „Hintergrund-Test-Strategie"). WebKitGTK in dieser Umgebung verhält
sich an einigen Stellen unterschiedlich von einer echten Desktop-WebView.
Dieses Dokument sammelt die bekannten Eigenheiten und Workarounds, damit
nachfolgende Tests/Test-Schreiber nicht jedes Mal neu raten müssen.

## 1. Scroll-State propagiert nicht zuverlässig

`state.view.scrollY` und der DOM-`scrollTop` werden nach einem Anchor-
Jump (TOC-Klick, `/toc/activate`) **nicht zuverlässig** auf den neuen
Offset aktualisiert. Der Jump funktioniert (Section ist visuell im
Viewport, sichtbar am Screenshot), aber die Zahlen-Synchronisation
bleibt brüchig.

**Workaround:** Visuelle Verifikation per Screenshot statt numerische
Assertion auf `scrollY`. Beispiele: `02_view_mode.py`, `20_toc_click.py`.

## 2. Monaco-Canvas-Capture nur via Monitor-Screenshot

Monaco rendert in ein Canvas-Element. Window-basierte Screenshot-Libs
(`xcap` u. ä.) sehen den Canvas-Inhalt im Window-Pixmap **nicht**.
`tauri-plugin-screenshots` v2.2.0 nimmt deshalb einen Monitor-Capture
(nicht Window-Capture); das ist der einzige in Xvfb funktionierende
Weg, Monacos Output sichtbar zu erfassen. Test-Belege und Methodik:
`docs/headless-monaco-test-results.md`.

**Konsequenz für Tests:** Jeder Test, der einen Editor-Screenshot
prüft, muss die Folio-App und die Suite **im selben Xvfb-Framebuffer**
fahren (`DISPLAY=:99` für beide). Mehrere Folio-Instanzen parallel auf
demselben `:99` sind möglich, aber die Screenshots zeigen den gesamten
Monitor — wenn ein zweites Fenster im Weg ist, schlägt der Diff fehl.

## 3. Synthetische KeyboardEvents greifen nicht in Monaco

Ein `KeyboardEvent` per JavaScript-`dispatchEvent` an `document` bzw.
`#editor-mount` läuft nicht durch Monacos internen Keyboard-Stack.
Konkret: Shortcuts wie `Ctrl+Z`, `Ctrl+B`, `Tab`-Indent reagieren
**nicht** auf synthetic events.

**Workaround:** Über `/editor/command {command, args?}` (Phase 0) den
Monaco-Adapter direkt rufen — z. B. `editor_command("undo")` triggert
`editor.trigger('menu', 'undo', null)`. Für Type-Operationen die
`FolioEditor.insertText`-Hilfsfunktion (Phase 1), die
`editor.trigger('keyboard', 'type', { text })` aufruft und korrekt im
Undo-Stack landet.

Die `/key`-API ist trotzdem nützlich — sie deckt **DOM**-Keybindings ab
(`Ctrl+1` / `Ctrl+2` für Mode-Switch, `Ctrl+F` für find-bar, `Ctrl+S`
für save). Diese hängen an `document.addEventListener('keydown', …)`
und werden vom synthetic event korrekt getriggert. Beispiele:
`15_keybindings.py`.

## 4. Native Tauri-Menü-Items sind aus dem WebView unerreichbar

Die OS-Menü-Bar (Datei / Bearbeiten / Ansicht / Hilfe) lebt außerhalb
des WebView-DOMs. `/click` kann sie nicht treffen, native Accelerators
(`Ctrl+S` als Menü-Accelerator, `Ctrl+Q` zum Beenden, `Ctrl+W` zum
Schließen) laufen vom WebView aus betrachtet ins Nichts.

**Workaround:** `/menu/click {id}` (Phase 0) ruft
`menu::dispatch_menu_action` synthetisch auf — derselbe Routing-Pfad,
den ein echter Menü-Klick auslöst, nur ohne OS-Eingabe. Backend-
Aktionen wie Save-As/Rename laufen direkt in Rust; UI-Aktionen werden
als `menu:<id>`-Event ans Frontend emittiert.

Beispiele: `11_menu_file.py`, `12_menu_edit.py`, `13_menu_view.py`,
`14_menu_help.py`.

**Achtung:** `/menu/click` hat **keinen Ack**-Mechanismus, weil die
Frontend-`menu:*`-Listener (in `menu-router.ts`) keine `requestId`
durchreichen. Tests synchronisieren über `/wait` (für `document.saved`,
`editor.ready` etc.) oder `/state`-Polling.

## 5. OS-Dialoge können nicht direkt gemockt werden

Menü-Items wie `file.open`, `file.save_as`, `file.rename` öffnen native
Dateidialoge (Tauri-`pick_file`). Es gibt keinen Programmweg, diese
Dialoge aus dem Test zu simulieren — `/menu/click` triggert den
Dialog, blockiert dann aber.

**Workaround:** Diese Items in den Szenarien explizit auslassen
(dokumentiert, nicht versucht). Verifikation der dahinterliegenden
Logik geht über die Direkt-API: `/open`, `/save` (Phase 0 nicht
involviert — die existierten schon).

## 6. `alert()` blockiert die WebView-JS-Schleife

`help.about` ruft `alert('folio v…')`. Das blockiert die WebView und
damit auch die Automation-API. `/menu/click help.about` würde alles
einfrieren, bis der User händisch wegklickt.

**Workaround:** Item explizit nicht testen, dokumentiert in
`14_menu_help.py`. Wenn About-Dialog mal zu echtem Tauri-Dialog wird,
können wir den Pfad reaktivieren.

## 7. `applyReplace` und der Undo-Stack (Historie)

Bis 2026-05-19 rief `FolioEditor.applyReplace` (in `editor/text.ts`)
`editor.setValue(fullText)`. Monaco interpretiert das als Hard-Reset
und leerte damit den gesamten Undo-Stack — jeder Klick auf
Bold/Italic/Heading/… machte die Edit-Historie davor unwiederbringlich
weg.

**Aktueller Stand:** Fix im Commit, der `applyReplace` auf
`editor.executeEdits('applyReplace', [{range: fullRange, text}])`
umgestellt hat. Voll-Range-Replace landet als ein Edit im Stack und
ist regulär undo-bar. Regression-Sperre: `09_undo_redo.py` macht jetzt
nach dem `insertText`-Pfad zusätzlich einen Bold-Wrap und prüft, dass
der per `undo` zurückgenommen wird.

## 8. `/history/back` und `/history/forward` am Stack-Ende (Historie)

Bis 2026-05-19 hat `commands::nav::move_history` (und der Phase-0-
Pendant in `automation/handlers/ui.rs`) nicht geprüft, ob ein
Back/Forward überhaupt möglich ist. `NavigationController::go_back/
go_forward` liefert per Konvention auch am Edge `current()` zurück —
die Move-Wrapper haben das als „echte Bewegung" interpretiert und
unnötig `document_store.load` + `navigation:changed` ausgelöst.

**Aktueller Stand:** Beide Move-Wrapper haben jetzt einen
`can_go_back`/`can_go_forward`-Check vorgeschaltet. Am Edge liefern sie
`Ok(None)` bzw. `{moved: false, entry: null}` ohne Side-Effects. Der
Edge-Case ist als zusätzlicher Step in `18_history.py` abgesichert.
Die `NavigationController`-API selbst bleibt unverändert — der
`stay_at_edges`-Test in `navigation.rs` dokumentiert die low-level-
Semantik weiterhin.

## 9. Async-Pfade ohne deterministisches Sync-Signal

Manche Endpoints — insbesondere `/menu/click`, der ganze Toolbar-
`apply_editor_command`-Stack, `vault:refresh` nach Pin/Unpin — laufen
asynchron im Frontend weiter, nachdem der HTTP-Endpoint schon
geantwortet hat. Es gibt nicht für jeden Pfad einen passenden
`/wait`-Event.

**Workaround in Tests:** Kurzes Polling auf den erwarteten Zustand
(`/state`, `/dom`, `/editor/text`) mit ~2 s Timeout und 50–100 ms
Intervall. Helper-Funktion `_poll_state` / `_poll_text` etc. sind in
mehreren Phase-1+-Szenarien dupliziert; eine zentrale Helper-Lib wäre
für eine spätere Refactoring-Pass sinnvoll.

## 10. Visual-Diff: Subpixel-Antialiasing-Rauschen

Pillow's `ImageChops.difference` ist pixel-exakt. Subpixel-Antialiasing
und Schriftart-Hinting können selbst bei identischem Rendering
zwischen Runs unterschiedliche Bytes liefern.

**Workaround:** `VisualSuite` hat einen `diff_threshold` (Default 12
auf Y-Channel) und einen `threshold_ratio` (Default 1 % der Pixel
dürfen abweichen). Beides ist pro Aufruf von `ctx.screenshot(…)`
übersteuerbar.

## 11. Erster Lauf: Auto-Baseline-Erstellung

Wenn eine Baseline-PNG für ein Szenario noch nicht existiert,
schreibt `VisualSuite` (`tests/e2e/lib/visual.py`) sie automatisch
mit der aktuellen Aufnahme und meldet den Step als „PASS — baseline
created (first run)". Erst der **zweite** Run gegen diese Baseline
kann fehlschlagen.

**Konsequenz:** Beim Hinzufügen eines Szenarios ist kein separater
`--update-baselines`-Lauf nötig. Wenn UI-Änderungen anstehen,
sollte man die Baselines vor dem Commit visuell prüfen (z. B. mit
einem Bildbetrachter) — versehentliche Baselines sind sonst eingefroren.

## Szenarien-Marker: `DESKTOP_ONLY`

Manche zukünftige Szenarien werden auf Xvfb gar nicht funktionieren
(z. B. echter OS-Dialog-Test, Multi-Monitor-Capture, GPU-spezifisches
Rendering). Diese können sich als Modul-Konstante markieren:

```python
# tests/e2e/scenarios/22_some_desktop_thing.py
DESKTOP_ONLY = True

def run(ctx):
    ...
```

Der Orchestrator (`run.py`) skipt solche Szenarien standardmäßig.
Mit `--include-desktop-only` werden sie mitgenommen — nutzbar für
einen manuellen Lauf auf einem echten Desktop oder unter VNC-Session.

Heute (Stand 2026-05-18) hat **kein** Szenario diesen Marker — alle
laufen unter Xvfb. Die Infrastruktur ist eine reine Vorhaltung für
spätere Tests, die OS-Eingabe oder echte Display-Hardware brauchen.
