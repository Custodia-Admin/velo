#!/usr/bin/env python3
"""Labelled side-by-side composites (before | after, or owner shot | before | after).

    uv run --with pillow python scripts/v2-build-shots/before-after.py <out.jpg> "<label>=<image>" ...

Each panel may carry a scale ("<label>=<image>@0.5" halves a 2x shot to CSS pixels); panels are top-aligned on a paper background with a caption bar, and the result is saved as
a JPEG. Used for the owner-viewport evidence (docs/design/screenshots/v2/build/owner-1280/).
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

GAP, BAR = 24, 44
PAPER = (245, 241, 234)
INK = (40, 30, 24)


def font(size: int):
    for f in ("/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"):
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def panel(spec: str) -> tuple[str, Image.Image]:
    """'<label>=<path>[@<scale>]': 2x shots take @0.5 so every panel is in CSS pixels."""
    label, _, rest = spec.partition("=")
    path, _, scale = rest.partition("@")
    img = Image.open(path).convert("RGB")
    k = float(scale or 1)
    if k != 1:
        img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
    return label, img


def main() -> None:
    out = Path(sys.argv[1])
    panels = [panel(s) for s in sys.argv[2:]]
    h = max(p.height for _, p in panels)
    w = sum(p.width for _, p in panels) + GAP * (len(panels) - 1)
    canvas = Image.new("RGB", (w, h + BAR), PAPER)
    d = ImageDraw.Draw(canvas)
    f = font(18)
    x = 0
    for label, img in panels:
        canvas.paste(img, (x, BAR))
        d.text((x + 8, 12), label, fill=INK, font=f)
        x += img.width + GAP
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "JPEG", quality=82, optimize=True, progressive=True)
    print(out, canvas.size)


if __name__ == "__main__":
    main()
