# Plan-Review: Internationalisierung

Review-Stand: 2026-07-13. Geprüft wurden `docs/spec-i18n.md`,
`docs/i18n-inventar.md`, `CLAUDE.md` sowie die relevanten Frontend-, Rust- und
E2E-Pfade im aktuellen Arbeitsbaum. Dies ist ausschließlich ein Plan-Review;
es wurden keine Implementierungsänderungen vorgenommen.

## Blocker

### 1. Das harte Abnahmekriterium „weitere Sprache = nur eine Katalogdatei“ wird von der vorgesehenen Architektur nicht erfüllt

**Begründung:** Die aktuelle Sprache ist im Backend ein geschlossenes Enum
(`src-tauri/src/settings.rs:19-32`), im Frontend ein geschlossenes Union-Type
(`src-tauri/web/app/ui/settings-dialog.ts:23-30`) und im HTML als feste
Optionsliste verdrahtet (`src-tauri/dist/index.html:169-173`). Die Spec ergänzt
zwar `System`, behält aber dieses Modell grundsätzlich bei. Zusätzlich brauchen
`include_str!`-Einbettung, Rust-Pluralregeln und Settings-Optionen ohne einen
generierten Katalog-Index weiterhin Codeänderungen. Das widerspricht auch dem
Folgepunkt der Spec, der für neue Sprachen selbst „`Language`-Variante +
Plural-Regeln“ nennt. Regionale Tags wie `pt-BR` oder Skript-Tags wie `zh-Hans`
lassen sich durch „nur Sprach-Subtag“ außerdem nicht korrekt repräsentieren.

**Konkrete Spec-Änderung:** Vor Implementierungsstart zwischen zwei ehrlichen
Verträgen entscheiden:

- Entweder das harte Kriterium auf „Katalogdatei plus Sprachregistrierung im
  Code“ abschwächen.
- Oder die Architektur darauf ausrichten: Katalogdateien tragen Metadaten wie
  BCP-47-Tag, Formatierungs-Locale und Eigenbezeichnung; ein Build-Script
  generiert aus `locales/*.json` den eingebetteten Registry-Code; das Setting
  speichert `system` oder einen validierten String-Tag statt einer Enum-Variante;
  die Settings-Liste kommt aus dem Registry-Command; Rust verwendet ein
  generisches CLDR-Pluralregelwerk statt eines Matchs pro Sprache.

Als Abnahmetest ist eine dritte Testkatalogdatei sinnvoll, die ohne manuelle
Rust-/TS-/HTML-Änderung eingebettet, auswählbar und pluralfähig wird.

### 2. Settings-Migration kann nach der heutigen Deserialisierung „Datei fehlt“ und „Feld fehlt“ nicht unterscheiden

**Begründung:** `Language::default()` ist heute Deutsch
(`src-tauri/src/settings.rs:19-25`), und `SettingsData.language` verwendet
`#[serde(default)]` (`src-tauri/src/settings.rs:130-135`).
`SettingsService::load_from` bekommt von `persist::load_json` bereits einen
fertigen Defaultwert (`src-tauri/src/settings.rs:279-286`); `load_json` fasst
fehlende Datei, Lesefehler, ungültiges JSON und Deserialisierungsfehler in
denselben `Default`-Pfad zusammen (`src-tauri/src/persist.rs:60-64`). Nach
diesem Punkt ist nicht mehr erkennbar, ob `"language":"de"` explizit vorhanden
war.

Hinzu kommt: Eine fehlende `settings.json` beweist nicht zwingend eine
Neuinstallation. Der Service schreibt die Datei derzeit erst bei einem
tatsächlich geänderten Patch (`src-tauri/src/settings.rs:431-433`). Ein
langjähriger Nutzer, der nie eine semantische Einstellung geändert hat, kann
also ebenfalls keine Datei besitzen und würde entgegen dem Migrationsziel auf
OS-Locale umgestellt.

**Konkrete Spec-Änderung:** Einen expliziten Raw-JSON-Migrationsalgorithmus vor
der typisierten Deserialisierung festlegen und testen:

1. gültiges bestehendes JSON-Objekt ohne `language` -> `"de"` injizieren und
   atomar persistieren;
2. gültiges JSON mit `language` -> unverändert übernehmen;
3. korrupte/unlesbare Datei -> definiertes Recovery-Verhalten, ohne sie
   ungefragt als Neuinstallation zu behandeln;
4. fehlende Datei -> nur dann `system`, wenn ein belastbares
   Neuinstallationskriterium erfüllt ist. Dafür ist ein Migrationsmarker oder
   mindestens die Existenz anderer Folio-State-Dateien zu berücksichtigen.

