"""P1.4 rework measurement: HUD-on fps (flat HUD vs old glass vs canvas-only), backdrop elements, rider framing.

usage: uv run --with playwright python scripts/world-hud-fps.py <out> <base> [route]
env: QUALITIES=medium,low ROUNDS=3 WIN_S=5 W/H LONG_S=90 (0 = skip the long run)
Modes per round (in a fixed rotation, 1 s settle each):
  hud        - the shipped HUD (.hud-flat on the ride root: no backdrop-filter)
  hud-glass  - same HUD with .hud-flat removed (the old blurred glass) for A/B
  canvas     - HUD hidden, canvas only
The long run is HUD-on (shipped) only.
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

out = sys.argv[1]; base = sys.argv[2]
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-perugia-tiber-park"
W = int(os.environ.get("W", 1920)); H = int(os.environ.get("H", 1080))
QUALS = os.environ.get("QUALITIES", "medium,low").split(",")
ROUNDS = int(os.environ.get("ROUNDS", 3)); WIN = float(os.environ.get("WIN_S", 5))
LONG = float(os.environ.get("LONG_S", 90))
os.makedirs(out, exist_ok=True)

RAF = """(secs) => new Promise(res => { const ts = []; const t0 = performance.now();
  function f(t) { ts.push(t); if (t - t0 < secs * 1000) requestAnimationFrame(f); else {
    const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i-1]); d.sort((a,b)=>a-b);
    res({ fps: Math.round(10 * (ts.length - 1) * 1000 / (ts[ts.length-1] - ts[0])) / 10,
          p95: Math.round(10 * d[Math.floor(d.length * 0.95)]) / 10, worst: Math.round(d[d.length-1]),
          over20: Math.round(1000 * d.filter(x => x > 20).length / d.length) / 10 }); } }
  requestAnimationFrame(f); })"""

LONGRUN = """(dur) => new Promise(res => {
  const t0 = performance.now(); const samples = []; let frames = 0; let last = t0; const deltas = [];
  function f(t) { frames++; deltas.push(t - last); last = t;
    if (frames % 15 === 0) { const d = window.__veloRideDebug(); samples.push({ t: Math.round(t - t0), d: d.distance, s: d.riderScreen }); }
    if (t - t0 < dur * 1000) requestAnimationFrame(f); else res({ frames, ms: t - t0, deltas, samples }); }
  requestAnimationFrame(f); })"""

BACKDROP = """() => [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e);
  return (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none'); })
  .map(e => (e.getAttribute('class') || e.tagName).slice(0, 90))"""

def set_mode(page, mode):
    page.evaluate("""(m) => { document.getElementById('__rv')?.remove();
      const root = document.querySelector('[data-renderer]')?.parentElement;
      const flatRoot = document.querySelector('.hud-flat') || window.__flatRoot;
      if (flatRoot) { window.__flatRoot = flatRoot; flatRoot.classList.toggle('hud-flat', m !== 'hud-glass'); }
      if (m === 'canvas') { const s = document.createElement('style'); s.id = '__rv';
        s.textContent = 'body *{visibility:hidden!important} canvas{visibility:visible!important}'; document.head.appendChild(s); } }""", mode)

def init(q):
    return """
localStorage.removeItem('globeride.cesiumIonToken');
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
let cur = {}; try { cur = JSON.parse(localStorage.getItem('globeride.settings.v1') || '{}'); } catch {}
cur.state = Object.assign(cur.state || {}, { graphicsQuality: '%s' }); cur.version = 1;
localStorage.setItem('globeride.settings.v1', JSON.stringify(cur));
""" % q

res = {"route": route_id, "viewport": [W, H], "base": base, "loadavg_start": os.getloadavg()}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
                          args=["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"])
    for q in QUALS:
        ctx = b.new_context(viewport={"width": W, "height": H}, service_workers="block")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(init(q))
        page.goto(base + "/app")
        card = page.locator(f'[data-scenic-route="{route_id}"]').first
        card.wait_for(state="visible", timeout=60000)
        card.evaluate("el => el.click()")
        page.wait_for_url("**/ride**", timeout=60000)
        page.wait_for_function("() => typeof window.__veloRideDebug === 'function' && typeof window.__veloPerf === 'function'", timeout=90000)
        time.sleep(8)
        r = {"renderer": page.get_attribute("[data-renderer]", "data-renderer"),
             "bundle": page.evaluate("() => [...document.querySelectorAll('script[src]')].map(s => s.src.split('/').pop())"),
             "gpu": page.evaluate("""() => { const gl = document.createElement('canvas').getContext('webgl2');
                 const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }"""),
             "dpr": page.evaluate("() => window.__veloRideDebug().dpr"),
             "noTokenBanner": page.get_by_text("Add a free Cesium ion token").count()}
        set_mode(page, "hud"); time.sleep(0.5)
        r["backdropHud"] = page.evaluate(BACKDROP)
        page.screenshot(path=f"{out}/{q}-hud.png")
        set_mode(page, "hud-glass"); time.sleep(0.5)
        r["backdropGlass"] = len(page.evaluate(BACKDROP))
        page.screenshot(path=f"{out}/{q}-hud-glass.png")
        rounds = []
        for rd in range(ROUNDS):
            for mode in ("hud", "hud-glass", "canvas"):
                set_mode(page, mode); time.sleep(1.0)
                raf = page.evaluate(RAF, WIN)
                rounds.append({"round": rd, "mode": mode, **raf, "load1": round(os.getloadavg()[0], 2)})
                print(q, rd, mode, raf, flush=True)
        set_mode(page, "hud")
        r["rounds"] = rounds
        if LONG > 0:
            time.sleep(1)
            lr = page.evaluate(LONGRUN, LONG)
            d = lr["deltas"][1:]
            win, acc, n = [], 0, 0
            for x in d:
                acc += x; n += 1
                if acc >= 5000: win.append(round(n * 1000 / acc, 1)); acc, n = 0, 0
            S = lr["samples"]
            inframe = [s for s in S if s["s"] and 0 <= s["s"][0] <= W and 0 <= s["s"][1] <= H]
            r["long"] = {"durS": round(lr["ms"] / 1000, 1), "avgFps": round(lr["frames"] * 1000 / lr["ms"], 1),
                         "fps5s": win, "pctOver20ms": round(100 * sum(1 for x in d if x > 20) / len(d), 1),
                         "riderInFramePct": round(100 * len(inframe) / max(1, len(S)), 1),
                         "riderXRange": [min(s["s"][0] for s in inframe), max(s["s"][0] for s in inframe)] if inframe else None,
                         "distRange": [round(S[0]["d"]), round(S[-1]["d"])], "load1": round(os.getloadavg()[0], 2)}
            print(q, "long", r["long"], flush=True)
        r["pageErrors"] = errs[:5]
        res[q] = r
        ctx.close()
    b.close()
res["loadavg_end"] = os.getloadavg()
json.dump(res, open(f"{out}/result.json", "w"), indent=1)
print("WROTE", f"{out}/result.json")
