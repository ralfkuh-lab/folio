#!/usr/bin/env python3
"""E2E-Orchestrator.

Startet (optional) eine Folio-Instanz, importiert alle
`scenarios/*.py`-Module, fuehrt sie sequentiell aus und schreibt
Report + Error-Log nach `tests/e2e/artifacts/<timestamp>/`.

Aufruf-Varianten:

- Default (Linux Headless + Wrapper-Skript handhabt Xvfb):
    python tests/e2e/run.py

- Gegen eine bereits laufende Folio-Instanz (Windows-Debugging):
    python tests/e2e/run.py --attach

- Baselines updaten:
    python tests/e2e/run.py --update-baselines

Exit-Code: 0 = alle Szenarien gruen, 1 = mind. ein Fehler.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
import time
from pathlib import Path
from typing import Callable


# Skript ist in tests/e2e/, der Repo-Root ist zwei Ebenen drueber.
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.api import AutomationApi  # noqa: E402
from lib.app import AppController, discover_folio_binary, ensure_xvfb_or_no_op  # noqa: E402
from lib.report import ReportWriter, ScenarioContext  # noqa: E402
from lib.todo import append_e2e_failure_entry  # noqa: E402
from lib.visual import VisualSuite  # noqa: E402


def discover_scenarios(
    scenarios_dir: Path,
    include_desktop_only: bool = False,
) -> list[tuple[str, Callable]]:
    """Importiert alle nummerierten `NN_name.py`-Module und gibt
    (Name, run)-Paare in lexikografischer Reihenfolge zurueck.

    Szenarien, die eine Modul-Konstante `DESKTOP_ONLY = True` exportieren,
    werden standardmaessig uebersprungen (Xvfb-untauglich — z. B. OS-
    Dialoge oder Multi-Monitor-Capture). `include_desktop_only=True`
    nimmt sie mit. Siehe `docs/e2e-headless-caveats.md`.
    """
    found: list[tuple[str, Callable]] = []
    for path in sorted(scenarios_dir.glob("[0-9][0-9]_*.py")):
        spec = importlib.util.spec_from_file_location(path.stem, path)
        if spec is None or spec.loader is None:
            continue
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        run_fn = getattr(module, "run", None)
        if not callable(run_fn):
            print(f"[WARN] scenarios/{path.name}: missing run() function — skipped")
            continue
        if getattr(module, "DESKTOP_ONLY", False) and not include_desktop_only:
            print(f"[SKIP] scenarios/{path.name}: DESKTOP_ONLY (use --include-desktop-only)")
            continue
        found.append((path.stem, run_fn))
    return found


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Folio E2E-Suite")
    parser.add_argument(
        "--attach", action="store_true",
        help="Nicht selbst starten — gegen bereits laufende Folio-Instanz testen.",
    )
    parser.add_argument(
        "--update-baselines", action="store_true",
        help="Aufnahmen als neue Baselines schreiben statt zu vergleichen.",
    )
    parser.add_argument(
        "--base-url", default="http://127.0.0.1:9876",
        help="Automation-API-Endpoint (default %(default)s).",
    )
    parser.add_argument(
        "--scenarios-dir", default=str(SCRIPT_DIR / "scenarios"),
        help="Verzeichnis mit den Szenario-Modulen.",
    )
    parser.add_argument(
        "--no-auto-todo", action="store_true",
        help="Bei Fehlern KEINEN Eintrag in TODO.md ergaenzen.",
    )
    parser.add_argument(
        "--include-desktop-only", action="store_true",
        help="Szenarien mit `DESKTOP_ONLY = True` mitnehmen (sonst geskippt).",
    )
    args = parser.parse_args(argv)

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    artifacts_dir = SCRIPT_DIR / "artifacts" / timestamp
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    console_log = artifacts_dir / "console.log"
    binary = discover_folio_binary(REPO_ROOT)

    api = AutomationApi(args.base_url)
    app: AppController | None = None
    if not args.attach:
        ensure_xvfb_or_no_op()
        app = AppController(binary=binary, console_log=console_log)
        app.start()
        if not api.wait_for_alive(timeout=45.0):
            app.stop(api)
            print("[ERR] Folio Automation-API kam nicht hoch (Timeout 45 s).")
            print(f"[ERR] Konsole: {console_log}")
            return 1
    else:
        if not api.wait_for_alive(timeout=5.0):
            print(f"[ERR] --attach: keine Antwort von {args.base_url}/state")
            return 1
        # Sicherstellen, dass eine Konsole-Datei existiert (auch wenn leer),
        # damit Report sie referenzieren kann.
        console_log.write_text(
            "(attach mode — Folio-Konsole nicht aufgezeichnet)\n",
            encoding="utf-8",
        )

    fixtures_dir = SCRIPT_DIR / "fixtures"
    baselines_dir = SCRIPT_DIR / "baselines"

    visual = VisualSuite(
        baselines_dir=baselines_dir,
        artifacts_dir=artifacts_dir,
        update_baselines=args.update_baselines,
    )

    scenarios = discover_scenarios(
        Path(args.scenarios_dir),
        include_desktop_only=args.include_desktop_only,
    )
    print(f"[i] {len(scenarios)} Szenario(s) entdeckt: "
          f"{', '.join(n for n, _ in scenarios)}")

    run_start = time.monotonic()
    run_start_wall = time.time()
    results = []

    for name, run_fn in scenarios:
        print(f"[>] {name}")
        ctx = ScenarioContext(name, api, visual, fixtures_dir)
        try:
            run_fn(ctx)
        except Exception:
            # ScenarioAbort und alles andere wird im Step-Wrapper bereits
            # geloggt; hier nur den Run weiterführen.
            pass
        result = ctx.finish()
        results.append(result)
        status = "PASS" if result.passed else "FAIL"
        print(f"[{status}] {name} ({result.duration_s:.2f}s)")

    run_end_wall = time.time()

    # Vor dem Stop: console.errors einsammeln (best effort).
    try:
        errs = api.console_errors(clear=False)
        if errs.get("count", 0) > 0:
            (artifacts_dir / "console-errors.json").write_text(
                __import__("json").dumps(errs, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
    except Exception:
        pass

    if app is not None:
        app.stop(api)

    writer = ReportWriter(artifacts_dir)
    report_path, errors_path = writer.write(
        run_started=run_start_wall,
        run_finished=run_end_wall,
        results=results,
        visual_summary=visual.summary(),
        console_log_path=console_log,
        binary_path=binary,
    )

    print(f"[i] Report: {report_path}")
    if errors_path is not None:
        print(f"[i] Errors: {errors_path}")
        failed_count = sum(1 for r in results if not r.passed)
        if not args.no_auto_todo:
            entry = append_e2e_failure_entry(
                todo_path=REPO_ROOT / "TODO.md",
                run_id=timestamp,
                report_path=report_path,
                errors_path=errors_path,
                failed_count=failed_count,
                repo_root=REPO_ROOT,
            )
            if entry:
                print(f"[i] TODO.md ergaenzt um E2E-Fehler-Eintrag.")
            else:
                print(f"[i] TODO.md bleibt unveraendert (Eintrag fuer {timestamp} schon vorhanden).")

    failed = sum(1 for r in results if not r.passed)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
