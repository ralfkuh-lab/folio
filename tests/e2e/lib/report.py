"""Run-Report-Writer + ScenarioContext (das `ctx`-Objekt, das jedem
Szenario übergeben wird).

Der Report ist Markdown — gut menschen-lesbar, vom Agent diff-bar,
und git-friendly. Pro Szenario gibt es einen Block mit Schritt-Liste,
Status, Dauer und Fehler-Details.

Errors landen zusätzlich in `errors.md` (nur die Failures, kompakt) —
der lib/todo.py-Pfad referenziert dann diese Datei vom TODO-Eintrag.
"""

from __future__ import annotations

import time
import traceback
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Optional


@dataclass
class StepResult:
    name: str
    passed: bool
    duration_s: float
    detail: str = ""


@dataclass
class ScenarioResult:
    name: str
    passed: bool
    duration_s: float
    steps: list[StepResult] = field(default_factory=list)
    error: Optional[str] = None
    traceback: Optional[str] = None


class ScenarioAbort(Exception):
    """Raised internally to short-circuit a scenario after a failed step."""


class ScenarioContext:
    """Das `ctx`-Objekt, das jedem Szenario übergeben wird. Kapselt API,
    Visual-Suite, Schritt-Tracking und Fehler-Sammlung.

    Konvention: Wirft ein Step intern eine Exception (Assertion, API-
    Fehler), markieren wir den Step als FAIL und brechen das **Szenario**
    ab (nicht den Run) — nachfolgende Szenarien laufen weiter.
    """

    def __init__(self, name: str, api, visual, fixtures_dir: Path):
        self.name = name
        self.api = api
        self.visual = visual
        self.fixtures_dir = Path(fixtures_dir)
        self.steps: list[StepResult] = []
        self._start = time.monotonic()
        self._aborted_with: Optional[tuple[str, str]] = None  # (message, traceback)

    # ----- helpers used inside scenarios -----------------------------

    def fixture(self, *relative: str) -> str:
        """Absoluter Pfad zu einer Test-Fixture."""
        return str(self.fixtures_dir.joinpath(*relative).resolve())

    @contextmanager
    def step(self, description: str) -> Iterator[None]:
        """Markiert einen Schritt. Eine Exception innerhalb des `with`-Blocks
        wird abgefangen, der Step als FAIL aufgezeichnet und das Szenario
        abgebrochen (via ScenarioAbort).
        """
        if self._aborted_with is not None:
            # Bereits abgebrochen — neue Steps werden nicht mehr ausgeführt,
            # damit nachfolgende Assertions nicht in einem inkonsistenten
            # App-State laufen.
            raise ScenarioAbort(self._aborted_with[0])
        start = time.monotonic()
        try:
            yield
        except ScenarioAbort:
            raise
        except Exception as e:
            dur = time.monotonic() - start
            self.steps.append(
                StepResult(name=description, passed=False, duration_s=dur, detail=str(e))
            )
            self._aborted_with = (str(e), traceback.format_exc())
            raise ScenarioAbort(str(e)) from e
        else:
            dur = time.monotonic() - start
            self.steps.append(
                StepResult(name=description, passed=True, duration_s=dur)
            )

    def expect(self, condition: bool, message: str) -> None:
        """Assertion innerhalb eines Schrittes; nutzt die normale Step-
        Mechanik via Exception, falls condition false ist.
        """
        if not condition:
            raise AssertionError(message)

    def expect_event(self, event: str, timeout_ms: int = 5000) -> None:
        result = self.api.wait(event, timeout_ms=timeout_ms)
        if not result.get("fired"):
            raise AssertionError(f"event '{event}' did not fire within {timeout_ms} ms")

    def screenshot(self, name: str, threshold_ratio: Optional[float] = None) -> None:
        """Aufnahme + Vergleich. Bei Mismatch wird der Step gefailt — wenn
        innerhalb eines `step()`-Blocks aufgerufen, läuft der Abbruch über
        ScenarioAbort wie gewohnt.
        """
        full_name = f"{self.name}__{name}"
        # Deterministische Render-Synchronisation statt fixem Sleep: wartet,
        # bis das Frontend den durch Backend-State-Wechsel ausgeloesten
        # Reflow gerendert hat (Microtask + zwei Frames + laufende
        # CSS-Transitions, rAF-Ack ueber POST /sync/render).
        self.api.sync_render()
        png = self.api.screenshot()
        result = self.visual.compare(full_name, png, threshold_ratio=threshold_ratio)
        if not result.passed:
            raise AssertionError(f"visual diff failed: {result.message}")

    # ----- finalize ---------------------------------------------------

    def finish(self) -> ScenarioResult:
        passed = all(s.passed for s in self.steps) and self._aborted_with is None
        dur = time.monotonic() - self._start
        return ScenarioResult(
            name=self.name,
            passed=passed,
            duration_s=dur,
            steps=list(self.steps),
            error=self._aborted_with[0] if self._aborted_with else None,
            traceback=self._aborted_with[1] if self._aborted_with else None,
        )


