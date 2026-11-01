"""World-renderer ride check: Home -> a Perugia scenic route -> /ride, token-free.

usage: uv run --with playwright python scripts/world-ride-check.py <out-dir> [base] [route-id]
env: W/H viewport (1920x1080), QUALITY (low|medium|high), SETTLE_S (8), MEASURE_S (12),
     GL=swiftshader for CI-like software GL (default: real GPU via ANGLE/Vulkan),
     CAMERA (chase...), DIST (close|standard|far|overview), SHOTS=1 for screenshots,
     PW_CHROMIUM executable (default /usr/sbin/chromium).

Prints JSON: renderer, request counts (cesium.com, Cesium chunks), debug numbers
(window.__veloRideDebug: fps, p95, draw calls, rider/ground gap, camera clearance).
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1] if len(sys.argv) > 1 else "."
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5181"
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-perugia-tiber-park"
W = int(os.environ.get("W", 1920))
H = int(os.environ.get("H", 1080))
QUALITY = os.environ.get("QUALITY", "medium")
SETTLE = float(os.environ.get("SETTLE_S", 8))
MEASURE = float(os.environ.get("MEASURE_S", 12))
GL = os.environ.get("GL", "gpu")
os.makedirs(out, exist_ok=True)

gl_args = (
    ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    if GL == "swiftshader"
    else ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
)
settings_patch = {"graphicsQuality": QUALITY}
if os.environ.get("CAMERA"):
    settings_patch["cameraMode"] = os.environ["CAMERA"]
if os.environ.get("DIST"):
    settings_patch["cameraDistance"] = os.environ["DIST"]

INIT = """
localStorage.removeItem('globeride.cesiumIonToken');
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
const PATCH = %s;
const KEY = Object.keys(localStorage).find((k) => /settings/i.test(k) && localStorage.getItem(k).includes('riderMassKg'));
const key = KEY || 'globeride.settings.v1';
let cur = {};
try { cur = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
cur.state = Object.assign(cur.state || {}, PATCH);
cur.version = 1;
localStorage.setItem(key, JSON.stringify(cur));
""" % json.dumps(settings_patch)

result = {"route": route_id, "quality": QUALITY, "viewport": [W, H], "gl": GL}
with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
        args=gl_args,
    )
    page = browser.new_page(viewport={"width": W, "height": H})
    cesium_requests, cesium_chunks, errors, console = [], [], [], []
    page.on("request", lambda r: (
        cesium_requests.append(r.url) if "cesium.com" in r.url else None,
        cesium_chunks.append(r.url) if (r.resource_type == "script" and ("cesium" in r.url.lower())) else None,
    ))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: console.append(m.text) if m.type in ("error", "warning") else None)
    page.add_init_script(INIT)
    page.goto(base + "/app")
    card = page.locator(f'[data-scenic-route="{route_id}"]').first
    card.wait_for(state="visible", timeout=60000)
    card.evaluate("el => el.click()")
    page.wait_for_url("**/ride**", timeout=60000)
    page.wait_for_selector("[data-renderer]", state="attached", timeout=60000)
    t0 = time.time()
    page.wait_for_function("() => typeof window.__veloRideDebug === 'function'", timeout=90000)
    result["worldReadyS"] = round(time.time() - t0, 1)
    time.sleep(SETTLE)
    result["renderer"] = page.get_attribute("[data-renderer]", "data-renderer")
    samples = []
    end = time.time() + MEASURE
    while time.time() < end:
        time.sleep(2)
        samples.append(page.evaluate("() => window.__veloRideDebug()"))
    result["debug"] = samples[-1]
    result["fpsSamples"] = [s.get("fps") for s in samples]
    result["p95Samples"] = [s.get("p95Ms") for s in samples]
    result["speed"] = page.evaluate("() => document.querySelector('[aria-label^=\"Speed:\"]')?.getAttribute('aria-label')")
    result["visibility"] = page.evaluate("() => document.visibilityState")
    if os.environ.get("SHOTS", "1") == "1":
        page.screenshot(path=os.path.join(out, f"ride-{QUALITY}-{W}x{H}.png"))
        page.add_style_tag(content="body *{visibility:hidden} canvas{visibility:visible}")
        page.screenshot(path=os.path.join(out, f"scene-{QUALITY}-{W}x{H}.png"))
    result["cesiumComRequests"] = len(cesium_requests)
    result["cesiumChunkRequests"] = cesium_chunks[:5]
    result["pageErrors"] = errors[:5]
    result["consoleErrors"] = console[:8]
    browser.close()
print(json.dumps(result, indent=1))
