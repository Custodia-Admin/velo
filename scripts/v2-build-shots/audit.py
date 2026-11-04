#!/usr/bin/env python3
"""Fit audit: every screen the owner can reach, at one gate viewport (default 1280x648 @2,
the owner's laptop). For each screen it saves <screen>-<vp>.jpg and measures:

  overflowX   document wider than the viewport (horizontal page scroll)
  pageScrollY document taller than the viewport (page scroll)
  scrollers   inner scroll boxes whose content is taller than the box (name, scrollH, clientH)
  clipped     visible controls / headings that cross a viewport edge
  covered     visible controls whose centre is painted over by another element
  hudArea     ride screens: hud_area.HUD_AREA sumPct + budget()

Screens (env SCREENS, comma list): home, settings, devices, ride, ride-open, finish, onboarding.
The finish screen is reached the way the owner reached it: ride Tiber river park in demo mode
(190 W, no trainer), staged near the end of the route (10.86 km at 20:00), ride on to the end of
the route, Finish (env FINISH_STAGE_M / FINISH_STAGE_S).

    BASE=http://localhost:5201 OUT=<dir> uv run --with playwright --with pillow \\
        python scripts/v2-build-shots/audit.py

Env: VP=1280 (any common.VIEWPORTS key), THEME=day|night, SCREENS=..., OUT=<dir>.
Writes OUT/audit-<vp>[-night].json. Needs a DEV server for the finish staging (/src/stores).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from hud_area import HUD_AREA, budget  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

VP = os.environ.get("VP", "1280")
THEME = os.environ.get("THEME", "day")
SCREENS = [s for s in os.environ.get("SCREENS", "home,settings,devices,ride,ride-open,finish,onboarding").split(",") if s]
STAGE_M = float(os.environ.get("FINISH_STAGE_M", "10860"))
STAGE_S = float(os.environ.get("FINISH_STAGE_S", "1200"))

# No Vite HMR socket: another worker's edit must not full-reload the page mid-ride.
NO_HMR = """
(() => { const Real = window.WebSocket;
  window.WebSocket = function (url, proto) {
    if (String(proto || '').includes('vite-hmr')) { const fake = new EventTarget(); fake.readyState = 0; fake.send = () => {}; fake.close = () => {}; return fake; }
    return new Real(url, proto); };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); })();
