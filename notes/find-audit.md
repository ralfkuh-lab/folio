# Befundbericht: Read-only-Audit der Suchfunktion (folio)

Dieser Bericht dokumentiert Lücken, Bugs und Optimierungspotenziale in den Suchpfaden des folio-Frontends. Bekannte Bugs (keine Monaco-Suche bei Code-View `kind=text` und fehlende Such-Invalidierung beim Tab-Wechsel) wurden vereinbarungsgemäß nicht aufgeführt.

---

### 1. Auslassen von Suchtreffern in großen Textknoten bei asynchronem Chunking
* **Datei/Zeile**: [markdown.ts](file:///home/ralf/dev/folio/src-tauri/web/app/view/markdown.ts#L202-L206) & [html.ts](file:///home/ralf/dev/folio/src-tauri/web/app/view/html.ts#L469-L473)
* **Symptom aus User-Sicht**: In sehr großen Dokumenten, bei denen ein einzelner HTML-Textknoten mehr als 500 (`CHUNK_SIZE`) Matches enthält, werden alle Matches ab dem 501. Treffer in diesem spezifischen Knoten übersprungen und nicht markiert.
* **Schweregrad**: Kritisch
* **Fix-Skizze**: Den Zustand der Regex (`lastIndex`) und den aktuellen Textknoten im Such-State sichern, sodass die asynchrone `step()`-Funktion im nächsten Frame im selben Knoten fortfahren kann, statt via `walker.nextNode()` direkt zum nächsten Knoten zu springen.

---

### 2. UI-Freeze / Layout-Thrashing bei vielen Matches (Marker-Lane-Berechnung)
* **Datei/Zeile**: [markdown.ts](file:///home/ralf/dev/folio/src-tauri/web/app/view/markdown.ts#L133-L139) & [html.ts](file:///home/ralf/dev/folio/src-tauri/web/app/view/html.ts#L377-L383)
* **Symptom aus User-Sicht**: Wenn eine Suche Tausende von Treffern liefert (z. B. Suche nach einem einzelnen Buchstaben), friert die UI bei jedem Druck auf F3 / Klick auf "Next" kurzzeitig ein.
* **Schweregrad**: Mittel
* **Fix-Skizze**: Die Marker-Positionen (`getBoundingClientRect()`) einmalig berechnen und cachen, solange sich Layout/Scroll-Höhe nicht verändern, anstatt sie bei jeder Treffernavigation für alle Treffer synchron neu abzufragen.
* **Status**: GEFIXT 2026-07-09 (Cache + rAF-Batching >500 in markdown.ts + html.ts)

---

### 3. Speicher- und Dekoration-Leak in Monaco bei Tab-Wechseln
* **Datei/Zeile**: [find.ts](file:///home/ralf/dev/folio/src-tauri/web/editor/find.ts#L25) & [mount.ts](file:///home/ralf/dev/folio/src-tauri/web/editor/mount.ts#L363-L369)
* **Symptom aus User-Sicht**: Beim schnellen Hin- und Herwechseln zwischen Tabs bei aktiver Suche bleiben gelbe Such-Highlights von früheren Suchen permanent in den Dokumenten sichtbar und lassen sich nicht mehr löschen ("Geister-Highlights").
* **Schweregrad**: Mittel
* **Fix-Skizze**: Vor dem Model-Swap in `doSetDocument` die Suchdekorationen auf dem aktiven Model explizit zurücksetzen oder die Dekorations-IDs `matchDecorations` pro Tab in `tabModels` cachen und verwalten.

---

### 4. Blockierender Suchlauf in Monaco bei großen Dokumenten
* **Datei/Zeile**: [find.ts](file:///home/ralf/dev/folio/src-tauri/web/editor/find.ts#L63-L71)
* **Symptom aus User-Sicht**: Beim Bearbeiten und Suchen in sehr großen Textdateien im Edit-Mode blockiert die Eingabe in die Suchzeile den Browser/Tauri-Prozess, da der Monaco-Finder komplett synchron sucht.
* **Schweregrad**: Mittel
* **Fix-Skizze**: Die maximale Anzahl an Matches begrenzen (z. B. auf 2000) oder auf Monacos optimiertes internes Suchwerkzeug (`model.findMatches`) zurückgreifen, anstatt manuell per `indexOf` über den gesamten String zu iterieren.
* **Status**: GEFIXT 2026-07-09 (model.findMatches + 5000-Cap + "5000+"-Anzeige in editor/find.ts + find-bar.ts)

---

### 5. Stale Such-Highlights im Split-Mode für HTML-Dateien
* **Datei/Zeile**: [document.ts](file:///home/ralf/dev/folio/src-tauri/web/app/state/document.ts#L300) & [html.ts](file:///home/ralf/dev/folio/src-tauri/web/app/view/html.ts)
* **Symptom aus User-Sicht**: Im Split-Mode einer HTML-Datei aktualisiert sich der Preview-Iframe nur beim Speichern (Strg+S). Tippt der User Text ein und sucht danach, weichen die Highlights im Iframe von den Highlights im Editor ab und passen nicht mehr zum geschriebenen Text.
* **Schweregrad**: Mittel
* **Fix-Skizze**: Textänderungen im HTML-Editor debouncen und den Iframe via `mountHtmlView` aktualisieren, gefolgt von einem Aufruf von `HtmlFinder.refresh()` nach dem Laden des Iframes.
* **Status**: GEFIXT 2026-07-09 (debounce + Gen-Token + Scroll-Erhalt + invalidate nach preview.ts-Muster in html.ts + wiring in document/main)

---

### 6. Race-Condition zwischen Eingabe-Debounce und Schnell-Navigation (F3 / Enter)
* **Datei/Zeile**: [find-bar.ts](file:///home/ralf/dev/folio/src-tauri/web/app/ui/find-bar.ts#L126-L144)
* **Symptom aus User-Sicht**: Tippt man ein neues Suchwort ein und drückt sofort F3 oder Enter, springt die Suche zunächst zum nächsten Treffer des *alten* Suchbegriffs. Erst 150 ms später feuert das Debounce und springt zum neuen Begriff zurück.
* **Schweregrad**: Gering
* **Fix-Skizze**: In `findNext()` und `findPrev()` prüfen, ob ein `inputDebounce`-Timer läuft, diesen abbrechen und die Suche für den neuen Begriff sofort synchron triggern, bevor die Navigation ausgeführt wird.

---

### 7. Visueller Mismatch bei Ctrl+F mit markiertem Text in Monaco
* **Datei/Zeile**: [find-bar.ts](file:///home/ralf/dev/folio/src-tauri/web/app/ui/find-bar.ts#L70-L85) & [find.ts](file:///home/ralf/dev/folio/src-tauri/web/editor/find.ts#L164-L182)
* **Symptom aus User-Sicht**: Markiert man ein Wort im Editor und drückt Ctrl+F, werden die entsprechenden Wörter im Editor gelb markiert und der Counter zählt sie (z. B. "1/3"), aber das Eingabefeld der Suchleiste bleibt leer.
* **Schweregrad**: Mittel
* **Fix-Skizze**: Bei `openEditorFind` in der Shell die Editor-Selektion abfragen und als Suchbegriff an die Find-Bar übergeben, um das Input-Feld synchron zu befüllen.

---

### 8. Find-Bar öffnet sich für nicht-durchsuchbare Dateitypen (Bilder/Binärdateien)
* **Datei/Zeile**: [find-bar.ts](file:///home/ralf/dev/folio/src-tauri/web/app/ui/find-bar.ts#L245-L257)
* **Symptom aus User-Sicht**: Wenn man ein Bild oder eine Binärdatei geöffnet hat, lässt sich die Suchleiste via Ctrl+F / F3 dennoch öffnen und zeigt funktionslos `0/0` an.
* **Schweregrad**: Gering
* **Fix-Skizze**: Die Keydown-Listener und die `open`-Funktion so anpassen, dass sie bei `kind === 'image'` oder `kind === 'binary'` gar nicht erst reagieren.

---

### 9. Fehlende Suchoptionen (Regex/Case/Word) in der Automation-API
* **Datei/Zeile**: [types.rs](file:///home/ralf/dev/folio/src-tauri/src/automation/types.rs#L189-L191) & [ui.rs](file:///home/ralf/dev/folio/src-tauri/src/automation/handlers/ui.rs#L338-L350)
* **Symptom aus User-Sicht**: Über die Web-Automation-API (`POST /find/text`) gestartete Tests können keine Optionen wie `caseSensitive` oder `wholeWord` mitgeben. Es wird stattdessen der im UI verbleibende Checkbox-Zustand genutzt, was Testläufe nicht-deterministisch macht.
* **Schweregrad**: Gering
* **Fix-Skizze**: `FindTextRequest` in Rust und die Payload von `editor:set_find_term` im Frontend um optionale Flags erweitern.

---

## Geprüfte Pfade & Edge Cases (Geprüft & OK)

* **Regex-Sonderzeichen-Escaping**: Geprüft-OK. Sonderzeichen werden in [markdown.ts](file:///home/ralf/dev/folio/src-tauri/web/app/view/markdown.ts#L160) und [html.ts](file:///home/ralf/dev/folio/src-tauri/web/app/view/html.ts#L425) korrekt mit `escapeRegExp` entschärft. Im Monaco-Finder ([find.ts](file:///home/ralf/dev/folio/src-tauri/web/editor/find.ts#L64)) wird ausschließlich `indexOf()` (Literal-Suche) verwendet, wodurch Regex-Exploits ausgeschlossen sind.
* **Leerer Suchbegriff**: Geprüft-OK. Leere Suchbegriffe werden in allen Findern abgefangen und führen zur sauberen Bereinigung aller Highlights/Marker (`clearMarks` bzw. `clearDecorations`).
* **CRLF-Dokumente**: Geprüft-OK. Monaco normalisiert Zeilenumbrüche intern auf `\n` in `getValue()`, weshalb Zeichen-Offsets und Dekorationsbereiche konsistent bleiben.
* **Optionen-Synchronisation bei Mode-Wechsel**: Geprüft-OK. Beim Wechsel zwischen View, Edit und Split mit geöffneter Suchleiste werden `caseSensitive` und `wholeWord` aus den persistierenden DOM-Checkboxen gelesen und an den neuen Finder übergeben.
* **Shortcut-Weiterleitung aus Sandbox-Iframe**: Geprüft-OK. Die über `BRIDGE_SOURCE` in [html.ts](file:///home/ralf/dev/folio/src-tauri/web/app/view/html.ts#L186) injizierte Tastatur-Bridge leitet Ctrl+F und F3 via `postMessage` und CustomEvent zuverlässig an das Hauptfenster weiter.
