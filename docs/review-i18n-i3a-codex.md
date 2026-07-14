# Review Etappe I3a — dynamische Frontend-Strings

**Urteil:** Nicht freigeben. Der Diff hat vier Blocker: eine verbindliche
I3a-Surface bleibt deutsch, die vorgeschriebene Plural-Matrix ist unvollständig,
zwei Such-Renderpfade verletzen die `innerHTML`-Regel, und die französische
Fixture erzeugt bei `0` falsche Zahlen bzw. enthält fehlerhafte neue Texte.

## Blocker

1. **Die Ausführen-Bestätigung ist weiterhin hartcodiert und erfüllt den
   Kompositions-Key aus der Map nicht.**
   [`src-tauri/web/app/ui/dialogs.ts:146`](../src-tauri/web/app/ui/dialogs.ts#L146)
   setzt weiterhin `„${name}" als Programm ausführen?` als deutsches Literal.
   Der Pfad wird aus dem lokalisierten Vault-Kontextmenü unverändert über
   `confirmRunFile(basename(path))` erreicht
   ([`src-tauri/web/app/vault/context-menu.ts:70`](../src-tauri/web/app/vault/context-menu.ts#L70)).
   Damit bleibt diese I3a-Surface auf Englisch/Französisch deutsch. Zusätzlich
   haben die bereits vorhandenen Katalogwerte
   [`de.json:87`](../src-tauri/locales/de.json#L87),
   [`en.json:87`](../src-tauri/locales/en.json#L87) und
   [`fr.json:87`](../src-tauri/tests/fixtures/locales/fr.json#L87) keinen
   `{name}`-Platzhalter, obwohl die verbindliche Map für
   `dialogs.run.confirm` genau `„{name}“ als Programm ausführen?` verlangt
   ([`docs/i18n-surface-map.md:1336`](i18n-surface-map.md#L1336)).
   `confirmRunFile` muss `t('dialogs.run.confirm', { name })` via
   `textContent` verwenden; die drei Katalogwerte und ein de/en-Test mit einem
   Dateinamen sind entsprechend anzupassen.

2. **Die Frontend-Pluraltests bilden die geforderte 0/1/2-Matrix nicht ab.**
   [`src-tauri/web/tests/i18n/plural-composition.test.ts:76`](../src-tauri/web/tests/i18n/plural-composition.test.ts#L76)
   testet für die drei Wortstatistik-Zähler nur Diagonalen und sechs
   Stichproben statt der 27 kartesischen Kombinationen. Der englische Block
   testet sogar ausschließlich `(0,0,0)`, `(1,1,1)`, `(2,2,2)`
   ([`plural-composition.test.ts:117`](../src-tauri/web/tests/i18n/plural-composition.test.ts#L117)).
   Auch die Suchkompositionen sind lückenhaft: `done` und `running` prüfen
   weder in de noch en alle neun `hits × files`-Kombinationen; en lässt bei
   `empty` den 0-Fall aus, und `skipped` hat in beiden Sprachen keinen 0-Fall
   ([`plural-composition.test.ts:88`](../src-tauri/web/tests/i18n/plural-composition.test.ts#L88),
   [`plural-composition.test.ts:123`](../src-tauri/web/tests/i18n/plural-composition.test.ts#L123)).
   Das widerspricht der normativen Forderung „0/1/2-Kombinationen in allen
   unabhängigen Zählvariablen (de + en)“
   ([`docs/spec-i18n.md:304`](spec-i18n.md#L304)). Schleifen über das volle
   kartesische Produkt sind hier weniger fehleranfällig als weitere
   Einzel-Assertions. Der Test sollte außerdem `fmtNumber(ms)` wie der
   Produktionspfad statt `String(ms)` verwenden.

3. **Neu lokalisierte Suchtexte und User-Werte werden weiterhin in
   `innerHTML`-Strings komponiert.**
   [`src-tauri/web/app/vault/search.ts:407`](../src-tauri/web/app/vault/search.ts#L407)
   fügt `t('search.results.moreInFile')` in den später an `listEl.innerHTML`
   zugewiesenen String ein. Der Scope-Chip setzt sowohl `t()`-Werte als auch
   den User-/Dateisystemwert `scopePath` und den daraus gebildeten Ordnernamen
   in `scopeEl.innerHTML` ein
   ([`search.ts:711`](../src-tauri/web/app/vault/search.ts#L711)). Die Werte
   werden zwar mit `escapeHtml` escaped; die Spec fordert für HTML-bauende
   Stellen aber ausdrücklich DOM-Nodes plus `textContent`
   ([`docs/spec-i18n.md:311`](spec-i18n.md#L311)). Das ist zudem Scope-Drift:
   `search.results.moreInFile` ist in der Map explizit als
   `OUT-OF-SCOPE: Markup-Schnipsel` markiert
   ([`docs/i18n-surface-map.md:1253`](i18n-surface-map.md#L1253)). Beide
   umgestellten Renderpfade müssen auf DOM-Konstruktion umgebaut werden oder
   die nicht autorisierte Extraktion muss zurückgenommen werden.

4. **Die neue französische Fixture ist für die Pluralfälle funktional falsch
   und enthält sichtbare Übersetzungsfehler.**
   Für Französisch liefert `Intl.PluralRules('fr').select(0)` die Kategorie
   `one`. Die neuen `one`-Branches sind jedoch mit `1` hartcodiert, z. B.
   `search.status.filesPart`, `hitsPart`, `skippedPart`
   ([`fr.json:169`](../src-tauri/tests/fixtures/locales/fr.json#L169)) sowie die
   drei Wortstatistik-Segmente
   ([`fr.json:270`](../src-tauri/tests/fixtures/locales/fr.json#L270)). Folglich
   würden `0` Dateien/Treffer/Wörter als `1 fichier/résultat/mot` erscheinen.
   In französischen `one`-Branches muss `{count}` statt `1` stehen. Darüber
   hinaus sind `Aucun résultat ({filesPart} parcourus)` und
   `{skippedPart} ignorés` im Singular grammatisch falsch
   ([`fr.json:167`](../src-tauri/tests/fixtures/locales/fr.json#L167),
   [`fr.json:187`](../src-tauri/tests/fixtures/locales/fr.json#L187));
   `Aucun fichier searchable` enthält sogar ein unübersetztes englisches Wort
   ([`fr.json:179`](../src-tauri/tests/fixtures/locales/fr.json#L179)). Die
   Texte müssen so umformuliert/segmentiert werden, dass 0/1/2 grammatisch
   tragen, und die Fixture braucht mindestens eigene 0/1/2-Ausgaben für die
   neu hinzugekommenen Plural-Keys.

## Empfehlungen

1. **Die 29 neu angelegten, in der abgenommenen Map nicht vorkommenden Keys
   explizit mit der Map versöhnen.** Der Diff ergänzt insgesamt 76 Top-Level-
   Keys; 29 davon sind in `docs/i18n-surface-map.md` nicht genannt. Darunter
   sind nachvollziehbare Map-Lücken (weitere Cheatsheet-Zeilen,
   `statusBar.modeEdit`, `statusBar.modeSplit`, Kontextmenü-Aktionen), aber
   auch explizit ausgeschlossene Stellen wie `search.results.moreInFile` und
   `errors.view.imageConvertUnavailable`. Relevante Beispiele stehen in
   [`src-tauri/locales/en.json:96`](../src-tauri/locales/en.json#L96),
   [`en.json:161`](../src-tauri/locales/en.json#L161),
   [`en.json:263`](../src-tauri/locales/en.json#L263) und
   [`en.json:349`](../src-tauri/locales/en.json#L349). Da die Map laut
   [`docs/i18n-surface-map.md:1418`](i18n-surface-map.md#L1418) die
   1:1-Arbeitsgrundlage ist, sollten die sinnvollen Ergänzungen vor Freigabe
   dokumentiert und die übrigen entfernt werden.

2. **Alle durch I3a neu katalogabhängigen Unit-Tests seeden.** Der vollständige
   Vitest-Lauf ist grün, emittiert aber wiederholt `missing vault.tree.empty`,
   `missing tabs.close.tooltip`, `missing tabs.dirty.ariaLabel` und
   `missing tabs.settings.label`. Insbesondere
   [`src-tauri/web/tests/vault/tree.test.ts:42`](../src-tauri/web/tests/vault/tree.test.ts#L42),
   [`src-tauri/web/tests/ui/theme-editor.test.ts:1`](../src-tauri/web/tests/ui/theme-editor.test.ts#L1)
   und
   [`src-tauri/web/tests/ui/settings-dialog.test.ts:1`](../src-tauri/web/tests/ui/settings-dialog.test.ts#L1)
   verwenden die neue Übersetzungsoberfläche ohne Katalog. Das verdeckt rohe
   Keys in Assertions und macht die Testsuite unnötig laut. `seedDeCatalog()`
   sollte dort wie in den bereits angepassten State-/Vault-/View-Tests gesetzt
   werden.

3. **Die Monaco-Optionen direkt testen.** `contextmenu: false` ist in
   [`src-tauri/web/editor/mount.ts:169`](../src-tauri/web/editor/mount.ts#L169)
   und
   [`src-tauri/web/editor/theme-editor.ts:73`](../src-tauri/web/editor/theme-editor.ts#L73)
   korrekt gesetzt und auch in `editor.bundle.js` enthalten. Die bestehenden
   Mount-Tests prüfen die übergebenen Create-Options jedoch nicht auf diesen
   Wert. Je eine Assertion schützt die I3a-Entscheidung; ein kleiner Test für
   normales Text-Cut/Copy/Paste kann zusätzlich bestätigen, dass nur das
   Kontextmenü und keine Tastaturfunktion entfernt wurde.

4. **Die deutsche Zeichenäquivalenz als Regressionstest festhalten.** Für
   Zähler ungleich 1 sind Trennzeichen, Leerzeichen und Wortlaut der
   Wortstatistik exakt wie zuvor; bei 1 entstehen die von der Spec geforderten
   Singularformen. Die E2E-`sample.md` ergibt im Produktionsalgorithmus 35
   Zeilen (inklusive Segment nach dem finalen Newline), 95 Wörter und 611
   JS-Zeichen, daher
   bleibt die sichtbare Statuszeile der bestehenden View-/Edit-Screenshots
   unverändert. Ein exakter de-Assertionfall mit dieser Fixtureform wäre
   aussagekräftiger als die heutigen `toContain`-Checks in
   [`src-tauri/web/tests/state/document.test.ts:95`](../src-tauri/web/tests/state/document.test.ts#L95).

## Nice-to-have

1. **Die derzeit ungenutzte Cross-Bundle-Surface entfernen oder ihren Vertrag
   testen.** `window.FolioI18n` wird erst nach erfolgreichem `initI18n` gesetzt
   ([`src-tauri/web/app/main.ts:351`](../src-tauri/web/app/main.ts#L351)), aber
   kein Modul unter `web/editor/` liest sie. Die sichtbare `Plain Text`-
   Übersetzung wird stattdessen race-sicher im App-Bundle nach dem Ready-Gate
   überschrieben
   ([`src-tauri/web/app/ui/language-picker.ts:21`](../src-tauri/web/app/ui/language-picker.ts#L21)).
   Aktuell entstehen dadurch weder rohe Keys noch ein `app/`-Import im
   Editor-Bundle; `FolioI18nSurface` in
   [`src-tauri/web/globals.d.ts:112`](../src-tauri/web/globals.d.ts#L112) ist
   aber tote, missverständliche API. Falls sie für spätere Editor-Strings
   bleiben soll, braucht sie einen dokumentierten deutschen Pre-Init-Fallback
   und einen Mount-vor-Init-Test.

2. Falls `errors.view.imageConvertUnavailable` entgegen der Map doch im
   Katalog bleiben soll, sollte der deutsche Text in
   [`src-tauri/locales/de.json:104`](../src-tauri/locales/de.json#L104)
   `verfügbar` statt des übernommenen Entwickler-Literals `verfuegbar`
   verwenden.

## Für gut befunden

- **Plural-Komposition im Produktionscode:** Die Wortstatistik verwendet die
  drei geforderten unabhängigen Segmente und den Template-Key exakt nach Spec
  ([`src-tauri/web/app/state/document.ts:136`](../src-tauri/web/app/state/document.ts#L136)).
  `running`, `empty`, `done` und der Skip-Suffix der Vault-Suche verwenden die
  vorgesehenen Segmente; `elapsedMs` läuft korrekt über `fmtNumber`
  ([`src-tauri/web/app/vault/search.ts:320`](../src-tauri/web/app/vault/search.ts#L320),
  [`search.ts:339`](../src-tauri/web/app/vault/search.ts#L339)).

- **Sichere DOM-Konstruktion im Kontextmenü und Empty-State:** Kontextmenü-
  Labels werden als DOM-Nodes mit `textContent` gebaut; `innerHTML` enthält nur
  statische SVG-Konstanten
  ([`src-tauri/web/app/vault/context-menu.ts:37`](../src-tauri/web/app/vault/context-menu.ts#L37)).
  Der Papierkorb-Dialog interpoliert den Dateinamen und übergibt ihn an
  `showConfirmDialog`, das `textContent` nutzt
  ([`context-menu.ts:297`](../src-tauri/web/app/vault/context-menu.ts#L297),
  [`src-tauri/web/app/ui/dialogs.ts:113`](../src-tauri/web/app/ui/dialogs.ts#L113)).
  Auch der Vault-Empty-State wurde korrekt auf DOM-Nodes umgestellt
  ([`src-tauri/web/app/vault/tree.ts:237`](../src-tauri/web/app/vault/tree.ts#L237)).

- **Editor-Bundle-Grenze und Mount-Reihenfolge:** Unter `src-tauri/web/editor/`
  gibt es keinen Import aus `app/`. Die einzige lokalisierte Editor-Shell-
  Anzeige (`Plain Text`) liegt im App-Bundle und wird erst nach `initI18n` und
  vor den Modul-Inits aufgelöst. Das isolierte Editor-Bundle zeigt daher bei
  frühem Laden keine rohen Katalog-Keys.

- **Monaco-Kontextmenüs:** Haupteditor und Theme-Editor setzen
  `contextmenu: false`; Code- und Diff-View hatten dies bereits. Es wurde kein
  Cut-/Copy-/Paste-Keybinding entfernt. Monacos eingebaute Tastaturbearbeitung
  bleibt erhalten; der Folio-Paste-Handler greift nur Bild-Pastes ab und lässt
  Text-Paste unverändert.

- **Katalog-Gates:** de/en/fr haben identische Key-Mengen, Werttypen,
  Platzhalter und erlaubte Pluralzweige; Sortierung und Referenz-Gate sind
  grün. Alle 372 englischen Keys sind referenziert, tote Keys: 0. Die oben
  genannten französischen semantischen Fehler werden von diesen strukturellen
  Gates erwartungsgemäß nicht erkannt.

- **Keine Text-Regression in Lifecycle-Pfaden:** `seq`-Stale-Checks,
  `commitLifecycleSeq`, Tab-ID-Validierung und die
  `folio-doc-kind-changed`-Dispatch-Kette sind gegenüber HEAD unverändert.
  Die Statuszeilen-Updatepfade ersetzen Literale durch `t()`/`tPlural()`, ohne
  Kontrollfluss oder Reihenfolge zu ändern.

- **Ausgeführte Checks (kein E2E gemäß Auftrag):** `npm run typecheck` grün;
  `npm test` grün (37 Dateien, 335 Tests; mit den unter Empfehlungen genannten
  Missing-Key-Warnungen); `cargo test i18n::tests` grün (82 Tests);
  `cargo test --test i18n_ref -- --nocapture` grün (5 Tests, 372/372 Keys,
  0 tote Keys); `git diff --check HEAD` grün. Kein Build, kein E2E und kein
  Commit wurden ausgeführt.
