#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Side-by-side: shipped reference page (left) vs v2 mockup (right), per screen and width.

Usage (repo root, after scripts/v2-mockup-shots.py):

    uv run --with pillow python scripts/v2-mockup-compare.py

Reads the committed reference shots under docs/design/screenshots/ (the latest
shipped screenshot of each surface) and writes
docs/design/screenshots/v2/compare/<screen>-<1440|390>.jpg.
"""
from pathlib import Path

from PIL import Image, ImageDraw

SHOTS = Path(__file__).resolve().parents[1] / "docs/design/screenshots"
OUT = SHOTS / "v2/compare"
# screen -> (reference 1440, reference 390); references are the latest shipped shots
REFS = {
    "home": ("ride-tonight/after/home-1440.jpg", "ride-tonight/after/home-390.jpg"),
    "ride-hud": ("ride-tonight/after/ride-1440.jpg", "ride-tonight/after/ride-390.jpg"),
    "devices": ("ride-tonight/trainer/trainer-reconnected-1440.png", "ride-tonight/trainer/trainer-reconnected-390.png"),
    "show": ("p2b/after/show-playing-1440.jpg", "p2b/after/show-playing-390.jpg"),
    "finish": ("p3/after/finish-1440.jpg", "p3/after/finish-390.jpg"),
}
GAP, BAR = 24, 40


def pair(left: Image.Image, right: Image.Image, labels: tuple[str, str]) -> Image.Image:
    h = max(left.height, right.height)
    canvas = Image.new("RGB", (left.width + right.width + GAP, h + BAR), (245, 241, 234))
    d = ImageDraw.Draw(canvas)
    for x, img, label in ((0, left, labels[0]), (left.width + GAP, right, labels[1])):
        canvas.paste(img, (x, BAR))
        d.text((x + 8, 12), label, fill=(40, 30, 24))
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for screen, (r1440, r390) in REFS.items():
        for width, ref in (("1440", r1440), ("390", r390)):
            left = Image.open(SHOTS / ref).convert("RGB")
            right = Image.open(SHOTS / f"v2/mockup/{screen}-{width}.jpg").convert("RGB")
            if width == "390":
                right = right.resize((right.width // 2, right.height // 2), Image.LANCZOS)  # shots are 2x
            if left.height != right.height:
                left = left.resize((round(left.width * right.height / left.height), right.height), Image.LANCZOS)
            img = pair(left, right, (f"shipped: {ref}", f"v2 mockup: {screen}-{width}"))
            dest = OUT / f"{screen}-{width}.jpg"
            img.save(dest, "JPEG", quality=80, optimize=True, progressive=True)
            print(dest.relative_to(SHOTS.parents[2]), img.size)


if __name__ == "__main__":
    main()
