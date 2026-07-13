# Re-Review der i18n-Spec v2

Stand: 2026-07-13. Review-Gegenstand ist `docs/spec-i18n.md` v2. Der reale
Code wurde erneut geprüft; das Inventar diente nicht als Belegquelle.

## Kurzurteil

**NACHARBEIT.** v2 ist deutlich tragfähiger als v1 und schließt vier der neun
alten Blocker vollständig. Fünf alte Blocker sind jedoch nur teilweise
geschlossen. Die verbleibenden Probleme liegen nicht in der String-Menge,
sondern in den neu eingeführten Verträgen für Registry-Codegen, Settings-
Recovery, Pluralauflösung und Frontend-Readiness. Diese Verträge müssen vor dem
ersten Implementierungslauf präzisiert werden.

## Abgleich der 9 Blocker und 7 Empfehlungen aus Review v1

| Nr. | Punkt aus v1 | Verdikt für v2 | Begründung |
|---|---|---|---|
| B1 | Weitere Sprache nur als Katalogdatei | **Teilweise** | Registry statt Enum, Metadaten und der vorgezogene CLDR-Batch adressieren den Kern (`docs/spec-i18n.md:47-79`). Der produktive Wildcard-Scan kollidiert aber mit der „nur im Test“-Katalogdatei (`docs/spec-i18n.md:55-57`, `docs/spec-i18n.md:343`), und ein notwendiger Directory-Rebuild-Trigger fehlt im Vertrag. |
| B2 | Migration kann „Datei fehlt“ und „Feld fehlt“ nicht unterscheiden | **Teilweise** | Der Raw-JSON-Vorlauf und die vier Fälle sind richtig ergänzt (`docs/spec-i18n.md:124-140`). Fall 3 kann Bestandsnutzer dennoch als Neuinstallation behandeln; außerdem kann ein Fehler in einem anderen typisierten Feld die separat vorhandene Sprache weiterhin auf den neuen Default zurückwerfen (`src-tauri/src/persist.rs:60-65`, `src-tauri/src/settings.rs:761-770`). |
| B3 | Kein Rust-Boot-Owner vor Menü und `OnceLock` | **Vollständig** | `lib.rs::run` ist nun kanonischer Owner, lädt Settings einmal, setzt i18n explizit vor dem Menü und reicht denselben Service an `AppState` weiter (`docs/spec-i18n.md:141-150`). Das beseitigt die heutigen Loads in Menü, State und `run` (`src-tauri/src/lib.rs:113-125`, `src-tauri/src/state.rs:145-156`, `src-tauri/src/lib.rs:517-534`). |
| B4 | Async-Boot ohne Early-Event-Vertrag | **Teilweise** | `async bootstrap`, Vorab-Listener und Queue sind aufgenommen (`docs/spec-i18n.md:215-225`). Die Queue endet laut Text aber bereits bei `i18nReady`, obwohl die übrigen Handler erst danach initialisiert werden. Auch der Ready-Handshake ist noch nur als Absicht beschrieben (`docs/spec-i18n.md:289-291`). |
| B5 | `app.bundle` kann Monaco nicht vollständig lokalisieren | **Vollständig** | Die V1-Grenze ist eindeutig: Folio-Surfaces werden übersetzt, Monaco-internes UI ist out of scope, native Monaco-Kontextmenüs werden auf allen Surfaces deaktiviert (`docs/spec-i18n.md:254-262`). |
| B6 | DOM-Applier zu grob und Dokument-Locale fehlt | **Vollständig** | Zielattribute, Leaf-Regel, Wrapper, Strukturtest und `documentElement.lang` sind normativ festgelegt (`docs/spec-i18n.md:232-245`). |
| B7 | Mikro-Pluralformat trägt mehrere Zählgrößen nicht | **Teilweise** | Segment-Komposition löst Reihenfolge und unabhängige Zählgrößen grundsätzlich korrekt (`docs/spec-i18n.md:186-205`). Offen bleiben jedoch die Semantik von `{count}`, Branch-Vollständigkeit und der Merge/Fallback von Pluralobjekten. |
| B8 | Export-String-Surface fehlt | **Vollständig** | Cover/Header, `<html lang>`, Default-Titel und Datumsfallback sind samt englischen HTML-/PDF-Tests aufgenommen (`docs/spec-i18n.md:176-184`, `docs/spec-i18n.md:376-383`). |
| B9 | de-Pin und en-Boot sind im Runner nicht ausführbar | **Teilweise** | Beide realen Startpfade, `/state.lang`, Runner-Assert und separater en-Prozess sind jetzt konkret (`docs/spec-i18n.md:272-288`). Der zugehörige Ready-Handshake ist noch nicht implementierbar spezifiziert; der Server startet heute vor den Frontend-Handlern (`src-tauri/src/lib.rs:298-302`, `src-tauri/src/automation/handlers/dom.rs:15-44`). |
| E1 | Parität um Referenz- und Dead-Key-Prüfung erweitern | **Vollständig** | Fehlende Referenzen, unbenutzte Keys, dynamische Keys und deklarative Ausnahmen werden in beide Richtungen geprüft (`docs/spec-i18n.md:293-307`). |
| E2 | Locale-Helfer vervollständigen | **Vollständig** | Number/Date/Bytes, Collator, Search-Normalisierung und der Grep-Nachweis für alle bekannten festen Locale-Operationen sind enthalten (`docs/spec-i18n.md:246-253`). |
| E3 | Grenze UI-Fehler/Automation-Fehler | **Vollständig in bewusst geänderter Form** | Die Spec definiert UI-Rahmen plus unübersetztes `{detail}` und erklärt Automation-Fehlertext ausdrücklich zum instabilen Diagnosetext (`docs/spec-i18n.md:163-171`). Das ist für V1 tragfähig; siehe eigene Bewertung unten. |
| E4 | Dynamisches Inventar vor I3 neu erheben | **Vollständig** | I0 erzeugt maschinenunterstützte Surface-, Plural- und Key-Maps vor jeder Extraktion (`docs/spec-i18n.md:311-320`). |
| E5 | I3/I4 teilen und de-Pin vorziehen | **Vollständig bezogen auf den Altbefund** | I3 und I4 sind jeweils in a/b geteilt (`docs/spec-i18n.md:358-390`), der de-Pin liegt bereits in I1 (`docs/spec-i18n.md:343-346`). I1 ist dadurch neu zu groß geworden; das ist ein neuer Etappenbefund. |
| E6 | Naming-Regel flexibler machen | **Vollständig** | 3 Ebenen sind nur noch Regelfall, 4–5 Ebenen und neue konsistente Rollen sind erlaubt; funktionale statt wortlautbasierte Namen sind festgelegt (`docs/spec-i18n.md:83-113`). |
| E7 | Interpolations-/Katalogfehler sichtbar, aber nicht destruktiv | **Vollständig** | Statische Fehler werden getestet, Runtime-Lücken geloggt und sichtbar stehen gelassen; fehlendes Frontend-Katalog-Inventar überschreibt den deutschen Shell-Fallback nicht (`docs/spec-i18n.md:206-211`, `docs/spec-i18n.md:226-245`). |