Die Spec muss Tests für alle vier Fälle einschließlich wiederholtem Laden
fordern.

### 3. Es fehlt ein einziger, vor dem Menü festgelegter Rust-Boot-Owner für Settings, Migration und `OnceLock`

**Begründung:** Settings werden heute mindestens dreimal unabhängig geladen:
für Logging (`src-tauri/src/lib.rs:526-531`), im Tauri-Menü-Callback
(`src-tauri/src/lib.rs:113-123`) und beim Aufbau des `AppState`
(`src-tauri/src/state.rs:145-156`). Das Menü wird sofort aus dem übergebenen
Sprachcode gebaut (`src-tauri/src/menu/build.rs:14-18`). Die Spec sagt nur, die
aufgelöste Sprache „liegt als `OnceLock`“ vor, aber nicht, wer sie wann setzt.
Ein lazy `labels()` könnte dadurch die Migration oder Env-Auflösung beim ersten
beliebigen Aufruf auslösen; ein späteres explizites `set` könnte bereits zu spät
sein. Mehrfaches Laden ist bei einer nun schreibenden Migration zusätzlich
unnötig riskant.

**Konkrete Spec-Änderung:** Eine kanonische Boot-Sequenz festschreiben:

1. Settings genau einmal laden und migrieren;
2. `FOLIO_LANG` validieren und die Prozesssprache genau einmal auflösen;
3. Kataloge parsen/validieren und den i18n-State initialisieren;
4. erst danach Tauri-Menü bauen;
5. denselben geladenen `SettingsService` in `AppState` übernehmen.

`OnceLock` soll nur Cache/Read-Surface sein, nicht versteckter Settings-Loader.
Die Spec muss außerdem definieren, was bei unbekanntem `FOLIO_LANG`, unbekanntem
gespeichertem Tag und Katalog-Parsefehler passiert. Tests müssen Menü,
`i18n_catalog` und Backend-`t()` auf dieselbe aufgelöste Sprache prüfen.

### 4. Der asynchrone Frontend-Boot braucht einen echten Bootstrap- und Early-Event-Vertrag

**Begründung:** `main.ts` führt derzeit ab `src-tauri/web/app/main.ts:95-135`
alle `init*()`-Funktionen unmittelbar auf Modulebene aus und registriert erst
danach die zentralen Backend-Listener (`src-tauri/web/app/main.ts:137-156`). Ein
bloß davor geschriebener `await` ist in der heutigen IIFE-Bundle-Struktur keine
ausreichend beschriebene Änderung. Statische Imports werden zudem vor jedem
Bootstrap ausgewertet. Übersetzbare Daten liegen bereits auf Modulebene, etwa
die Cheat-Sheet-Zeilen (`src-tauri/web/app/ui/cheatsheet.ts:11-25`). Werden
diese Literale dort einfach durch `t()` ersetzt, frieren sie vor `initI18n()`
auf dem Key-Fallback ein.

Während des zusätzlichen IPC-Wartens ist die WebView bereits sichtbar
(`src-tauri/src/lib.rs:270-297`), die Automation-API kann schon laufen
(`src-tauri/src/lib.rs:298-302`), und native Menü-/`cli:open`-/Automation-Events
können eintreffen. Der bestehende Boot berücksichtigt verlorene Initialevents
explizit über spätere Re-Emission (`src-tauri/src/lib.rs:206-212`); für
beliebige Menü-, Single-Instance- und Automation-Events existiert keine
allgemeine Queue.

**Konkrete Spec-Änderung:** I1/I2 müssen einen konkreten Bootstrap-Vertrag
enthalten:

- ein `async bootstrap()` kapselt die bisherige Init-Reihenfolge;
- übersetzte Modulkonstanten werden zu nach Init erzeugten Factories oder in
  `init*()` aufgebaut; ein Test/Lint verhindert `t()` in Module-Level-
  Initializern;
- kritische Backend-Event-Sinks werden vor dem Await registriert und bis
  `i18nReady` gequeued, oder Backend und Automation warten auf einen expliziten
  Frontend-Ready-Handshake;
- `initI18n()`-Fehler haben einen definierten Degradationspfad. Insbesondere
  darf `applyStaticTranslations()` bei fehlendem Katalog nicht die brauchbaren
  deutschen HTML-Platzhalter durch rohe Keys ersetzen.

Ein Boot-Test soll absichtlich `cli:open`, ein Menüevent und eine
Automation-DOM-Anfrage während eines verzögerten `i18n_catalog` schicken.

### 5. `app.bundle` kann Monaco nicht nachträglich vollständig lokalisieren

