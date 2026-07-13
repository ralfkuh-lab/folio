# Plan-Feedback i18n (Implementierer-Sicht) — grok

Stand: 2026-07-13. Gelesen: `docs/spec-i18n.md` (v2), `docs/i18n-surface-map.md`
(I0, Stand „wird nachkorrigiert“), `CLAUDE.md`, plus der reale Code unter
`src-tauri/` (Build, Boot, Settings, Menü, Frontend-Bootstrap, Automation,
E2E-Runner). **Keine Implementierung, keine Code-Änderungen.**

Perspektive: ich soll I1–I6 anschließend selbst umsetzen. Bewertung: Kann ich
jede Etappe ohne gefährliches Raten bauen? Wo blockiert die Spec mich heute?

---

## Blocker aus Implementierer-Sicht

### B1 — I0-Key-Map ist als Arbeitsgrundlage unbrauchbar (hart)

Die Spec bindet I2–I4 explizit an die I0-Map als Checkliste
(`spec-i18n.md:311–320`, `:359–390`). Der aktuelle Stand von
`docs/i18n-surface-map.md` verletzt die in v2 **verbindliche** Naming-Konvention
(`spec-i18n.md:83–113`) massiv:

| Befund | Beleg |
| --- | --- |
| Unzulässiger Top-Level-Namespace `common` (~216 Keys) | Spec-Liste abschließend ohne `common` (`spec-i18n.md:89–92`); Map z. B. `common.arbeitsbereich` (`i18n-surface-map.md:57`), `common.allgemein` (`:81`) |
| Keys am Wortlaut statt an der Funktion | `common.sprachaenderungWirdBeimNchsten` (`:90`), `common.nutztMonacosFormatDocument` (`:101`) — Spec: „Keys benennen die Funktion, nicht den Wortlaut“ (`spec-i18n.md:100–101`) |
| Rollen-Kreuzung / Wiederverwendung über Surfaces | Toolbar-Speichern-`aria-label` → `dialogs.common.save` (`i18n-surface-map.md:35`); Menü „Bearbeiten“ → `settings.mode.optionEdit` (`:667`); Speichern-Menü → `dialogs.common.save` (`:660`) — Spec: „Keine Wiederverwendung über Rollen hinweg“ (`spec-i18n.md:102–104`) |
| Test-/Fixture-/Log-Strings als Surface | z. B. `ai.mlaut` / `Ä😀x` (`:342–345`), Search-Fixture `äß😀 needle` (`:706–708`), Logging (`:651–652`) — Spec: Logs out of scope (`spec-i18n.md:29–30`) |
| False-Positives und Technik-IDs | Theme-ID `standard` als Key (`:574–576`, `:790–795`); Markup-Schnipsel `>Keine Einträge</li>` (`:846`) |

**Konsequenz:** Sobald ich in I1 den `menu.*`-Katalog und den Referenz-Test
anlege, ist unklar, welche Keys kanonisch sind. In I2 würde ich hunderte
`data-i18n`-Attribute mit Wegwerf-Keys setzen und in I3/I4 umbenennen
(DOM-Diff + Katalog-Diff + Referenz-Test-Hölle). **I1 darf nicht starten,
bevor I0 naming-konform abgenommen ist** — die Spec sagt das sinngemäß,
der Artefakt-Stand erfüllt es nicht.

Plural-/Kompositions-Sammelabschnitt am Ende der Map
(`i18n-surface-map.md:1273–1320`) ist brauchbar und deckt die Spec-Beispiele
ab; das rettet die restliche Key-Map nicht.

### B2 — `MenuLabels`/`&'static str` vs. Katalog: Lifetime-Vertrag fehlt

Spec: `MenuLabels` bleibt Struct, wird aus dem Katalog befüllt; `const fn
de()/en()` und `labels("de")`-Hardcodes entfallen (`spec-i18n.md:157–162`).

Realität heute:

- Felder sind `&'static str`, Struct ist `Copy`
  (`menu/strings.rs:8–54`, `de()`/`en()` als `const fn` `:56–94`).
