# Code-Review I1a – i18n-Rust-Fundament

**Verdikt: NACHARBEIT.** Der Stand kompiliert und alle ausgeführten Gates sind grün, erfüllt den v3.1-Vertrag aber in mehreren produktionsrelevanten Punkten nicht. Besonders kritisch sind der doppelte Settings-Load, die dadurch ausgehebelte Defektfall-Migration sowie die von `Intl.PluralRules` abweichenden Rust-Regeln.

## Blocker

### 1. Der Boot lädt Settings zweimal und verwirft das Migrationsergebnis

`run()` liest zuerst über `migrate_settings_language()` die Datei roh und ruft unmittelbar danach `SettingsService::load()` auf, das dieselbe Datei erneut über `persist::load_json` liest (`src-tauri/src/lib.rs:526-530`, `src-tauri/src/i18n/mod.rs:298-388`, `src-tauri/src/settings.rs:268-275`). `_mig` wird nicht verwendet. Damit scheitert genau der zentrale Vertragsfall: Bei `{"language":"de","logLevel":"silly"}` liefert die Migration zwar `de`, der typisierte Whole-Object-Fallback liefert danach aber `SettingsData::default()` mit `system`. Dasselbe passiert bei korruptem/nicht-objektförmigem JSON und nicht-stringförmigem `language`: effektiv wird je nach OS-Locale nicht `de`, sondern `system` aufgelöst.

Zusätzlich loggt die Migration ihre Defektwarnungen vor `logging::init`; diese Warnungen sind im normalen Boot nicht sichtbar (`src-tauri/src/i18n/mod.rs:327-384`, `src-tauri/src/lib.rs:527-530`).

**Änderungsvorschlag:** Einen einzigen Raw-Load-Owner einführen, der aus denselben Bytes Migrationsergebnis und `SettingsService` erzeugt. Nach typisiertem Whole-Object-Fallback muss die unabhängig extrahierte effektive Sprache wieder eingesetzt werden. Migrationsdiagnosen zunächst sammeln und nach `logging::init` ausgeben. Boot-nahe Regressionstests müssen einen Read-Counter sowie die Fälle „gültige Sprache + kaputtes anderes Feld“, Syntaxfehler, Nicht-Objekt und nicht-stringförmige Sprache bis zur tatsächlich an den Resolver übergebenen Sprache prüfen – nicht nur den isolierten Migrationshelper.

### 2. Der Resolver behandelt unbekannte gespeicherte Tags als Subtag-Match und akzeptiert kaputte Overrides

Auch für ein explizites Setting ruft `resolve_language()` den allgemeinen Matcher auf (`src-tauri/src/i18n/mod.rs:212-220`). Dieser Matcher probiert nach exaktem und case-insensitivem Match immer den Primär-Subtag (`src-tauri/src/i18n/mod.rs:248-281`). Dadurch wird ein gespeichertes unbekanntes `de-CH` oder `DE` zu Katalog `de`; vertraglich muss jeder nicht exakt registrierte gespeicherte Wert auf `en` + `en.@meta.locale` fallen. Der vorhandene Test prüft nur `xx` und übersieht diesen Fall (`src-tauri/src/i18n/tests/resolve.rs:74-81`).

Dieselbe Logik akzeptiert `FOLIO_LANG=de-!!!`: Der Primär-Subtag `de` reicht für einen Treffer, und der syntaktisch ungültige Gesamtwert wird anschließend sogar als `formatLocale` weitergereicht (`src-tauri/src/i18n/mod.rs:200-209`, `src-tauri/src/i18n/mod.rs:265-280`).

**Änderungsvorschlag:** Zwei getrennte Pfade verwenden: Persistiertes Setting ausschließlich case-sensitiv und exakt gegen die Registry prüfen; OS-/`FOLIO_LANG`-Werte erst als zulässigen BCP-47-Tag validieren und dann exakt/Subtag matchen. Tests für gespeichertes `de-CH`, `DE` und Overrides `de-CH` versus `de-!!!` ergänzen.

### 3. Das Pluralregelwerk ist nicht symmetrisch zu `Intl.PluralRules`, und der Validator blockiert ru/pl

