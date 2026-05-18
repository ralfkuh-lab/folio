# Folio E2E Test Suite

Autonomer End-to-End-Test der Folio-App. Treibt die laufende App über
die Automation-API (`http://127.0.0.1:9876`), vergleicht Screenshots
gegen committed Baselines und protokolliert Ergebnisse in Markdown.

## Voraussetzungen

- **Linux + Xvfb** — die Suite ist headless-only (Begründung in
  `CLAUDE.md` Abschnitt "Headless-Screenshots"). Auf Windows läuft
  nur eine eingeschränkte Variante gegen ein bereits gestartetes
  Folio (sichtbar, kein Lifecycle-Management) — gedacht für lokales
  Debuggen einzelner Szenarien, nicht für komplette Läufe.
- **Python 3.10+** (Standard-Lib + Pillow).
  ```sh
  pip install Pillow
  ```
- **Folio-Release-Build** bereitgestellt unter
  `src-tauri/target/release/folio` (Linux) oder
  `src-tauri/target/release/folio.exe` (Windows). Wird vom Wrapper
  über `cargo tauri build` bzw. `cargo build --release` erzeugt,
  falls noch nicht vorhanden.

## Aufruf (Agent-Standardpfad)

Auf einem Linux-Headless-System genügt **eine** Anweisung:

```sh
bash scripts/run-e2e.sh
```

Das Skript

1. startet einen Xvfb-Server auf `:99`,
2. baut Folio im Release-Mode (falls Binary fehlt),
3. startet Folio mit `DISPLAY=:99`,
4. wartet auf `/state` (max. 30 s),
5. läuft alle Szenarien sequentiell ab (siehe `scenarios/`),
6. schreibt Report + ggf. Error-Log in `artifacts/<timestamp>/`,
7. ergänzt bei Fehlern automatisch einen TODO-Eintrag in
   `TODO.md` mit Verweis auf den Run-Log,
8. stoppt Folio + Xvfb sauber.

Exit-Code `0` = alle Szenarien grün, `1` = mindestens ein Fehler.

## Artefakte

Pro Run unter `artifacts/<YYYYMMDD-HHMMSS>/`:

- `report.md` — Markdown-Report mit Schritt-für-Schritt-Ergebnissen.
- `errors.md` — Nur bei Fehlern, mit Stack/Diff-Refs.
- `console.log` — Folio-Stdout/Stderr während des Runs.
- `screenshots/<scenario>_<step>.png` — Aufgenommene Bilder.
- `diffs/<scenario>_<step>.png` — Pixel-Diff gegen Baseline (bei
  Mismatch).

Baselines sind in `baselines/` eingecheckt. Neue Aufnahme via:

```sh
bash scripts/run-e2e.sh --update-baselines
```

## Architektur

```
tests/e2e/
├── run.py                 # Orchestrator (Python)
├── lib/
│   ├── app.py             # Folio-Lifecycle (start/stop, Health-Polling)
│   ├── api.py             # Automation-API-Client
│   ├── visual.py          # Screenshot + Pillow-Diff
│   ├── report.py          # Markdown-Report-Writer
│   └── todo.py            # TODO.md-Auto-Update bei Errors
├── scenarios/             # Einzeln, durchnummeriert; jedes Modul
│   ├── 01_boot.py            stellt `def run(ctx)` bereit.
│   ├── 02_view_mode.py
│   ├── 03_edit_mode.py
│   ├── 04_theme.py
│   ├── 05_vault.py
│   ├── 06_find.py
│   └── 07_workspace.py
├── fixtures/              # Test-Dokumente (eingecheckt, deterministisch)
└── baselines/             # Golden-Screenshots
```

## Szenario-Vertrag

Jedes `scenarios/NN_name.py` exportiert eine Funktion `run(ctx)`:

```python
def run(ctx):
    ctx.step("open sample.md", lambda: ctx.api.open(ctx.fixture("sample.md")))
    ctx.expect_event("document.loaded")
    state = ctx.api.state()
    ctx.expect(state["viewMode"] == "view", f"viewMode={state['viewMode']!r}")
    ctx.screenshot("default")
```

`ctx` (siehe `lib/report.py::ScenarioContext`) bündelt API-Client,
Screenshot-Helper, Assertion + automatisches Fehler-Catching.
Eine geworfene Assertion bricht das **Szenario** ab (nicht den Run);
nachfolgende Szenarien laufen weiter.

## TODO-Auto-Eintrag

Wenn `errors.md` nicht leer ist, ergänzt `lib/todo.py` einen neuen
Eintrag in `TODO.md` unter "Hohe Priorität":

```markdown
- **E2E-Run 2026-05-18 14:23: 3 Fehler** — Details in
  [`tests/e2e/artifacts/20260518-142312/errors.md`](tests/e2e/artifacts/20260518-142312/errors.md).
  Run-Report:
  [`report.md`](tests/e2e/artifacts/20260518-142312/report.md).
```

Falls schon ein Eintrag für denselben Run-Timestamp existiert, wird
er nicht dupliziert.

## Limitationen

- **Nicht auf Windows headless**: xcap (über `tauri-plugin-screenshots`)
  filtert Fenster des eigenen Prozesses; Folio kann sich auf Windows
  nicht selbst capturen. Lokale Visual-Tests von Windows aus gehen nur
  mit sichtbarem Fenster.
- **Visual Diff ist pixel-basiert**: Subpixel-Rendering und Antialiasing
  können False-Positives erzeugen. Threshold ist großzügig gewählt
  (default 1 % der Pixel dürfen abweichen), pro Szenario tunbar.
- **Sequentielle Ausführung**: kein Parallelismus, weil Folio-State
  geteilt ist.
