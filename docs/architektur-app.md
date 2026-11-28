# Architektur: App-Kern

Querschnittsthemen rund um Dokumente, IPC, Persistenz, Sicherheit und Logging. Ausgelagert aus der früheren `CLAUDE.md`; [`AGENTS.md`](../AGENTS.md) enthält nur noch den Index.

- **CRLF/LF/BOM + Encoding**: Roundtrip ist getestet (`document_store.rs`).
  Beim Schreiben Original-Encoding/Line-Endings beibehalten. `read_and_decode`
  erkennt in dieser Reihenfolge: BOM (`EF BB BF` → UTF-8-BOM, `FF FE` →
  UTF-16 LE, `FE FF` → UTF-16 BE) → striktes UTF-8 → **Windows-1252-Fallback**
  (deterministisch, kann nie fehlschlagen; keine Rate-Heuristik). BOM-loses
  UTF-16 wird bewusst NICHT erkannt und landet im 1252-Fallback. Das Encoding
  wird als `TextEncoding`-Enum im `DocumentStore` gehalten (`encoding_rs` für
  1252 + UTF-16-Decode; UTF-16-**Encode** über std `str::encode_utf16`, weil
  encoding_rs keinen UTF-16-Encoder hat) und beim Save zurückkodiert. Bei
  Windows-1252 nicht darstellbare Zeichen (z. B. Emoji) sind ein **Fehler**
  (`SaveError::Unmappable`, i18n-Key `errors.file.encodingUnmappable`) — die
  Datei wird NICHT geschrieben, statt Zeichen still durch HTML-Entities zu
  ersetzen. `document:loaded`/`read_file` liefern additiv ein `encoding`-Label
  (`utf8`|`utf8-bom`|`utf16le`|`utf16be`|`windows1252`); die Statusleiste
  (`#status-encoding`) zeigt es nur, wenn es NICHT reines UTF-8 ohne BOM ist
  (sonst würden alle E2E-Baselines wandern).
- **IPC-Payloads**: gerendertes HTML geht über Tauri-Events, nicht über Command-Returns.
  *Bewusste Ausnahme*: `render_markdown_preview` (Live-Preview im
  View-/Split-Mode) liefert HTML+TOC als Command-Return. Frontend
  treibt den Roundtrip aktiv (Debounce + Generation-Token-
  Invalidierung in `view/preview.ts`); das passt nicht ins
  Push-Event-Modell der kanonischen `document:loaded`/`saved`-Pfade.
- **Document-Lifecycle-Events**: gemeinsamer monotoner seq-Counter
  (`next_doc_seq` in state.rs) fuer `document:loaded|closed|saved|dirty_changed`.
  Frontend (`state/document.ts`) verwirft via `isStaleLifecycleEvent` alle
  Events mit seq <= lastApplied (inkl. cross-Tab-Races); zusaetzlich
  tabId-Validierung fuer saved/dirty_changed gegen `getActiveTabId()`.
  loaded/closed werden nur per seq geschuetzt. Alt-Payloads ohne seq
  laufen durch.
- **assetProtocol-Scope `allow: ["**"]`** (tauri.conf.json): bewusste
  Entscheidung — der Image-View rendert Bilder von beliebigen Pfaden via
  `convertFileSrc`, ein engerer Scope würde jeden Ordner außerhalb einer
  Whitelist brechen. Konsequenz: die WebView kann jede lokale Datei
  **lesen**; in Kombination mit der HTML-View
  (`sandbox="allow-same-origin allow-scripts"`) ist der HTML-Sanitizer
  die einzige Barriere zwischen einer fremden `.html`-Datei und lokalen
  Dateien. Bei Änderungen an HTML-View/Sanitizer mitdenken.
  **`requireLiteralLeadingDot: false` ist Pflicht** (seit 2026-09-07):
  Tauri setzt bei der Listen-Form `["**"]` auf Unix
  `require_literal_leading_dot = true`, damit matcht `**` keine
  Pfadkomponente mit führendem Punkt — jedes Bild unter `.preview/`,
  `.github/` oder in einem Dotfile-Vault kam als `403` zurück und der
  Image-View zeigte „Bild konnte nicht geladen werden" (User-Report,
  Windows war nie betroffen). Die Dotfile-Regel war also nie ein
  Schutz, sondern eine plattformabhängige Lücke; stattdessen steht
  Folios Schlüsseldatei `$CONFIG/folio/auth.json` explizit in `deny`
  (gleicher Pfad wie `persist::config_file`, auf allen drei OS).
