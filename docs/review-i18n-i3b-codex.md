# Review Etappe I3b — Frontend-Dialoge/Settings/AI/Theme/Export-UI i18n

**Basis:** uncommitteter Diff gegen `HEAD=5191e64`  
**Urteil:** noch nicht freigabefähig; drei Blocker.  
**Scope:** statischer Review, Typecheck, Frontend-Unit-Tests und Rust-/Katalog-Gates. Kein E2E (laut Auftrag), keine Produktcode-Änderungen.

## Blocker

1. **Die Selektions-Zeichenzahl ist in Sprachen mit Singular/Plural grammatisch falsch.**

   `src-tauri/web/app/ui/ai-actions-dialog.ts:408` setzt `ai.actions.scope.selectionWithCount` mit einfachem `t()` und nur `formattedCount`. Dadurch liefert eine Auswahl von genau einem Codepoint in `src-tauri/locales/en.json:30` **„Selection (1 characters)“** und in `src-tauri/tests/fixtures/locales/fr.json:30` **„Sélection (1 caractères)“**. Die neu eingeführte, bereits korrekt pluralisierte Komponente `ai.status.charsPart` wird hier nicht benutzt. Das ist eine sichtbare en-/fr-Regression, die die de-Tests nicht erkennen. Den Scope-Text entweder aus einem Template plus `tPlural('ai.status.charsPart', count, { formattedCount: fmtNumber(count) })` zusammensetzen oder `selectionWithCount` selbst als Plural-Key modellieren; 0/1/2 für en und fr testen.

2. **Die verbindliche Surface Map ist nicht mit dem I3b-Diff versöhnt.**

   `docs/i18n-surface-map.md:1438` verlangt eine 1:1-Beziehung zwischen Map, Katalog und `t()`/`tPlural()`. Der Diff fügt in `src-tauri/locales/en.json` 142 Top-Level-Keys hinzu; 77 davon kommen in der Map nicht einmal als Key-Text vor. Zusätzlich weicht implementierter Key-Bestand von vorhandenen Map-Zeilen ab, zum Beispiel:

   - `src-tauri/web/app/ui/export-ai.ts:154` nutzt `export.aiDraft.base.none`, während `docs/i18n-surface-map.md:1022` `export.aiDraft.noBaseTheme` festlegt.
   - `src-tauri/web/app/ui/translate-dialog.ts:242` nutzt `ai.translate.noTargetLanguage`, während `docs/i18n-surface-map.md:1217` `errors.ai.noTargetLanguage` festlegt.
   - `src-tauri/locales/en.json:30` nutzt `{formattedCount}`, während der KI-Zeichen-Segmentvertrag in `docs/i18n-surface-map.md:1364` `{count}` dokumentiert.

   Zu den komplett fehlenden neuen Map-Einträgen gehören unter anderem `ai.actions.customPrompt.name`, `ai.diffReview.discard.confirm`, `dialogs.image.noClipboardImage`, `settings.ai.auth.keyStored`, `settings.ai.model.costBadge` und `settings.themes.variant.lightDark`. Vor Abnahme muss die Map jede neue Surface und die endgültige kanonische Key-Entscheidung enthalten; abweichende/duplizierte Keys sind dabei zu konsolidieren.

3. **Die Katalogquelle bleibt hart codiert und ist durch eine weitere Sprache nicht übersetzbar.**

   `src-tauri/web/app/ui/settings-ai.ts:707` erzeugt weiterhin die sichtbaren Labels `Cache` bzw. `Snapshot` im Code und interpoliert sie in den lokalisierten Wrapper an `src-tauri/web/app/ui/settings-ai.ts:708`. Damit zeigt insbesondere die fr-Fixture weiterhin das englische „Snapshot“, obwohl `src-tauri/tests/fixtures/locales/fr.json:293` den umgebenden Text übersetzt. Das verletzt das Erweiterbarkeitsziel „weitere Sprache nur per Katalog“. Für beide Quellwerte eigene Keys (oder einen vollständig lokalisierten Varianten-Key) anlegen, in der Map erfassen und beide Zweige testen.

