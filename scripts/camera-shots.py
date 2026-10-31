"""Camera framing shots: every camera mode at the given distance, 1440 and 390.

For each mode, seeds settings (cameraMode, cameraDistance), starts a Demo Mode
ride from Home, waits SETTLE_MS, then saves the full UI shot plus a
scene-only shot (UI hidden) and prints the rider's on-screen position and
height (window.__veloRideDebug) as a fraction of the viewport height.

Usage: uv run --with playwright python scripts/camera-shots.py <out-dir> [base] [route-id]
Env: MODES (comma list; default chase,firstPerson,overhead,sideTracking,cinematic),
     DISTANCE (close|standard|far|overview; default standard), VIEWS (1440,390),
     SETTLE_MS (20000), PREFIX (default "cam")
"""
import json, os, pathlib, sys
from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4173"
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-lugano-melide"
MODES = os.environ.get("MODES", "chase,firstPerson,overhead,sideTracking,cinematic").split(",")
DISTANCE = os.environ.get("DISTANCE", "standard")
VIEWS = os.environ.get("VIEWS", "1440,390").split(",")
SETTLE_MS = int(os.environ.get("SETTLE_MS", "20000"))
PREFIX = os.environ.get("PREFIX", "cam")
GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
VP = {"1440": (1440, 900), "390": (390, 844)}

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/sbin/chromium", args=GPU)
    for mode in MODES:
        for vp in VIEWS:
            w, h = VP[vp]
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="dark",
                                service_workers="block", is_mobile=vp == "390", has_touch=vp == "390")
            state = {"liveWeatherEnabled": False, "cameraMode": mode, "cameraDistance": DISTANCE}
            ctx.add_init_script(
                "localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));"
                "localStorage.setItem('globeride.settings.v1', JSON.stringify({state:%s,version:1}));" % json.dumps(state))
            pg = ctx.new_page()
            pg.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_selector(f"[data-scenic-route='{route_id}']", timeout=30000)
            pg.evaluate(f"() => document.querySelector(\"[data-scenic-route='{route_id}']\").click()")
            pg.wait_for_url("**/ride**", timeout=20000)
            pg.wait_for_timeout(SETTLE_MS)
            dbg = pg.evaluate("() => window.__veloRideDebug ? window.__veloRideDebug() : null")
            stem = f"{PREFIX}-{DISTANCE}-{mode}-{vp}"
            pg.screenshot(path=str(out / f"{stem}.png"))
            pg.add_style_tag(content="body *{visibility:hidden !important} canvas{visibility:visible !important}")
            pg.screenshot(path=str(out / f"{stem}-scene.png"))
            frac = None
            if dbg and dbg.get("riderHeightPx") is not None:
                frac = round(dbg["riderHeightPx"] / h, 3)
            print(stem, "rider", dbg and dbg.get("riderScreen"), "heightPx", dbg and dbg.get("riderHeightPx"),
                  "frac", frac, "camH-ground", dbg and round(dbg["cameraHeight"] - dbg["groundEle"], 1), flush=True)
            ctx.close()
    b.close()