## Blocker

### 1. Registry-Codegen und „dritter Test-Katalog“ haben noch keinen widerspruchsfreien Build-Vertrag

**Begründung:** Die Spec lässt das Cargo-Build-Script produktiv
`locales/*.json` scannen (`docs/spec-i18n.md:55-57`), fordert zugleich aber
eine dritte Katalogdatei „nur im Test“ im selben Fundament (`docs/spec-i18n.md:343`).
Eine Datei unter dem produktiven Glob landet auch im Release-Registry-Code;
eine Fixture außerhalb des Globs beweist ohne expliziten Generator-Einstieg
nichts. Der heutige `build.rs` läuft bedingungslos (`src-tauri/build.rs:3-31`)
und setzt nach den ersten `rerun-if-changed`-Direktiven nur Git-Pfade als
Trigger (`src-tauri/build.rs:26-31`). Ohne
`cargo:rerun-if-changed=locales` ist gerade das Abnahmekriterium „Datei
hinzufügen und neu bauen“ im inkrementellen Build nicht abgesichert.

Die Qualitäts-Gates verlangen außerdem Quellreihenfolge und doppelte JSON-
Keys (`docs/spec-i18n.md:295-299`). Ein normales Einlesen in
`serde_json::Value` reicht dafür nicht: doppelte Objekt-Keys sind nach dem
Parse nicht mehr zuverlässig feststellbar, und eine sortierende Map kann eine
unsortierte Quelldatei verdecken. Aktuell ist `serde_json` nur normale
Dependency und der Build hat allein `tauri-build` (`src-tauri/Cargo.toml:25-30`,
`src-tauri/Cargo.toml:97-99`); die Spec muss festlegen, welcher Generator die
Validierung besitzt, statt sie zwischen Build-Script und Tests offen zu
lassen.

**Konkrete Spec-Änderung:** In „Kataloge & Sprach-Registry“ und I1 einen
eindeutigen Vertrag ergänzen:

- Eine reine Generatorfunktion nimmt ein Katalogverzeichnis als Parameter;
  `build.rs` ruft sie ausschließlich für `src-tauri/locales/` auf und emittiert
  `cargo:rerun-if-changed=locales` (Directory-Watch, damit auch neue Dateien
  triggern).