- Aufrufer: `menu/build.rs:15–19`, Hardcodes
  `menu/recent.rs:31`, `commands/file/rename.rs:47`,
  `commands/file/save_as.rs:35`.

Katalog-Werte sind zur Laufzeit geparste `String`s. Ohne Festlegung muss der
Implementierer raten zwischen:

1. `MenuLabels` auf `String` umstellen (API-Bruch, kein `Copy`, alle Call-Sites),
2. einmalig leak/internen Cache mit `'static` (hässlich, aber kompatibel),
3. `Cow<'static, str>` / `Arc<str>`.

**Raten ist gefährlich:** betrifft natives Menü-Build und Save-As-Filter-Titel;
falsche Lifetime-Strategie erzeugt entweder Compile-Schmerz über viele Module
oder versteckte Leaks. Spec muss **eine** Variante vorschreiben (Empfehlung
unten: owned `String`, kein `Copy`).

### B3 — Automation-Ready-Handshake ist spezifiziert als „Detail in I1“

Spec verlangt Handshake, damit `/dom`/Automation nicht ins i18n-Await fallen
(`spec-i18n.md:289–291`), delegiert das Design aber an I1.

Realität:

- Automation-Listener sitzen in `initAutomationEvents()`
  (`automation/events.ts:287+`), u. a. `automation:dom_query` (`:338`),
  `automation:click`, `automation:eval` — heute erst **nach** ~30 `init*()`-
  Aufrufen aus `main.ts:128`.
- E2E startet Folio und pollt früh über HTTP (`scripts/run-e2e.sh:162+`,
  `tests/e2e/run.py`).
- Backend-Automation läuft schon im Setup (`lib.rs`, Automation-Server
  parallel zum WebView).

Ohne konkreten Vertrag (Backend blockiert Responses vs. Frontend-Queue vs.
`/wait`-Predicate) baue ich entweder Race-Flakes in **jedem** E2E ab I1 oder
eine Queue, die mit `ackHandler`/`requestId` kollidiert. Das ist kein
Nice-to-have — es ist die Stabilitätsbedingung der gesamten Suite.

### B4 — Dritte Test-Katalogdatei vs. Registry-Scan unklar

Abnahmekriterium: dritte Test-Katalogdatei eingebettet, auswählbar, pluralfähig,
**ohne Code-Änderung** (`spec-i18n.md:16–19`, `:343`).

Build-Script scannt `locales/*.json` (`spec-i18n.md:55–57`). Wenn die Test-
Datei unter `locales/` liegt, landet sie im **Produktions-Binary** und im
Settings-Dropdown. Liegt sie außerhalb, braucht das Build-Script/Test-Code
eine Ausnahme → das ist Code.

**Ohne Festlegung** (z. B. `locales/` nur Release-Registry;
`#[cfg(test)] include_str!` einer `locales/testdata/xx.json`; oder
`FOLIO_I18N_EXTRA` nur in Tests) kann ich den Erweiterbarkeits-Nachweis nicht
spec-treu bauen.

### B5 — I1-Scope ist für einen TDD-Lauf unrealistisch und vermischt Risiken

I1 verlangt gleichzeitig (`spec-i18n.md:322–346`):

- Katalogformat + Build-Script + `i18n.rs` + Pluralregelwerk + Migration (4 Fälle),
- Boot-Konsolidierung der **drei** Settings-Loads
  (`lib.rs:118–122` Menü, `lib.rs:530` Logging, `state.rs:155` AppState),
- Frontend-Bootstrap-Umbau + vitest + Ready-Handshake,
- `menu/strings.rs`-Migration + MenuLabels-Integrationstest,
- E2E: `FOLIO_LANG` in **beiden** Runner-Pfaden, `/state.lang`, Assert,
- Katalog- **und** Referenz-Test als Gates,
- plus dritter Test-Katalog.

Das ist architektonisch korrekt als *Fundament*, aber als **eine** abnehmbare
TDD-Etappe mit „Tests unantastbar“ und Kreuz-Review zu groß. Scheitert der
Bootstrap/E2E-Teil, blockiert der Review den bereits grünen Rust-Kern.
Merge-/Review-Latenz pro Etappe explodiert.

