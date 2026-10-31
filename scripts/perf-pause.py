"""Ride vs paused frame rate: is the cost streaming (moving camera) or drawing?

Starts a Demo Mode ride, measures while riding, pauses (Space) and waits for
tiles to settle, measures the still scene, then resumes and measures again.
Reads window.__veloPerf() when present (perf overlay build) plus an
independent rAF sampler.

Usage: uv run --with playwright python scripts/perf-pause.py [base] [route-id]
Env: VIEW=1080|1600, QUALITY, BLOCK_ASSETS (ion ids to fail, e.g. 2275207,96188), HEADLESS=1 (default), RIDE_S (20), SETTLE_S (20), WINDOW_S (6)
"""
import json, os, sys
from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173"
route_id = sys.argv[2] if len(sys.argv) > 2 else "scenic-lugano-melide"
VIEW = os.environ.get("VIEW", "1080")
QUALITY = os.environ.get("QUALITY")
RIDE_S = float(os.environ.get("RIDE_S", "20"))
SETTLE_S = float(os.environ.get("SETTLE_S", "20"))
WINDOW_S = float(os.environ.get("WINDOW_S", "6"))
GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
VIEWPORTS = {
    "1080": dict(viewport={"width": 1920, "height": 1080}, device_scale_factor=1),
    "1600": dict(viewport={"width": 1463, "height": 914}, device_scale_factor=1.75),
}
state = {"liveWeatherEnabled": False, **json.loads(os.environ.get("EXTRA_LS", "{}"))}
if QUALITY:
    state["graphicsQuality"] = QUALITY
INIT = """
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
localStorage.setItem('globeride.settings.v1', JSON.stringify({state:%s,version:1}));
window.__d = [];
(() => { let last = 0; const t = (n) => { if (last) window.__d.push(n - last); last = n; requestAnimationFrame(t); }; requestAnimationFrame(t); })();
""" % json.dumps(state)


def measure(pg, label):
    pg.evaluate("() => { window.__d.length = 0 }")
    pg.wait_for_timeout(int(WINDOW_S * 1000))
    d = pg.evaluate("() => window.__d.splice(0)")
    perf = pg.evaluate("() => window.__veloPerf ? window.__veloPerf() : null")
    s = sorted(d) or [0]
    raf = {"fps": round(len(d) / (sum(d) / 1000), 1) if d else 0, "p50": round(s[len(s) // 2], 1), "p95": round(s[int(len(s) * 0.95)], 1)}
    print(f"{label:10s} raf {raf}  perf {json.dumps({k: perf[k] for k in ('fps', 'avgMs', 'p95Ms', 'jankPct', 'tiles')}) if perf else None}", flush=True)
    return {"raf": raf, "perf": perf}


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/sbin/chromium", headless=os.environ.get("HEADLESS", "1") == "1", args=GPU)
    ctx = b.new_context(**VIEWPORTS[VIEW], color_scheme="dark", service_workers="block")
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    for asset in filter(None, os.environ.get("BLOCK_ASSETS", "").split(",")):
        pg.route(f"**/v1/assets/{asset}/endpoint**", lambda route: route.abort())
    pg.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_selector(f"[data-scenic-route='{route_id}']", timeout=30000)
    pg.evaluate(f"() => document.querySelector(\"[data-scenic-route='{route_id}']\").click()")
    pg.wait_for_url("**/ride**", timeout=20000)
    pg.wait_for_timeout(int(RIDE_S * 1000))
    out = {"riding": measure(pg, "riding")}
    pg.keyboard.press("Space")
    pg.wait_for_timeout(int(SETTLE_S * 1000))
    out["paused"] = measure(pg, "paused")
    pg.keyboard.press("Space")
    pg.wait_for_timeout(3000)
    out["resumed"] = measure(pg, "resumed")
    b.close()
print(json.dumps({k: v["raf"] for k, v in out.items()}))