Rust behandelt `es`, `it` und `pt` ausschließlich als `one` bei 1 und `fr` ausschließlich als `one` bei 0/1 (`src-tauri/src/i18n/catalog.rs:516-535`). Das ist gegenüber dem in der Spec festgelegten Frontend-Gegenstück falsch: Für nichtnegative Integer selektiert `Intl.PluralRules` bei `1_000_000` in `es`, `fr`, `it` und `pt` die Kategorie `many`; bei `pt` ist außerdem 0 `one`. Entsprechend fehlen `many` in der Pflichtliste und `one` für `pt` bei 0 (`src-tauri/src/i18n/catalog.rs:327-334`). Der vorhandene Romance-Test prüft nur 0/1/2 und beschreibt die Sprachen irreführend als `one/other` (`src-tauri/src/i18n/tests/plural_rules.rs:19-29`).

Unabhängig davon verlangt der Katalogvalidator für jeden Plural-Key exakt dieselben Kategorien wie im englischen Katalog (`src-tauri/src/i18n/catalog.rs:285-299`). Ein korrekter ru-/pl-Katalog braucht `few` und `many`, ein korrekter en-Katalog nicht. Damit ist der zugesagte Sprach-Batch mit sinnvollen Katalogen nicht erweiterbar.

**Änderungsvorschlag:** Die Integer-Regeln an die Kategorien von `Intl.PluralRules` angleichen und mindestens 0, 1, 2, 5 und 1_000_000 für alle elf Tags testen. Branch-Mengen pro Sprache gegen deren eigene erreichbare Kategorien validieren, nicht gegen en. Die Platzhalterparität separat über alle Branch-Texte eines fachlichen Keys prüfen. Ein Generator-Test mit einem korrekten ru- oder pl-Katalog muss grün werden.

### 4. Der fail-closed-Parser erkennt Duplikate nur auf der obersten Ebene

Der eigene Visitor erhält Top-Level-Werte bereits als `serde_json::Value` (`src-tauri/src/i18n/catalog.rs:371-380`). Doppelte Keys innerhalb von `@meta` oder eines Plural-Objekts sind zu diesem Zeitpunkt bereits von `Value::Object` zusammengeführt; `parse_meta()` und `parse_value()` können sie nicht mehr erkennen (`src-tauri/src/i18n/catalog.rs:440-500`). Damit erfüllt der Generator den expliziten Duplicate-Preservation-Vertrag nur teilweise. Außerdem wird nach der manuellen Deserialisierung kein `Deserializer::end()` aufgerufen, sodass nach einem gültigen Root-Objekt verbleibender Inhalt nicht ausdrücklich fail-closed geprüft wird (`src-tauri/src/i18n/catalog.rs:388-409`).

**Änderungsvorschlag:** Den duplicate-erhaltenden Parser rekursiv für `@meta` und Plural-Objekte verwenden und nach dem Root-Wert EOF erzwingen. Negative Tests für doppeltes `@meta.tag`, doppelten Plural-Branch und gültiges Objekt mit nachgestelltem Garbage ergänzen.

### 5. `MenuLabels` hat weiterhin zwei produktive Quellen und die drei `labels("de")`-Reste

Neben den Katalogen existieren weiterhin vollständige de-/en-Hardcodes in produktiv kompiliertem Code (`src-tauri/src/menu/strings.rs:15-17`, `src-tauri/src/menu/strings.rs:38-115`). `labels(lang)` ignoriert den Parameter nach dem Boot und fällt davor still auf diese zweite Quelle zurück (`src-tauri/src/menu/strings.rs:20-35`). Die drei laut Vertrag zu entfernenden `labels("de")`-Call-Sites bestehen fort; zusätzlich wird jeweils der komplette String-Satz geklont (`src-tauri/src/menu/recent.rs:30-35`, `src-tauri/src/commands/file/rename.rs:47-57`, `src-tauri/src/commands/file/save_as.rs:34-50`). Auch `menu::build` klont den gesamten Satz und behält den bedeutungslos gewordenen Sprachparameter (`src-tauri/src/menu/build.rs:14-18`).

