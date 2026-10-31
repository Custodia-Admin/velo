"""Time-series probe of the ride view: per 2 s window, rAF fps plus WebGL
program creations, readPixels, scene.sampleHeight calls, primitive/entity
counts and JS heap. Shows what grows while the frame rate falls.

Usage: xvfb-run -a -s "-screen 0 2600x1700x24" uv run --with playwright \\
         python scripts/perf-probe.py <out.json> [base] [route-id]
Env: VIEW=1080|1600, QUALITY, DURATION_S (40), PATCH_JS (extra init script)
"""
import json, os, pathlib, sys
from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4173"
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-lugano-melide"
VIEW = os.environ.get("VIEW", "1080")
QUALITY = os.environ.get("QUALITY")
DURATION_S = int(os.environ.get("DURATION_S", "40"))
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
window.__d = []; window.__c = {createProgram: 0, deleteProgram: 0, readPixels: 0, sampleHeight: 0, createBuffer: 0, draw: 0};
(() => { let last = 0; const t = (n) => { if (last) window.__d.push(n - last); last = n; requestAnimationFrame(t); }; requestAnimationFrame(t); })();
for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
  if (!C) continue;
  for (const k of ['createProgram', 'deleteProgram', 'readPixels', 'createBuffer']) {
    const o = C.prototype[k]; C.prototype[k] = function (...a) { window.__c[k]++; return o.apply(this, a); };
  }
  for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const o = C.prototype[k]; if (o) C.prototype[k] = function (...a) { window.__c.draw++; return o.apply(this, a); };
  }
}
const iv = setInterval(() => {
  const C = window.Cesium; if (!C || !C.CesiumWidget) return; clearInterval(iv);
  const sh = C.Scene.prototype.sampleHeight;
  C.Scene.prototype.sampleHeight = function (...a) { window.__c.sampleHeight++; return window.__noSampleHeight ? undefined : sh.apply(this, a); };
  const r = C.CesiumWidget.prototype.render;
  C.CesiumWidget.prototype.render = function () { if (!this.isDestroyed() && this.container && this.container.offsetWidth > 800) window.__w = this; return r.call(this); };
}, 20);
""" % json.dumps(state) + os.environ.get("PATCH_JS", "")

SNAP = """() => {
  const d = window.__d.splice(0); const c = {...window.__c}; for (const k in window.__c) window.__c[k] = 0;
  let prims = 0; const walk = (col) => { for (let i = 0; i < col.length; i++) { const p = col.get(i); prims++; if (p && typeof p.length === 'number' && p.get) walk(p); } };
  const w = window.__w; let ents = null, tiles = null, rs = null;
  if (w && !w.isDestroyed()) { walk(w.scene.primitives); ents = w.entities.values.length;
    const g = w.scene.globe; tiles = { globeLoaded: g.tilesLoaded };
    for (let i = 0; i < w.scene.primitives.length; i++) { const p = w.scene.primitives.get(i); if (p instanceof Cesium.Cesium3DTileset) { const s = p.statistics; (tiles.ts = tiles.ts || []).push([p.show, s.numberOfPendingRequests, s.numberOfTilesProcessing, Math.round(p.totalMemoryUsageInBytes / 1e6)]); } }
    rs = w.resolutionScale; }
  const sp = document.querySelector('[aria-label^="Speed:"]')?.getAttribute('aria-label');
  return { fps: d.length ? +(d.length / (d.reduce((a, b) => a + b, 0) / 1000)).toFixed(1) : 0, maxMs: d.length ? Math.round(Math.max(...d)) : 0,
    calls: c, prims, ents, tiles, heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6), speed: sp };
}"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/sbin/chromium", headless=os.environ.get("HEADLESS") == "1", args=GPU)
    ctx = b.new_context(**VIEWPORTS[VIEW], color_scheme="dark", service_workers="block")
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    pg.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_selector(f"[data-scenic-route='{route_id}']", timeout=30000)
    pg.evaluate(f"() => document.querySelector(\"[data-scenic-route='{route_id}']\").click()")
    pg.wait_for_url("**/ride**", timeout=20000)
    pg.evaluate(SNAP)
    rows = []
    for k in range(DURATION_S // 2):
        pg.wait_for_timeout(2000)
        r = pg.evaluate(SNAP)
        r["t"] = 2 * (k + 1)
        rows.append(r)
        print(json.dumps(r), flush=True)
    b.close()
out.write_text(json.dumps(rows, indent=1))
