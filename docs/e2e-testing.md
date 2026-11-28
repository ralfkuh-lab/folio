# E2E-Test-Suite

Autonomer End-to-End-Test der Folio-App: startet die App headless,
treibt sie über die Automation-API (`127.0.0.1:9876`), vergleicht
Screenshots gegen committed Baselines und protokolliert alles in
Markdown unter `tests/e2e/artifacts/<timestamp>/`.

## Für Agenten: ein Befehl

Wenn ein Agent (z. B. Hermes) den Auftrag bekommt "Führe einen
kompletten Applikationstest durch", soll er auf einem Linux-Headless-
System genau dies ausführen:

```sh
bash scripts/run-e2e.sh
```

Das Skript ist selbst-trapping (Cleanup bei Ctrl-C / Fehlerausstieg),
braucht keine User-Interaktion und liefert:

- Exit-Code **0** = alle Szenarien grün.
- Exit-Code **1** = mindestens ein Szenario fehlgeschlagen ODER
  Setup-Fehler.
- Artefakte unter `tests/e2e/artifacts/<YYYYMMDD-HHMMSS>/`:
  - `report.md` — Vollständiger Run-Report.
  - `errors.md` — Nur bei Fehlern: kompakte Fehlerübersicht.
  - `console.log` — Stdout/Stderr von Folio.
  - `screenshots/<name>.png` — Aufnahmen.
  - `diffs/<name>.png` — Pixel-Diff gegen Baseline (nur bei Mismatch).
- Bei Fehlern wird ein Eintrag in `TODO.md` unter "Hohe Priorität"
  angehängt, mit Verweis auf `report.md` und `errors.md`.

## Vorbereitung auf einem frischen Linux-Headless-System

```sh
# System-Pakete
sudo apt update
sudo apt install -y xvfb python3 python3-pip curl

# Rust (für initialen Build, falls noch nicht vorhanden)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# Tauri-Build-Deps für WebKitGTK
sudo apt install -y \
    libwebkit2gtk-4.1-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libgtk-3-dev \
    pkg-config

# Python-Deps der Suite
pip install -r tests/e2e/requirements.txt
```

Der erste Lauf braucht ca. 5–10 min für den initialen Cargo-Build,
nachfolgende Läufe nur Sekunden.

## Was die Suite abdeckt

23 Szenarien, sequentiell:

1. **`01_boot`** — App-Sanity, Console-Errors, Boot-Screenshot.
2. **`02_view_mode`** — Markdown-View, TOC, Anchor-Sprung.
3. **`03_edit_mode`** — Editor-Boot, Text-Roundtrip, Selection.
4. **`04_theme`** — Hell/Dunkel-Umschaltung mit Visual-Baselines.
5. **`05_vault`** — Rail-Toggle und Workspace-Layout.
6. **`06_find`** — Find-Bar öffnen, Term setzen, schließen.
7. **`07_workspace`** — Recent-Dateien nach `/open`.
8. **`08_save_roundtrip`** — Save-Roundtrip mit BOM/EOL-Erhalt.
9. **`09_undo_redo`** — Monaco-Undo/Redo und `applyReplace`.
10. **`10_editor_commands`** — Toolbar-Commands wie Bold/Italic.
11. **`11_menu_file`** — Datei-Menü-Pfade Save, Close, Recent.
12. **`12_menu_edit`** — Edit-Menü Undo, Redo, Find.
13. **`13_menu_view`** — View-Menü Mode, Theme, Rails.
14. **`14_menu_help`** — Cheatsheet und About-Dialog.
15. **`15_keybindings`** — DOM-Keybindings wie Ctrl+S/Ctrl+F.
16. **`16_vault_tree`** — gepinnte Datei im Vault-Tree öffnen.
17. **`17_workspace_pin`** — Pin/Unpin-API und Idempotenz.
18. **`18_history`** — Back/Forward inklusive Stack-Kanten.
19. **`19_context_menus`** — Vault-Kontextmenü und Unpin.
20. **`20_toc_click`** — echter DOM-Klick auf TOC-Eintrag.
21. **`21_split_mode`** — Split-Mode-Layout und Rückwechsel.
22. **`22_html_view`** — HTML-Datei im Sandbox-iframe.
23. **`23_api_settings_split`** — Settings-GET/POST und Split-State (rein funktional).

