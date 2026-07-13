# i18n-Bestandsaufnahme für folio

Dieses Dokument dient als vollständige, strukturierte Bestandsaufnahme aller user-sichtbaren Strings und der vorhandenen i18n-Infrastruktur im Projekt **folio**. Es dient als Planungsgrundlage für die Internationalisierung der Anwendung.

---

## 1. Übersichtstabelle

| Bereich | Dateien (Beispiele) | ~ Strings (DE) | Besonderheiten |
| :--- | :--- | :---: | :--- |
| **Backend (Rust): Menüleiste** | `src-tauri/src/menu/strings.rs` | 34 | Enthält bereits vollständige Übersetzungen (DE/EN) für das Hauptmenü. |
| **Backend (Rust): Core & Commands** | `src-tauri/src/commands/*`, `theme/*`, `ai/*` | ~100 | Fehlermeldungen, native Dialog-Titel/Filter, eingebettete Theme-Manifeste, KI-Aktionen und hartkodierte System-Prompts. |
| **HTML-Shell (Frontend)** | `src-tauri/dist/index.html` | ~170 | Handgepflegte Datei mit allen statischen UI-Elementen (Toolbars, Dialog-Grundgerüste, Tabs, Sidebar-Labels). Fast komplett deutsch. |
| **Frontend (TS): UI-Code** | `src-tauri/web/app/ui/*` | ~180 | Dynamische Statusanzeigen, Tooltips, Fehler-Overlays und Dialog-Steuerung. |
| **Frontend (TS): Vault & State** | `src-tauri/web/app/vault/*`, `state/*` | ~40 | Kontextmenüs (im Vault-Tree), Suchstatistiken, Wortzählung und Tab-Titel. |
| **Zusammen** | | **~524** | |

---

## 2. Vorhandene i18n-Ansätze

### Menü-Labels (`src-tauri/src/menu/strings.rs`)
Es existiert bereits eine Struktur `MenuLabels` und die Funktion `labels(lang: &str) -> MenuLabels`, die vollständig übersetzte Menüeinträge für Deutsch (`de`) und Englisch (`en`) zurückgibt. 

