# Spec — Zen-Modus + Vollbild

**Status**: ✅ umgesetzt 2026-08-17 (Kreuz-Review codex + agy, E2E-Voll-Lauf grün)
**Ausgangspunkt**: [`docs/feature-ideen.md`](feature-ideen.md) Top-Konsens #5
(„Zen-/Fokus-Modus + Typewriter-Scrolling", `[S–M]`, von allen drei Quellen
genannt)

## Ziel

Ein Toggle blendet alles außer dem Dokument aus. Zweck im konkreten
Gebrauch: langen Agent-Output ablenkungsfrei **lesen** und folio
**herzeigen** können, ohne dass Toolbar, Rails und Leisten den Blick
teilen.

## Scope-Entscheidungen (getroffen 2026-08-17)

Die ursprüngliche Idee bündelt drei Dinge. Umgesetzt wird nur das erste:

- **Chrome ausblenden** — ja.
- **Absatz-Fokus (Umfeld dimmen)** — **nein.** Beim Schreiben stark, beim
  Lesen hinderlich: der Überblick über einen langen Output ist genau das,
  was man will. Nicht umsetzen, auch nicht als Setting.
- **Typewriter-Scrolling** — **nein.** Braucht einen Cursor und ist im
  View-Mode wirkungslos.

Weiter:

- **Zoom ist bereits da** (`ui/zoom.ts`, `set_webview_zoom`, Strg +/− und
  Strg+Mausrad, persistiert unter `folio.zoom`). Kein Teil dieser Etappe.
- **Vollbild und Zen sind getrennte Toggles.** Vollbild ist eine
  Eigenschaft des OS-Fensters, Zen eine des App-Layouts, und beide werden
  einzeln gebraucht: F11 allein, um auf einem großen Monitor mehr
  Vault-Baum zu sehen (Rails bleiben!); Zen allein, wenn folio als Fenster
  neben dem Terminal liegt. Verkettet werden sie über ein Setting.

## Nicht-Ziele

- Kein Slide-/Präsentationsmodus (Dokument an `---`/H1 schneiden) — das
  ist Idee #6 und etwas anderes.
- Keine eigene Zen-Typografie (andere Schrift, andere Textbreite). Der
  vorhandene Zoom deckt den Präsentationsbedarf ab.
- Keine Persistenz des Zen-Zustands über den App-Neustart: wer im Zen
  beendet, startet normal. Ein unsichtbar gebliebener Modus wäre beim
  nächsten Start schwer zu erklären.

---

## Kernentscheidung: Zen ist ein Layer, kein Zustandswechsel

**Zen darf keinen persistierten UI-Zustand überschreiben.** Die
Rail-Sichtbarkeit liegt in `panel_state.rs`
(`left_rail_visible`/`right_rail_visible`) und überlebt den Neustart. Ein
Zen, das beim Einschalten die Toggles auf „aus" setzt, hätte dem Nutzer
seine offene Vault-Rail dauerhaft weggenommen — Ausschalten stellt sie
nicht wieder her, weil der alte Wert überschrieben ist.

Deshalb: **Body-Klasse `zen-mode` plus CSS.** Die Klasse überdeckt, was
sichtbar wäre; `panel_state.json` wird nicht angefasst. Beim Verlassen ist
alles wie vorher, ohne dass irgendwo ein Vorzustand rekonstruiert werden
muss.

Dasselbe Prinzip beim Vollbild: Zen **merkt sich, was es vorgefunden hat**.
War das Fenster schon per F11 im Vollbild, lässt Zen es beim Verlassen
dort. Hat Zen es selbst eingeschaltet, nimmt es das zurück.

## Was Zen ausblendet

Per CSS unter `body.zen-mode`:

| Element | |
|---|---|
| `#toolbar` | |
| `#vault-region` | linke Rail |
| rechte Rail (TOC + Backlinks) | |
| `#tab-bar` | |
| `#statusbar` | |

**Sichtbar bleibt** der Zoom-Indikator (`#zoom-indicator`) — er ist ein
transientes Overlay, und gerade beim Präsentieren will man die Rückmeldung
beim Zoomen sehen.

