# Code-Review Etappe I2 (Codex)

**Urteil:** Noch nicht abnahmebereit. Die statische Extraktion ist insgesamt sorgfältig, aber vier verbindliche I2-Verträge sind noch nicht vollständig erfüllt: Der Sprach-Select kann im Degradationspfad leer werden, ein unbekannter gespeicherter Tag erklärt den tatsächlich verwendeten Fallback nicht, der deutsche About-Text wird falsch decodiert angezeigt, und mindestens eine sichtbare Shell-Zeichenkette fehlt sowohl in der Surface-Map als auch im Katalog.

## Blocker

### 1. Bei i18n-Degradation ist das Sprach-Select leer

Das HTML enthält im Sprach-Select nur noch einen Kommentar, aber keine deutsche Fallback-Option (`src-tauri/dist/index.html:170`). `populateLanguageOptions()` kehrt ohne Katalog sofort zurück (`src-tauri/web/app/ui/settings-dialog.ts:239`), anschließend kann `syncLanguageSelect()` für einen normalen Wert wie `system` oder `de` keine bekannte Option auswählen und hängt lediglich für den unbekannten Fall eine deaktivierte Option an (`src-tauri/web/app/ui/settings-dialog.ts:259`). Im realen Degradationspfad existiert Tauri weiterhin: `settings_get` läuft, `applySettingsToForm()` ruft beide Funktionen auf, und der Dialog wird danach geöffnet (`src-tauri/web/app/ui/settings-dialog.ts:192`, `src-tauri/web/app/ui/settings-dialog.ts:205`). Damit bleibt das Select für `system`/`de` tatsächlich ohne Eintrag.

Das widerspricht sowohl der allgemeinen Degradationsregel „deutsche HTML-Platzhalter bleiben“ als auch dem Settings-Vertrag „nie ein leeres Select“ (`docs/spec-i18n.md:341`, `docs/spec-i18n.md:146`). Die Funktion muss auch ohne Katalog mindestens einen sinnvollen deutschen Fallbackzustand herstellen bzw. vorhandenes Fallback-Markup erhalten. Der Test beweist diesen Pfad nicht: Er baut drei Optionen künstlich vor und ruft nur `syncLanguageSelect()` auf (`src-tauri/web/tests/ui/settings-dialog.test.ts:640`). Ein Regressionstest muss das echte leere I2-Markup mit `getCatalog() === null` abbilden.

### 2. Für unbekannte persistierte Tags fehlt der vorgeschriebene Fallback-Hinweis

Die temporäre deaktivierte Option zeigt lediglich `xx-YY (unbekannt)` (`src-tauri/web/app/ui/settings-dialog.ts:266`, `src-tauri/locales/de.json:182`). Der Hinweis darunter wird unabhängig vom Unknown-Zustand immer auf den allgemeinen Neustarttext gesetzt (`src-tauri/web/app/ui/settings-dialog.ts:147`). Nirgends wird erklärt, dass Folio den unbekannten Tag zur Laufzeit mit dem englischen Katalog und dessen Format-Locale aufgelöst hat.

Die Spezifikation verlangt ausdrücklich „deaktivierte temporäre Option + übersetzten Fallback-Hinweis“ (`docs/spec-i18n.md:146`, `docs/spec-i18n.md:398`). Benötigt wird ein eigener, in allen Katalogen vorhandener Hinweistext für den Unknown-Zustand; der Test sollte neben Option, Disabled-State und `select.value` auch diesen Hinweis prüfen. Der aktuelle Test prüft nur die Option (`src-tauri/web/tests/ui/settings-dialog.test.ts:654`).

### 3. Der deutsche About-Untertitel zeigt sichtbar `&amp;` statt `&`

