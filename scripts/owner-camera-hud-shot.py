"""Owner-camera before/after for the compact ride HUD (owner report, Assisi, 2 Nov 2026).

The owner rode Assisi valley at night (1280x658 @2, the rider held ~220 m in) and found the HUD
"enormous ... all crammed to the top". This shoots that camera on a build and measures the ride UI
(scripts/v2-build-shots/hud_area.py: sum of the visible HUD surfaces' rects / viewport).

usage: uv run --with playwright python scripts/owner-camera-hud-shot.py <out.png> <base>
env: SPOT=220, TIME=night, WEATHER=overcast, SIZE=1280x648@2 (the owner's laptop gate; his 2 Nov shot was 1280x658), OPEN=0 (1: tap the details toggle first),
     ERROR=0 (1: the trainer link fails as in the owner's shot, "Connection failed"; needs a dev server)

Writes <out.png> and <out>.json ({hudArea, fps, errors}). Compose the before/after with
scripts/owner-camera-hud-compare.py.
"""
import json
import os
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "v2-build-shots"))
from hud_area import HUD_AREA, budget  # noqa: E402
from scenic_home import ride_scenic_route  # noqa: E402

out = sys.argv[1]
base = sys.argv[2]
SPOT = float(os.environ.get("SPOT", "220"))
TIME = os.environ.get("TIME", "night")
WEATHER = os.environ.get("WEATHER", "overcast")
SIZE = os.environ.get("SIZE", "1280x648@2")
OPEN = os.environ.get("OPEN", "0") == "1"
ERROR = os.environ.get("ERROR", "0") == "1"

FAIL = """async () => {
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  useRideStore.getState().setConnection('error', { error: 'Connection failed', code: 'connect-failed' });
}"""

INIT = """
localStorage.removeItem('globeride.cesiumIonToken');
localStorage.setItem('velo.debug.three', '1');
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
let cur = {}; try { cur = JSON.parse(localStorage.getItem('globeride.settings.v1') || '{}'); } catch {}
cur.state = Object.assign(cur.state || {}, { graphicsQuality: 'medium' }); cur.version = 1;
localStorage.setItem('globeride.settings.v1', JSON.stringify(cur));
"""

RAF = """(secs) => new Promise(res => { const ts = []; const t0 = performance.now();
  function f(t) { ts.push(t); if (t - t0 < secs * 1000) requestAnimationFrame(f); else
    res(Math.round(10 * (ts.length - 1) * 1000 / (ts[ts.length-1] - ts[0])) / 10); }
  requestAnimationFrame(f); })"""

dims, _, dpr = SIZE.partition("@")
W, H = (int(v) for v in dims.split("x"))
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
                          args=["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"])
    ctx = b.new_context(viewport={"width": W, "height": H}, device_scale_factor=float(dpr or 1), service_workers="block")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.add_init_script(INIT)
    page.goto(base + "/app")
    ride_scenic_route(page, "scenic-assisi-valley", timeout=90000)
    page.wait_for_url("**/ride**", timeout=60000)
    page.wait_for_function("() => window.__veloWorldLight && window.__veloThree", timeout=120000)
    time.sleep(4)
    page.evaluate("(a) => window.__veloWorldLight.set({ time: a[0], weather: a[1] })", [TIME, WEATHER])
    if OPEN:
        page.locator("[data-testid=ride-details-toggle]").evaluate("el => el.click()")
    page.evaluate("(d) => window.__veloWorldLight.place(d)", SPOT)
    if ERROR:
        page.evaluate(FAIL)
    time.sleep(8)
    page.mouse.move(5, 5)
    time.sleep(0.5)
    page.screenshot(path=out)
    area = page.evaluate(HUD_AREA)
    fps = page.evaluate(RAF, 3)
    ctx.close()
    b.close()
meta = {"base": base, "spot": SPOT, "time": TIME, "weather": WEATHER, "size": SIZE, "open": OPEN, "error": ERROR,
        "hudArea": area, "fps": fps, "errors": errs[:5]}
pathlib.Path(out).with_suffix(".json").write_text(json.dumps(meta, indent=1) + "\n")
print(out, "sumPct", area["sumPct"], "budget", budget(area) if not OPEN else "-", "unionPct", area["unionPct"], "topmostPct", area["topmostPct"], "fps", fps,
      "errors", errs[:2], flush=True)
print("  surfaces", [(r["name"][:32], r["w"], r["h"]) for r in area["rects"]], flush=True)
