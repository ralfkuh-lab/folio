# Spec: Internationalisierung (i18n)

Status: **UMGESETZT (I1–I6, 2026-07-14)**. Planungsgrundlage war Spec v3.1;
die konsolidierte Historie steht am Ende und im Git-Log. Die gepflegte,
normative Referenz der String-Surfaces ist
[`i18n-surface-map.md`](i18n-surface-map.md).

## Ziel

Die komplette folio-UI mehrsprachig machen. V1 liefert **Deutsch + Englisch**.
Abnahmekriterium für Erweiterbarkeit: **eine weitere Sprache = eine
Katalogdatei mit Metadaten, ohne Änderungen an Rust-/TS-/HTML-Code** —
einzige zulässige Ausnahme: die Sprache braucht CLDR-Pluralregeln, die noch
nicht im Regelwerk hinterlegt sind (das Regelwerk deckt ab V1 den geplanten
Sprach-Batch ab, s. u.). Nachweis: ein Test kopiert `de`, `en` und einen
dritten vollständigen Katalog (Fixture, s. „Registry & Build-Script") in ein
Temp-Verzeichnis, ruft denselben Generator auf und prüft Registry, Auswahl,
Fallback und mindestens einen Pluralfall — ohne Code-Änderung.

Umfang: grob ~520+ user-sichtbare Strings (HTML-Shell ~170, TypeScript ~220,
Rust ~134) plus die in den Reviews nachgewiesenen Zusatzflächen
(Export-Templates, ARIA, `web/editor/`-Baum). Verbindliche Surface-Liste ist
die abgenommene I0-Map.

**Nicht** Ziel von V1 (bewusst, siehe Folgepunkte): Live-Sprachwechsel ohne
Neustart, RTL-Sprachen (eigenes Projekt), Übersetzung von User-Content
(Custom-Themes, eigene KI-Templates, Dokumente, Frontmatter), Übersetzung von
Log-Meldungen, Lokalisierung Monaco-interner Strings (Drittanbieter-Surface).

## Vom User entschiedene Eckpunkte (2026-07-13)

1. **Sprachwechsel = Neustart-Semantik** (bestehender Hinweis bleibt);
   Live-Wechsel ist Folgepunkt.
2. **Default für Neuinstallationen: OS-Locale, Fallback en.** Bestandsnutzer
   behalten Deutsch (Migrations-Zustandsmaschine unten).
3. **KI-Systemprompts auf Englisch** (Etappe I5), Antwort in Dokumentsprache.
4. **Kataloge: eine Datei pro Sprache** (Industriestandard, Voraussetzung für
   Sprachpakete und Übersetzungs-Workflow).
5. **Alle Key-Segmente englisch** (sprachneutrale Bezeichner wie
   Code-Identifikatoren).

## Architektur-Entscheidungen (verbindlich)

### Kataloge — eine Quelle für Backend UND Frontend

- **Format**: eine JSON-Datei pro Sprache unter `src-tauri/locales/`
  (`de.json`, `en.json`). Reservierter Metadaten-Key `"@meta"`:
  `{ "tag": "de", "name": "Deutsch", "locale": "de-DE" }` — kanonischer
  BCP-47-Tag (== Dateistamm), Eigenbezeichnung (Settings-Dropdown),
  Default-Formatierungs-Locale. Darunter flache **Namespace-Dot-Keys**.
- **Werte**: String **oder** Plural-Objekt mit CLDR-Kategorien. Interpolation
  über benannte Platzhalter `{name}` (englisch, sprechend, in allen Sprachen
  identisch). Kein ICU, keine Fremdbibliothek (Grenzen unter „Plural &
  Komposition"). Objekte mit `@format`-Key sind in V1 **ungültig** und werden
  vom Validator mit „unsupported format" abgelehnt — der Namensraum ist nur
  konzeptionell für eine spätere ICU-Eskalation reserviert (kein Vorgriff auf
  Formatkompatibilität).
- **Fallback-Kette**: aktive Sprache → `en` → Key selbst (plus `warn`-Log
  `folio::i18n` mit Sprache + Key, **dedupliziert pro
  `(catalogTag, key, failureKind)` und Prozess** — Status-/Stream-Updates
  dürfen denselben Defekt nicht tausendfach loggen). Fehlende Keys dürfen
  die UI nie brechen.

### Registry & Build-Script (Vertrag)

- **Reine Generatorfunktion** `generate_registry(dir)` nimmt ein
  Katalogverzeichnis als Parameter; `build.rs` ruft sie ausschließlich für
  `src-tauri/locales/` auf und schreibt den Registry-Code nach
  `$OUT_DIR/i18n_registry.rs` (Einbindung via
  `include!(concat!(env!("OUT_DIR"), …))`). Reihenfolge in `build.rs`:
  bestehende Git-Env-Logik → Registry-Codegen → `tauri_build::build()`.
- **Rebuild-Trigger**: `cargo:rerun-if-changed=locales` (Directory-Watch,
  damit neue Dateien triggern) **und** pro gefundener Datei
  `cargo:rerun-if-changed=locales/<tag>.json`.
- **Build-time fail closed, runtime fail open**: Der Generator sortiert
  Dateien deterministisch und **bricht den Build ab** bei: unparsebarem
  JSON, ungültigem/dupliziertem kanonischem Tag (case-insensitiv eindeutig),
  `@meta.tag` ≠ Dateistamm, unvollständigem `@meta`, fehlendem `en`,
  Schema-Verstößen (inkl. Key-Sortierung, doppelte Keys — geprüft mit
  order- und duplicate-erhaltendem Parser/Visitor, nicht über eine
  sortierende Map), Plural-Verstößen (s. u.). Der Laufzeit-Fallback „leerer
  Katalog + Key-Fallback" gilt nur für theoretisch kaputte **eingebettete**
  Daten, nie als Ersatz für Build-Validierung.
- **Dritter Test-Katalog**: liegt als Fixture unter
  `src-tauri/tests/fixtures/locales/fr.json` (echter Tag aus dem
  Pluralregelwerk, kein Kunst-Tag) — **außerhalb** des Produktions-Globs.
  Der Erweiterbarkeits-Test (s. Ziel) nutzt den Generator mit
  Temp-Verzeichnis. Die Fixture erscheint nie in `i18n_catalog.languages`
  eines Produkt-Builds oder im Settings-Dropdown.
- Optional (Nice-to-have): Snapshot-Test nur für Registry-Reihenfolge +
  Metadaten (nicht die Volltexte).

### Key-Naming-Konvention (verbindlich)

Schema: **`bereich.komponente.element[.qualifier]`** — 3 Ebenen Regelfall,
4–5 erlaubt bei stabiler fachlicher Hierarchie
(`settings.ai.providers.empty`). Segmente in camelCase.

- **Alle Key-Segmente sind englisch** (User-Vorgabe): `vault.contextMenu.
  moveToTrash`, nicht `vault.kontextMenue.papierkorb`. Keine
  Transliterationen deutscher Wörter.
- **Kanonische Top-Level-Namespaces** (abschließend, Erweiterung nur per
  Spec-Änderung): `menu`, `toolbar`, `statusBar`, `vault`, `search`, `tabs`,
  `find`, `settings`, `dialogs`, `export`, `theme`, `ai`, `cheatsheet`,
  `editor`, `view`, `errors`. **Kein `common`-Namespace** — generische
  Sammel-Keys sind genau das Anti-Pattern, das die Rollen-Regel verhindert
  (einzige Ausnahme: `dialogs.common.*`).
- **`qualifier`** = Rollen-Suffix. Kern-Vokabular: `.title`, `.label`,
  `.tooltip`, `.placeholder`, `.hint`, `.confirm`, `.ariaLabel`, `.name`,
  `.description`, `.status`, `.empty`, `.action`. Neue Rollen erlaubt, aber
  projekteinheitlich (kein `.tip` neben `.tooltip`).
- **Fehlermeldungen**: `errors.<modul>.<fall>`.
- **Keys benennen die Funktion, nicht den Wortlaut.** Textkorrekturen ändern
  nie den Key.
- **Keine Wiederverwendung über Rollen hinweg** (Ausnahme
  `dialogs.common.*`: `ok`, `cancel`, `save`, `discard`, `close` — nur für
  echte Standard-Dialog-Buttons, nicht für Toolbar-ARIA oder Menü-Items).
- **Keine dynamisch zusammengesetzten Keys** (`t('a.' + x)` verboten);
  ID-basierte Auswahl (Built-in-Themes, KI-Actions) läuft über eine
  deklarative Key-Registry, die der Referenz-Test kennt.
- Kataloge alphabetisch sortiert, keine doppelten Keys.
- **Normative Beispiele**: `menu.file.save`, `toolbar.bold.tooltip`,
  `vault.contextMenu.openNewTab`, `search.status.hitsPart`,
  `settings.language.hint`, `dialogs.unsaved.confirm`,
  `theme.builtin.business.description`, `ai.actions.summarize.name`,
  `errors.export.writeFailed`.

### Sprach-Auflösung: Tag-Vertrag & Resolver

- Das `language`-Setting speichert **`"system"` oder einen kanonischen
  BCP-47-String-Tag** (das geschlossene `Language`-Enum und der TS-Union-Type
  entfallen; die Settings-Optionen kommen aus der Registry).
- **Patch-Validierung** (gemeinsamer Tauri-/Automation-Pfad): akzeptiert nur
  `"system"` oder einen exakten Registry-Tag; unbekannt/ungültig wird **vor**
  jeder Mutation abgelehnt — Tauri: üblicher String-Fehler; Automation:
  **HTTP 400** mit Diagnosetext (kein Error-Code-System; stabilisiert nur die
  Statusklasse). `docs/automation-contract.md` wird entsprechend ergänzt
  (Breaking: bisherige Enum-Werte `de`/`en` bleiben als Tags gültig —
  Kompatibilitätstest mit heutigen `{"language":"de"}`-Dateien).
- **Bereits gespeicherte unbekannte Tags** bleiben unverändert erhalten,
  lösen aber `{catalogTag: "en", formatLocale: en.@meta.locale}` auf. Das
  Settings-Select zeigt dafür eine deaktivierte temporäre Option + übersetzten
  Fallback-Hinweis (nie ein leeres Select).
- **Resolver liefert immer getrennt `catalogTag` + `formatLocale`**:
  - explizites Setting oder `FOLIO_LANG` mit Registry-Tag →
    `formatLocale = @meta.locale` des Katalogs;
  - `system` → Katalog per OS-Tag-Match (erst exakt, dann Sprach-Subtag),
    `formatLocale` = **voller OS-Tag** (Beispiel: `de-CH`-System → Katalog
    `de`, Zahlenformat `de-CH`);
  - Fallback → `en` + `en.@meta.locale`.
  `FOLIO_LANG` folgt derselben Match-Regel wie `system` (exakt, dann
  Subtag); ungültiger Wert → `warn` + normaler Pfad. **`formatLocale` beim
  Override**: konsistent zur System-Regel — matcht `FOLIO_LANG` nur per
  Sprach-Subtag (z. B. `de-CH` → Katalog `de`), bleibt der volle
  Override-Wert als `formatLocale` erhalten; nur ein exakter Registry-Tag
  verwendet `@meta.locale`. Auflösung genau einmal pro Prozess
  (Neustart-Semantik).

### Settings-Migration (Zustandsmaschine, verbindlich)

Vorlauf auf dem **Raw-JSON**, vor der typisierten Deserialisierung —
`persist::load_json` kollabiert heute alle Fehler auf `Default`, das reicht
nicht mehr; es gibt einen neuen Raw-Load-Pfad für `settings.json`:

1. `settings.json` wird genau einmal als Bytes gelesen. **Getrennte Fälle**:
   `NotFound` / sonstiger I/O-Fehler / Syntaxfehler / gültiges Nicht-Objekt /
   gültiges Objekt.
2. Gültiges Objekt **ohne** `language` → `"de"` injizieren, atomar
   persistieren (Bestandsnutzer bleibt deutsch).
3. Gültiges Objekt **mit** `language` → Wert wird **unabhängig von der
   übrigen typisierten Deserialisierung extrahiert**. Schlägt später ein
   anderes Feld fehl (Whole-Object-Recovery à la heutiger
   `logLevel`-Fallback-Test), darf das die extrahierte Sprache NICHT auf den
   Default zurückwerfen — eigener Regressionstest
   (`{"language":"de","logLevel":"silly"}` bleibt de).
4. Vorhandene, aber unlesbare/korrupte Datei → effektiv `de` für diesen
   Boot, `warn`, Datei NICHT überschreiben. **Die bloße Existenz zählt als
   Bestandsnachweis** (nie `system`). **Gleiches Verhalten** für die beiden
   Defekt-Varianten „gültiges JSON, aber kein Objekt" und „Objekt mit
   nicht-stringförmigem `language`" (null, Zahl, Objekt): effektiv `de`,
   `warn`, nicht überschreiben — gemeinsamer Regressionstest.
5. Fehlende Datei → `system` **nur bei Neuinstallation**: Config-Verzeichnis
   (nach der bestehenden `folio-rs`-Migration) existiert nicht oder ist leer.
   **Jedes** Folio-Artefakt (`workspace.json`, `panel-state.json`,
   `theme.json`, `ai.json`, `auth.json`, `ai-catalog.json`, `themes/`,
   `prompts/`) pinnt konservativ `de`. Dokumentierte Grenze: frühere Nutzung
   gänzlich ohne persistiertes Artefakt ist nicht erkennbar.
6. Tests: alle Fälle + korrupte Datei allein, nur `theme.json`, nur
   `ai.json`, gültige Sprache + ungültiges anderes Feld, wiederholtes Laden
   ohne weitere Schreibmutation (Idempotenz).

### Rust-Boot-Sequenz (ein Owner)

`lib.rs::run`: (1) Settings genau **einmal** raw laden + migrieren →
(2) `FOLIO_LANG` validieren, Sprache genau einmal auflösen → (3) Kataloge
initialisieren, i18n-State **explizit setzen** → (4) erst danach Tauri-Menü
bauen → (5) denselben `SettingsService` in `AppState` übernehmen (die
heutigen drei unabhängigen Loads in `lib.rs` [Logging, Menü] und `state.rs`
werden konsolidiert; Logging-Init darf vor der Migration keinen eigenen
Settings-Load mehr machen, sondern bekommt den geladenen Stand).

### Rust-Seite (`src-tauri/src/i18n.rs`)

- **Kern instanziierbar, `OnceLock` nur Fassade**: `Translator` /
  `CatalogRegistry` sind reine, instanziierbare Objekte; Resolver-, Merge-,
  Plural- und `MenuLabels`-Tests arbeiten mit lokalen Instanzen (keine
  Prozess-ENV-/Global-Mutation in Tests). Der produktive
  `OnceLock<Translator>` ist die nach dem Boot gesetzte `t()`-Fassade;
  `t()` vor Init = Debug-Assert. Genau ein Test prüft die Fassade selbst.
- API: `t(key)`, `t_args(key, &[(name, value)])`,
  `t_plural(key, count, &[…])` — Semantik unter „Plural & Komposition".
- **`MenuLabels`-Speichermodell (festgelegt)**: Felder werden `String`,
  Struct verliert `Copy`; `labels()` liefert `&'static MenuLabels` aus einem
  beim Boot einmal gebauten `OnceLock<MenuLabels>` (kein Leak, kein
  Call-Site-Umbau auf Ownership — Aufrufer borrowen). Die
  `const fn de()/en()`-Blöcke und die drei `labels("de")`-Hardcodes
  entfallen. Rust-Integrationstest baut de- und en-Sets über lokale
  `Translator`-Instanzen (deckt native Menülabels ab, die E2E nicht lesen
  kann).
- **Fehlermeldungen — Grenze UI vs. Diagnose**: UI-Fehler bleiben
  `Result<T, String>`; erklärender Rahmen via `t()`/`t_args()`, technische
  Details unübersetzt als `{detail}`. **Automation-Fehlertexte sind
  Diagnose, kein Vertrag** (Contract-Doku verbietet Asserts auf Wortlaut;
  HTTP-Status + Erfolgs-Felder bleiben Vertrag). Kein Error-Code-System in
  V1. Für geteilte `thiserror`-Enums gilt in I4b diese **Entscheidungstabelle**
  (in I4b zu vervollständigen, Muster verbindlich):

  | Enum | UI-sichtbar? | Automation teilt Display? | Entscheidung |
  | --- | --- | --- | --- |
  | `SearchError` | ja | ja (`handlers/search.rs`) | Display übersetzen (Automation-Text = Diagnose) |
  | `AiConfigError` | ja | indirekt (`POST /settings` nutzt einen eigenen Settings-Pfad) | Display bleibt Diagnose; in `commands/ai.rs::mutate_config` mit `errors.ai.configUpdateFailed` wrappen |
  | `CatalogError` | ja | nein | Display bleibt Diagnose; in `ai_catalog_refresh` mit `errors.ai.catalogRefreshFailed` wrappen |
  | `AuthError` | ja | nein | Display bleibt Diagnose; in `ai_auth_set`/`ai_auth_remove` mit `errors.ai.authUpdateFailed` wrappen |
  | `ChatError` | ja | nein | Display bleibt Provider-/Transportdiagnose; an allen Command-Rändern mit `errors.ai.requestFailed` (bzw. dem spezifischen Response-Key) wrappen |

  `SearchError::localized(&Translator)` ist der lokale Testpfad; sein
  produktives `Display` verwendet die Prozess-Übersetzung. Die vier KI-Enums
  behalten absichtlich ihre `thiserror`-Diagnosetexte, damit keine bereits
  lokalisierte Erklärung als technisches `{detail}` erneut übersetzt wird.

- Eingebettete Inhalte als Katalog-Keys: Built-in-Theme-Manifeste,
  Built-in-KI-Action-Metadaten, Linux-Icon-Dialog, Datei-Dialog-Titel/-Filter.
  User-Content bleibt unangetastet.
- **Export-Surface** (I4a): Cover-/Header-Texte der Built-in-Layouts über
  zusätzliche TemplateContext-Werte; `<html lang>` aus aufgelöster Sprache;
  Default-Titel „Dokument" und Datums-Fallback lokalisiert
  (`formatLocale`). User-Frontmatter/Custom-Templates unverändert. Je ein
  en-Exporttest HTML + PDF (Covertext, `<html lang>`, Titel, Datum).

### Plural & Komposition (normativ, identisch für Rust und TS)

- **Pluralregelwerk `plural_rules(tag)`** (Rust; Frontend nutzt
  `Intl.PluralRules`): deckt ab V1 **explizit diese Sprachen** ab (I1a-
  Umfang): de, en, es, fr, it, pt, ru, pl, ja, zh, ko — Kategorien inkl.
  `few`/`many`, wo die Sprache sie hat. Ein Katalog-Tag ohne hinterlegte
  Regel = Build-Fehler des Generators (das ist die eine dokumentierte
  Ausnahme vom „nur eine Katalogdatei"-Kriterium).
- `tPlural(key, count, args)` (TS) / `t_plural(key, count, args)` (Rust):
  `count` ist endlicher, nichtnegativer Integer und **alleiniger**
  Kategorie-Selektor. Beide APIs **injizieren den reservierten Platzhalter
  `{count}`** (Dezimaldarstellung); `args` darf `count` nicht überschreiben
  (Fehler). Lokalisiert gruppierte Darstellung läuft über einen expliziten
  eigenen Platzhalter (z. B. `{formattedCount}` via `fmtNumber`).
- **Pflicht-Branches**: jedes Plural-Objekt hat `other` und alle für
  nichtnegative Integer erreichbaren Kategorien seiner Sprache (laut
  Regelwerk). Verstoß = Build-Fehler (Generator). Ausgewählter fehlender
  Branch zur Laufzeit = `warn` + `other`-Fallback.
- **Plural-Objekte sind beim Sprachen-Merge atomar**: Key-Fallback ist
  aktive Sprache → en → Key; Branches verschiedener Sprachen werden nie
  tief gemischt. Werttyp-Parität (String vs. Objekt) über alle Sprachen ist
  Pflicht (Generator).
- **Mehrere unabhängige Zählgrößen** → eigenständig pluralisierte Segmente
  + Kompositions-Key. Normatives Beispiel (beide Seiten):

  ```jsonc
  // de.json
  "search.status.done": "{hitsPart} in {filesPart} ({ms} ms)",
  "search.status.hitsPart":  { "one": "1 Treffer", "other": "{count} Treffer" },
  "search.status.filesPart": { "one": "1 Datei",   "other": "{count} Dateien" }
  ```

  ```ts
  // TS
  t('search.status.done', {
    hitsPart:  tPlural('search.status.hitsPart', hits, {}),
    filesPart: tPlural('search.status.filesPart', files, {}),
    ms: fmtNumber(elapsedMs),
  })
  ```

  ```rust
  // Rust
  t_args("search.status.done", &[
      ("hitsPart",  &t_plural("search.status.hitsPart", hits, &[])),
      ("filesPart", &t_plural("search.status.filesPart", files, &[])),
      ("ms",        &ms.to_string()),
  ])
  ```

  Betroffene Stellen listet die I0-Map vollständig (Statuszeile
  Wörter/Zeichen/Zeilen, Such-Status × 3, „Weitere Layouts (n)", „N große
  Datei(en) übersprungen"). Tests: 0/1/2-Kombinationen in **allen**
  unabhängigen Zählvariablen (de + en), `{count}`-Injektion, verbotene
  Überschreibung, fehlendes `other`, fehlende erreichbare Kategorie.
- Eskalationsregel: trägt die Segment-Komposition in einer späteren Sprache
  grammatisch nicht, wird für genau diese Keys auf ICU migriert (bis dahin:
  `@format`-Objekte sind ungültig, s. Kataloge).
- **`t()` liefert reinen Text, keine HTML-Sicherheit.** Interpolierte
  User-Werte nie via `innerHTML`; HTML-bauende Stellen komponieren
  DOM-Nodes + `textContent`.

### Frontend-Bootstrap (Zustandsmaschine, verbindlich)

`main.ts` bekommt `async bootstrap()` mit drei Phasen:

1. **`booting`**: Vorab-Adapter für **alle** vor UI-Ready möglichen
   Backend→Frontend-Events registrieren (die `listen`-Promises werden
   abgewartet); eingehende Events werden gequeut. I1b enthält die aus den
   realen `listen`-Stellen erzeugte **Ereignisliste** (mindestens:
   CLI/Single-Instance [`cli:open`], Menü, Navigation/Panel/Vault,
   Automation [`automation:*` aus `initAutomationEvents`], Document/Tabs).
   Queue mit definierter Maximalgröße, Overflow-Log, Fehlerfortsetzung.
   `cli_pending_open` ist **kein** Event, sondern ein Frontend-invoked
   Command: er wird erst nach Installation der Document-/Tab-Handler
   abgefragt und sein Ergebnis läuft über denselben Dispatcher.
2. **`i18nReady`**: `initI18n()` (ein `i18n_catalog`-Invoke) gelaufen ODER
   Degradationsentscheidung getroffen; `applyStaticTranslations()` läuft.
   **Die Queue wird hier noch NICHT geleert** — die Zielhandler existieren
   erst nach den Modul-Inits.
3. **`uiReady`**: alle heutigen `init*()`-Aufrufe + Cross-Module-Listener
   sind installiert; Queue in Ankunftsreihenfolge über die echten Handler
   drainen. Erst nach erfolgreichem Drain ruft das Frontend den
   **idempotenten Command `frontend_ready`** — auch im Degradationspfad.

Weitere Regeln:

- **Kein `t()` in Module-Level-Initializern** — übersetzbare
  Modul-Konstanten (Cheatsheet-Zeilen, Menü-Einträge) werden
  Factories/Getter nach `initI18n()`; vitest-Check verhindert Regressionen.
- **Degradation**: schlägt `initI18n()` fehl, unterbleibt
  `applyStaticTranslations()` vollständig (deutsche HTML-Platzhalter bleiben;
  nie rohe Keys in den DOM). `t()` fällt auf den Key zurück; jsdom-Tests
  seeden einen Test-Katalog.
- `initSettingsDialog` (Sprach-Select aus Registry) läuft nach `i18nReady`
  bzw. füllt lazy.

### Automation-Ready-Gate (verbindlich)

- Rust hält `AtomicBool` + `Notify`, gesetzt von `frontend_ready`.
- **`/state` bleibt ungesperrt** (Healthcheck) und liefert zusätzlich
  `frontendReady: bool` und `lang` (aufgelöster catalogTag).
- **Warten mit eigenem Startup-Timeout**: alle Routen, die ein
  Frontend-Event emittieren, eine Frontend-Antwort/ACK erwarten oder einen
  Screenshot brauchen (u. a. `/dom`, `/click`, `/eval`, `/find/*`,
  `/sync/render`, `/menu/click`, `/screenshot`). **Nicht warten** (explizite
  Liste in I1b): reine Backend-Leseendpunkte (`/state`, `/tabs`,
  `/console/errors`, `/settings` GET, `/search`, …).
- Der E2E-Runner pollt `frontendReady == true` statt Readiness über einen
  potenziell verlorenen `/dom`-Roundtrip zu erzeugen.

### Statischer DOM-Applier

- Attribute: `data-i18n` (textContent), `data-i18n-title`,
  `data-i18n-placeholder`, `data-i18n-aria-label` — exakte Abbildung aufs
  Zielattribut.
- `data-i18n` **nur auf Leaf-Elementen**; gemischte Knoten (Checkbox+Text,
  Icon+Text) bekommen `<span data-i18n>`-Wrapper — die I0-Map führt pro
  HTML-Fundstelle eine **Wrapper-Spalte** (ja/nein).
- DOM-Test: Applier entfernt nie Element-Kinder. Markup-Test: alle
  `data-i18n-*`-Werte existieren im Katalog, keine Nicht-Leaf-Verstöße.
- Applier setzt `document.documentElement.lang`.
- **HTML-Shell behält deutsche Texte als Platzhalter**; Applier überschreibt
  **immer** (auch bei de) — Katalog ist Single Source of Truth, veraltete
  HTML-Texte fallen im de-Betrieb sofort auf. Kurzer de-Flash bei ≠de-Boot in
  V1 akzeptiert (kein visibility-Gate).

### Locale-Formatierung (`app/i18n/format.ts`)

`fmtNumber(value, options?)`, `fmtDate(value, options?)`, `fmtBytes(bytes)`,
gemeinsamer `Intl.Collator` (`compareStrings`), `normalizeForSearch`
(locale-bewusstes Lowercasing) — alle auf Basis `formatLocale`.
Grep-Nachweis in I3b: `toLocaleString`, `localeCompare`,
`toLocaleLowerCase`, `Intl.DateTimeFormat`, `toFixed` (user-sichtbar),
locale-loses `sort()` auf Anzeige-Listen.

### Monaco (V1-Entscheidung)

Native Monaco-Kontextmenüs auf **allen** Surfaces aus (Code-/Diff-View heute
schon; Haupteditor + Theme-Editor ziehen nach). Monaco-interne Strings
(ARIA, interne Widgets) = Drittanbieter-Surface außerhalb des
Vollständigkeitsziels. Editor-Sprachpicker: Monacos technische Sprachnamen
(Eigennamen) unverändert; nur „Plain Text"-Eintrag und die Picker-UI aus dem
Katalog.

### Settings-UI

Sprach-Select aus der Registry (`languages` aus `i18n_catalog`): „System"
(übersetzt) + Sprachen in Eigenbezeichnung. Unbekannter gespeicherter Tag →
deaktivierte temporäre Option + Hinweis (s. Tag-Vertrag). Neustart-Hinweis
bleibt. Kein hartkodiertes Options-HTML, kein TS-Union-Type.

### E2E

- **de-Pin ab I1b**: `FOLIO_LANG=de` in **beiden** Startpfaden
  (`scripts/run-e2e.sh` — startet Folio selbst! — und `run.py`); Runner
  assertet `lang == "de"` aus `/state` vor Baseline-Vergleichen.
- `33_ai_settings`-String-Asserts → sprachneutrale Signale (I6).
- **en-Nachweis = separater Prozesslauf** (`run-e2e.sh --lang-smoke`):
  Boot mit `FOLIO_LANG=en`, DOM-Checks (Toolbar/Statusleiste/Settings),
  `console/errors` leer, kein Baseline-Vergleich. Native Menülabels über den
  `MenuLabels`-Rust-Test.

### Qualitäts-Gates

- **Katalog-/Generator-Gate** (Build + `cargo test`): Key-Mengen-Parität
  aller Sprachen; Platzhalter-Parität pro Key (in jedem Pluralzweig);
  Werttyp-Parität; Pflicht-Branches (`other` + erreichbare Kategorien);
  erlaubte CLDR-Kategorien; `@meta` vollständig; Sortierung; keine
  Duplikate; `@format`-Ablehnung.
- **Referenz-Test** (beide Richtungen): erfasst `t`, `tPlural`, `t_args`,
  `t_plural`, `data-i18n-*` und deklarative Registry-Einträge.
  **Erstes Key-Argument muss String-Literal sein** (auch mehrzeilige
  Aufrufe); **Aliasing der i18n-Funktionen ist verboten** (Konvention +
  Test). Scan-Scope: `src-tauri/src/**/*.rs`, `src-tauri/web/**/*.ts`,
  `src-tauri/dist/index.html`. Fehlender Key = Fehler ab I1c.
  **Dead-Key-Prüfung ist bis I6 soft** (Warnung/Report), ab I6 hart —
  sonst blockiert jeder Zwischenstand mit noch nicht extrahierten Bereichen.
  Allowlist-Einträge (Registry-Keys wie `theme.builtin.<id>.*`) tragen
  Begründung und müssen selbst referenziert sein.
- Frontend-vitest: `t()`/`tPlural`/Format-Helfer/Applier (inkl.
  Kinder-Erhalt, Degradation, Bootstrap-Phasen mit gemockter Queue).

## Etappen & Checkliste

### Etappe I0 — Surface- und Key-Map (läuft; Abnahme-Kriterien verbindlich)

Die Map ist erst abgenommen, wenn: (a) nur kanonische Namespaces (kein
`common`), (b) englische Funktions-Keys nach Konvention, (c) keine
Test-/Log-/False-Positive-Einträge, (d) Wrapper-Spalte für alle
HTML-Fundstellen, (e) vollständige Plural-/Kompositions- und
Locale-Operations-Listen. **Ohne I0-Abnahme startet I1a nicht** (die Keys
sind die Arbeitsgrundlage aller Etappen — Wegwerf-Keys in I2 wären
DOM-/Katalog-/Referenz-Test-Umbau im Quadrat).

### Etappe I1a — Rust-Fundament (TDD)

- [x] `locales/de.json`/`en.json` mit `@meta` + `menu.*`
- [x] Generator + `build.rs`-Integration (Vertrag oben: rerun-if-changed,
      fail-closed, OUT_DIR)
- [x] `i18n.rs`: `Translator`/`CatalogRegistry` instanziierbar, `OnceLock`-
      Fassade, `t`/`t_args`/`t_plural` (inkl. `{count}`-Injektion),
      Pluralregelwerk (Batch-Sprachen), Fallback/Merge (atomare
      Plural-Objekte)
- [x] Resolver (`catalogTag`+`formatLocale`, `FOLIO_LANG`, `system`,
      Subtag-Match) + Settings-Migration (Zustandsmaschine, alle Tests)
- [x] `language` als String-Tag + Patch-Validierung (Tauri + Automation-400)
- [x] Boot-Owner-Sequenz in `lib.rs` (ein Settings-Load)
- [x] `menu/strings.rs`: `MenuLabels` mit `String`-Feldern aus dem Katalog,
      Hardcodes weg, de/en-Integrationstest
- [x] Erweiterbarkeits-Test mit `fr`-Fixture (Temp-Verzeichnis-Generator)
- [x] Katalog-/Generator-Gate aktiv
- [x] Gates: cargo test/clippy/fmt (Frontend unberührt)

### Etappe I1b — Frontend-Fundament + Ready-Gate

- [x] Command `i18n_catalog` (`tag`, `locale`, `languages`, merged `strings`)
- [x] `app/i18n/`: `initI18n`, `t`, `tPlural`, `format.ts`, Applier
      (Leaf-Regel, Attribut-Mapping, `documentElement.lang`)
- [x] `bootstrap()`-Zustandsmaschine (booting → i18nReady → uiReady) +
      Ereignisliste + Queue + Drain + `frontend_ready`
- [x] Automation-Ready-Gate (AtomicBool/Notify, Routen-Matrix wartend/nicht
      wartend, Startup-Timeouts), `/state` +`frontendReady`+`lang`
- [x] Modul-Konstanten-Factories (Cheatsheet & Co.) + vitest-Check
- [x] vitest komplett; Gates inkl. npm build
- [x] **`FOLIO_LANG=de`-Pin in `run-e2e.sh` UND `run.py` + Runner-Assert auf
      `/state.lang`** (vorgezogen aus I1c: das isolierte Testprofil ist leer
      → Migration ergäbe `system`, und auf nichtdeutscher/`C`-Locale bräche
      der Baseline-Lauf englisch)
- [x] E2E-Voll-Lauf grün (de-gepinnt)

### Etappe I1c — Referenz-Gate + Runner-Readiness

- [x] Referenz-Test (Scan-Scope, Literal-Regel, Alias-Verbot, Allowlist;
      Dead-Keys soft)
- [x] Runner-Readiness auf `frontendReady`-Poll umgestellt
- [x] E2E-Voll-Lauf grün

### Etappe I2 — HTML-Shell + Settings-UI

- [x] `dist/index.html`: alle statischen Strings laut I0-Map mit
      `data-i18n-*` (Wrapper-Spalte beachten), deutsche Platzhalter bleiben
- [x] Settings-Sprachauswahl aus Registry (inkl. Unknown-Tag-Option)
- [x] Markup-Test
- [x] Sichtprüfung de/en (Screenshots), E2E-Voll-Lauf

### Etappe I3a — Frontend dynamisch: State/Vault/Find/Tabs/View/Editor-Shell

- [x] Strings laut I0-Map auf `t()`/`tPlural()` (Statuszeile, Such-Status,
      Kontextmenüs, Tab-Tooltips, Image-View-Fehler, Code-Copy-ARIA,
      Mode-Tooltips, Cheatsheet-Factory, `web/editor/`-Surfaces)
- [x] Monaco-Kontextmenü Haupteditor/Theme-Editor aus
- [x] Plural-Kompositions-Tests (0/1/2-Matrix de/en)
- [x] Gates + E2E-Voll-Lauf

### Etappe I3b — Frontend dynamisch: Dialoge/Settings/AI/Theme/Export-UI

- [x] Strings laut I0-Map (translate-, ai-actions-, theme-, export-,
      settings-Dialoge, ai-chat-test)
- [x] Locale-Helfer flächendeckend + Grep-Nachweis (Liste oben)
- [x] Gates + E2E-Voll-Lauf

*(I3a und I3b strikt sequentiell — beide ändern dieselben Katalogdateien.)*

### Etappe I4a — Backend: native Dialoge, Built-ins, Export

- [x] Datei-Dialog-Titel/-Filter, Linux-Icon-Dialog
- [x] Built-in-Theme-Manifeste + KI-Action-Metadaten (deklarative
      Registry-Keys)
- [x] Export: TemplateContext-Cover-Werte, `<html lang>`, Default-Titel,
      Datums-Fallback; en-Exporttests HTML+PDF
- [x] Gates + E2E-Voll-Lauf

### Etappe I4b — Backend: Fehlermeldungen

- [x] UI-Fehlertexte auf `t()`/`t_args()` mit `{detail}`;
      `thiserror`-Entscheidungstabelle vervollständigt und umgesetzt
- [x] automation-contract.md: Fehlertext-Diagnose-Regel, 400-Statusklasse,
      `lang`/`frontendReady`-Felder
- [x] Gates + E2E-Voll-Lauf

### Etappe I5 — KI-Systemprompts (klein, isoliert)

- [x] Prompts in `ai/actions.rs`/`theme/author.rs` englisch + „respond in
      the language of the document" (Prompts sind KEINE Katalogwerte)
- [x] E2E 34/45: Semantik- statt Wortlaut-Asserts

### Etappe I6 — E2E-Härtung + Abschluss

- [x] `33_ai_settings` sprachneutral
- [x] `--lang-smoke`-Modus (en-Boot)
- [x] Dead-Key-Gate hart schalten
- [x] Doku: CLAUDE.md-Konvention, README, automation-contract.md final,
      Arbeitsdateien (Inventar, Reviews, Surface-Map) archivieren/löschen,
      TODO-Folgepunkte

## Risiken / bewusste Entscheidungen

- **Extraktion vollständig?** I0-Map (abgenommen) + Referenz-Test +
  „Applier überschreibt immer" + Kreuz-Review pro Etappe mit Auftrag
  „fehlende Extraktionen suchen".
- **Kein Live-Sprachwechsel** in V1; Unterbau macht Live-Switch später zu
  Re-Apply + Menü-Rebuild.
- **Kein ICU** — Segment-Komposition + reservierter (in V1 ungültiger)
  `@format`-Namensraum.
- **Fehlertexte übersetzt statt Error-Codes**; Automation-Text = Diagnose
  (von beiden Reviewern als tragfähig bestätigt).
- **Monaco-interne Strings out of scope**; native Kontextmenüs aus.
- **de-Flash bei ≠de-Boot** akzeptiert; Beobachtung in I2.
- **RTL out of scope.**
- Etappen **sequentiell** (Katalogdateien sind gemeinsamer Hotspot — keine
  Parallel-Läufe auf `locales/*.json`).

## Folgepunkte (nach V1, TODO.md)

- **Sprach-Batch 2**: es, fr, pt-BR, it, zh-Hans, ja (opt. ru, pl, ko) — KI-
  vorübersetzt, menschlich durchgesehen; echte Nur-Katalog-Erweiterung.
- Live-Sprachwechsel; externe Sprachpakete (`<config>/folio/lang/`).
- Pseudo-Locale (Layout-/Extraktionsprobe); generierte typisierte
  Key-Surface; Translator-Notes; Registry-Snapshot-Test (falls nicht schon
  in I1a); Flicker-Gate falls nötig.

## Verifikation pro Etappe

Standard-Gates + E2E-Voll-Lauf ab I1b. Katalog-/Generator-Gate ab I1a,
Referenz-Gate ab I1c (Dead-Keys hart ab I6). Abnahme je Etappe:
Orchestrator-Diff-Review gegen diese Spec.

## Vorgehen / Delegation

- Plan-Reviews: codex (2×) + grok (Implementierer-Sicht) — erfolgt; v3
  arbeitet beide ein. Freigabe-Bestätigung beider Reviewer vor I1a.
- I0-Nacharbeit: agy (mechanische Key-Map-Korrektur nach Konvention),
  Abnahme durch Orchestrator.
- Implementierung I1a–I6: grok (grok-4.5), eine Session, Etappen einzeln
  abgenommen; I1a nach TDD-Muster.
- Kreuz-Review pro Etappe: codex + agy parallel; Konsolidierung durch den
  Orchestrator; Fixes in der offenen grok-Session.

## Konsolidierung der Reviews (Orchestrator, 2026-07-13)

**Runde 1 (codex, v1→v2):** alle 9 Blocker + E1–E7 übernommen; E3 bewusst
abgeschwächt (kein Error-Code-System — von codex in Runde 2 explizit als
tragfähig bestätigt).

**Runde 2 (codex v2 + grok, →v3):** alle 5 codex-Blocker übernommen
(Registry-/Fixture-Trennung + Build-Vertrag; Migrations-Zustandsmaschine mit
Sprach-Extraktion vor typisiertem Load + erweitertes Artefakt-Kriterium;
Tag-/Patch-/formatLocale-Vertrag; Plural-`{count}`/-Branch-/-Merge-Vertrag;
dreiphasiger Bootstrap mit uiReady-Drain + Automation-Routen-Matrix). Alle 5
grok-Blocker übernommen (I0-Abnahmekriterien inkl. englischer Keys;
`MenuLabels`-Modell festgelegt [`String`-Felder + `OnceLock`-Referenz —
Synthese aus grok-Empfehlung und codex-Testbarkeits-Einwand];
Ready-Handshake konkretisiert; `fr`-Test-Fixture außerhalb des Globs;
I1→I1a/b/c). codex-Empfehlungen 1–4 und grok K1–K7 eingearbeitet
(Dead-Keys soft bis I6, Referenz-Test-Literal-Regel, `@format`-Ablehnung,
`thiserror`-Tabelle, Wrapper-Spalte, Build-Script-Details). Nice-to-haves →
Folgepunkte bzw. optional (Log-Dedup wurde normativ übernommen, da billig
und Stream-Update-relevant).
