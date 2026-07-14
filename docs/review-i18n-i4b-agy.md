# Diff-Review Etappe I4b (Backend-Fehlermeldungen i18n)

Reviewer: Antigravity

---

## Blocker

### `src-tauri/src/commands/file/image.rs:280`
### `src-tauri/src/commands/file/image.rs:287`
### `src-tauri/src/commands/file/image.rs:296`
* **Beschreibung**: In der Funktion `compute_relative` werden Warnungen als hartkodierte deutsche Zeichenketten (`Kein Dokument geoeffnet...`, `Dokumentpfad ohne Verzeichnis...`, `Bild liegt ausserhalb des Dokumentbaums...`) erzeugt und über `ImageInsertResult.warning` direkt ans Frontend gereicht. Das Frontend zeigt diesen String im Status direkt an. Dadurch sieht ein englischer oder französischer Benutzer deutsche Texte.
* **Korrektur**: Die Warnungen sollten übersetzt über `i18n::t` zurückgegeben werden (z. B. `i18n::t("dialogs.image.noDocOpen.warning")`). Zudem müssen entsprechende Übersetzungen für die anderen beiden Warnungen im Katalog ergänzt werden.

---

## Empfehlungen

### `src-tauri/src/ai/actions.rs:280`
### `src-tauri/src/ai/actions.rs:341`
### `src-tauri/src/ai/actions.rs:358`
### `src-tauri/src/ai/actions.rs:366`
* **Beschreibung**: Die Geschäftslogik in `ai/actions.rs` gibt hartkodierte deutsche Fehlermeldungen zurück (z. B. `"Der Selektions-Offset ist zu groß."`). Diese werden an den Command-Grenzen als `{detail}` in die ansonsten übersetzten Wrapper `errors.ai.templateDeleteFailed` bzw. `errors.ai.selectionInvalid` eingebettet.
* **Effekt**: Ein englischer Benutzer sieht ein gemischtsprachiges `"Could not delete template: Eingebaute Aktionen können nicht gelöscht werden."`. Die Fehler-Details sollten idealerweise englisch sein oder strukturiert übergeben werden, damit sie sprachkonsistent formatiert werden können.

### `src-tauri/src/theme/archive.rs:45`
### `src-tauri/src/theme/archive.rs:49`
### `src-tauri/src/theme/archive.rs:51`
### `src-tauri/src/theme/archive.rs:62`
### `src-tauri/src/theme/archive.rs:66`
### `src-tauri/src/theme/archive.rs:68`
* **Beschreibung**: Ähnlich wie bei den KI-Aktionen geben die internen Archivierungs-Funktionen hartkodierte deutsche Fehlertexte zurück. Diese werden bei `export_theme` und `import_theme` in `errors.theme.exportFailed` bzw. `errors.theme.importFailed` gewrappt und führen zu gemischtsprachigen Fehlermeldungen beim Benutzer.

### `src-tauri/src/automation/handlers/search.rs:83`
### `src-tauri/src/automation/handlers/settings.rs:27`
### `src-tauri/src/automation/handlers/settings.rs:37`
### `src-tauri/src/automation/handlers/settings.rs:46`
### `src-tauri/src/automation/handlers/settings.rs:51`
* **Beschreibung**: Die Automation-API-Endpunkte geben deutsche Fehlermeldungen zurück (z. B. `"Suche hat das Zeitlimit überschritten"`, `"Das Standard-Theme kann kein Favorit sein"`). Laut `docs/automation-contract.md` sind diese rein informativ und kein Teil des stabilen Testvertrags. Für ein konsistentes Entwickler-Erlebnis sollten sie jedoch auf Englisch umgestellt werden.

---

## Für gut befunden

### Übersetzungen und Kataloge (`locales/de.json`, `locales/en.json`, `fixtures/locales/fr.json`)
* **Vollständigkeit**: Alle drei Katalogdateien haben exakt **127** `errors.*`-Schlüssel. Es gibt keine unübersetzten Lücken.
* **Platzhalter-Konsistenz**: Die Parameter `{detail}`, `{name}`, `{count}` und `{charsPart}` sind zeichengenau und konsistent über alle Sprachen hinweg definiert.
* **Übersetzungsqualität**: Die englischen und französischen Texte sind typografisch und grammatikalisch korrekt. Im Französischen wurde die korrekte Platzierung von Leerzeichen vor Doppelpunkten eingehalten.

### Automation-Contract (`docs/automation-contract.md`)
* **Konformität**: Der Code setzt die Ergänzungen der Spec I1b vollständig um.
* **Ready-Gate**: `src-tauri/src/automation/middleware.rs` implementiert die Ready-Allowlist-Matrix exakt wie spezifiziert.
* **Language-Validation**: Ungültige Sprachen beim Settings-Patch werden korrekt mit HTTP 400 abgelehnt.
* **State-Felder**: `lang` und `frontendReady` werden in `GET /state` korrekt camelCase-serialisiert und mit den richtigen Prozess-Zuständen befüllt.

### Testabdeckung
* **Ergebnis**: Alle 629 Backend-Unit- und Integrations-Tests sowie alle E2E-Smoke-Tests laufen erfolgreich durch (`cargo test` ist grün).