- **Dateityp-Klassifizierung**: zentral in `file_kind.rs`
  (`FileKind::{Markdown, Text, Image, Binary}`, `classify(path)`).
  `read_file` und `document:loaded` liefern `kind` ans Frontend; das
  setzt `body.kind-<value>` als Single Source of Truth. UI, die nur
  für Markdown gilt (Edit-Toolbar-Markdown-Gruppen, TOC-Rail,
  Rail-Right-Toggle), wird ausschließlich über CSS auf `.kind-markdown`
  beschränkt — keine eigene Endungs-Heuristik im Frontend.
  Einzeln zu öffnende Dokumente laufen über `document_service::load_by_kind`
  mit genau einem `classify_deep`: das Ergebnis landet im
  `DocumentDescriptor` (kind/file_size/revision/`too_large`) am Store und
  wird von `document:loaded`/`saved`, Default-Mode, History-Mode und Tab-
  Aktivierung gelesen, nicht neu gesnifft. `fileSize` ist immer
  adressierbar; wächst die Datei darüber, bleibt der letzte gültige Wert
  stehen und `tooLarge` wird wahr — die Hex-Ansicht darf dann keine
  Fenster jenseits dieser Größe anfordern. Image **und Binary** gehen
  opaque (`load_opaque_as`); Binary rendert in der Hex-Surface
  (`view/hex.ts`, nur View-Mode). **Ein `stale:` aus `read_file_chunk` ist
  kein Grund, still auszusteigen**: die Frontend-Revision kann dem Backend
  regulär hinterherhinken (`note_external_change` bumpt auch für inaktive
  Tabs; das `document:external_changed` verwerfen Aktiv-Check in `state.rs`
  sowie Pfad- und Tab-Guard in `state/document.ts`). Der Stale-Zweig zieht
  die Revision deshalb über `hex_document_state` nach und setzt den Fetch
  fort — gedeckelt und mit sichtbarem Fehler als Fallback; der Suchkontext
  muss dabei mitgehen (`notifyHexContextChanged`), sonst läuft der Finder
  mit der alten Revision weiter. Bis 0.7.0 verriegelte der Zweig sich still
  (`fetchPaused` blieb stehen) und machte aus jedem Revisions-Versatz einen
  dauerhaft auf `loading` stehenden Tab — Details in
  [`docs/spec-hex-view.md`](spec-hex-view.md). Der Typ bleibt für die Tab-Lebensdauer
  stehen (Rename ändert ihn nicht). Vault-Baum,
  Filter, Wikilinks, Tags und der Such-Walk bleiben endungsbasiert
  und IO-frei. Bleibt `classify` bei `Binary`, entscheidet ein
  Inhalts-Sniff (bekannte BOM am Dateianfang → Text; sonst NUL
  irgendwo in der Datei innerhalb 32 MiB → Binary; darüber bleibt
  Binary). Dateien über `MAX_SAFE_INTEGER − 4 MiB` werden mit
  `errors.file.tooLargeToAddress` abgelehnt.
  Eine nur per Sniff erkannte Textdatei lässt sich öffnen, bearbeiten
  und speichern, hat im Vault aber kein `data-text="1"` (also kein
  „Änderungen anzeigen" im Kontextmenü) und wird von
  `fileFilter: allText` nicht durchsucht.
- **UI-Toggle-Persistenz**: alle UI-Schalter mit Memo (Vault-Rail,
  TOC-Rail, Editor-Minimap, Cheatsheet-Position, Window-Geometrie,
  Pinned/Recent-Section-Expansion) sitzen in
  `panel_state.rs::PanelStateData` und werden in `panel-state.json`
  unter dem App-Config-Verzeichnis persistiert. Neue Toggles dort
  ergänzen, nicht eigene JSON-Files erfinden.
- **Fenster-Geometrie-Restore mit Off-Screen-Clamp**
  (`window_geometry.rs` + Boot-Pfad in `lib.rs`): die persistierte
  Position wird beim Boot nur angewendet, wenn ein greifbarer
  Titelleisten-Streifen (≥100×50 logische px) auf einer Monitor-
  **Work-Area** liegt; sonst Zentrierung auf dem primären Monitor bzw.
  (ohne Primary) OS-Default. Die Entscheidung fällt bewusst in
  **physischen** Pixeln — pro Monitor durch dessen Scale geteilte
  „logische" Rechtecke ergäben bei Mixed-DPI keine gemeinsame Fläche,
  und `set_position(LogicalPosition)` rechnet mit dem Scale des
  *Fensters*; Recenter wird deshalb als `PhysicalPosition` gesetzt.
  Save-Seite: `Moved`-Handler ignoriert minimierte Fenster,
  `set_window_position_in_memory` verwirft die Windows-Parkposition
  (≤ -30000, nur `cfg(windows)`) — sonst startete Folio nach
  Minimieren+Beenden bzw. Monitor-Abstecken unsichtbar
  (User-Report 2026-07-19).
- **Logging** (`logging.rs`): `tracing` + `tracing-subscriber` mit
  Stderr- und täglich rotierendem File-Sink. Logverzeichnis pro OS via
  `persist::log_dir()` (Windows: `%LOCALAPPDATA%\Folio\logs`, macOS:
  `~/Library/Logs/Folio`, Linux: `$XDG_STATE_HOME/folio/logs`). Init
  läuft in `lib.rs::run` **vor** dem Tauri-Builder, damit Setup-Fehler
  ebenfalls landen. Level-Hierarchie beim Boot: `RUST_LOG` >
  `cfg(debug_assertions)` (→ `debug`) > Setting `logLevel`
  (Default `info`). **Wenn `RUST_LOG` beim Boot gesetzt war, ist der
  Live-Reload aus dem Settings-UI gesperrt** (`set_level` wird
  No-op + warn-Log) — sonst könnte ein versehentlicher UI-Wechsel den
  Diagnose-Override aufheben. Live-Reload sonst via
  `tracing_subscriber::reload::Handle`; `settings_update`-Side-Effect
  ruft `logging::set_level`, ohne App-Restart.
  Robustheit: `set_global_default`-Fehler werden in `init` mit
  `eprintln!` sichtbar gemacht und `RELOAD_HANDLE`/`FILE_GUARD`
  bleiben in dem Fall leer (kein dangling Handle). Ein ungültiger
  `RUST_LOG`-Ausdruck wird vor dem Subscriber-Setup mit `eprintln!`
  geflaggt und auf `info` zurückgefallen.
  **Keine** `eprintln!`/`println!` in Production-Code mit Ausnahme
  von `logging.rs::init` (vor der Subscriber-Installation) — Tests
  dürfen. Sonst `tracing::{error,warn,info,debug}!` mit explizitem
  `target: "folio::*"`-Namespace (z. B. `folio::ipc`, `folio::vault`,
  `folio::automation`, `folio::menu`, `folio::settings`). Externe
  Crates (axum/tokio/notify) werden im `env_filter()` der
  `LogLevel`-Stufen bei `warn` gehalten, um Request-Spam zu vermeiden.
  Rotation: tägliche Dateinamen `YYYY-MM-DD.log` (kein Prefix —
  Folio-Kontext steckt im Verzeichnis, dafuer chronologisch
  sortierbar und von Folio selbst als `Text` klassifiziert/oeffenbar).
  Retention 7 Tage, Best-Effort-Prune beim Boot.
- **Frontend-Logging** (`util/log.ts` + `commands/app/log_bridge.rs`):
  `folioLog.{error,warn,info,debug,trace}(source, message, fields?)`
  ruft den Tauri-Command `frontend_log`, der mit `tracing::*!` ins
  selbe Logfile schreibt (Target `folio::frontend`, fixer Wert —
  `tracing` verlangt `'static str`, deshalb steckt der konkrete
  Sub-Bereich im `source`-Feld statt im Target-Pfad). Frontend
  **filtert vor**: `log.ts` cached den `logLevel` aus den Settings
  (`settings:changed`-Listener + `applyLogLevelFromSettings` aus dem
  Boot-`settings_get`) und verwirft Events unterhalb dieses Levels,
  bevor sie zum IPC-Roundtrip werden. Caveat: weil der Cache nur das
  **Setting** kennt, sind Frontend-Traces unter `RUST_LOG=folio=trace`
  trotzdem stumm — Devs müssen in DevTools
  `window.__folioSetLogLevel('trace')` ausführen, um sie sichtbar zu
  machen. Das Settings-UI bietet `trace` bewusst nicht an.
  Statt stillem `invoke(...).catch(()=>{})` benutzen Aufrufer
  `safeInvoke(cmd, args, op, level?)` aus `util/log.ts` — der
  Wrapper schluckt Fehler nicht, sondern loggt sie standardisiert
  unter `source=ipc`. Level-Konvention: `warn` für User-sichtbare
  Operationen (set_view_mode, save, open), `debug` für hochfrequente
  State-Sync-Calls (menu_set_*, set_window_title, …) **und für
  per-Operation-Diagnose mit überschaubarer Frequenz** (z. B. ein
  Eintrag pro Code-Block in `code-highlight.ts` — selten >50 pro
  Dokument), `trace` ist für DevTools-Sessions reserviert
  (Release-Build hat DevTools standardmäßig aus, daher ohne
  Custom-Build nicht erreichbar). In Tests (jsdom) ist die Bridge
  ein No-op, weil `__TAURI__` nicht installiert ist; Aufrufer
  bleiben framework-frei.
