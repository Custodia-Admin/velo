#!/usr/bin/env python3
"""Side-by-side composites for the P2.4 design gate: approved mockup (left) | build (right).

Usage (repo root, after the screen scripts have written docs/design/screenshots/v2/build/):

    uv run --with pillow python scripts/v2-build-shots/compare.py [--only home,finish]

Writes docs/design/screenshots/v2/build/compare/<screen>-<1440|390|tv>[-night].jpg for every
build shot that has a mockup render of the same name. 390 shots are 2x on both sides and are
shown at 1x (CSS pixels); TV and 1440 at 1x.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw

V2 = Path(__file__).resolve().parents[2] / "docs/design/screenshots/v2"
GAP, BAR = 24, 40


def load(path: Path, half: bool) -> Image.Image:
    img = Image.open(path).convert("RGB")
    return img.resize((img.width // 2, img.height // 2), Image.LANCZOS) if half else img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    only = {s for s in args.only.split(",") if s}
    out = V2 / "build/compare"
    out.mkdir(parents=True, exist_ok=True)
    n = 0
    for build in sorted((V2 / "build").glob("*.jpg")):
        screen = build.stem.split("-1440")[0].split("-390")[0].split("-tv")[0]
        if only and screen not in only:
            continue
        mock = V2 / "mockup" / build.name
        if not mock.exists():
            continue
        half = "-390" in build.stem
        left, right = load(mock, half), load(build, half)
        h = max(left.height, right.height)
        canvas = Image.new("RGB", (left.width + right.width + GAP, h + BAR), (245, 241, 234))
        d = ImageDraw.Draw(canvas)
        for x, img, label in ((0, left, f"approved mockup: {build.stem}"), (left.width + GAP, right, f"build: {build.stem}")):
            canvas.paste(img, (x, BAR))
            d.text((x + 8, 12), label, fill=(40, 30, 24))
        canvas.save(out / build.name, "JPEG", quality=82, optimize=True, progressive=True)
        n += 1
    print(f"wrote {n} composites to {out}")


if __name__ == "__main__":
    main()
