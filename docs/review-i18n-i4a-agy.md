# Diff-Review: Etappe I4a (native Dialoge, Built-ins, Export)

Hier sind die Ergebnisse des i18n-Diff-Reviews für Etappe I4a.

## Blocker

### 1. Validierungsfehler bei Cover-Platzhaltern für Custom- und KI-Themes
* **Ort:** [src-tauri/src/theme/template.rs:16](file:///home/ralf/dev/folio/src-tauri/src/theme/template.rs#L16) / [src-tauri/src/theme/author.rs:335](file:///home/ralf/dev/folio/src-tauri/src/theme/author.rs#L335)
* **Problem:** In `template::WHITELIST` wurden die neuen Cover-Labels `"createdBy"` und `"preparedBy"` in CamelCase hinzugefügt. Die Theme-Validierung in `author.rs` führt jedoch einen kleingeschriebenen Abgleich durch:
  ```rust
  if !template::WHITELIST.contains(&caps.to_ascii_lowercase().as_str()) {
  ```
  Da `"createdby"` und `"preparedby"` nicht in `WHITELIST` enthalten sind, schlägt die Validierung jedes neu erstellten Themes fehl, das diese Platzhalter verwendet, und wirft den Fehler `coverHtml: unbekannter Platzhalter '{{createdBy}}'`.
* **Empfohlene Lösung:** Die Einträge in `template::WHITELIST` in Kleinschreibung definieren (`"createdby"` und `"preparedby"`).

### 2. Grammatikalisch inkorrekte französische Übersetzung für `report`
* **Ort:** [src-tauri/tests/fixtures/locales/fr.json:472](file:///home/ralf/dev/folio/src-tauri/tests/fixtures/locales/fr.json#L472)
* **Problem:** Die französische Beschreibung des Themes `report` lautet:
  `"Mise en page de rapport formelle avec élégantes serifs et structure traditionnelle."`
  * "serif" ist im Französischen maskulin (le sérif / les sérifs), daher ist das Adjektiv "élégantes" (feminin) falsch. Zudem wird im selben File für `classic` der korrektere Begriff "empattements" verwendet.
* **Empfohlene Lösung:** Ändern in `"Mise en page de rapport formelle avec d'élégants sérifs et une structure traditionnelle."` oder `"Mise en page de rapport formelle avec d'élégants empattements et une structure traditionnelle."`.

---

## Empfehlungen

### 1. Hardcodiertes deutsches String-Literal in Export-Vorschau
* **Ort:** [src-tauri/src/export.rs:55](file:///home/ralf/dev/folio/src-tauri/src/export.rs#L55)
* **Problem:** Wenn `parts.manifest.name` leer ist, fällt der Dokumenttitel bei der Vorschau hart auf das deutsche Literal `"Theme-Vorschau"` zurück. Dies wird in fremdsprachigen Versionen nicht übersetzt.
* **Empfohlene Lösung:** Das Literal lokalisieren, z. B. über den bestehenden Key `theme.editor.preview.tooltip` (`crate::i18n::t("theme.editor.preview.tooltip")`) oder einen neuen Key einführen.

### 2. Unpassende französische Übersetzung für "Proofread"
* **Ort:** [src-tauri/tests/fixtures/locales/fr.json:22](file:///home/ralf/dev/folio/src-tauri/tests/fixtures/locales/fr.json#L22)
* **Problem:** Der Name der KI-Aktion "Proofread" ist auf Französisch mit `"Relire"` übersetzt. Dies bedeutet jedoch "erneut lesen" (reread).
* **Empfohlene Lösung:** Nutzen von `"Correction"` oder `"Relecture"` (bzw. `"Relecture orthographique"`).

---

## Nice-to-have

### 1. Hölzerne englische Übersetzung für `business`-Theme-Beschreibung
* **Ort:** [src-tauri/locales/en.json:450](file:///home/ralf/dev/folio/src-tauri/locales/en.json#L450)
* **Problem:** Die Beschreibung beginnt mit `"Serious corporate theme..."`. Im Englischen klingt "Serious" für Themes hölzern. "Professional" wäre flüssiger.
* **Empfohlene Lösung:** Ändern in `"Professional corporate theme..."`.

---

## Für gut befunden

* **Lokalisierung der Linux-Icon-Integration:** [src-tauri/src/commands/app/icon_integration.rs](file:///home/ralf/dev/folio/src-tauri/src/commands/app/icon_integration.rs) hat alle Dialog-Titel, Bestätigungsmeldungen und Buttons über Catalog-Keys (`dialogs.icon.*`) erfolgreich ausgelagert. Die verbleibenden deutschen Strings sind reine Error-Meldungen, die vertragsgemäß erst in Etappe I4b übersetzt werden.
* **Date-Fallback für Exporte:** [src-tauri/src/i18n/mod.rs](file:///home/ralf/dev/folio/src-tauri/src/i18n/mod.rs) (`format_export_date`) implementiert die länderspezifische Datumsformatierung für de, en, fr und andere sauber und ist mit Unit-Tests abgedeckt.
* **Validierung der Templates & HTML-Struktur:** Die Platzhalter `{{createdBy}}` und `{{preparedBy}}` in den Cover-Templates `brand.cover.html` und `business.cover.html` sind syntaktisch korrekt und das HTML ist fehlerfrei.
* **Allowlist-Sauberkeit:** Die Einträge in [src-tauri/tests/i18n_ref_allowlist.txt](file:///home/ralf/dev/folio/src-tauri/tests/i18n_ref_allowlist.txt) sind präzise auf die zusammengesetzten Keys eingegrenzt und begründet.
