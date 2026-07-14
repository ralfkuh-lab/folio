# i18n String-Surface- und Key-Map (Etappe I0)

Dieses Dokument ist die **verbindliche I0-Arbeits-Checkliste** (Spec v3.1). Keys folgen der Naming-Konvention: englische Funktions-Keys, camelCase, kanonische Namespaces (kein `common.*` außer `dialogs.common.*`), Rollen-Qualifier, `errors.<modul>.<fall>`. False-Positives bleiben als Zeile mit `OUT-OF-SCOPE: …` stehen.

## src-tauri/dist/index.html

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/dist/index.html)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Wrapper | Bemerkung |
| :--- | :--- | :--- | :--- | :---: | :--- |
| 6 | `Folio` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 24 | `Zurück (Alt+←)` | title | `toolbar.back.tooltip` | nein | HTML attribute title |
| 24 | `Zurück` | aria-label | `toolbar.back.ariaLabel` | nein | HTML attribute aria-label |
| 25 | `Vorwärts (Alt+→)` | title | `toolbar.forward.tooltip` | nein | HTML attribute title |
| 25 | `Vorwärts` | aria-label | `toolbar.forward.ariaLabel` | nein | HTML attribute aria-label |
| 29 | `View (Ctrl+1)` | title | `toolbar.modeView.tooltip` | nein | HTML attribute title |
| 29 | `Anzeigen` | aria-label | `toolbar.modeView.ariaLabel` | nein | HTML attribute aria-label |
| 30 | `Edit (Ctrl+2)` | title | `toolbar.modeEdit.tooltip` | nein | HTML attribute title |
| 30 | `Bearbeiten` | aria-label | `toolbar.modeEdit.ariaLabel` | nein | HTML attribute aria-label |
| 31 | `Split (Ctrl+3)` | title | `toolbar.modeSplit.tooltip` | nein | HTML attribute title |
| 31 | `Geteilte Ansicht` | aria-label | `toolbar.modeSplit.ariaLabel` | nein | HTML attribute aria-label |
| 35 | `Speichern (Ctrl+S)` | title | `toolbar.save.tooltip` | nein | HTML attribute title |
| 35 | `Speichern` | aria-label | `toolbar.save.ariaLabel` | nein | HTML attribute aria-label |
| 39 | `Fett (Ctrl+B)` | title | `toolbar.bold.tooltip` | nein | HTML attribute title |
| 40 | `Kursiv (Ctrl+I)` | title | `toolbar.italic.tooltip` | nein | HTML attribute title |
| 41 | `Durchgestrichen` | title | `toolbar.strike.tooltip` | nein | HTML attribute title |
| 45 | `Überschrift (zyklisch H1/H2/H3)` | title | `toolbar.heading.tooltip` | nein | HTML attribute title |
| 46 | `Aufzählung` | title | `toolbar.bulletList.tooltip` | nein | HTML attribute title |
| 47 | `Nummerierte Liste` | title | `toolbar.orderedList.tooltip` | nein | HTML attribute title |
| 51 | `Link (Ctrl+K)` | title | `toolbar.link.tooltip` | nein | HTML attribute title |
| 52 | `Bild einfügen` | title | `toolbar.image.tooltip` | nein | HTML attribute title |
| 53 | `Tabelle einfügen` | title | `toolbar.table.tooltip` | nein | HTML attribute title |
| 54 | `Inline-Code` | title | `toolbar.inlineCode.tooltip` | nein | HTML attribute title |
| 55 | `Codeblock` | title | `toolbar.codeBlock.tooltip` | nein | HTML attribute title |
| 59 | `Markdown Cheat-Sheet` | title | `toolbar.cheatsheet.tooltip` | nein | HTML attribute title |
| 59 | `Hilfe` | aria-label | `toolbar.cheatsheet.ariaLabel` | nein | HTML attribute aria-label |
| 63 | `Datei extern geändert — neuladen` | title | `toolbar.reload.tooltip` | nein | HTML attribute title |
| 63 | `Neuladen` | aria-label | `toolbar.reload.ariaLabel` | nein | HTML attribute aria-label |
| 66 | `Exportieren…` | title | `toolbar.export.tooltip` | nein | HTML attribute title |
| 66 | `Exportieren` | aria-label | `toolbar.export.ariaLabel` | nein | HTML attribute aria-label |
| 67 | `Mit KI übersetzen…` | title | `toolbar.aiTranslate.tooltip` | nein | HTML attribute title |
| 67 | `Mit KI übersetzen` | aria-label | `toolbar.aiTranslate.ariaLabel` | nein | HTML attribute aria-label |
| 68 | `KI-Aktionen…` | title | `toolbar.aiActions.tooltip` | nein | HTML attribute title |
| 68 | `KI-Aktionen` | aria-label | `toolbar.aiActions.ariaLabel` | nein | HTML attribute aria-label |
| 69 | `KI-Aktions-Favoriten` | title | `toolbar.aiActionsMenu.tooltip` | nein | HTML attribute title |
| 69 | `KI-Aktions-Favoriten` | aria-label | `toolbar.aiActionsMenu.ariaLabel` | nein | HTML attribute aria-label |
| 73 | `Suchen (Ctrl+F)` | title | `toolbar.find.tooltip` | nein | HTML attribute title |
| 73 | `Suchen` | aria-label | `toolbar.find.ariaLabel` | nein | HTML attribute aria-label |
| 74 | `Linke Leiste umschalten` | title | `toolbar.railLeft.tooltip` | nein | HTML attribute title |
| 74 | `Linke Leiste` | aria-label | `toolbar.railLeft.ariaLabel` | nein | HTML attribute aria-label |
| 75 | `Minimap umschalten` | title | `toolbar.minimap.tooltip` | nein | HTML attribute title |
| 75 | `Minimap` | aria-label | `toolbar.minimap.ariaLabel` | nein | HTML attribute aria-label |
| 76 | `Rechte Leiste umschalten` | title | `toolbar.railRight.tooltip` | nein | HTML attribute title |
| 76 | `Rechte Leiste` | aria-label | `toolbar.railRight.ariaLabel` | nein | HTML attribute aria-label |
| 80 | `Einstellungen` | title | `toolbar.settings.tooltip` | nein | HTML attribute title |
| 80 | `Einstellungen` | aria-label | `toolbar.settings.ariaLabel` | nein | HTML attribute aria-label |
| 85 | `Arbeitsbereich` | textNode | `vault.header.title` | nein | HTML text node |
| 86 | `Datei öffnen…` | title | `vault.header.openFile.tooltip` | nein | HTML attribute title |
| 86 | `Datei öffnen` | aria-label | `vault.header.openFile.ariaLabel` | nein | HTML attribute aria-label |
| 87 | `Ordner hinzufügen…` | title | `vault.header.addFolder.tooltip` | nein | HTML attribute title |
| 87 | `Ordner hinzufügen` | aria-label | `vault.header.addFolder.ariaLabel` | nein | HTML attribute aria-label |
| 91 | `Im Vault suchen…` | placeholder | `vault.search.placeholder` | nein | HTML attribute placeholder |
| 91 | `Im Vault suchen` | aria-label | `vault.search.ariaLabel` | nein | HTML attribute aria-label |
| 92 | `Groß-/Kleinschreibung beachten` | title | `vault.search.caseSensitive.tooltip` | nein | HTML attribute title |
| 92 | `Groß-/Kleinschreibung beachten` | aria-label | `vault.search.caseSensitive.ariaLabel` | nein | HTML attribute aria-label |
| 92 | `Aa` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 93 | `Ganzes Wort` | title | `vault.search.wholeWord.tooltip` | nein | HTML attribute title |
| 93 | `Ganzes Wort` | aria-label | `vault.search.wholeWord.ariaLabel` | nein | HTML attribute aria-label |
| 105 | `Offene Dokumente` | aria-label | `tabs.bar.ariaLabel` | nein | HTML attribute aria-label |
| 108 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 112 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 116 | `Suchen…` | placeholder | `find.bar.placeholder` | nein | HTML attribute placeholder |
| 118 | `Zurück (Shift+Enter)` | title | `find.bar.prev.tooltip` | nein | HTML attribute title |
| 119 | `Weiter (Enter)` | title | `find.bar.next.tooltip` | nein | HTML attribute title |
| 120 | `Optionen` | title | `find.bar.options.tooltip` | nein | HTML attribute title |
| 121 | `Schließen (Esc)` | title | `find.bar.close.tooltip` | nein | HTML attribute title |
| 124 | `Aa Groß-/Kleinschreibung` | textNode | `find.options.caseSensitive.label` | ja | HTML text node |
| 125 | `Ganzes Wort` | textNode | `find.options.wholeWord.label` | ja | HTML text node |
| 156 | `Einstellungen` | textNode | `settings.title` | nein | HTML text node |
| 158 | `Einstellungsbereiche` | aria-label | `settings.nav.ariaLabel` | nein | HTML attribute aria-label |
| 159 | `Allgemein` | textNode | `settings.nav.general` | nein | HTML text node |
| 160 | `Markdown-Themes` | textNode | `settings.nav.themes` | nein | HTML text node |
| 161 | `KI-Anbieter` | textNode | `settings.nav.aiProviders` | nein | HTML text node |
| 162 | `KI-Modelle` | textNode | `settings.nav.aiModels` | nein | HTML text node |
| 163 | `Diagnose` | textNode | `settings.nav.diagnostics` | nein | HTML text node |
| 167 | `Allgemein` | textNode | `settings.nav.general` | nein | HTML text node |
| 169 | `Sprache` | textNode | `settings.language.label` | nein | HTML text node |
| 170 | `System` / Registry-Optionen | select options | `settings.language.system` (+ `@meta.name` pro Tag) | — | **dynamisch** via `populateLanguageOptions` aus Registry; kein hartkodiertes Options-HTML mehr |
| — | `{tag} (unbekannt)` | select option | `settings.language.unknown` | — | **dynamisch** in `syncLanguageSelect` bei unbekanntem persistiertem Tag |
| — | Fallback-Hinweis unbekannter Tag | hint text | `settings.language.unknownHint` | — | **dynamisch** — nur im Unknown-Fall statt des Neustart-Hinweises |
| 171 | `Deutsch` | textNode | `ENTFALLEN: Registry-Select` | — | ehem. `settings.language.optionDe`; Optionen kommen aus Katalog-`@meta.name` |
| 172 | `English` | textNode | `ENTFALLEN: Registry-Select` | — | ehem. `settings.language.optionEn`; Optionen kommen aus Katalog-`@meta.name` |
| 175 | `Sprachänderung wird beim nächsten Start aktiv.` | textNode | `settings.language.hint` | nein | HTML text node (+ dynamisch via `t()` bei bekanntem Tag) |
| 178 | `View-/Edit-Mode` | textNode | `settings.mode.sectionTitle` | nein | HTML text node |
| 180 | `Markdown-Dateien öffnen in` | textNode | `settings.mode.markdownOpenIn.label` | nein | HTML text node |
| 182 | `Anzeige` | textNode | `settings.mode.optionView` | nein | HTML text node |
| 183 | `Bearbeiten` | textNode | `settings.mode.optionEdit` | nein | HTML text node |
| 184 | `Aktueller Modus` | textNode | `settings.mode.optionCurrent` | nein | HTML text node |
| 188 | `Text-/Code-Dateien öffnen in` | textNode | `settings.mode.textOpenIn.label` | nein | HTML text node |
| 190 | `Anzeige` | textNode | `settings.mode.optionView` | nein | HTML text node |
| 191 | `Bearbeiten` | textNode | `settings.mode.optionEdit` | nein | HTML text node |
| 192 | `Aktueller Modus` | textNode | `settings.mode.optionCurrent` | nein | HTML text node |
| 195 | `„Aktueller Modus" behält den aktuell aktiven View/Edit-Status beim Öffnen einer neuen Datei. Zurück/Vorwärts stellt unabhängig davon den ursprünglichen Modus wieder her.` | textNode | `settings.mode.optionCurrent.hint` | nein | HTML text node |
| 199 | `Im View-Mode automatisch formatieren` | textNode | `settings.viewAutoFormat.label` | ja | Checkbox-Label (Nicht-Leaf-`<label>`) |
| 202 | `Nutzt Monacos „Format Document" für alle Sprachen mit registriertem Formatter (JSON, XML, HTML, CSS, JS/TS, …). Ohne Häkchen wird der Rohinhalt angezeigt.` | textNode | `settings.viewAutoFormat.hint` | nein | HTML text node |
| 205 | `Export` | textNode | `settings.export.sectionTitle` | nein | HTML text node |
| 207 | `Export-Zielverzeichnis` | textNode | `settings.export.dirMode.label` | nein | HTML text node |
| 209 | `Verzeichnis der Datei` | textNode | `settings.export.dirMode.optionFileDir` | nein | HTML text node |
| 210 | `Zuletzt gewähltes Verzeichnis` | textNode | `settings.export.dirMode.optionLastDir` | nein | HTML text node |
| 215 | `Tabs` | textNode | `settings.tabs.sectionTitle` | nein | HTML text node |
| 217 | `Extern geöffnete Dateien` | textNode | `settings.tabs.openFileTarget.label` | nein | HTML text node |
| 219 | `In neuem Tab öffnen` | textNode | `settings.tabs.openFileTarget.optionNewTab` | nein | HTML text node |
| 220 | `Aktuellen Tab ersetzen` | textNode | `settings.tabs.openFileTarget.optionReplace` | nein | HTML text node |
| 223 | `Gilt für Dateien, die per Explorer-Doppelklick oder Kommandozeile in der laufenden Instanz geöffnet werden.` | textNode | `settings.tabs.openFileTarget.hint` | nein | HTML text node |
| 226 | `Datei-Überwachung` | textNode | `settings.watch.sectionTitle` | nein | HTML text node |
| 230 | `Vault-Tree bei externen Änderungen aktualisieren` | textNode | `settings.watch.vaultAutoRefresh.label` | ja | Checkbox-Label |
| 233 | `Aufgeklappte Ordner werden überwacht; neue, gelöschte oder umbenannte Dateien tauchen direkt im Arbeitsbereich auf.` | textNode | `settings.watch.vaultAutoRefresh.hint` | nein | HTML text node |
| 237 | `Geöffnete Datei bei externer Änderung neuladen` | textNode | `settings.watch.reloadOnExternal.label` | ja | Checkbox-Label |
| 240 | `Ohne Häkchen erscheint stattdessen ein Reload-Button in der Toolbar — sinnvoll für Log-Dateien o. ä. mit ständigen Schreibvorgängen.` | textNode | `settings.watch.reloadOnExternal.hint` | nein | HTML text node |
| 246 | `Markdown-Themes` | textNode | `settings.nav.themes` | nein | HTML text node |
| 248 | `Theme importieren…` | textNode | `settings.themes.import.action` | nein | HTML text node |
| 249 | `Neues Theme` | textNode | `settings.themes.create.action` | nein | HTML text node |
| 253 | `Markdown-Theme` | aria-label | `settings.themes.list.ariaLabel` | nein | HTML attribute aria-label |
| 261 | `Theme erstellen` | textNode | `settings.themes.createDialog.title` | nein | HTML text node |
| 262 | `ID-Slug` | textNode | `theme.editor.manifest.idSlug.label` | nein | HTML text node |
| 264 | `Nur Kleinbuchstaben, Zahlen, - und _` | textNode | `theme.editor.manifest.idSlug.hint` | nein | HTML text node |
| 265 | `Anzeigename` | textNode | `theme.editor.manifest.displayName.label` | nein | HTML text node (Key-Korrektur I2: getrennt von `name.label`) |
| 267 | `Basis-Theme` | textNode | `settings.themes.createDialog.base.label` | nein | HTML text node |
| 271 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 272 | `Erstellen` | textNode | `settings.themes.createDialog.submit.action` | nein | HTML text node |
| 278 | `Theme löschen` | textNode | `settings.themes.deleteDialog.title` | nein | HTML text node |
| 279 | `Theme wirklich löschen?` | textNode | `settings.themes.deleteDialog.confirm` | nein | HTML text node |
| 281 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 282 | `Löschen` | textNode | `settings.themes.deleteDialog.submit.action` | nein | HTML text node |
| 289 | `KI-Anbieter` | textNode | `settings.nav.aiProviders` | nein | HTML text node |
| 290 | `Schlüssel liegen im Klartext in` | textNode | `settings.ai.providers.securityHint.prefix` | nein | HTML text node |
| 290 | `auth.json` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 290 | `im Config-Verzeichnis (Dateirechte 0600).` | textNode | `settings.ai.providers.securityHint.suffix` | nein | HTML text node |
| 292 | `Anbieter suchen…` | placeholder | `settings.ai.providers.search.placeholder` | nein | HTML attribute placeholder |
| 293 | `Anbieter hinzufügen` | textNode | `settings.ai.providers.add.action` | nein | HTML text node |
| 295 | `Die vordefinierten Anbieter stammen aus dem` | textNode | `settings.ai.providers.catalogHint.prefix` | nein | HTML text node |
| 295 | `models.dev` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 295 | `-Katalog; aktualisieren lässt er sich im Reiter „KI-Modelle“. Eigene (OpenAI-kompatible) Anbieter lassen sich über „Anbieter hinzufügen“ ergänzen.` | textNode | `settings.ai.providers.catalogHint.suffix` | nein | HTML text node |
| 301 | `Anbieter hinzufügen` | textNode | `settings.ai.providers.addDialog.title` | nein | HTML text node |
| 302 | `ID` | textNode | `settings.ai.providers.addDialog.id.label` | nein | HTML text node |
| 304 | `Nur Kleinbuchstaben, Zahlen, - und _` | textNode | `theme.editor.manifest.idSlug.hint` | nein | HTML text node |
| 305 | `Anzeigename` | textNode | `theme.editor.manifest.displayName.label` | nein | HTML text node (Key-Korrektur I2) |
| 307 | `Basis-URL` | textNode | `settings.ai.providers.addDialog.baseUrl.label` | nein | HTML text node |
| 308 | `http://localhost:11434/v1` | placeholder | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML attribute placeholder |
| 309 | `OpenAI-kompatibler Endpoint.` | textNode | `settings.ai.providers.addDialog.baseUrl.hint` | nein | HTML text node |
| 310 | `Schlüssel (optional)` | textNode | `settings.ai.providers.addDialog.apiKey.label` | nein | HTML text node |
| 314 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 315 | `Speichern` | textNode | `dialogs.common.save` | nein | HTML text node |
| 323 | `Provider oder Modell suchen…` | placeholder | `settings.ai.models.search.placeholder` | nein | HTML attribute placeholder |
| 324 | `Lädt den Anbieter- und Modellkatalog der vordefinierten Cloud-Provider neu von models.dev.` | title | `settings.ai.models.refreshCatalog.tooltip` | nein | HTML attribute title |
| 324 | `Anbieter-/Modellkatalog aktualisieren` | textNode | `settings.ai.models.refreshCatalog.action` | nein | HTML text node |
| 326 | `Lädt Anbieter- und Modellliste der vordefinierten Cloud-Provider von` | textNode | `settings.ai.models.catalogHint.prefix` | nein | HTML text node |
| 326 | `models.dev` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 326 | `. Modelle eigener Anbieter holst du im jeweiligen Anbieter über „Modelle abrufen“.` | textNode | `settings.ai.models.catalogHint.suffix` | nein | HTML text node |
| 330 | `Default-Modell` | textNode | `settings.ai.defaultModel.label` | nein | HTML text node |
| 332 | `(keins)` | textNode | `settings.ai.defaultModel.none` | nein | HTML text node |
| 341 | `Modell testen` | textNode | `settings.ai.models.test.action` | nein | HTML text node |
| 345 | `Testnachricht` | aria-label | `settings.ai.models.testInput.ariaLabel` | nein | HTML attribute aria-label |
| 347 | `Schließen` | textNode | `dialogs.common.close` | nein | HTML text node |
| 348 | `Senden` | textNode | `settings.ai.models.testSend.action` | nein | HTML text node |
| 355 | `Diagnose` | textNode | `settings.nav.diagnostics` | nein | HTML text node |
| 357 | `Log-Level` | textNode | `settings.diagnostics.logLevel.label` | nein | HTML text node |
| 359 | `Aus (keine Logdateien)` | textNode | `settings.diagnostics.logLevel.optionOff` | nein | HTML text node |
| 360 | `Nur Fehler` | textNode | `settings.diagnostics.logLevel.optionError` | nein | HTML text node |
| 361 | `Warnungen + Fehler` | textNode | `settings.diagnostics.logLevel.optionWarn` | nein | HTML text node |
| 362 | `Normal (empfohlen)` | textNode | `settings.diagnostics.logLevel.optionInfo` | nein | HTML text node |
| 363 | `Debug (ausführlich)` | textNode | `settings.diagnostics.logLevel.optionDebug` | nein | HTML text node |
| 366 | `Logs landen rotierend (täglich, max. 7 Tage) im OS-Log-Verzeichnis (Windows:` | textNode | `settings.diagnostics.logsHint.prefix` | nein | HTML text node |
| 366 | `%LOCALAPPDATA%\Folio\logs` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 366 | `). Änderung greift sofort. Während der Entwicklung überschreibt` | textNode | `settings.diagnostics.logsHint.mid` | nein | HTML text node |
| 366 | `RUST_LOG` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 366 | `und der Debug-Build immer auf` | textNode | `settings.diagnostics.logsHint.suffix` | nein | HTML text node |
| 366 | `debug` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | nein | HTML text node |
| 371 | `Schließen` | textNode | `dialogs.common.close` | nein | HTML text node |
| 377 | `Theme-Datei` | aria-label | `theme.editor.fileInput.ariaLabel` | nein | HTML attribute aria-label |
| 380 | `Dunkle Vorschau` | textNode | `theme.editor.darkPreview.label` | ja | Toolbar-Toggle-Label |
| 383 | `Mit KI anpassen…` | textNode | `theme.editor.aiCustomize.action` | nein | HTML text node |
| 384 | `Speichern` | textNode | `dialogs.common.save` | nein | HTML text node |
| 385 | `Schließen` | textNode | `dialogs.common.close` | nein | HTML text node |
| 391 | `Manifest` | textNode | `theme.editor.manifest.sectionTitle` | nein | HTML text node |
| 393 | `Name` | textNode | `theme.editor.manifest.name.label` | nein | HTML text node (Theme-Editor-Manifest; nicht displayName) |
| 395 | `Beschreibung` | textNode | `theme.editor.manifest.description.label` | nein | HTML text node |
| 397 | `Body-Font` | textNode | `theme.editor.manifest.fontBody.label` | nein | HTML text node |
| 399 | `Mono-Font` | textNode | `theme.editor.manifest.fontMono.label` | nein | HTML text node |
| 401 | `Schriftgröße` | textNode | `theme.editor.manifest.fontSize.label` | nein | HTML text node |
| 428 | `Frontmatter im Body verbergen` | textNode | `theme.editor.flags.hideFrontmatter.label` | ja | Checkbox-Label |
| 423 | `Cover` | textNode | `theme.editor.flags.cover.label` | ja | HTML text node |
| 424 | `Kopfzeile` | textNode | `theme.editor.flags.header.label` | ja | HTML text node |
| 425 | `Fußzeile` | textNode | `theme.editor.flags.footer.label` | ja | HTML text node |
| 432 | `Assets` | textNode | `theme.editor.assets.sectionTitle` | nein | HTML text node |
| 433 | `Asset hinzufügen; das erste Bild wird als Logo verwendet` | title | `theme.editor.assets.add.tooltip` | nein | HTML attribute title |
| 435 | `＋ Hochladen` | textNode | `theme.editor.assets.upload.action` | nein | HTML text node |
| 439 | `Manifest-Logo:` | textNode | `theme.editor.manifest.logo.label` | nein | HTML text node (I2 nachgezogen) |
| 441 | `(kein)` | textNode | `theme.editor.assets.logo.none` | nein | HTML text node |
| 442 | `zurücksetzen` | textNode | `theme.editor.assets.logo.reset.action` | nein | HTML text node |
| 446 | `Theme-Vorschau` | title | `theme.editor.preview.tooltip` | nein | HTML attribute title |
| 450 | `Mit KI anpassen` | textNode | `theme.editor.aiDialog.title` | nein | HTML text node |
| 452 | `Prompt` | textNode | `ai.prompt.label` | nein | HTML text node |
| 453 | `z. B. Ein elegantes Theme mit neongrünen Akzenten für Programmierer...` | placeholder | `theme.editor.aiDialog.prompt.placeholder` | nein | HTML attribute placeholder |
| 456 | `Modell` | textNode | `ai.model.label` | nein | HTML text node |
| 460 | `Warte auf KI...` | textNode | `theme.editor.aiDialog.status.waiting` | nein | HTML text node |
| 464 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 465 | `Starten` | textNode | `theme.editor.aiDialog.start.action` | nein | HTML text node |
| 472 | `✨ KI-Review` | textNode | `ai.diffReview.titlePlain` | nein | HTML text node |
| 475 | `Verwerfen` | textNode | `dialogs.common.discard` | nein | HTML text node |
| 476 | `Übernehmen` | textNode | `ai.diffReview.apply.action` | nein | HTML text node |
| 483 | `Inhaltsverzeichnis` | textNode | `view.toc.title` | nein | HTML text node |
| 487 | `Bereit` | textNode | `statusBar.ready` | nein | HTML text node |
| 489 | `View` | textNode | `statusBar.modeView` | nein | HTML text node |
| 490 | `Editor-Sprache wählen` | title | `editor.languagePicker.tooltip` | nein | HTML attribute title |
| 490 | `Plain Text` | textNode | `editor.language.plaintext` | nein | HTML text node |
| 491 | `Theme umschalten` | title | `toolbar.themeToggle.tooltip` | nein | HTML attribute title |
| 491 | `Theme` | aria-label | `toolbar.themeToggle.ariaLabel` | nein | HTML attribute aria-label |
| 494 | `Datei hier ablegen, um zu öffnen` | textNode | `view.dropOverlay.message` | nein | HTML text node |
| 498 | `Umbenennen` | textNode | `dialogs.rename.title` | nein | HTML text node |
| 499 | `Neuen Dateinamen eingeben:` | textNode | `dialogs.rename.prompt` | nein | HTML text node |
| 502 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 503 | `Umbenennen` | textNode | `dialogs.rename.submit.action` | nein | HTML text node |
| 510 | `Ungespeicherte Änderungen` | textNode | `dialogs.unsaved.title` | nein | HTML text node |
| 511 | `Die Datei wurde geändert. Änderungen speichern?` | textNode | `dialogs.unsaved.confirm` | nein | HTML text node |
| 513 | `Verwerfen` | textNode | `dialogs.common.discard` | nein | HTML text node |
| 514 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 515 | `Speichern` | textNode | `dialogs.common.save` | nein | HTML text node |
| 522 | `Bestätigen` | textNode | `dialogs.confirm.title` | nein | HTML text node |
| 525 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 526 | `OK` | textNode | `dialogs.common.ok` | nein | HTML text node |
| 533 | `Datei ausführen` | textNode | `dialogs.run.title` | nein | HTML text node |
| 534 | `Diese Datei als Programm ausführen?` | textNode | `dialogs.run.confirm` | nein | HTML text node |
| 536 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 537 | `Ausführen` | textNode | `dialogs.run.submit.action` | nein | HTML text node |
| 544 | `Exportieren` | textNode | `export.dialog.title` | nein | HTML text node |
| 546 | `HTML` | textNode | `export.formats.html` | nein | HTML text node |
| 547 | `PDF` | textNode | `export.formats.pdf` | nein | HTML text node |
| 550 | `✨ KI-Layout für dieses Dokument` | textNode | `export.aiDraft.title` | nein | HTML text node |
| 552 | `Prompt` | textNode | `ai.prompt.label` | nein | HTML text node |
| 553 | `Layout-Stil, Zielgruppe, visuelle Richtung` | placeholder | `export.aiDraft.prompt.placeholder` | nein | HTML attribute placeholder |
| 557 | `Basis-Theme` | textNode | `settings.themes.createDialog.base.label` | ja | Export-KI-Draft-Grid (I2 nachgezogen) |
| 561 | `Modell` | textNode | `ai.model.label` | ja | Export-KI-Draft-Grid (I2 nachgezogen) |
| 564 | `Jeder Lauf sendet das Dokument an den gewählten Anbieter und verursacht Kosten.` | textNode | `export.aiDraft.costHint` | nein | HTML text node |
| 566 | `Bereit.` | textNode | `export.aiDraft.status.ready` | nein | HTML text node |
| 568 | `Starten` | textNode | `export.aiDraft.start.action` | nein | HTML text node |
| 569 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 572 | `Neu generieren` | textNode | `export.aiDraft.regenerate.action` | nein | HTML text node |
| 573 | `Als Theme speichern…` | textNode | `export.aiDraft.saveAsTheme.action` | nein | HTML text node |
| 579 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 580 | `Speichern…` | textNode | `dialogs.common.save` | nein | HTML text node |
| 585 | `KI-Entwurf als Theme speichern` | textNode | `export.aiDraft.saveDialog.title` | nein | HTML text node |
| 586 | `ID-Slug` | textNode | `theme.editor.manifest.idSlug.label` | nein | HTML text node |
| 588 | `Anzeigename` | textNode | `theme.editor.manifest.displayName.label` | nein | HTML text node (Key-Korrektur I2) |
| 592 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 593 | `Speichern` | textNode | `dialogs.common.save` | nein | HTML text node |
| 600 | `Mit KI übersetzen` | textNode | `ai.translate.dialog.title` | nein | HTML text node |
| 602 | `Zielsprachen` | textNode | `ai.translate.targetLangs.label` | nein | HTML text node |
| 603 | `Zielsprachen` | aria-label | `ai.translate.targetLangs.ariaLabel` | nein | HTML attribute aria-label |
| 604 | `Englisch (en)` | textNode | `ai.translate.lang.en` | ja | HTML text node |
| 605 | `Deutsch (de)` | textNode | `ai.translate.lang.de` | ja | HTML text node |
| 606 | `Französisch (fr)` | textNode | `ai.translate.lang.fr` | ja | HTML text node |
| 607 | `Spanisch (es)` | textNode | `ai.translate.lang.es` | ja | HTML text node |
| 608 | `Italienisch (it)` | textNode | `ai.translate.lang.it` | ja | HTML text node |
| 609 | `Portugiesisch (pt)` | textNode | `ai.translate.lang.pt` | ja | HTML text node |
| 610 | `Niederländisch (nl)` | textNode | `ai.translate.lang.nl` | ja | HTML text node |
| 611 | `Polnisch (pl)` | textNode | `ai.translate.lang.pl` | ja | HTML text node |
| 612 | `Japanisch (ja)` | textNode | `ai.translate.lang.ja` | ja | HTML text node |
| 613 | `Chinesisch (zh)` | textNode | `ai.translate.lang.zh` | ja | HTML text node |
| 615 | `Weitere Sprachcodes` | textNode | `ai.translate.extraCodes.label` | nein | HTML text node |
| 616 | `z. B. sv, ko, en-GB` | placeholder | `ai.translate.extraCodes.placeholder` | nein | HTML attribute placeholder |
| 617 | `Kommagetrennte BCP-47- oder ISO-Sprachcodes.` | textNode | `ai.translate.extraCodes.hint` | nein | HTML text node |
| 620 | `Modell` | textNode | `ai.model.label` | nein | HTML text node |
| 625 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 626 | `Übersetzen` | textNode | `ai.translate.submit.action` | nein | HTML text node |
| 630 | `KI-Aktions-Favoriten` | aria-label | `toolbar.aiActionsMenu.ariaLabel` | nein | HTML attribute aria-label |
| 633 | `Als Vorlage speichern` | textNode | `ai.actions.saveTemplate.title` | nein | HTML text node |
| 634 | `Name` | textNode | `ai.actions.saveTemplate.name.label` | nein | HTML text node |
| 636 | `Kürzel (Datei-Suffix)` | textNode | `ai.actions.saveTemplate.slug.label` | nein | HTML text node |
| 637 | `z. B. mein-prompt` | placeholder | `ai.actions.saveTemplate.slug.placeholder` | nein | HTML attribute placeholder |
| 640 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 641 | `Speichern` | textNode | `dialogs.common.save` | nein | HTML text node |
| 647 | `✨ KI-Aktionen` | textNode | `ai.actions.dialog.title` | nein | HTML text node |
| 650 | `Aktion` | textNode | `ai.actions.picker.label` | nein | HTML text node |
| 651 | `KI-Aktionen` | aria-label | `ai.actions.picker.ariaLabel` | nein | HTML attribute aria-label |
| 654 | `Prompt` | textNode | `ai.prompt.label` | nein | HTML text node |
| 657 | `Systemregeln anzeigen` | textNode | `ai.actions.showSystemRules.action` | nein | HTML text node |
| 657–661 | `Fixed system rules (not editable): Return only the…` | textNode | `OUT-OF-SCOPE: englische KI-Systemprompt-Anzeige` | — | `#ai-actions-system-text`; I5 englisch, bewusst un-katalogisiert, spiegelt den Backend-Prompt |
| 664 | `Ziel` | aria-label | `ai.actions.target.ariaLabel` | nein | HTML attribute aria-label |
| 665 | `Ziel` | textNode | `ai.actions.target.label` | nein | HTML text node |
| 666 | `Neue Datei` | textNode | `ai.actions.target.newFile` | ja | HTML text node |
| 667 | `Original ersetzen (mit Diff-Review)` | textNode | `ai.actions.target.replace` | ja | HTML text node |
| 669 | `Bereich` | aria-label | `ai.actions.scope.ariaLabel` | nein | HTML attribute aria-label |
| 670 | `Bereich` | textNode | `ai.actions.scope.label` | nein | HTML text node |
| 671 | `Selektion` | textNode | `ai.actions.scope.selection` | ja | HTML text node |
| 672 | `Ganzes Dokument` | textNode | `ai.actions.scope.document` | ja | HTML text node |
| 674 | `Modell` | textNode | `ai.model.label` | nein | HTML text node |
| 680 | `Als Vorlage speichern…` | textNode | `ai.actions.saveTemplate.action` | nein | HTML text node |
| 682 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 683 | `Ausführen` | textNode | `ai.actions.run.action` | nein | HTML text node |
| 703 | `Ralf Kuhlendahl` | alt | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML attribute alt |
| 703–705 | `Made with ♥ by Ralf Kuhlendahl` | textNode | `OUT-OF-SCOPE: Branding/Autorenzeile` | — | About-Figcaption; bewusst unübersetzt |
| 711 | `Folio` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 712 | `Markdown-Viewer &amp; -Editor` | textNode | `dialogs.about.tagline` | nein | HTML text node |
| 716 | `Version` | textNode | `dialogs.about.version.label` | ja | HTML text node |
| 717 | `Build` | textNode | `dialogs.about.build.label` | ja | HTML text node |
| 718 | `Commit` | textNode | `dialogs.about.commit.label` | ja | HTML text node |
| 719 | `Lizenz` | textNode | `dialogs.about.license.label` | ja | HTML text node |
| 719 | `MIT` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 723 | `github.com/ralfkuh-lab/folio` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 726 | `Folio hilft dir? Ein Dankeschön freut den Autor:` | textNode | `dialogs.about.support.prompt` | nein | HTML text node |
| 730 | `PayPal` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 734 | `Star on GitHub` | textNode | `dialogs.about.support.githubStar` | nein | HTML text node |
| 741 | `GitHub Sponsors` | textNode | `OUT-OF-SCOPE: Markenname/technischer Token` | — | HTML text node |
| 747 | `Built with` | textNode | `dialogs.about.builtWith` | nein | HTML text node |
| 769 | `Schließen` | textNode | `dialogs.common.close` | nein | HTML text node |
| 775 | `Bild einfügen` | textNode | `dialogs.image.title` | nein | HTML text node |
| 777 | `Aus Zwischenablage` | textNode | `dialogs.image.fromClipboard.action` | nein | HTML text node |
| 778 | `Datei wählen…` | textNode | `dialogs.image.chooseFile.action` | nein | HTML text node |
| 781 | `Keine Bildquelle gewählt.` | textNode | `dialogs.image.noSource.status` | nein | HTML text node |
| 785 | `Alt-Text` | textNode | `dialogs.image.altText.label` | nein | HTML text node |
| 788 | `Dateinamen aus Alt-Text ableiten` | title | `dialogs.image.filenameFromAlt.tooltip` | nein | HTML attribute title |
| 790 | `Dateiname` | textNode | `dialogs.image.filename.label` | nein | HTML text node |
| 795 | `Zielordner` | textNode | `dialogs.image.targetDir.label` | nein | HTML text node |
| 798 | `Durchsuchen…` | textNode | `dialogs.image.browse.action` | nein | HTML text node |
| 804 | `Abbrechen` | textNode | `dialogs.common.cancel` | nein | HTML text node |
| 805 | `Einfügen` | textNode | `dialogs.image.insert.action` | nein | HTML text node |
| 810 | `Markdown Cheat-Sheet` | textNode | `cheatsheet.title` | nein | HTML text node |
| 813 | `Editor-Sprache wählen` | aria-label | `editor.languagePicker.ariaLabel` | nein | HTML attribute aria-label |
| 814 | `Sprache suchen…` | placeholder | `editor.languagePicker.search.placeholder` | nein | HTML attribute placeholder |