"""

FIT = r"""() => {
  const vw = innerWidth, vh = innerHeight, de = document.documentElement;
  const vis = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 48);
  // Visible part of an element after its overflow-clipping ancestors (an element scrolled out of an
  // inner scroll box is not "clipped by the viewport", it is just scrolled).
  const clipBox = (el) => { let r = el.getBoundingClientRect(); let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) { const q = p.getBoundingClientRect();
        x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom); } }
    return { x0, y0, x1, y1, empty: x1 <= x0 || y1 <= y0 }; };
  const scrollers = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (!/(auto|scroll)/.test(s.overflowY) || !vis(el)) continue;
    if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0)
      scrollers.push({ name: el.getAttribute('role') || el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.tagName.toLowerCase(),
                       scrollH: el.scrollHeight, clientH: el.clientHeight });
  }
  const clipped = [], covered = [], controls = [];
  // With a modal open, only its own controls count (the page behind is meant to be covered).
  const modal = [...document.querySelectorAll('[aria-modal="true"]')].filter(vis).pop() || null;
  for (const el of document.querySelectorAll('button, a[href], input, select, [role=switch], [role=radio], [role=tab], h1, h2')) {
    if (!vis(el) || el.closest('[aria-hidden="true"]')) continue;
    if (modal && !modal.contains(el)) continue;
    const c = clipBox(el); if (c.empty) continue;  // scrolled out of an inner box
    const r = el.getBoundingClientRect();
    const out = [];
    if (r.left < -1) out.push('left'); if (r.right > vw + 1) out.push('right');
    if (r.top < -1) out.push('top'); if (r.bottom > vh + 1) out.push('bottom');
    // Inside a page that scrolls, below the fold is fine: only report vertical clipping on fixed screens.
    const pageScrolls = de.scrollHeight > vh + 1;
    const fixedCtx = !!el.closest('[role=dialog], [data-renderer], .fixed') || getComputedStyle(el).position === 'fixed';
    const real = out.filter((k) => k === 'left' || k === 'right' || !pageScrolls || fixedCtx);
    if (real.length) clipped.push({ name: name(el), edges: real, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
    if (/^(BUTTON|A|INPUT|SELECT)$/.test(el.tagName) || el.getAttribute('role')) {
      const cx = (Math.max(c.x0, 0) + Math.min(c.x1, vw)) / 2, cy = (Math.max(c.y0, 0) + Math.min(c.y1, vh)) / 2;
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
      const hit = document.elementFromPoint(cx, cy);
      controls.push(name(el));
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) covered.push({ name: name(el), by: name(hit) });
    }
  }
  return { viewport: [vw, vh], overflowX: de.scrollWidth > vw + 1, scrollWidth: de.scrollWidth,
           pageScrollY: de.scrollHeight > vh + 1, scrollHeight: de.scrollHeight, scrollers, clipped, covered, controls: controls.length };
}"""

STAGE_FINISH = """async ([m, s]) => {
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  const { sampleRouteAtDistance } = await import('/src/lib/gpxParser.ts');
  const st = useRideStore.getState();
  const v = m / s, t0 = Date.now() - s * 1000, pre = [];
  for (let t = 0; t < s; t += 5) {
    const p = sampleRouteAtDistance(st.route, v * t);
    pre.push({ t: t0 + t * 1000, lat: p.lat, lon: p.lon, ele: p.ele, distance: v * t, speed: v, grade: 0, power: 190, cadence: 85 });
  }
  useRideStore.setState({ distance: m, elapsedMs: s * 1000, samples: pre });
  return { total: st.route && st.route.totalDistance, samples: pre.length, mode: st.mode };
}"""

DIALOG = '[role="dialog"][aria-labelledby="finish-title"]'


def shoot(page, screen: str, report: dict, ride: bool = False) -> None:
    common.fonts_ready(page)
    page.mouse.move(2, 2)
    page.wait_for_timeout(500)
    path = common.save(page, screen, VP, THEME)
    m = page.evaluate(FIT)
    if ride:
        area = page.evaluate(HUD_AREA)
        m["hudArea"] = {"sumPct": area["sumPct"], "unionPct": area["unionPct"], "budget": budget(area),
                        "surfaces": [(r["name"][:32], r["w"], r["h"]) for r in area["rects"]]}
    m["errors"] = page.errors[:5]  # type: ignore[attr-defined]
    report[screen] = m
    flags = [k for k in ("overflowX", "pageScrollY") if m[k]] + (["clipped"] if m["clipped"] else []) + (["covered"] if m["covered"] else [])
    print(f"{path.name}: {'OK' if not flags else 'FLAGS ' + ','.join(flags)}", json.dumps(
        {k: m[k] for k in ("scrollHeight", "scrollers", "clipped", "covered") if m[k]})[:900], flush=True)
    if ride:
        print("   hud", m["hudArea"]["sumPct"], m["hudArea"]["budget"], flush=True)


def start_ride(page) -> None:
    page.goto(common.url("/app", VP), wait_until="domcontentloaded", timeout=60000)
    card = page.locator('[data-scenic-route="scenic-perugia-tiber-park"] button[aria-label="Ride Tiber river park"]')
    featured = page.get_by_test_id("featured-scenic-ride").get_by_role("button", name="Ride Tiber river park", exact=True)
    target = card.or_(featured).first
    target.wait_for(state="attached", timeout=60000)
    target.evaluate("el => el.click()")
    page.wait_for_url("**/ride**", timeout=30000)
    page.wait_for_selector('[aria-label="Pause ride"]', state="attached", timeout=90000)
    try:
        page.wait_for_selector("[data-world-status=ready]", timeout=60000)
    except Exception:
        pass
    page.wait_for_timeout(2500)


def finish_ride(page) -> None:
    print("  staged", page.evaluate(STAGE_FINISH, [STAGE_M, STAGE_S]), flush=True)
    t0 = time.time()
    while time.time() - t0 < 40 and not page.locator(DIALOG).count():
        time.sleep(0.5)
    if not page.locator(DIALOG).count():
        page.evaluate("() => document.querySelector('[aria-label=\"Finish ride\"]')?.click()")
    page.locator(DIALOG).wait_for(state="visible", timeout=30000)
    try:
        page.wait_for_function("() => /saved on this device/i.test(document.querySelector('[role=dialog]')?.textContent || '')", timeout=6000)
    except Exception:
        pass
    page.evaluate("""async () => { await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('[role=dialog] img')].map(i => i.complete ? 0 : new Promise(r => { i.onload = r; i.onerror = r; }))); }""")
    page.wait_for_timeout(800)


def main() -> None:
    report: dict = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for screen in SCREENS:
            if screen == "ride-open" and "ride" in SCREENS:
                continue  # shot in the same ride as "ride"
            extra = NO_HMR
            if screen == "onboarding":
                # common.init_script marks the upstream onboarding as seen; this screen asks for a first run.
                extra += "localStorage.removeItem('globeride.onboarding.v2');\n"
            ctx, page = common.new_page(browser, VP, THEME, extra)
            try:
                if screen in ("home", "onboarding"):
                    page.goto(common.url("/app", VP), wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=60000)
                    page.wait_for_timeout(1500)
                    shoot(page, screen, report)
                elif screen == "settings":
                    page.goto(common.url("/app", VP), wait_until="domcontentloaded", timeout=60000)
                    page.get_by_role("button", name="Open settings").first.click()
                    page.wait_for_timeout(1200)
                    shoot(page, screen, report)
                elif screen == "devices":
                    page.goto(common.url("/devices", VP), wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_selector("[data-testid=device-trainer]", timeout=30000)
                    page.wait_for_timeout(1000)
                    shoot(page, screen, report)
                elif screen in ("ride", "ride-open"):
                    start_ride(page)
                    page.wait_for_timeout(4000)
                    shoot(page, "ride", report, ride=True)
                    if "ride-open" in SCREENS:
                        page.locator("[data-testid=ride-details-toggle]").evaluate("el => el.click()")
                        page.wait_for_timeout(1500)
                        shoot(page, "ride-open", report, ride=True)
                elif screen == "finish":
                    start_ride(page)
                    finish_ride(page)
                    shoot(page, "finish", report)
            except Exception as e:  # keep going; report the failure
                report[screen] = {"error": str(e)[:400]}
                print("FAIL", screen, str(e)[:400], flush=True)
                try:
                    page.screenshot(path=str(common.OUT / f"_fail-{screen}-{VP}.png"))
                except Exception:
                    pass
            finally:
                ctx.close()
        browser.close()
    common.OUT.mkdir(parents=True, exist_ok=True)
    out = common.OUT / f"audit-{VP}{'-night' if THEME == 'night' else ''}.json"
    prev = json.loads(out.read_text()) if out.exists() else {}
    prev.update(report)
    out.write_text(json.dumps(prev, indent=1, sort_keys=True))
    print("wrote", out)


if __name__ == "__main__":
    main()
