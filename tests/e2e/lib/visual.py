"""Screenshot-Diff. Vergleicht aktuelle Aufnahmen pixelweise gegen
committed Baselines (`tests/e2e/baselines/*.png`).

Dep: Pillow (`pip install Pillow`).

Toleranz-Modell: Default erlaubt 1 % der Pixel sichtbar (Y-Channel
> diff_threshold) abzuweichen — Sub-Pixel/Antialiasing-Rauschen wird
darunter geschluckt, echte Layout-/Theme-Brüche fallen durch.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

try:
    from PIL import Image, ImageChops
except ImportError as e:
    raise ImportError(
        "Pillow ist nicht installiert. Run `pip install Pillow` "
        "(oder `pip install -r tests/e2e/requirements.txt`).",
    ) from e


@dataclass
class CompareResult:
    name: str
    captured_path: Path
    baseline_path: Optional[Path]
    diff_path: Optional[Path]
    mismatch_ratio: float  # 0.0..1.0
    threshold_ratio: float
    passed: bool
    message: str

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "passed": self.passed,
            "mismatch_ratio": round(self.mismatch_ratio, 5),
            "threshold_ratio": self.threshold_ratio,
            "captured": str(self.captured_path),
            "baseline": str(self.baseline_path) if self.baseline_path else None,
            "diff": str(self.diff_path) if self.diff_path else None,
            "message": self.message,
        }


class VisualSuite:
    """Speichert Screenshots in `artifacts/<run>/screenshots/` und vergleicht
    sie gegen `tests/e2e/baselines/<name>.png`.

    Im `update_baselines`-Mode werden Baselines nur geschrieben (keine
    Vergleichs-Aussage).
    """

    def __init__(
        self,
        baselines_dir: Path,
        artifacts_dir: Path,
        update_baselines: bool = False,
        threshold_ratio: float = 0.01,
        diff_threshold: int = 12,
    ):
        self.baselines_dir = Path(baselines_dir)
        self.screenshots_dir = Path(artifacts_dir) / "screenshots"
        self.diffs_dir = Path(artifacts_dir) / "diffs"
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)
        self.diffs_dir.mkdir(parents=True, exist_ok=True)
        self.baselines_dir.mkdir(parents=True, exist_ok=True)
        self.update_baselines = update_baselines
        self.threshold_ratio = threshold_ratio
        self.diff_threshold = diff_threshold
        self.results: list[CompareResult] = []

    def compare(self, name: str, png_bytes: bytes,
                threshold_ratio: Optional[float] = None) -> CompareResult:
        """Speichert die Aufnahme, vergleicht mit der Baseline, registriert
        das Ergebnis intern und gibt es auch zurück.
        """
        threshold = self.threshold_ratio if threshold_ratio is None else threshold_ratio
        captured_path = self.screenshots_dir / f"{name}.png"
        captured_path.write_bytes(png_bytes)

        baseline_path = self.baselines_dir / f"{name}.png"

        if self.update_baselines:
            baseline_path.write_bytes(png_bytes)
            result = CompareResult(
                name=name,
                captured_path=captured_path,
                baseline_path=baseline_path,
                diff_path=None,
                mismatch_ratio=0.0,
                threshold_ratio=threshold,
                passed=True,
                message="baseline updated",
            )
            self.results.append(result)
            return result

        if not baseline_path.exists():
            # Auto-seed: Baseline existiert nicht → wird mit dieser Aufnahme
            # angelegt. Erster Run nach Hinzufügen eines Szenarios funktioniert
            # damit ohne separaten `--update-baselines`-Lauf; Mismatch erst
            # ab dem zweiten Run möglich.
            baseline_path.write_bytes(png_bytes)
            result = CompareResult(
                name=name,
                captured_path=captured_path,
                baseline_path=baseline_path,
                diff_path=None,
                mismatch_ratio=0.0,
                threshold_ratio=threshold,
                passed=True,
                message="baseline created (first run)",
            )
            self.results.append(result)
            return result

        cur = Image.open(io.BytesIO(png_bytes)).convert("RGB")
        base = Image.open(baseline_path).convert("RGB")

        if cur.size != base.size:
            result = CompareResult(
                name=name,
                captured_path=captured_path,
                baseline_path=baseline_path,
                diff_path=None,
                mismatch_ratio=1.0,
                threshold_ratio=threshold,
                passed=False,
                message=(
                    f"size mismatch: captured {cur.size} vs baseline {base.size}"
                ),
            )
            self.results.append(result)
            return result

        mismatch_ratio, diff_path = self._diff(cur, base, name)
        passed = mismatch_ratio <= threshold
        result = CompareResult(
            name=name,
            captured_path=captured_path,
            baseline_path=baseline_path,
            diff_path=diff_path if not passed else None,
            mismatch_ratio=mismatch_ratio,
            threshold_ratio=threshold,
            passed=passed,
            message=(
                f"mismatch {mismatch_ratio:.4%} (threshold {threshold:.2%})"
                if not passed
                else f"ok ({mismatch_ratio:.4%} within threshold)"
            ),
        )
        self.results.append(result)
        return result

    def _diff(self, cur: "Image.Image", base: "Image.Image", name: str) -> Tuple[float, Path]:
        diff = ImageChops.difference(cur, base).convert("L")
        # Schwelle pro Pixel: alles < diff_threshold gilt als gleich.
        # Pillow.point() arbeitet auf Lookup-Table-Basis und ist deutlich
        # schneller als pixel-Python-Schleifen.
        bw = diff.point(lambda v: 255 if v > self.diff_threshold else 0)
        # Anzahl mismatched Pixel:
        total_pixels = bw.size[0] * bw.size[1]
        # getextrema()[1] == 255 wenn überhaupt einer drüber war; getbbox()
        # liefert die mismatched Region. Für den Ratio brauchen wir aber die
        # Pixelzahl — wir benutzen histogram()[255].
        hist = bw.histogram()
        mismatch_pixels = hist[255] if len(hist) > 255 else 0
        ratio = mismatch_pixels / total_pixels if total_pixels else 0.0

        diff_path = self.diffs_dir / f"{name}.png"
        if ratio > 0.0:
            # Diff-Visualisierung: Original (graustufen) + rot-akzentuierte
            # mismatched Pixel.
            visual = cur.copy()
            mask = bw  # 0 oder 255
            red = Image.new("RGB", cur.size, (255, 0, 64))
            visual.paste(red, mask=mask)
            visual.save(diff_path)
        return ratio, diff_path

    def summary(self) -> dict:
        passed = sum(1 for r in self.results if r.passed)
        failed = sum(1 for r in self.results if not r.passed)
        return {
            "total": len(self.results),
            "passed": passed,
            "failed": failed,
            "results": [r.to_dict() for r in self.results],
        }