`dialogs.about.tagline` enthält im JSON den HTML-Entity-Text `Markdown-Viewer &amp; -Editor` (`src-tauri/locales/de.json:53`). Der statische Applier schreibt Katalogwerte absichtlich über `textContent`, nicht `innerHTML` (`src-tauri/web/app/i18n/apply.ts:47`). Beim deutschen Boot überschreibt er daher den korrekt vom HTML-Parser decodierten Platzhalter und zeigt wortwörtlich `Markdown-Viewer &amp; -Editor` an. Der Katalogwert muss ein normales `&` enthalten, wie es im englischen und französischen Katalog bereits korrekt der Fall ist (`src-tauri/locales/en.json:53`, `src-tauri/tests/fixtures/locales/fr.json:53`).

### 4. Die Surface-Map ist für die HTML-Shell nicht vollständig; mindestens ein sichtbarer Text bleibt in der englischen UI deutsch

`Manifest-Logo:` ist sichtbare statische UI, besitzt aber weder `data-i18n` noch einen Eintrag im gesamten `src-tauri/dist/index.html`-Abschnitt der Surface-Map (`src-tauri/dist/index.html:439`, `docs/i18n-surface-map.md:5`). In einer englischen UI bleibt dieser Text deshalb deutsch. Das ist kein Markenname oder technischer Token, sondern ein Feldhinweis, und damit nicht OUT-OF-SCOPE.

Daneben enthält die Shell weitere undokumentierte statische Texte: den expandierbaren deutschen Systemregel-Text (`src-tauri/dist/index.html:657`) sowie `Made with … by Ralf Kuhlendahl` (`src-tauri/dist/index.html:703`). Für den Systemregel-Text kann eine bewusste Verschiebung nach I5 sinnvoll sein, weil dort die englischen KI-Systemprompts umgesetzt werden; dann muss die Map den Fund aber explizit als I5/OUT-OF-SCOPE für I2 ausweisen. Für die Autorenzeile ist ebenfalls eine bewusste Branding-Ausnahme oder ein Katalogeintrag zu dokumentieren. Die I0-Regel verlangt gerade, False-Positives als begründete OUT-OF-SCOPE-Zeilen stehen zu lassen (`docs/i18n-surface-map.md:3`).

## Empfehlungen

### 1. Surface-Map und tatsächlich verwendete Keys wieder synchronisieren

Die Gesamtzahlen täuschen Übereinstimmung vor: Sowohl Map als auch HTML enthalten 297 nicht-ausgenommene Referenzen, aber auf Zeilen-/Key-Ebene gleichen sich mehrere Abweichungen nur zufällig aus.

- Die Map fordert noch die hartkodierten Sprachoptionen `settings.language.optionDe` und `settings.language.optionEn`, obwohl das Registry-Select sie gemäß Settings-Vertrag zu Recht entfernt hat (`docs/i18n-surface-map.md:88`, `src-tauri/dist/index.html:170`).
- Drei `Anzeigename`-Fundstellen verwenden den neu eingeführten und semantisch besseren Key `theme.editor.manifest.displayName.label` (`src-tauri/dist/index.html:264`, `src-tauri/dist/index.html:304`, `src-tauri/dist/index.html:587`), während die Map jeweils `theme.editor.manifest.name.label` vorgibt (`docs/i18n-surface-map.md:124`, `docs/i18n-surface-map.md:248`). Das ist fachlich plausibel, aber derzeit ein Key ohne Map-Basis.
- `Basis-Theme` und `Modell` im KI-Export waren in der Map gar nicht erfasst; die Implementierung hat sie sinnvoll mit vorhandenen Keys markiert (`src-tauri/dist/index.html:555`, `src-tauri/dist/index.html:559`, `docs/i18n-surface-map.md:237`).
- `settings.language.system` und `settings.language.unknown` haben zwar keine HTML-Map-Zeile, besitzen aber eine klare Basis im dynamischen Registry-/Unknown-Vertrag (`src-tauri/web/app/ui/settings-dialog.ts:245`, `src-tauri/web/app/ui/settings-dialog.ts:269`).

Vor Abnahme sollte die normative Map diese bewussten Änderungen und die fehlenden Shell-Fundstellen nachziehen; andernfalls ist sie für spätere Vollständigkeitsreviews nicht mehr belastbar.