**Begründung:** Die Script-Reihenfolge ist Loader -> `editor.bundle.js` ->
`app.bundle.js` (`src-tauri/dist/index.html:817-819`). Das Editor-Bundle startet
den Monaco-AMD-Load bereits auf Modulebene
(`src-tauri/web/editor/mount.ts:116-127`), also vor jedem geplanten
`initI18n()` im App-Bundle. Beim Haupteditor und Theme-Editor bleibt Monacos
eingebautes Kontextmenü standardmäßig aktiv
(`src-tauri/web/editor/mount.ts:153-167`,
`src-tauri/web/editor/theme-editor.ts:58-71`); Code-View und Diff-View schalten
es dagegen explizit ab (`src-tauri/web/editor/view-code.ts:109-127`,
`src-tauri/web/editor/diff-view.ts:74-88`). Damit bleiben mindestens Monacos
eigene Menü-/ARIA-/Aktionsstrings außerhalb des Katalogdesigns. Auch der
Editor-Sprachpicker bezieht Anzeigenamen direkt aus Monacos englischen Aliases
(`src-tauri/web/editor/text.ts:51-58`).

**Konkrete Spec-Änderung:** Den Monaco-Scope verbindlich entscheiden. Für das
harte „nur Katalogdatei“-Ziel ist die einfachste V1-Lösung, native Monaco-
Kontextmenüs auf allen Surfaces abzuschalten und verbleibende Monaco-interne
Strings ausdrücklich als Drittanbieter-Surface aus dem Vollständigkeitsziel
auszunehmen. Soll Monaco selbst lokalisiert werden, muss die Locale vor dem
Editor-Bundle/AMD-Load verfügbar sein; dann braucht die Spec einen separaten
NLS-Build-/Loaderpfad und kann nicht behaupten, allein `app/i18n` trage alles.
Der Sprachpicker braucht zusätzlich eine bewusste Regel für technische
Sprachnamen und den Fallback „Plain Text“.

### 6. Der statische DOM-Applier ist für das reale HTML zu grob und setzt die Dokument-Locale nicht

**Begründung:** `data-i18n` soll laut Spec pauschal `textContent` setzen. Viele
übersetzbare Elemente sind aber keine Textblätter. Beispielsweise enthält das
Label für Auto-Format eine Checkbox plus Text
(`src-tauri/dist/index.html:196-200`); im About-Dialog enthalten `dt`-Elemente
SVG-Icons plus Text (`src-tauri/dist/index.html:715-719`). Ein `textContent`-
Apply auf diese Elemente würde die Controls bzw. Icons löschen. Umgekehrt
bleibt `<html lang="de">` beim englischen Boot falsch
(`src-tauri/dist/index.html:1-2`), weil die vorgesehenen Attribute nur Text,
Titel, Placeholder und ARIA abdecken.

**Konkrete Spec-Änderung:** `data-i18n` ausdrücklich nur auf Leaf-Elementen
zulassen; gemischte Textknoten bekommen eigene `<span>`-Wrapper. Ein DOM-Test
muss garantieren, dass der Applier keine vorhandenen Elementkinder entfernt.
Zusätzlich `document.documentElement.lang` aus dem aufgelösten BCP-47-Tag
setzen. Die Attributnamen sollten exakt auf Zielattribute abgebildet werden
(`data-i18n-aria-label`, nicht ein unspezifisches `data-i18n-aria`). I2 braucht
einen Markup-Lint/Test für alle `data-i18n-*`-Referenzen und gemischten Nodes.

### 7. Das Mikro-Pluralformat reicht für mehrere der angeblich 14 Fälle nicht aus

**Begründung:** Die Spec beschreibt automatische Pluralwahl nur bei einem
numerischen `count`, zeigt aber als Beispiel `{hits}` und `{files}`. Die reale
Statuszeile hat drei unabhängig zu pluralisierende Größen
(`src-tauri/web/app/state/document.ts:134-142`). Die Vault-Suche kombiniert
Treffer- und Dateizahl in einem Satz (`src-tauri/web/app/vault/search.ts:319`,
`src-tauri/web/app/vault/search.ts:347-355`). Ein einziges Pluralobjekt kann
nicht gleichzeitig „1 Treffer in 2 Dateien“ und „2 Treffer in 1 Datei“ korrekt
auswählen. Das Problem ist nicht theoretisch und wird bei Sprachen mit mehr
CLDR-Kategorien größer.