* **Aufruf-Pfad**: Das Hauptmenü wird in [src-tauri/src/lib.rs](file:///home/ralf/dev/folio/src-tauri/src/lib.rs#L118-L122) beim Anwendungsstart aufgebaut. Der Sprachcode wird dabei aus den Einstellungen geladen:
  ```rust
  let lang = crate::settings::SettingsService::load().data().language.code();
  menu::build(handle, lang)
  ```
* **Hartkodierte Abweichungen**: An mehreren Stellen im Backend wird die Sprachwahl ignoriert und `labels("de")` hartkodiert aufgerufen:
  * [src-tauri/src/commands/file/rename.rs:L47](file:///home/ralf/dev/folio/src-tauri/src/commands/file/rename.rs#L47): `let labels = menu_strings::labels("de");`
  * [src-tauri/src/commands/file/save_as.rs:L35](file:///home/ralf/dev/folio/src-tauri/src/commands/file/save_as.rs#L35): `let labels = menu_strings::labels("de");`
  * [src-tauri/src/menu/recent.rs:L31](file:///home/ralf/dev/folio/src-tauri/src/menu/recent.rs#L31): `let l = strings::labels("de");`

### Settings-Verwaltung (`src-tauri/src/settings.rs`)
Es existiert ein Enum `Language` mit den Werten `De` und `En`. In `SettingsData` ist das Feld `pub language: Language` vorhanden.

* **Exposition im UI**: Der Einstellungsdialog (`src-tauri/web/app/ui/settings-dialog.ts`) bindet ein `<select id="settings-language">`-Element ein, das den Wert beim Ändern via `settings_update` (Tauri-Command) persistiert.
* **Kein Live-Rebuild**: Bei Änderung der Sprache wird das Event `settings:changed` emittiert. Im Frontend wird daraufhin lediglich der Hinweis *„Sprachänderung wird beim nächsten Start aktiv.“* angezeigt. Es findet kein Live-Wechsel der Menü- oder UI-Sprache statt. Ein Live-Rebuild des Menüs wurde laut Kommentar in `lib.rs` vermieden, da sonst der vom Frontend synchronisierte `checked`/`enabled`-Zustand der Menü-Items verloren ginge.

---

## 3. String-Inventar Backend (Rust)

Die user-sichtbaren Strings im Backend teilen sich in Fehlermeldungen, native Dialogparameter, eingebettete Theme-Manifeste und KI-Prompts auf.

### A. Fehlermeldungen (Command-Results)
Fehler werden im Backend meist als `Result<T, String>` gefangen und als String an das Frontend transportiert. Dort werden sie in Fehler-Overlays oder Alerts angezeigt. Sie sind fast durchgehend auf Deutsch formuliert.

* **Beispiele**:
  * [src-tauri/src/commands/file/rename.rs:L96](file:///home/ralf/dev/folio/src-tauri/src/commands/file/rename.rs#L96): `return Err(format!("Zieldatei existiert bereits: {}", ...));`
  * [src-tauri/src/commands/ai.rs:L290](file:///home/ralf/dev/folio/src-tauri/src/commands/ai.rs#L290): `return Err("Nur Markdown-Dokumente können mit KI übersetzt werden.".to_string());`
  * [src-tauri/src/theme/store.rs:L189](file:///home/ralf/dev/folio/src-tauri/src/theme/store.rs#L189): `return Err(format!("Theme-ID '{}' ist bereits vergeben", id));`

### B. Native Dialoge & Fenstertitel
Dialogtitel und Filter für Dateiauswahlen sind teils im Backend fest verdrahtet.

* **Beispiele**:
  * [src-tauri/src/commands/file/rename.rs:L48](file:///home/ralf/dev/folio/src-tauri/src/commands/file/rename.rs#L48): `handle.dialog().file().set_title("Umbenennen…")`
  * [src-tauri/src/commands/file/image.rs:L161](file:///home/ralf/dev/folio/src-tauri/src/commands/file/image.rs#L161): `.add_filter("Bilder", &["png", "jpg", ...])`
  * [src-tauri/src/commands/app/icon_integration.rs:L43](file:///home/ralf/dev/folio/src-tauri/src/commands/app/icon_integration.rs#L43): Linux-spezifischer Bestätigungsdialog mit dem Titel `"Markdown-Icon-Integration"` und deutschem Erklärungstext sowie benutzerdefinierten Buttons (`"Einrichten"`, `"Abbrechen"`).

### C. Eingebettete Inhalte
* **Themes (`theme/builtin.rs`)**: 12 eingebaute Themes besitzen Manifest-Beschreibungen auf Deutsch.
  * [src-tauri/src/theme/builtin.rs:L47](file:///home/ralf/dev/folio/src-tauri/src/theme/builtin.rs#L47): `"Die eingebaute Folio-Ansicht, folgt dem App-Theme."` (Standard)
  * [src-tauri/src/theme/builtin.rs:L86](file:///home/ralf/dev/folio/src-tauri/src/theme/builtin.rs#L86): `"Seriöses Corporate-Theme mit klarem Sans-Serif-Design..."` (Business)
* **KI-Aktionen (`ai/actions.rs`)**: 5 integrierte KI-Aktionen besitzen deutsche Bezeichnungen und Beschreibungen.
  * [src-tauri/src/ai/actions.rs:L109](file:///home/ralf/dev/folio/src-tauri/src/ai/actions.rs#L109): Name: `"Zusammenfassen"`, Beschreibung: `"Prägnante Zusammenfassung als neues Dokument."`
* **Systemprompts**: Die Prompts, mit denen die KI angewiesen wird, sind auf Deutsch formuliert.
  * [src-tauri/src/ai/actions.rs:L307](file:///home/ralf/dev/folio/src-tauri/src/ai/actions.rs#L307): `Du bearbeitest ein Markdown-Dokument. Die Nachricht des Nutzers enthält zuerst die Bearbeitungsanweisung...` (System-Rahmen für KI-Aktionen)
  * [src-tauri/src/theme/author.rs:L60](file:///home/ralf/dev/folio/src-tauri/src/theme/author.rs#L60): `Du bist ein Theme-Autor fuer den Markdown-Viewer folio. Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt...` (Systemprompt für die Theme-Generierung)
  * *Hinweis*: Der Prompt für die reine Übersetzung ([src-tauri/src/ai/client.rs:L372](file:///home/ralf/dev/folio/src-tauri/src/ai/client.rs#L372)) ist dagegen auf Englisch formuliert (`Translate the complete Markdown document into the target language...`).

---

## 4. String-Inventar Frontend (TypeScript)

Im TypeScript-Frontend befinden sich Strings in Form von Modul-Konstanten, Zuweisungen an den DOM (`textContent`, `innerHTML`) oder Tooltips (`title`).

### A. UI-Module (`src-tauri/web/app/ui/*`)
Enthält die Steuerungslogik für alle Dialoge und Overlays. Fast jede Datei enthält hartkodierte Meldungen.

* **Beispiele**:
  * [src-tauri/web/app/ui/translate-dialog.ts:L250](file:///home/ralf/dev/folio/src-tauri/web/app/ui/translate-dialog.ts#L250): `setError('Die Modellauswahl ist ungültig.');`
  * [src-tauri/web/app/ui/settings-dialog.ts:L141](file:///home/ralf/dev/folio/src-tauri/web/app/ui/settings-dialog.ts#L141): `langHint.textContent = 'Sprachänderung wird beim nächsten Start aktiv.';`
  * [src-tauri/web/app/ui/cheatsheet.ts:L12](file:///home/ralf/dev/folio/src-tauri/web/app/ui/cheatsheet.ts#L12): 13 Zeilen des Markdown-Cheat-Sheets wie `['Überschrift', '# H1   ## H2']` und `['Fett / Kursiv', '**fett**']`.

### B. Vault & State (`src-tauri/web/app/vault/*`, `state/*`)
Kapselt den Workspace-Baum, die Suche und den Editor-Zustand.

* **Beispiele**:
  * [src-tauri/web/app/vault/context-menu.ts:L82](file:///home/ralf/dev/folio/src-tauri/web/app/vault/context-menu.ts#L82): 14 Einträge für das Datei- und Ordner-Kontextmenü (z. B. `Öffnen`, `In neuem Tab öffnen`, `Anpinnen`, `Löschen`).
  * [src-tauri/web/app/vault/search.ts:L218](file:///home/ralf/dev/folio/src-tauri/web/app/vault/search.ts#L218): `setStatus('Mindestens 2 Zeichen');`
  * [src-tauri/web/app/state/document.ts:L130](file:///home/ralf/dev/folio/src-tauri/web/app/state/document.ts#L130): `el.textContent = path || 'Bereit';` (Statuszeile)

---

## 5. HTML-Shell (`src-tauri/dist/index.html`)

Da es im Frontend-Build-Prozess in `web/package.json` keine HTML-Transformation gibt, ist die `dist/index.html` direkt die Quelldatei. Sie enthält alle statischen Labels, Toolbar-Tooltips (`title`) und Dialog-Grundgerüste auf Deutsch.

* **Beispiele für statische Strings**:
  * [src-tauri/dist/index.html:L24](file:///home/ralf/dev/folio/src-tauri/dist/index.html#L24): `<button id="tb-back" title="Zurück (Alt+←)" ...>`
  * [src-tauri/dist/index.html:L85](file:///home/ralf/dev/folio/src-tauri/dist/index.html#L85): `<span class="title">Arbeitsbereich</span>`
  * [src-tauri/dist/index.html:L199](file:///home/ralf/dev/folio/src-tauri/dist/index.html#L199): `Im View-Mode automatisch formatieren`
  * [src-tauri/dist/index.html:L494](file:///home/ralf/dev/folio/src-tauri/dist/index.html#L494): `<div id="dnd-overlay">Datei hier ablegen, um zu öffnen</div>`
  * [src-tauri/dist/index.html:L511](file:///home/ralf/dev/folio/dist/index.html#L511): `Die Datei wurde geändert. Änderungen speichern?` (Unsaved-Dialog)

---

## 6. Interpolation & Plural

Im Folgenden sind alle Vorkommen dynamischer String-Verkettungen, die Variablen-Interpolation oder Pluralformen nutzen, vollständig aufgelistet:

1. **Wortstatistik (Statusleiste)**:
   * *Code*: `words + ' Wörter · ' + chars + ' Zeichen · ' + lines + ' Zeilen'`
   * *Datei*: [src-tauri/web/app/state/document.ts:L142](file:///home/ralf/dev/folio/src-tauri/web/app/state/document.ts#L142)
2. **Laufende Suche (Vault-Suche)**:
   * *Code*: `` `${totalHits()} Treffer in ${files.length} Dateien …` ``
   * *Datei*: [src-tauri/web/app/vault/search.ts:L319](file:///home/ralf/dev/folio/src-tauri/web/app/vault/search.ts#L319)
3. **Suche ohne Treffer**:
   * *Code*: `` `Keine Treffer (${s.filesScanned} Dateien durchsucht)` ``
   * *Datei*: [src-tauri/web/app/vault/search.ts:L347](file:///home/ralf/dev/folio/src-tauri/web/app/vault/search.ts#L347)
4. **Suche abgeschlossen**:
   * *Code*: `` `${s.hits} Treffer in ${s.filesMatched} Dateien (${s.elapsedMs} ms)` ``
   * *Datei*: [src-tauri/web/app/vault/search.ts:L350](file:///home/ralf/dev/folio/src-tauri/web/app/vault/search.ts#L350)
5. **Suche gekürzt/übersprungen (Pluralform)**:
   * *Code*: `` ` — ${s.skippedLarge} große Datei(en) übersprungen` ``
   * *Datei*: [src-tauri/web/app/vault/search.ts:L354](file:///home/ralf/dev/folio/src-tauri/web/app/vault/search.ts#L354)
6. **Selektionslänge (KI-Dialog)**:
   * *Code*: `` `Selektion (${codePoints(selectedText).toLocaleString('de-DE')} Zeichen)` ``
   * *Datei*: [src-tauri/web/app/ui/ai-actions-dialog.ts:L407](file:///home/ralf/dev/folio/src-tauri/web/app/ui/ai-actions-dialog.ts#L407)
7. **Fortschritt KI-Aktion**:
   * *Code*: `` `✨ ${currentActionName} · ${chars.toLocaleString('de-DE')} Zeichen` ``
   * *Datei*: [src-tauri/web/app/ui/ai-actions-dialog.ts:L1076](file:///home/ralf/dev/folio/src-tauri/web/app/ui/ai-actions-dialog.ts#L1076)
8. **Fortschritt KI-Layout**:
   * *Code*: `` `KI-Generierung · ${chars.toLocaleString('de-DE')} Zeichen` ``
   * *Dateien*: [src-tauri/web/app/ui/export-ai.ts:L422](file:///home/ralf/dev/folio/src-tauri/web/app/ui/export-ai.ts#L422) und [src-tauri/web/app/ui/theme-ai-dialog.ts:L216](file:///home/ralf/dev/folio/src-tauri/web/app/ui/theme-ai-dialog.ts#L216)
9. **Fortschritt KI-Übersetzung**:
   * *Code*: `` `KI-Übersetzung ${language} · ${chars.toLocaleString('de-DE')} Zeichen` ``
   * *Datei*: [src-tauri/web/app/ui/translate-dialog.ts:L338](file:///home/ralf/dev/folio/src-tauri/web/app/ui/translate-dialog.ts#L338)
10. **Fortschritt KI-Übersetzung (Teil-Fertigstellung)**:
    * *Code*: `` next ? `✓ ${language} · KI-Übersetzung ${next} · 0 Zeichen` : `✓ ${language}` ``
    * *Datei*: [src-tauri/web/app/ui/translate-dialog.ts:L351](file:///home/ralf/dev/folio/src-tauri/web/app/ui/translate-dialog.ts#L351)
11. **Papierkorb-Bestätigung (Vault-Kontextmenü)**:
    * *Code*: `` `„${name}" in den Papierkorb verschieben?` ``
    * *Datei*: [src-tauri/web/app/vault/context-menu.ts:L283](file:///home/ralf/dev/folio/src-tauri/web/app/vault/context-menu.ts#L283)
12. **Ausführen-Bestätigung (Dialog)**:
    * *Code*: `'„' + name + '" als Programm ausführen?'`
    * *Datei*: [src-tauri/web/app/ui/dialogs.ts:L146](file:///home/ralf/dev/folio/src-tauri/web/app/ui/dialogs.ts#L146)
13. **Tab-Schließen Tooltip**:
    * *Code*: `virtual.label() + ' schließen'`
    * *Datei*: [src-tauri/web/app/state/tabs.ts:L267](file:///home/ralf/dev/folio/src-tauri/web/app/state/tabs.ts#L267)
14. **Review-Titel (KI-Diff)**:
    * *Code*: `` `✨ KI-Review — ${context.actionName}` ``
    * *Datei*: [src-tauri/web/app/ui/ai-diff-review.ts:L122](file:///home/ralf/dev/folio/src-tauri/web/app/ui/ai-diff-review.ts#L122)

---

## 7. Risiken & Stolpersteine für i18n

1. **E2E-Testbrüche**:
   * Das E2E-Szenario `tests/e2e/scenarios/33_ai_settings.py` enthält harte String-Vergleiche im DOM:
     * [L119](file:///home/ralf/dev/folio/tests/e2e/scenarios/33_ai_settings.py#L119) prüft auf das Nichtvorhandensein von `"Wird geladen"`.
     * [L271](file:///home/ralf/dev/folio/tests/e2e/scenarios/33_ai_settings.py#L271) assertet `model_state.get("fetchText") == "Modelle abrufen"`.
   * *Risiko*: Wird das UI in das Englische übersetzt, schlägt dieser Test fehl.
   * *Empfehlung*: Die E2E-Tests sollten für diese Checks sprachneutrale Attribute (z. B. `data-translate-key` oder IDs) oder eine Test-Sprachkonfiguration nutzen.
2. **Visual-Baselines (Screenshots)**:
   * Die E2E-Suite verfügt über 16 visuelle Baselines in `tests/e2e/baselines/`, die das deutsche UI abbilden und bei Abweichungen (englischer Text) fehlschlagen:
     * `01_boot__boot_initial.png`
     * `02_view_mode__view_anchor_b.png`
     * `02_view_mode__view_default.png`
     * `03_edit_mode__edit_default.png`
     * `04_theme__theme_dark.png`
     * `04_theme__theme_light.png`
     * `05_vault__vault_rails_visible.png`
     * `06_find__find_open_abschnitt.png`
     * `20_toc_click__toc_click_abschnitt_b.png`
     * `21_split_mode__split_default.png`
     * `22_html_view__html_view_default.png`
     * `38_theme_browser__theme_browser_detail.png`
     * `45_ai_actions__ai_diff_review.png`
     * `47_vault_search_ui__47_folder_scope.png`
     * `47_vault_search_ui__47_search_jump.png`
     * `47_vault_search_ui__47_search_results.png`
   * *Risiko*: Sobald die UI-Sprache während der Tests wechselt, weichen die Screenshots von den Baselines ab.
   * *Empfehlung*: Tests in einer festen Test-Sprachumgebung (z.B. Deutsch) ausführen oder separate Baselines pro Sprache pflegen.
3. **Statische `index.html`**:
   * Da `index.html` direkt an Tauri ausgeliefert wird und es kein serverseitiges Rendering (SSR) oder Bundler-Pre-Processing für HTML gibt, können die deutschen Texte nicht zur Build-Zeit übersetzt werden.
   * *Risiko*: Statische Übersetzung führt zu separaten HTML-Dateien pro Sprache (Kompliziertheit bei Tauri-Routing) oder zu leeren HTML-Elementen, die beim Booten über JS gefüllt werden (führt zu störendem Layout-Shift/Flackern).
   * *Empfehlung*: Nutzung von `data-i18n`-Attributen im HTML und eine synchrone Übersetzungsklasse im DOM-Boot-Skript, um Layout-Shift zu minimieren.
3. **Hartkodierte `de`-Aufrufe im Backend**:
   * Das Backend bestimmt an manchen Stellen das Filterlabel für Dateidialoge hartkodiert über `labels("de")` (z. B. in `rename.rs`, `save_as.rs`).
   * *Risiko*: Selbst wenn der Benutzer Englisch wählt, zeigen OS-Speichern-Dialoge deutsche Filter (`Alle Dateien`, `Textdatei`).
   * *Empfehlung*: Die aktive Sprache des Benutzers muss bei diesen Tauri-Commands als Parameter übergeben oder aus dem globalen Backend-State gelesen werden.
4. **Zahlen- und Sortier-Locales**:
   * Im Frontend wird `.toLocaleString('de-DE')` zur Formatierung von Tausendertrennzeichen verwendet. Zur alphabetischen Sortierung wird `localeCompare(..., 'de')` gerufen.
   * *Risiko*: Englische Anwender sehen `10.500 Zeichen` statt `10,500 characters`.
   * *Empfehlung*: Der Locale-Code muss dynamisch zur gewählten Sprache passen (`en-US`, `de-DE` etc.).
5. **KI-Systemprompts**:
   * Die Systemprompts in `actions.rs` und `author.rs` weisen die KI auf Deutsch an.
   * *Risiko*: Wenn ein Benutzer englische Dokumente übersetzen oder bearbeiten lässt, zwingt der Prompt die KI zu deutschem Ausgabeverhalten oder verwirrt das LLM.
   * *Empfehlung*: Übersetzung der System-Prompts und dynamische Bereitstellung je nach Dokument- oder UI-Sprache.

---

## 8. Gesamtschätzung String-Anzahl

* **Backend (Rust)**: **~134** Strings
  * Menü-Infrastruktur: 34
  * Fehlermeldungen: ~60
  * Dialogparameter / Titel: ~12
  * Theme-Manifeste: 24
  * KI-Aktionen / Systemprompts: ~18
* **HTML-Shell (`index.html`)**: **~170** Strings
* **Frontend (TypeScript)**: **~220** Strings
  * Dialog- & Einstellungsseiten (`ui/*`): ~175
  * Vault- & State-Steuerung (`vault/*`, `state/*`): ~45

**Gesamtschätzung der zu übersetzenden Textfragmente: ~524 Strings.**