---

## Klärungsbedarf

Nicht alles blockiert den Start; ohne Antwort rate ich aber an Stellen, die
später teuer werden.

### K1 — Cargo-Build-Script / Registry (Frage 2 des Auftrags)

**Bestehendes `build.rs`** (`src-tauri/build.rs:1–32`): setzt
`FOLIO_GIT_HASH`/`FOLIO_BUILD_DATE`, `cargo:rerun-if-changed` auf Git-Refs,
ruft `tauri_build::build()`. Kein `OUT_DIR`-Codegen bisher
(nur `env!` für Hash/Version).

**Machbar und unproblematisch, wenn:**

1. Generierter Registry-Code nach `$OUT_DIR/i18n_registry.rs`,
   Einbindung via `include!(concat!(env!("OUT_DIR"), "/i18n_registry.rs"))`.
2. **Pflicht:** `cargo:rerun-if-changed=locales` **und** pro Datei
   `cargo:rerun-if-changed=locales/<tag>.json` (Directory-Watch allein ist
   auf manchen Cargo-Versionen/FS unzuverlässig). Ohne das friert der
   inkrementelle Cache Katalogänderungen ein — analog zum bereits
   dokumentierten Git-Hash-Problem (`build.rs:26–29`).
3. Katalog-**Inhalte** per `include_str!(…)` aus `CARGO_MANIFEST_DIR/locales/…`
   (nicht nur einmalig in den generierten Bytes kopieren), damit `cargo`
   die JSON-Dateien als Compile-Inputs sieht.
4. Build-Script **validiert minimal** (`@meta.tag` == Dateiname-Stem, JSON
   parsebar) und **schlägt den Build fehl** bei kaputten Locale-Dateien.
   Das widerspricht oberflächlich dem Runtime-Fallback „Parsefehler → leerer
   Katalog“ (`spec-i18n.md:149–150`) — das gilt für **Laufzeit**/kaputte
   eingebettete Daten, nicht für den Entwickler-Build. Spec sollte das
   trennen: *build-time fail closed*, *runtime fail open*.

**Keine echten Konflikte mit:**

- **Eingecheckten Bundles:** Kataloge gehen **nicht** in `app.bundle.js`
  (Spec `spec-i18n.md:75–80`). `npm run build` bleibt unberührt von
  Locale-Edits. Gut.
- **`tauri build`:** `frontendDist: "dist"`; HTML/`data-i18n` in I2 ändert
  `dist/index.html` (das **ist** die Quelle — kein separates
  `web/index.html`, Bundle-Script kopiert HTML nicht). Nach I2-HTML-Änderungen
  reicht Commit von `dist/index.html`; Release-Binary braucht wie üblich
  `cargo build`, weil Tauri `dist/` zur Compile-Zeit einbettet
  (`CLAUDE.md` Build-Abschnitt). Locale-only-Änderungen → nur Rust-Rebuild,
  kein npm — erwünscht.
- **`include_str!` der Layouts/Themes** (`theme/builtin.rs` u. a.): parallel
  unberührt. Risiko nur, wenn jemand Locale-JSON fälschlich analog manuell
  `include_str!` **ohne** `rerun-if-changed` einbaut.

**Leichte Falle:** Build-Script darf `tauri_build::build()` nicht vor dem
Codegen abbrechen; Reihenfolge: Git-Env → Locale-Registry generieren →
`tauri_build::build()` beibehalten.

### K2 — Bootstrap `main.ts` (Frage 3)

**Ist-Zustand** (`main.ts`):

| Phase | Zeilen | Inhalt |
| --- | --- | --- |
| Static imports | `:9–61` | ~25 Module; Auswertung **vor** jeder Bootstrap-Funktion (esbuild-IIFE) |
| Sync `init*()`-Kaskade | `:95–135` | 30+ Inits inkl. Dialoge, Vault, Tabs, Document, Automation |
| Backend-Listener | `:137–283` | `shell:command`, `navigation:*`, `panel:*`, `cli:open`, `cli_pending_open` |
| Boot-Invokes | `:285–335` | `theme_get`, Minimap, Split, Rails |