## src-tauri/src/ai/actions.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/ai/actions.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 67 | `Template-Kürzel` | literal | `ai.actions.template.slug.label` | German string found |
| 68 | `Datei-Suffix` | literal | `ai.actions.template.fileSuffix.label` | German string found |
| 71 | `Der Template-Name muss 1–{NAME_MAX_CHARS} Zeichen lang sein.` | literal | `errors.ai.templateNameLength` | German string found |
| 76 | `Die Template-Beschreibung darf höchstens {DESCRIPTION_MAX_CHARS} Zeichen haben.` | literal | `errors.ai.templateDescriptionLength` | German string found |
| 81 | `Der Template-Prompt muss 1–{PROMPT_MAX_CHARS} Zeichen lang sein.` | literal | `errors.ai.templatePromptLength` | German string found |
| 110 | `Prägnante Zusammenfassung als neues Dokument.` | literal | `ai.actions.summarize.description` | German string found |
| 123 | `Struktur verbessern: Überschriften, Listen, Code-Blöcke, Tabellen.` | literal | `ai.actions.improveStructure.description` | German string found |
| 150 | `Daten/Aufzählungen in eine Markdown-Tabelle umwandeln.` | literal | `ai.actions.toTable.description` | German string found |
| 272 | `Die ID '{}' ist für eine eingebaute Aktion reserviert.` | literal | `errors.ai.builtinIdReserved` | German string found |
| 277 | `Template-Verzeichnis konnte nicht angelegt werden: {error}` | format!( | `errors.ai.templateDirCreateFailed` | Rust error/literal |
| 280 | `Template konnte nicht gespeichert werden: {error}` | format!( | `errors.ai.templateSaveFailed` | Rust error/literal |
| 290 | `Template-Kürzel` | literal | `ai.actions.template.slug.label` | German string found |
| 292 | `Eingebaute Aktionen können nicht gelöscht werden.` | Err( | `errors.ai.builtinActionDelete` | Rust error/literal |
| 299 | `Template '{id}' konnte nicht gelöscht werden: {error}` | literal | `errors.ai.templateDeleteFailed` | German string found |
| 353 | `Der Selektions-Offset ist zu groß.` | literal | `errors.ai.selectionOffsetTooLarge` | German string found |
| 370 | `Die Selektion liegt außerhalb des Dokuments.` | Err( | `errors.ai.selectionOutOfRange` | Rust error/literal |
| 378 | `Die Selektion ist ungültig (Überlauf).` | literal | `errors.ai.selectionInvalid` | German string found |
| 422 | `ümlaut` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 464 | `Ä` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 465 | `Ä😀x` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 480 | `Äx` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 508 | `unverändert` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 605 | `nicht gelöscht` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |

## src-tauri/src/ai/catalog.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/ai/catalog.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 86 | `models.dev-Katalog konnte nicht geladen werden: {0}` | #[error( | `errors.ai.catalogLoadFailed` | Rust error/literal |
| 90 | `models.dev-Katalog enthält ungültiges JSON: {0}` | #[error( | `errors.ai.invalidJson` | Rust error/literal |

## src-tauri/src/ai/client.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/ai/client.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 39 | `Ungültige Provider-Basis-URL: {0}` | #[error( | `errors.ai.invalidBaseUrl` | Rust error/literal |
| 43 | `KI-Anfrage fehlgeschlagen: {0}` | #[error( | `errors.ai.requestFailed` | Rust error/literal |
| 49 | `KI-Antwort enthält ungültiges JSON: {0}` | #[error( | `errors.ai.invalidJson` | Rust error/literal |
| 51 | `KI-Antwort enthält keine Text-Antwort in choices[0]` | #[error( | `errors.ai.emptyChoice` | Rust error/literal |
| 53 | `KI-Übersetzung abgebrochen` | #[error( | `errors.ai.aborted` | Rust error/literal |
| 251 | `Zeitüberschreitung beim Warten auf den nächsten Stream-Chunk` | literal | `errors.ai.streamChunkTimeout` | German string found |
| 563 | `# Übersetzt` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |

## src-tauri/src/ai/config.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/ai/config.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 13 | `Ungültige Provider-ID ` | #[error( | `errors.ai.invalidProviderId` | Rust error/literal |
| 21 | `Provider und Modell müssen entweder beide gesetzt oder beide leer sein` | #[error( | `errors.ai.providerModelPair` | Rust error/literal |
| 23 | `Provider- und Modell-ID dürfen nicht leer sein` | #[error( | `errors.ai.providerModelEmpty` | Rust error/literal |

## src-tauri/src/ai/mask.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/ai/mask.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 340 | `ä\` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 459 | `ö\` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 468 | ``let grüße = \` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |

## src-tauri/src/automation/handlers/search.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/automation/handlers/search.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 83 | `Suche hat das Zeitlimit überschritten` | literal | `errors.search.timeout` | German string found |

## src-tauri/src/automation/handlers/settings.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/automation/handlers/settings.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 36 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 38 | `Das Standard-Theme kann kein Favorit sein` | literal | `errors.theme.standardNotFavorite` | German string found |

## src-tauri/src/automation/handlers/ui.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/automation/handlers/ui.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 28 | `unknown mode ` | format!( | `OUT-OF-SCOPE: Automation-Diagnose (englisch, kein UI-Vertrag)` | Rust error/literal |
| 63 | `unknown theme ` | format!( | `OUT-OF-SCOPE: Automation-Diagnose (englisch, kein UI-Vertrag)` | Rust error/literal |
| 113 | `unknown side ` | format!( | `OUT-OF-SCOPE: Automation-Diagnose (englisch, kein UI-Vertrag)` | Rust error/literal |
| 264 | `unknown target ` | format!( | `OUT-OF-SCOPE: Automation-Diagnose (englisch, kein UI-Vertrag)` | Rust error/literal |

## src-tauri/src/commands/ai.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/ai.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 50 | `Es läuft bereits ein KI-Vorgang.` | Err( | `errors.ai.jobActive` | Rust error/literal |
| 179 | `Modelle von Provider ` | format!( | `errors.ai.listModelsFailed` | Rust error/literal |
| 189 | `Provider '{provider_id}' lieferte keine gültige Modellliste: {error}` | literal | `errors.ai.invalidModelList` | German string found |
| 287 | `Für die Übersetzung muss ein gespeichertes Dokument geöffnet sein.` | literal | `errors.ai.translateNeedsSavedDoc` | German string found |
| 290 | `Nur Markdown-Dokumente können mit KI übersetzt werden.` | Err( | `errors.ai.translateMarkdownOnly` | Rust error/literal |
| 480 | `Kein Dokument geöffnet.` | Err( | `errors.document.noneOpen` | Rust error/literal |
| 688 | `Datei-Suffix` | literal | `ai.actions.template.fileSuffix.label` | German string found |
| 692 | `Aktions-Kürzel` | literal | `ai.actions.template.actionSlug.label` | German string found |
| 699 | `Der Prompt darf höchstens {} Zeichen haben.` | literal | `errors.ai.promptTooLong` | German string found |
| 714 | `Für KI-Aktionen muss ein gespeichertes Dokument geöffnet sein.` | literal | `errors.ai.actionsNeedSavedDoc` | German string found |
| 717 | `Die Quelle hat sich geändert — bitte erneut starten.` | Err( | `errors.ai.sourceChanged` | Rust error/literal |
| 720 | `KI-Aktionen sind nur für Markdown-Dokumente verfügbar.` | Err( | `errors.ai.actionsMarkdownOnly` | Rust error/literal |
| 729 | `Dieses Dokument verwendet nicht unterstützte Zeilenenden (einzelne CR).` | literal | `errors.ai.unsupportedLineEndings` | German string found |
| 733 | `Die Quelle hat sich geändert — bitte erneut starten.` | Err( | `errors.ai.sourceChanged` | Rust error/literal |
| 905 | `Das Modell hat eine leere Antwort geliefert.` | literal | `errors.ai.emptyModelResponse` | German string found |
| 1003 | `Das Modell hat eine leere Antwort geliefert.` | literal | `errors.ai.emptyModelResponse` | German string found |
| 1126 | `Zieldatei '{normalized}' konnte nicht neu geladen werden: {error}` | literal | `errors.ai.reloadTargetFailed` | German string found |
| 1341 | `Modell '{model_id}' ist für Provider '{provider_id}' nicht freigeschaltet.` | literal | `errors.ai.modelNotWhitelisted` | German string found |
| 1365 | `Ungültiger Sprachcode '{language}': erlaubt sind Buchstaben, Zahlen und '-'.` | literal | `errors.ai.invalidLanguageCode` | German string found |
| 1373 | `Bitte mindestens eine Zielsprache auswählen.` | Err( | `errors.ai.noTargetLanguage` | Rust error/literal |
| 1387 | `Der Dateiname des Quelldokuments ist ungültig.` | literal | `errors.ai.invalidSourceFilename` | German string found |
| 1434 | `Zieldatei '{path}' konnte nicht neu geladen werden: {error}` | literal | `errors.ai.reloadTargetFailed` | German string found |
| 1483 | `Übersetzung für ` | format!( | `ai.translate.status.forLanguage` | Rust error/literal |
| 1486 | `Übersetzung für '{language}' fehlgeschlagen: {error} Bereits erzeugt: {}` | literal | `errors.ai.translateLanguageFailed` | German string found |
| 1504 | `Ungültige Basis-URL für Custom-Provider: {error}` | format!( | `errors.ai.invalidCustomBaseUrl` | Rust error/literal |

## src-tauri/src/commands/app/icon_integration.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/app/icon_integration.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 56 | `Abbrechen` | literal | `dialogs.common.cancel` | German string found |
| 121 | `Die Einrichtung ist fehlgeschlagen:\n\n{detail}` | format!( | `errors.app.iconSetupFailed` | Rust error/literal |
| 133 | `Das Skript konnte nicht gestartet werden: {error}` | format!( | `errors.app.iconScriptFailed` | Rust error/literal |

## src-tauri/src/commands/app/mod.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/app/mod.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 28 | `unknown mode ` | format!( | `OUT-OF-SCOPE: Automation-Diagnose (englisch, kein UI-Vertrag)` | Rust error/literal |
| 61 | `unknown theme ` | format!( | `OUT-OF-SCOPE: Automation-Diagnose (englisch, kein UI-Vertrag)` | Rust error/literal |
| 95 | `unknown side ` | format!( | `OUT-OF-SCOPE: Automation-Diagnose (englisch, kein UI-Vertrag)` | Rust error/literal |

## src-tauri/src/commands/app/shell_opener.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/app/shell_opener.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 66 | `{cmd}: {error}` | format!( | `errors.app.shellCommandFailed` | Rust error/literal |
| 116 | `Datei ist nicht ausführbar` | Err( | `errors.file.notExecutable` | Rust error/literal |

## src-tauri/src/commands/editor.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/editor.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 46 | `Dieses Dokument verwendet nicht unterstützte Zeilenenden (einzelne CR).` | literal | `errors.editor.unsupportedLineEndings` | German string found |
| 242 | `unknown editor command: {command}` | format!( | `OUT-OF-SCOPE: interner Command-Fehler (englisch)` | Rust error/literal |
| 285 | `Ä\nTitle` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 288 | `Ä\n# Title` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |

## src-tauri/src/commands/export.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/export.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 219 | `Kein Dokument geöffnet.` | Err( | `errors.document.noneOpen` | Rust error/literal |

## src-tauri/src/commands/file/create.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/file/create.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 12 | `Ungültiger Dateiname` | Err( | `errors.file.invalidName` | Rust error/literal |
| 23 | `Datei existiert bereits: {}` | literal | `errors.file.alreadyExists` | German string found |
| 98 | `Ungültiger Dateiname` | literal | `errors.file.invalidName` | German string found |

## src-tauri/src/commands/file/image.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/file/image.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 68 | `Clipboard-Bild dekodieren fehlgeschlagen: {error}` | format!( | `errors.file.clipboardDecodeFailed` | Rust error/literal |
| 88 | `Zielverzeichnis kann nicht angelegt werden: {error}` | format!( | `errors.file.mkdirFailed` | Rust error/literal |
| 97 | `Tempfile anlegen fehlgeschlagen: {error}` | format!( | `errors.file.tempCreateFailed` | Rust error/literal |
| 101 | `PNG-Encoding fehlgeschlagen: {error}` | format!( | `errors.file.pngEncodeFailed` | Rust error/literal |
| 104 | `Rename fehlgeschlagen: {error}` | format!( | `errors.file.renameFailed` | Rust error/literal |
| 128 | `Zielverzeichnis kann nicht angelegt werden: {error}` | format!( | `errors.file.mkdirFailed` | Rust error/literal |
| 135 | `Bild kopieren fehlgeschlagen: {error}` | format!( | `errors.file.copyFailed` | Rust error/literal |
| 162 | `Alle Dateien` | add_filter( | `menu.filter.all` | Rust error/literal |
| 251 | `Kein Dokument geoeffnet — absoluter Pfad eingefuegt.` | warning | `dialogs.image.noDocOpen.warning` | I4b-Fix F2: am Backend-Rand lokalisiert |
| 258 | `Dokumentpfad ohne Verzeichnis — absoluter Pfad eingefuegt.` | warning | `dialogs.image.docPathNoDirectory.warning` | I4b-Fix F2: am Backend-Rand lokalisiert |
| 267 | `Bild liegt ausserhalb des Dokumentbaums — absoluter Pfad eingefuegt.` | warning | `dialogs.image.outsideDocumentTree.warning` | I4b-Fix F2: am Backend-Rand lokalisiert |

## src-tauri/src/commands/file/read.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/file/read.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 18 | `Dateityp wird nicht unterstützt: {}` | literal | `errors.file.unsupportedType` | German string found |

## src-tauri/src/commands/file/rename.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/file/rename.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 44 | `Kein Dokument geöffnet.` | literal | `errors.document.noneOpen` | German string found |

## src-tauri/src/commands/file/save_as.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/file/save_as.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 28 | `Kein Dokument geöffnet.` | Err( | `errors.document.noneOpen` | Rust error/literal |

## src-tauri/src/commands/search_cmd.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/search_cmd.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 59 | `scope:{error}` | format!( | `OUT-OF-SCOPE: interner Fehler-Prefix` | Rust error/literal |

## src-tauri/src/commands/theme.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/commands/theme.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 35 | `Theme-Vorschau` | literal | `theme.preview.title` | German string found |
| 229 | `Asset-Bytes konnten nicht dekodiert werden: {error}` | format!( | `errors.theme.assetDecodeFailed` | Rust error/literal |
| 343 | `Theme-Vorschau` | literal | `theme.preview.title` | German string found |
| 344 | `Überschrift 1` | literal | `theme.preview.headingSample` | German string found |
| 356 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 358 | `Theme-Vorschau` | literal | `theme.preview.title` | German string found |

## src-tauri/src/document_store.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/document_store.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 175 | `kein Dokument geladen` | literal | `errors.document.noneLoaded` | German string found |

## src-tauri/src/editor_commands/inline.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/editor_commands/inline.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 50 | `pfad` | literal | `OUT-OF-SCOPE: Test-Fixture (Markdown-Beispiel)` | German string found |
| 139 | `![alt](pfad)` | literal | `OUT-OF-SCOPE: Test-Fixture (Markdown-Beispiel)` | German string found |
| 148 | `![cat](pfad)` | literal | `OUT-OF-SCOPE: Test-Fixture (Markdown-Beispiel)` | German string found |

## src-tauri/src/export.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/export.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 53 | `Theme-Vorschau` | literal | `export.preview.title` | German string found |
| 487 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 507 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 576 | `Vorschau` | literal | `export.preview.title` | German string found |
| 591 | `<title>Vorschau</title>` | literal | `OUT-OF-SCOPE: Markup-Schnipsel` | German string found |
| 687 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |

## src-tauri/src/file_icon/mod.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/file_icon/mod.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 114 | `kein Icon für .{ext} gefunden — Theme-Detection fehlgeschlagen?` | literal | `OUT-OF-SCOPE: Test-Assert / Debug` | German string found |
| 130 | `Cache-Treffer muss dasselbe Ergebnis liefern` | literal | `OUT-OF-SCOPE: Test-Assert / Debug` | German string found |

## src-tauri/src/file_kind.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/file_kind.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 204 | `ausführbar` | literal | `OUT-OF-SCOPE: interner Klassifikator-String` | German string found |

## src-tauri/src/git_branch.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/git_branch.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 50 | `gitdir: <pfad>` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |

## src-tauri/src/layouts/brand.cover.html

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/layouts/brand.cover.html)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 24 | `Erstellt von` | textNode | `export.cover.createdBy` | HTML text node |

## src-tauri/src/layouts/business.cover.html

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/layouts/business.cover.html)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 22 | `Vorbereitet von:` | textNode | `export.cover.preparedBy` | HTML text node |

## src-tauri/src/logging.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/logging.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 137 | `[folio::logging] set_global_default fehlgeschlagen: {err}` | literal | `OUT-OF-SCOPE: Log-Meldung (nicht UI)` | German string found |
| 173 | `reload des log-level-filters fehlgeschlagen` | literal | `OUT-OF-SCOPE: Log-Meldung (nicht UI)` | German string found |

## src-tauri/src/menu/strings.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/menu/strings.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 58 | `Datei` | literal | `menu.file` | MenuLabels.file |
| 59 | `Öffnen…` | literal | `menu.file.open` | MenuLabels.file_open |
| 60 | `Speichern` | literal | `menu.file.save` | MenuLabels.file_save (eigener Key, nicht dialogs.common) |
| 61 | `Speichern unter…` | literal | `menu.file.saveAs` | MenuLabels.file_save_as |
| 62 | `Zuletzt geöffnet` | literal | `menu.file.recent` | MenuLabels.file_recent |
| 63 | `(keine Einträge)` | literal | `menu.file.recentEmpty` | MenuLabels.file_recent_empty |
| 64 | `Umbenennen…` | literal | `menu.file.rename` | MenuLabels.file_rename |
| 65 | `Exportieren…` | literal | `menu.file.export` | MenuLabels.file_export |
| 66 | `Tab schließen` | literal | `menu.file.closeTab` | MenuLabels.file_close |
| 67 | `Beenden` | literal | `menu.file.quit` | MenuLabels.file_quit |
| 68 | `Bearbeiten` | literal | `menu.edit` | MenuLabels.edit |
| 69 | `Rückgängig` | literal | `menu.edit.undo` | MenuLabels.edit_undo |
| 70 | `Wiederholen` | literal | `menu.edit.redo` | MenuLabels.edit_redo |
| 71 | `Suchen…` | literal | `menu.edit.find` | MenuLabels.edit_find |
| 72 | `Im Vault suchen…` | literal | `menu.edit.searchVault` | MenuLabels.edit_search_vault |
| 73 | `Mit KI übersetzen…` | literal | `menu.edit.aiTranslate` | MenuLabels.edit_ai_translate |
| 74 | `KI-Aktionen…` | literal | `menu.edit.aiActions` | MenuLabels.edit_ai_actions |
| 75 | `Einstellungen…` | literal | `menu.edit.settings` | MenuLabels.edit_settings |
| 76 | `Ansicht` | literal | `menu.view` | MenuLabels.view |
| 77 | `View-Mode` | literal | `menu.view.modeView` | MenuLabels.view_mode_view |
| 78 | `Edit-Mode` | literal | `menu.view.modeEdit` | MenuLabels.view_mode_edit |
| 79 | `Split-Mode` | literal | `menu.view.modeSplit` | MenuLabels.view_mode_split |
| 80 | `Theme` | literal | `menu.view.theme` | MenuLabels.view_theme |
| 81 | `Hell` | literal | `menu.view.themeLight` | MenuLabels.view_theme_light |
| 82 | `Dunkel` | literal | `menu.view.themeDark` | MenuLabels.view_theme_dark |
| 83 | `Vault ein/aus` | literal | `menu.view.railLeft` | MenuLabels.view_rail_left |
| 84 | `Inhaltsverzeichnis ein/aus` | literal | `menu.view.railRight` | MenuLabels.view_rail_right |
| 85 | `Minimap ein/aus` | literal | `menu.view.minimap` | MenuLabels.view_minimap |
| 86 | `Hilfe` | literal | `menu.help` | MenuLabels.help |
| 87 | `Cheat-Sheet` | literal | `menu.help.cheatsheet` | MenuLabels.help_cheatsheet |
| 89 | `Markdown-Icon-Integration einrichten…` | literal | `menu.help.setupMdIcon` | MenuLabels.help_setup_md_icon (Linux) |
| 90 | `Über folio` | literal | `menu.help.about` | MenuLabels.help_about |
| 91 | `Markdown` | literal | `menu.filter.markdown` | MenuLabels.save_as_filter_markdown |
| 92 | `Textdatei` | literal | `menu.filter.text` | MenuLabels.save_as_filter_text |
| 93 | `Alle Dateien` | literal | `menu.filter.all` | MenuLabels.save_as_filter_all |


## src-tauri/src/pdf_export.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/pdf_export.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 76 | `Kein Verzeichnis für Temp-Datei verfügbar.` | literal | `errors.export.noTempDir` | German string found |
| 109 | `Browser-Aufruf fehlgeschlagen: {e}` | format!( | `errors.export.browserLaunchFailed` | Rust error/literal |
| 113 | `PDF-Erzeugung fehlgeschlagen (Exit {:?}): {stderr}` | literal | `errors.export.pdfFailed` | German string found |
| 118 | `PDF wurde nicht erzeugt (Browser-Output prüfen).` | Err( | `errors.export.pdfNotCreated` | Rust error/literal |

## src-tauri/src/renderer.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/renderer.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 808 | `## Hällo Wörld` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |
| 810 | `>Hällo Wörld</h2>` | literal | `OUT-OF-SCOPE: Test-Fixture` | German string found |

## src-tauri/src/search.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/search.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 146 | `Suchbegriff muss mindestens 2 Zeichen lang sein` | #[error( | `errors.search.queryTooShort` | Rust error/literal |
| 153 | `Ungültiger Suchpfad: {0}` | #[error( | `errors.search.invalidScope` | Rust error/literal |
| 156 | `Ungültiger Suchausdruck: {0}` | #[error( | `errors.search.invalidQuery` | Rust error/literal |
| 695 | `äß😀 needle` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |
| 699 | `äß😀 needle\n` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |
| 707 | `äß😀 needle` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |
| 772 | `Hits dürfen den Deckel nicht überschreiten` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |
| 880 | `ä` | literal | `search.line880` | German string found |
| 883 | `äö needle\n` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |
| 888 | `ä` | literal | `search.line888` | German string found |
| 891 | `äö` | literal | `search.line891` | German string found |
| 892 | `äö` | literal | `search.line892` | German string found |
| 931 | `, aber „straße` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |
| 933 | `Die Straße ist breit\n` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |
| 937 | `ß≠ss: kein Treffer erwartet` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |
| 939 | `straße` | literal | `OUT-OF-SCOPE: Test-Fixture/Assert` | German string found |

## src-tauri/src/settings.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/settings.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 203 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 319 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 322 | `Das Standard-Theme kann kein Favorit sein` | literal | `errors.theme.standardNotFavorite` | German string found |
| 450 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 655 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |

## src-tauri/src/theme/archive.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/theme/archive.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 60 | `Tempfile fuer Theme-Export kann nicht angelegt werden: {error}` | format!( | `errors.theme.tempCreateFailed` | Rust error/literal |
| 64 | `Theme-Export kann nicht geschrieben werden: {error}` | format!( | `errors.theme.writeFailed` | Rust error/literal |
| 66 | `Theme-Export kann nicht veroeffentlicht werden: {error}` | format!( | `errors.theme.operationFailed` | Rust error/literal |
| 84 | `Temporäres Asset-Verzeichnis kann nicht angelegt werden: {error}` | format!( | `errors.theme.assetFailed` | Rust error/literal |
| 110 | `Theme-Manifest kann nicht serialisiert werden: {error}` | format!( | `errors.theme.manifestSerializeFailed` | Rust error/literal |
| 154 | `Theme-Archiv kann nicht abgeschlossen werden: {error}` | format!( | `errors.theme.archiveFailed` | Rust error/literal |
| 187 | `Asset-Eintrag kann nicht gelesen werden: {error}` | format!( | `errors.theme.readFailed` | Rust error/literal |
| 190 | `Asset-Typ kann nicht gelesen werden: {error}` | format!( | `errors.theme.readFailed` | Rust error/literal |
| 250 | `Archiv-Eintrag #{index} kann nicht gelesen werden: {error}` | format!( | `errors.theme.readFailed` | Rust error/literal |
| 261 | `Theme-Manifest im Archiv ist ungueltig: {error}` | format!( | `errors.theme.archiveFailed` | Rust error/literal |
| 312 | `Archiv-Eintrag '{name}' hat einen unsicheren Pfad` | literal | `errors.theme.archiveFailed` | German string found |
| 321 | `Archiv-Eintrag '{name}' ist keine regulaere Datei` | literal | `errors.theme.archiveFailed` | German string found |

## src-tauri/src/theme/assets.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/theme/assets.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 82 | `Asset-Datei ` | format!( | `errors.theme.assetFailed` | Rust error/literal |
| 256 | `Logo-Asset kann nicht geladen werden; Export ohne Logo` | literal | `theme.export.logoLoadFailed.status` | German string found |

## src-tauri/src/theme/author.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/theme/author.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 197 | `KI-Antwort ist kein gueltiges Theme-JSON: {error}` | format!( | `errors.theme.invalidAiJson` | Rust error/literal |

## src-tauri/src/theme/builtin.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/theme/builtin.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 38 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 45 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 46 | `Standard` | literal | `theme.builtin.standard.name` | German string found |
| 75 | `Stil angelehnt an die GitHub-Markdown-Vorschau.` | literal | `theme.builtin.github.description` | German string found |
| 86 | `Seriöses Corporate-Theme mit klarem Sans-Serif-Design und blauen Akzenten.` | literal | `theme.builtin.business.description` | German string found |
| 110 | `Maximal reduziertes Design mit viel Weißraum und dezenter Typografie.` | literal | `theme.builtin.minimal.description` | German string found |
| 120 | `Ausdrucksstarkes Branding-Theme mit kräftigem Indigo-Akzent und moderner Ästhetik.` | literal | `theme.builtin.brand.description` | German string found |
| 133 | `Einladendes Theme in warmen Sepia- und Erdtönen für entspanntes Lesen.` | literal | `theme.builtin.warm.description` | German string found |
| 143 | `Kompaktes Entwickler-Theme mit Monospace-Überschriften und technischem Code-Look.` | literal | `theme.builtin.tech.description` | German string found |
| 153 | `Kontrastreiches und barrierearmes Design für optimale Lesbarkeit.` | literal | `theme.builtin.contrast.description` | German string found |

## src-tauri/src/theme/mod.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/theme/mod.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 43 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 65 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 84 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 110 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 188 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |

## src-tauri/src/theme/package.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/theme/package.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 139 | `fontBody: {error}` | format!( | `errors.theme.fontBodyInvalid` | Rust error/literal |
| 142 | `fontMono: {error}` | format!( | `errors.theme.fontMonoInvalid` | Rust error/literal |
| 145 | `fontSize: {error}` | format!( | `errors.theme.fontSizeInvalid` | Rust error/literal |
| 163 | `enthaelt verbotenes Zeichen ` | format!( | `errors.theme.forbiddenChar` | Rust error/literal |

## src-tauri/src/theme/store.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/theme/store.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 143 | `Tempfile anlegen fehlgeschlagen: {error}` | format!( | `errors.theme.tempCreateFailed` | Rust error/literal |
| 145 | `Asset schreiben fehlgeschlagen: {error}` | format!( | `errors.theme.assetFailed` | Rust error/literal |
| 147 | `Asset umbenennen fehlgeschlagen: {error}` | format!( | `errors.theme.assetFailed` | Rust error/literal |
| 150 | `Asset-Datei ` | format!( | `errors.theme.assetFailed` | Rust error/literal |
| 207 | `Eingebautes Theme '{id}' kann nicht gelöscht werden` | Domainfehler | `errors.theme.builtinDelete` | I4b-Fix F3: ohne Operationsrahmen |
| 215 | `Theme-Verzeichnis '{}' kann nicht gelöscht werden: {error}` | literal | `errors.theme.operationFailed` | German string found |
| 268 | `Temporäres Theme-Verzeichnis kann nicht angelegt werden: {error}` | format!( | `errors.theme.operationFailed` | Rust error/literal |
| 279 | `Theme-Verzeichnis '{}' kann nicht veröffentlicht werden: {error}` | literal | `errors.theme.publishFailed` | German string found |
| 285 | `Geschriebenes Theme '{id}' kann nicht geladen werden` | literal | `errors.theme.operationFailed` | German string found |
| 294 | `Theme-Manifest kann nicht serialisiert werden: {error}` | format!( | `errors.theme.manifestSerializeFailed` | Rust error/literal |
| 296 | `Theme-Manifest kann nicht geschrieben werden: {error}` | format!( | `errors.theme.writeFailed` | Rust error/literal |
| 298 | `Theme-CSS kann nicht geschrieben werden: {error}` | format!( | `errors.theme.writeFailed` | Rust error/literal |
| 315 | `Theme-Datei ` | format!( | `errors.theme.operationFailed` | Rust error/literal |
| 336 | `Theme-Backup kann nicht angelegt werden: {error}` | format!( | `errors.theme.backupFailed` | Rust error/literal |
| 350 | `Theme-Update kann nicht veröffentlicht werden: {error}` | literal | `errors.theme.publishFailed` | German string found |
| 353 | `Theme-Update fehlgeschlagen ({error}); Rollback fehlgeschlagen: {rollback_error}` | literal | `errors.theme.rollbackFailed` | German string found |
| 362 | `Asset-Verzeichnis kann nicht angelegt werden: {error}` | format!( | `errors.theme.assetFailed` | Rust error/literal |
| 364 | `Asset-Verzeichnis kann nicht gelesen werden: {error}` | format!( | `errors.theme.readFailed` | Rust error/literal |
| 367 | `Asset-Eintrag kann nicht gelesen werden: {error}` | format!( | `errors.theme.readFailed` | Rust error/literal |
| 370 | `Asset-Typ kann nicht gelesen werden: {error}` | format!( | `errors.theme.readFailed` | Rust error/literal |
| 376 | `Asset kann nicht kopiert werden: {error}` | format!( | `errors.theme.assetFailed` | Rust error/literal |
| 390 | `Legacy-Theme-Datei '{}' kann nicht gelöscht werden: {error}` | literal | `errors.theme.legacyDeleteFailed` | German string found |
| 409 | `Ungültige Theme-ID: ` | format!( | `errors.theme.invalidId` | Rust error/literal |
| 417 | `Eingebautes Theme '{id}' kann nicht geändert werden` | Domainfehler | `errors.theme.builtinReadOnly` | I4b-Fix F3: ohne Operationsrahmen |

## src-tauri/src/vault.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/vault.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 233 | `Zuletzt geöffnet` | literal | `vault.recent.sectionTitle` | German string found |
| 514 | `>Keine Einträge</li>` | literal | `OUT-OF-SCOPE: Markup-Schnipsel` | German string found |
| 560 | `Zuletzt geöffnet` | literal | `vault.recent.sectionTitle` | German string found |

## src-tauri/src/vault_watcher.rs

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/src/vault_watcher.rs)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 425 | `fs notify nicht verfuegbar, Test geskippt` | literal | `OUT-OF-SCOPE: Test-Skip-Meldung` | German string found |
| 498 | `fs notify nicht verfuegbar, Test geskippt` | literal | `OUT-OF-SCOPE: Test-Skip-Meldung` | German string found |
| 525 | `fs notify nicht verfuegbar, Test geskippt` | literal | `OUT-OF-SCOPE: Test-Skip-Meldung` | German string found |

## src-tauri/web/app/state/document.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/state/document.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 130 | `Bereit` | literal | `statusBar.ready` | German string found |
| 142 | `Wörter ·` | literal | `statusBar.wordCount.wordsPart` | German string found |
| 283 | `Kein Dokument geladen` | literal | `errors.document.noneLoaded` | German string found |
| 290 | `Kein Dokument geladen` / `Bilder sind read-only` | literal | `errors.document.noneLoaded` / `errors.document.imageReadOnly` | Mode-Tooltip disabled |
| 300 | `Kein Dokument geladen` / `Bilder sind read-only` | literal | `errors.document.noneLoaded` / `errors.document.imageReadOnly` | Mode-Tooltip disabled |
| 305 | `Export nur für Markdown verfügbar` | literal | `statusBar.exportMarkdownOnly` | German string found |
| 342 | `Datei konnte nicht geöffnet werden` | literal | `errors.file.openFailed` | German string found |
| 419 | `Bereit` | literal | `statusBar.ready` | German string found |
| 536 | `Datei extern geändert (ungespeicherte Änderungen) — Reload via Save oder Verwerfen` | showStatus | `statusBar.externalChangedDirty` | dialog call |
| 545 | `Datei extern geändert — Reload-Button zum Übernehmen` | showStatus | `statusBar.externalChangedClean` | dialog call |
| 584 | `Bereit` | literal | `statusBar.ready` | German string found |
| 616 | `Bereit` | literal | `statusBar.ready` | German string found |
| — | `View` / `Edit` / `Split` (Statuszelle) | shell `setActiveMode` | `statusBar.modeView` / `statusBar.modeEdit` / `statusBar.modeSplit` | I3a ergänzt |

## src-tauri/web/app/state/tabs.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/state/tabs.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 110 | `\u2699 Einstellungen` | literal | `tabs.settings.label` | German string found |
| 126 | `\u2699 Einstellungen` | literal | `tabs.settings.label` | German string found |
| 137 | `Leerer Tab` | literal | `tabs.empty.label` | I3a ergänzt |
| 195 | `Ungespeicherte Änderungen` | setAttribute(aria-label) | `tabs.dirty.ariaLabel` | setAttribute text |
| 203 | `Tab schließen` | title | `tabs.close.tooltip` | DOM assignment (`{label} schließen`) |
| 204 | `schließen` | literal | `tabs.close.tooltip` | German string found |
| 260 | `Ungespeicherte Änderungen` | setAttribute(aria-label) | `tabs.dirty.ariaLabel` | setAttribute text |
| 267 | `schließen` | literal | `tabs.close.tooltip` | German string found |
| 268 | `schließen` | literal | `tabs.close.tooltip` | German string found |

## src-tauri/web/app/ui/ai-actions-dialog.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/ai-actions-dialog.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 110 | `Settings für KI-Aktions-Favoriten laden` | literal | `OUT-OF-SCOPE: internes Log/IPC-Op-Label` | German string found |
| 191 | `KI-Konfiguration für Aktionsmenü laden` | literal | `OUT-OF-SCOPE: internes Log/IPC-Op-Label` | German string found |
| 233 | `Läuft…` | literal | `ai.actions.status.running` | German string found |
| 307 | `Vorlage löschen` | setAttribute(aria-label) | `ai.actions.deleteTemplate.ariaLabel` | setAttribute text |
| 329 | `Eigene Vorlage` | textContent | `ai.actions.customTemplate.badge` | DOM assignment |
| 341 | `Die Vorlage „${template.name}" löschen?` | literal | `ai.actions.deleteTemplate.confirm` | German string found |
| 342 | `Löschen` | literal | `ai.actions.deleteTemplate.submit` | German string found |
| 407 | `Selektion (${…} Zeichen)` | textContent | `ai.actions.scope.selectionWithCount` + `ai.status.charsPart` | I3b-fix F1: Template `{charsPart}` + tPlural/fmtNumber |
| 417 | `✨ ${actionName} · 0 Zeichen` | literal | `ai.actions.status.charCount` | German string found |
| 421 | `Abbrechen` | textContent | `dialogs.common.cancel` | DOM assignment |
| 505 | `Kein freigeschaltetes Modell verfügbar.` | setError | `errors.ai.noEnabledModel` | dialog call |
| 534 | `Der Prompt darf nicht leer sein.` | setError | `errors.ai.emptyPrompt` | dialog call |
| 539 | `Bitte ein Modell auswählen.` | setError | `errors.ai.noModelSelected` | dialog call |
| 547 | `Die Modellauswahl ist ungültig.` | setError | `errors.ai.invalidModelSelection` | dialog call |
| 554 | `Die Quelle hat sich geändert — Dialog bitte neu öffnen.` | setError | `errors.ai.sourceChanged` | I3b kanonisch |
| 558 | `Das Dokument wurde zwischenzeitlich geändert — Dialog bitte neu öffnen.` | setError | `errors.ai.documentChanged` | I3b kanonisch |
| 566 | `Erst die offene KI-Review abschließen.` | setError | `errors.ai.reviewOpen` | dialog call |
| 595 | `Das Dokument wurde während des Starts geändert — bitte erneut starten.` | setError | `errors.ai.documentChangedDuringStart` | I3b kanonisch |
| 709 | `Schließen` | textContent | `dialogs.common.close` | DOM assignment |
| 764 | `Erst die offene KI-Review abschließen.` | literal | `errors.ai.reviewOpen` | German string found |
| 803 | `Schließen` | literal | `dialogs.common.close` | German string found |
| 809 | `Bricht ab…` | textContent | `ai.actions.status.cancelling` | DOM assignment |
| 817 | `Abbrechen` | textContent | `dialogs.common.cancel` | DOM assignment |
| 867 | `Favoriten im ✨-Dialog markieren.` | textContent | `ai.actions.favorites.empty` | DOM assignment |
| 876 | `${template.name}` | textContent | `ai.templateName` | DOM assignment |
| 1076 | `✨ ${currentActionName} · ${chars.toLocaleString('de-DE')} Zeichen` | literal | `ai.actions.status.charCount` | German string found |

## src-tauri/web/app/ui/ai-chat-test.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/ai-chat-test.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 41 | `Du` | textContent | `ai.chatTest.roleUser` | User-Rolle im Chat-Test |
| 41 | `Modell` | textContent | `ai.chatTest.roleAssistant` | KI-Rolle im Chat-Test |
| 68 | `Tauri-Schnittstelle ist nicht verfügbar.` | setError | `errors.ai.tauriUnavailable` | I3b kanonisch |

## src-tauri/web/app/ui/ai-diff-review.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/ai-diff-review.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 122 | `✨ KI-Review — ${context.actionName}` | textContent | `ai.diffReview.title` | DOM assignment |
| 193 | `Die bearbeitete KI-Review verwerfen?` | literal | `ai.diffReview.title` | German string found |
| 194 | `Verwerfen` | literal | `dialogs.common.discard` | German string found |
| 212 | `Verwerfen und beenden` | literal | `ai.diffReview.discardAndExit.action` | German string found |
| 224 | `Der Quell-Tab wurde geschlossen — Übernehmen ist nicht mehr möglich.` | literal | `errors.ai.sourceTabClosed` | German string found |
| 247 | `Das Dokument wurde zwischenzeitlich geändert — Ersetzen überschreibt diese Änderungen.` | literal | `ai.diffReview.apply.overwriteConfirm` | German string found |

## src-tauri/web/app/ui/cheatsheet.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/cheatsheet.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 12 | `Überschrift` | literal | `cheatsheet.heading.label` | German string found |
| 13 | `Fett / Kursiv` | literal | `cheatsheet.boldItalic.label` | I3a ergänzt (volle Zeilenliste) |
| 14 | `Durchgestrichen` | literal | `cheatsheet.strikethrough.label` | I3a ergänzt |
| 15 | `Inline-Code` | literal | `cheatsheet.inlineCode.label` | I3a ergänzt |
| 16 | `Codeblock` | literal | `cheatsheet.codeBlock.label` | I3a ergänzt |
| 17 | `Link` | literal | `cheatsheet.link.label` | I3a ergänzt |
| 18 | `![alt](pfad.png)` | literal | `OUT-OF-SCOPE: Markdown-Beispielsyntax (nicht übersetzen)` | Code-Spalte |
| 18 | `Bild` | literal | `cheatsheet.image.label` | I3a ergänzt |
| 19 | `Aufzählung` | literal | `cheatsheet.bulletList.label` | German string found |
| 20 | `Nummeriert` | literal | `cheatsheet.orderedList.label` | I3a ergänzt |
| 21 | `Zitat` | literal | `cheatsheet.blockquote.label` | I3a ergänzt |
| 22 | `Trennlinie` | literal | `cheatsheet.horizontalRule.label` | I3a ergänzt |
| 23 | `Tabelle` | literal | `cheatsheet.table.label` | I3a ergänzt |
| 24 | `Aufgabe` | literal | `cheatsheet.taskList.label` | I3a ergänzt |

## src-tauri/web/app/ui/dialogs.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/dialogs.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 113 | `Bestätigen` | literal | `dialogs.confirm.title` | German string found |
| 146 | `„{name}" als Programm ausführen?` | textContent | `dialogs.run.confirm` | I3a F1: `{name}` + textContent |

## src-tauri/web/app/ui/export-ai.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/export-ai.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 102 | `Abbrechen` | textContent | `dialogs.common.cancel` | DOM assignment |
| 108 | `Transientes KI-Layout für diesen Export` | literal | `export.aiDraft.transientLabel` | German string found |
| 152 | `Kein Basis-Theme` | textContent | `export.aiDraft.base.none` | I3b: hierarchischer Key behalten (Map-Korrektur) |
| 172 | `Kein freigeschaltetes Modell verfügbar.` | setError | `errors.ai.noEnabledModel` | dialog call |
| 233 | `KI-Entwurf bereit.` | literal | `export.aiDraft.status.readyResult` | German string found |
| 240 | `Bitte einen Prompt eingeben.` | setError | `errors.ai.emptyPrompt` | dialog call |
| 245 | `Bitte ein Modell auswählen.` | setError | `errors.ai.noModelSelected` | dialog call |
| 253 | `Die Modellauswahl ist ungültig.` | setError | `errors.ai.invalidModelSelection` | dialog call |
| 259 | `KI-Generierung · 0 Zeichen` | literal | `export.aiDraft.status.charCount` | German string found |
| 277 | `KI-Generierung fehlgeschlagen.` | literal | `errors.export.aiGenerateFailed` | German string found |
| 286 | `Bricht ab...` | textContent | `export.aiDraft.status.cancelling` | DOM assignment |
| 344 | `Theme gespeichert: ` | showStatus | `export.aiDraft.themeSaved.status` | dialog call |
| 357 | `Bereit.` | literal | `export.aiDraft.status.ready` | German string found |
| 422 | `KI-Generierung · ${chars.toLocaleString('de-DE')} Zeichen` | literal | `export.aiDraft.status.charCount` | German string found |

## src-tauri/web/app/ui/export-dialog.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/export-dialog.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 150 | `Weitere Layouts (` | textContent | `export.layouts.moreTemplate` | DOM assignment |
| 224 | `Export fehlgeschlagen` | literal | `errors.export.failed` | German string found |
| 251 | `Export läuft…` | showStatus | `export.status.running` | dialog call |
| 256 | `Exportiert: ` | showStatus | `export.status.done` | dialog call |
| 265 | `Exportiert: ` | showStatus | `export.status.done` | dialog call |
| 268 | `Export fehlgeschlagen` | literal | `errors.export.failed` | German string found |

## src-tauri/web/app/ui/find-bar.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/find-bar.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 354 | `…/` | textContent | `OUT-OF-SCOPE: technisches UI-Glyph` | DOM assignment |

## src-tauri/web/app/ui/image-dialog.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/image-dialog.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 94 | `Bild laden fehlgeschlagen` | literal | `errors.dialogs.imageFilePickFailed` | German string found |
| 101 | `Canvas-Context nicht verfuegbar` | literal | `dialogs.canvasContextNichtVerfuegbar` | German string found |
| 163 | `Keine Datei gewählt.` | literal | `dialogs.image.noFileChosen` | German string found |
| 274 | `Datei-Auswahl fehlgeschlagen` | literal | `errors.dialogs.imageFilePickFailed` | German string found |
| 287 | `Verzeichnis-Auswahl fehlgeschlagen` | literal | `errors.dialogs.imageFilePickFailed` | German string found |
| 344 | `Zielordner darf nicht leer sein.` | showStatus | `dialogs.zielordnerDarfNichtLeer` | dialog call |
| 396 | `Bild eingefügt: ${result.finalFilename}` | showStatus | `dialogs.bildEingefGtResult` | dialog call |
| 407 | `Bild-Insert fehlgeschlagen` | literal | `errors.dialogs.imageFilePickFailed` | German string found |
| 508 | `Kein Dokument geöffnet — Bild wird mit absolutem Pfad eingefügt.` | literal | `dialogs.keinDokumentGeFfnet` | German string found |

## src-tauri/web/app/ui/settings-ai.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/settings-ai.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 71 | `Tauri-Schnittstelle ist nicht verfügbar.` | literal | `settings.tauriSchnittstelleIstNicht` | German string found |
| 116 | `Schlüssel hinterlegt` | literal | `settings.schlSselHinterlegt` | German string found |
| 121 | `Schlüssel ändern` | literal | `settings.ai.providers.changeKey.action` | German string found |
| 139 | `Schlüssel für ${providerId}` | setAttribute(aria-label) | `settings.schlSselFR.ariaLabel` | setAttribute text |
| 140 | `Speichern` | literal | `dialogs.common.save` | German string found |
| 143 | `Abbrechen` | literal | `dialogs.common.cancel` | German string found |
| 172 | `KI-Schlüsselstatus konnte nicht geladen werden` | literal | `errors.ai.keyUpdateFailed` | German string found |
| 183 | `Schlüssel darf nicht leer sein.` | literal | `settings.schlSselDarfNicht` | German string found |
| 190 | `KI-Schlüssel konnte nicht gespeichert werden` | literal | `errors.ai.keyUpdateFailed` | German string found |
| 207 | `KI-Schlüssel konnte nicht entfernt werden` | literal | `errors.ai.keyUpdateFailed` | German string found |
| 222 | `KI-Anbieter konnte nicht geändert werden` | literal | `errors.ai.providerUpdateFailed` | German string found |
| 225 | `ai-providers-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 230 | `ai-providers-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 272 | `API: ${api}` | textContent | `settings.apiApi` | DOM assignment |
| 277 | `Doku: ${doc}` | textContent | `settings.dokuDoc` | DOM assignment |
| 345 | `Keine passenden Anbieter.` | literal | `settings.ai.providers.noneMatch` | German string found |
| 361 | `Bearbeiten` | literal | `settings.bearbeiten` | German string found |
| 365 | `Löschen` | literal | `settings.themes.delete.action` | German string found |
| 384 | `Anbieter bearbeiten` | literal | `settings.anbieterBearbeiten` | German string found |
| 390 | `ai-custom-error` | setError | `errors.app.aiCustomError` | dialog call |
| 400 | `ai-custom-error` | setError | `errors.app.aiCustomError` | dialog call |
| 410 | `ai-custom-error` | setError | `errors.app.aiCustomError` | dialog call |
| 422 | `ai-custom-error` | setError | `errors.app.aiCustomError` | dialog call |
| 433 | `Schlüssel des Custom-Providers konnte nicht gespeichert werden` | literal | `errors.ai.providerUpdateFailed` | German string found |
| 437 | `ai-custom-error` | setError | `errors.app.aiCustomError` | dialog call |
| 451 | `Custom-Provider konnte nicht gelöscht werden` | literal | `errors.ai.providerUpdateFailed` | German string found |
| 454 | `ai-providers-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 510 | `KI-Modell konnte nicht geändert werden` | literal | `errors.ai.modelUpdateFailed` | German string found |
| 513 | `ai-models-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 518 | `ai-models-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 600 | `Aktiviere zuerst Anbieter im Tab KI-Anbieter.` | textContent | `settings.ai.models.enableProviderFirst` | DOM assignment |
| 628 | `Modelle abrufen` | literal | `settings.ai.providers.fetchModels.action` | German string found |
| 644 | `Noch keine Modelle. Rufe die Modellliste vom Anbieter ab.` | literal | `settings.ai.providers.models.empty` | German string found |
| 645 | `Keine passenden Modelle.` | literal | `settings.ai.models.noneMatch` | German string found |
| 658 | `Keine passenden Modelle.` | textContent | `settings.ai.models.noneMatch` | DOM assignment |
| 670 | `Wird abgerufen…` | textContent | `settings.ai.providers.fetchModels.status` | DOM assignment |
| 674 | `Modelle des Custom-Providers konnten nicht abgerufen werden` | literal | `errors.ai.providerUpdateFailed` | German string found |
| 678 | `Modelle abrufen` | textContent | `settings.ai.providers.fetchModels.action` | DOM assignment |
| 703 | `Katalogstand: ${formatCatalogDate(catalogResult.updatedAt)} (${source})` | textContent | `settings.ai.models.catalogAge` | DOM assignment |
| 710 | `Wird aktualisiert…` | textContent | `settings.ai.models.refreshCatalog.status` | DOM assignment |
| 711 | `ai-models-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 718 | `Anbieter-/Modellkatalog aktualisieren` | textContent | `settings.ai.models.refreshCatalog.action` | DOM assignment |
| 720 | `ai-models-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 738 | `Default-Modell konnte nicht gespeichert werden` | literal | `errors.ai.modelUpdateFailed` | German string found |
| 741 | `ai-models-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 746 | `ai-models-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 754 | `Wird geladen…` | textContent | `settings.ai.loading.status` | DOM assignment |
| 755 | `Wird geladen…` | textContent | `settings.ai.loading.status` | DOM assignment |
| 762 | `KI-Schlüsselstatus laden` | literal | `OUT-OF-SCOPE: internes Log/IPC-Op-Label` | German string found |
| 766 | `ai-providers-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 767 | `ai-models-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 773 | `ai-providers-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 774 | `ai-models-error` | setError | `OUT-OF-SCOPE: DOM-ID / Fehler-Slot-ID` | dialog call |
| 785 | `settings-panel-ki-anbieter` | literal | `OUT-OF-SCOPE: DOM-ID / Test-Selektor` | German string found |
| 790 | `settings-tab-ki-anbieter` | literal | `OUT-OF-SCOPE: DOM-ID / Test-Selektor` | German string found |
| 791 | `settings-tab-ki-modelle` | literal | `OUT-OF-SCOPE: DOM-ID / Test-Selektor` | German string found |

## src-tauri/web/app/ui/settings-dialog.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/settings-dialog.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 141 | `Sprachänderung wird beim nächsten Start aktiv.` | textContent | `settings.language.hint` | DOM assignment |
| 144 | `Sprachänderung wird beim nächsten Start aktiv.` | textContent | `settings.language.hint` | DOM assignment |

## src-tauri/web/app/ui/settings-themes.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/settings-themes.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 71 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 93 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 94 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 103 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 276 | `Vorschau` | literal | `settings.themes.preview.label` | German string found |
| 289 | `● Aktiv` | textContent | `settings.themes.active.badge` | DOM assignment |
| 295 | `Eigenes Theme` | textContent | `settings.themes.custom.badge` | DOM assignment |
| 300 | `Built-in` | textContent | `settings.themes.builtin.badge` | DOM assignment |
| 346 | `Als Favorit markieren` | setAttribute(aria-label) | `settings.themes.favorite.ariaLabel` | setAttribute text |
| 362 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 365 | `Folgt dem App-Theme · nur Ansicht, kein Export-Layout` | textContent | `settings.themes.standard.hint` | DOM assignment |
| 404 | `Eigene Themes: CSS-Dateien in ` | textContent | `settings.themes.customDir.hint.prefix` | DOM assignment |
| 405 | `ablegen (name.css, optional name.dark.css / name.page.css).` | literal | `settings.themes.customDir.hint.suffix` | German string found |
| 458 | `Bearbeiten` | literal | `settings.themes.edit.action` | German string found |
| 469 | `Löschen` | literal | `settings.themes.delete.action` | German string found |
| 486 | `Theme-Name` | setAttribute(aria-label) | `settings.themes.detail.name.ariaLabel` | setAttribute text |
| 491 | `Theme-Beschreibung` | setAttribute(aria-label) | `settings.themes.detail.description.ariaLabel` | setAttribute text |
| 508 | `Name und Beschreibung speichern` | literal | `settings.themes.detail.saveMeta.action` | German string found |
| 533 | `Theme auswählen.` | textContent | `settings.themes.detail.empty` | DOM assignment |
| 547 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 550 | `Folgt dem App-Theme · nur Ansicht, kein Export-Layout` | textContent | `settings.themes.standard.hint` | DOM assignment |
| 558 | `Größe` | literal | `settings.themes.detail.size.label` | German string found |
| 574 | `Detail-Vorschau` | literal | `settings.themes.detail.preview.label` | German string found |
| 584 | `Dunkle Vorschau` | literal | `settings.themes.detail.darkPreview.label` | German string found |
| 591 | `Dunkle Vorschau` | textContent | `settings.themes.detail.darkPreview.label` | DOM assignment |
| 597 | `Datei: ` | textContent | `settings.themes.detail.file.label` | DOM assignment |
| 735 | `Bitte ein Basis-Theme wählen.` | literal | `errors.theme.baseRequired` | German string found |
| 772 | `Theme „` | textContent | `settings.themes.deleted.status` | DOM assignment |

## src-tauri/web/app/ui/theme-ai-dialog.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/theme-ai-dialog.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 72 | `Abbrechen` | textContent | `dialogs.common.cancel` | DOM assignment |
| 107 | `Kein freigeschaltetes Modell verfügbar.` | setError | `errors.ai.noEnabledModel` | dialog call |
| 124 | `Bitte einen Prompt eingeben.` | setError | `errors.ai.emptyPrompt` | dialog call |
| 130 | `Bitte ein Modell auswählen.` | setError | `errors.ai.noModelSelected` | dialog call |
| 138 | `Die Modellauswahl ist ungültig.` | setError | `errors.ai.invalidModelSelection` | dialog call |
| 144 | `KI-Generierung · 0 Zeichen` | literal | `export.aiDraft.status.charCount` | German string found |
| 184 | `Bricht ab…` | textContent | `export.aiDraft.status.cancelling` | DOM assignment |
| 192 | `Abbrechen` | textContent | `dialogs.common.cancel` | DOM assignment |
| 216 | `KI-Generierung · ${chars.toLocaleString('de-DE')} Zeichen` | literal | `export.aiDraft.status.charCount` | German string found |
| 221 | `Generierung fehlgeschlagen.` | literal | `errors.ai.generationFailed` | I3b-Fix F4: Theme-AI → errors.ai.* |

## src-tauri/web/app/ui/theme-editor.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/theme-editor.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 239 | `als Logo` | textContent | `theme.editor.assets.logo.badge` | DOM assignment |
| 245 | `Asset entfernen` | title | `theme.editor.assets.remove.tooltip` | DOM assignment |
| 283 | `Das Asset darf höchstens 5 MB groß sein.` | setError | `errors.theme.dasAssetDarfH` | dialog call |

## src-tauri/web/app/ui/translate-dialog.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/ui/translate-dialog.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 89 | `KI-Konfiguration für Übersetzungsmenü laden` | literal | `OUT-OF-SCOPE: internes Log/IPC-Op-Label` | German string found |
| 163 | `Übersetze…` | literal | `ai.translate.status.running` | German string found |
| 171 | `KI-Übersetzung ${language} · 0 Zeichen` | literal | `ai.translate.status.charCount` | German string found |
| 175 | `Abbrechen` | textContent | `dialogs.common.cancel` | DOM assignment |
| 221 | `Kein freigeschaltetes Modell verfügbar.` | setError | `errors.ai.noEnabledModel` | dialog call |
| 237 | `Bitte mindestens eine Zielsprache auswählen.` | setError | `errors.ai.noTargetLanguage` | I3b-fix F2: errors-Namespace (war kurzzeitig ai.translate.noTargetLanguage) |
| 242 | `Bitte ein Modell auswählen.` | setError | `errors.ai.noModelSelected` | dialog call |
| 250 | `Die Modellauswahl ist ungültig.` | setError | `errors.ai.invalidModelSelection` | dialog call |
| 300 | `Bricht ab…` | textContent | `ai.translate.status.cancelling` | DOM assignment |
| 308 | `Abbrechen` | textContent | `dialogs.common.cancel` | DOM assignment |
| 338 | `KI-Übersetzung ${language} · ${chars.toLocaleString('de-DE')} Zeichen` | literal | `ai.translate.status.charCount` | German string found |
| 352 | `✓ ${language} · KI-Übersetzung ${next} · 0 Zeichen` | literal | `ai.translate.status.charCount` | German string found |

## src-tauri/web/app/vault/context-menu.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/vault/context-menu.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 82 | `Öffnen` | textContent | `vault.contextMenu.open` | DOM-Item |
| 83 | `In neuem Tab öffnen` | textContent | `vault.contextMenu.openNewTab` | DOM-Item |
| 85 | `Ausführen` | textContent | `vault.contextMenu.run` | DOM-Item |
| 86 | `Mit Standardprogramm öffnen` | textContent | `vault.contextMenu.openWithDefault` | DOM-Item |
| 92 | `Neue Datei…` | textContent | `vault.contextMenu.newFile` | DOM-Item |
| 93 | `In diesem Ordner suchen` | textContent | `vault.contextMenu.searchInFolder` | DOM-Item |
| 94 | `Umbenennen` | textContent | `vault.contextMenu.rename` | I3a ergänzt |
| 95 | `Neue Datei…` | textContent | `vault.contextMenu.newFile` | DOM-Item |
| 96 | `Anpinnen` | textContent | `vault.contextMenu.pin` | I3a ergänzt |
| 97 | `Vom Pin lösen` | textContent | `vault.contextMenu.unpin` | DOM-Item |
| 98 | `Aus „Zuletzt" entfernen` | textContent | `vault.contextMenu.removeRecent` | DOM-Item |
| 102 | `Im Explorer zeigen` | textContent | `vault.contextMenu.showInExplorer` | I3a ergänzt |
| — | `Dateinamen eingeben:` / `Neue Datei` / `Anlegen` | dialog | `vault.contextMenu.newFile.prompt` / `.title` / `.action` | I3a ergänzt |
| — | `Datei löschen` / `Löschen` (Confirm) | dialog | `vault.contextMenu.delete.title` / `.action` | I3a ergänzt |
| 103 | `Terminal hier öffnen` | literal | `vault.contextMenu.openTerminal` | German string found |
| 104 | `Pfad kopieren` | literal | `vault.contextMenu.copyPath` | German string found |
| 111 | `Löschen` | literal | `vault.contextMenu.delete` | German string found |
| 205 | `Umbenennen fehlgeschlagen` | literal | `errors.vault.renameFailed` | German string found |
| 267 | `untitled.md` | showRenameDialog | `OUT-OF-SCOPE: Fixture-/Default-Dateiname` | dialog call |
| 271 | `Ungültiger Dateiname` | showStatus | `errors.file.invalidName` | dialog call |
| 278 | `Anlegen fehlgeschlagen` | literal | `errors.vault.createFailed` | German string found |
| 283 | `„${name}` | showConfirmDialog | `vault.contextMenu.deleteConfirm` | dialog call |

## src-tauri/web/app/vault/search.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/vault/search.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 218 | `Mindestens 2 Zeichen` | literal | `search.query.minLength.hint` | German string found |
| 230 | `Suche läuft …` | literal | `search.status.runningSimple` | German string found |
| 241 | `Fehler beim Starten der Suche` | literal | `errors.search.startFailed` | German string found |
| 265 | `Ordner existiert nicht mehr — Suche im gesamten Vault` | literal | `search.scope.folderMissing.fallback` | German string found |
| 267 | `Fehler beim Starten der Suche` | literal | `errors.search.startFailed` | German string found |
| 319 | `${totalHits()} Treffer in ${files.length} Dateien …` | literal | `search.status.running` | German string found |
| 333 | `Keine durchsuchbaren Dateien im Vault — pinne einen Ordner oder starte die Suche per Rechtsklick auf einen Ordner` | literal | `search.status.noFiles` | German string found |
| 347 | `Keine Treffer (${s.filesScanned} Dateien durchsucht)` | literal | `search.status.empty` | German string found |
| 350 | `${s.hits} Treffer in ${s.filesMatched} Dateien (${s.elapsedMs} ms)` | literal | `search.status.done` | German string found |
| 353 | `— Ergebnis gekürzt, Suchbegriff verfeinern` | literal | `search.status.truncated` | German string found |
| 354 | `— ${s.skippedLarge} große Datei(en) übersprungen` | literal | `search.status.skippedSuffix` | German string found |
| — | `Fehler: {detail}` | setStatus | `search.status.error` | I3a ergänzt |
| — | `Ordner-Scope entfernen` | aria-label/title | `search.scope.clear.ariaLabel` / `.tooltip` | I3a ergänzt |
| 393 | `… weitere Treffer in dieser Datei, Suchbegriff verfeinern` | textContent | `search.results.moreInFile` | **I3a F3:** user-sichtbar (Truncation-Hinweis). Frühere Map-Einstufung „OUT-OF-SCOPE: Markup-Schnipsel“ war falsch — der Text ist lesbar; Render jetzt DOM+`textContent`, nicht `innerHTML` |

## src-tauri/web/app/vault/tree.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/vault/tree.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 239 | `Keine Einträge. Datei öffnen oder per Drag&amp;Drop ablegen.` | innerHTML | `vault.tree.empty` | Empty-State |

## src-tauri/web/app/view/code-copy.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/view/code-copy.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 56 | `Code kopieren` | title | `view.codeCopy.tooltip` | DOM assignment |
| 57 | `Code kopieren` | setAttribute(aria-label) | `view.codeCopy.ariaLabel` | setAttribute text |
| 110 | `Kopiert!` / `Kopieren fehlgeschlagen` | literal | `view.codeCopy.copied` / `view.codeCopy.failed` | Feedback |
| 117 | `Code kopieren` | title | `view.codeCopy.tooltip` | DOM assignment |
| 118 | `Code kopieren` | setAttribute(aria-label) | `view.codeCopy.ariaLabel` | setAttribute text |

## src-tauri/web/app/view/image.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/view/image.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 36 | `convertFileSrc nicht verfügbar` | textContent | `errors.view.imageConvertUnavailable` | **I3a F5:** user-sichtbar im Image-Mount (kein reines Dev-Log); Map früher fälschlich OOS |
| 47 | `convertFileSrc warf: ` | textContent | `errors.view.imageConvertFailed` | `{detail}` |
| 59 | `Bild konnte nicht geladen werden` | textContent | `errors.view.imageLoadFailed` | Fehlertext-Zuweisung |

## src-tauri/web/app/view/mermaid.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/view/mermaid.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 75 | `Laden von mermaid.bundle.js fehlgeschlagen` | literal | `errors.view.mermaidLoadFailed` | Fehler beim Laden des Bundles |
| 114 | `unbekannter Mermaid-Fehler` | literal | `errors.view.mermaidUnknownError` | Fehler-Fallback |

## src-tauri/web/app/view/theme.ts

[Datei öffnen](file:///home/ralf/dev/folio/src-tauri/web/app/view/theme.ts)

| Zeile | Originaler String | Einbau-Pfad | Vorgeschlagener Key | Bemerkung |
| :--- | :--- | :--- | :--- | :--- |
| 10 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 27 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |
| 38 | `standard` | literal | `OUT-OF-SCOPE: Theme-/Layout-ID (technisch)` | German string found |

---

## Sammelabschnitt: Plural- & Kompositionsstellen

Folgende Vorkommen erfordern Segment-Zerlegung oder Pluralformen gemäß Spec v3.1
(`tPlural` / `t_plural`; API injiziert `{count}`):

1. **Wortstatistik (Statusleiste)** — `src-tauri/web/app/state/document.ts:142`
   - Komposition: `statusBar.wordCount.template` = `"{wordsPart} · {charsPart} · {linesPart}"`
   - Segmente:
     - `statusBar.wordCount.wordsPart` = `{ "one": "1 Wort", "other": "{count} Wörter" }`
     - `statusBar.wordCount.charsPart` = `{ "one": "1 Zeichen", "other": "{count} Zeichen" }`
     - `statusBar.wordCount.linesPart` = `{ "one": "1 Zeile", "other": "{count} Zeilen" }`

2. **Vault-Suche Status** — `src-tauri/web/app/vault/search.ts`
   - Kompositionen:
     - `search.status.running` = `"{hitsPart} in {filesPart} …"`
     - `search.status.empty` = `"Keine Treffer ({filesPart} durchsucht)"` (`filesPart` ← filesScanned)
     - `search.status.done` = `"{hitsPart} in {filesPart} ({ms} ms)"` (`filesPart` ← filesMatched)
     - `search.status.truncated` = `" — Ergebnis gekürzt, Suchbegriff verfeinern"`
     - `search.status.skippedSuffix` = `" — {skippedPart} übersprungen"`
   - Segmente:
     - `search.status.hitsPart` = `{ "one": "1 Treffer", "other": "{count} Treffer" }`
     - `search.status.filesPart` = `{ "one": "1 Datei", "other": "{count} Dateien" }`
     - `search.status.skippedPart` = `{ "one": "1 große Datei", "other": "{count} große Dateien" }`

3. **Weitere Layouts (Export)** — `src-tauri/web/app/ui/export-dialog.ts:144`
   - Bevorzugt ein Plural-Key: `export.layouts.more` = `{ "one": "Weiteres Layout (1)", "other": "Weitere Layouts ({count})" }`
   - Alternativ Komposition: `export.layouts.moreTemplate` + `export.layouts.moreCountPart`

4. **Papierkorb-Bestätigung** — `vault.contextMenu.deleteConfirm` = `"„{name}“ in den Papierkorb verschieben?"`

5. **Ausführen-Bestätigung** — `dialogs.run.confirm` = `"„{name}“ als Programm ausführen?"` (Button: `dialogs.run.submit.action`)

6. **Tab-Close-Tooltip** — `tabs.close.tooltip` = `"{label} schließen"`

7. **KI-Diff-Titel** — `ai.diffReview.title` = `"✨ KI-Review — {actionName}"`

8. **KI-Status mit Zeichenzahl** (Translate / Actions / Export-AI / Theme-AI)
   - Komposition z. B. `ai.status.runningTemplate` = `"{title} · {charsPart}"`
   - Segment: `ai.status.charsPart` = `{ "one": "1 Zeichen", "other": "{formattedCount} Zeichen" }`
     (`formattedCount` via `fmtNumber` — lokalisierte Gruppierung gewollt; I3b-Fix F2c)
   - Selektion: `ai.actions.scope.selectionWithCount` = `"Selektion ({charsPart})"` + gleiches Segment

---


## Sammelabschnitt: Locale-Operationen

Folgende Stellen rufen locale-abhängige JS-Funktionen auf und müssen auf die neuen `app/i18n/format.ts`-Helfer umgestellt werden:

| Datei:Zeile | Aktueller Code | Zu ersetzender Helfer |
| :--- | :--- | :--- | :--- | :--- |
| `src-tauri/web/app/ui/ai-actions-dialog.ts` (Scope/Stream) | `toLocaleString('de-DE')` | `fmtNumber` + `tPlural(ai.status.charsPart)` — **I3b erledigt** |
| `src-tauri/web/app/ui/ai-actions-dialog.ts:1076` | `toLocaleString('de-DE')` | `fmtNumber` |
| `src-tauri/web/app/ui/export-ai.ts:422` | `toLocaleString('de-DE')` | `fmtNumber` |
| `src-tauri/web/app/ui/theme-ai-dialog.ts:216` | `toLocaleString('de-DE')` | `fmtNumber` |
| `src-tauri/web/app/ui/translate-dialog.ts:338` | `toLocaleString('de-DE')` | `fmtNumber` |
| `src-tauri/web/app/ui/settings-ai.ts:696` | `new Intl.DateTimeFormat('de-DE', ...)` | `fmtDate` |
| `src-tauri/web/app/ui/theme-editor.ts` | `.toFixed(1) + ' MB'` | `fmtBytes` (SI 1000er KB/MB — I3b-Fix F5) |
| `src-tauri/web/app/ui/settings-ai.ts:297` | `.toLocaleLowerCase('de')` | `normalizeForSearch` |
| `src-tauri/web/app/ui/settings-ai.ts:314` | `.toLocaleLowerCase('de')` | `normalizeForSearch` |
| `src-tauri/web/app/ui/settings-ai.ts:589` | `.toLocaleLowerCase('de')` | `normalizeForSearch` |
| `src-tauri/web/app/ui/settings-ai.ts:612` | `.toLocaleLowerCase('de')` | `normalizeForSearch` |
| `src-tauri/web/app/ui/settings-ai.ts:616` | `.toLocaleLowerCase('de')` | `normalizeForSearch` |
| `src-tauri/web/app/ui/ai-model-picker.ts:61` | `.localeCompare(..., 'de')` | `compareStrings` |
| `src-tauri/web/app/ui/settings-ai.ts:340` | `.localeCompare(..., 'de')` | `compareStrings` |
| `src-tauri/web/app/ui/settings-ai.ts:502` | `.localeCompare(..., 'de')` | `compareStrings` |
| `src-tauri/web/app/ui/settings-ai.ts:593` | `.localeCompare(..., 'de')` | `compareStrings` |
| `src-tauri/web/app/ui/language-picker.ts:23` | `.localeCompare(...)` (ohne locale) | `compareStrings` |

---

## Abschluss & Zählung (Key-Überarbeitung grok, Spec v3.1)

| Metrik | Wert |
| :--- | ---: |
| Tabellen-Zeilen (Surface-Fundstellen inkl. OOS) | 807 |
| In-Scope (zu extrahieren) | 696 |
| OUT-OF-SCOPE (Vollständigkeitsnachweis) | 111 |
| Eindeutige In-Scope-Key-Strings | 558 |
| Ungültige Top-Level-Namespaces | 0 |
| `common.*` außer `dialogs.common.*` | 0 |
| Wortlaut-/Transliterations-Verdacht | 0 |

### Namespaces (eindeutige Keys)

| Namespace | Anzahl |
| :--- | ---: |
| `errors` | 134 |
| `settings` | 110 |
| `ai` | 64 |
| `toolbar` | 47 |
| `theme` | 38 |
| `dialogs` | 39 |
| `menu` | 35 |
| `vault` | 25 |
| `export` | 23 |
| `search` | 13 |
| `find` | 7 |
| `statusBar` | 6 |
| `editor` | 5 |
| `view` | 5 |
| `tabs` | 4 |
| `cheatsheet` | 3 |

### I0-Abnahmekriterien (Spec Etappe I0)

| # | Kriterium | Status |
| :---: | :--- | :---: |
| a | Nur kanonische Namespaces; kein `common` außer `dialogs.common.*` | ✅ |
| b | Englische Funktions-Keys (camelCase); kein Wortlaut/Umlaut-Strip | ✅ |
| c | Test-/Log-/False-Positives als `OUT-OF-SCOPE: …`, nicht als Katalog-Keys | ✅ |
| d | Wrapper-Spalte im `index.html`-Abschnitt (`ja` bei Nicht-Leaf) | ✅ |
| e | Plural-/Kompositions-Liste (Segment-Muster) + Locale-Operations-Liste | ✅ |

**Abnahme:** Diese Map ist die Arbeitsgrundlage für I1a–I4. Keys sind 1:1 für
`locales/*.json`, `data-i18n-*` und `t()`/`tPlural()` vorgesehen.
`dialogs.common.*` nur: `ok`, `cancel`, `save`, `discard`, `close`.
`menu.*` deckt den vollständigen `MenuLabels`-Satz ab (I1a).

*Überarbeitet: 2026-07-13 · grok (Implementierer) · Spec v3.1 Naming*

---

## I3b — Kanonische Key-Registry (Dialoge/Settings/AI/Theme/Export)

Nach Etappe I3b + Fix-Paket. Regeln (F2): (a) Validierung/Fehler → `errors.<modul>.<fall>`;
(b) Map-Key gewinnt außer Implementierung klar besser → Map korrigiert;
(c) `ai.status.charsPart` nutzt `{formattedCount}` (fmtNumber).

### AI Actions / Status

| Key | de (zeichengenau) | Bemerkung |
| :--- | :--- | :--- |
| `ai.actions.customPrompt.name` | Eigener Prompt | |
| `ai.actions.customPrompt.description` | Freie Anweisung ohne Vorlage. | |
| `ai.actions.customTemplate.badge` | Eigene Vorlage | Map-alt |
| `ai.actions.deleteTemplate.ariaLabel` | Vorlage löschen | Map-alt |
| `ai.actions.deleteTemplate.confirm` | Die Vorlage „{name}" löschen? | Map-alt |
| `ai.actions.deleteTemplate.submit` | Löschen | Map-alt |
| `ai.actions.favorite.add.ariaLabel` | Als Favorit markieren | |
| `ai.actions.favorite.remove.ariaLabel` | Favorit entfernen | |
| `ai.actions.favorites.empty` | Favoriten im ✨-Dialog markieren. | Map-alt |
| `ai.actions.saveTemplate.emptyName` | Bitte einen Namen angeben. | |
| `ai.actions.scope.selectionWithCount` | Selektion ({charsPart}) | F1: + `ai.status.charsPart` |
| `ai.actions.status.cancelling` | Bricht ab… | Map-alt |
| `ai.actions.status.charCount` | ✨ {actionName} · {charsPart} | Map-alt |
| `ai.actions.status.done` | ✓ {actionName} | |
| `ai.actions.status.error` | ✕ {detail} | |
| `ai.actions.status.errorNamed` | ✕ {actionName}: {detail} | |
| `ai.actions.status.running` | Läuft… | Map-alt |
| `ai.status.charsPart` | one: 1 Zeichen / other: {formattedCount} Zeichen | F2c |
| `ai.chatTest.roleUser` | Du | Map-alt |
| `ai.chatTest.roleAssistant` | Modell | Map-alt |

### AI Diff / Translate

| Key | de | Bemerkung |
| :--- | :--- | :--- |
| `ai.diffReview.title` | ✨ KI-Review — {actionName} | Map-alt |
| `ai.diffReview.titlePlain` | ✨ KI-Review | Map-alt |
| `ai.diffReview.discard.confirm` | Die bearbeitete KI-Review verwerfen? | |
| `ai.diffReview.discard.title` | KI-Review | |
| `ai.diffReview.discardAndExit.confirm` | Die bearbeitete KI-Review wird beim Beenden verworfen. Fortfahren? | |
| `ai.diffReview.discardAndExit.action` | Verwerfen und beenden | Map-alt |
| `ai.diffReview.apply.overwriteConfirm` | Das Dokument wurde zwischenzeitlich geändert — Ersetzen überschreibt diese Änderungen. | Map-alt |
| `ai.diffReview.apply.overwrite.action` | Trotzdem ersetzen | |
| `ai.diffReview.activateSource.hint` | Bitte zuerst den Quell-Tab aktivieren. | |
| `ai.translate.status.running` | Übersetze… | Map-alt |
| `ai.translate.status.cancelling` | Bricht ab… | Map-alt |
| `ai.translate.status.charCount` | KI-Übersetzung {language} · {charsPart} | Map-alt |
| `ai.translate.status.done` | ✓ {language} | |
| `ai.translate.status.doneWithNext` | ✓ {language} · KI-Übersetzung {next} · {charsPart} | |

### errors.ai (Validierung/Laufzeit)

| Key | de | Bemerkung |
| :--- | :--- | :--- |
| `errors.ai.emptyPrompt` | Der Prompt darf nicht leer sein. | F4: einziger Prompt-Leer-Key (promptRequired entfernt) |
| `errors.ai.noEnabledModel` | Kein freigeschaltetes Modell verfügbar. | Map-alt |
| `errors.ai.noModelSelected` | Bitte ein Modell auswählen. | Map-alt |
| `errors.ai.invalidModelSelection` | Die Modellauswahl ist ungültig. | Map-alt |
| `errors.ai.noTargetLanguage` | Bitte mindestens eine Zielsprache auswählen. | F2a (war ai.translate.*) |
| `errors.ai.reviewOpen` | Erst die offene KI-Review abschließen. | Map-alt |
| `errors.ai.sourceChanged` | Die Quelle hat sich geändert — Dialog bitte neu öffnen. | |
| `errors.ai.documentChanged` | Das Dokument wurde zwischenzeitlich geändert — Dialog bitte neu öffnen. | |
| `errors.ai.documentChangedDuringStart` | Das Dokument wurde während des Starts geändert — bitte erneut starten. | |
| `errors.ai.sourceTabClosed` | Der Quell-Tab wurde geschlossen — Übernehmen ist nicht mehr möglich. | Map-alt |
| `errors.ai.tauriUnavailable` | Tauri-Schnittstelle ist nicht verfügbar. | |
| `errors.ai.generationFailed` | Generierung fehlgeschlagen. | F4 (war errors.export.generationFailed) |
| `errors.ai.builtinTemplateDelete` | Eingebaute Aktionen können nicht gelöscht werden. | I4b-Fix F5: eigentliche Nutzerbotschaft, kein Diagnose-Detail |
| `errors.export.aiGenerateFailed` | KI-Generierung fehlgeschlagen. | Export-Draft-Status |
| `errors.export.failed` | Export fehlgeschlagen | Map-alt |
| `errors.theme.assetTooLarge` | Das Asset darf höchstens 5 MB groß sein. | |
| `errors.theme.baseRequired` | Bitte ein Basis-Theme wählen. | Map-alt |
| `errors.theme.assetDirectoryRequired` | Verzeichnis-Theme `{id}` für Asset-Vorgang erforderlich | I4b-Fix F3, direkter Domainfehler |
| `errors.theme.builtinDelete` / `.builtinReadOnly` | Eingebautes Theme kann nicht gelöscht/geändert werden | I4b-Fix F3, direkter Domainfehler |
| `errors.theme.cloneUnsupported` | Theme kann nicht dupliziert werden | I4b-Fix F3, direkter Domainfehler |
| `errors.theme.idTaken` / `.invalidId` | Theme-ID bereits vergeben / ungültig | I4b-Fix F3, direkter Domainfehler |

### Export / Image / Theme

| Key | de | Bemerkung |
| :--- | :--- | :--- |
| `export.layouts.more` | one/other Plural | Map-alt |
| `export.status.running` / `.done` | Export läuft… / Exportiert: {path} | Map-alt |
| `export.aiDraft.base.none` | Kein Basis-Theme | F2b: statt noBaseTheme |
| `export.aiDraft.card.name` / `.defaultDesc` / `.defaultName` | KI-Entwurf / … | |
| `export.aiDraft.generating` | Erzeuge... | |
| `export.aiDraft.status.*` | ready/readyResult/cancelling/charCount | Map-alt + ergänzt |
| `export.aiDraft.saveDialog.idInvalid` / `.displayNameEmpty` | … | |
| `export.aiDraft.themeSaved.status` | Theme gespeichert: {name} | Map-alt |
| `export.aiDraft.transientLabel` | Transientes KI-Layout… | Map-alt |
| `dialogs.image.*` | loadFailed, noClipboardImage, noFileChosen, pick*, insert*, targetDirEmpty, noDocOpen.warning, docPathNoDirectory.warning, outsideDocumentTree.warning, canvasContextUnavailable | I3b + I4b-Fix F2 |
| `theme.editor.assets.logo.badge` / `.remove.tooltip` | als Logo / Asset entfernen | Map-alt |
| `theme.editor.aiDialog.generating` / `.status.cancelling` / `.status.charCount` | … | |

### Settings AI / Themes

| Key | de | Bemerkung |
| :--- | :--- | :--- |
| `settings.ai.auth.keyStored` / `.keyMissing` / `.changeKey.action` / `.setKey*` / `.remove.action` / `.keyEmpty` / `.keyAriaLabel` / `.active.label` | Schlüssel-UI | |
| `settings.ai.catalog.sourceCache` | Cache | F3 |
| `settings.ai.catalog.sourceSnapshot` | Snapshot | F3 (fr: Instantané) |
| `settings.ai.models.catalogAge` | Katalogstand: {date} ({source}) | Map-alt Wrapper |
| `settings.ai.model.*` | contextBadge, costBadge, reasoning/tools/use/test | |
| `settings.ai.providers.*` | apiLabel, docLabel, empty, noneMatch, fetchModels.*, models.empty | |
| `settings.ai.loading.status` / `.loadFailed` / `.edit.action` / `.custom.edit.title` | … | |
| `settings.themes.*` | active/custom/builtin badges, variants, detail.*, favorite*, use.*, clone/export/delete.confirmNamed, customDir.hint, createDialog.* | |

*I3b-Fix-Paket 2026-07-14 · F1–F5 kanonisiert*

---

## I4a — Kanonische Key-Registry (native Dialoge, Built-ins, Export)

### Native Dialoge / Filter

| Key | de (zeichengenau) | Bemerkung |
| :--- | :--- | :--- |
| `menu.file.rename` | Umbenennen… | rename-Dialog-Titel via `labels().file_rename` |
| `menu.file.saveAs` | Speichern unter… | save_as-Dialog-Titel |
| `menu.filter.images` | Bilder | image-Picker |
| `menu.filter.all` / `.markdown` / `.text` | Alle Dateien / … | bestehende Filter via labels() |
| `export.formats.html` / `.pdf` | HTML / PDF | Export-Save-Filter |
| `dialogs.icon.title` | Markdown-Icon-Integration | Linux-Icon-Dialog |
| `dialogs.icon.confirm` | Diese Funktion richtet … Jetzt einrichten? | (ASCII-Umlautschreibweise wie historisch) |
| `dialogs.icon.setup.action` | Einrichten | |
| `dialogs.icon.success` | Das Folio-Icon wurde … | |
| `dialogs.icon.scriptNotFound` | Das Installations-Skript … | |
| `dialogs.common.cancel` | Abbrechen | Icon-Dialog-Button |

### Built-in Themes (deklarativ, Allowlist `theme.builtin.`)

Keys: `theme.builtin.<id>.name` / `.description` für IDs
`standard|classic|clean|github|business|report|minimal|brand|warm|tech|contrast|pastel`.
Auflösung: `i18n::theme_builtin_name/description` (ID-Komposition, kein `t("literal")`).
de-Namen/Beschreibungen zeichengenau wie vor I4a (E2E 38_theme_browser).

### Built-in KI-Actions (Allowlist `ai.actions.<segment>.`)

| Template-ID | Key-Segment | de name |
| :--- | :--- | :--- |
| `summarize` | summarize | Zusammenfassen |
| `reformat` | reformat | Neu formatieren |
| `proofread` | proofread | Korrektur lesen |
| `to-table` | toTable | Daten als Tabelle |
| `extract-actions` | extractActions | Aktionspunkte extrahieren |

Die fünf Built-in-Prompts sind seit I5 feste englische Instruktionen mit
expliziter Dokumentsprachen-Regel und bleiben bewusst un-katalogisiert.
Custom-Templates bleiben unangetastet.

### Export-Surface

| Key | de | en |
| :--- | :--- | :--- |
| `export.cover.createdBy` | Erstellt von | Created by |
| `export.cover.preparedBy` | Vorbereitet von: | Prepared by: |
| `export.defaultTitle` | Dokument | Document |

Template-Platzhalter `{{createdBy}}` / `{{preparedBy}}` in brand/business.cover.html
(WHITELIST-Einträge lowercase: `createdby`/`preparedby` für author-Validate).
`<html lang>` = `catalogTag`; Datums-Fallback via `format_export_date` auf dem
**vollen** `formatLocale` (BCP-47): z. B. `en-US` → MM/DD/YYYY, `en-GB` →
DD/MM/YYYY, `fr-CA` → YYYY-MM-DD, `fr-FR` → DD/MM/YYYY, `de-*` → DD.MM.YYYY;
Sprach-Default ohne Region: en→US, fr→FR, de→DE-Muster; sonst ISO.
| `export.preview.title` | Theme-Vorschau | Theme preview |

Built-in-Registry: `THEME_BUILTIN_CATALOG` / `AI_ACTION_BUILTIN_CATALOG` mit
literalen Keys (kein `format!`, keine Allowlist-Präfixe).

*I4a 2026-07-14 · native Dialoge, Built-ins, Export · Fix-Paket F1–F8*

## I4b — Kanonische Error-Ränder

Die Rust-Ränder verwenden `errors.<modul>.<fall>`; OS-/IO-/Provider-Texte,
Pfade und IDs werden ausschließlich als `{detail}` interpoliert. Die in den
obigen Rust-Zeilen vorgeschlagenen Keys wurden dabei wie folgt versöhnt:

| Modul | Kanonische I4b-Keys (zusätzlich zu bereits vorhandenen) |
| :--- | :--- |
| `commands/file/*` | `errors.file.alreadyExists`, `.clipboardDecodeFailed`, `.closeFailed`, `.copyFailed`, `.createFailed`, `.deleteFailed`, `.imageBufferInvalid`, `.imageDataInvalid`, `.imageDimensionsOverflow`, `.listFailed`, `.mkdirFailed`, `.notExecutable`, `.openFailedWithDetail`, `.pngEncodeFailed`, `.reloadFailed`, `.renameFailed`, `.saveFailed`, `.sourceMissing`, `.targetAlreadyExists`, `.tempCreateFailed`, `.unsupportedType` |
| `commands/editor.rs` | `errors.editor.discardFailed`, `.saveFailed`, `.sourceTabMissing`, `.unsupportedLineEndings` |
| `commands/export.rs` | `errors.export.pdfFailed`, `.writeFailed`; dokumentlos weiter `errors.document.noneOpen` |
| `commands/theme.rs`, `theme/store.rs`, `theme/archive.rs` | IO-/Systemrahmen: `errors.theme.assetDecodeFailed`, `.assetFailed`, `.cloneFailed`, `.createFailed`, `.deleteFailed`, `.eventFailed`, `.exportFailed`, `.importFailed`, `.writeFailed`; direkte Domainfälle: `.assetDirectoryRequired`, `.builtinDelete`, `.builtinReadOnly`, `.cloneUnsupported`, `.idTaken`, `.invalidId`, `.unknown` |
| `commands/app/*` | `errors.app.fileManagerFailed`, `.iconNoOutput`, `.iconScriptFailed`, `.iconSetupFailed`, `.openDefaultFailed`, `.runFileFailed`, `.settingsUpdateFailed`, `.terminalFailed` |
| `commands/ai.rs` / KI-Ränder | `errors.ai.*` gemäß den literalen `t`/`t_args`-Referenzen; `AiConfigError`, `CatalogError`, `AuthError` und `ChatError` werden am Command-Rand gewrappt |
| `search.rs` | `errors.search.queryTooShort`, `.rootNotFound`, `.invalidScope`, `.invalidQuery`; `SearchError::Display` delegiert an `localized`, vor Prozess-Init mit Key-Fallback |
| `vault.rs` | keine `Result<_, String>`-UI-Fehlergrenze; Renderfehler bleiben Log + leerer Baum (kein neuer Error-Key) |

Stichprobentests verwenden lokale `Translator`-Instanzen für Datei-, Theme-,
KI- und Suchfehler. Angepasste Alt-Asserts: `commands/file/create.rs`
(`existiert bereits`, exakter deutscher Dateiname), `commands/theme.rs`
(`Unbekanntes Theme`), `commands/ai.rs` (`keinen bekannten Endpoint`) — nun
englischer Rahmen plus unverändertes technisches Detail.

*I4b 2026-07-14 · Backend-Fehlergrenzen, thiserror-Entscheidung, Contract*


### Hinweis

False-Positives (Tests, Logs, Markup, technische IDs, Markennamen) bleiben als
Zeilen mit `OUT-OF-SCOPE: <grund>` stehen — das ist der
Vollständigkeitsnachweis des Surface-Scans, nicht Kataloginhalt.