class ReportWriter:
    """Schreibt `report.md` und `errors.md` in `artifacts/<run>/`."""

    def __init__(self, artifacts_dir: Path):
        self.artifacts_dir = Path(artifacts_dir)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)

    def write(
        self,
        run_started: float,
        run_finished: float,
        results: list[ScenarioResult],
        visual_summary: dict,
        console_log_path: Path,
        binary_path: Path,
    ) -> tuple[Path, Optional[Path]]:
        report_path = self.artifacts_dir / "report.md"
        report = self._build_report(
            run_started, run_finished, results, visual_summary, console_log_path, binary_path
        )
        report_path.write_text(report, encoding="utf-8")

        failed = [r for r in results if not r.passed]
        errors_path: Optional[Path] = None
        if failed:
            errors_path = self.artifacts_dir / "errors.md"
            errors_path.write_text(
                self._build_errors(run_started, failed, visual_summary),
                encoding="utf-8",
            )
        return report_path, errors_path

    def _build_report(
        self,
        run_started: float,
        run_finished: float,
        results: list[ScenarioResult],
        visual_summary: dict,
        console_log_path: Path,
        binary_path: Path,
    ) -> str:
        lines = []
        ts_start = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(run_started))
        duration = run_finished - run_started
        passed = sum(1 for r in results if r.passed)
        failed = sum(1 for r in results if not r.passed)

        lines.append(f"# E2E Run – {ts_start}")
        lines.append("")
        lines.append(f"- Dauer: **{duration:.2f}s**")
        lines.append(f"- Szenarien: **{len(results)}** – {passed} PASS, {failed} FAIL")
        lines.append(f"- Visuelle Vergleiche: **{visual_summary['total']}** – "
                     f"{visual_summary['passed']} PASS, {visual_summary['failed']} FAIL")
        lines.append(f"- Binary: `{binary_path}`")
        lines.append(f"- Folio-Konsole: [`{console_log_path.name}`]({console_log_path.name})")
        lines.append("")
        lines.append("## Szenarien")
        lines.append("")

        for r in results:
            status = "✅ PASS" if r.passed else "❌ FAIL"
            lines.append(f"### {status} – `{r.name}` ({r.duration_s:.2f}s)")
            lines.append("")
            if r.steps:
                lines.append("| # | Schritt | Status | Dauer | Detail |")
                lines.append("|---:|---|:---:|---:|---|")
                for i, s in enumerate(r.steps, 1):
                    icon = "✓" if s.passed else "✗"
                    detail = s.detail.replace("|", "\\|") if s.detail else ""
                    lines.append(
                        f"| {i} | {s.name} | {icon} | {s.duration_s:.2f}s | {detail} |"
                    )
                lines.append("")
            if r.error:
                lines.append("**Fehler:**")
                lines.append("")
                lines.append("```")
                lines.append(r.error)
                lines.append("```")
                lines.append("")
                if r.traceback:
                    lines.append("<details><summary>Traceback</summary>")
                    lines.append("")
                    lines.append("```")
                    lines.append(r.traceback.strip())
                    lines.append("```")
                    lines.append("")
                    lines.append("</details>")
                    lines.append("")
            lines.append("")

        lines.append("## Visuelle Vergleiche")
        lines.append("")
        if not visual_summary["results"]:
            lines.append("_(keine)_")
            lines.append("")
        else:
            lines.append("| Name | Status | Mismatch | Threshold | Diff |")
            lines.append("|---|:---:|---:|---:|---|")
            for v in visual_summary["results"]:
                icon = "✓" if v["passed"] else "✗"
                diff_cell = f"[diff]({Path(v['diff']).name})" if v.get("diff") else "—"
                lines.append(
                    f"| `{v['name']}` | {icon} | {v['mismatch_ratio']:.4%} | "
                    f"{v['threshold_ratio']:.2%} | {diff_cell} |"
                )
            lines.append("")

        return "\n".join(lines)

    def _build_errors(
        self,
        run_started: float,
        failed: list[ScenarioResult],
        visual_summary: dict,
    ) -> str:
        lines = []
        ts_start = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(run_started))
        lines.append(f"# E2E Fehler – {ts_start}")
        lines.append("")
        lines.append(f"{len(failed)} Szenario(s) gefailt.")
        lines.append("")
        for r in failed:
            lines.append(f"## ❌ `{r.name}`")
            lines.append("")
            if r.error:
                lines.append(f"**Fehler:** {r.error}")
                lines.append("")
            failed_steps = [s for s in r.steps if not s.passed]
            if failed_steps:
                lines.append("Gefailter Schritt:")
                for s in failed_steps:
                    lines.append(f"- `{s.name}` ({s.duration_s:.2f}s) – {s.detail}")
                lines.append("")
            if r.traceback:
                lines.append("```")
                lines.append(r.traceback.strip())
                lines.append("```")
                lines.append("")

        # Visuelle Fehler getrennt rausziehen (sie sind in den Szenarien
        # schon als Step-FAIL erfasst, aber ein Quick-Index hilft).
        visual_failed = [v for v in visual_summary["results"] if not v["passed"]]
        if visual_failed:
            lines.append("## Visuelle Diffs")
            lines.append("")
            for v in visual_failed:
                lines.append(
                    f"- `{v['name']}`: {v['message']} – diff: "
                    f"{Path(v['diff']).name if v.get('diff') else '—'}"
                )
            lines.append("")
        return "\n".join(lines)