**Modul-Level-`t()`-Fallen (bestätigt):**

- `cheatSheetRows` export const mit deutschen Labels
  (`ui/cheatsheet.ts:11–25`) — Spec hat recht: Factory/Getter nach
  `initI18n()`.
- Vault-Kontextmenü baut HTML-Strings zur Laufzeit in Funktionen
  (`vault/context-menu.ts`) — weniger Init-Problem, mehr
  `textContent`-vs-`innerHTML`-Disziplin (`spec-i18n.md:206–209`).

**Aufwand/Risiko realistisch:**

| Aspekt | Einschätzung |
| --- | --- |
| Mechanischer Umbau zu `async function bootstrap()` + IIFE | **klein** (halber Tag) |
| Event-Queue „kritisch vor Await“ | **mittel–hoch**: welche Events? Mindestens alles in `initAutomationEvents`, `cli:open`/`cli_pending_open`, vermutlich `document:*`/`tabs:changed` aus `initDocumentState`/`initTabs` — die registrieren **innerhalb** ihrer `init*`, nicht in `main.ts` |
| Reihenfolge `initI18n` → `applyStatic` → Rest | **mittel**: Settings-Dialog liest Sprache und füllt Select; nach Registry-Befüllung muss `initSettingsDialog` **nach** Katalog laufen oder Select lazy füllen |
| Degradation ohne Katalog | **klein**, wenn Applier strikt gated |
| E2E-Regression | **hoch**, solange B3 ungelöst |

**Empfehlung Implementierungspfad (wenn Spec nachzieht):**

1. Backend-Ready-Gate (sauberer als Frontend-Event-Queue für HTTP-Automation):
   Automation-Handler warten auf `frontend_ready`-Flag (Command vom Bootstrap
   nach `applyStaticTranslations`).
2. Parallel: `cli_pending_open` und schwere UI-Inits erst nach `i18nReady`.
3. Keine generische Event-Queue für *alle* Tauri-Events — zu fehleranfällig
   mit `ackHandler` (`main.ts:159+`).

Das ist **1–2 fokussierte Tage** inkl. vitest-Boot-Mock, nicht „ein
Nebenpunkt in I1“.

### K3 — Referenz-Test: wie scannt man TS/HTML?

Spec (`spec-i18n.md:300–305`) verlangt Scan aller statischen `t`/`tPlural`/
`data-i18n-*` gegen den Basiskatalog. Offen:

- Tooling: `regex` über `src-tauri/web/app/**/*.ts` + `dist/index.html` in
  einem Rust-Integrationstest? Eigenes Node-Skript im `cargo test`-Hook?
- Erlaubt: nur Literal-Keys `t('a.b.c')` — Template-Strings verboten
  (Spec ok), aber multiline/`t(\n  "…"`?
- Allowlist-Datei-Ort und Format für Registry-Keys
  (`theme.builtin.<id>.*`).

Ohne das ist der „Referenz-Test ab I1“ entweder zahnlos oder eine eigene
Etappe.

### K4 — Settings-String-Tag und Serde-Kompatibilität

Heute: `Language`-Enum, `rename_all = "lowercase"`, Default `De`
(`settings.rs:19–32`). Spec: String `"system"` | BCP-47.

Klärungsbedarf:

- Patch-API / Automation `POST /settings` akzeptiert heute Enum-Werte —
  Vertrag in `docs/automation-contract.md` anpassen (I6 nennt Doku, aber
  Breaking schon in I1).
- Unbekannter Tag: Spec speichert Wert, Runtime-Fallback `en`
  (`spec-i18n.md:132–133`). `settings_get` liefert dann `"xx"` während UI
  englisch ist — Frontend-Select braucht „unbekannte Option anzeigen oder
  nicht?“-Regel.
- Migration Fall 3 (korrupt): „bestehendes Recovery, Sprache wie Fall 4,
  Datei NICHT still überschreiben“ (`spec-i18n.md:134–135`) — `load_json`
  kollabiert Fehler auf Default (`persist.rs:60–64`). Braucht **neuen**
  Raw-Load-Pfad; Spec sagt das, aber nicht, ob Logging-Init vor Migration
  noch den alten Default-Pfad nutzen darf (Boot-Owner löst das, wenn strikt).