### 2. Das Markup-Gate sollte langfristig einen HTML-Parser statt eines Textscanners verwenden

Für das aktuelle Markup prüft das Gate alle vier Attribute (`data-i18n`, `-title`, `-placeholder`, `-aria-label`) gegen `en` (`src-tauri/tests/i18n_ref.rs:423`, `src-tauri/tests/i18n_ref.rs:873`). Die vier exakten Suchmuster kollidieren nicht miteinander; ein Element mit Text- und Titel-Key wird korrekt als zwei Referenzen gezählt, während die Dead-Key-Prüfung anschließend ohnehin mit einer Menge arbeitet. Aktuell entsteht daher keine inkonsistente Doppelzählung.

Der Scanner ist aber formatabhängig: `find_html_attrs()` erkennt nur Attribut und Wert auf derselben Zeile (`src-tauri/tests/i18n_ref.rs:431`), und der Leaf-Check sucht naiv nach dem ersten schließenden Tag bzw. überspringt ungeschlossene Elemente (`src-tauri/tests/i18n_ref.rs:836`, `src-tauri/tests/i18n_ref.rs:850`). Außerdem prüft das Gate nur vorhandene Attribute, nicht die Vollständigkeit gegen die Surface-Map; genau deshalb bleibt `Manifest-Logo:` unentdeckt. Ein echter HTML-Parse plus eine maschinenlesbare Map bzw. ein separater Vollständigkeitscheck würde diese Lücken schließen.

### 3. Die Settings-Select-Tests sollten die Zustandsmatrix direkt abdecken

Zusätzlich zum Degradationsfall aus Blocker 1 fehlen direkte Tests für: erfolgreicher Katalog mit `system`; bekannter persistierter Registry-Tag samt Roundtrip von `select.value`; erfolgreicher Katalog mit leerem `languages`-Array (mindestens `System` bleibt); wiederholtes Befüllen ohne doppelte Optionen; unbekannter Tag samt Fallback-Hinweis. Die Implementierung des bekannten Tags ist statisch korrekt — Optionen werden zuerst erzeugt und danach `select.value` gesetzt (`src-tauri/web/app/ui/settings-dialog.ts:242`, `src-tauri/web/app/ui/settings-dialog.ts:275`) — sollte aber als Vertragsverhalten festgehalten werden.

## Nice-to-have

- Die Sichtprüfung sollte besonders die neuen Wrapper in Find-Optionen, Settings-/Theme-Checkboxen, den zweispaltigen Übersetzungssprachen und den About-`dt`-Zeilen fokussieren (`src-tauri/dist/index.html:124`, `src-tauri/dist/index.html:196`, `src-tauri/dist/index.html:603`, `src-tauri/dist/index.html:715`). Die CSS-Selektoren arbeiten jeweils am umgebenden `label`/`dt`, nicht an direkten Textknoten (`src-tauri/web/styles/find-bar.css:58`, `src-tauri/web/styles/theme-editor.css:132`, `src-tauri/web/styles/translate-dialog.css:86`, `src-tauri/web/styles/dialogs.css:519`). Ein konkreter Selektorbruch ist daher nicht erkennbar; verbleibendes Baseline-Risiko sind Textlänge/Umbruch und minimale Inline-Metrik-Unterschiede. Im About-Grid ist wegen `max-content` plus festem rechten Avatar-Padding insbesondere `License` visuell prüfenswert (`src-tauri/web/styles/dialogs.css:508`).
- `settings.language.unknown` könnte statt der knappen Klammerform eine zugänglichere Bezeichnung für die deaktivierte Option erhalten; die eigentliche Fallback-Erklärung gehört dennoch separat in den Hinweis aus Blocker 2 (`src-tauri/locales/en.json:182`).
- Das englische `Each run … incurs cost.` ist verständlich, idiomatischer wäre `incurs costs` oder `incurs a cost` (`src-tauri/locales/en.json:83`).