Außerdem ist die Inventarliste nicht vollständig: „Weitere Layouts (n)“ ist
eine zusätzliche dynamische Zählstelle
(`src-tauri/web/app/ui/export-dialog.ts:144-150`), Katalogdatum und Quelle
werden zusammengesetzt (`src-tauri/web/app/ui/settings-ai.ts:686-703`), und
Assetname/-größe ebenfalls (`src-tauri/web/app/ui/theme-editor.ts:216-233`).

**Konkrete Spec-Änderung:** Die API darf den Selektor nicht implizit erraten.
Mindestens `tPlural(key, selector, args)` im Frontend analog zur Rust-API
festlegen. Für mehrere unabhängige Plurale entweder:

- die Nachricht in eigenständig pluralisierte, sprachlich tragfähige Segmente
  zerlegen und deren Reihenfolge pro Sprache modellieren, oder
- ein echtes MessageFormat mit verschachtelten Plural-/Select-Ausdrücken
  verwenden.

Die Spec muss für 0/1/2 in allen unabhängigen Zählvariablen konkrete de/en-
Tests nennen. Vor der Entscheidung „kein ICU“ ist das dynamische Inventar neu
zu erheben; die Zahl 14 darf nicht mehr als Vollständigkeitsbeleg dienen.

### 8. Export-Ausgabe ist als String-Surface übersehen

**Begründung:** Nicht nur Theme-Namen/-Beschreibungen sind eingebettet. Das
Brand-Cover enthält „Erstellt von“ (`src-tauri/src/layouts/brand.cover.html:22-25`),
das Business-Cover „Vorbereitet von:“
(`src-tauri/src/layouts/business.cover.html:20-23`). Diese Dateien werden als
Built-ins direkt eingebettet (`src-tauri/src/theme/builtin.rs:14-27`) und beim
Export gerendert (`src-tauri/src/export.rs:232-268`). Der Export-Wrapper setzt
außerdem immer `<html lang="de">` (`src-tauri/src/export.rs:400-412`), und ein
pfadloses Dokument heißt immer „Dokument“ (`src-tauri/src/export.rs:417-426`).
Der automatisch erzeugte Datumsfallback ist ausdrücklich `DD.MM.YYYY`
(`src-tauri/src/theme/template.rs:55-61`,
`src-tauri/src/theme/template.rs:324-329`). Inventar und I4 nennen diese
Ausgabe-Surface nicht.

**Konkrete Spec-Änderung:** I4 um Built-in-Cover/Header/Footer, Export-`lang`,
Defaulttitel und Defaultdatum ergänzen. Statische Built-in-Template-Texte
sollten über zusätzliche TemplateContext-Werte aus dem Katalog kommen; vom
Nutzer gelieferte Frontmatter- und Custom-Template-Texte bleiben unverändert.
Für HTML und PDF ist je ein englischer Exporttest nötig, der Covertext,
`<html lang>`, Titel und Datum prüft. Die aktuell geprüften Footer enthalten
nur User-Platzhalter und brauchen selbst keine Übersetzung.

### 9. E2E-Pin und englischer Boot sind im vorgesehenen Runner so nicht ausführbar

**Begründung:** Der übliche Linux-Wrapper startet Folio selbst
(`scripts/run-e2e.sh:154-163`) und ruft `run.py` anschließend mit `--attach`
auf (`scripts/run-e2e.sh:187-190`). Ein nur in `run.py` gesetztes
`FOLIO_LANG=de` erreicht diesen Hauptpfad daher nicht. Gleichzeitig liegt der
Pin erst in I6, obwohl ab I2 deutsche Baselines verlangt werden. Das isolierte
Testprofil hat keine `settings.json`; mit dem neuen Systemdefault und einer
neutralen Xvfb-Locale kann es bereits ab I2 auf Englisch fallen.

Alle Szenarien laufen gegen genau einen Prozess
(`tests/e2e/run.py:267-285`). Ein einzelnes Szenario kann denselben Prozess
nicht mit `FOLIO_LANG=en` neu booten. Native Menülabels sind über die heutige
Automation nur per stabiler ID dispatchbar, nicht als DOM lesbar; der HTTP-
Menüpfad testet Aktionen, nicht native Beschriftungen. Der Automation-State
liefert zwar Fenstertitel und UI-State (`src-tauri/src/automation/handlers/state.rs:15-23`,
`src-tauri/src/automation/handlers/state.rs:105-135`), aber keine Menülabels.

