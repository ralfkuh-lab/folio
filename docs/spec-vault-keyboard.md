# Spec: Tastaturbedienung im Vault-Baum

Stand: 2026-10-18 — **umgesetzt** (K1–K3 inkl. zwei Review-Runden; Abweichungen
im Abschnitt „Umsetzung“ am Ende). Quelle: `docs/feature-ideen.md` („Tastaturnavigation
im Vault“) plus der Vermerk in `CLAUDE.md` (Vault-Dateioperationen V2): Kürzel
für Ausschneiden/Einfügen gibt es nicht, „solange es keinen modellierten
Vault-Fokus gibt“. Diese Spec liefert genau diesen Fokus.

**Bewusst NICHT im Scope**: Mehrfachauswahl (Shift/Strg+Pfeil), Drag&Drop per
Tastatur, Tastatur im Tag-Browser und in der Suchtrefferliste (eigene
Bereiche), Umbelegen globaler Kürzel.

## Grundsätze

1. **Muster ist der WAI-ARIA-„Tree View“** mit wanderndem `tabindex`: genau
   eine Zeile ist per Tab erreichbar, die Pfeiltasten bewegen den Fokus. So
   kennen es Screenreader und Dateimanager.
2. **Fokus ≠ aktives Dokument.** Die bestehende Markierung des geöffneten
   Dokuments (`active`) bleibt; der Tastaturfokus ist eine eigene, sichtbare
   Markierung (Fokusring, solange der Baum den Fokus hat). Pfeiltasten öffnen nichts.
3. **Kürzel wirken nur, wenn der Baum den Fokus hat.** Strg+C/X/V, Entf, F2
   im Editor oder in der View bleiben unberührt.
4. **Jede Aktion läuft über denselben Pfad wie das Kontextmenü** — kein
   zweiter Code-Pfad für Umbenennen, Löschen, Ausschneiden usw. Dafür werden
   die Aktionen aus dem Klick-Handler in `vault/context-menu.ts` in eine
   aufrufbare Funktion gezogen.
5. **Der Fokus überlebt Baum-Neuaufbauten** (Lazy-Expand, `vault:refresh`,
   Filter, Git-Status): Er wird über `data-path` (bzw. Abschnitt) nach jedem
   Rebuild wiederhergestellt, solange die Zeile noch existiert und sichtbar
   ist; sonst landet er auf dem nächsten sichtbaren Vorfahren.

## Ist-Zustand (relevant)

- Markup (`CLAUDE.md`, „Vault-Markup“): `#vault-tree` (`ul.tree`) mit
  Abschnitten `.section[data-section]` (Angepinnt, Zuletzt geöffnet) und
  Knoten `li.node[data-path][data-kind=file|dir]`, je mit `.row`, `.caret`,
  `ul.children` (`collapsed`). Ordner laden ihre Kinder lazy
  (`expand-dir` → `insertVaultChildren`).
- Klick-Routing in `vault/tree.ts::initVaultTree`: Ordner → `toggleDir`,
  Datei → `deps.openDocument` (Strg+Klick → `tab_open`), Abschnitt →
  `toggleSection`. Mittelklick → `tab_open`.
- Kontextmenü `vault/context-menu.ts`: Aktionen `open`, `open-newtab`,
  `rename` (`startInlineRename`), `cut`/`clip-copy`/`paste`, `duplicate`,
  `new-file`, `new-folder`, `delete` (mit `showConfirmDialog`), `pin`/`unpin`
  u. a. — alle inline im delegierten Klick-Handler.
- Baum-Setter (`renderVault`, `setVaultPinned`, `setVaultRecent`,
  `insertVaultChildren`) ersetzen DOM; während eines Inline-Renames schieben
  sie auf (`vault/rename-guard.ts`).
- Filter (`vault/filter.ts`) blendet Zeilen per `vf-hidden` aus; im
  Suchmodus ist der Baum ausgeblendet.
- Zen-Modus: Escape-Priorität in `ui/zen-mode.ts::hasPriorityEscapeTarget`.

