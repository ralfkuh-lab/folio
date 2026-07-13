# Freigabe-Check der i18n-Spec v3

Stand: 2026-07-13. Geprüft wurden nur die fünf Blocker aus
`docs/review-i18n-plan-codex-v2.md` und offensichtliche Widersprüche der
v3-Einarbeitung. Die separat nachgearbeitete I0-Surface-Map ist ausdrücklich
nicht Gegenstand dieses Checks.

## Blocker-Abgleich

| Nr. | Verdikt | Kurzbegründung |
|---|---|---|
| 1 — Registry/Fixture/Build-Vertrag | **Vollständig adressiert** | Produktions-Glob und `fr`-Fixture sind getrennt, derselbe parametrisierte Generator wird im Temp-Verzeichnis getestet, Rebuild-Trigger und fail-closed-Validierung einschließlich Duplikat-/Reihenfolgeprüfung sind festgelegt (`docs/spec-i18n.md:69-96`). |
| 2 — Settings-Migration/Recovery | **Fast vollständig, kleiner Rest** | Raw-Load, unabhängige Sprachextraktion, corrupt-file-Pin, vollständigeres Artefaktkriterium und Regressionstests sind vorhanden (`docs/spec-i18n.md:160-188`). Für den ausdrücklich unterschiedenen Fall „gültiges Nicht-Objekt“ sowie ein vorhandenes, aber nicht-stringförmiges `language`-Feld fehlt noch die Folgeregel. |
| 3 — String-Tag/Patch/Format-Locale | **Fast vollständig, kleiner Rest** | Patch-Validierung, Automation-400, unbekannte persistierte Tags, UI-Darstellung und getrennte Resolver-Ausgabe sind festgelegt (`docs/spec-i18n.md:133-158`, `docs/spec-i18n.md:378-383`). Nur für einen per Subtag gematchten Override wie `FOLIO_LANG=de-CH` bleibt `formatLocale` zwischen den Regeln offen. |
| 4 — Plural-API/Branches/Merge | **Vollständig adressiert** | `{count}`-Injektion, reservierte Überschreibung, Pflicht-Branches, atomare Pluralobjekte, identische Rust-/TS-Semantik und konkrete Kompositionsbeispiele sind normativ beschrieben (`docs/spec-i18n.md:241-295`). |
| 5 — Bootstrap/Queue/Automation-Ready | **Vollständig adressiert im Architekturvertrag** | `booting`, `i18nReady` und `uiReady` sind getrennt; Drain und `frontend_ready` liegen nach allen Handler-Inits. Backend-State, ungated `/state`, wartende Routenkategorie und Runner-Poll sind definiert (`docs/spec-i18n.md:297-342`). Zwei redaktionelle Ablaufwidersprüche für I1b stehen unten. |

## Offensichtliche neue Widersprüche

### 1. Die Settings-Zustandsmaschine benennt einen Zustand ohne Übergang

`gültiges Nicht-Objekt` wird ausdrücklich als eigener Raw-Load-Fall genannt
(`docs/spec-i18n.md:166-168`), danach behandeln die Regeln aber nur gültige
Objekte, korrupte/unlesbare Dateien und `NotFound`
(`docs/spec-i18n.md:169-185`). Dasselbe gilt für ein syntaktisch gültiges
Objekt mit `"language": null` oder einer Zahl: Es ist weder „ohne Feld“ noch
ein extrahierbarer gespeicherter String-Tag.

**Minimale Spec-Korrektur:** Beide Fälle der vorhandenen defekten Datei
zuordnen: effektiv `de`, `warn`, Datei nicht überschreiben. Einen gemeinsamen
Regressionstest für Nicht-Objekt und nicht-stringförmiges `language` ergänzen.

### 2. Subtag-Match von `FOLIO_LANG` hat keine eindeutige Format-Locale

Ein exakter `FOLIO_LANG`-Registry-Tag verwendet `@meta.locale`
(`docs/spec-i18n.md:149-151`); zugleich darf der Override wie `system` per
Sprach-Subtag matchen (`docs/spec-i18n.md:152-157`). Für
`FOLIO_LANG=de-CH` bei nur vorhandenem Katalog `de` ist damit nicht festgelegt,
ob `formatLocale` `de-CH` oder `de-DE` wird.

**Minimale Spec-Korrektur:** Einen Satz ergänzen. Konsistent mit der
Systemregel wäre: gültiger voller Override bleibt beim Subtag-Fallback als
`formatLocale` erhalten; nur ein exakter Registry-Tag verwendet
`@meta.locale`.

### 3. `cli_pending_open` ist kein Backend→Frontend-Event

Die Bootstrap-Ereignisliste führt `cli_pending_open` unter den vorab zu
registrierenden Events (`docs/spec-i18n.md:301-307`). Im realen Boot ist es
jedoch ein vom Frontend aufgerufener Tauri-Command; nur `cli:open` ist ein
Listener-Event (`src-tauri/web/app/main.ts:267-282`).

**Minimale Spec-Korrektur:** `cli_pending_open` aus der Eventliste entfernen
und separat festlegen, dass der Command erst nach Installation der
Document-/Tab-Handler abgefragt und sein Ergebnis über denselben Dispatcher
verarbeitet wird. Das betrifft I1b, nicht den Start von I1a.

### 4. I1b verlangt einen de-Baseline-Lauf vor dem de-Pin

I1b fordert einen E2E-Voll-Lauf „noch ohne Pin“ und behauptet dabei faktisch
deutsches Verhalten (`docs/spec-i18n.md:447-460`). Nach derselben Spec setzt
ein leeres isoliertes Testprofil das Setting aber auf `system`
(`docs/spec-i18n.md:180-185`); der Wrapper isoliert genau dieses Config-Profil
(`scripts/run-e2e.sh:142-152`). Auf einer nichtdeutschen bzw. `C`-Locale kann
der Lauf daher englisch booten und deutsche Baselines brechen. Der Pin kommt
erst in I1c (`docs/spec-i18n.md:462-469`).

**Minimale Spec-Korrektur:** Den `FOLIO_LANG=de`-Pin samt `/state.lang`-Assert
vor den ersten I1b-E2E-Voll-Lauf ziehen; I1c behält Referenz-Gate und
Runner-Readiness. Alternativ in I1b noch keinen Baseline-E2E verlangen. Das
betrifft I1b, nicht den Rust-Fundament-Schnitt I1a.

## Verdikt

**NACHARBEIT — I1a noch nicht starten.** Vor der Freigabe reichen zwei kleine
normative Ergänzungen:

1. Recovery für gültiges Nicht-Objekt und nicht-stringförmiges
   `language` festlegen.
2. `formatLocale` für einen per Subtag gematchten `FOLIO_LANG`-Override
   festlegen.

Die Punkte 3 und 4 sollten im selben kurzen Spec-Patch korrigiert werden,
blockieren für sich genommen aber nur I1b. Registry, Generator, Pluralmodell,
`MenuLabels`, `OnceLock`-Testbarkeit und der grundsätzliche Ready-Vertrag sind
für I1a ausreichend spezifiziert. Nach den beiden I1a-Korrekturen ist aus
diesem gezielten Check **FREIGABE für I1a** zu erwarten; die separate I0-Abnahme
bleibt gemäß Auftrag eine unabhängige Startvoraussetzung.