- Der dritte vollständige Katalog liegt unter einer Test-Fixture außerhalb
  des Produktions-Globs. Ein Test kopiert `de`, `en` und die dritte Datei in
  ein Temp-Verzeichnis, ruft denselben Generator auf und prüft Registry,
  Auswahl, Fallback und mindestens einen Pluralfall. Ein geeigneter Tag aus
  dem unterstützten Regelwerk, etwa `fr`, verhindert einen künstlichen
  Sonderpfad.
- Der Generator sortiert Dateien deterministisch und scheitert bereits beim
  Build an ungültigem/dupliziertem kanonischem Tag, abweichendem
  Dateistamm/`@meta.tag`, fehlendem `en`, unvollständigem `@meta` sowie
  Katalogschemafehlern. Quell-Key-Reihenfolge und Duplikate werden mit einem
  order- und duplicate-erhaltenden Parser/Visitor geprüft.
- Die Test-Fixture darf weder in `i18n_catalog.languages` eines Produkt-Builds
  noch in die Settings-UI gelangen.

### 2. Die Migration schützt die Sprache noch nicht gegen Recovery anderer Settings-Felder

**Begründung:** Der Raw-JSON-Vorlauf löst das alte fehlende-Feld-Problem, aber
der anschließende typisierte Load bleibt unpräzisiert. Heute kollabiert
`persist::load_json` jeden Read-, JSON- oder Deserialisierungsfehler auf den
gesamten `Default` (`src-tauri/src/persist.rs:60-65`). Der bestehende Test mit
einem unbekannten `logLevel` belegt genau diesen Whole-object-Fallback
(`src-tauri/src/settings.rs:761-770`). Nach Umstellung des Defaults auf
`system` könnte daher eine gültige Datei
`{"language":"de","logLevel":"silly"}` Fall 2 zunächst korrekt erkennen,
die Sprache bei der typisierten Deserialisierung aber wieder auf `system`
setzen. Das widerspricht „mit language unverändert übernehmen“
(`docs/spec-i18n.md:132-133`).

Fall 3 ist ebenfalls falsch an Fall 4 gekoppelt (`docs/spec-i18n.md:134-139`):
Eine vorhandene korrupte/unlesbare `settings.json` ist selbst Evidenz für
eine Bestandsinstallation und darf nicht bei fehlenden Workspace-/Panel-
Dateien zu `system` führen. Zudem sind diese zwei Dateien kein vollständiges
Bestandskriterium. Folio persistiert auch `theme.json`
(`src-tauri/src/theme/service.rs:29-33`), `ai.json`
(`src-tauri/src/ai/config.rs:39-47`), `auth.json`
(`src-tauri/src/ai/auth.rs:48-56`), `ai-catalog.json`
(`src-tauri/src/ai/catalog.rs:99-100`) sowie die Verzeichnisse `themes` und
`prompts` (`src-tauri/src/persist.rs:17-31`). Ein Nutzer nur mit eigener
Theme-/KI-Konfiguration würde nach v2 fälschlich als Neuinstallation gelten.

**Konkrete Spec-Änderung:** Den Migrationsalgorithmus durch folgende
Zustandsmaschine ersetzen:

1. `settings.json` wird genau einmal als Bytes/Raw-JSON gelesen. `NotFound`,
   sonstiger I/O-Fehler, Syntaxfehler, gültiges Nicht-Objekt und gültiges
   Objekt sind getrennte Fälle.
2. Jede vorhandene, aber unlesbare/syntaktisch defekte Datei erhält für diesen
   Boot effektiv `de`, wird nicht überschrieben und erzeugt ein `warn`. Ihre
   bloße Existenz zählt als Bestandsnachweis.
3. Bei einem gültigen Objekt wird `language` unabhängig von der übrigen
   typisierten Deserialisierung extrahiert. Schlägt später ein anderes Feld
   fehl, dürfen dessen Recovery-Defaults die extrahierte Sprache nicht ändern;
   mindestens dieser Fall bekommt einen Regressionstest.
4. Nur eine fehlende `settings.json` plus ein nicht vorhandenes bzw. leeres
   Folio-Config-Verzeichnis nach der bestehenden `folio-rs`-Migration
   (`src-tauri/src/persist.rs:7-14`) gilt als Neuinstallation. Jeder vorhandene
   Folio-Artefakt-Eintrag pinnt konservativ `de`. Die unvermeidbare Grenze
   „frühere Nutzung ganz ohne persistiertes Artefakt ist nicht erkennbar“ wird
   ausdrücklich dokumentiert.
5. Tests ergänzen: korrupte Datei allein, nur `theme.json`, nur `ai.json`,
   gültiges `language` plus ungültiges anderes Enum-Feld sowie Wiederholung
   ohne weitere Schreibmutation.

### 3. String-Tag, Patch-Validierung und Formatierungs-Locale sind noch nicht einheitlich definiert

