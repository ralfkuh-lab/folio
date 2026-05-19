#!/usr/bin/env python3
"""Backt eine weiche Alpha-Vignette in den About-Dialog-Avatar.

Hintergrund: `src-tauri/dist/about/avatar.png` wird vom Frontend im
Hero-Bereich des About-Dialogs angezeigt. Wenn das Bild einen opaken
hellen Hintergrund hat (typisch fuer KI-erzeugte Aquarell-Portraits),
sieht es im Dark Mode aus wie ein heller Block gegen den dunklen
Dialog. Loesung: radiale Alpha-Mask direkt ins PNG einbacken, sodass
die Bild-Raender echt transparent sind.

Aufruf:
    python3 scripts/bake_avatar_vignette.py [pfad/zum/bild.png]

Default: src-tauri/dist/about/avatar.png im Projekt-Root.

Braucht Pillow (`pip install Pillow`).
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


def bake_vignette(path: Path) -> None:
    src = Image.open(path).convert("RGBA")
    w, h = src.size

    # Voll-opaker zentraler Ellipsen-Bereich.
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    pad = int(w * 0.18)
    draw.ellipse((pad, pad, w - pad, h - pad), fill=255)

    # Weicher Uebergang via Gaussian-Blur — Radius bestimmt die
    # Fade-Breite. ~15 % der Bildbreite ist ein angenehmer Mittelwert.
    mask = mask.filter(ImageFilter.GaussianBlur(radius=int(w * 0.15)))

    src.putalpha(mask)
    src.save(path, "PNG", optimize=True)
    print(f"OK vignette baked into {path} ({w}x{h})")


def main() -> int:
    if len(sys.argv) > 1:
        target = Path(sys.argv[1])
    else:
        repo_root = Path(__file__).resolve().parent.parent
        target = repo_root / "src-tauri" / "dist" / "about" / "avatar.png"
    if not target.exists():
        print(f"error: {target} nicht gefunden", file=sys.stderr)
        return 2
    bake_vignette(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
