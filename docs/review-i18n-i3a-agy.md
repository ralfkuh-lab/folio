# Diff-Review Etappe I3a (dynamische Frontend-Strings State/Vault/Find/Tabs/View/Editor-Shell)

Dieses Dokument enthält das mechanische und komplementäre Review der Etappe I3a für das Projekt **folio**.

---

### Blocker
* Keine Blocker identifiziert. Alle funktionalen Texte wurden korrekt ausgelagert, die Tests laufen fehlerfrei durch und es gibt keine UI-seitig sichtbaren verbleibenden deutschen String-Literale.

---

### Empfehlungen
* **Empfehlungen, src-tauri/web/app/i18n/translate.ts:92**: Performance-Flaschenhals durch fehlendes Caching von `Intl.PluralRules`. Bei jedem Aufruf von `tPlural` wird ein neues `Intl.PluralRules`-Objekt instanziiert (`cat = new Intl.PluralRules(tag).select(count)`). Da die Wortstatistik in `src-tauri/web/app/state/document.ts` über das Event `folio-editor-text-updated` bei **jedem Tastendruck** aktualisiert wird und dabei 3 `tPlural`-Aufrufe (`wordsPart`, `charsPart`, `linesPart`) abgesetzt werden, führt dies beim Tippen zu massiven Garbage-Collection- und CPU-Overheads (3 Instanziierungen pro Keystroke).
  * *Empfohlene Lösung*: `Intl.PluralRules`-Instanzen sprachabhängig in einer Map im `translate.ts`-Modul cachen, z. B.:
    ```typescript
    const pluralRulesCache = new Map<string, Intl.PluralRules>();
    // ...
    let pr = pluralRulesCache.get(tag);
    if (!pr) {
        pr = new Intl.PluralRules(tag);
        pluralRulesCache.set(tag, pr);
    }
    cat = pr.select(count);
    ```

---

### Nice-to-have
* **Nice-to-have, src-tauri/web/app/view/code-highlight.ts:163**: Verbleibendes deutsches String-Literal in Entwickler-Warnung: `folioLog.warn('view', 'highlightCodeBlocks: monaco.editor.colorize nicht verfuegbar');`. Da dies ein reines Entwickler-Log ist, blockiert es nicht das Benutzer-Interface, sollte aber zukünftig ins Englische übersetzt werden.
* **Nice-to-have, src-tauri/web/app/view/mermaid.ts:335**: Verbleibendes deutsches String-Literal in Entwickler-Warnung: `folioLog.warn('mermaid', 'Mermaid-Bundle für Export konnte nicht geladen werden', { error: String(e) });`. Entwickler-Log, sollte ins Englische übersetzt werden.
* **Nice-to-have, src-tauri/web/app/ui/theme-editor.ts:399 (bzw. tests/ui/theme-editor.test.ts)**: Unhandled Rejection nach dem Vitest-Testlauf (`ReferenceError: window is not defined`). Ein asynchroner Timer in `runPreview` feuert nach dem Abbau der JSDOM-Testumgebung. Ein ordnungsgemäßes Clearing der Timer vor Testende oder verbesserte Mocks wären von Vorteil, um verfälschte Testergebnisse zu vermeiden.

---

### Für gut befunden
* **Für gut befunden, src-tauri/locales/de.json:142**: Fehlerfreie zeichengenaue Übereinstimmung mit allen ersetzten Literalen (Ellipsen wie `…`, Trenner wie ` · `, etc.).
* **Für gut befunden, src-tauri/locales/de.json (Plural-Einträge)**: Behebt alte Grammatikfehler der originalen String-Zusammensetzung. Die korrekten Singular-Formen wie `1 Wort` (statt `1 Wörter`), `1 Zeile` (statt `1 Zeilen`) und `1 Datei` (statt `1 Dateien`) werden nun dynamisch und sprachspezifisch aufgelöst.
* **Für gut befunden, src-tauri/web/app/vault/search.ts:996**: Korrekte und fehlerfreie Parameterzuordnung bei allen `tPlural`-Aufrufen. Die Variablen für Treffer (`totalHits()`), Dateien (`files.length`) und übersprungene Dateien (`skippedLarge`) werden nirgends vertauscht.
* **Für gut befunden, src-tauri/web/app/main.ts:362**: Effizienter cross-bundle Surface-Mechanismus für den Monaco-Editor (`(window as any).FolioI18n = { t, tPlural, ready: true }`). Der Katalog wird nicht doppelt in den Speicher geladen. Zudem wurde das Monaco-Kontextmenü (`contextmenu: false`) deaktiviert, da es standardmäßig nur auf Englisch vorliegt.
* **Für gut befunden, src-tauri/web/tests/i18n/plural-composition.test.ts**: Hohe Testqualität der neuen Vitest-Tests. Diese testen reale Übersetzungsdateien (`de.json`, `en.json`) im Dateisystem mit echten Text- und Pluralmatrix-Assertions statt Mock-Selbstbestätigung.