**Begründung:** Das heutige `Language`-Enum validiert `settings_update` bereits
bei der Payload-Deserialisierung (`src-tauri/src/settings.rs:19-34`,
`src-tauri/src/settings.rs:229-247`). Nach dem Wechsel zu `String` würde der
Service den Wert ohne zusätzliche Prüfung direkt übernehmen; heute geschieht
die Zuweisung schlicht in `apply_patch` (`src-tauri/src/settings.rs:352-358`).
Sowohl Tauri als auch HTTP laufen über denselben Update-Pfad
(`src-tauri/src/commands/app/settings.rs:27-53`), der Automation-Adapter mappt
Servicefehler derzeit pauschal auf 500 (`src-tauri/src/automation/handlers/settings.rs:48-51`).
„validierter BCP-47-String-Tag“ (`docs/spec-i18n.md:57-63`) sagt noch nicht,
ob unbekannte neue Tags abgelehnt, normalisiert oder gespeichert werden und
welchen HTTP-Status der gemeinsame Pfad liefert.

Daneben widersprechen sich die Locale-Aussagen: `@meta.locale` heißt
Default-Formatierungs-Locale (`docs/spec-i18n.md:49-54`), der volle OS-Tag soll
bei Systemauflösung erhalten bleiben (`docs/spec-i18n.md:117-123`), später
heißt es aber pauschal, Formatierungs-Locale sei der OS-/Settings-Tag
(`docs/spec-i18n.md:246-253`). Für ein explizites Setting `de` ist damit
unklar, ob `de`, `de-DE` aus `@meta` oder etwas anderes an das Frontend geht.
Auch ein unbekannter gespeicherter Tag ist im Settings-UI nicht darstellbar:
die bestehende Formlogik setzt `select.value = data.language`
(`src-tauri/web/app/ui/settings-dialog.ts:116-129`); ohne passende Registry-
Option wird der Select leer.

**Konkrete Spec-Änderung:** Eine normative Tabelle für Persistenz, Update und
Auflösung aufnehmen:

- Registry-Tags sind build-time kanonisiert, case-insensitiv eindeutig und
  der Dateistamm entspricht dem kanonischen Tag. `system` ist reserviert.
- Neu eingehende Patches akzeptieren nur `system` oder einen exakten
  Registry-Tag. Unbekannt/ungültig wird vor jeder Mutation abgelehnt; Tauri
  liefert den üblichen String-Fehler, Automation einen stabilen 400-Status
  mit weiterhin instabilem Diagnosetext. Das erfordert keine Error-Codes.
- Bereits gespeicherte unbekannte Strings werden wie zugesagt unverändert
  erhalten, lösen aber `{catalogTag: "en", formatLocale:
  en.@meta.locale}` auf. Die UI zeigt dafür eine deaktivierte temporäre Option
  plus übersetzten Fallback-Hinweis, statt einen leeren Select.
- Der Resolver gibt immer getrennt `catalogTag` und `formatLocale` zurück:
  `system` verwendet den vollen passenden OS-Tag als Format-Locale;
  explizites Setting und exakter `FOLIO_LANG`-Registry-Tag verwenden
  `@meta.locale`; Fallback `en` verwendet `en.@meta.locale`. Falls
  `FOLIO_LANG=de-CH` auf `de` matchen soll, muss diese Subtag-Regel ausdrücklich
  auch für den Override gelten; andernfalls bleibt Override-Matching bewusst
  exakt.
- Kompatibilitätstests laden heutige Dateien mit `"language":"de"` und
  `"language":"en"`, testen den gemeinsamen Tauri-/Automation-Patch-Pfad
  sowie kanonische Groß-/Kleinschreibung.

### 4. Der Pluralvertrag definiert weder `{count}` noch vollständige Branches oder Objekt-Fallback

**Begründung:** Beide APIs führen Selektor und `args` getrennt
(`docs/spec-i18n.md:154-156`, `docs/spec-i18n.md:188-189`), die normativen
Segmente enthalten aber `{count}` (`docs/spec-i18n.md:194-196`). Es steht
nicht fest, ob `tPlural(key, hits, {})` den Selektor automatisch als
`{count}` injiziert oder jeder Aufrufer denselben Wert zusätzlich in `args`
mitführen muss. Frontend und Rust könnten dadurch unterschiedliche Ausgaben
implementieren.

Der Katalogtest verbietet nur Kategorien außerhalb des Regelwerks
(`docs/spec-i18n.md:295-299`); er verlangt weder `other` noch alle für
nichtnegative Integer erreichbaren Kategorien. Gleichzeitig ist `strings`
„aktive Sprache über en-Fallback“ gemerged (`docs/spec-i18n.md:75-81`), ohne
festzulegen, ob ein Pluralobjekt atomar ersetzt oder branchweise tief gemerged
wird. Bei späteren Sprachen mit `few`/`many` entscheidet diese Kleinigkeit
über rohe Keys oder grammatisch falsche englische Branches. Die reale
Wortstatistik besitzt drei unabhängige Zähler
(`src-tauri/web/app/state/document.ts:137-143`), die Suche zwei plus Zusatz-
Zähler (`src-tauri/web/app/vault/search.ts:319-354`); der Vertrag muss vor
diesen Migrationen eindeutig sein.

