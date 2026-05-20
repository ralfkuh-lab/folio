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

22 Szenarien, sequentiell:

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
voll-headless-Lauf möglich — siehe CLAUDE.md "Headless-Screenshots").

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

- **Nicht auf Windows headless** — siehe CLAUDE.md. Auf Windows nur
  Attach-Mode mit sichtbarem Fenster sinnvoll.
- **Visual-Diffs sind plattformabhängig** — die committed Baselines
  sind primär für Linux+Xvfb gedacht. Windows-Attach-Runs sind Debug-
  Werkzeug, kein vollständiger Release-Gate.
- **Sequentiell, nicht parallel** — Folio-State ist geteilt.
