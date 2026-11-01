"""Profile the world ride: GPU string, CPU profile top functions over a few seconds.
usage: uv run --with playwright python scripts/world-ride-profile.py [base] [route]
"""
import json
import os
import sys
import time
from collections import Counter

from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5181"
route_id = sys.argv[2] if len(sys.argv) > 2 else "scenic-perugia-tiber-park"
QUALITY = os.environ.get("QUALITY", "medium")
INIT = """
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
localStorage.setItem('globeride.settings.v1', JSON.stringify({ state: { graphicsQuality: '%s' }, version: 1 }));
""" % QUALITY
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
                          args=["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1920, "height": 1080})
    page.add_init_script(INIT)
    page.goto(base + "/app")
    page.locator(f'[data-scenic-route="{route_id}"]').first.evaluate("el => el.click()")
    page.wait_for_function("() => typeof window.__veloRideDebug === 'function'", timeout=90000)
    time.sleep(6)
    print(page.evaluate("""() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
      const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }"""))
    cdp = page.context.new_cdp_session(page)
    cdp.send("Profiler.enable")
    cdp.send("Profiler.setSamplingInterval", {"interval": 500})
    cdp.send("Profiler.start")
    time.sleep(4)
    prof = cdp.send("Profiler.stop")["profile"]
    nodes = {n["id"]: n for n in prof["nodes"]}
    self_t = Counter()
    total = 0
    for sid, dt in zip(prof["samples"], prof["timeDeltas"]):
        n = nodes[sid]
        cf = n["callFrame"]
        key = f'{cf["functionName"] or "(anon)"} {cf["url"].split("/")[-1].split("?")[0]}:{cf["lineNumber"]}'
        self_t[key] += dt
        total += dt
    for k, v in self_t.most_common(25):
        print(f"{v/1000:8.1f} ms {100*v/total:5.1f}%  {k}")
    print(json.dumps(page.evaluate("() => window.__veloRideDebug()")))
    b.close()
