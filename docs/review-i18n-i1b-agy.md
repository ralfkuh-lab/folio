# Review der Etappe I1b: i18n-Frontend-Fundament + Ready-Gate

Dieses Dokument enthält das unabhängige Diff-Review für die Etappe I1b der Internationalisierung (i18n) im Projekt **folio**. Das Review basiert auf den Vorgaben in [spec-i18n.md](file:///home/ralf/dev/folio/docs/spec-i18n.md) (Etappe I1b).

---

## Zusammenfassung der Verifikation

Sämtliche automatisierten Prüfungen laufen erfolgreich durch:
- **Rust Integration- und Unit-Tests**: 612 Tests erfolgreich bestanden.
- **Frontend Vitest-Suite**: 318 Tests (inkl. i18n-spezifischer Tests) erfolgreich bestanden.
- **E2E Automation-Suite**: Alle 47 Szenarien (inkl. `47_vault_search_ui` und der i18n `FOLIO_LANG=de` Pins) erfolgreich bestanden.

---

## 1. Blocker
Es wurden **keine kritischen Blocker** im uncommitteten Diff identifiziert. Alle Kernanforderungen aus der Spezifikation wurden funktional korrekt umgesetzt.

---

## 2. Empfehlungen

### E1: Speicherleck in der `listen`-Wrapper-Registrierung bei `dispose`
> [!WARNING]
> In [event-queue.ts](file:///home/ralf/dev/folio/src-tauri/web/app/i18n/event-queue.ts#L156-L165) speichert das gepatchte `ev.listen` den Handler in `registeredHandlers`:
> ```typescript
> ev.listen = function (eventName: string, handler: Handler) {
>     registeredHandlers.push({ event: eventName, handler });
>     return original(eventName, function (event: any) { ... });
> };
> ```
> Wenn die vom originalen `listen` zurückgegebene `unlisten`-Funktion aufgerufen wird (z. B. in [search.ts](file:///home/ralf/dev/folio/src-tauri/web/app/vault/search.ts#L829) beim Dispose des Such-Panels), wird der Handler zwar im Tauri-Backend ausgetragen, verbleibt aber dauerhaft in `registeredHandlers`.
>
> **Auswirkung**: Dies führt zu einem schleichenden Speicherleck, falls Komponenten dynamisch erstellt und verworfen werden. In der Praxis bei Folio ist dies unkritisch, da die meisten UI-Komponenten langlebige Singletons sind, führt jedoch bei Unit-Tests ohne expliziten Reset zu Akkumulationen.
>
> **Lösungsvorschlag**: Die zurückgegebene `unlisten`-Funktion wrappen, um den Eintrag aus `registeredHandlers` zu entfernen:
> ```typescript
> ev.listen = function (eventName: string, handler: Handler) {
>     const record = { event: eventName, handler };
>     registeredHandlers.push(record);
>     const p = original(eventName, function (event: any) {
>         if (phase !== 'uiReady') return;
>         return handler(event);
>     });
>     return p.then(function (unlistenFn) {
>         return function () {
>             const idx = registeredHandlers.indexOf(record);
>             if (idx >= 0) registeredHandlers.splice(idx, 1);
>             unlistenFn();
>         };
>     });
> };
> ```

### E2: Fehlende Unit-Tests für `initI18n()`
> [!NOTE]
> Die i18n-Tests in [translate.test.ts](file:///home/ralf/dev/folio/src-tauri/web/tests/i18n/translate.test.ts#L12-L25) testen ausschließlich die `t()`- und `tPlural()`-Funktionen über einen manuell geimpften Katalog via `seedCatalog()`.
>
> **Auswirkung**: Die Funktionalität von `initI18n()` (Abfrage der Tauri-API und Fehler-Fallback-Verhalten) wird im Frontend-Unit-Test-Umfeld nicht abgedeckt.
>
> **Lösungsvorschlag**: Hinzufügen eines Vitest-Tests, der `window.__TAURI__.core.invoke` für den Command `i18n_catalog` mockt und verifiziert, dass `initI18n()` den Katalog korrekt parst bzw. bei Fehlern den Degradations-Fallback (Katalog = `null`) ansteuert.

---

## 3. Nice-to-have

### N1: Bereinigung ungenutzter Platzhalter-Parameter
In [translate.ts](file:///home/ralf/dev/folio/src-tauri/web/app/i18n/translate.ts#L92) wird im Catch-Block von `Intl.PluralRules` der ungenutzte Parameter `_` deklariert. Dies könnte zur Vermeidung von Warnungen/Lint-Resten entfernt werden (`catch { ... }` in modernem TypeScript).

---

## 4. Für gut befunden

### G1: Exakte Beibehaltung der Modul-Initialisierungsreihenfolge
In [main.ts](file:///home/ralf/dev/folio/src-tauri/web/app/main.ts#L99-L142) wurde die ursprüngliche, feste Modul-Initialisierungsreihenfolge in der neuen Hilfsfunktion `runModuleInits()` Zeile für Zeile exakt beibehalten. Ein unbeabsichtigtes Verschieben von Modulabhängigkeiten ist ausgeschlossen.

### G2: Zuverlässiges Boot-Timing und Patch-Reihenfolge
Durch den Import von `./i18n/event-queue` als **erste Zeile** in `main.ts` ist sichergestellt, dass die globale `listen`-Funktion von Tauri gepatcht wird, bevor andere TypeScript-Module ihre Event-Listener auf Modulebene registrieren. Dies garantiert ein lückenloses Abfangen aller Boot-Events.

### G3: Mechanische Vollständigkeit des Event-Adapters
Ein Abgleich aller `listen`-Aufrufe im gesamten Frontend-Repository (`src-tauri/web/app/`) mit der Liste `BOOT_EVENT_NAMES` in [event-queue.ts](file:///home/ralf/dev/folio/src-tauri/web/app/i18n/event-queue.ts#L15-L97) ergab eine 100%ige Übereinstimmung. Es fehlen keine Event-Namen und es gibt keine Schreibfehler.

### G4: Keine unnötigen Speicher-Kopien (Performance)
Die Implementierung von `t()` und `tPlural()` greift direkt per Referenz auf die geladene JSON-Map im Translator-Modul ([translate.ts](file:///home/ralf/dev/folio/src-tauri/web/app/i18n/translate.ts#L28-L31)) zu. Es finden keine Kopieraktionen pro Übersetzung statt.

### G5: Robuste Rust `wait_ready`-Synchronisation
Die asynchrone Implementierung des Ready-Gates in [ready.rs](file:///home/ralf/dev/folio/src-tauri/src/i18n/ready.rs#L33-L57) nutzt ein `tokio::sync::Notify`-Signal in Kombination mit einer Timeout-Prüfung. Sie vermeidet CPU-Spinning vollständig und ist durch Abonnieren des Notifiers *vor* dem Re-Check gegen Edge-Trigger-Verluste gesichert.

### G6: Saubere Platzierung des `FOLIO_LANG=de` Pins in E2E-Skripten
Der Pin wurde sowohl in [run-e2e.sh](file:///home/ralf/dev/folio/scripts/run-e2e.sh#L159) als auch im Python-Orchestrator [run.py](file:///home/ralf/dev/folio/tests/e2e/run.py#L196) korrekt als Umgebungsvariable deklariert und wirkt auf die jeweiligen Tauri-Prozesse. Der Assert-Check auf `/state.lang` beim Startup stellt sicher, dass Tests fehlschlagen, falls der Pin unwirksam sein sollte.

### G7: Einhaltung der CLAUDE.md Logging-Konventionen
Die Verwendung von `console.warn` in den Kern-i18n-Modulen ist mit `// eslint-disable-next-line no-console` versehen und aufgrund des frühen Bootstrappings (bevor `folioLog` instanziiert bzw. konfiguriert ist) technisch notwendig, um Zirkelbezüge zu vermeiden. Alle anderen Modul-Meldungen nutzen standardkonform `folioLog`.
