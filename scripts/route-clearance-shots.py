"""Reference shots for the route-vs-buildings / landmark-pin fix (owner report, Assisi valley).

usage: uv run --with playwright python scripts/route-clearance-shots.py <out> <base> [prefix]
env: ROUTE (default scenic-assisi-valley), SPOTS=220,7240 (route metres to hold the rider at),
     TIMES=night,noon, WEATHER=overcast, SIZES=1440x900,390x844,1280x658@2, HIDE_HUD=0

Holds the rider at each spot with window.__veloWorldLight.place(), pins time and weather,
waits for the world to settle, and shoots the page. Also writes <out>/<prefix>meta.json
with the landmark sprites' screen rects (label overlap check) and fps over 3 s.
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright
from scenic_home import ride_scenic_route

out = sys.argv[1]; base = sys.argv[2]
prefix = sys.argv[3] if len(sys.argv) > 3 else ""
ROUTE = os.environ.get("ROUTE", "scenic-assisi-valley")
SPOTS = [float(s) for s in os.environ.get("SPOTS", "220,7240").split(",")]
TIMES = os.environ.get("TIMES", "night,noon").split(",")
WEATHER = os.environ.get("WEATHER", "overcast")
SIZES = os.environ.get("SIZES", "1440x900,390x844,1280x658@2").split(",")
HIDE_HUD = os.environ.get("HIDE_HUD", "0") == "1"
os.makedirs(out, exist_ok=True)

INIT = """
localStorage.removeItem('globeride.cesiumIonToken');
localStorage.setItem('velo.debug.three', '1');
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
let cur = {}; try { cur = JSON.parse(localStorage.getItem('globeride.settings.v1') || '{}'); } catch {}
cur.state = Object.assign(cur.state || {}, { graphicsQuality: 'medium' }); cur.version = 1;
localStorage.setItem('globeride.settings.v1', JSON.stringify(cur));
"""

# Screen rects of every visible landmark sprite (labels before the fix, pins after).
SPRITES = """() => { const t = window.__veloThree; if (!t) return null; const { scene, camera, gl } = t;
  const g = scene.getObjectByName('landmarks'); if (!g) return [];
  const W = gl.domElement.clientWidth, H = gl.domElement.clientHeight; const out = [];
  const v = camera.position.clone();
  g.traverse(o => { if (!o.isSprite || !o.visible || o.material.opacity < 0.2) return;
    const p = o.position.clone().project(camera); if (p.z > 1 || p.z < -1) return;
    const d = camera.position.distanceTo(o.position);
    const hpx = o.scale.y / (2 * Math.tan(camera.fov * Math.PI / 360) * d) * H;
    const wpx = hpx * o.scale.x / o.scale.y;
    const cx = (p.x + 1) / 2 * W, by = (1 - p.y) / 2 * H;
    out.push({ name: o.name, x: cx - wpx * o.center.x, y: by - hpx * (1 - o.center.y), w: wpx, h: hpx, opacity: o.material.opacity }); });
  return out; }"""

RAF = """(secs) => new Promise(res => { const ts = []; const t0 = performance.now();
  function f(t) { ts.push(t); if (t - t0 < secs * 1000) requestAnimationFrame(f); else
    res(Math.round(10 * (ts.length - 1) * 1000 / (ts[ts.length-1] - ts[0])) / 10); }
  requestAnimationFrame(f); })"""


def overlaps(rects):
    n = 0
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            a, b = rects[i], rects[j]
            if a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]:
                n += 1
    return n


meta = {"base": base, "route": ROUTE, "shots": []}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
                          args=["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"])
    for size in SIZES:
        dims, _, dpr = size.partition("@")
        W, H = (int(v) for v in dims.split("x"))
        ctx = b.new_context(viewport={"width": W, "height": H}, device_scale_factor=float(dpr or 1), service_workers="block")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(INIT)
        page.goto(base + "/app")
        ride_scenic_route(page, ROUTE, timeout=60000)
        page.wait_for_url("**/ride**", timeout=60000)
        page.wait_for_function("() => window.__veloWorldLight && window.__veloThree", timeout=90000)
        time.sleep(4)
        if HIDE_HUD:
            page.add_style_tag(content="body *{visibility:hidden!important} canvas{visibility:visible!important}")
        for tm in TIMES:
            page.evaluate("(a) => window.__veloWorldLight.set({ time: a[0], weather: a[1] })", [tm, WEATHER])
            for s in SPOTS:
                page.evaluate("(d) => window.__veloWorldLight.place(d)", s)
                time.sleep(6)
                name = f"{prefix}{ROUTE.replace('scenic-', '')}-{int(s)}-{tm}-{W}x{H}.png"
                page.screenshot(path=os.path.join(out, name))
                rects = page.evaluate(SPRITES) or []
                fps = page.evaluate(RAF, 3)
                meta["shots"].append({"file": name, "spot": s, "time": tm, "size": [W, H], "sprites": rects,
                                      "spriteOverlaps": overlaps(rects), "fps": fps})
                print(name, "sprites", len(rects), "overlaps", overlaps(rects), "fps", fps, flush=True)
        meta.setdefault("errors", []).extend(errs)
        ctx.close()
    b.close()
with open(os.path.join(out, f"{prefix}meta.json"), "w") as f:
    json.dump(meta, f, indent=1)
