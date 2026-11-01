#!/usr/bin/env python3
"""P2.4 build shots: the v2 in-ride HUD (docs/design/mockups/v2-ride-hud.html).

Home (/app) -> Today's ride (Tiber river park on the pinned 1 Nov 2026) -> the
token-free world renderer -> riding ~25 s -> shot, at 1440 / 390 / tv, day and
night. Also records window.__veloRideDebug().riderScreen and every HUD panel
rect, and flags panels that overlap the rider box.

    BASE=http://localhost:5183 uv run --with playwright --with pillow \
        python scripts/v2-build-shots/ride-hud.py [vp ...]

Env: RIDE_S (seconds riding before the shot, default 25), THEMES=day,night.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SCREEN = "ride-hud"
RIDE_S = float(os.environ.get("RIDE_S", "25"))
ROUTE = "scenic-perugia-tiber-park"

PANELS = """() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const sel = {
    exit: '[aria-label="Exit ride and return to setup"]',
    route: 'section[aria-label="Route progress"]',
    chip: '[data-testid=ride-status-chip]',
    show: '[data-testid=show-toggle]',
    camera: '[aria-label^="Camera:"]',
    settings: '[aria-label="Ride settings"]',
    more: '[aria-label="More ride options"]',
    strip: '[data-testid=ride-strip]',
    dock: '[data-dock-toggle]',
    gesture: '[aria-label="Show gesture controls legend"]',
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
  out.rideState = null;
  return out;
}"""


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


def start_ride(page, vp):
    for attempt in range(3):
        try:
            _start_ride(page, vp)
            return
        except Exception as e:  # Home may be mid-edit by another worker (shared dev server)
            print(f"  start_ride attempt {attempt + 1} failed: {str(e).splitlines()[0]}", flush=True)
            page.wait_for_timeout(3000)
    _start_ride(page, vp)


# The dev server is shared with other workers editing the tree: a full HMR
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
    page.goto(common.url("/app", vp), wait_until="domcontentloaded", timeout=60000)
    card = page.locator(f'[data-scenic-route="{ROUTE}"]')
    featured = page.locator('[data-testid=featured-scenic-ride] button[aria-label^="Ride "]:not([data-testid])')
    target = card.or_(featured).first
    target.wait_for(state="visible", timeout=30000)
    # JS click: Home may still be animating / re-rendering under a loaded machine.
    target.evaluate("el => el.click()")
    page.wait_for_url("**/ride**", timeout=30000)
    page.wait_for_selector('[aria-label^="Speed:"]', timeout=60000)
    # Riding: the Pause button appears once the auto-start fired.
    page.wait_for_selector('[aria-label="Pause ride"]', timeout=60000)


def main() -> None:
    vps = sys.argv[1:] or ["1440", "390", "tv"]
    themes = os.environ.get("THEMES", "day,night").split(",")
    results = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in vps:
            for theme in themes:
                ctx, page = common.new_page(browser, vp, theme, NO_HMR)
                t0 = time.time()
                start_ride(page, vp)
                page.wait_for_timeout(int(RIDE_S * 1000))
                page.mouse.move(5, 5)
                info = page.evaluate(PANELS)
                m = common.measure(page)
                path = common.save(page, SCREEN, vp, theme)
                box = rider_box(info.get("rider"), common.VIEWPORTS[vp][1])
                covering = [k for k, v in info.items() if isinstance(v, dict) and k != "rider" and overlaps(v, box)]
                name = common.shot_name(SCREEN, vp, theme)
                results[name] = {"measure": m, "panels": info, "riderBox": box, "covering": covering,
                                 "errors": page.errors[:5], "secs": round(time.time() - t0)}
                print(name, json.dumps({"measure": m, "riderBox": box, "covering": covering,
                                        "speed": info["speed"], "dist": info["dist"], "chip": info["chipText"],
                                        "route": info["routeText"], "errors": page.errors[:3]}))
                print("  panels", json.dumps({k: v for k, v in info.items() if isinstance(v, dict)}))
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