### K5 — `thiserror`-Enums: Entscheidungstabelle fehlt vor I4b

Spec: in I4b einzeln entscheiden (`spec-i18n.md:167–169`). Für den
Implementierer reicht eine **Vorlage in der Spec**:

| Enum | UI-sichtbar? | Automation teilt Display? | Entscheidung |
| --- | --- | --- | --- |
| `SearchError` | ja | ja (`automation/handlers/search.rs`) | Display übersetzen **oder** am Rand wrappen |
| `AiConfigError` | ja | indirekt | … |

Sonst rate ich in I4b inkonsistent und flakke E2E 34/45.

### K6 — HTML-Quelle und Leaf-Wrapper

`dist/index.html` ist die editierte Shell (keine zweite Quelle). Leaf-Regel
(`spec-i18n.md:234–238`) trifft reale gemischte Knoten:

- Auto-Format-Label mit Checkbox (`dist/index.html` ~196–200),
- About-`dt` mit SVG + Text (~715–719).

I0 markiert die Textknoten, aber **nicht**, welche Nodes einen
`<span data-i18n>`-Wrapper brauchen. Für I2 brauche ich pro Zeile der Map
eine Spalte `wrapper: ja/nein` oder eine explizite Liste gemischter Nodes.

### K7 — en-Katalog-Vollständigkeit je Etappe

I1 startet nur mit `menu.*`. Referenz-Test „alle Keys im Code“ ist dann
ok; „identische Key-Mengen de/en“ ebenfalls. Ab I2 wächst der Katalog
pro Etappe — **ok**, wenn der Referenz-Test nur **existierende** Referenzen
prüft und Dead-Keys erst ab I6 streng sind. Spec impliziert beides ab I1
(`spec-i18n.md:295–305`). Bitte Dead-Key-Gate erst ab I6 (oder Allowlist
„wip“) — sonst blockiert jeder Zwischenstand.

---

## Einschätzung Aufwand je Etappe

Skala: **S** ≤0,5 T · **M** 1–2 T · **L** 3–5 T · **XL** >5 T
(eine Person, inkl. Gates/E2E, ohne Kreuz-Review-Latenz).

| Etappe | Spec-Schnitt | Aufwand | Risiko | Kommentar |
| --- | --- | --- | --- | --- |
| **I0** | Surface+Keys | **M** (Nacharbeit) | Hoch, wenn übersprungen | Jetzt: Inventar roh brauchbar, Keys **nicht**. Nachkorrektur Naming + False-Positive-Säuberung + Wrapper-Spalte zwingend vor I1 |
| **I1** wie spezifiziert | Alles Fundament | **XL** | Sehr hoch | Zu viele unabhängige Failure-Domains in einem Review |
| **I1a** (Vorschlag) | Katalog, build.rs, `i18n.rs`, Migration, Boot-Owner, `i18n_catalog`, menu aus Katalog, unit/integration | **L** | Mittel | TDD-Kern; noch kein Frontend-Bootstrap-Umbau |
| **I1b** (Vorschlag) | `app/i18n`, bootstrap, Ready-Handshake, E2E-Pin+`lang`, vitest | **L** | Hoch | Isoliert flaky E2E |
| **I2** | HTML `data-i18n` + Settings-Select | **M–L** | Mittel | ~170 Strings; Leaf-Wrapper-Fummelei; de-Flash akzeptiert; E2E-Voll-Lauf |
| **I3a** | State/Vault/Find/Tabs/View/Editor-Shell | **L** | Mittel–hoch | Plural-Kompositionen + Cheatsheet-Factory + Monaco contextmenu off |
| **I3b** | Dialoge/Settings/AI/Theme/Export-UI | **L–XL** | Hoch | Größte TS-Fläche (`settings-ai`, theme-editor, ai-actions); Locale-Grep |
| **I4a** | Native Dialoge, Built-ins, Export | **M–L** | Mittel | Cover-Templates + en-Exporttests; MenuLabels-Lifetime muss aus I1 sitzen |
| **I4b** | Fehlertexte | **L** | Mittel | Viele Call-Sites; Automation-Contract; ohne K5 inkonsistent |
| **I5** | KI-Systemprompts EN | **S** | Niedrig | Isoliert; E2E 34/45 Asserts |
| **I6** | lang-smoke, Doku, 33_ai_settings | **M** | Niedrig–mittel | Wrapper-Modus; Aufräumen I0/Reviews |

