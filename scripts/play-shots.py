"""Render Play mode for the design gate: Home switch, in-ride panel, finish card.

Usage (vite preview or dev server already running):
    uv run --with playwright python scripts/play-shots.py <out-dir> [base-url] [route-id]

Seeds two riders (Federico active, Anna with her own avatar colours), turns
Play mode on for Federico and stores one earlier ride by Anna on the route so
the buddy follows her recorded pace. Then: Home (full page), the ride just
before the first postcard, the moment it is collected, and the finish card.
Prints the panel text, element rects and overflow checks. Demo Mode only: no
trainer, no Bluetooth.

Env:
    GL=swiftshader  software WebGL instead of the host GPU via Vulkan
    THEME=light     light theme instead of dark
    CLOCK           ISO time for the page clock so real-sun moods are in daylight
    ONLY=1440|390   one viewport
"""
import datetime
import json
import os
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173"
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-lugano-melide"
out.mkdir(parents=True, exist_ok=True)
THEME = os.environ.get("THEME", "dark")
SUFFIX = "-light" if THEME == "light" else ""
CLOCK = os.environ.get("CLOCK")

SUNSET = {"frame": "#1e293b", "wheel": "#0b1220", "kit": "#f97316", "skin": "#d8a877", "helmet": "#fbbf24", "accent": "#ef4444"}
INIT = f"""
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({{state:{{hasSeenOnboarding:true}},version:2}}));
localStorage.setItem('globeride.theme', {json.dumps(THEME)});
if (!localStorage.getItem('globeride.settings.v1')) {{
  localStorage.setItem('globeride.settings.v1', JSON.stringify({{state:{{playMode:true}},version:1}}));
}}
if (!localStorage.getItem('globeride.velo.riders.v1')) {{
  localStorage.setItem('globeride.velo.riders.v1', JSON.stringify({{state:{{activeRiderId:'rider-1', riders:[
    {{id:'rider-1', name:'Federico', settings:null, profile:null}},
    {{id:'rider-2', name:'Anna', settings:{{avatar:{json.dumps(SUNSET)}}}, profile:null}}
  ]}}, version:1}}));
}}
"""

# One earlier ride by Anna on this route: steady 6 m/s, so she sits a little
# ahead of the demo rider and the gap clamp shows.
SEED_RIDE = """async ([routeId, routeName]) => {
  const startedAt = Date.UTC(2026, 9, 28, 17, 0, 0);
  const samples = [];
  for (let i = 0; i <= 1700; i++) samples.push({ t: startedAt + i * 1000, distance: Math.min(9709, i * 6), speed: 6, power: 110, cadence: 82, hr: 0, grade: 0, lat: 0, lon: 0, ele: 0 });
  const rec = { id: 'seed-anna', name: routeName, startedAt, durationSec: 1700, distanceM: 9709, ascentM: 50,
    avgPower: 110, avgSpeed: 6, sampleCount: samples.length, samples, source: 'route',
    routeRef: { id: routeId, name: routeName }, riderId: 'rider-2' };
  const db = await new Promise((res, rej) => { const r = indexedDB.open('globeride'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  if (!db.objectStoreNames.contains('rides')) return 'no rides store (version ' + db.version + ')';
  await new Promise((res, rej) => { const tx = db.transaction('rides', 'readwrite'); tx.objectStore('rides').put(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
  return 'seeded';
}"""

PANEL = """() => {
  const s = [...document.querySelectorAll('section[aria-label="Play mode"]')].filter(e => e.offsetParent);
  return s.map(e => { const r = e.closest('.glass')?.getBoundingClientRect() || e.getBoundingClientRect();
    return { text: e.innerText.replace(/\\n+/g, ' | '), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
}"""
OVERFLOW = "() => ({ scrollW: document.documentElement.scrollWidth, innerW: innerWidth })"

GL_ARGS = {
    "vulkan": ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"],
    "swiftshader": ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
}[os.environ.get("GL", "vulkan")]
VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}
if os.environ.get("ONLY"):
    VIEWPORTS = {os.environ["ONLY"]: VIEWPORTS[os.environ["ONLY"]]}


def wait_for_note(page, pattern, timeout_s):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        panels = page.evaluate(PANEL)
        if panels and any(pattern(p["text"]) for p in panels):
            return panels
        page.wait_for_timeout(250)
    return page.evaluate(PANEL)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"), args=GL_ARGS)
    for vp, (w, h) in VIEWPORTS.items():
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=THEME)
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if CLOCK:
            page.clock.set_system_time(datetime.datetime.fromisoformat(CLOCK))
        page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(f"[data-scenic-route='{route_id}']", timeout=20000)
        page.wait_for_timeout(1500)
        switch = page.evaluate("""() => { const b = [...document.querySelectorAll('button[role=switch]')].find(b => /Play mode/.test(document.getElementById(b.getAttribute('aria-labelledby'))?.textContent || ''));
          if (!b) return null; const r = b.getBoundingClientRect(); const hint = document.getElementById(b.getAttribute('aria-describedby'))?.textContent;
          return { checked: b.getAttribute('aria-checked'), w: r.width, h: r.height, hint }; }""")
        print(vp, "home switch:", switch, "overflow:", page.evaluate(OVERFLOW))
        page.screenshot(path=str(out / f"home-play{SUFFIX}-{vp}.png"), full_page=True)
        print(vp, "seed:", page.evaluate(SEED_RIDE, [route_id, "Lugano lakefront to Melide"]))

        page.click(f"[data-scenic-route='{route_id}']")
        page.wait_for_url("**/ride**", timeout=20000)
        panels = wait_for_note(page, lambda t: "Next one in 100 m" in t or "Next one in 50 m" in t, 120)
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / f"ride-approach{SUFFIX}-{vp}.png"))
        print(vp, "approach:", panels)
        panels = wait_for_note(page, lambda t: "collected" in t, 60)
        page.wait_for_timeout(250)
        page.screenshot(path=str(out / f"ride-pickup{SUFFIX}-{vp}.png"))
        print(vp, "pickup:", panels, "overflow:", page.evaluate(OVERFLOW))

        page.get_by_role("button", name="Finish").first.click()
        page.wait_for_timeout(2500)
        page.screenshot(path=str(out / f"finish{SUFFIX}-{vp}.png"))
        fin = page.evaluate("() => [...document.querySelectorAll('[role=dialog] .num')].map(e => e.closest('.glass')?.innerText.replace(/\\n+/g,' | ')).filter(t => /Postcards/.test(t || ''))")
        print(vp, "finish:", fin, "errors:", errors[:3])
        ctx.close()
    browser.close()