**Konkrete Spec-Änderung:** Den de-Pin vor den ersten I2-E2E-Lauf ziehen und in
beide Startpfade setzen, insbesondere in `scripts/run-e2e.sh`. Der Runner soll
vor Baseline-Vergleichen die tatsächlich aufgelöste Sprache prüfen. Den
en-Nachweis als separaten Prozesslauf/Wrapper-Modus spezifizieren, nicht als
normales Szenario im bestehenden Voll-Lauf. Native Menütexte gehören in einen
Rust-Integrationstest des gebauten `MenuLabels`-Satzes oder benötigen einen
gezielten read-only Diagnose-Endpunkt; Toolbar/Status/HTML können im separaten
en-Boot per DOM geprüft werden. Ein Frontend-Ready-Handshake muss außerdem vor
der ersten `/dom`-Anfrage stehen, damit das neue i18n-Await keine
Automation-Events verliert.

## Empfehlungen

### 1. Parität um Referenz- und Dead-Key-Prüfung erweitern

**Begründung:** Identische de/en-Keymengen beweisen nur, dass beide Kataloge
gleich driften. Reale Referenzen entstehen in dynamischem TS
(z. B. `src-tauri/web/app/state/tabs.ts:194-204`), im HTML
(`src-tauri/dist/index.html:114-120`) und künftig in Rust-`t()`-Aufrufen. Ein in
beiden Katalogen fehlender, im Code verwendeter Key sowie ein in beiden
Katalogen ungenutzter Alt-Key würden den geplanten Test bestehen.

**Konkrete Spec-Änderung:** Das Gate soll zusätzlich alle statischen
`t`/`t_args`/`t_plural`-Referenzen und alle `data-i18n-*`-Werte gegen den
Basiskatalog prüfen und umgekehrt unreferenzierte Keys melden (mit expliziter
Allowlist für absichtlich indirekte Registry-Keys wie Built-in-Theme-IDs).
Dynamisch zusammengesetzte Keys verbieten oder über eine deklarative Registry
erfassen. Außerdem Werttyp-Parität (String vs. Pluralobjekt), Platzhalter pro
Pluralzweig, erlaubte CLDR-Kategorien, doppelte JSON-Keys und alphabetische
Sortierung testen.

### 2. Locale-Helfer decken derzeit nicht alle locale-abhängigen Operationen ab

**Begründung:** Neben den in der Spec genannten `toLocaleString`- und
`localeCompare`-Stellen gibt es festes `Intl.DateTimeFormat('de-DE')`
(`src-tauri/web/app/ui/settings-ai.ts:686-696`), mehrere
`toLocaleLowerCase('de')`-Suchpfade
(`src-tauri/web/app/ui/settings-ai.ts:296-314`) und dezimale Dateigrößen mit
`toFixed(1)` (`src-tauri/web/app/ui/theme-editor.ts:216-219`). Der
Editor-Sprachpicker sortiert sogar ohne explizite Locale
(`src-tauri/web/app/ui/language-picker.ts:18-24`). `fmtNumber(n)` und
`compareStrings(a,b)` allein reichen dafür nicht.

**Konkrete Spec-Änderung:** Eine kleine Locale-Surface festlegen, mindestens
`fmtNumber(value, options?)`, `fmtDate`, `fmtBytes`, einen gemeinsamen
`Intl.Collator` und eine locale-bewusste Suchnormalisierung. I3 braucht Greps
nicht nur für `'de-DE'`/`localeCompare`, sondern auch für
`toLocaleLowerCase`, `Intl.DateTimeFormat` und `toFixed` in user-sichtbaren
Zahlen. Der vom OS gelieferte volle BCP-47-Tag sollte für Formatierung erhalten
bleiben, auch wenn der Übersetzungskatalog auf eine Basissprache zurückfällt.

### 3. UI-Fehler und Automation-Fehler brauchen eine explizite Grenze

**Begründung:** Mehrere Fehlerquellen sind geteilte `thiserror`-Displays, etwa
`SearchError` (`src-tauri/src/search.rs:142-156`) und `AiConfigError`
(`src-tauri/src/ai/config.rs:9-24`). Die Automation reicht dieselben
Suchfehlermeldungen als freies `{"error": String}` durch
(`src-tauri/src/automation/handlers/search.rs:89-98`), und Settings-Automation
nutzt denselben Update-Service wie die UI
(`src-tauri/src/automation/handlers/settings.rs:48-51`). Werden die Display-
Strings global über `t()` lokalisiert, ändert `FOLIO_LANG` damit auch
HTTP-Antworttexte. Reine OS-/Parserdetails werden zudem vielfach unverändert
über `error.to_string()` angehängt; diese sind nicht vollständig
übersetzbar.

**Konkrete Spec-Änderung:** Festlegen, dass UI-Präfixe/-Erklärungen übersetzt,
technische Details aber als `{detail}` unverändert angehängt werden. Für die
Automation stabile sprachneutrale Fehlercodes ergänzen und `error` nur als
diagnostischen Text behandeln, oder Automationfehler ausdrücklich separat und
unübersetzt mappen. I4 muss `#[error(...)]`-Enums und geteilte Servicefehler
explizit aufführen; „am Entstehungsort `t()`“ ist dafür zu pauschal.

