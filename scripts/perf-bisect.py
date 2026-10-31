"""Bisect the ride scene's frame cost by toggling one knob at a time at runtime.

Grabs the live CesiumWidget by patching CesiumWidget.prototype.render (no app
change), starts a Demo Mode ride, lets tiles settle, then measures rAF fps for
WINDOW_S seconds per toggle; each toggle is reverted before the next.

Usage:
    xvfb-run -a -s "-screen 0 2600x1700x24" \\
      uv run --with playwright python scripts/perf-bisect.py <out.json> [base] [route-id]
Env: VIEW=1080|1600, QUALITY, BLOCK_ASSETS (ion ids to fail), SETTLE_S (20), WINDOW_S (6), HEADLESS=1
"""
import json, os, pathlib, sys
from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4173"
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-lugano-melide"
VIEW = os.environ.get("VIEW", "1080")
QUALITY = os.environ.get("QUALITY")
SETTLE_S = float(os.environ.get("SETTLE_S", "20"))
WINDOW_S = float(os.environ.get("WINDOW_S", "6"))
GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
VIEWPORTS = {
    "1080": dict(viewport={"width": 1920, "height": 1080}, device_scale_factor=1),
    "1600": dict(viewport={"width": 1463, "height": 914}, device_scale_factor=1.75),
}
state = {"liveWeatherEnabled": False}
if QUALITY:
    state["graphicsQuality"] = QUALITY
INIT = """
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
localStorage.setItem('globeride.settings.v1', JSON.stringify({state:%s,version:1}));
window.__d = [];
(() => { let last = 0; const t = (n) => { if (last) window.__d.push(n - last); last = n; requestAnimationFrame(t); }; requestAnimationFrame(t); })();
const iv = setInterval(() => {
  const C = window.Cesium; if (!C || !C.CesiumWidget) return; clearInterval(iv);
  const orig = C.CesiumWidget.prototype.render;
  const sh = C.Scene.prototype.sampleHeight;
  C.Scene.prototype.sampleHeight = function (...a) { return window.__noSampleHeight ? undefined : sh.apply(this, a); };
  C.CesiumWidget.prototype.render = function () { if (!this.isDestroyed() && this.scene && this.container && this.container.offsetWidth > 800) window.__w = this; return orig.call(this); };
}, 20);
""" % json.dumps(state)