Der Modus gilt in **allen drei Anzeigemodi** (view/edit/split). Er ist
kein vierter Mode, sondern orthogonal dazu — dieselbe Trennung wie beim
Git-Diff (siehe `CLAUDE.md`: „Aktion mit Enabled-Zustand, kein vierter
View-Mode").

## Bedienung

| Auslöser | Wirkung |
|---|---|
| **F11** | nur Vollbild, Layout unverändert |
| **Shift+F11** | Zen-Toggle |
| Menü *Ansicht* | zwei Einträge: „Vollbild" und „Zen-Modus" |
| Command Palette | beide über `menu_dispatch` |
| **Escape** | verlässt Zen — **nur wenn sonst nichts offen ist** |

Zur Kürzelwahl: `Strg+Shift+Z` wäre naheliegend, ist aber als Redo belegt
(`toolbar-actions.ts`), ebenso `Strg+K` (Monaco-Chord-Prefix) und
`Strg+Shift+F` (Vault-Suche). **Shift+F11** liegt neben F11, ist
thematisch verwandt und nachweislich frei.

Escape ist bereits für Kontextmenü, Find-Bar, Command Palette und Dialoge
belegt. Der Zen-Ausstieg ist der **letzte** Kandidat in dieser Kette: nur
greifen, wenn keiner der anderen etwas zu schließen hatte.

Ausgelöst werden beide Kürzel wie die übrigen über den DOM-Capture-Block
in `ui/toolbar-actions.ts` → `menu_dispatch`, nicht über den
OS-Accelerator-Dispatch (siehe die offene Accelerator-Baustelle in
`TODO.md`). Die Menü-Items tragen den Accelerator trotzdem — als
**Anzeige**, sonst wären die beiden einzigen Shortcuts der App ohne
Fundstelle im Menü. Ein Doppel-Toggle entsteht dadurch nicht: dieselbe
Konstellation hat Strg+Z seit jeher, und beide Pfade münden in denselben
`menu_dispatch`-Aufruf. Nachgemessen am 2026-08-18 mit echten X-Events
(XTEST unter Xvfb, kein synthetisches WebView-Event): vier Shift+F11 →
genau vier Zen-Wechsel, F11 schaltet Vollbild 1:1.

### Ausstiegs-Hinweis

Wer Zen zum ersten Mal aktiviert, sieht kein Bedienelement mehr — beim
Präsentieren vor Publikum ist Suchen peinlich. Deshalb beim **ersten**
Aktivieren ein transienter Hinweis („Shift+F11 oder Escape beendet den
Zen-Modus"), der nach wenigen Sekunden verschwindet. Muster:
`#vault-tree-notice` in `vault/filter.ts`. Gesehen-Flag als
`zen_hint_seen` in `panel_state.rs` — es beschreibt die UI-Historie, nicht
das Verhalten, und gehört damit dorthin und nicht in `settings.json`.

## Verkettung

Setting **`zenFullscreen`** in `settings.json`, Vorgabe **`true`**:
Zen schaltet zusätzlich in den Vollbildmodus. Damit ist Zen der
Ein-Griff-Präsentationsmodus, und wer das nicht will, schaltet es ab.

Begründung für die Vorgabe: Der Fensterrahmen samt Titelleiste und
Taskleiste ist genau die Ablenkung, die Zen wegnehmen soll. Weil Zen den
Vollbildzustand sauber zurückgibt (siehe oben), ist die Kopplung
folgenlos.

## Backend

- Neuer Command `set_fullscreen(enabled: bool)` und `toggle_fullscreen()`
  über Tauris `WebviewWindow::set_fullscreen`. Menü-IDs `view.fullscreen`
  und `view.zen` im bestehenden `dispatch_menu_action`-Pfad.
- Zen selbst ist **Frontend-State**: keine Persistenz, kein Backend-Feld.
  Das Backend kennt nur Vollbild (OS-Fenster) und das `zen_hint_seen`-Flag.

## Automation & E2E

- `/state` bekommt additiv `zen: bool` und `fullscreen: bool`, damit
  Szenarien den Zustand prüfen können, ohne CSS zu inspizieren.
- Szenario `60_zen_mode.py`:
  - **`zenFullscreen` im Szenario auf `false` setzen**, damit das
    Layout-Verhalten isoliert getestet wird. Ob Xvfb echtes Vollbild
    liefert, ist nicht verlässlich, und ein umgeschalteter Fenstermodus
    macht jede Visual-Baseline wertlos.
  - Prüft: Toggle blendet Toolbar/Rails/Tab-Leiste/Statusleiste aus;
    Ausschalten stellt sie wieder her; **`panel_state.json` ist vorher
    und nachher unverändert** (der Kern der Layer-Semantik); Escape
    verlässt Zen; Escape schließt bei offener Find-Bar zuerst diese und
    lässt Zen an.
  - Eine Visual-Baseline im Zen-Zustand.

## Offener Folgepunkt

**Die Find-Bar hört Escape nur auf ihren eigenen Inputs**
(`ui/find-bar.ts` — je ein `keydown`-Listener auf `#find-input` und
`#find-replace-input`), nicht auf `document`. Liegt der Fokus woanders
(etwa im Dokument), tut Escape bei offener Find-Bar gar nichts: Sie
schließt nicht, und Zen verlässt der Druck auch nicht, weil die sichtbare
Find-Bar zu Recht Vorrang hat. Shift+F11 funktioniert weiterhin.

Das ist **vorbestehendes Find-Bar-Verhalten**, keine Zen-Regression — vor
Zen fiel es nur nicht auf, weil es keinen zweiten Escape-Kandidaten gab.
Aufgefallen beim Schreiben von `60_zen_mode.py` (2026-08-17). Sauber wäre
ein Escape-Handler der Find-Bar auf Dokumentebene, solange sie offen ist.

## Tests

- **vitest**: Toggle setzt/entfernt die Body-Klasse; Escape-Kette
  (Find-Bar offen → Zen bleibt); Hinweis erscheint nur beim ersten Mal.
- **Rust**: `zen_hint_seen`-Persistenz; `zenFullscreen`-Default.