### 4. Das dynamische Inventar vor I3 neu erheben

**Begründung:** Das vorhandene Inventar fokussiert Umlaute und die größten
Module. Zusätzliche user-sichtbare Quellen sind unter anderem Image-View-
Fehler (`src-tauri/web/app/view/image.ts:35-61`), Code-Copy-ARIA/Tooltip
(`src-tauri/web/app/view/code-copy.ts:56-58`,
`src-tauri/web/app/view/code-copy.ts:111-118`), dynamische Mode-Tooltips
(`src-tauri/web/app/state/document.ts:283-305`) und die Scope-Remove-ARIA-
Beschriftung der Vault-Suche (`src-tauri/web/app/vault/search.ts:697-704`).
Diese Fälle passen grundsätzlich in `t()`, sind aber in der behaupteten
Vollständigkeitsliste nicht belastbar abgebildet.

**Konkrete Spec-Änderung:** Vor Extraktion eine maschinenunterstützte
String-Surface-Liste pro Datei erzeugen und als I0-/I3-Checkliste führen:
Textknoten, `textContent`, `innerHTML`, `title`, `aria-*`, `placeholder`,
native Dialoge, `thiserror`, eingebettete HTML-Dateien und exportierte
Dokumente. Die Schätzung darf Planungswert bleiben, aber nicht Abnahmekriterium.

### 5. I3 und I4 sind für jeweils einen Implementierungslauf zu groß; der de-Pin ist zu spät

**Begründung:** I3 kombiniert rund 220 Strings, mehrere DOM-Bauweisen,
Pluralumbau und Locale-Semantik. Der Code verteilt sich auf unabhängige, große
Surfaces wie Settings-AI (`src-tauri/web/app/ui/settings-ai.ts:285-350`),
Theme-Browser (`src-tauri/web/app/ui/settings-themes.ts:276-365`) und
KI-Aktionen (`src-tauri/web/app/ui/ai-actions-dialog.ts:270-329`). I4 kombiniert
Fehlerarchitektur, native Dialoge, Built-ins und nun zusätzlich Export-
Templates. Fehler würden erst am Ende einer sehr breiten Etappe lokalisiert.

**Konkrete Spec-Änderung:** Einen kleinen Vorlauf I0 (vollständige Surface- und
Key-Map) ergänzen. I3 mindestens in „State/Vault/Find/Tabs“ und
„Dialoge/Settings/AI/Theme“ teilen; I4 in „native Dialoge + Built-in-Daten +
Export“ und „Backend-Fehler“. Den E2E-de-Pin in I1 bzw. spätestens vor I2
ziehen. Jede Teil-Etappe bekommt Paritäts-/Referenzgate und einen de/en-Smoke.

### 6. Die Naming-Regel ist zu starr für die bereits bekannten Datenrollen

**Begründung:** Die erlaubten Qualifier enthalten weder `name` noch
`description`, obwohl Built-in-Themes genau diese zwei Rollen liefern
(`src-tauri/src/theme/builtin.rs:42-55`). Auch Status, Empty-State, Buttontext
und Optionswert passen nicht immer sauber in `.title/.label/.tooltip/...`.
Bei maximal vier Ebenen werden komplexe Bereiche wie Settings -> AI -> Provider
-> Empty-State entweder künstlich zusammengezogen oder inkonsistent benannt.
Die Spec verwendet außerdem parallel `statusbar` und `statusline`.

**Konkrete Spec-Änderung:** Drei Ebenen als Empfehlung, nicht als harte
Semantikgrenze behandeln; vier bis fünf Ebenen erlauben, wenn sie stabile
fachliche Hierarchie ausdrücken. Qualifier um mindestens `name`,
`description`, `status`, `empty` und `action` erweitern oder Qualifier ganz als
Rollenbegriff statt geschlossener Liste definieren. Top-Level-Namespace und
Komponentenwortschatz einmal kanonisch festlegen (`statusBar` versus
`statusline`, `find.findBar` vermeiden). Einige reale Keyfamilien für Theme,
AI-Provider, Export und Fehler sollten als normative Beispiele in die Spec.

### 7. Katalog- und Interpolationsfehler sollten im Produktionspfad sichtbar, aber nicht destruktiv sein