## K1 — Fokus und Navigation

**Rollen/Attribute**: `#vault-tree` `role="tree"` mit `aria-label`;
Abschnitte und Knoten `role="treeitem"`, `aria-expanded` (Ordner/Abschnitte),
`aria-level`, `ul.children` `role="group"`. Die Attribute setzt das Frontend
nach jedem Rebuild (das Backend-HTML bleibt unverändert, wie bei
Gitignore-/Git-Status-Klassen). Fokussierbar ist die `.row` (bzw. das
`treeitem` — Entscheidung bei der Umsetzung, Hauptsache genau ein
`tabindex="0"` im Baum, alle anderen `-1`).

**Tasten** (Baum fokussiert):

| Taste | Wirkung |
|---|---|
| ↓ / ↑ | nächste / vorige **sichtbare** Zeile (überspringt eingeklappte Inhalte und `vf-hidden`) |
| → | geschlossener Ordner/Abschnitt: aufklappen; offener: erstes Kind; Datei: nichts |
| ← | offener Ordner/Abschnitt: zuklappen; sonst: zum Elternknoten |
| Pos1 / Ende | erste / letzte sichtbare Zeile |
| Enter | Datei: öffnen (ersetzt wie Klick); Ordner/Abschnitt: auf-/zuklappen |
| Strg+Enter | Datei: in neuem Tab öffnen |
| Leertaste | Ordner/Abschnitt: auf-/zuklappen; Datei: öffnen, Fokus bleibt im Baum |
| Buchstaben | Type-ahead: springt zur nächsten sichtbaren Zeile, deren Name mit dem Getippten beginnt (Puffer ~500 ms) |
| Escape | Fokus zurück an Editor bzw. View (wo er vorher war); Zen-Priorität beachten |

Enter öffnet und **der Fokus bleibt im Baum** (Benutzerentscheidung
2026-10-18; so lässt sich mit ↓ Enter ↓ Enter durch Dateien blättern). Escape
bzw. Strg+Umschalt+E wechseln zwischen Baum und Dokument.

**Einstieg**: Tab aus der Vault-Kopfzeile in den Baum; neues Kürzel
**Strg+Umschalt+E** (wie „Explorer“ in VS Code; frei, siehe Menü-
Accelerators) fokussiert den Baum auf das aktive Dokument (aufgeklappt falls
nötig, sonst die erste Zeile) und blendet die Vault-Rail ein, falls sie
zu ist. Menüeintrag *Ansicht → Vault fokussieren* (`view.focus_vault`), damit
es auch in der Command Palette steht. Im Zen-Modus: Kürzel ohne Wirkung
(die Rail ist ausgeblendet).

Lazy-Expand: → auf geschlossenem Ordner klappt auf, der Fokus bleibt auf
dem Ordner; ein zweites → geht ins erste Kind, sobald die Kinder da sind
(vorher nichts).

## K2 — Datei-Aktionen per Tastatur

Nur bei fokussiertem Baum, auf der fokussierten Zeile, über die gemeinsame
Aktionsfunktion (Grundsatz 4), mit denselben Bedingungen wie im Kontextmenü
(z. B. kein „Löschen“ auf Pin-Wurzeln, „Einfügen“ nur auf Ordnern bzw. in den
Elternordner einer Datei — gleiche Regel wie das Menü):

| Taste | Aktion |
|---|---|
| F2 | Umbenennen (Inline) |
| Entf | Löschen (Papierkorb, bestehende Bestätigung) |
| Strg+C / Strg+X / Strg+V | Kopieren / Ausschneiden / Einfügen (Vault-Clipboard) |
| Strg+D | Duplizieren |
| Umschalt+F10 / Kontextmenü-Taste | Kontextmenü an der Zeile öffnen |

Nach Umbenennen/Einfügen/Duplizieren steht der Fokus auf dem neuen bzw.
umbenannten Eintrag, nach Löschen auf dem nächsten sichtbaren Nachbarn.

