#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright", "pillow", "numpy"]
# ///
"""Velo v2 world thumbnails: render photographic stills of a baked world bundle.

Usage (from the repo root):

    uv run -q --with playwright --with pillow --with numpy python scripts/v2-world-thumbs/shoot.py \
        [--only id1,id2] [--ss 2] [--out DIR]

    Renders one still at a time (the laptop is shared and thermally limited);
    keep --ss at 2 (max 3). The full 11-still set takes ~4-5 min on the Intel Arc.

What it does:
  * three.js is NOT a repo dependency. It is fetched once into a scratch dir
    (default ~/.hermes/cache/scratch/v2-thumbs/three, override with THREE_DIR)
    with `npm install --prefix <dir> three@0.170.0` and served locally, so
    nothing loads from a CDN at render time.
  * Serves a temp dir of symlinks (tool/ -> this folder, worlds/ -> public/worlds,
    three/ -> the scratch three package) with python http.server on a free port.
  * Launches headless Chromium (/usr/sbin/chromium, override with CHROMIUM) on
    the real GPU (ANGLE Vulkan; swiftshader is too slow and renders black),
    opens tool/index.html?view=<id> for every view in views.json, waits for
    window.__thumbDone, reads the canvas (rendered at --ss x size) and
    downsamples it with Lanczos.
  * finish(): optional screen-space depth of field (views.json "dof", the
    logged rider box stays sharp), then a per-mood film grade (GRADES, override
    with views.json "grade"): halation + bloom on the highlights, S-curve with a
    soft shoulder, warm-highlight / cool-shadow split toning, saturation,
    lateral chroma + softness toward the corners, vignette, seeded grain.
  * Prints window.__riderBox (screen fractions, every rider vertex projected)
    for views with a rider, and writes JPGs (quality 85, stepped down if a file
    would exceed 350 KB) into docs/design/screenshots/v2/thumbs/.
  * Deterministic: all scene randomness is seeded (mulberry32/hash2) and the
    grain seed is a CRC of the view id (stable with --only).

views.json camera types: "look" (from/to as [x, y, h] or {route, s, side, up}),
"route", "chase" (camera on the rider's tangent, rider centred). Optional:
fov, moodOverrides, rider {route, s}, shiftX/shiftY (off-centre subject via
setViewOffset), sunGap {width, length} (tree clearing between rider and sun).
"""
from __future__ import annotations

import argparse
import base64
import functools
import http.server
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
    from playwright.sync_api import sync_playwright
except ImportError:
    # `uv run --with playwright python shoot.py` only adds playwright; re-exec once with the rest.
    if os.environ.get("V2THUMBS_REEXEC"):
        raise
    os.environ["V2THUMBS_REEXEC"] = "1"
    cmd = ["uv", "run", "-q", "--with", "playwright", "--with", "pillow", "--with", "numpy", "python", __file__, *sys.argv[1:]]
    os.execvp(cmd[0], cmd)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SCRATCH = Path(os.environ.get("THUMBS_SCRATCH", Path.home() / ".hermes/cache/scratch/v2-thumbs"))
THREE_VERSION = "0.170.0"
GPU_FLAGS = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
MAX_BYTES = 350 * 1024


def ensure_three() -> Path:
    env = os.environ.get("THREE_DIR")
    if env:
        return Path(env)
    pkg = SCRATCH / "three" / "node_modules" / "three"
    if not (pkg / "build" / "three.module.js").exists():
        (SCRATCH / "three").mkdir(parents=True, exist_ok=True)
        print(f"fetching three@{THREE_VERSION} into {SCRATCH / 'three'}")
        subprocess.run(["npm", "install", "--prefix", str(SCRATCH / "three"), f"three@{THREE_VERSION}"], check=True)
    return pkg


def serve(root: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):  # noqa: D401
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    handler = functools.partial(Quiet, directory=str(root))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


# Film grade per mood (views.json "grade" overrides keys). warm/cool = split-tone
# multipliers for highlights/shadows, split = how far to push them, halation =
# red-orange glow hugging bright edges, bloom = wide soft glow, contrast = S-curve
# amount, lift = black lift, knee = shoulder start, sat = saturation, chroma =
# lateral colour shift at the corners (fraction of width), soft = edge softness.
GRADES = {
    "golden-hour": dict(warm=(1.07, 1.0, 0.84), cool=(0.88, 0.97, 1.12), split=0.6, halation=0.30, bloom=0.16,
                        contrast=0.16, lift=0.022, knee=0.74, sat=1.06, chroma=0.0016, soft=0.5),
    "late-afternoon": dict(warm=(1.05, 1.0, 0.88), cool=(0.9, 0.98, 1.1), split=0.5, halation=0.2, bloom=0.1,
                           contrast=0.15, lift=0.02, knee=0.76, sat=1.05, chroma=0.0014, soft=0.45),
    "valley-fog": dict(warm=(1.06, 1.0, 0.86), cool=(0.9, 0.97, 1.1), split=0.55, halation=0.24, bloom=0.18,
                       contrast=0.12, lift=0.03, knee=0.72, sat=1.02, chroma=0.0014, soft=0.45),
    "blue-hour": dict(warm=(1.04, 0.98, 0.9), cool=(0.84, 0.94, 1.18), split=0.7, halation=0.35, bloom=0.22,
                      contrast=0.12, lift=0.03, knee=0.7, sat=1.04, chroma=0.0016, soft=0.5),
}
DEFAULT_GRADE = dict(warm=(1.03, 1.0, 0.94), cool=(0.95, 0.99, 1.05), split=0.4, halation=0.12, bloom=0.06,
                     contrast=0.12, lift=0.015, knee=0.78, sat=1.03, chroma=0.0012, soft=0.4)


