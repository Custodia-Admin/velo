"""Side-by-side compare for the P3 design gate: before | mockup | after.

    uv run --with pillow python scripts/p3-compare.py

Converts docs/design/screenshots/p3/after/*.png to JPEG (smaller in git) and
writes compare/*.jpg. Before = P2a reference Home and the P2a ride view.
"""
import pathlib
from PIL import Image, ImageDraw

root = pathlib.Path("docs/design/screenshots")
p3 = root / "p3"
(p3 / "compare").mkdir(parents=True, exist_ok=True)

for png in sorted((p3 / "after").glob("*.png")):
    Image.open(png).convert("RGB").save(png.with_suffix(".jpg"), quality=82)
    png.unlink()
for png in sorted((p3 / "mockup").glob("*.png")):
    Image.open(png).convert("RGB").save(png.with_suffix(".jpg"), quality=82)
    png.unlink()


def panel(paths_labels, out, height):
    ims = []
    for path, label in paths_labels:
        im = Image.open(path).convert("RGB")
        if im.height > height:
            im = im.crop((0, 0, im.width, height))
        ims.append((im, label))
    w = sum(i.width for i, _ in ims) + 24 * (len(ims) - 1)
    h = max(i.height for i, _ in ims) + 40
    canvas = Image.new("RGB", (w, h), (12, 14, 20))
    d = ImageDraw.Draw(canvas)
    x = 0
    for im, label in ims:
        d.text((x + 8, 12), label, fill=(230, 230, 230))
        canvas.paste(im, (x, 40))
        x += im.width + 24
    canvas.save(out, quality=82)


for vp, h in (("1440", 900), ("390", 1400)):
    panel(
        [
            (root / "p2a/after" / f"home-{vp}.jpg", f"before (P2a Home) {vp}"),
            (p3 / "mockup" / f"play-mockup-{vp}.jpg", "mockup"),
            (p3 / "after" / f"home-play-{vp}.jpg", f"after {vp}"),
        ],
        p3 / "compare" / f"home-{vp}-before-mockup-after.jpg",
        h,
    )
    panel(
        [
            (p3 / "before" / f"ride-{vp}.jpg", f"before (P2a ride) {vp}"),
            (p3 / "mockup" / f"play-mockup-{vp}.jpg", "mockup"),
            (p3 / "after" / f"ride-pickup-{vp}.jpg", f"after {vp}"),
        ],
        p3 / "compare" / f"ride-{vp}-before-mockup-after.jpg",
        900 if vp == "1440" else 844,
    )
print(sorted(p.name for p in (p3 / "compare").iterdir()))