## K3 — Kontextmenü per Tastatur

Das bestehende Kontextmenü (`#ctx-menu` bzw. Vault-Menü) wird bedienbar:
`role="menu"`/`menuitem`, beim Öffnen per Tastatur Fokus auf den ersten
Eintrag, ↑/↓ wandern (Trenner überspringen), Enter/Leertaste löst aus,
Escape schließt und gibt den Fokus an die Zeile zurück. Mausbedienung
unverändert.

## Tests

- vitest: Navigationslogik (sichtbare Zeilen, →/← auf Ordner/Abschnitt/
  Datei, Type-ahead, Pos1/Ende) gegen ein Baum-Fixture; Fokus-Restore nach
  `renderVault`/`insertVaultChildren`; Kürzel nur bei Fokus im Baum (Strg+C im
  Editor löst nichts aus); K2 ruft dieselbe Aktionsfunktion wie das Menü.
- E2E (neues Szenario `70_vault_keyboard.py`, echte Tasten per xdotool):
  Strg+Umschalt+E, Pfeile durch einen gepinnten Ordner (Lazy-Expand),
  Enter öffnet, F2 benennt um (Tab-Pfad wandert mit), Strg+X/Strg+V
  verschiebt, Entf mit Bestätigung, Umschalt+F10 + Pfeile im Kontextmenü,
  Fokusring sichtbar (Screenshot hell/dunkel).

## Offene Punkte

- Strg+D (Duplizieren) kollidiert nicht mit globalen Kürzeln, ist aber in
  manchen Programmen „Lesezeichen“ — unkritisch, nur im Baum aktiv.

## Umsetzung (2026-10-18) — Abweichungen und Ergänzungen

- `treeitem` ist das `li`, der Fokusring sitzt per CSS auf seiner Zeile.
- **Mausklick setzt den Fokus in den Baum** (wie im Dateimanager), und der
  Fokusring ist sichtbar, solange der Baum den Fokus hat (`:focus` statt
  `:focus-visible`; Grundsatz 2 der Spec entsprechend angepasst). Die erste Fassung unterdrückte
  das; Benutzerentscheidung 2026-10-18: Klick in den Vault = Fokus im Vault.
- **Enter und Klick behalten den Fokus auch bei Moduswechsel:** `app:set_mode` trägt
  `cause: "open" | "user"`; bei `open` und fokussiertem Baum stellt
  `editor/shell.ts` den Editor nur bereit, statt ihn zu fokussieren.
  History-Restore übergibt `cause: "open"` an `set_view_mode`.
- Strg+V auf einer Datei fügt in deren Ordner ein, wenn er im Baum steht;
  auf Pin-Wurzel-Dateien und „Zuletzt geöffnet“ nichts. Ein geschlossener
  Zielordner wird aufgeklappt (Kürzel und Tastaturmenü gleich).
- Liegt das Ergebnis von Duplizieren/Einfügen außerhalb des dargestellten
  Baums (Kopie einer Pin-Wurzel oder eines Recent-Eintrags), bleibt der
  Fokus auf der Quelle — kein automatisches Anpinnen.
- Wartende Fokusziele haben keine Frist; sie enden beim Erreichen, bei einem
  Nutzer-Fokuswechsel oder einer neuen Eingabe im Baum.
- Key-Repeat löst keine Dateiaktion aus (Navigation wiederholt).
- Escape ohne vorheriges Fokusziel im View-Mode: Blur. Tab im
  Tastatur-Kontextmenü schließt es. Shift/Strg+Entf unbelegt.
- Nebenbei behoben: Leerzeile unter dem letzten Kind eines Ordners
  (`content.css` `ul:not(.toc)` gewann gegen `.vault-region ul`).
- **Doppelklick auf eine Datei** öffnet nicht mehr extern, sondern setzt den
  Fokus ins Dokument (wie in VS Code); extern öffnen/ausführen nur über das
  Kontextmenü (Benutzerentscheidung 2026-10-18).