Das kollidiert zugleich mit dem „unantastbaren“ Testbestand: Die Menütests rufen ausdrücklich die alte API `labels("de"|"en")` als Legacy-Oracle auf (`src-tauri/src/i18n/tests/menu_labels.rs:19-24`, `src-tauri/src/i18n/tests/menu_labels.rs:65-69`). Der Spec-Vertrag und dieser Test können in ihrer jetzigen Form nicht beide sauber erfüllt werden.

**Änderungsvorschlag:** Eine einzige produktive Quelle behalten: `BOOT_LABELS`, `labels()` ohne Sprachargument, Call-Sites über die statische Referenz borrowen und die Legacy-Katalogkopien entfernen. Vor Umsetzung muss der Auftraggeber die minimale Korrektur der beiden Legacy-Oracle-Tests freigeben (z. B. abgenommene Erwartungswerte in einer Test-Fixture statt produktiver Hardcodes); andernfalls ist der Vertrag unter der Vorgabe „Tests unantastbar“ nicht erfüllbar.

### 6. Die String-Umstellung bricht das aktuelle Settings-Frontend für `system`

Das Backend liefert bei einer Neuinstallation nun korrekt `language: "system"` (`src-tauri/src/settings.rs:113-118`, `src-tauri/src/settings.rs:174-197`). Das aktuelle Frontend typisiert die Sprache aber weiter als `'de' | 'en'`, setzt den Backendwert direkt in das Select und akzeptiert bei Änderungen nur de/en (`src-tauri/web/app/ui/settings-dialog.ts:23-30`, `src-tauri/web/app/ui/settings-dialog.ts:116-128`, `src-tauri/web/app/ui/settings-dialog.ts:227-234`). Im ausgelieferten Markup existieren ebenfalls nur de und en (`src-tauri/dist/index.html:169-173`). Bei einer frischen Installation ist das Select daher leer. Der Frontendtest verwendet ausschließlich `language: 'de'` und enthält in seinem Test-DOM nicht einmal das Sprach-Select, weshalb alle 298 Vitests trotzdem grün sind (`src-tauri/web/tests/ui/settings-dialog.test.ts:10-22`, `src-tauri/web/tests/ui/settings-dialog.test.ts:24-49`).

**Änderungsvorschlag:** Den Etappenschnitt minimal korrigieren: Bereits I1a muss den TS-Typ auf String erweitern und `system` sowie einen unbekannten gespeicherten Tag ohne leeres Select darstellen. Die vollständig registry-getriebene, übersetzte UI kann weiterhin I2 bleiben. Alternativ darf der neue Backend-Default nicht vor dieser Kompatibilitätsschicht aktiviert werden.

### 7. Die Unverändertheit der 62 abgenommenen Tests ist mit Git nicht nachweisbar

`src-tauri/src/i18n/tests/` ist vollständig untracked; weder `git diff` noch `git diff --cached` besitzen daher eine Vergleichsbasis (`src-tauri/src/i18n/tests/mod.rs:1-9`). Der aktuelle Baum enthält exakt 62 `#[test]`-Fälle und diese laufen grün, aber daraus folgt nicht, dass die abgenommene Fassung unverändert ist. Der aktuelle aggregierte SHA-256-Abzug der acht Dateien ist `8d2f607d3f4d8781b54665b20a148fe84d1a50598b1ee577124b82fc19e9fe52`; es fehlt ein abgenommener Referenzwert.

**Änderungsvorschlag:** Vor Freigabe den aktuellen Testbaum gegen das ursprüngliche Abnahmeartefakt bzw. dessen Hashes vergleichen und die Tests anschließend in einer unveränderlichen Git-Basis führen. Bis dahin kann der ausdrücklich verlangte Integritätsnachweis nicht erbracht werden. Dies ist kein Beleg, dass Tests verändert wurden, sondern ein fehlender Beleg, dass sie es nicht wurden.

## Empfehlungen

### 1. Fresh-Install-Erkennung und Schreibfehler konservativ behandeln

Kann ein vorhandenes Config-Verzeichnis nicht gelesen werden, erklärt `is_fresh_install()` es derzeit zur Neuinstallation und wählt `system` (`src-tauri/src/i18n/mod.rs:391-400`). Das ist gerade im Fehlerfall nicht konservativ. `atomic_write_json()` verwirft außerdem `create_dir_all`- und Rename-Details und liefert nur `bool`; temporäre Reste und die Ursache bleiben unsichtbar (`src-tauri/src/i18n/mod.rs:402-416`).

