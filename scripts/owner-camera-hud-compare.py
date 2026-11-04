"""Compose the owner-camera before/after for the compact ride HUD.

usage: uv run --with pillow python scripts/owner-camera-hud-compare.py <out.jpg> <owner.png> <before.png> <after.png> [<after-error.png>]

A 2x2 sheet, each panel labelled: the owner's own screenshot (2 Nov) | PR #27's head at the same camera;
the compact HUD | the compact HUD with the trainer link failed as in the owner's shot (ERROR=1). The
before/after labels carry the measured ride-UI area from the shots' .json (owner-camera-hud-shot.py).
"""
import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

out, owner, before, after = sys.argv[1:5]
after_error = sys.argv[5] if len(sys.argv) > 5 else None
W = 1280  # each panel at CSS size (the shots are @2)


def area(p):
    j = pathlib.Path(p).with_suffix(".json")
    if not j.exists():
        return ""
    a = json.loads(j.read_text())["hudArea"]
    return f" · ride UI {a['sumPct']} % of the screen"


def font(size):
    for f in ("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"):
        if pathlib.Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


panels = [
    (owner, "Owner, 2 Nov (Assisi, night)"),
    (before, "Before: PR #27 head 5954f7e" + area(before)),
    (after, "After: compact ride HUD" + area(after)),
]
if after_error:
    panels.append((after_error, "After, trainer link failed: one chip" + area(after_error)))
imgs = []
for path, label in panels:
    im = Image.open(path).convert("RGB")
    im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
    imgs.append((im, label))
H = max(i.height for i, _ in imgs)
BAR, GAP = 44, 16
cols = 2 if len(imgs) == 4 else len(imgs)
rows = (len(imgs) + cols - 1) // cols
sheet = Image.new("RGB", (W * cols + GAP * (cols - 1), (H + BAR) * rows + GAP * (rows - 1)), (246, 241, 232))
d = ImageDraw.Draw(sheet)
f = font(22)
for k, (im, label) in enumerate(imgs):
    x = (k % cols) * (W + GAP)
    y = (k // cols) * (H + BAR + GAP)
    d.text((x + 8, y + 10), label, fill=(40, 32, 26), font=f)
    sheet.paste(im, (x, y + BAR))
sheet.save(out, quality=86)
print(out, sheet.size)
