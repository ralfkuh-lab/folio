# Diff-Review Etappe I2 (HTML-Shell + Settings-UI i18n)

Dieses Dokument enthält das mechanische und komplementäre Review der Etappe I2 (HTML-Shell und Settings-UI i18n) für das Projekt **folio**.

---

### 1. Zeilenweiser Abgleich `dist/index.html`
* **Für gut befunden, src-tauri/dist/index.html:170-172**: Die Mappings für `settings.language.optionDe` und `settings.language.optionEn` wurden korrekterweise aus dem HTML-Code entfernt, da das Dropdown-Menü nun dynamisch via `populateLanguageOptions` und `syncLanguageSelect` aus der Registry befüllt wird.
* **Für gut befunden, src-tauri/dist/index.html:24-814**: Alle restlichen 310 nicht-OUT-OF-SCOPE Zeilen der `docs/i18n-surface-map.md` wurden korrekt mit `data-i18n-*`-Attributen in `src-tauri/dist/index.html` versehen.

---

### 2. Katalog-Diff `de.json`
* **Für gut befunden, src-tauri/locales/de.json:147, 148, 161, 162, 164, 165, 172, 173, 174**: Prefix-, Mid- und Suffix-Einträge für Hilfetexte weichen von der Checkliste ab, da sie führende/abschließende Leerzeichen enthalten. Dies ist korrekt, da sie im HTML-Code Inline-Tags wie `<code>auth.json</code>` umschließen und ohne die Leerzeichen im UI direkt aneinandergeklebt würden.
* **Für gut befunden, src-tauri/locales/de.json:136**: `search.status.done` weicht ab, da es anstelle des alten JS-Templates die Platzhalter `"{hitsPart} in {filesPart} ({ms} ms)"` nutzt. Dies entspricht exakt den Spezifikationen zur Plural-Komposition.
* **Blocker, src-tauri/locales/de.json:53**: Der Key `dialogs.about.tagline` hat den Wert `"Markdown-Viewer &amp; -Editor"`. Da das Attribut `data-i18n` mittels `.textContent` geladen wird, erfolgt keine HTML-Entity-Dekodierung und die Rohzeichen `&amp;` werden direkt im UI ausgegeben.
  * *Korrektur*: Das Entity `&amp;` muss durch ein einfaches Kaufmanns-Und `&` ersetzt werden.

---

### 3. `en.json` / `fr.json`
* **Für gut befunden, src-tauri/tests/fixtures/locales/fr.json:136-146**: Die Plural-Objekte für Französisch enthalten die BCP-47-konformen Kategorien `"one"`, `"many"` und `"other"`, was perfekt zur Implementierung in `src-tauri/src/i18n/catalog.rs:379` passt.
* **Für gut befunden, src-tauri/tests/fixtures/locales/fr.json:55, 108**: Die zweifache Nutzung von `"Annuler"` für Abbrechen und Rückgängig ist die korrekte und gängige französische Übersetzung.
* **Für gut befunden, src-tauri/locales/en.json:174**: `" and the debug build always force "` nutzt korrekt die Pluralform von `force`, da sich das Verb auf beide Subjekte `RUST_LOG` und `the debug build` bezieht.

---

### 4. `settings-dialog.ts`-Diff
* **Für gut befunden, src-tauri/web/app/ui/settings-dialog.ts:28**: Der veraltete Union-Typ für Sprachen wurde vollständig durch `SettingsLanguage = string` ersetzt.
* **Für gut befunden, src-tauri/web/app/ui/settings-dialog.ts:134**: Das Dropdown wird dynamisch via `populateLanguageOptions` befüllt.
* **Für gut befunden, src-tauri/web/app/ui/settings-dialog.ts (gesamter web/-Baum)**: Eine Suche im gesamten `web/`-Baum ergab keine verbleibenden Restnutzungen oder hardcodierten Sprachoptionen (außerhalb der Test-Mocks, wo sie zur Isolation benötigt werden).

---

### 5. Neue `<span>`-Wrapper
* **Für gut befunden, src-tauri/dist/index.html (neue spans)**: Die neu eingeführten `<span>`-Wrapper brechen keine CSS-Regeln, da das Stylesheet keine fragilen Kind-Selektoren (wie `:first-child` auf Label-Ebene) enthält.
* **Für gut befunden, src-tauri/web/app/ui (gesamter web/-Baum)**: TypeScript-DOM-Zugriffe auf betroffene Elemente (z. B. Checkboxen) holen diese ausschließlich per ID und lesen/schreiben `.checked` bzw. `.focus()`. Es finden keine relativen DOM-Traversierungen ausgehend von den Eltern-Elementen statt.