**Änderungsvorschlag:** `read_dir`-Fehler als Bestandsinstallation/de behandeln. Den Atomicschreiber als `io::Result` ausführen, Fehlerdiagnosen über den nach Logging-Init geleerten Boot-Diagnosepuffer melden und eine `.tmp`-Aufräumstrategie definieren.

### 2. Language-Validierung zentralisieren und HTTP 400 als Router-Test absichern

Der Service validiert vor Mutation korrekt (`src-tauri/src/settings.rs:291-350`), die Automation validiert denselben Wert aber vorher ein zweites Mal mit einem erneut geparsten Registry-Satz (`src-tauri/src/automation/handlers/settings.rs:18-30`). Nur diese Vorprüfung macht aus dem Fehler 400; Fehler aus dem gemeinsamen Update-Pfad werden danach pauschal zu 500 (`src-tauri/src/automation/handlers/settings.rs:56-59`). `ApiError::bad_request` selbst setzt tatsächlich 400 (`src-tauri/src/automation/error.rs:17-22`), ein End-to-End-Routertest dafür fehlt jedoch.

**Änderungsvorschlag:** Einen typisierten gemeinsamen Validierungsfehler bis an beide Ränder tragen und dort auf Tauri-String bzw. Automation-400 abbilden. Einen echten Request-Test für unbekannte Sprache, Status 400, unveränderten In-Memory-Stand und unveränderte Datei ergänzen.

### 3. `@meta.locale` wirklich als BCP-47-Wert validieren

`parse_meta()` prüft für `tag`, `name` und `locale` nur Typ und Nicht-Leere (`src-tauri/src/i18n/catalog.rs:440-472`). Ein Wert wie `locale: "not a locale"` passiert den Build und kann später als Format-Locale an das Frontend gelangen.

**Änderungsvorschlag:** Registry-Tag und Format-Locale mit einer klar definierten BCP-47-Well-formed-/Canonical-Regel prüfen und negative Generatorfälle ergänzen. Bei der endlichen V1-Tagliste ist der Tag implizit begrenzt; `locale` ist derzeit völlig offen.

### 4. Die tatsächlich versprochenen Fallback- und Fassadenpfade testen

Der Fallback-Test prüft nur „in aktiv vorhanden“ und „in beiden fehlend“, nicht „aktiv fehlt, en vorhanden“ (`src-tauri/src/i18n/tests/translate.rs:29-38`). Auch der fr-Test nennt sich Fallback-Nachweis, fragt aber nur einen Key ab, der in fr vorhanden ist, und danach einen Key, der auch in en fehlt (`src-tauri/src/i18n/tests/generator.rs:183-212`). Für die produktive `OnceLock`-Fassade existiert gar kein Test, obwohl `t()` vor Init im Debug-Build absichtlich assertet (`src-tauri/src/i18n/mod.rs:510-543`).

**Änderungsvorschlag:** Zusätzliche Tests mit lokal konstruiertem, absichtlich lückenhaftem Registry-Objekt ergänzen sowie genau einen isolierten Fassaden-Testprozess vorsehen. Die 62 bestehenden Fälle müssen dafür nicht verändert werden.

## Nice-to-have

### 1. Review-Scratch-Kommentare und unnötig öffentliche Testhelfer entfernen

Im Produktionsmodul steht ein mehrzeiliger Selbstkorrektur-Kommentar ohne dauerhaften Architekturwert (`src-tauri/src/i18n/mod.rs:419-424`). `production_locales_dir()`, `fr_fixture_path()` und `CatalogRegistry::insert()` sind öffentlich, werden aber nur von Tests beziehungsweise gar nicht verwendet (`src-tauri/src/i18n/mod.rs:546-551`, `src-tauri/src/i18n/catalog.rs:119-125`).

**Änderungsvorschlag:** Scratch-Kommentar löschen, Testpfad-Helper auf `#[cfg(test)]`/`pub(crate)` begrenzen und ungenutzte Mutations-API entfernen, sofern kein geplanter lokaler Test sie benötigt.

### 2. Generatorfehler lesbarer formatieren

