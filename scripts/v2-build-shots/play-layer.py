#!/usr/bin/env python3
"""P3.2 build shots: the play layer (couple ghost + postcards) in the built app.

Screens, staged as the mockup (docs/design/mockups/p3.2-play-layer.html):

  play-setup    Home -> Build your own ride -> Tiber river park -> step 3
                "Who rides with you": Anna's ghost (last / best / none) above
                the pace partners. Two earlier rides by Anna on the route are
                stored first (real positions along the route, ride clock).
  play-setup-none  the same with no ride by Anna (1440 only).
  play-ride     the ride with Anna's ghost a few metres ahead, near a
                postcard's place (its pin in the accent).
  play-finish   Finish: "ahead of Anna's last ride" and the postcards' places.

Runs the fake KICKR (common.FAKE_BT, no hardware) on a DEV server (BASE): the
staging imports app modules. Output: OUT (default
docs/design/screenshots/v2/build/play-layer/).

    BASE=http://127.0.0.1:5197 uv run --with playwright --with pillow \\
        python scripts/v2-build-shots/play-layer.py

Env: ONLY=1440,1280,390,tv  THEMES=day,night  SCREENS=setup,ride,finish
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

common.OUT = Path(os.environ.get("OUT", common.REPO / "docs/design/screenshots/v2/build/play-layer"))
ONLY = [v for v in os.environ.get("ONLY", "1440,1280,390,tv").split(",") if v]
THEMES = [t for t in os.environ.get("THEMES", "day,night").split(",") if t]
SCREENS = [s for s in os.environ.get("SCREENS", "setup,ride,finish").split(",") if s]
ROUTE = "scenic-perugia-tiber-park"

ANNA = {"frame": "#1e293b", "wheel": "#0b1220", "kit": "#f97316", "skin": "#d8a877", "helmet": "#fbbf24", "accent": "#ef4444"}
ROSTER = f"""
localStorage.setItem('globeride.velo.riders.v1', JSON.stringify({{state:{{activeRiderId:'rider-1', riders:[
  {{id:'rider-1', name:'Federico', settings:null, profile:null}},
  {{id:'rider-2', name:'Anna', settings:{{avatar:{json.dumps(ANNA)}}}, profile:null}}
]}}, version:1}}));
localStorage.setItem('globeride.velo.coupleGhost.v1', JSON.stringify({{state:{{choice:'last'}}, version:0}}));
if (!localStorage.getItem('globeride.settings.v1')) {{
  localStorage.setItem('globeride.settings.v1', JSON.stringify({{state:{{playMode:true}}, version:1}}));
}}
"""

# Anna's rides on Tiber river park: last (3 Nov, 36:40) and best (28 Oct,
# 34:12), one sample a second along the route at an even pace.
SEED = """async (routeId) => {
  const { routeFromGeometry } = await import('/src/lib/scenicRoutes.ts');
  const { SCENIC_ROUTE_GEOMETRY } = await import('/src/lib/scenicRouteData.ts');
  const { sampleRouteAtDistance } = await import('/src/lib/gpxParser.ts');
  const { saveRide } = await import('/src/lib/rideHistory.ts');
  const route = routeFromGeometry(routeId, 'Tiber river park', SCENIC_ROUTE_GEOMETRY[routeId]);
  const make = async (id, startedAt, durationSec) => {
    const v = route.totalDistance / durationSec, samples = [];
    for (let i = 0; i <= durationSec; i++) {
      const d = Math.min(route.totalDistance, v * i), p = sampleRouteAtDistance(route, d);
      samples.push({ t: startedAt + i * 1000, rideMs: i * 1000, lat: p.lat, lon: p.lon, ele: p.ele, distance: d, speed: v, grade: 0, power: 150, cadence: 84 });
    }
    await saveRide({ id, name: 'Tiber river park', startedAt, durationSec, distanceM: route.totalDistance, ascentM: 22,
      avgPower: 150, avgSpeed: v, sampleCount: samples.length, samples, source: 'route', riderId: 'rider-2',
      routeRef: { id: routeId, name: 'Tiber river park' } });
  };
  await make('anna-best', Date.UTC(2026, 9, 28, 16), 2052);
  await make('anna-last', Date.UTC(2026, 10, 3, 16), 2200);
  return route.totalDistance;
}"""

SETUP_RECTS = """() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const step = document.querySelector('[data-wizard-step="3"]');
  return { step: r(step), ghost: r(document.querySelector('[data-couple-ghost]')), status: document.querySelector('[data-couple-ghost]')?.dataset.coupleGhost,
    tiles: [...document.querySelectorAll('[data-ghost-choice]')].map(e => [e.dataset.ghostChoice, e.getAttribute('aria-checked'), e.innerText.replace(/\\n+/g, ' | '), Math.round(e.getBoundingClientRect().height)]),
    header: step?.querySelector('button[aria-expanded]')?.innerText.replace(/\\n+/g, ' | ') };
}"""


def open_setup(page, vp: str, seed: bool) -> None:
    page.goto(common.url("/app", vp), wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=60000)
    if seed:
        print("  seeded", page.evaluate(SEED, ROUTE), flush=True)
    page.evaluate("() => { document.querySelector('details[data-build-your-own]').open = true; }")
    tile = page.locator(f'[data-featured-route="{ROUTE}"]')
    if tile.count():
        tile.first.click()
    else:
        page.evaluate("""async (id) => { const { routeFromGeometry } = await import('/src/lib/scenicRoutes.ts');
          const { SCENIC_ROUTE_GEOMETRY } = await import('/src/lib/scenicRouteData.ts');
          const { useRideStore } = await import('/src/stores/rideStore.ts');
          useRideStore.getState().setRoute(routeFromGeometry(id, 'Tiber river park', SCENIC_ROUTE_GEOMETRY[id])); }""", ROUTE)
    page.locator('[data-wizard-step="3"] button[aria-expanded]').first.click()
    page.wait_for_selector("[data-couple-ghost]", timeout=15000)
    # One pace partner picked, as the mockup: the ghost rides with The Diesel.
    page.locator("[data-partner]").first.click()
    page.wait_for_timeout(400)
    # Step 3 in view: its header near the top, as the user scrolls to it.
    page.evaluate("() => { const s = document.querySelector('[data-wizard-step=\"3\"]'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - innerHeight * 0.12); }")
    # No hover state left on a tile under the pointer from the clicks.
    page.mouse.move(1, 1)
    page.wait_for_timeout(500)


def start_ride(page, vp: str) -> None:
    common.connect_trainer(page, vp)
    common.go_home_in_app(page)
    print("  seeded", page.evaluate(SEED, ROUTE), flush=True)
    featured = page.get_by_test_id("featured-scenic-ride").get_by_role("button", name="Ride Tiber river park", exact=True)
    card = page.locator(f'[data-scenic-route="{ROUTE}"]')
    target = card.or_(featured).first
    target.wait_for(state="visible", timeout=60_000)
    target.click()
    page.wait_for_url("**/ride**", timeout=30_000)
    page.locator('[aria-label="Finish ride"]').first.wait_for(state="attached", timeout=90_000)
    t0 = time.time()
    while time.time() - t0 < 60:
        st = page.evaluate("() => (window.__veloRideDebug?.() ?? {})")
        if page.locator('[aria-label="Pause ride"]').count() or st.get("rideState") == "running":
            break
        time.sleep(0.5)
    page.wait_for_timeout(2500)


# Jump the ride to `riderM` at ride time `rideS`, samples filled in as the store would hold them.
JUMP = """async ([riderM, rideS]) => {
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  const { sampleRouteAtDistance } = await import('/src/lib/gpxParser.ts');
  const st = useRideStore.getState();
  const v = riderM / rideS, t0 = Date.now() - rideS * 1000, pre = [];
  for (let t = 0; t < rideS; t += 5) {
    const p = sampleRouteAtDistance(st.route, v * t);
    pre.push({ t: t0 + t * 1000, rideMs: t * 1000, lat: p.lat, lon: p.lon, ele: p.ele, distance: v * t, speed: v, grade: 0, power: 142 });
  }
  useRideStore.setState({ distance: riderM, elapsedMs: rideS * 1000, samples: pre });
  return { riderM, rideS };
}"""

GHOST_STATE = """async () => {
  const { useCoupleGhostStore } = await import('/src/stores/coupleGhostStore.ts');
  const { usePlayStore } = await import('/src/stores/playStore.ts');
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  const g = useCoupleGhostStore.getState().ghost, r = useRideStore.getState(), p = usePlayStore.getState();
  const t = r.elapsedMs / 1000;
  return { ghost: g && { rider: g.riderName, kind: g.kind, at: g.replay.distanceAt(t), gapM: g.replay.distanceAt(t) - r.distance },
    rider: r.distance, t, postcards: { collected: p.collected, total: p.total, names: p.names } };
}"""

PANEL = """() => [...document.querySelectorAll('section[aria-label="Play mode"]')].filter(e => e.offsetParent)
  .map(e => { const b = (e.closest('.glass') || e).getBoundingClientRect(); return { text: e.innerText.replace(/\\n+/g, ' | '), rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }; })"""


def stage_ride_shot(page) -> dict:
    """Rider ~70 m before the third postcard's place, Anna's ghost ~10 m ahead."""
    cards = page.evaluate("""async (id) => {
      const { postcardsAtPlaces } = await import('/src/lib/play/threePlayLayer.ts');
      const { useRideStore } = await import('/src/stores/rideStore.ts');
      const m = await (await fetch('/worlds/perugia/manifest.json')).json();
      const r = useRideStore.getState().route;
      return { length: r.totalDistance, cards: postcardsAtPlaces(r, m).map(c => [c.name, Math.round(c.distanceM)]) };
    }""", ROUTE)
    length, cards = cards["length"], cards["cards"]
    target = cards[2][1]
    rider = target - 70
    v_anna = length / 2200  # her last ride's even pace (SEED)
    ride_s = (rider + 12) / v_anna
    page.evaluate(JUMP, [rider, ride_s])
    page.wait_for_timeout(1200)
    return {"cards": cards, "target": cards[2], "jump": [rider, ride_s]}


def finish(page) -> None:
    """120 m from the end at 34:41, then ride on to the line (the Finish screen opens itself)."""
    length = page.evaluate("async () => (await import('/src/stores/rideStore.ts')).useRideStore.getState().route.totalDistance")
    page.evaluate(JUMP, [length - 120, 2081])
    dialog = '[role="dialog"][aria-labelledby="finish-title"]'
    t0 = time.time()
    while time.time() - t0 < 90 and not page.locator(dialog).count():
        time.sleep(0.5)
    if not page.locator(dialog).count():
        page.evaluate("""() => { const b = document.querySelector('[aria-label="Finish ride"]'); b && b.click(); }""")
    page.locator(dialog).wait_for(state="visible", timeout=30_000)
    try:
        page.wait_for_function("() => /saved on this device/.test(document.querySelector('[role=dialog] section span')?.textContent || '')", timeout=6_000)
    except Exception:
        pass
    page.evaluate("""async () => { await document.fonts.ready;
      const imgs = [...document.querySelectorAll('[role="dialog"] img')].filter(i => i.getBoundingClientRect().width > 0);
      await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = r; i.onerror = r; }))); }""")
    page.wait_for_timeout(600)


FINISH_TEXT = """() => ({ ghost: document.querySelector('[data-testid=finish-ghost]')?.innerText, postcards: document.querySelector('[data-testid=finish-postcards]')?.innerText,
  after: (() => { const e = document.querySelector('[data-testid=finish-ghost]')?.parentElement; if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })() })"""


def main() -> None:
    results: dict = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in ONLY:
            for theme in THEMES:
                if "setup" in SCREENS:
                    ctx, page = common.new_page(browser, vp, theme, ROSTER)
                    try:
                        open_setup(page, vp, seed=True)
                        common.fonts_ready(page)
                        path = common.save(page, "play-setup", vp, theme)
                        m = common.measure(page) | {"setup": page.evaluate(SETUP_RECTS), "errors": page.errors[:3]}  # type: ignore[attr-defined]
                        results[path.name] = m
                        print(path.name, json.dumps(m), flush=True)
                    except Exception as e:
                        print("FAIL setup", vp, theme, str(e)[:300], flush=True)
                        page.screenshot(path=str(common.OUT / f"_fail-setup-{vp}-{theme}.png"))
                    ctx.close()
                    if vp == "1440" and theme == "day":
                        ctx, page = common.new_page(browser, vp, theme, ROSTER)
                        try:
                            open_setup(page, vp, seed=False)
                            path = common.save(page, "play-setup-none", vp, theme)
                            results[path.name] = {"setup": page.evaluate(SETUP_RECTS)}
                            print(path.name, json.dumps(results[path.name]), flush=True)
                        except Exception as e:
                            print("FAIL setup-none", str(e)[:300], flush=True)
                        ctx.close()
                if "ride" in SCREENS or "finish" in SCREENS:
                    ctx, page = common.new_page(browser, vp, theme, ROSTER, fake={"granted": True})
                    try:
                        start_ride(page, vp)
                        if "ride" in SCREENS and theme == "day":
                            staged = stage_ride_shot(page)
                            # The pickup moment (the jump collected two postcards), then the
                            # steady state once its note has gone (PICKUP_NOTE_MS = 6 s): the
                            # same spot again, no new pickup.
                            hud = page.evaluate(HUD_AREA)
                            path = common.save(page, "play-ride-pickup", vp, theme)
                            results[path.name] = {"hud": {"sumPct": hud["sumPct"], "budget": budget(hud)}, "panel": page.evaluate(PANEL)}
                            print(path.name, json.dumps(results[path.name]), flush=True)
                            page.wait_for_timeout(6500)
                            page.evaluate(JUMP, staged["jump"])
                            page.wait_for_timeout(1200)
                            state = page.evaluate(GHOST_STATE)
                            path = common.save(page, "play-ride", vp, theme)
                            hud = page.evaluate(HUD_AREA)
                            m = common.measure(page) | {"staged": staged, "state": state, "panel": page.evaluate(PANEL),
                                                        "hud": {"sumPct": hud["sumPct"], "unionPct": hud["unionPct"], "budget": budget(hud), "rects": hud["rects"][:6]},
                                                        "errors": page.errors[:3]}  # type: ignore[attr-defined]
                            results[path.name] = m
                            print(path.name, json.dumps(m), flush=True)
                        if "finish" in SCREENS:
                            finish(page)
                            path = common.save(page, "play-finish", vp, theme)
                            m = common.measure(page) | {"finish": page.evaluate(FINISH_TEXT), "errors": page.errors[:3]}  # type: ignore[attr-defined]
                            results[path.name] = m
                            print(path.name, json.dumps(m), flush=True)
                    except Exception as e:
                        print("FAIL ride", vp, theme, str(e)[:300], flush=True)
                        try:
                            page.screenshot(path=str(common.OUT / f"_fail-ride-{vp}-{theme}.png"))
                        except Exception:
                            pass
                    ctx.close()
        browser.close()
    # Merge with earlier runs (ONLY / SCREENS subsets).
    path = common.OUT / "measurements.json"
    merged = json.loads(path.read_text()) if path.exists() else {}
    merged.update(results)
    path.write_text(json.dumps(merged, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
