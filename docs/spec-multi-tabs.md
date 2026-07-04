# Spec: Multi-Datei-Tabs

> **Arbeitsdokument mit Fortschritts-Checkliste.** Checkboxen werden
> pro abgeschlossener, grün getesteter Etappe abgehakt und committet.
> Grundlage: Kartierung der Single-Document-Annahmen (agy, 2026-07-04)
> + TODO-Eintrag „Mehrere Dateien gleichzeitig offen (Tabs)".

## Ziel

Mehrere Dokumente parallel geöffnet, Tab-Leiste wie im Browser.
Explorer-Doppelklick (`cli:open`) öffnet per Default einen **neuen
Tab** statt das Dokument zu ersetzen (Setting für altes Verhalten).
Pro Tab eigene History, eigener Dirty-Zustand, eigener Undo-Stack.

## Architektur-Entscheidungen (verbindlich)

1. **Tab = Backend-Objekt, Backend ist Source of Truth.**
   `TabManager` in `AppState`: `Vec<Tab>` + `active: usize`, wobei
   `Tab { id: u64 (monoton), document_store: DocumentStore,
   navigation: NavigationController, view_mode }`. `DocumentStore`
   kapselt bereits Datei + Watcher + Dirty + Encoding pro Dokument
   und wird **unverändert wiederverwendet** (kein Multi-Doc-Store-
   Umbau); ebenso `NavigationController` → **History ist per Tab**
   (Browser-Modell).
2. **Bestehende Events und Commands bleiben „aktiver Tab"-bezogen.**
   `document:loaded/saved/closed/dirty_changed` behalten Semantik
   „betrifft den aktiven Tab" — der Frontend-Grundfluss und die
   bestehenden Automation-Endpoints (`/open`, `/editor/*`, `/save`,
   `/state`) bleiben kompatibel. Neu kommt ein `tabs:changed`-Event
   (Liste + aktiver Index) für die Tab-Leiste.
3. **Tab-Wechsel = document:loaded des Ziel-Tabs.** Der Wechsel
   re-emittiert den geladenen Zustand des Ziel-Tabs (gleicher Pfad
   wie Open/History-Restore heute). Scroll-/Cursor-/Mode-Restore
   läuft über die bereits existierende `NavigationController::Entry`-
   Mechanik des Ziel-Tabs.
4. **Monaco: Model-Cache pro Tab im Frontend.** `editor/mount.ts`
   disposed Models beim Dokumentwechsel heute — künftig werden Models
   (+ `saveViewState`) in einer Map `tabId → model/viewState`
   gehalten: **Undo-Stack und Cursor bleiben pro Tab erhalten.**
   Disposal erst beim Tab-Schließen. Kein Cap in V1 (Anzahl Tabs ist
   praktisch klein); Memory-Punkt in „Risiken".
5. **Öffnen-Verhalten:** Vault-/Recent-/Pin-Klick ersetzt das Dokument
   im aktiven Tab (heutiges Verhalten). **Ctrl+Klick und Mittelklick**
   im Vault öffnen einen neuen Tab. `cli:open` öffnet neuen Tab
   (Default) bzw. ersetzt — Setting `openFileTarget: newtab|replace`
   (Default `newtab`). Ist die Datei bereits in einem Tab offen, wird
   **immer dessen Tab aktiviert** statt doppelt zu öffnen.
6. **Dirty beim Schließen eines Tabs:** gleicher Discard-Dialog-Fluss
   wie heute beim Close/Open-über-dirty (DirtyPolicy). „App beenden"
   prüft alle Tabs.
7. **Find-Bar/Preview/Scroll-Sync bleiben global** und werden beim
   Tab-Wechsel zurückgesetzt/neu aufgebaut — exakt wie heute beim
   Dokumentwechsel (kein Per-Tab-Find-State in V1).
8. **Persistenz in `workspace.json`**: `open_tabs: Vec<String>` +
   `active_tab: Option<usize>`. Boot-Restore **lazy**: nur der aktive
   Tab lädt seine Datei, inaktive Tabs laden beim ersten Aktivieren
   (Boot-Performance, keine n Watcher beim Start). Nicht mehr
   existierende Pfade werden beim Restore still verworfen.

## Etappen & Checkliste

### Etappe T1 — Backend-Fundament (verhaltensneutral) ✅ FERTIG

Reines Refactoring: TabManager mit genau einem Tab, keinerlei
UI-/Verhaltensänderung. Abnahme: komplette E2E-Suite unverändert grün.

- [x] `tab_manager.rs`: `Tab`/`TabManager` (new/active/active_mut,
      Tab-IDs monoton), Unit-Tests.