`RegistryError::Display` gibt lediglich die Debug-Darstellung aus (`src-tauri/src/i18n/catalog.rs:136-159`). Der Build bricht damit zwar klar ab, die Meldung ist für Übersetzer aber unnötig technisch.

**Änderungsvorschlag:** Pro Fehlerklasse eine kurze Meldung mit Datei, Key/Tag und Ursache formatieren; der Build-Präfix in `build.rs` kann bleiben.

## Explizit geprüft und für gut befunden

- **Build-Script-Grundgerüst:** Git-Logik → Registry-Generator → `tauri_build::build()` ist korrekt geordnet. Directory- und einzelne JSON-Dateien werden als `rerun-if-changed` ausgegeben, und Generatorfehler brechen den Build mit Kontext ab (`src-tauri/build.rs:31-60`).
- **Determinismus und Produktions-/Fixture-Trennung:** Dateien und generierter Tag-Satz werden sortiert; die fr-Fixture liegt außerhalb des Produktions-Globs (`src-tauri/src/i18n/catalog.rs:199-234`, `src-tauri/src/i18n/tests/generator.rs:150-181`, `src-tauri/src/i18n/tests/generator.rs:243-251`).
- **Runtime fail open:** Kaputte eingebettete Kataloge führen zu einer leeren Registry und anschließendem Key-Fallback statt zu einem Boot-Panic (`src-tauri/src/i18n/mod.rs:26-39`, `src-tauri/src/i18n/mod.rs:79-90`).
- **Patch vor Mutation:** Der Language-Wert wird im Service geprüft, bevor `self.data.language` verändert wird; unbekannte Tags werden als `InvalidInput` abgelehnt (`src-tauri/src/settings.rs:291-350`). Die Automation-Vorprüfung liefert über `ApiError::bad_request` tatsächlich HTTP 400 (`src-tauri/src/automation/handlers/settings.rs:18-30`, `src-tauri/src/automation/error.rs:17-22`).
- **Persistenz-Kompatibilität:** Heutige Dateien mit `{"language":"de"}`/`"en"` deserialisieren nach der Enum→String-Umstellung weiterhin; unbekannte gespeicherte Strings bleiben im Service erhalten (`src-tauri/src/settings.rs:113-118`, `src-tauri/src/settings.rs:893-904`).
- **Menüzeitpunkt und State-Übergabe:** Die aus dem Katalog gebauten Boot-Labels werden vor Tauri-Builder/Menu gesetzt, und der danach geladene `SettingsService` wird tatsächlich in `AppState::with_settings` übernommen (`src-tauri/src/lib.rs:548-555`, `src-tauri/src/lib.rs:114-121`, `src-tauri/src/state.rs:145-161`). Das behebt die früheren zusätzlichen Loads in Menüclosure und produktivem AppState; offen bleibt Blocker 1, also der separate Raw- plus Typed-Load.
- **Resolver-Grundpriorität:** Gültiges `FOLIO_LANG` gewinnt vor Setting, System nutzt OS exakt/Subtag, Subtag-Matches behalten für OS/Override den vollen Formatwert, und der normale Fallback ist en (`src-tauri/src/i18n/mod.rs:195-234`, `src-tauri/src/i18n/mod.rs:248-280`). Die Validierungslücken stehen in Blocker 2.
- **Translator-Kern:** Instanziierbarer Kern, atomarer Key-Fallback, reserviertes `{count}` und Warn-Deduplizierung sind nachvollziehbar umgesetzt (`src-tauri/src/i18n/mod.rs:49-169`).
- **Katalogbestand und Naming:** de/en haben im aktuellen Stand dieselben, alphabetisch sortierten Key-Mengen; die vorhandenen Key-Segmente sind englisch und camelCase (`src-tauri/locales/de.json:1`, `src-tauri/locales/en.json:1`).
- **Ausgeführte Gates:** `cargo test` ist grün (587 Lib-Tests plus alle Integrations-/Smoke-Tests), die isolierten 62 i18n-Tests sind grün, `cargo fmt --check`, `cargo clippy --lib --tests -- -D warnings` und `git diff --check` sind grün. Zusätzlich sind alle 298 Frontend-Vitests grün; die in Blocker 6 beschriebene `system`-Lücke wird von ihnen nicht modelliert.