**Konkrete Spec-Änderung:** Für Rust und TypeScript dieselbe normative
Semantik festschreiben:

- `count` ist ein endlicher, nichtnegativer Integer und alleiniger
  Kategorie-Selektor. Beide APIs injizieren zusätzlich den reservierten
  Platzhalter `{count}` als Dezimaldarstellung; `args` darf `count` nicht
  überschreiben. Falls lokalisierte Gruppierung benötigt wird, bekommt sie
  einen getrennten expliziten Platzhalter wie `{formattedCount}`.
- Jedes Pluralobjekt muss `other` und alle für Integer durch die jeweilige
  V1-Regel erreichbaren Kategorien besitzen. Ausgewählter fehlender Branch ist
  Katalogfehler, kein stiller Sprachwechsel.
- Ein Pluralobjekt ist beim Katalog-Merge ein atomarer Wert. Key-Fallback ist
  aktive Sprache → `en` → Key; Branches verschiedener Sprachen werden nicht
  tief gemischt. Werttyp-Parität bleibt Pflicht.
- Die Spec zeigt je einen vollständigen FE- und Rust-Aufruf für
  `hitsPart`, `filesPart` und den zusammensetzenden `done`-Key. Tests prüfen
  `{count}`-Injektion, verbotene Überschreibung, fehlendes `other`, fehlende
  erreichbare Kategorien und die 0/1/2-Kombinationen.

### 5. `i18nReady` ist zu früh; Frontend-Queue und Automation-Ready brauchen zwei getrennte Phasen

**Begründung:** v2 lässt frühe Events nur bis `i18nReady` queuen und führt
erst danach Static-Applier und restliche Init aus (`docs/spec-i18n.md:215-221`).
Im realen `main.ts` installieren aber gerade die „restlichen“ Module fast alle
Handler (`src-tauri/web/app/main.ts:95-135`); weitere Listener folgen erst im
Cross-Module-Block (`src-tauri/web/app/main.ts:137-282`). Ein Flush unmittelbar
nach erfolgreichem `initI18n` kann daher noch keinen Zielhandler aufrufen.
Zudem sind die Listener über viele Module verteilt, etwa alle Automation-
Listener in `initAutomationEvents` (`src-tauri/web/app/automation/events.ts:287-452`).
„kritische“ Listener ist ohne Ereignisliste und Replay-Besitzer nicht
implementierbar eindeutig.

Das Timing ist real: Das Fenster wird im Rust-Setup sichtbar gemacht und der
Automation-Server direkt danach gestartet (`src-tauri/src/lib.rs:270-302`).
`/dom` emittiert sofort und beginnt seinen Timeout
(`src-tauri/src/automation/handlers/dom.rs:15-44`), `/eval` ebenso
(`src-tauri/src/automation/handlers/eval.rs:33-67`), und viele UI-Endpunkte
registrieren ACKs vor ihrem Event (`src-tauri/src/automation/handlers/ui.rs:20-52`).
Der heutige Runner verwendet `/state` als Healthcheck und danach `/dom body`
als Bereitschaftsprobe (`tests/e2e/run.py:189-225`). Ein unspezifisches
„Automation wartet auf Ready“ (`docs/spec-i18n.md:289-291`) lässt offen, welche
Routen warten, wo der Zustand lebt und was bei Boot-Degradation passiert.

**Konkrete Spec-Änderung:** Den Bootstrap als explizite Zustandsmaschine
definieren:

1. `booting`: Vorab-Adapter für **alle** vor UI-Ready möglichen Backend→FE-
   Events registrieren; die Promises von Tauri `listen` werden abgewartet.
   I1 enthält eine aus den realen `listen`-Stellen erzeugte Ereignisliste,
   mindestens CLI/Single-instance, Menü, Navigation/Panel/Vault und
   Automation.
2. `i18nReady`: Katalog geladen oder Degradationsentscheidung getroffen;
   Static-Applier kann laufen. Die Eventqueue wird noch nicht geleert.
3. `uiReady`: alle heutigen Modul-Inits und Zielhandler sind installiert;
   danach Queue in Ankunftsreihenfolge über definierte Dispatcher leeren.
   Queuegröße, Overflow-Log und Fehlerfortsetzung werden festgelegt.
4. Erst nach erfolgreichem Drain ruft das Frontend einen idempotenten
   `frontend_ready`-Command. Auch der Degradationspfad erreicht diesen Zustand.
