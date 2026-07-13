# Review: i18n-Rust-Fundament (Etappe I1a)

Dieses Dokument enthält das detaillierte Code-Review des aktuellen, uncommitteten Arbeitsstandes für die Etappe I1a (Rust-Fundament für die Internationalisierung).

---

## 1. Für gut befunden (Approved)

Folgende Implementierungsdetails sind hervorragend gelöst und entsprechen vollumfänglich der Spezifikation (v3.1):

* **Konsolidiertes Boot-Konzept**:
  * *Datei*: [`src-tauri/src/lib.rs:513-556`](file:///home/ralf/dev/folio/src-tauri/src/lib.rs#L513-L556) (`run`)
  * *Lob*: Die Initialisierungsreihenfolge ist extrem sauber gelöst. Settings werden genau einmal geladen, migriert, für Logging/i18n-Setup verwendet und danach an den AppState übergeben. Dies eliminiert redundante Dateizugriffe und garantiert konsistente Spracheinstellungen ab der ersten Logzeile.
* **Robuste Build-Time Validierung (Fail-Closed)**:
  * *Datei*: [`src-tauri/src/i18n/catalog.rs:237-325`](file:///home/ralf/dev/folio/src-tauri/src/i18n/catalog.rs#L237-L325) (`validate_catalog_set`)
  * *Lob*: Der Generator validiert rigoros alle Katalogbedingungen zur Compilezeit. Die Prüfung auf Key-Parität, Platzhalter-Konsistenz, Typ-Gleichheit und Sortierordnung (mittels eines duplikat-erhaltenden JSON-Visitors) fängt ungültige Lokalisierungsdateien sofort ab und verhindert kaputte Runtime-Übersetzungen.
* **Erweiterbarkeitstest**:
  * *Datei*: [`src-tauri/src/i18n/tests/generator.rs:176-213`](file:///home/ralf/dev/folio/src-tauri/src/i18n/tests/generator.rs#L176-L213) (`extensibility_temp_dir_with_fr_fixture`)
  * *Lob*: Der Test kopiert die Kataloge sowie die französische Fixture-Datei `fr.json` in ein temporäres Verzeichnis und führt den Code-Generator aus. Dies beweist das Hauptkriterium: Eine neue Sprache kann ohne jegliche Codeänderung am Backend hinzugefügt werden.
* **Fehler-Deduplizierung**:
  * *Datei*: [`src-tauri/src/i18n/mod.rs:156-169`](file:///home/ralf/dev/folio/src-tauri/src/i18n/mod.rs#L156-L169) (`warn_once`)
  * *Lob*: Das Deduplizieren von Lookup-Fehlern mittels eines thread-sicheren `BTreeSet` verhindert Log-Spamming im Produktionsbetrieb (z. B. wenn bei schnellen UI-Updates unübersetzte Tasten gedrückt werden).
* **Qualität der Kataloge**:
  * *Dateien*: [`de.json`](file:///home/ralf/dev/folio/src-tauri/locales/de.json), [`en.json`](file:///home/ralf/dev/folio/src-tauri/locales/en.json), [`fr.json`](file:///home/ralf/dev/folio/tests/fixtures/locales/fr.json)
  * *Lob*: Alle drei Sprachdateien weisen eine exakte Parität auf. Die Übersetzungen (inkl. der französischen Ausdrücke wie *Mode lecture* für View-Mode) sind fachlich präzise und stimmig.

---

## 2. Blocker (Kritische Abweichungen / Code-Smells)

* **Die drei `labels("de")`-Hardcodes sind noch aktiv**:
  * *Dateien*: 
    * [`src-tauri/src/commands/file/rename.rs:47`](file:///home/ralf/dev/folio/src-tauri/src/commands/file/rename.rs#L47)
    * [`src-tauri/src/commands/file/save_as.rs:35`](file:///home/ralf/dev/folio/src-tauri/src/commands/file/save_as.rs#L35)
    * [`src-tauri/src/menu/recent.rs:31`](file:///home/ralf/dev/folio/src-tauri/src/menu/recent.rs#L31)
  * *Problem*: In allen drei Dateien wird beim Aufruf von `menu_strings::labels("de")` das Sprachkürzel `"de"` hartkodiert übergeben. Zur Laufzeit in der App wird dies zwar durch das `OnceLock` in `BOOT_LABELS` überschrieben (da die Sprache dort ignoriert wird, sobald gebootet wurde). In Unit-Tests vor dem Booten führt dies jedoch dazu, dass *immer* die deutschen Labels zurückgegeben werden, selbst wenn ein Test ein anderes Sprachverhalten überprüfen möchte.
  * *Lösung*: Die Signatur von `labels()` sollte idealerweise parameterlos sein (da sie zur Runtime ohnehin global gesteuert wird) oder standardmäßig auf den globalen Translator bzw. ein neutrales Fallback zurückgreifen.

---

## 3. Empfehlungen (Recommendations)

* **Redundantes Parsen der embedded Registry zur Laufzeit**:
  * *Dateien*: 
    * [`src-tauri/src/settings.rs:343`](file:///home/ralf/dev/folio/src-tauri/src/settings.rs#L343) (Validierung in `apply_patch`)
    * [`src-tauri/src/automation/handlers/settings.rs:24`](file:///home/ralf/dev/folio/src-tauri/src/automation/handlers/settings.rs#L24) (Validierung in POST-Handler)
  * *Problem*: Bei jeder Einstellungs-Mutation (Tauri-Patch oder Automation-POST), die das Sprachfeld ändert, wird `load_embedded_registry()` aufgerufen. Dies führt dazu, dass alle JSON-Kataloge zur Laufzeit komplett neu eingelesen und geparst werden.
  * *Lösung*: Da der Translator bereits einmal zur Bootzeit initialisiert wird und global im `PROCESS_TRANSLATOR` vorliegt, sollte eine öffentliche Methode wie `pub fn registry() -> &'static CatalogRegistry` (oder ähnlich) im `i18n`-Modul bereitgestellt werden. Damit kann auf die bereits im Speicher befindliche Registry zugegriffen werden, ohne die Kataloge erneut parsen zu müssen.
* **Unnötiges Klonen in `lookup_value`**:
  * *Datei*: [`src-tauri/src/i18n/mod.rs:139`](file:///home/ralf/dev/folio/src-tauri/src/i18n/mod.rs#L139)
  * *Problem*: Die Methode `lookup_value` gibt ein geclonetes `CatalogValue` zurück (`Some(v.clone())`). Da `CatalogValue` owned Strings und BTreeMaps enthält, führt dies bei jedem `t()`-Aufruf zu Heap-Allokationen und Deep-Clones der kompletten Übersetzungen, noch bevor die Formatierung/Interpolation stattfindet.
  * *Lösung*: Ändere die Signatur der Hilfsfunktion so ab, dass eine Referenz auf das Element im Katalog zurückgegeben wird:
    ```rust
    fn lookup_value(&self, key: &str) -> Option<&CatalogValue>
    ```
    Da `&self.registry` die gleiche Lebenszeit besitzt wie `self`, ist das borrow-checker-technisch absolut valide. Das Klonen der Strings kann dann gezielt erst in den End-Methoden `t()` bzw. `t_plural()` stattfinden.

---

## 4. Nice-to-have

* **Temporäre `.tmp`-Dateien bei atomaren Schreibvorgängen**:
  * *Datei*: [`src-tauri/src/i18n/mod.rs:402`](file:///home/ralf/dev/folio/src-tauri/src/i18n/mod.rs#L402) (`atomic_write_json`)
  * *Problem*: Wenn das Umbenennen der Datei `fs::rename(&tmp, path)` fehlschlägt, bleibt die temporäre Datei `.tmp` dauerhaft im Konfigurationsverzeichnis liegen und vermüllt dieses.
  * *Lösung*: Füge im Fehlerpfad eine Löschoperation hinzu:
    ```rust
    let _ = fs::remove_file(&tmp);
    ```
