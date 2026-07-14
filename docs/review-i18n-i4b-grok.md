# Diff-Review: Etappe I4b (Backend-Fehlermeldungen) — grok

Zweitreview zum uncommitteten Diff (HEAD `af7a32b`). Fokus laut Spec
„Fehlermeldungen — Grenze UI vs. Diagnose“ + thiserror-Tabelle.

## Blocker

1. **Doppelter Rahmen bei `ChatError` → `errors.ai.requestFailed`.**  
   `ChatError::Request` (und verwandte Varianten) tragen bereits den UI-Satz
   im `thiserror`-Display (`src-tauri/src/ai/client.rs:43` „KI-Anfrage
   fehlgeschlagen: {0}“). Command-Ränder wrappen dasselbe erneut mit
   `errors.ai.requestFailed` = „KI-Anfrage fehlgeschlagen: {detail}“
   (`src-tauri/src/commands/ai.rs:564`, `:930`, `:1041` u. a.). Ergebnis:
   `KI-Anfrage fehlgeschlagen: KI-Anfrage fehlgeschlagen: <io>`.  
   Das verletzt Fokus 2 (keine doppelte Rahmen+Display-Übersetzung) und
   die Absicht der Spec-Tabelle (Diagnose unübersetzt als `{detail}`, nicht
   zweimal gerahmt).  
   **Fix:** entweder (a) `ChatError`-Displays auf rohe Diagnose kürzen und
   den Rahmen nur am Command-Rand setzen, oder (b) am Rand nur noch
   `error.to_string()` durchreichen, wenn der Enum-Text schon der
   Nutzerrahmen ist, und `requestFailed` nur für echte Roh-IO-Details
   nutzen. Regressionstest en/de mit `ChatError::Request("disk")` und
   Assert „kein doppeltes Präfix“.

## Empfehlungen

1. **Theme-Store-Outer-Wrap ändert sichtbare Texte.**  
   `theme/store.rs` `create`/`write`/`delete`/`clone`/`asset_*` wrappen
   innere deutsche Diagnose-Strings als `{detail}` in
   `errors.theme.createFailed` etc. (`src-tauri/src/theme/store.rs:40–50`,
   `:167–186`). Vorher kam z. B. nur „Theme-ID 'x' ist bereits vergeben“
   raus, jetzt „Theme konnte nicht angelegt werden: Theme-ID …“. Spec-
   konform als Rahmen, aber de-zeichengenau ist die **Gesamtmeldung**
   nicht mehr der Alttext — UI/E2E, die auf exakte Strings matchen,
   könnten knacken. Kurz dokumentieren oder nur am Command-Rand wrappen
   (wie AI), `*_in`-Pfade roh lassen (analog archive-Tests).

2. **`SearchError::Display` vs. `localized` Duplikat.**  
   `Display` und `localized` duplizieren denselben Match
   (`src-tauri/src/search.rs:155–190`). `Display` sollte
   `localized(process_translator()…)` (oder Key-Fallback) delegieren,
   damit kein Drift zwischen Test- und Produktivpfad entsteht.

3. **`validate_slug` liefert weiterhin deutsches Detail.**  
   `actions::validate_slug` (`src-tauri/src/ai/actions.rs:48–62`) bleibt
   hart deutsch und landet in `errors.ai.actionValidationFailed`
   (`commands/ai.rs` Validation-Pfad). Rahmen lokalisiert, Detail nicht
   sprachneutral. Für V1 tragbar; Folgepunkt: Validate-Messages als
   Diagnose-englisch oder eigene Keys.

4. **`pdf_export` interne DE-Strings als Detail.**  
   Rohtexte in `pdf_export.rs` (z. B. Temp-Dir, „PDF wurde nicht erzeugt“)
   gehen unverändert in `errors.export.pdfFailed` — gut als Diagnose;
   optional später anglisieren, damit en-UI nicht DE im Detail zeigt.

5. **Testabdeckung der Chat-Doppelrahmen-Stelle fehlt.**  
   Neue en-Translator-Tests (editor/export/search/create) prüfen Rahmen+
   `{detail}` sinnvoll; der kritische Chat-Wrap hat keinen analogen
   Unit-Test. NTH: ein Fall `requestFailed` mit `ChatError::Request`.

## Für gut befunden

- **thiserror-Tabelle weitgehend speztreu:** `SearchError` lokalisiert
  Display (+ `localized(&Translator)` für Tests); `CatalogError` /
  `AuthError` / `AiConfigError` bleiben Diagnose und werden nur in
  `ai_catalog_refresh` / `ai_auth_*` / `mutate_config` gerahmt
  (`commands/ai.rs:64–67`, `:1296–1324`, `:1358–1363`).
- **`{detail}`-Konvention** bei IO/Pfad-Fehlern konsistent (file/export/
  editor/image/rename/shell): Rahmen aus Katalog, technische Bytes/Pfade
  unübersetzt. Stichprobe de: Search-Keys zeichengenau zu alten
  `#[error]`-Texten (`queryTooShort`, `rootNotFound: {detail}`, …).
- **Reine UI-Sätze** (jobActive, noneOpen, emptyPrompt, actionsMarkdownOnly,
  notExecutable, …) 1:1 im de-Katalog; stichprobenartig exakt zu HEAD-
  Literalen.
- **Transport unverändert:** weiter `Result<T, String>`; Automation
  `POST /search` mappt `SearchError` auf 400/500 via `error.to_string()`
  (`automation/handlers/search.rs:93–97`) ohne Status-Umbau. Contract-
  Absatz „Fehlertext = Diagnose“ (`docs/automation-contract.md`) passt.
- **Pre-Boot/Tests:** `create_file_at(..., Option<&Translator>)` und
  en-Translator-Unit-Tests vermeiden Wortlaut-Asserts auf Prozess-`t()`;
  Varianten-Matches bei Search-Tests bleiben (kein Display-Zwang).
- **Katalog-Parität** de/en/fr für die ~99 neuen Keys; Map/Spec-Tabelle
  nachgezogen.

## Kurzfazit

I4b ist speztreu und flächig sauber — **ein echter UX-Blocker** bleibt die
doppelte Chat-Rahmenzeile. Theme-Outer-Wrap und Chat-Testlücke als
Empfehlungen vor Abnahme adressieren; Rest freigabefähig.