Jedes Szenario ist eine `tests/e2e/scenarios/NN_name.py`-Datei mit
`def run(ctx)`. Weitere Szenarien einfach analog anlegen — der
Orchestrator entdeckt sie automatisch.

## Architektur

```
tests/e2e/
├── run.py                     # Orchestrator (Python, stdlib + Pillow)
├── requirements.txt           # Pillow ≥ 10
├── lib/
│   ├── app.py                 # AppController: Folio-Lifecycle
│   ├── api.py                 # Automation-API-Client (urllib)
│   ├── visual.py              # Pillow-basierte Pixel-Diffs
│   ├── report.py              # ScenarioContext + Markdown-Report
│   └── todo.py                # TODO.md-Auto-Update bei Fehlern
├── scenarios/                 # NN_name.py mit `def run(ctx)`
├── fixtures/                  # Test-Dokumente (eingecheckt)
└── baselines/                 # Golden Screenshots (eingecheckt)
```

Der Wrapper `scripts/run-e2e.sh` orchestriert Xvfb + Folio +
Python-Suite. Auf Windows kann `tests/e2e/run.py --attach` gegen eine
bereits gestartete Folio-Instanz laufen (nur für Debugging, kein
voll-headless-Lauf möglich — siehe unten „Headless-Screenshots“).

## Baselines pflegen

Beim ersten Lauf einer neuen Szenario-Screenshot-Kombination wird
automatisch eine Baseline aufgenommen (kein FAIL). Folgeläufe
vergleichen pixelweise.

Wenn ein UI-Change die Baselines berechtigt invalidiert:

```sh
bash scripts/run-e2e.sh --update-baselines
```

Danach den Baseline-Diff im Git-Diff prüfen und committen.

Toleranz-Default: 1 % der Pixel dürfen sichtbar abweichen (Subpixel-
Rendering, Antialiasing). Pro Szenario via
`ctx.screenshot("name", threshold_ratio=0.05)` lockerbar.

## TODO-Auto-Update

Wenn `errors.md` geschrieben wird, hängt `lib/todo.py` einen Eintrag
in `TODO.md` an:

```markdown
- **E2E-Run 2026-05-18 14:23: 2 Fehler** — Details in
  [`tests/e2e/artifacts/20260518-142312/errors.md`](...). Run-Report:
  [`tests/e2e/artifacts/20260518-142312/report.md`](...).
```

Idempotent: Ein Run-Timestamp wird höchstens einmal eingetragen. Wenn
der Agent dieselben Tests neu laufen lässt, kommt ein neuer Eintrag
mit neuem Timestamp dazu — alte bleiben stehen, bis sie manuell
abgehakt werden.

Disable mit `bash scripts/run-e2e.sh --no-auto-todo`.

## Bekannte Einschränkungen

- **Nicht auf Windows headless** — siehe unten „Headless-Screenshots“. Auf Windows nur
  Attach-Mode mit sichtbarem Fenster sinnvoll.
- **Visual-Diffs sind plattformabhängig** — die committed Baselines
  sind primär für Linux+Xvfb gedacht. Windows-Attach-Runs sind Debug-
  Werkzeug, kein vollständiger Release-Gate.
- **Sequentiell, nicht parallel** — Folio-State ist geteilt.

## Ergänzungen (aus der früheren `CLAUDE.md`)

## Headless-Screenshots

- **Monaco in Xvfb via Monitor-Capture**: `tauri-plugin-screenshots`
  v2.2.0 ist eingebunden (`Cargo.toml`, `lib.rs`, `automation/handlers/
  screenshot.rs`). `GET /screenshot` macht damit einen Monitor- (nicht
  Window-)Capture; das ist der einzige in Xvfb funktionierende Weg,
  Monacos Canvas-Output sichtbar zu erfassen. Window-basierte
  Screenshot-Libs (xcap o. ä.) lesen nur das Window-Pixmap und sehen
  den Canvas dort nicht. Test-Belege + Methodik in
  [`docs/headless-monaco-test-results.md`](headless-monaco-test-results.md)
  (Option 3, Commit `b6a0996`); Hintergrund/Alternativen für andere
  Setups in [`docs/headless-monaco-screenshots.md`](headless-monaco-screenshots.md).