**Gesamt V1** nach sauberem I0: grob **15–25 Personentage** Implementierung
+ Review-Runden — nicht „eine Session alles“, aber in einer langen
grok-Session mit Etappen-Abnahme machbar, **wenn** I1 geschnitten wird.

### Reihenfolge / Merge-Konflikte (Frage 4)

**Würde ich anders schneiden?** Ja:

1. **I0 abschließen und abnehmen** (Blocker B1) — sonst alle späteren PRs.
2. **I1a → I1b** statt monolithischem I1.
3. I2 nach I1b (braucht Applier + de-Pin).
4. I3a / I3b sequentiell (nicht parallel): beide touchieren
   `locales/de.json`/`en.json` und denselben `t()`-Import — **garantierte
   Katalog-Merge-Konflikte** bei Parallelität.
5. I4a vor I4b (Export-Tests unabhängig von Fehler-Wording).
6. I5 jederzeit nach I1a (kaum Katalog); ideal nach I3b (E2E-Mocks stabil).
7. I6 zuletzt.

**Konflikt-Hotspots zwischen Etappen:**

| Datei / Fläche | Etappen | Risiko |
| --- | --- | --- |
| `locales/de.json`, `en.json` | I1–I4 | **Sehr hoch** bei Parallel-PRs — nur sequentiell |
| `src-tauri/build.rs` | I1 | Einmalig |
| `src-tauri/src/lib.rs`, `settings.rs`, `state.rs` | I1 | Hoch untereinander, danach stabil |
| `menu/strings.rs`, `menu/build.rs` | I1 | Einmalig |
| `web/app/main.ts` | I1b | Danach selten |
| `web/app/i18n/**` | I1b, Tests in I3 | Mittel |
| `dist/index.html` | I2 (+ ggf. spätere UI) | Hoch nur in I2 |
| `automation/handlers/state.rs`, `run-e2e.sh`, `run.py` | I1b, I6 | Mittel |
| Dialog-TS-Module | I3b | Untereinander, wenn parallel |

**Nicht parallelisieren:** I3a‖I3b, I4a‖I4b auf dem Katalog; I1a‖I1b auf
`lib.rs`/Settings.

---

## Was ich an der Spec ÄNDERN würde (priorisiert)

Bevor ich implementiere — kurze Liste, höchste Priorität zuerst:

1. **I0-Abnahmekriterium schärfen:** Map muss (a) nur erlaubte Namespaces,
   (b) funktionsbenannte Keys, (c) keine Test/Log/False-Positives,
   (d) Wrapper-Markierung für Nicht-Leafs, (e) Plural-Liste (ist ok)
   enthalten. Ohne Abnahme-Haken → kein I1.
2. **`MenuLabels`-Speicher-Modell festnageln:** Empfehlung: Felder `String`,
   `labels() -> MenuLabels` aus Boot-Katalog, kein `Copy`; Call-Sites
   anpassen. Alternativ einmalig gebauter `&'static MenuLabels` in
   `OnceLock` — dann dokumentieren.
3. **Ready-Handshake konkretisieren (nicht „Detail in I1“):** z. B. Command
   `frontend_i18n_ready` setzt Flag; Automation-Routen `/dom`, `/click`,
   `/eval`, `/sync/render` warten ≤N ms oder 503/Retry-Header; E2E-Runner
   pollt `/state` mit `i18nReady: true`. Frontend-Event-Queue nur für
   `cli:open` falls nötig.
4. **I1 teilen** in I1a (Rust-Fundament + Menü) und I1b (Frontend-Bootstrap +
   E2E-Pin) — TDD bleibt auf I1a.