5. Rust hält `AtomicBool` plus `Notify`. `/state` bleibt als Healthcheck
   ungesperrt und liefert `frontendReady` sowie `lang`; alle Routen, die ein
   Frontend-Event emittieren, eine Frontend-Antwort/ACK erwarten oder einen
   Screenshot benötigen, warten mit einem eigenen Startup-Timeout. Reine
   Backend-Leseendpunkte werden ausdrücklich aufgelistet und warten nicht.
   Der Runner pollt `frontendReady` statt Readiness durch einen potenziell
   verlorenen `/dom`-Roundtrip zu erzeugen.

## Bewertung der E3-Abschwächung: kein Error-Code-System

**Tragfähig, kein Einspruch für V1.** Der aktuelle Automation-Client behandelt
Fehler als HTTP-Status plus Diagnosetext (`tests/e2e/lib/api.py:15-19`,
`tests/e2e/lib/api.py:46-57`). Die vorhandenen Negativszenarien verzweigen auf
4xx, nicht auf deutschen oder englischen Wortlaut, beispielsweise Vault-Suche
(`tests/e2e/scenarios/46_vault_search_api.py:169-175`) und Tabs
(`tests/e2e/scenarios/29_tabs_api.py:39-49`,
`tests/e2e/scenarios/29_tabs_api.py:84-93`). Es gibt damit keinen aktuellen
Bedarfsträger, der die zusätzliche Contract-Migration rechtfertigt.

Die v2-Regel ist ausreichend, wenn drei Dinge verbindlich bleiben:

- HTTP-Status und erfolgreiche Response-Felder bleiben Vertrag; nur das
  `error`-Stringfeld ist Diagnose.
- `docs/automation-contract.md` verbietet ausdrücklich Branching/Asserts auf
  Fehlerwortlaut; der E2E-Audit aus I4b/I6 prüft das.
- `{detail}` ist eine UI-Rahmenkonvention, keine Behauptung, technische
  Betriebssystem-/Parsertexte selbst übersetzen zu können. Automation darf
  diese Diagnose in der Boot-Sprache oder roh liefern.

Die in Blocker 3 geforderte 400-Abbildung für einen ungültigen Language-Patch
ist mit dieser Entscheidung kompatibel: Sie stabilisiert nur den bestehenden
Statusklassen-Vertrag, nicht den Fehlertext und führt kein Code-System ein.

## Empfehlungen

### 1. I1 in Rust-Fundament und Frontend-/Automation-Boot teilen

**Begründung:** I1 umfasst Generator, zwei Vollkataloge, CLDR-Regeln,
Migration, Boot-Owner, Menü, drei Übersetzungs-APIs, Frontend-Runtime,
DOM-Applier, Eventqueue, Ready-Gate, zwei Drift-Tests und einen vollständigen
E2E-Lauf (`docs/spec-i18n.md:322-346`). Das ist größer und riskanter als die
nun sinnvoll geteilten I3-/I4-Etappen. Der reale Bootumbau berührt sowohl die
Tauri-Builder-Reihenfolge (`src-tauri/src/lib.rs:61-125`) als auch praktisch
die gesamte Init-Kaskade (`src-tauri/web/app/main.ts:95-335`).

**Konkrete Spec-Änderung:** I1a = Generator/Katalog/Settings-Migration/
Resolver/Boot/OnceLock/Menü plus Rust-Tests; I1b = Frontend-i18n/Applier/
zweiphasiger Bootstrap/Ready-Gate plus vitest; I1c = Referenz-Gate,
Erweiterbarkeits-Fixture und E2E-Infrastruktur. Nach jeder Teil-Etappe müssen
Build und die bis dahin relevanten Gates grün sein. Der de-Pin bleibt vor dem
ersten Prozess-E2E.

### 2. `OnceLock` nur als globale Fassade, nicht als Testobjekt verwenden

**Begründung:** Die Spec verlangt in einem Testlauf de- und en-Menüsets sowie
eine dritte Sprache (`docs/spec-i18n.md:157-162`,
`docs/spec-i18n.md:343`). Ein globaler `OnceLock` ist absichtlich nicht
zurücksetzbar. Tests, die Prozess-ENV und globale Initialisierung mehrfach
mutieren, werden reihenfolgeabhängig oder müssen in getrennte Prozesse
ausweichen.

**Konkrete Spec-Änderung:** `Translator`/`CatalogRegistry` als reine,
instanziierbare Kernobjekte vorsehen; Resolver-, Merge-, Plural- und
`MenuLabels`-Tests arbeiten mit lokalen Instanzen. Der produktive
`OnceLock<Translator>` ist nur die nach dem Boot gesetzte `t()`-Fassade. Ein
einziger Test prüft „vor Init Debug-Assert / nach Init lesbar“.