- **Hintergrund-Test-Strategie**: "Unsichtbares" Ausführen für
  Automation-Tests ist **nur unter Linux via Xvfb** vorgesehen — die
  App läuft auf `DISPLAY=:99`, der interaktive User auf `:0`, kein
  Fenster auf seinem Schirm, `/screenshot` liefert sichtbares Monaco
  über Monitor-Capture im Xvfb-Framebuffer. Ein `--headless`-Flag für
  Windows ist **nicht gebaut** (Stand 2026-05-18): `xcap` filtert in
  `is_valid_window` Fenster des **eigenen Prozesses** raus
  (Deadlock-Vermeidung bei `GetWindowText*`) und blockiert damit jeden
  Window-Capture-Pfad von Folio auf sich selbst — egal ob `visible:
  false`, `set_skip_taskbar`, off-screen. Echtes Hidden-Headless auf
  Windows bräuchte einen direkten Win32-`PrintWindow`-Bypass; der
  Aufwand ist gegenüber dem Linux+Xvfb-Pfad nicht gerechtfertigt.

## Suite-Details

Vollständige UI-Coverage in `tests/e2e/` (70 Szenarien, Python +
Pillow): Boot, View-/Edit-/Split-Mode, Theme, Vault, Find (inkl.
Code-View), Workspace, Save-Roundtrip durch alle BOM/EOL-Kombis,
Undo/Redo, Toolbar-Commands (Bold/Italic/Heading), Menü-Coverage
(File/Edit/View/Help), DOM-Keybindings, Vault-Tree-Klicks, Pin/Unpin,
History-Back/Forward, Rechtsklick-Kontextmenüs, echter TOC-DOM-Klick,
HTML-View, Tabs (API/UI/Restore/Reorder), View-/Custom-Themes,
Theme-CRUD/-Browser/-Import-Export, Export-Highlighting, Mermaid
(View + Export), Link-in-neuem-Tab, Vault-Volltextsuche (API + UI + Such-/Filterbereich),
Vault-Filter (R3 + Tiefenfilter/Ordnerbereich R4), Tab-Kontextmenü,
Command Palette, Statusleiste,
Wikilinks/Tags, Task-Checkboxen, Git-Status/-Diff/-Filter,
versteckte Vault-Einträge, Find-Bar-Regex/-Ersetzen,
Vault-Dateioperationen (Ordner anlegen/umbenennen/löschen),
Zen-Modus, Hex-Ansicht, Pfad-Identität (Symlink-Verzeichnis → ein Tab),
Breiten-Toggle, Callouts (inkl. Kontrast über alle Themes), Smart-List,
Tabellen (Formatieren; breite Tabellen, Overlay, Sortieren, Filtern),
Vault-Tastaturbedienung
sowie
KI-Settings, KI-Übersetzung, KI-Theme-Autor, Export-KI-Draft und
KI-Aktionen (Mock-Provider). Der englische Boot ist über
`scripts/run-e2e.sh --lang-smoke` separat abgedeckt.

**Szenarien mit eigener Git-Fixture** (`56_git_status.py`): Das Repo
wird im Szenario per `git init` an einem **festen** Temp-Pfad angelegt
(`/tmp/folio-e2e-gitrepo`) — nicht per `mkdtemp`, weil der Pfad im
Vault-Baum und in der Statusleiste sichtbar und damit Teil der
Visual-Baseline ist. Gepinnt wird bewusst nur ein **Unterordner** des
Repos, und ein geänderter Zweig liegt daneben außerhalb: nur so ist
prüfbar, dass der Filter-Auto-Expand keine Pfade außerhalb sichtbarer
Pin-Wurzeln öffnet. Git-Optionen, die das Ergebnis verfälschen könnten
(`core.excludesFile`, `core.autocrlf`), werden **repo-lokal** gesetzt —
Umgebungsvariablen der Test-Subprozesse greifen nicht für Folios eigene
`git`-Aufrufe, die im bereits gestarteten App-Prozess laufen.

