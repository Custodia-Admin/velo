"""Ride-view frame-rate measurement on the host GPU (Intel Arc via Vulkan).

Runs Chromium HEADED (so requestAnimationFrame is not throttled) — wrap it
in xvfb-run. Opens Home, clicks a scenic route card, lets the ride start in
Demo Mode (no trainer, no Bluetooth — nothing is ever paired or sent), then
samples frame times for a startup/streaming window and a steady window.

Usage:
    xvfb-run -a -s "-screen 0 2600x1700x24" \\
      uv run --with playwright python scripts/perf-ride.py <out.json> [base] [route-id]

Env:
    VIEWS     comma list of viewports: 1080 (1920x1080 @1x) and/or
              1600 (1463x914 @1.75x = the laptop's 2560x1600 at 175 %).
              Default "1080,1600".
    QUALITY   graphics tier seeded into settings (low|medium|high); unset =
              the app default.
    STARTUP_S seconds of the startup/streaming window (default 20)
    STEADY_S  seconds of the steady window (default 30)
    PROFILE=1 also record a 5 s CPU profile in the steady window and print
              the top self-time functions.
    EXTRA_LS  JSON object merged into the persisted settings state.

Frame times come from an init-script requestAnimationFrame sampler, which
works on any build. When the app exposes window.__veloPerf() (the perf
overlay), its fps / frame-time / tile-load numbers are recorded too.
"""
import json
import os
import pathlib
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4173"
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-lugano-melide"
VIEWS = os.environ.get("VIEWS", "1080,1600").split(",")
QUALITY = os.environ.get("QUALITY")
STARTUP_S = float(os.environ.get("STARTUP_S", "20"))
STEADY_S = float(os.environ.get("STEADY_S", "30"))
PROFILE = os.environ.get("PROFILE") == "1"
EXTRA = json.loads(os.environ.get("EXTRA_LS", "{}"))

GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
VIEWPORTS = {
    "1080": dict(viewport={"width": 1920, "height": 1080}, device_scale_factor=1),
    "1600": dict(viewport={"width": 1463, "height": 914}, device_scale_factor=1.75),
}

settings_state = {"liveWeatherEnabled": False, **EXTRA}
if QUALITY:
    settings_state["graphicsQuality"] = QUALITY
    # Pin the tier: otherwise the ride view picks one for the detected GPU.
    settings_state["graphicsQualityAuto"] = False

INIT = """
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
localStorage.setItem('globeride.settings.v1', JSON.stringify({state:%s,version:1}));
window.__rafDeltas = [];
window.__longTasks = [];
(() => {
  let last = 0;
  const tick = (t) => { if (last) window.__rafDeltas.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push(e.duration); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) {}
})();
""" % json.dumps(settings_state)
INIT += """
window.__calls = {readPixels: 0, sampleHeight: 0};
(() => {
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const orig = C.prototype.readPixels;
    C.prototype.readPixels = function (...a) { window.__calls.readPixels++; return orig.apply(this, a); };
  }
  const iv = setInterval(() => {
    const Cz = window.Cesium;
    if (!Cz || !Cz.Scene) return;
    clearInterval(iv);
    const orig = Cz.Scene.prototype.sampleHeight;
    Cz.Scene.prototype.sampleHeight = function (...a) {
      window.__calls.sampleHeight++;
      if (window.__noSampleHeight) return undefined;
      return orig.apply(this, a);
    };
  }, 20);
})();
""" + os.environ.get("PATCH_JS", "")


def summarize(deltas):
    if not deltas:
        return None
    d = sorted(deltas)
    n = len(d)
    total_s = sum(d) / 1000
    q = lambda p: d[min(n - 1, int(p * n))]
    return {
        "frames": n,
        "fps": round(n / total_s, 1) if total_s else 0,
        "p50_ms": round(q(0.50), 1),
        "p95_ms": round(q(0.95), 1),
        "p99_ms": round(q(0.99), 1),
        "max_ms": round(d[-1], 1),
        "jank33_pct": round(100 * sum(1 for x in d if x > 33.4) / n, 1),
        "over50": sum(1 for x in d if x > 50),
        "over100": sum(1 for x in d if x > 100),
        "worst_1s_fps": worst_window_fps(deltas),
    }


def worst_window_fps(deltas):
    """Lowest frame count in any rolling 1 s window (streaming stutter)."""
    worst = None
    i = 0
    acc = 0.0
    for j, x in enumerate(deltas):
        acc += x
        while acc > 1000 and i <= j:
            acc -= deltas[i]
            i += 1
        if acc >= 900:  # a full-ish second
            frames = j - i + 1
            worst = frames if worst is None else min(worst, frames)
    return worst


def metrics(cdp):
    return {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}


def top_self_time(profile, n=25):
    nodes = {nd["id"]: nd for nd in profile["nodes"]}
    parent = {}
    for nd in profile["nodes"]:
        for c in nd.get("children", []):
            parent[c] = nd["id"]
    label = lambda nd: f'{nd["callFrame"]["functionName"] or "(anon)"} {nd["callFrame"]["url"].rsplit("/", 1)[-1]}:{nd["callFrame"]["lineNumber"]}:{nd["callFrame"]["columnNumber"]}'
    incl = {}
    for sid, dt in zip(profile.get("samples", []), profile.get("timeDeltas", [])):
        seen = set()
        cur = sid
        while cur is not None:
            k = label(nodes[cur])
            if k not in seen:
                seen.add(k)
                incl[k] = incl.get(k, 0) + dt
            cur = parent.get(cur)
    globals()["_INCL"] = sorted(((k, round(v / 1000, 1)) for k, v in incl.items()), key=lambda kv: -kv[1])[:80]
    self_us = {}
    samples = profile.get("samples", [])
    deltas = profile.get("timeDeltas", [])
    for sid, dt in zip(samples, deltas):
        nd = nodes[sid]
        cf = nd["callFrame"]
        key = f'{cf["functionName"] or "(anon)"} {cf["url"].rsplit("/", 1)[-1]}:{cf["lineNumber"]}'
        self_us[key] = self_us.get(key, 0) + dt
    total = sum(self_us.values()) or 1
    return [(k, round(v / 1000, 1), round(100 * v / total, 1)) for k, v in sorted(self_us.items(), key=lambda kv: -kv[1])[:n]]