## Für gut befunden

- **Leaf-/Wrapper-Korrektheit:** Im geparsten aktuellen DOM hat kein Element mit `data-i18n` Element-Kinder. Sämtliche in der Map als Wrapper=`ja` markierten Checkbox-/Radio-Texte und die About-`dt`-Texte wurden mit inneren `<span>`-Leafs umgesetzt (`src-tauri/dist/index.html:124`, `src-tauri/dist/index.html:198`, `src-tauri/dist/index.html:379`, `src-tauri/dist/index.html:422`, `src-tauri/dist/index.html:603`, `src-tauri/dist/index.html:665`, `src-tauri/dist/index.html:715`). Die TS-Logik greift bei den betroffenen Strukturen über IDs zu, nicht über fragile `label > input + text`- oder `dt`-Pfade (`src-tauri/web/app/ui/find-bar.ts:267`, `src-tauri/web/app/ui/translate-dialog.ts:138`, `src-tauri/web/app/ui/ai-actions-dialog.ts:377`, `src-tauri/web/app/ui/theme-editor.ts:164`).
- **Attribut-Mapping:** `title`, `placeholder` und `aria-label` sind konsistent mit den drei vorgesehenen Attributvarianten markiert. Der Markup-Test meldet 297 Attributreferenzen; alle Keys existieren in `en`, und alle Textreferenzen bestehen die Leaf-Regel (`src-tauri/tests/i18n_ref.rs:868`).
- **Katalog-Parität:** `de`, `en` und die `fr`-Fixture besitzen identische Key-Mengen und Werttypen; die geprüften Platzhalter sind parallel. `settings.language.unknown` verwendet überall exakt `{tag}` (`src-tauri/locales/de.json:182`, `src-tauri/locales/en.json:182`, `src-tauri/tests/fixtures/locales/fr.json:184`).
- **Englische Terminologie:** View/Edit/Split sind in Toolbar und Settings konsistent; `Workspace` ist als Vault-Überschrift passend, und `Table of Contents` ist die korrekte Übersetzung für das Inhaltsverzeichnis (`src-tauri/locales/en.json:183`, `src-tauri/locales/en.json:273`, `src-tauri/locales/en.json:275`, `src-tauri/locales/en.json:277`, `src-tauri/locales/en.json:298`, `src-tauri/locales/en.json:306`).
- **Registry-Select im Erfolgsfall:** `System` wird übersetzt vorangestellt, Registry-Sprachen erscheinen mit Eigenbezeichnung, unbekannte Tags werden deaktiviert und temporär eingefügt, und bekannte persistierte Werte werden nach dem Aufbau ausgewählt (`src-tauri/web/app/ui/settings-dialog.ts:239`, `src-tauri/web/app/ui/settings-dialog.ts:259`). Ein erfolgreicher Produktionskatalog kann wegen der Build-Validierung nicht ohne `en` entstehen; ein leeres `languages`-Array lässt im jetzigen Code immerhin die `System`-Option stehen. Der geschlossene Sprach-Union ist entfernt; `SettingsLanguage` ist nur noch ein Alias für `string`, und es gibt keine weiteren Restverbraucher (`src-tauri/web/app/ui/settings-dialog.ts:27`).
- **Keine erkennbare Wrapper-Regression:** Die relevanten CSS-Regeln formatieren die Labels als Flex/Grid und bleiben mit einem Inline-`span` semantisch gleich. Der globale Checkbox-Abstand wirkt unverändert auf das Input selbst (`src-tauri/web/styles/content.css:334`). Der About-Icon-Abstand bleibt über den `dt`-Flex-Gap erhalten (`src-tauri/web/styles/dialogs.css:519`).
- **Ausgeführte Prüfungen:** `git diff --check`, `npm run typecheck`, die 17 Settings-Dialog-Vitest-Tests, `cargo test --test i18n_ref` (5/5) und der Katalog-Key-Paritätstest sind grün. Wie beauftragt wurde kein E2E-Lauf gestartet.
