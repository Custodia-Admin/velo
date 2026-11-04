#!/usr/bin/env python3
"""Build shots: the compact ride HUD (owner-directed revision, 2 Nov 2026;
docs/design/mockups/v2-ride-hud.html).

Staged as mocked (scripts/v2-build-shots/common.py): a fake granted KICKR CORE
is reconnected on /devices (no hardware) and streams 142 W, then Home (/app) ->
Today's ride (Tiber river park on the pinned 1 Nov 2026) -> the token-free
world renderer. Once riding, the ride is staged at the mockup's point in the
ride (9.06 km, 24:42; set on the dev server's rideStore module) and the world
is pinned to golden hour, clear (window.__veloWorldLight), then it rides on
~RIDE_S s before the shots, at 1440 / 390 / tv, day and night.

States, one ride per viewport + theme (env STATES, default closed,open,lost):
  closed  the default HUD: band + chip          -> ride-hud-<vp>[-night].jpg
  open    the details toggle tapped             -> ride-hud-open-<vp>[-night].jpg
  lost    trainer lost mid-ride: a REAL drop    -> ride-hud-lost-<vp>[-night].jpg
          on the fake KICKR (its gatt disconnects and refuses to reconnect;
          ftms runs its own retry loop until it gives up), the one chip says so

Every shot records the HUD area (hud_area.HUD_AREA: sum and union of every
visible surface over the canvas, % of the viewport), every HUD panel rect,
window.__veloRideDebug().riderScreen, and flags panels over the rider box.
Needs a DEV server (BASE): the staging imports /src/stores/*.ts.

    BASE=http://localhost:5191 uv run --with playwright --with pillow \\
        python scripts/v2-build-shots/ride-hud.py [vp ...]

Env: RIDE_S (seconds riding before the first shot, default 12), THEMES=day,night,
STATES=closed,open,lost, OUT=<dir> while iterating.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from hud_area import HUD_AREA  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SCREEN = "ride-hud"
RIDE_S = float(os.environ.get("RIDE_S", "12"))
# The mockup still is the tree avenue at 9.06 km (scripts/v2-world-thumbs/views.json
# ride-chase, s 9060); ride time to match an easy 22 km/h average.
STAGE_M = float(os.environ.get("STAGE_M", "9060"))
STAGE_S = float(os.environ.get("STAGE_S", "1482"))
TIME = os.environ.get("WORLD_TIME", "golden")
STATES = os.environ.get("STATES", "closed,open,lost").split(",")

STAGE = """async ([m, s, time]) => {
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  useRideStore.setState({ distance: m, elapsedMs: s * 1000 });
  const light = !!window.__veloWorldLight;
  window.__veloWorldLight?.set({ time, weather: 'clear' });
  return { conn: useRideStore.getState().connection, name: useRideStore.getState().deviceName, light };
}"""

# Trainer dropped mid-ride, for real: no store staging. The fake KICKR's GATT
# link drops and every reconnect attempt is refused, so ftms' own retry loop
# (4 attempts, ~9 s) runs and gives up, and TrainerEventBridge reports it.
# What the chip then says depends on the build: with #27 alone nothing makes a
# reconnect grant usable after a drop ("Trainer lost · tap for devices"); with
# #26's trainerLost() merged it is "Trainer lost · tap to reconnect".
DROP = """async () => {
  const [k] = await navigator.bluetooth.getDevices();
  k.gatt.connect = async () => { throw Object.assign(new Error('fake: out of range'), { name: 'NetworkError' }); };
  k.gatt.connected = false;
  k.dispatchEvent(new Event('gattserverdisconnected'));
  return true;
}"""
CHIP = """() => { const c = document.querySelector('[data-testid=ride-status-chip]');
  return c ? [c.textContent, getComputedStyle(c).display !== 'none'] : [null, false]; }"""


def drop_trainer(page) -> list:
    """Drop the fake KICKR and sample the chip every second until it reads lost (max 30 s)."""
    page.evaluate(DROP)
    timeline = []
    for i in range(30):
        page.wait_for_timeout(1000)
        text, shown = page.evaluate(CHIP)
        timeline.append([i + 1, text, shown])
        if text and text.startswith("Trainer lost") and i >= 12:
            break
    return timeline
ROUTE = "scenic-perugia-tiber-park"

PANELS = """() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const sel = {
    strip: '[data-testid=ride-strip]',
    chip: '[data-testid=ride-status-chip]',
    details: '[data-testid=ride-details]',
    route: 'section[aria-label="Route progress"]',
    map: '[data-testid=ride-map]',
    tools: '[aria-label="Ride tools"]',
    exit: '[aria-label="Exit ride and return to setup"]',
    pause: '[aria-label="Pause ride"]',
    finish: '[aria-label="Finish ride"]',
    toggle: '[data-testid=ride-details-toggle]',
  };
  const out = {};
  for (const [k, s] of Object.entries(sel)) {
    const el = [...document.querySelectorAll(s)].find(vis);
    out[k] = el ? rect(el) : null;
  }
  const dbg = window.__veloRideDebug ? window.__veloRideDebug() : null;
  out.rider = dbg && dbg.riderScreen ? dbg.riderScreen : null;
  out.renderer = dbg ? dbg.renderer : null;
  out.speed = document.querySelector('[aria-label^="Speed:"]')?.getAttribute('aria-label') ?? null;
  out.dist = document.querySelector('[data-testid=ride-strip] [aria-label*=" of "]')?.getAttribute('aria-label') ?? null;
  out.chipText = document.querySelector('[data-testid=ride-status-chip]')?.textContent ?? null;
  out.routeText = document.querySelector('section[aria-label="Route progress"]')?.innerText ?? null;
  out.toasts = document.querySelectorAll('[aria-label="Notifications"] > *').length;
  return out;
}"""

# Panels that must never overlap one another (the directive: expanded panels never overlap).
NO_OVERLAP = ["strip", "chip", "route", "map", "tools"]


def rider_box(r, vh):
    """riderScreen is the projected point 1 m above the rider's ground contact.

    The standard chase camera draws the ~1.7 m rider about 21 % of the viewport
    height tall (176 px at 390x844, skill notes). Pad that to 24 % and take a
    width of 0.6 x height: a generous box from the head to the wheels.
    """
    if not r:
        return None
    x, y = r
    h = 0.24 * vh
    return (round(x - 0.3 * h), round(y - h * 0.7 / 1.7), round(x + 0.3 * h), round(y + h * 1.0 / 1.7))


def overlaps(p, box):
    if not p or not box:
        return False
    return not (p["x"] + p["w"] <= box[0] or p["x"] >= box[2] or p["y"] + p["h"] <= box[1] or p["y"] >= box[3])


def rect_box(p):
    return (p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"])


def panel_overlaps(info):
    """Pairs of HUD panels that overlap (a panel's own children excluded: route/map/tools sit in details)."""
    out = []
    keys = [k for k in NO_OVERLAP if info.get(k)]
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            if overlaps(info[a], rect_box(info[b])):
                out.append(f"{a}/{b}")
    return out


def start_ride(page, vp):
    for attempt in range(3):
        try:
            _start_ride(page, vp)
            return
        except Exception as e:  # Home may be mid-edit by another worker (shared dev server)
            print(f"  start_ride attempt {attempt + 1} failed: {str(e).splitlines()[0]}", flush=True)
            page.wait_for_timeout(3000)
    _start_ride(page, vp)


# The dev server may be shared with other workers editing the tree: a full HMR
# reload mid-ride drops the ride (no route -> back to /app). Give Vite's HMR
# client a WebSocket that never connects, so no update or reload arrives.
NO_HMR = """
(() => {
  const RealWS = window.WebSocket;
  function isHmr(p) { return p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr')); }
  const Fake = function (url, protocols) {
    if (!isHmr(protocols)) return new RealWS(url, protocols);
    return { readyState: 0, url: String(url), protocol: 'vite-hmr', send() {}, close() {},
             addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
  };
  Fake.prototype = RealWS.prototype;
  Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Fake;
})();
"""


def _start_ride(page, vp):
    common.connect_trainer(page, vp)
    common.go_home_in_app(page)
    card = page.locator(f'[data-scenic-route="{ROUTE}"]')
    featured = page.locator('[data-testid=featured-scenic-ride] button[aria-label^="Ride "]:not([data-testid])')
    target = card.or_(featured).first
    target.wait_for(state="visible", timeout=30000)
    # JS click: Home may still be animating / re-rendering under a loaded machine.
    target.evaluate("el => el.click()")
    page.wait_for_url("**/ride**", timeout=30000)
    page.wait_for_selector('[aria-label^="Speed:"]', timeout=60000)
    # Riding: the Pause button appears once the auto-start fired.
    page.wait_for_selector('[aria-label="Pause ride"]', state="attached", timeout=60000)


def shoot(page, vp, theme, state, results):
    common.fonts_ready(page)
    page.mouse.move(5, 5)
    page.wait_for_timeout(400)
    info = page.evaluate(PANELS)
    area = page.evaluate(HUD_AREA)
    m = common.measure(page)
    screen = SCREEN if state == "closed" else f"{SCREEN}-{state}"
    common.save(page, screen, vp, theme)
    box = rider_box(info.get("rider"), common.VIEWPORTS[vp][1])
    covering = [k for k, v in info.items() if isinstance(v, dict) and k != "rider" and overlaps(v, box)]
    name = common.shot_name(screen, vp, theme)
    pairs = panel_overlaps(info)
    results[name] = {"measure": m, "hudArea": area, "panels": info, "riderBox": box, "covering": covering,
                     "panelOverlaps": pairs, "errors": page.errors[:5]}
    print(name, json.dumps({"sumPct": area["sumPct"], "unionPct": area["unionPct"], "topmostPct": area["topmostPct"],
                            "covering": covering, "panelOverlaps": pairs, "chip": info["chipText"],
                            "speed": info["speed"], "dist": info["dist"], "toasts": info["toasts"],
                            "minTarget": m["minTarget"], "minFont": m["minFont"], "backdrop": m["backdrop"],
                            "overflow": m["overflow"], "errors": page.errors[:3]}), flush=True)
    print("  surfaces", json.dumps([(r["name"], r["w"], r["h"]) for r in area["rects"]]), flush=True)


def main() -> None:
    vps = sys.argv[1:] or ["1440", "390", "tv"]
    themes = os.environ.get("THEMES", "day,night").split(",")
    results = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in vps:
            for theme in themes:
                ctx, page = common.new_page(browser, vp, theme, NO_HMR, fake={"granted": True})
                t0 = time.time()
                start_ride(page, vp)
                page.wait_for_selector('[data-world-status=ready]', timeout=90000)
                page.wait_for_timeout(3000)
                staged = page.evaluate(STAGE, [STAGE_M, STAGE_S, TIME])
                print("  staged", staged, flush=True)
                page.wait_for_timeout(int(RIDE_S * 1000))
                for state in STATES:
                    if state == "open":
                        page.locator('[data-testid=ride-details-toggle]').evaluate("el => el.click()")
                        page.wait_for_selector('[data-testid=ride-details]', timeout=10000)
                        page.wait_for_timeout(1500)
                    elif state == "lost":
                        if page.locator('[data-testid=ride-details]').count():
                            page.locator('[data-testid=ride-details-toggle]').evaluate("el => el.click()")
                        print("  lost chip timeline", json.dumps(drop_trainer(page)), flush=True)
                    shoot(page, vp, theme, state, results)
                print(f"  {vp}/{theme} {round(time.time() - t0)} s", flush=True)
                ctx.close()
        browser.close()
    prev = {}
    mp = common.OUT / f"measurements-{SCREEN}.json"
    if mp.exists():
        prev = json.loads(mp.read_text())
    prev.update(results)
    common.record(SCREEN, prev)


if __name__ == "__main__":
    main()