# name -> (apply js returning a revert-state, revert js)
TOGGLES = [
    ("baseline", "null", "null"),
    ("no backdrop-filter", "(() => { const st = document.createElement('style'); st.id = '__nobf'; st.textContent = '*,*::before,*::after{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}'; document.head.appendChild(st); return 0; })()", "document.getElementById('__nobf').remove()"),
    ("UI hidden (canvas only)", "(() => { const st = document.createElement('style'); st.id = '__noui'; st.textContent = 'body *{visibility:hidden !important} canvas{visibility:visible !important}'; document.head.appendChild(st); return 0; })()", "document.getElementById('__noui').remove()"),
    ("UI display:none (no React paint)", "(() => { const v = []; document.querySelectorAll('main *, #root *').forEach(()=>0); const st = document.createElement('style'); st.id = '__nodom'; st.textContent = '[class*=glass],[class*=pointer-events]{display:none !important}'; document.head.appendChild(st); return 0; })()", "document.getElementById('__nodom').remove()"),
    ("sampleHeight off", "(() => { window.__noSampleHeight = true; return 0; })()", "window.__noSampleHeight = false"),
    ("resolutionScale=0.5", "(() => { const v = __w.resolutionScale; __w.resolutionScale = 0.5; return v; })()", "__w.resolutionScale = S"),
    ("resolutionScale=1/dpr", "(() => { const v = __w.resolutionScale; __w.resolutionScale = 1 / devicePixelRatio; return v; })()", "__w.resolutionScale = S"),
    ("msaa=1", "(() => { const v = __w.scene.msaaSamples; __w.scene.msaaSamples = 1; return v; })()", "__w.scene.msaaSamples = S"),
    ("shadows off", "(() => { const v = [__w.scene.shadowMap.enabled]; __w.scene.shadowMap.enabled = false; return v; })()", "__w.scene.shadowMap.enabled = S[0]"),
    ("postprocess off", "(() => { const s = __w.scene.postProcessStages; const v = []; for (let i = 0; i < s.length; i++) { v.push(s.get(i).enabled); s.get(i).enabled = false; } v.push(s.fxaa.enabled, s.ambientOcclusion.enabled, s.bloom.enabled); s.fxaa.enabled = false; s.ambientOcclusion.enabled = false; s.bloom.enabled = false; return v; })()",
     "(() => { const s = __w.scene.postProcessStages; for (let i = 0; i < s.length; i++) s.get(i).enabled = S[i]; const n = s.length; s.fxaa.enabled = S[n]; s.ambientOcclusion.enabled = S[n+1]; s.bloom.enabled = S[n+2]; })()"),
    ("hdr off", "(() => { const v = __w.scene.highDynamicRange; __w.scene.highDynamicRange = false; return v; })()", "__w.scene.highDynamicRange = S"),
    ("fog off", "(() => { const v = __w.scene.fog.enabled; __w.scene.fog.enabled = false; return v; })()", "__w.scene.fog.enabled = S"),
    ("skyAtmosphere+groundAtmosphere off", "(() => { const v = [__w.scene.skyAtmosphere.show, __w.scene.globe.showGroundAtmosphere, __w.scene.globe.enableLighting]; __w.scene.skyAtmosphere.show = false; __w.scene.globe.showGroundAtmosphere = false; __w.scene.globe.enableLighting = false; return v; })()",
     "(() => { __w.scene.skyAtmosphere.show = S[0]; __w.scene.globe.showGroundAtmosphere = S[1]; __w.scene.globe.enableLighting = S[2]; })()"),
    ("3D tilesets hidden", "(() => { const p = __w.scene.primitives; const v = []; for (let i = 0; i < p.length; i++) { const x = p.get(i); if (x instanceof Cesium.Cesium3DTileset) { v.push([i, x.show]); x.show = false; } } return v; })()",
     "(() => { for (const [i, s] of S) __w.scene.primitives.get(i).show = s; })()"),
    ("clouds hidden", "(() => { const p = __w.scene.primitives; const v = []; for (let i = 0; i < p.length; i++) { const x = p.get(i); if (x instanceof Cesium.CloudCollection) { v.push([i, x.show]); x.show = false; } } return v; })()",
     "(() => { for (const [i, s] of S) __w.scene.primitives.get(i).show = s; })()"),
    ("particles hidden", "(() => { const p = __w.scene.primitives; const v = []; for (let i = 0; i < p.length; i++) { const x = p.get(i); if (x instanceof Cesium.ParticleSystem) { v.push([i, x.show]); x.show = false; } } return v; })()",
     "(() => { for (const [i, s] of S) __w.scene.primitives.get(i).show = s; })()"),
    ("all primitives hidden", "(() => { const p = __w.scene.primitives; const v = []; for (let i = 0; i < p.length; i++) { const x = p.get(i); v.push(x.show); x.show = false; } return v; })()",
     "(() => { const p = __w.scene.primitives; for (let i = 0; i < S.length; i++) p.get(i).show = S[i]; })()"),
    ("entities hidden", "(() => { const v = __w.entities.show; __w.entities.show = false; return v; })()", "__w.entities.show = S"),
    ("ground primitives hidden", "(() => { const p = __w.scene.groundPrimitives; const v = p.show; p.show = false; return v; })()", "__w.scene.groundPrimitives.show = S"),
    ("everything hidden", "(() => { const s = __w.scene; const v = [s.globe.show, s.primitives.show, s.groundPrimitives.show, __w.entities.show, s.skyAtmosphere.show, s.skyBox && s.skyBox.show, s.sun && s.sun.show, s.moon && s.moon.show]; s.globe.show = false; s.primitives.show = false; s.groundPrimitives.show = false; __w.entities.show = false; s.skyAtmosphere.show = false; if (s.skyBox) s.skyBox.show = false; if (s.sun) s.sun.show = false; if (s.moon) s.moon.show = false; return v; })()",
     "(() => { const s = __w.scene; [s.globe.show, s.primitives.show, s.groundPrimitives.show, __w.entities.show, s.skyAtmosphere.show] = S; if (s.skyBox) s.skyBox.show = S[5]; if (s.sun) s.sun.show = S[6]; if (s.moon) s.moon.show = S[7]; })()"),
    ("globe hidden", "(() => { const v = __w.scene.globe.show; __w.scene.globe.show = false; return v; })()", "__w.scene.globe.show = S"),
    ("baseline (again)", "null", "null"),
]