**Begründung:** Dynamische UI verwendet sowohl sichere `textContent`-Pfade als
auch bewusst gebautes `innerHTML`, etwa das Vault-Kontextmenü
(`src-tauri/web/app/vault/context-menu.ts:38-40`,
`src-tauri/web/app/vault/context-menu.ts:81-113`). Ein Mikro-Interpolator weiß
nicht, ob sein Ergebnis später als Text, Attribut oder HTML verwendet wird.
Außerdem darf ein unbekannter Platzhalter nicht still als sichtbare
`{variable}`-Leiche enden.

**Konkrete Spec-Änderung:** Dokumentieren, dass `t()` reinen Text liefert und
keine HTML-Sicherheit garantiert; interpolierte Userwerte dürfen nicht in
`innerHTML` gelangen. Katalogtests prüfen unbekannte/fehlende Platzhalter,
Runtime-Warnungen enthalten Sprache und Key, und Production fällt pro Key auf
Englisch bzw. den Key zurück. Für HTML-Komposition sind DOM-Nodes statt
übersetztem HTML vorzusehen.

## Nice-to-have

### 1. Pseudo-Locale als Layout- und Extraktionsprobe

**Begründung:** Die UI ist toolbar- und dialoglastig; lange Texte können
Controls sprengen, obwohl de/en funktional korrekt sind. Die Toolbar enthält
viele reine Tooltip-/ARIA-Flächen (`src-tauri/dist/index.html:22-80`), während
Settings lange Hilfetexte enthalten (`src-tauri/dist/index.html:195-240`).

**Konkrete Spec-Änderung:** Eine nur im Debug/Test verfügbare Pseudo-Locale
vorsehen, die Strings verlängert und sichtbar markiert. Ein Screenshot-Smoke
hilft zugleich, nicht extrahierte deutsche Texte zu finden.

### 2. Generierte bzw. typisierte Key-Surface im Frontend

**Begründung:** Die aktuelle Frontendarchitektur ist frameworkfrei und stark
modular; Tippfehler in String-Literalen würden sonst erst im Laufzeitfallback
auffallen. Die Bundle-Surface wird per TypeScript bereits streng geprüft
(`src-tauri/web/package.json:6-10`).

**Konkrete Spec-Änderung:** Aus dem Basiskatalog optional einen TypeScript-
Union-Type und Rust-Konstanten generieren. Das ersetzt den Referenztest nicht,
macht aber Editorfeedback früh und verhindert Schreibfehler.

### 3. Übersetzungskontext neben dem Katalog pflegen

**Begründung:** Gleichlautende Rollen werden bewusst getrennt, aber ein flacher
Key erklärt Übersetzern nicht immer, ob ein Text Menü, Tooltip oder
Exportinhalt ist. Besonders „View“, „Theme“, „Run“ und technische
Editorbegriffe kommen in mehreren Oberflächen vor
(`src-tauri/src/menu/strings.rs:76-89`,
`src-tauri/dist/index.html:29-31`).

**Konkrete Spec-Änderung:** Eine kleine Context-/Translator-Notes-Konvention
definieren, entweder als separate Metadatei oder generierte Doku. Die
Runtime-Katalogform kann flach bleiben.

## Explizit geprüft und für gut befunden

### 1. Ein gemeinsamer eingebetteter Katalog für Rust und Frontend ist grundsätzlich passend

**Begründung:** Menütexte werden heute im Backend benötigt
(`src-tauri/src/menu/build.rs:14-18`), während dieselben Sprachdaten im DOM und
dynamischen Frontend gebraucht werden. Ein vom Backend gemergter Katalog
vermeidet zwei handgepflegte Übersetzungsquellen und passt zum eingecheckten
Bundle-Modell (`src-tauri/web/package.json:6-10`). Die Fallbackfolge
aktive Sprache -> Englisch -> Key ist als nichtwerfender Runtimepfad sinnvoll,
sofern die oben genannten Build-Gates ergänzt werden.

**Konkrete Spec-Änderung:** Keine Richtungsänderung nötig; nur Registry,
Validierung und Fehlerverhalten präzisieren.

### 2. Neustart-Semantik passt zur aktuellen Menü- und Settings-Architektur

**Begründung:** Das Menü wird einmal beim Builder-Aufbau konstruiert
(`src-tauri/src/lib.rs:113-123`), während checked/enabled-Zustände später aus
dem Frontend synchronisiert werden (`src-tauri/src/menu/build.rs:21-48`). Der
Settings-Dialog zeigt bereits denselben Neustarthinweis
(`src-tauri/web/app/ui/settings-dialog.ts:139-146`). Ein Live-Rebuild würde
damit tatsächlich zusätzliche State-Rekonstruktion erfordern.

**Konkrete Spec-Änderung:** Keine; V1-Neustartsemantik beibehalten.