## Empfehlungen

1. **Beim Map-Abgleich die Fehler-Namespaces bereinigen.** `src-tauri/web/app/ui/theme-ai-dialog.ts:227` verwendet für einen Theme-AI-Fehler `errors.export.generationFailed`; `src-tauri/web/app/ui/translate-dialog.ts:242` legt einen Validierungsfehler unter `ai.translate.*` ab. Außerdem duplizieren `src-tauri/locales/en.json:145` (`errors.ai.emptyPrompt`) und `src-tauri/locales/en.json:149` (`errors.ai.promptRequired`) denselben Fall. Die Map fordert englische Funktions-Keys und `errors.<modul>.<fall>`; ein gemeinsamer kanonischer Fehler-Key reduziert Katalog- und Übersetzungsdrift.

2. **Die neuen I3b-Aussagen gezielter in Sprachmatrizen testen.** `src-tauri/web/tests/i18n/plural-composition.test.ts:224` deckt `export.layouts.more` und `ai.status.charsPart` für de/en 0/1/2 sowie fr 0/1/2 korrekt ab. Ergänzen sollten die Tests den Selektions-Scope aus Blocker 1 und die beiden Katalogquellen aus Blocker 3. So werden nicht nur Segmente, sondern die tatsächlich sichtbaren Kompositionen geprüft.

## Nice-to-have

1. **Einheitenbezeichnung bewusst festlegen.** `src-tauri/web/app/ui/theme-editor.ts:219` delegiert jetzt korrekt an `fmtBytes`, wodurch aus den bisherigen Labels `KB`/`MB` die IEC-Labels `KiB`/`MiB` aus `src-tauri/web/app/i18n/format.ts:36` werden. Gleichzeitig spricht `src-tauri/locales/de.json:162` weiterhin von maximal „5 MB“. Das ist kein Locale-Fehler, aber eine sichtbare Terminologieänderung; UI-Liste und Grenzwertmeldung sollten dieselbe Einheitenkonvention verwenden.

2. **Formatter-Caching erst bei Messbedarf.** Die Stream-Pfade rufen pro Chunk `t()`, `tPlural()` und `fmtNumber()` auf. `Intl.PluralRules` ist bereits pro Katalog-Tag gecacht (`src-tauri/web/app/i18n/translate.ts:10`, `src-tauri/web/app/i18n/translate.ts:95`); Katalog-Lookup und Interpolation sind klein. `fmtNumber()` erzeugt dagegen pro Aufruf einen `Intl.NumberFormat` (`src-tauri/web/app/i18n/format.ts:18`). Das ist aktuell kein Korrektheitsproblem; nur bei nachgewiesen hoher Chunk-Rate wäre ein Formatter-Cache sinnvoll.

## Für gut befunden

- **Locale-Helfer-Vollständigkeit:** Der geforderte Grep über `src-tauri/web/app` findet `Intl.DateTimeFormat` und `toLocaleLowerCase` nur noch in `src-tauri/web/app/i18n/format.ts:27` bzw. `src-tauri/web/app/i18n/format.ts:67`. `toLocaleString`, `localeCompare` und user-sichtbares `toFixed` haben außerhalb des Helfers keine Resttreffer. Alle Anzeige-Sorts in `settings-ai.ts`, `ai-model-picker.ts` und `language-picker.ts` verwenden `compareStrings`; die übrigen `.sort()`-Treffer sortieren numerische Ranges/Zeilen. `fmtNumber`, `fmtDate`, `fmtBytes`, Collator und Suchnormalisierung basieren vollständig auf `formatLocale` (`src-tauri/web/app/i18n/format.ts:4`). Der `catalogTag` wird korrekt nur für Pluralregeln benutzt.