**Szenarien mit fester Hidden-Fixture** (`57_vault_hidden.py`): Verzeichnis
unter `/tmp/folio-e2e-hidden` — gleicher Grund wie bei 56, der Pfad steht
im Vault und in der Baseline. Enthält eine normale `.md`, `.versteckt/`,
`.versteckte-datei.md` und ein leeres `.git/`.

**Szenario mit fester Fileops-Fixture** (`59_vault_fileops.py`):
`/tmp/folio-e2e-fileops` — gleicher Grund. Gepinnt wird `projekt/`, darin
ein `unterordner/` mit `notiz.md`; das Szenario öffnet einen Tab auf die
Notiz und prüft nach dem Ordner-Rename, dass der **Tab-Pfad präfixweise
mitgewandert** ist (der eigentliche V1-Vertrag) und beim Löschen wieder
verschwindet.

**Szenario mit fester Such-/Filter-Fixture** (`67_search_area.py`):
`/tmp/folio-e2e-searcharea` — gleicher Grund wie 56/57/59 (Pin-Name im
Baum = Baseline). Nimmt die sechs Zustände des Such-/Filterbereichs (S9)
hell und dunkel auf; vor den Treffer-Aufnahmen wird auf „Dateiname“
sortiert (Ankunftsreihenfolge ist nicht deterministisch) und die
Laufzeitangabe aus dem Status entfernt.

**Szenario mit Symlink-Fixture** (`62_path_identity.py`):
`/tmp/folio-e2e-symlink` mit `real/notiz.md` und dem Symlink-Verzeichnis
`link` → `real` — selbst angelegt statt sich auf plattformabhängige
Symlinks wie macOS' `/tmp`→`/private/tmp` zu verlassen. Geprüft wird, dass
beide Schreibweisen **einen** Tab ergeben (beide Reihenfolgen, plus der
Replace-Open-Pfad `/open`) und dass der Pfad dabei **nicht** aufgelöst
wird. Ohne Screenshot: das Szenario prüft nur Backend-State.

Wrapper: `bash scripts/run-e2e.sh` (Linux+Xvfb). Visual-Baselines in
`tests/e2e/baselines/`, Artefakte (gitignored) in
`tests/e2e/artifacts/<timestamp>/`. Bei fehlender Baseline wird sie beim
ersten Run automatisch angelegt. Der Wrapper bricht mit klarer Meldung
ab, wenn bereits eine Folio-Instanz des Users läuft (das
single-instance-Plugin würde die Test-Instanz sonst sofort still
beenden — Symptom: „Folio-Prozess ist gestorben", Log endet nach der
Logging-Init-Zeile).

**Kanonischer Reset pro Szenario**: `run.py` ruft vor jedem Szenario
`lib/reset.py::reset_canonical_state` auf — Tabs schließen, Settings
auf den Run-Start-Snapshot zurück, Theme light, Find-Bar zu, Mode view
(best effort), linke Rail sichtbar, Split 50 %, Recent-Liste leeren
(`POST /workspace/clear_recents`), danach `/sync/render`. Damit kodiert
jede Baseline nur noch den Zustand ihres eigenen Szenarios; der Reset
läuft in Voll- wie Auswahl-Läufen identisch.

**Läufe abseits von Linux 1280×800**: `--no-visual` nimmt Screenshots auf,
vergleicht sie aber nicht (`bash scripts/run-e2e.sh 61_hex_view --no-visual`,
bzw. auf macOS/Windows ohne Xvfb: Folio mit `FOLIO_AUTOMATION=1` starten und
`python3 tests/e2e/run.py --attach --attach-reset --no-visual <szenario>`).
Die Baselines sind **Monitor**-Captures und damit an Linux 1280×800 gebunden —
ohne den Schalter bricht ein Szenario am ersten Screenshot mit `size mismatch`
ab, und die funktionalen Schritte dahinter laufen nie (der Grund, warum der
Windows-Durchgang 2026-08-18 per Automation-API statt per Suite lief).
Übersprungene Aufnahmen zählen im Report als *übersprungen*, nie als PASS.
Bewusst **opt-in**: automatisch im Attach-Mode zu skippen würde auf der
Baseline-Maschine echte Visual-Regressionen verstecken.