- [x] `AppState`: `document_store`/`navigation` durch
      `tabs: Mutex<TabManager>` ersetzt; alle Zugriffe in
      commands/, document_service, automation/handlers auf
      „aktiver Tab" umgestellt. (Zusatz: `view_mode` von
      `AutomationUiState` in den Tab verschoben — dokumentbezogen.)
- [x] `DocumentEvents`-Verkabelung (dirty_changed-Callback etc.) pro
      Tab statt einmalig global; Watcher-Callback trägt Tab-ID, Events
      aus inaktiven Tabs (external_changed) werden korrekt zugeordnet.
      Alle `document:*`-Events tragen jetzt `tabId`.
- [x] `cargo test`/`clippy`/`fmt` grün; keine Frontend-Änderung.
- [x] Volle E2E-Suite (28 Szenarien) unverändert grün.

### Etappe T2 — Tab-Operationen Backend + Automation-API ✅ FERTIG

Tabs funktional per API, noch ohne UI (API-first → testbar).

- [x] Commands: `tab_open` (Pfad → neuer Tab hinter aktivem, wird
      aktiv; existiert Pfad schon → aktivieren), `tab_close(id)`
      (DirtyPolicy; letzter Tab → leerer Zustand wie heute nach
      close_document), `tab_activate(id)`, `tabs_list`. Open-Fehler
      rollen den frisch angelegten Tab zurück.
- [x] Event `tabs:changed { tabs: [{id, path, dirty, active}], … }`
      bei jeder Mutation; `document:loaded` beim Aktivieren
      (gemeinsame Payload-Quelle `emit_document_loaded` — Format-
      parität mit dem Open-Pfad; async-Hop gegen rekursiven Lock aus
      Store-Callbacks).
- [x] Automation: `GET /tabs`, `POST /tabs/open|close|activate`,
      `POST /tabs/close_all` (E2E-Isolation); `/state` um
      `tabs`-Feld erweitert; Acks nach ack.rs-Muster.
- [x] `docs/automation-contract.md` um /tabs erweitert.
- [x] E2E `29_tabs_api.py`: open/list/activate/close, Dedupe bei
      doppeltem Pfad, Dirty-Reject beim Close, per-Tab-History
      (back/forward wirkt nur im aktiven Tab), close_all.

### Etappe T3 — Tab-Leiste UI + Editor-Model-Cache ✅ FERTIG

- [x] Tab-Leiste in `dist/index.html` (eigene Grid-Zeile zwischen
      Toolbar und Content — alle `grid-row`-Indizes rutschen um 1,
      `#tab-bar`, bei 0 Dokumenten ausgeblendet), CSS `tabs.css`,
      Dirty-Indikator, Close-Button, Mittelklick schließt, Overflow
      scrollbar.
- [x] Frontend `state/tabs.ts`: `tabs:changed`-Listener rendert die
      Leiste; Klick → `tab_activate`, Close → `tab_close` (Dirty-
      Confirm-Fluss); Boot-Initialisierung via `tabs_list`.
- [x] Monaco-Model-Cache pro Tab in `editor/mount.ts` (Model +
      ViewState, Undo-Stack bleibt; Disposal via `document:closed` +
      `tabs:changed`-Diff; pendingDocument nach Pre-Mount-Konvention).
      Review-Fix (Claude): Save-As-Kurzschluss nur bei unverändertem
      Inhalt — Ersetzen-Open im selben Tab (Vault-Klick, History)
      setzt den neuen Text.
- [x] Shortcuts über den DOM-Capture-Keybinding-Pfad: Ctrl+Tab /
      Ctrl+Shift+Tab, Ctrl+W; Menü „Datei" → „Tab schließen".
- [x] Fenstertitel/Statusbar folgen dem aktiven Tab über den
      bestehenden document:loaded-Pfad.
- [x] jsdom-Tests für Tab-Leiste + Model-Cache (18 Dateien/130 Tests).
- [x] E2E `30_tabs_ui.py` grün; Visual-Baselines wegen der neuen
      Tab-Leisten-Zeile neu geseedet (10 Stück) und im Folgelauf
      bestätigt.

### Etappe T4 — Persistenz + Session-Restore ✅ FERTIG

- [x] `WorkspaceData.open_tabs`/`active_tab` (Forward-Slash-
      Normalisierung, serde-Default-Migration), zentraler Sync in
      `emit_tabs_changed` — jede Tab-Mutation persistiert.
- [x] Boot-Restore lazy über `Tab.pending_path` (nur aktiver Tab lädt,
      kein Watcher für pending Tabs; tote Pfade beim Restore UND beim
      späteren Aktivieren verworfen + warn-Log, workspace.json wird
      sofort bereinigt).