### 3. Den Referenz-Test auf beide API-Schreibweisen und Literalität festnageln

**Begründung:** Die Qualitätsregel nennt statische
`t`/`t_args`/`t_plural`-Aufrufe für Rust und TS
(`docs/spec-i18n.md:300-305`), die Frontend-API heißt aber `tPlural`
(`docs/spec-i18n.md:188-189`). Ein einfacher Text-Grep übersieht Aliase,
Kommentare, mehrzeilige Aufrufe oder die abweichende Schreibweise. Gerade die
heutige Codebasis arbeitet mit vielen Importen und Factories.

**Konkrete Spec-Änderung:** Entweder AST-basierte Extraktion oder eine bewusst
eingeschränkte Aufrufkonvention festlegen. Der Test muss `t`, `tPlural`,
`t_args`, `t_plural`, HTML-Attribute und deklarative Registry-Einträge
erfassen; das erste Key-Argument muss ein Stringliteral sein. Aliasing der
i18n-Funktionen ist verboten oder explizit unterstützt. Allowlist-Einträge
tragen Begründung und müssen selbst benutzt sein.

### 4. `@format: "icu"` als reservierte Form syntaktisch eindeutig machen

**Begründung:** V1 erlaubt als Wert nur String oder CLDR-Pluralobjekt
(`docs/spec-i18n.md:70-74`), reserviert später aber ein Objekt mit dem
Nicht-CLDR-Key `@format` (`docs/spec-i18n.md:201-205`). Zugleich soll der
Validator alle nicht erlaubten Pluralkategorien ablehnen
(`docs/spec-i18n.md:295-299`). Ohne Ausnahme ist der reservierte Marker kein
gültiger zukünftiger Katalogwert.

**Konkrete Spec-Änderung:** Für V1 entweder nur den Key-Namensraum
konzeptionell reservieren und `@format`-Objekte ausdrücklich mit
„unsupported format“ ablehnen, oder bereits eine separate diskriminierte
Wertform definieren. Nicht so tun, als sei ein noch validator-ungültiges Objekt
schon formatkompatibel.

## Nice-to-have

### 1. Generator-Snapshot für deterministischen Output

**Begründung:** Der Registry-Code ist generiert und soll allein von den
Katalogdateien abhängen (`docs/spec-i18n.md:55-79`). Ein kleiner Snapshot des
generierten Tag-/Metadaten-Index würde versehentliche nichtdeterministische
Reihenfolge früh sichtbar machen, ohne die übersetzten Volltexte zu duplizieren.

**Konkrete Spec-Änderung:** Optional in I1a einen Snapshot nur für
Registry-Reihenfolge und Metadaten vorsehen; Kataloginhalt bleibt über die
Paritätstests abgedeckt.

### 2. Fallback-Warnungen pro Sprache/Key deduplizieren

**Begründung:** Fehlende Keys sollen bei jedem Lookup warnen
(`docs/spec-i18n.md:80-81`). Hochfrequente Status- und Stream-Updates können
dadurch denselben Defekt tausendfach loggen; die heutigen AI-Statuspfade werden
pro Chunk aktualisiert, etwa `src-tauri/web/app/ui/ai-actions-dialog.ts:1061-1077`.

**Konkrete Spec-Änderung:** Optional „einmal pro `(catalogTag, key,
failureKind)` und Prozess“ loggen; der sichtbare Key-Fallback bleibt
unverändert.

## Explizit geprüft und für gut befunden

### 1. Der kanonische Rust-Boot-Owner ist jetzt der richtige Schnitt

Die Reihenfolge Settings/Migration → Resolver → expliziter i18n-State → Menü →
`AppState` (`docs/spec-i18n.md:141-148`) passt zum realen Problem der drei
heutigen Loads (`src-tauri/src/lib.rs:113-125`, `src-tauri/src/state.rs:145-156`,
`src-tauri/src/lib.rs:517-534`). `OnceLock` als read-only Prozesszustand und
Debug-Fehler vor Init ist richtig; lediglich die Testbarkeit sollte wie oben
entkoppelt werden.

### 2. Segment-Komposition ist für die bekannten de/en-Fälle konzeptionell ausreichend

Die Zerlegung unabhängiger Zähler in übersetzbare Teile plus übersetzbaren
Kompositions-Key (`docs/spec-i18n.md:190-200`) behebt den zentralen Fehler von
v1. Für die realen Wortstatistik- und Suchfälle
(`src-tauri/web/app/state/document.ts:137-143`,
`src-tauri/web/app/vault/search.ts:319-354`) kann de/en damit korrekt zwischen
0/1/2 unterscheiden und die Reihenfolge ändern. Es braucht kein ICU in V1,
sofern der in Blocker 4 geforderte API-/Branch-Vertrag ergänzt wird.