def fps(page):
    page.evaluate("() => { window.__d.length = 0 }")
    page.wait_for_timeout(int(WINDOW_S * 1000))
    d = page.evaluate("() => window.__d.splice(0)")
    if not d:
        return {"fps": 0}
    s = sorted(d)
    return {"fps": round(len(d) / (sum(d) / 1000), 1), "p50_ms": round(s[len(s) // 2], 1), "p95_ms": round(s[int(len(s) * 0.95)], 1)}


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/sbin/chromium", headless=os.environ.get("HEADLESS") == "1", args=GPU)
    ctx = b.new_context(**VIEWPORTS[VIEW], color_scheme="dark", service_workers="block")
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    for asset in filter(None, os.environ.get("BLOCK_ASSETS", "").split(",")):
        pg.route(f"**/v1/assets/{asset}/endpoint**", lambda route: route.abort())
    pg.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_selector(f"[data-scenic-route='{route_id}']", timeout=30000)
    pg.evaluate(f"() => document.querySelector(\"[data-scenic-route='{route_id}']\").click()")
    pg.wait_for_url("**/ride**", timeout=20000)
    pg.wait_for_timeout(int(SETTLE_S * 1000))
    info = pg.evaluate("""() => { const w = __w, s = w.scene; const p = s.primitives; const kinds = [];
      for (let i = 0; i < p.length; i++) { const x = p.get(i); kinds.push(x.constructor.name + (x instanceof Cesium.Cesium3DTileset ? `(show=${x.show},sse=${x.maximumScreenSpaceError},mem=${Math.round((x.totalMemoryUsageInBytes||0)/1e6)}MB,cache=${Math.round((x.cacheBytes||0)/1e6)}MB)` : '')); }
      const pp = s.postProcessStages; const st = []; for (let i = 0; i < pp.length; i++) st.push(pp.get(i).name + ':' + pp.get(i).enabled);
      return { canvas: [w.canvas.width, w.canvas.height], resolutionScale: w.resolutionScale, dpr: devicePixelRatio,
        useBrowserRecommendedResolution: w.useBrowserRecommendedResolution, msaa: s.msaaSamples, hdr: s.highDynamicRange,
        shadows: s.shadowMap.enabled, softShadows: s.shadowMap.softShadows, shadowSize: s.shadowMap.size, fog: s.fog.enabled,
        fxaa: pp.fxaa.enabled, ao: pp.ambientOcclusion.enabled, bloom: pp.bloom.enabled, stages: st, primitives: kinds,
        entities: w.entities.values.length, requestRenderMode: s.requestRenderMode, globeTilesLoaded: s.globe.tilesLoaded,
        tileCacheSize: s.globe.tileCacheSize, maxSSE: s.globe.maximumScreenSpaceError, terrain: s.terrainProvider.constructor.name,
        imagery: s.imageryLayers.length }; }""")
    print(json.dumps(info, indent=1))
    rows = []
    for name, apply_js, revert_js in TOGGLES:
        S = pg.evaluate(f"() => {apply_js}")
        r = fps(pg)
        pg.evaluate(f"(S) => {{ {revert_js}; }}", S)
        pg.wait_for_timeout(500)
        rows.append((name, r))
        print(f"{name:40s} {r}", flush=True)
    b.close()
out.write_text(json.dumps({"view": VIEW, "quality": QUALITY, "info": info, "rows": rows}, indent=1))