**Einzelszenario-Läufe**: `bash scripts/run-e2e.sh 21_split_mode`
(Name oder Präfix, mehrere möglich) — vergleicht wie der Voll-Lauf
gegen die Baselines. Einzelne Baselines lassen sich direkt erneuern:
`bash scripts/run-e2e.sh 21_split_mode --update-baselines`.

**Screenshot-Sync**: `report.py::screenshot` ruft vor jeder Aufnahme
`POST /sync/render` (deterministischer rAF-Roundtrip-Ack, siehe
Automation-API oben) statt eines fixen Sleeps — das WebView-Reflow nach
Backend-State-Wechsel ist sonst nicht synchron. Bei Visual-Mismatch gibt
es **einen** Retry (erneut sync + Recapture): der rAF-Ack garantiert
nicht, dass WebKits Frame schon im Xvfb-Framebuffer angekommen ist
(Monitor-Capture liest den X-Server, nicht die Page) — ein veralteter
Frame verschwindet beim Recapture, eine echte Regression failt auch im
zweiten Versuch.

**Fixture-Isolation**: Schreibende Szenarien (03/08/10/11/15) modifizieren
Fixtures in place. `run.py` snapshottet `tests/e2e/fixtures/` beim Start
(als pristine angenommen) und stellt den Zustand **vor jedem Szenario +
am Ende** wieder her — am Original-Pfad, weil der in der Statusleiste
sichtbare Dateipfad Teil der Visual-Baseline ist. Ohne das leckte z. B.
die von 11/15 an `sample.md` angehängte Zeile in spätere Szenarien
(21_split). Konsequenz für neue Szenarien: Fixtures dürfen frei
beschrieben werden, aber **jedes Szenario muss seinen benötigten
View-Mode explizit setzen** (`api.mode(...)`) statt sich auf den
Vorzustand zu verlassen — `default_mode_{markdown,text}` ist `Current`
(behält den aktuellen Mode), sodass ein Mode aus dem Vorszenario sonst
leckt (war der 22_html_view-Folgefehler).

Xvfb-spezifische Eigenheiten (scrollY-Sync, Monaco-Canvas-Capture,
synthetic-keyboard-Fragilität bei Monaco-Shortcuts, native Tauri-Menüs
aus WebView unerreichbar, `alert()`-Blockade, `applyReplace`/
`history`-Historie der Bugfixes etc.) sind in
[`docs/e2e-headless-caveats.md`](e2e-headless-caveats.md)
zusammengefasst — Pflichtlektüre vor dem Schreiben neuer Szenarien.

Szenarien können `DESKTOP_ONLY = True` als Modul-Konstante exportieren;
der Orchestrator skipt sie standardmäßig, `--include-desktop-only`
schaltet sie ein. Heute hat kein Szenario den Marker — die Infrastruktur
ist Vorhaltung für zukünftige Dialog-/OS-Eingang-Tests.

## README-Screenshots

`bash scripts/make-readme-screenshots.sh` erzeugt die Bilder unter
`docs/images/` neu (einzelne Aufnahmen: `... hero search`; Namen siehe
Skriptkopf). Gleicher Aufbau wie der E2E-Wrapper — Xvfb, isoliertes
XDG-Home, Release-Binary —, aber auf Display `:98`, mit `FOLIO_LANG=en`
(die README ist englisch) und dem versionierten Demo-Vault aus
`scripts/readme-screenshots/demo-vault/`. Das Vault wird nach
`/tmp/folio-demo` kopiert und von dort gepinnt: der Pfad steht in
Statusleiste und Vault-Baum und darf nicht das Home-Verzeichnis des
Bauenden zeigen. Neue Aufnahme ergänzen = Funktion in
`scripts/readme-screenshots/shots.py` + Eintrag in `SHOTS`; Zustände, die
andere Aufnahmen sehen (Tag-Browser, Suchmodus, Recent-Liste), immer
idempotent setzen statt zu togglen.