- **KI-Streaming:** `src-tauri/web/app/ui/ai-actions-dialog.ts:1081`, `src-tauri/web/app/ui/translate-dialog.ts:342`, `src-tauri/web/app/ui/export-ai.ts:426` und `src-tauri/web/app/ui/theme-ai-dialog.ts:220` komponieren lokalisierte Statuszeilen mit `tPlural` und `fmtNumber`. Die hochfrequenten Lookups parsen keine Kataloge neu; `Intl.PluralRules` ist gecacht. Die `ai-status-running`-Semantik blieb in Actions (`src-tauri/web/app/ui/ai-actions-dialog.ts:419`, `src-tauri/web/app/ui/ai-actions-dialog.ts:434`) und Translate (`src-tauri/web/app/ui/translate-dialog.ts:172`, `src-tauri/web/app/ui/translate-dialog.ts:187`) unverändert. Die vorhandenen UI-Tests prüfen unter anderem den formatierten Translate-Stream mit 12.400 Zeichen.

- **„Weitere Layouts (n)“:** `src-tauri/web/app/ui/export-dialog.ts:151` verwendet das bevorzugte `tPlural`-Muster. de/en 0/1/2 sowie fr 0/1/2 sind in `src-tauri/web/tests/i18n/plural-composition.test.ts:193`, `src-tauri/web/tests/i18n/plural-composition.test.ts:232` und `src-tauri/web/tests/i18n/plural-composition.test.ts:264` abgedeckt. Insbesondere nutzt die französische `one`-Form `{count}`, sodass 0 korrekt als „0 autre mise en page“ erscheint.

- **Dialog-Fehlerpfade:** Die lokalen Validierungs- und Fallbacktexte der umgestellten Dialoge laufen über Katalog-Keys; rohe `String(error)`-Werte bleiben zu Recht Backend-/Providerdetails. Die Modellauswahlpfade in Translate, Actions, Export-AI und Theme-AI sind vollständig umgestellt. `showConfirmDialog` schreibt Titel, Button und Message ausschließlich per `textContent` (`src-tauri/web/app/ui/dialogs.ts:115`), ebenso `confirmRunFile` (`src-tauri/web/app/ui/dialogs.ts:148`). Fehlende Confirm-DOM-Knoten lösen weiterhin sicher `false` auf.

- **`innerHTML`-Disziplin:** Die verbleibenden Vorkommen leeren Container oder setzen konstante, datenfreie Card-Skelette (`src-tauri/web/app/ui/export-dialog.ts:110`, `src-tauri/web/app/ui/export-ai.ts:192`). Layoutnamen, Beschreibungen und Übersetzungen werden danach per `textContent` gesetzt. Das Export-Preview-`srcdoc` ist gerendertes Dokument-HTML und kein i18n-Interpolationspfad.

- **Verhaltensregressionen in den benannten Pfaden:** Die `folio-doc-kind-changed`-Kette und das Markdown-/Modell-Gating stehen unverändert in `src-tauri/web/app/ui/ai-actions-dialog.ts:1059` und `src-tauri/web/app/ui/translate-dialog.ts:330`. Der `folio-ai-invoke-complete`-Refresh bleibt an `src-tauri/web/app/ui/ai-actions-dialog.ts:1052` bzw. `src-tauri/web/app/ui/translate-dialog.ts:323`; `settings-ai.ts:76` dispatcht weiterhin die aktualisierte Config. Favoriten-Reihenfolge, Content-Hash und Hash-Pinning sind in `src-tauri/web/app/ui/ai-actions-dialog.ts:97` bis `src-tauri/web/app/ui/ai-actions-dialog.ts:146` unverändert. Der Diff ersetzt in diesen Bereichen nur Texte/Formatierung.

- **Gates:** `npm run typecheck` erfolgreich; `npm test -- --reporter=dot` erfolgreich (38 Dateien, 347 Tests); `cargo test` erfolgreich (617 Library-Tests plus alle Integrations-, Referenz-, Smoke- und Katalogtests). `git diff --check` ist sauber. E2E wurde auftragsgemäß nicht ausgeführt.
