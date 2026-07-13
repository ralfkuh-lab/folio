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

- Nur einzelne Szenarien (Name oder Praefix) — fuer funktionales
  Debugging. Screenshots werden dabei nur aufgenommen, NICHT gegen
  Baselines verglichen: die Baselines kodieren den kumulierten
  Voll-Lauf-Zustand (Theme aus 04, offene Find-Bar aus 06, Recents),
  gegen den ein Einzellauf prinzipiell nicht bestehen kann.
    python tests/e2e/run.py 21_split_mode
    python tests/e2e/run.py 21 05

- Eine einzelne Baseline erneuern: Datei in `baselines/` loeschen und
  einen VOLLEN Lauf starten (Auto-Seed legt sie neu an).
  `--update-baselines` ist mit Szenario-Auswahl deshalb gesperrt.

Exit-Code: 0 = alle Szenarien gruen, 1 = mind. ein Fehler,
2 = Aufruf-Fehler (unbekanntes Szenario / verbotene Options-Kombi).
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import sys
import time
import traceback
from pathlib import Path
from typing import Callable


# Skript ist in tests/e2e/, der Repo-Root ist zwei Ebenen drueber.
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.api import AutomationApi  # noqa: E402
from lib.app import AppController, discover_folio_binary, ensure_xvfb_or_no_op  # noqa: E402
from lib.report import ReportWriter, ScenarioAbort, ScenarioContext  # noqa: E402
from lib.todo import append_e2e_failure_entry  # noqa: E402
from lib.visual import VisualSuite  # noqa: E402


def discover_scenarios(scenarios_dir: Path) -> list[tuple[str, Callable, bool]]:
    """Importiert alle nummerierten `NN_name.py`-Module und gibt
    (Name, run, desktop_only)-Tripel in lexikografischer Reihenfolge
    zurueck. Das Skippen von `DESKTOP_ONLY = True`-Szenarien (Xvfb-
    untauglich — z. B. OS-Dialoge; siehe `docs/e2e-headless-caveats.md`)
    entscheidet der Aufrufer — eine explizite Auswahl per Szenario-
    Argument darf sie mitnehmen.
    """
    found: list[tuple[str, Callable, bool]] = []
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
        found.append((path.stem, run_fn, bool(getattr(module, "DESKTOP_ONLY", False))))
    return found