### 3. `MenuLabels` als erster Rust-Konsument und das Entfernen der drei de-Hardcodes sind ein sauberer Schnitt

**Begründung:** Der zentrale Menübau konsumiert schon ein Label-Struct
(`src-tauri/src/menu/build.rs:14-18`), während Recent-Placeholder
(`src-tauri/src/menu/recent.rs:30-35`), Rename-Dialog
(`src-tauri/src/commands/file/rename.rs:47-57`) und Save-As-Filter
(`src-tauri/src/commands/file/save_as.rs:34-69`) Deutsch separat erzwingen.
Die geplante parameterlose, prozesssprachige Label-Surface beseitigt diese
Abweichung ohne unnötigen Call-Site-Umbau.

**Konkrete Spec-Änderung:** Keine, abgesehen vom expliziten Boot-Owner aus
Blocker 3.

### 4. Find-Bar, Fenstertitel und Tray wurden konkret geprüft

**Begründung:** Die Folio-Find-Bar liegt in der HTML-Shell
(`src-tauri/dist/index.html:114-120`); ihr dynamischer Zähler besteht nur aus
Zahlen/Trennzeichen (`src-tauri/web/app/ui/find-bar.ts:342-357`). Sie wird durch
`find`-Keys plus statische Attribute ausreichend getragen. Der Fenstertitel
besteht aus Dateiname, Dirty-Marker und der nicht zu übersetzenden Marke
„Folio“ (`src-tauri/web/app/state/document.ts:103-114`); einen weiteren
lokalisierten Fenstertitelzusatz gibt es aktuell nicht. Der Tauri-Builder
registriert Plugins und das native Menü, aber keine Tray-Instanz
(`src-tauri/src/lib.rs:61-125`). Es gibt daher derzeit keine übersehene
Tray-String-Surface.

**Konkrete Spec-Änderung:** Find-Bar im I2/I3-Scope belassen; Fenstertitel und
Tray nicht künstlich mit Keys aufblasen. Nur künftige lokalisierte Zusätze
müssen dem Katalog folgen.

### 5. User-Content und Entwicklerlogs nicht zu übersetzen ist richtig abgegrenzt

**Begründung:** Custom-Theme-Metadaten werden als Userwerte aus Dateien gelesen
und unverändert angezeigt; die UI setzt Theme-Name/-Beschreibung direkt als
Text (`src-tauri/web/app/ui/settings-themes.ts:339-360`). Frontendlogs gehen
als Diagnosemeldungen an die Backend-Bridge, nicht als UI
(`src-tauri/web/app/util/log.ts:102-130`). Diese Inhalte in den UI-Katalog zu
ziehen würde Daten verändern bzw. Diagnose erschweren.

**Konkrete Spec-Änderung:** Keine; die Abgrenzung beibehalten. Technische
Fehlerdetails nur wie in Empfehlung 3 um einen übersetzten UI-Rahmen ergänzen.

### 6. KI-Systemprompts als eigene, UI-sprachunabhängige Etappe zu behandeln ist sinnvoll

**Begründung:** Die Built-in-Aktionsmetadaten und der Systemrahmen liegen im
Backend, während die UI sie nur konsumiert. Der bestehende Übersetzungspfad
arbeitet bereits mit einem englischen Prompt; die E2E-Übersetzung extrahiert
die Zielsprache aus diesem Vertrag (`tests/e2e/scenarios/34_ai_translate.py:114-117`).
Eine isolierte Prompt-Etappe reduziert das Risiko, Übersetzungsfehler und
Prompt-Verhaltensänderungen zu vermischen.

**Konkrete Spec-Änderung:** I5 beibehalten; zusätzlich klarstellen, dass
Prompttexte keine UI-Katalogwerte sind und Mock-Provider-Tests ihre Semantik,
nicht exakten deutschen Wortlaut prüfen.

### 7. Der deutsche E2E-Pin ist als Grundsatz richtig

**Begründung:** Die Baselines bilden bewusst einen kumulierten Voll-Lauf ab
(`tests/e2e/run.py:19-29`, `tests/e2e/run.py:251-256`), und der Test-Wrapper
isoliert alle Folio-Konfigurationsverzeichnisse
(`scripts/run-e2e.sh:142-152`). Eine feste Sprache ist deshalb die richtige
Stabilitätsstrategie; separate Baselines pro Sprache wären für den kurzen
englischen Funktionsnachweis unnötig.

**Konkrete Spec-Änderung:** Grundsatz beibehalten, aber Startpfad und Etappen-
Zeitpunkt gemäß Blocker 9 korrigieren.