def _blur(arr: np.ndarray, radius: float, down: int = 4) -> np.ndarray:
    """Gaussian blur of an HxWx3 float image (0..~2) via a downsampled 16-bit-ish proxy."""
    from PIL import ImageFilter

    h, w = arr.shape[:2]
    sw, sh = max(8, w // down), max(8, h // down)
    scale = float(max(arr.max(), 1e-6))
    im = Image.fromarray((np.clip(arr / scale, 0, 1) * 255 + 0.5).astype(np.uint8)).resize((sw, sh), Image.BILINEAR)
    im = im.filter(ImageFilter.GaussianBlur(max(0.5, radius / down)))
    return np.asarray(im.resize((w, h), Image.BILINEAR)).astype(np.float32) / 255.0 * scale


def _radial_scale(ch: np.ndarray, k: float) -> np.ndarray:
    """Scale one channel about the centre by (1 + k) (lateral chromatic shift, strongest at the edges)."""
    h, w = ch.shape
    im = Image.fromarray(ch.astype(np.float32))
    nw, nh = int(round(w * (1 + k))), int(round(h * (1 + k)))
    im = im.resize((nw, nh), Image.BICUBIC)
    x0, y0 = (nw - w) // 2, (nh - h) // 2
    return np.asarray(im.crop((x0, y0, x0 + w, y0 + h))).astype(np.float32)


def _dof(a: np.ndarray, dof: dict, box: dict | None) -> np.ndarray:
    """Screen-space depth-of-field cheat: blur above `farY` (background, ramping
    over `ramp`) and below `nearY` (foreground), keeping the rider box sharp."""
    h, w = a.shape[:2]
    yy = (np.arange(h, dtype=np.float32) / h)[:, None]
    far = np.clip((dof.get("farY", -1) - yy) / dof.get("ramp", 0.12), 0, 1)
    near = np.clip((yy - dof.get("nearY", 2)) / dof.get("ramp", 0.12), 0, 1)
    m = np.broadcast_to(np.maximum(far * dof.get("far", 1.0), near * dof.get("near", 1.0)), (h, w)).copy()
    if box:
        xx = (np.arange(w, dtype=np.float32) / w)[None, :]
        f = 0.02
        inx = np.clip(np.minimum(xx - box["left"] + f, box["right"] + f - xx) / f, 0, 1)
        iny = np.clip(np.minimum(yy - box["top"] + f, box["bottom"] + f - yy) / f, 0, 1)
        m *= 1 - inx * iny
    r = dof.get("radius", 0.004) * w
    b1 = _blur(a, r * 0.5, 1)
    b2 = _blur(a, r, 2)
    m = m[..., None]
    return a * (1 - np.clip(m * 2, 0, 1)) + np.where(m < 0.5, b1 * np.clip(m * 2, 0, 1), b1 * (2 - m * 2) + b2 * (m * 2 - 1))


def finish(png: bytes, w: int, h: int, seed: int, grade: dict | None = None, dof: dict | None = None,
           box: dict | None = None) -> Image.Image:
    """Downsample, then optional fake depth of field, then a filmic grade:
    halation + bloom, S-curve with a soft shoulder, warm-highlight / cool-shadow
    split toning, saturation, lateral chromatic softness toward the corners,
    vignette and luminance-weighted grain."""
    g = {**DEFAULT_GRADE, **(grade or {})}
    img = Image.open(io.BytesIO(png)).convert("RGB")
    if img.size != (w, h):
        img = img.resize((w, h), Image.LANCZOS)
    a = np.asarray(img).astype(np.float32) / 255.0
    if dof:
        a = _dof(a, dof, box)
    lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    # glow sources: only the brightest parts (sky near the sun, specular water, lamps)
    hi = (np.clip((lum - 0.68) / 0.32, 0, 1) ** 1.6)[..., None] * a
    halo = _blur(hi, w * 0.0035, 2) * np.array([1.0, 0.5, 0.24], np.float32)
    glow = _blur(hi, w * 0.022, 4) * np.array([1.0, 0.82, 0.62], np.float32)
    a = 1 - (1 - a) * (1 - np.clip(halo * g["halation"] + glow * g["bloom"], 0, 1))
    # S-curve around mid grey, black lift, soft shoulder
    s3 = a * a * (3 - 2 * a)
    a = a + g["contrast"] * (s3 - a)
    a = g["lift"] + a * (1 - g["lift"])
    k = g["knee"]
    a = np.where(a > k, k + (1 - k) * (1 - np.exp(-(a - k) / (1 - k))), a)
    # split toning keyed on luminance
    lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    t = np.clip((lum - 0.12) / 0.6, 0, 1)
    t = (t * t * (3 - 2 * t))[..., None]
    warm, cool = np.array(g["warm"], np.float32), np.array(g["cool"], np.float32)
    tone = cool * (1 - t) + warm * t
    a = a * (1 + g["split"] * (tone - 1))
    # saturation
    lum = (a @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    a = lum + (a - lum) * g["sat"]
    # lens: lateral chroma + softness toward the corners
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / np.sqrt(2)
    if g["chroma"]:
        a[..., 0] = _radial_scale(a[..., 0], g["chroma"])
        a[..., 2] = _radial_scale(a[..., 2], -g["chroma"])
    if g["soft"]:
        soft = _blur(np.clip(a, 0, 1), w * 0.0012, 1)
        m = (np.clip((r - 0.45) / 0.55, 0, 1) ** 2 * g["soft"])[..., None]
        a = a * (1 - m) + soft * m
    vign = 1.0 - 0.24 * np.clip(r, 0, 1) ** 2.2
    a *= vign[..., None]
    rng = np.random.default_rng(seed)
    grain = rng.normal(0.0, 0.012, (h, w, 1)).astype(np.float32)
    a = a + grain * (0.35 + 0.65 * (1.0 - np.clip(a, 0, 1)))
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def save_jpg(img: Image.Image, path: Path) -> int:
    for q in (85, 82, 79, 76, 73, 70):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True, progressive=True, subsampling="4:2:0")
        if buf.tell() <= MAX_BYTES or q == 70:
            path.write_bytes(buf.getvalue())
            return q
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated view ids")
    ap.add_argument("--ss", type=float, default=2, help="supersampling factor")
    ap.add_argument("--out", default=str(REPO / "docs/design/screenshots/v2/thumbs"))
    ap.add_argument("--world", default="perugia")
    ap.add_argument("--timeout", type=int, default=420)
    args = ap.parse_args()

    three = ensure_three()
    views = json.loads((HERE / "views.json").read_text())
    only = {v for v in args.only.split(",") if v}
    if only:
        views = [v for v in views if v["id"] in only]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    root = Path(tempfile.mkdtemp(prefix="v2thumbs-", dir=os.environ.get("TMPDIR")))
    (root / "tool").symlink_to(HERE)
    (root / "worlds").symlink_to(REPO / "public/worlds")
    (root / "three").symlink_to(three)
    httpd, port = serve(root)
    chromium = os.environ.get("CHROMIUM", "/usr/sbin/chromium")
    failures = 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chromium, headless=True, args=GPU_FLAGS)
            for i, v in enumerate(views):
                t = time.time()
                w, h = v["width"], v["height"]
                page = browser.new_page(viewport={"width": min(w, 1920), "height": min(h, 1080)})
                page.on("console", lambda m: print("   ", m.text) if m.type in ("error", "warning") else None)
                url = f"http://127.0.0.1:{port}/tool/index.html?view={v['id']}&ss={args.ss}&world=../worlds/{args.world}/"
                page.goto(url)
                page.wait_for_function("window.__thumbDone === true || !!window.__thumbError", timeout=args.timeout * 1000)
                err = page.evaluate("window.__thumbError || null")
                logs = page.evaluate("window.__thumbLog || []")
                for line in logs:
                    print("   ", line)
                if err:
                    print(f"FAIL {v['id']}: {err}")
                    failures += 1
                    page.close()
                    continue
                data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
                png = base64.b64decode(data.split(",", 1)[1])
                grade = {**GRADES.get(v.get("mood", ""), {}), **v.get("grade", {})}
                box = page.evaluate("window.__riderBox || null")
                img = finish(png, w, h, seed=zlib.crc32(v["id"].encode()), grade=grade, dof=v.get("dof"), box=box)
                if box:
                    print("    rider box (frac): top %.3f bottom %.3f left %.3f right %.3f -> height %.1f%%, centre x %.1f%%" % (
                        box["top"], box["bottom"], box["left"], box["right"], (box["bottom"] - box["top"]) * 100, (box["left"] + box["right"]) * 50))
                dest = out / v["out"]
                q = save_jpg(img, dest)
                print(f"ok {v['id']} -> {dest} ({dest.stat().st_size // 1024} KB, q{q}, {time.time() - t:.1f}s)")
                page.close()
            browser.close()
    finally:
        httpd.shutdown()
        shutil.rmtree(root, ignore_errors=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