def select_scenarios(
    all_scenarios: list[tuple[str, Callable, bool]],
    selectors: list[str],
    include_desktop_only: bool,
) -> list[tuple[str, Callable]] | None:
    """Filtert die entdeckten Szenarien auf die per CLI angeforderten.

    Ein Selektor matcht per Gleichheit oder Praefix (`21` findet
    `21_split_mode`); ein optionales `.py`-Suffix wird toleriert. Die
    Reihenfolge bleibt lexikografisch (nicht Selektor-Reihenfolge) —
    Szenarien sind zwar isoliert, aber ein deterministischer Ablauf haelt
    Läufe vergleichbar. Explizit angeforderte DESKTOP_ONLY-Szenarien
    laufen auch ohne --include-desktop-only (mit Hinweis).

    Rueckgabe None bei unbekanntem Selektor (Aufruf-Fehler).
    """
    selected_names: set[str] = set()
    for raw in selectors:
        sel = raw[:-3] if raw.endswith(".py") else raw
        matches = [name for name, _, _ in all_scenarios
                   if name == sel or name.startswith(sel)]
        if not matches:
            available = ", ".join(name for name, _, _ in all_scenarios)
            print(f"[ERR] Kein Szenario passt zu {raw!r}. Verfuegbar: {available}")
            return None
        selected_names.update(matches)

    result: list[tuple[str, Callable]] = []
    for name, run_fn, desktop_only in all_scenarios:
        if name not in selected_names:
            continue
        if desktop_only and not include_desktop_only:
            print(f"[i] {name}: DESKTOP_ONLY — explizit angefordert, laeuft trotzdem.")
        result.append((name, run_fn))
    return result


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
    parser.add_argument(
        "only", nargs="*", metavar="SZENARIO",
        help="Nur diese Szenarien ausfuehren (Name oder Praefix, z. B. "
             "'21_split_mode' oder '21'). Ohne Angabe laeuft die volle Suite.",
    )
    args = parser.parse_args(argv)

    # Szenario-Auswahl VOR dem App-Start validieren: ein Tippfehler im
    # Selektor soll sofort mit Exit 2 enden, nicht erst nach dem
    # 45-s-Folio-Boot (dessen Cleanup erst im try/finally weiter unten
    # haengt).
    all_scenarios = discover_scenarios(Path(args.scenarios_dir))
    if args.only:
        if args.update_baselines:
            print("[ERR] --update-baselines ist mit Szenario-Auswahl gesperrt: "
                  "Baselines kodieren den kumulierten Voll-Lauf-Zustand "
                  "(Theme/Find-Bar/Recents aus frueheren Szenarien) — ein "
                  "Teil-Lauf wuerde sie vergiften. Einzelne Baseline erneuern: "
                  "Datei in baselines/ loeschen + voller Lauf.")
            return 2
        maybe = select_scenarios(all_scenarios, args.only, args.include_desktop_only)
        if maybe is None:
            return 2
        scenarios = maybe
        print("[i] Teil-Lauf: Screenshots werden nur aufgenommen, nicht "
              "gegen Baselines verglichen (siehe Modul-Docstring).")
    else:
        scenarios = []
        for name, run_fn, desktop_only in all_scenarios:
            if desktop_only and not args.include_desktop_only:
                print(f"[SKIP] {name}: DESKTOP_ONLY (use --include-desktop-only)")
                continue
            scenarios.append((name, run_fn))
    print(f"[i] {len(scenarios)} Szenario(s) ausgewaehlt: "
          f"{', '.join(n for n, _ in scenarios)}")

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    artifacts_dir = SCRIPT_DIR / "artifacts" / timestamp
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    console_log = artifacts_dir / "console.log"
    binary = discover_folio_binary(REPO_ROOT)

    api = AutomationApi(args.base_url)
    app: AppController | None = None
    if not args.attach:
        ensure_xvfb_or_no_op()
        # Release-Builds starten die Automation-API nur mit explizitem Opt-in.
        env = os.environ.copy()
        env["FOLIO_AUTOMATION"] = "1"
        # i18n de-Pin (Spec I1b): Baselines + String-Stabilität.
        env["FOLIO_LANG"] = "de"
        app = AppController(binary=binary, console_log=console_log, env=env)
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
        # Platzhalter, damit der Report immer eine Konsole-Datei
        # referenzieren kann. Stellt der Wrapper (run-e2e.sh) die echte
        # Konsole via FOLIO_E2E_CONSOLE_LOG bereit, wird sie nach dem
        # Lauf hierher kopiert (siehe unten).
        console_log.write_text(
            "(attach mode — Folio-Konsole nicht aufgezeichnet)\n",
            encoding="utf-8",
        )

    # de-Pin assert: /state.lang must be "de" before baselines/scenarios.
    try:
        boot_state = api.state()
        lang = boot_state.get("lang")
        if lang != "de":
            print(
                f"[ERR] E2E erwartet lang=='de' (FOLIO_LANG=de), "
                f"got lang={lang!r}. Set FOLIO_LANG=de in run-e2e.sh "
                f"and run.py start paths."
            )
            if app is not None:
                app.stop(api)
            return 1
        print(f"[i] i18n pin ok: lang={lang}")
    except Exception as e:
        print(f"[ERR] could not assert /state.lang: {e}")
        if app is not None:
            app.stop(api)
        return 1

    # I1c: readiness via /state.frontendReady (not a /dom roundtrip that
    # itself requires the FE). Same 25 s budget as the former body probe.
    print("[i] Warte auf frontendReady (/state)...")
    ready_deadline = time.time() + 25.0
    ready_ok = False
    try:
        while time.time() < ready_deadline:
            st = api.state()
            if st.get("frontendReady") is True:
                ready_ok = True
                break
            time.sleep(0.1)
        if not ready_ok:
            print(
                "[ERR] frontendReady wurde nicht innerhalb von 25 s true "
                "(Bootstrap/frontend_ready ausgeblieben?). "
                f"Letzter /state.frontendReady={api.state().get('frontendReady')!r}"
            )
            if app is not None:
                app.stop(api)
            return 1
        print("[i] frontendReady=true — Webview-Bootstrap fertig.")
        time.sleep(0.5)  # Kurze Stabilisierung fuer Xvfb Rendering-Flush
    except Exception as e:
        print(f"[ERR] Fehler beim Warten auf frontendReady: {e}")
        if app is not None:
            app.stop(api)
        return 1

    fixtures_dir = SCRIPT_DIR / "fixtures"
    baselines_dir = SCRIPT_DIR / "baselines"

    # Fixtures sind git-getrackte Test-Daten, die schreibende Szenarien
    # (03/08/10/11/15) in place modifizieren (Save-Roundtrip, append via
    # Editor). Ohne Reset akkumulieren die Aenderungen ueber Laeufe UND
    # lecken innerhalb eines Laufs in spaetere Szenarien (z. B. sieht
    # 21_split die von 11/15 angehaengten Zeilen) -> nichtdeterministische
    # Visual-Diffs. Wir snapshotten den Start-Zustand (als pristine
    # angenommen) und stellen ihn vor jedem Szenario + am Ende wieder her.
    # Restore passiert in place am Original-Pfad, damit der in der
    # Statusleiste sichtbare Dateipfad (Teil der Visual-Baseline) stabil
    # bleibt.
    fixture_snapshot = {p: p.read_bytes() for p in fixtures_dir.rglob("*") if p.is_file()}

    def restore_fixtures() -> None:
        for p, data in fixture_snapshot.items():
            try:
                if p.read_bytes() == data:
                    continue
            except OSError:
                pass
            p.write_bytes(data)

    visual = VisualSuite(
        baselines_dir=baselines_dir,
        artifacts_dir=artifacts_dir,
        update_baselines=args.update_baselines,
        record_only=bool(args.only),
    )

    run_start = time.monotonic()
    run_start_wall = time.time()
    results = []

    # try/finally: Fixtures-Restore und App-Stop muessen auch bei
    # Ctrl+C/Crash mitten in einem schreibenden Szenario laufen — sonst
    # snapshottet der NAECHSTE Run die verschmutzten Fixtures "als
    # pristine" und restored sie konsequent vor jedem Szenario
    # (persistente Visual-Diffs bis zum manuellen git checkout).
    try:
        for name, run_fn in scenarios:
            restore_fixtures()
            print(f"[>] {name}")
            ctx = ScenarioContext(name, api, visual, fixtures_dir)
            try:
                run_fn(ctx)
            except ScenarioAbort:
                # Im Step-Wrapper bereits erfasst; Run weiterfuehren.
                pass
            except Exception as e:
                # Exception AUSSERHALB eines step()-Blocks (Setup,
                # Pre-Loops): ohne Registrierung wuerde finish() das
                # Szenario mit 0 Steps als PASS werten.
                ctx.record_failure(
                    str(e) or e.__class__.__name__, traceback.format_exc()
                )
            result = ctx.finish()
            results.append(result)
            status = "PASS" if result.passed else "FAIL"
            print(f"[{status}] {name} ({result.duration_s:.2f}s)")

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
    finally:
        # Fixtures auf den Start-Zustand zuruecksetzen, damit ein Lauf
        # keine Diffs im Working Tree hinterlaesst.
        restore_fixtures()
        if app is not None:
            app.stop(api)

    run_end_wall = time.time()

    # Im Attach-Modus die echte Folio-Konsole in den Artefaktordner
    # uebernehmen, falls der Wrapper sie bereitstellt — vorher verlinkte
    # der Report im Standard-Linux-Pfad nur den Platzhaltertext.
    if args.attach:
        wrapper_log = os.environ.get("FOLIO_E2E_CONSOLE_LOG")
        if wrapper_log and Path(wrapper_log).is_file():
            try:
                shutil.copyfile(wrapper_log, console_log)
            except OSError as e:
                print(f"[WARN] Konsole-Log nicht kopierbar: {e}")

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
