"""Harness calibration: rAF fps of an empty page and a trivial full-screen
WebGL clear loop under the same Chromium flags/viewport as perf-ride.py.
Usage: xvfb-run -a -s "-screen 0 2600x1700x24" uv run --with playwright python scripts/perf-calibrate.py
"""
import os
from playwright.sync_api import sync_playwright
GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
JS = """async (gl) => {
  if (gl) { const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
    document.body.appendChild(c); c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
    const g = c.getContext('webgl2'); let k = 0; const f = () => { g.clearColor((k++ % 60) / 60, 0.3, 0.5, 1); g.clear(g.COLOR_BUFFER_BIT); requestAnimationFrame(f); }; f(); }
  const d = []; let last = 0; await new Promise((res) => { const t = (n) => { if (last) d.push(n - last); last = n; if (d.length < 180) requestAnimationFrame(t); else res(); }; requestAnimationFrame(t); });
  return +(d.length / (d.reduce((a, b) => a + b, 0) / 1000)).toFixed(1);
}"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/sbin/chromium", headless=os.environ.get("HEADLESS") == "1", args=GPU)
    for name, vp, dsf in (("1080", (1920, 1080), 1), ("1600", (1463, 914), 1.75)):
        ctx = b.new_context(viewport={"width": vp[0], "height": vp[1]}, device_scale_factor=dsf)
        pg = ctx.new_page(); pg.goto("about:blank")
        print(name, "empty", pg.evaluate(JS, False), "webgl-clear", pg.evaluate(JS, True), flush=True)
        ctx.close()
    b.close()
