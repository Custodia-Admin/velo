"""Calibrate the GPU/harness with bare Cesium (scripts/perf-bare.html): the
ride view's terrain + imagery + photoreal mesh without any Velo scene.

Copies perf-bare.html into the served dist dir, then for each config in
CONFIGS loads it fresh, waits SETTLE_S and reports Cesium frame times for
WINDOW_S. The ion token is read from .env.local and injected via an init
script; it is never printed.

Usage: uv run --with playwright python scripts/perf-bare.py <served-dist-dir> [base]
Env: VIEW=1080|1600, SETTLE_S (15), WINDOW_S (8),
     CONFIGS="label:query;label:query" (default: a standard set)
"""
import json, os, pathlib, re, shutil, sys
from playwright.sync_api import sync_playwright

dist = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4173"
ROOT = pathlib.Path(__file__).resolve().parent.parent
shutil.copy(ROOT / "scripts/perf-bare.html", dist / "perf-bare.html")
env = (ROOT / ".env.local").read_text() if (ROOT / ".env.local").exists() else ""
m = re.search(r"^VITE_CESIUM_ION_TOKEN\s*=\s*['\"]?([^'\"\n]+)", env, re.M)
token = m.group(1).strip() if m else ""
VIEW = os.environ.get("VIEW", "1080")
SETTLE_S = float(os.environ.get("SETTLE_S", "15"))
WINDOW_S = float(os.environ.get("WINDOW_S", "8"))
GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
VIEWPORTS = {
    "1080": dict(viewport={"width": 1920, "height": 1080}, device_scale_factor=1),
    "1600": dict(viewport={"width": 1463, "height": 914}, device_scale_factor=1.75),
}
DEFAULT = (
    "empty:terrain=0&imagery=0&photoreal=0;"
    "terrain+bing:photoreal=0;"
    "terrain+bing still:photoreal=0&move=0;"
    "photoreal:;"
    "photoreal still:move=0;"
    "photoreal msaa1:msaa=1;"
    "photoreal res0.5:res=0.5;"
    "photoreal sse24 gsse3:sse=24&gsse=3"
)
CONFIGS = [c.split(":", 1) for c in os.environ.get("CONFIGS", DEFAULT).split(";") if c]

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/sbin/chromium", headless=True, args=GPU)
    for label, qs in CONFIGS:
        ctx = b.new_context(**VIEWPORTS[VIEW], service_workers="block")
        ctx.add_init_script("window.__ION = %s;" % json.dumps(token))
        pg = ctx.new_page()
        pg.goto(f"{base}/perf-bare.html?{qs}", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_function("() => window.__ready === true", timeout=60000)
        pg.wait_for_timeout(int(SETTLE_S * 1000))
        pg.evaluate("() => { window.__frames.length = 0 }")
        pg.wait_for_timeout(int(WINDOW_S * 1000))
        d = pg.evaluate("() => window.__frames.splice(0)")
        s = sorted(d) or [0]
        fps = round(len(d) / (sum(d) / 1000), 1) if d else 0
        print(f"{label:24s} fps {fps:5.1f}  p50 {s[len(s)//2]:6.1f}  p95 {s[int(len(s)*0.95)]:6.1f} ms", flush=True)
        ctx.close()
    b.close()