results = {"base": base, "route": route_id, "quality": QUALITY or "app-default", "settings": settings_state, "runs": {}}
with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"),
        headless=os.environ.get("HEADLESS") == "1",
        args=GPU + ["--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                    "--disable-backgrounding-occluded-windows", "--window-position=0,0"],
    )
    for vp in VIEWS:
        ctx = browser.new_context(**VIEWPORTS[vp], color_scheme="dark", service_workers="block")
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        for asset in filter(None, os.environ.get("BLOCK_ASSETS", "").split(",")):
            # Simulate "this ion asset is unavailable" (e.g. 2275207 = Google
            # photoreal, 96188 = OSM buildings) to isolate its cost.
            page.route(f"**/v1/assets/{asset}/endpoint**", lambda route: route.abort())
        hosts = {}

        def on_resp(r):
            h = r.url.split("/")[2] if "://" in r.url else "?"
            hosts[h] = hosts.get(h, 0) + 1

        page.on("response", on_resp)
        cdp = ctx.new_cdp_session(page)
        cdp.send("Performance.enable")
        page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(f"[data-scenic-route='{route_id}']", timeout=30000)
        page.evaluate(f"() => document.querySelector(\"[data-scenic-route='{route_id}']\").click()")
        page.wait_for_url("**/ride**", timeout=20000)
        gpu = page.evaluate("""() => { const c=document.createElement('canvas'); const gl=c.getContext('webgl2');
            const e=gl&&gl.getExtension('WEBGL_debug_renderer_info'); return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):'?'; }""")
        page.evaluate("() => { window.__rafDeltas.length = 0; window.__longTasks.length = 0; }")
        t0 = time.time()
        timeline = []
        while time.time() - t0 < STARTUP_S:
            page.wait_for_timeout(1000)
            perf = page.evaluate("() => window.__veloPerf ? window.__veloPerf() : null")
            if perf:
                timeline.append({"t": round(time.time() - t0, 1), **perf})
        startup = page.evaluate("() => window.__rafDeltas.splice(0)")
        startup_lt = page.evaluate("() => window.__longTasks.splice(0)")
        m0 = metrics(cdp)
        if PROFILE:
            cdp.send("Profiler.enable")
            cdp.send("Profiler.setSamplingInterval", {"interval": 200})
            cdp.send("Profiler.start")
        t1 = time.time()
        prof = None
        while time.time() - t1 < STEADY_S:
            page.wait_for_timeout(1000)
            if PROFILE and prof is None and time.time() - t1 >= 5:
                prof = cdp.send("Profiler.stop")["profile"]
            perf = page.evaluate("() => window.__veloPerf ? window.__veloPerf() : null")
            if perf:
                timeline.append({"t": round(time.time() - t0, 1), **perf})
        steady = page.evaluate("() => window.__rafDeltas.splice(0)")
        calls = page.evaluate("() => window.__calls")
        steady_lt = page.evaluate("() => window.__longTasks.splice(0)")
        m1 = metrics(cdp)
        span = time.time() - t1
        ride = page.evaluate("() => window.__veloRideDebug ? window.__veloRideDebug() : null")
        speed = page.evaluate("() => document.querySelector('[aria-label^=\"Speed:\"]')?.getAttribute('aria-label')")
        run = {
            "gpu": gpu,
            "startup": summarize(startup),
            "steady": summarize(steady),
            "longtasks_startup": {"n": len(startup_lt), "ms": round(sum(startup_lt))},
            "longtasks_steady": {"n": len(steady_lt), "ms": round(sum(steady_lt))},
            "main_thread_steady_pct": {
                k: round(100 * (m1[k] - m0[k]) / span, 1)
                for k in ("TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration")
            },
            "heap_mb": round(m1["JSHeapUsedSize"] / 1e6),
            "calls_total": calls,
            "ride": ride,
            "speed": speed,
            "hosts": dict(sorted(hosts.items(), key=lambda kv: -kv[1])[:8]),
            "perf_timeline": timeline[-6:] if timeline else None,
        }
        if prof:
            run["cpu_top_self"] = top_self_time(prof)
            run["cpu_top_inclusive"] = globals().get("_INCL")
            (out.parent / (out.stem + f"-{vp}.cpuprofile")).write_text(json.dumps(prof))
        shot = out.with_name(out.stem + f"-{vp}.png")
        page.screenshot(path=str(shot))
        run["shot"] = str(shot)
        results["runs"][vp] = run
        print(vp, json.dumps({k: run[k] for k in ("gpu", "startup", "steady", "main_thread_steady_pct", "longtasks_steady", "speed", "calls_total")}), flush=True)
        if prof:
            for row in run["cpu_top_self"][:15]:
                print("   ", row)
        ctx.close()
    browser.close()

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(results, indent=1))
print("wrote", out)