- [x] `cli_pending_open` zum Frontend-ready-Hook umgebaut: CLI-Pfad
      wird als zusätzlicher/deduplizieren Tab geöffnet, sonst wird der
      restaurierte aktive Tab re-emittiert; Rückgabe `None` (Frontend
      öffnet nichts doppelt).
- [x] Rust-Tests (Roundtrip, Migration, tote Pfade, lazy Aktivierung).
- [x] E2E `31_tabs_restore.py` (workspace.json-Sync live geprüft);
      echter Neustart-Restore headless manuell bewiesen (2 Tabs →
      Restart → Tabs + aktiver Tab + Lazy-Load beim Aktivieren ok).
- [x] Zustands-Leak-Regel: Tab-Szenarien schließen im finally via
      `/tabs/close_all`.
- [x] **Regressions-Fix aus der T4-Abnahme** (Claude): Boot ohne
      Dokument emittierte jetzt `navigation:changed` → Editor-Restore
      auf ungemountetem Editor → Endlos-Microtask-Schleife über die
      `whenReady()`-Retry-Defers (JS-Thread tot, 28 E2E-Fails).
      Strukturell behoben: `mountReady` ist bis zum ersten Mount
      pending, alle 7 Retry-Defers in `editor/text.ts` laufen über
      single-shot `deferUntilMounted` (+ Regressionstest), Backend
      emittiert bei leerem Tab kein `navigation:changed` mehr.

### Etappe T5 — Öffnen-Integration + Feinschliff ✅ FERTIG

- [x] Setting `openFileTarget` (`newtab` Default | `replace`) im
      Settings-Tab „Allgemein" (Sektion „Tabs"); die Weiche sitzt im
      Backend (single-instance-Callback in `lib.rs`): `newtab` öffnet
      direkt via `tabs::open`, `replace`/Fehler fallen auf den
      bestehenden `cli:open`-Frontend-Pfad zurück. Headless mit echter
      zweiter Instanz verifiziert (newtab + replace).
- [x] Vault: Ctrl/Cmd+Klick und Mittelklick (`auxclick`) → neuer Tab;
      normaler Klick/Recent/Pin unverändert aktiver Tab. Pin-Reorder
      unberührt (eigener Pointer-Pfad).
- [x] Kontextmenü Vault-Datei: „In neuem Tab öffnen"
      (`data-act="open-newtab"`).
- [x] Dirty-Handling „App beenden": Backend-Gate prüft
      `TabManager::any_dirty()` (Strg+Q, Menü UND Fenster-X/
      CloseRequested); Frontend fragt jeden dirty Tab einzeln ab
      (`confirmAllDirtyTabs`, aktiviert den Tab sichtbar), Cancel
      stoppt die Kette.
- [x] Bonus (Smoke-Befund): `tab_open` recycelt einen leeren aktiven
      Tab statt einen unerreichbaren Zombie-Tab zu hinterlassen
      (Boot-CLI-Pfad).
- [x] Doku: CLAUDE.md-Abschnitt „Multi-Datei-Tabs" + aktualisierte
      Pre-Mount-Konvention, automation-contract (`openFileTarget`),
      TODO auf Folgepunkte-Eintrag geschrumpft.
- [x] Voller E2E-Lauf 32/32 grün inkl. neuem `32_open_target`;
      Alt-Szenarien blieben dank aktiver-Tab-Semantik unverändert.

**Status: Alle Etappen T1–T5 abgeschlossen (2026-07-04).**

## Risiken / bewusste Entscheidungen

- **Monaco-Model-Memory**: ein Model pro offenem Tab bleibt im
  Speicher. Bei realistischen Tab-Zahlen (<20) unkritisch; kein
  LRU-Cap in V1.
- **Watcher-Anzahl**: ein notify-Watcher pro offenem Tab (statt 1).
  Lazy-Restore hält die Zahl beim Boot klein.
- **`document:loaded`-Payload beim Tab-Wechsel**: voller Re-Render
  wie beim Open — akzeptiert in V1 (identisch zum heutigen
  History-Restore); Optimierung (HTML-Cache pro Tab) nur bei
  spürbarer Latenz.
- **Kein Tab-Drag-Reorder in V1** (Pointer-Drag-Muster aus
  `vault/tree.ts` existiert als Vorlage — bewusst verschoben).
- **Image-/Binary-Tabs**: erben das heutige Verhalten (View-only);
  keine Sonderbehandlung.

## Verifikation pro Etappe

Aus `src-tauri/`: `cargo test`, `cargo clippy --all-targets --
-D warnings`, `cargo fmt --check`; bei TS-Änderungen `cd web && npm
run build && npm test` + Bundles einchecken; `bash scripts/run-e2e.sh`
komplett. Pro grüner Etappe: Commit auf `main` + Checkboxen hier
abhaken.