5. **Dritte Test-Locale:** `#[cfg(test)]`-Einbettung unter
   `src-tauri/tests/fixtures/locales/` **oder** Build-Script-Flag
   `FOLIO_I18N_TEST_LANGS=1` nur in `cargo test` — nicht im Release-Dropdown.
6. **Build-Script-Vertrag:** `rerun-if-changed`, fail-closed zur Build-Zeit,
   fail-open zur Runtime; generiert nach `OUT_DIR`.
7. **Referenz-Test:** Scan-Scope = Quellen unter `src-tauri/src/**/*.rs`,
   `src-tauri/web/app/**/*.{ts,html}`, `src-tauri/dist/index.html`; nur
   String-Literale; Dead-Keys soft bis I6.
8. **Dead-Key-/Vollkatalog-Erwartung pro Etappe** staffeln (I1 nur `menu.*` +
   i18n-Meta-Keys).
9. **`common`-Namespace:** entweder in die kanonische Liste aufnehmen
   (schwach — Spec will Fachnamespaces) **oder** in I0 vollständig
   weg-mappen (`settings.general.*`, `toolbar.*`, …). Halbzustand verbieten.
10. **I4b-Vorlage** für geteilte `thiserror`-Enums (Search/AI/Theme) in die
    Spec, nicht erst „während I4b entscheiden“.

---

## Verdikt

### **NACHARBEIT** — nicht implementierungsbereit für I1+

Die Architektur-Entscheidungen in Spec v2 (Registry statt Enum, Migration,
Plural-Segmente, Monaco-Scope, E2E-de-Pin, Leaf-Applier, Export-Surface) sind
aus Implementierer-Sicht **richtig und größtenteils umsetzbar**. Codex-Blocker
1–9 sind inhaltlich adressiert.

**Blockiert den Start dennoch:**

1. **I0-Key-Map** (B1) — Naming/`common`/False-Positives; ohne Nacharbeit
   rate ich hunderte Keys.
2. **MenuLabels-Lifetime** (B2).
3. **Ready-Handshake-Design** (B3) — sonst E2E-Selbstlähmung ab I1.
4. **Test-Katalog vs. Registry** (B4).
5. **I1-Schnitt zu fett** (B5) — operational, aber review-/risiko-kritisch.

**Nicht blockierend, aber vor I1 spezifizieren:** Build-Script-`rerun-if-
changed`/fail-closed (K1), Referenz-Test-Tooling (K3), Dead-Key-Staffelung
(K7).

**Bootstrap (Frage 3):** realistisch **machbar**, Risiko liegt nicht am
`async bootstrap()`-Syntax, sondern an **Listenern innerhalb der `init*()`-
Module** und am Automation-Ready-Vertrag — Spec unterschätzt das, wenn sie
es als Checkbox in I1 neben dem gesamten Rust-Fundament führt.

**Cargo-Build-Script (Frage 2):** **kein struktureller Konflikt** mit
eingecheckten Bundles oder `tauri build`; einzige echte Fußangel ist
`cargo:rerun-if-changed` für Locale-Dateien und die Trennung
build-time-validation vs. runtime-fallback.

### Checkliste Nacharbeit (Minimum vor „I1 starten“)

- [ ] I0-Map naming-konform abgenommen (Namespaces, Funktionskeys, ohne Test/Log-Müll, Wrapper-Spalte)
- [ ] Spec: `MenuLabels`-owned-Modell
- [ ] Spec: Ready-Handshake Sequenzdiagramm/Regeln (Backend-Flag bevorzugt)
- [ ] Spec: Test-Locale-Einbettung ohne Release-Dropdown
- [ ] Spec: I1 → I1a/I1b (oder gleichwertiger Schnitt)
- [ ] Spec: Build-Script `rerun-if-changed` + fail-closed
- [ ] Spec: Referenz-Test-Scanumfang + Dead-Keys soft bis I6

Wenn diese Punkte in Spec + I0 stehen, ist das Feature aus meiner Sicht
**BEREIT** für Implementierung I1a.
)