### 3. E3 ohne Error-Codes ist für den heutigen Automation-Vertrag ausreichend

Die vorhandenen Python-Szenarien prüfen Status und Struktur statt Wortlaut
(`tests/e2e/scenarios/46_vault_search_api.py:169-175`,
`tests/e2e/scenarios/29_tabs_api.py:39-49`). Die dokumentierte Diagnose-Grenze
ist daher eine reale, testbare Vereinfachung und keine bloße Vertagung eines
aktuellen Verbrauchervertrags.

### 4. Statischer DOM-Applier, deutscher Fallback und Monaco-Grenze sind belastbar

Leaf-only-Textsetzung, exakte Attributabbildung, Strukturtests und
`documentElement.lang` (`docs/spec-i18n.md:232-245`) verhindern den v1-
Strukturverlust. Der deutsche Markup-Fallback ist mit dem heutigen klassischen
Script-Boot kompatibel (`src-tauri/dist/index.html:817-819`). Die vollständige
Abschaltung nativer Monaco-Kontextmenüs bei gleichzeitigem Out-of-scope für
interne ARIA-/Command-Palette-Texte (`docs/spec-i18n.md:254-262`) ist ehrlich
und prüfbar.

### 5. Export-Surface und String-Grenzen sind vollständig genug beschrieben

Cover/Header, Default-Titel, Datum und Export-`lang` sind konkret in I4a und
in englischen Exporttests verankert (`docs/spec-i18n.md:176-184`,
`docs/spec-i18n.md:376-383`). User-Frontmatter, Custom-Templates,
Dokumentinhalt und technische Details bleiben korrekt außerhalb der
Übersetzung.

### 6. E2E-de-Pin und separater en-Prozess sind realistisch

Der Hauptpfad startet Folio tatsächlich im Wrapper
(`scripts/run-e2e.sh:142-163`), der Eigenstart in `run.py` baut seine Env vor
`AppController.start` (`tests/e2e/run.py:189-198`). Deshalb ist die Forderung,
`FOLIO_LANG=de` an genau beiden Stellen zu setzen, ausführbar. Der separate
en-Boot ohne Baseline-Vergleich ist richtig; native Menüs gehören weiterhin in
Rust-Tests. Die bekannten wortlautabhängigen AI-Settings-Asserts existieren
tatsächlich (`tests/e2e/scenarios/33_ai_settings.py:268-272`) und sind in I6
explizit neutralisiert (`docs/spec-i18n.md:399-406`). Weitere gefundene
deutsche E2E-Texte betreffen überwiegend Testdaten oder Meldungen des
Test-Runners, nicht UI-Selektoren.

### 7. Naming und Drift-Bremse sind praktikabel

Die flexible 3-bis-5-Ebenen-Regel, funktionale Namen, konsistente Rollen und
deklarative Ausnahme für ID-Registries (`docs/spec-i18n.md:83-113`) tragen die
bekannten Surfaces ohne wortlautbasierte Keys. Der bidirektionale Referenztest
mit Dead-Key-Prüfung (`docs/spec-i18n.md:300-305`) ist die richtige
Drift-Bremse; Empfehlung 3 präzisiert nur seine technische Erfassung.

## Abschluss-Verdikt

**NACHARBEIT — Implementierung noch nicht starten.** Für eine Freigabe müssen
mindestens folgende fünf Spec-Änderungen eingearbeitet sein:

1. Produktions-Registry und dritte Test-Fixture widerspruchsfrei trennen,
   Directory-Rebuild-Trigger und Build-Validator festlegen.
2. Migration/Recovery so definieren, dass eine vorhandene oder separat
   extrahierte Sprache nie durch Whole-object-Defaults verloren geht; das
   Neuinstallationskriterium auf alle Folio-Artefakte erweitern und korrupte
   `settings.json` als Bestandsnachweis behandeln.
3. String-Tag-Patchvalidierung, HTTP-Status, BCP-47-Kanonisierung,
   unbekannte gespeicherte Tags und die getrennte Auflösung von Katalog-Tag/
   Formatierungs-Locale normativ festlegen.
4. `{count}`-Semantik, Pflicht-Branches und atomaren Pluralobjekt-Fallback für
   Frontend und Rust identisch definieren.
5. `i18nReady` und `uiReady` trennen; Event-Queue erst nach vollständiger Init
   drainen und den Automation-Ready-Gate samt Routenmatrix, State und Timeout
   spezifizieren.

Die Empfehlungen — insbesondere die Teilung von I1 — sollten im selben
Nacharbeitsgang übernommen werden, sind aber nicht der Grund für das
NACHARBEIT-Verdikt. Nach den fünf Korrekturen ist aus heutiger Sicht kein
weiterer Architektur-Blocker erkennbar.
