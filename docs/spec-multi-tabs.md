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

### Etappe T1 — Backend-Fundament (verhaltensneutral) ✅=fertig

Reines Refactoring: TabManager mit genau einem Tab, keinerlei
UI-/Verhaltensänderung. Abnahme: komplette E2E-Suite unverändert grün.

- [ ] `tab_manager.rs`: `Tab`/`TabManager` (new/active/active_mut,
      Tab-IDs monoton), Unit-Tests.
- [ ] `AppState`: `document_store`/`navigation` durch
      `tabs: Mutex<TabManager>` ersetzt; alle Zugriffe in
      commands/, document_service, automation/handlers auf
      „aktiver Tab" umgestellt.
- [ ] `DocumentEvents`-Verkabelung (dirty_changed-Callback etc.) pro
      Tab statt einmalig global; Watcher-Callback trägt Tab-ID, Events
      aus inaktiven Tabs (external_changed) werden korrekt zugeordnet.
- [ ] `cargo test`/`clippy`/`fmt` grün; keine Frontend-Änderung.
- [ ] Volle E2E-Suite (28 Szenarien) unverändert grün.

### Etappe T2 — Tab-Operationen Backend + Automation-API

Tabs funktional per API, noch ohne UI (API-first → testbar).

- [ ] Commands: `tab_open` (Pfad → neuer Tab hinter aktivem, wird
      aktiv; existiert Pfad schon → aktivieren), `tab_close(id)`
      (DirtyPolicy; letzter Tab → leerer Zustand wie heute nach
      close_document), `tab_activate(id)`, `tabs_list`.
- [ ] Event `tabs:changed { tabs: [{id, path, dirty, active}], … }`
      bei jeder Mutation; `document:loaded` beim Aktivieren.
- [ ] Automation: `GET /tabs`, `POST /tabs/open|close|activate`,
      `POST /tabs/close_all` (E2E-Isolation); `/state` um
      `tabs`-Feld erweitert; Acks nach ack.rs-Muster.
- [ ] `docs/automation-contract.md` um /tabs erweitert.
- [ ] E2E `29_tabs_api.py`: open/list/activate/close, Dedupe bei
      doppeltem Pfad, Dirty-Reject beim Close, per-Tab-History
      (back/forward wirkt nur im aktiven Tab), close_all.

### Etappe T3 — Tab-Leiste UI + Editor-Model-Cache

- [ ] Tab-Leiste in `dist/index.html` (zwischen Toolbar und Content,
      `#tab-bar`, bei 0 Tabs ausgeblendet), CSS im Bestand-Stil
      (Dark/Light via Variablen), Dirty-Indikator (Punkt),
      Close-Button pro Tab, Mittelklick schließt, Overflow scrollbar.
- [ ] Frontend `state/tabs.ts`: `tabs:changed`-Listener rendert die
      Leiste; Klick → `tab_activate`, Close → `tab_close`.
- [ ] Monaco-Model-Cache pro Tab in `editor/mount.ts`
      (Model + ViewState halten, Undo-Stack bleibt; Disposal beim
      Tab-Schließen via `tabs:changed`-Diff). Pre-Mount-Konvention
      aus CLAUDE.md beachten (kein mountReady-Defer!).
- [ ] Shortcuts über den bestehenden DOM-Capture-Keybinding-Pfad:
      Ctrl+Tab / Ctrl+Shift+Tab (nächster/voriger Tab),
      Ctrl+W (Tab schließen); Menü „Datei": „Tab schließen".
- [ ] Fenstertitel/Statusbar folgen dem aktiven Tab (bestehender
      document:loaded-Pfad — verifizieren, kein Doppel-Update).
- [ ] jsdom-Tests für Tab-Leisten-Rendering + Model-Cache-Logik.
- [ ] E2E `30_tabs_ui.py`: Leiste erscheint/verschwindet, Klick
      wechselt (Statusbar-Pfad), Dirty-Punkt, Close-Button,
      Undo-Stack überlebt Tab-Wechsel (Edit → Wechsel → zurück →
      Undo wirkt).

### Etappe T4 — Persistenz + Session-Restore

- [ ] `WorkspaceData.open_tabs`/`active_tab` (Forward-Slash-
      Normalisierung wie alle Pfade!), Update bei jeder Tab-Mutation.
- [ ] Boot-Restore lazy (nur aktiver Tab lädt; inaktive beim ersten
      Aktivieren; tote Pfade still verworfen, warn-Log).
- [ ] Zusammenspiel mit `cli_pending_open`: CLI-Pfad gewinnt (wird
      nach Restore als neuer/aktivierter Tab geöffnet).
- [ ] Rust-Tests (Roundtrip, tote Pfade, Normalisierung).
- [ ] E2E `31_tabs_restore.py`: Tabs öffnen → App-Neustart im
      Szenario ist in der Suite nicht vorgesehen → stattdessen
      workspace.json-Inhalt via API/Datei prüfen + Restore-Logik
      als Rust-Test; UI-Restore manuell verifizieren (run-Skill).
- [ ] E2E-Zustands-Leak-Regel ergänzen: Szenarien, die Tabs öffnen,
      schließen sie im finally (`/tabs/close_all`).

### Etappe T5 — Öffnen-Integration + Feinschliff

- [ ] Setting `openFileTarget` (`newtab` Default | `replace`) im
      Settings-Tab „Allgemein"; `cli:open`-Handler respektiert es.
- [ ] Vault: Ctrl+Klick/Mittelklick → neuer Tab (Pointer-Pfad in
      `vault/tree.ts` beachten — Pin-Reorder-Logik nicht brechen);
      Recent/Pin-Klick unverändert aktiver Tab.
- [ ] Kontextmenü Vault-Datei: „In neuem Tab öffnen".
- [ ] Dirty-Handling „App beenden": alle dirty Tabs prüfen
      (bestehenden Quit-Fluss ansehen und erweitern).
- [ ] Doku: CLAUDE.md-Abschnitt „Tabs" (Architektur, Events,
      Model-Cache-Konvention), TODO.md-Eintrag abbauen,
      automation-contract final.
- [ ] Voller E2E-Lauf inkl. Alt-Szenarien; betroffene Szenarien
      (02/03/07/08/09/11/16/18, siehe Kartierung) bei Bedarf
      angepasst — Ziel: minimale Änderungen, da aktiver-Tab-
      Semantik kompatibel bleibt.

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
