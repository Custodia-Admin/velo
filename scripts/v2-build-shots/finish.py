#!/usr/bin/env python3
"""P2.4 build shots: the v2 finish page (src/components/velo/FinishCard.tsx).

Real flow per viewport x theme: /app -> ride "Tiber river park" token-free
(featured "Ride Tiber river park" button or its grid card) -> wait until the
ride runs -> ride RIDE_S seconds (default 34, so the history recorder's 30 s
minimum is passed and the ride really is saved on this device) -> Finish ->
wait for the finish dialog, the fonts and the plate image -> shoot + measure.

    BASE=http://localhost:5184 uv run --with playwright --with pillow \
        python scripts/v2-build-shots/finish.py

Env: ONLY=1440,390,tv  THEMES=day,night  RIDE_S=34  OUT=<dir>
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

SCREEN = "finish"
RIDE_S = float(os.environ.get("RIDE_S", "34"))
ONLY = [v for v in os.environ.get("ONLY", "1440,390,tv").split(",") if v]
THEMES = [t for t in os.environ.get("THEMES", "day,night").split(",") if t]
DIALOG = '[role="dialog"][aria-labelledby="finish-title"]'

READY = """async () => {
  await document.fonts.ready;
  const imgs = [...document.querySelectorAll('[role="dialog"] img')].filter(i => i.getBoundingClientRect().width > 0);
  await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = r; i.onerror = r; })));
  return imgs.map(i => ({ src: i.currentSrc.split('/').pop(), ok: i.naturalWidth > 0 }));
}"""

RECTS = """() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const btn = (name) => { const el = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')]
    .find(e => e.textContent.trim().startsWith(name)); if (!el) return null;
    const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const d = document.querySelector('[role="dialog"][aria-labelledby="finish-title"]');
  return { plate: r('[role="dialog"] main .rounded-lg'), h1: r('#finish-title'),
    kicker: d && d.querySelector('section span')?.textContent,
    download: btn('Download FIT'), strava: btn('Send to Strava'), home: btn('Back to Home'),
    profile: r('[role="dialog"] svg[role="img"]'), focused: document.activeElement?.id || document.activeElement?.tagName,
    after: r('[role="dialog"] section > div:last-child'), footer: r('[role="dialog"] footer') };
}"""


def ride_and_finish(page, vp: str) -> None:
    page.goto(common.url("/app", vp), wait_until="domcontentloaded")
    featured = page.get_by_test_id("featured-scenic-ride").get_by_role("button", name="Ride Tiber river park", exact=True)
    card = page.locator('[data-scenic-route="scenic-perugia-tiber-park"]')
    target = card.or_(featured).first
    target.wait_for(state="visible", timeout=60_000)
    target.click()
    page.wait_for_url("**/ride**", timeout=30_000)
    fin = page.locator('[aria-label="Finish ride"]').first
    fin.wait_for(state="attached", timeout=90_000)
    t0 = time.time()
    while time.time() - t0 < 60:
        st = page.evaluate("() => (window.__veloRideDebug?.() ?? {})")
        if page.locator('[aria-label="Pause ride"]').count() or st.get("rideState") == "running":
            break
        time.sleep(0.5)
    # Ride RIDE_S seconds of RIDE time (the HUD's Time figure), not wall time:
    # a slow headless frame rate clamps sim steps, and the history recorder
    # only saves rides of 30 s or more.
    t1 = time.time()
    while time.time() - t1 < RIDE_S * 4:
        label = page.evaluate("() => document.querySelector('[aria-label^=\"Time: \"]')?.getAttribute('aria-label') || ''")
        parts = label.replace("Time: ", "").split(":")
        try:
            secs = sum(int(x) * 60 ** i for i, x in enumerate(reversed(parts)))
        except ValueError:
            secs = 0
        if secs >= RIDE_S:
            break
        time.sleep(0.5)
    page.evaluate("""() => { const b = document.querySelector('[aria-label="Finish ride"]'); b && b.click(); }""")
    page.locator(DIALOG).wait_for(state="visible", timeout=30_000)
    # The kicker turns to "saved on this device" once the recorder's save is read back.
    try:
        page.wait_for_function("() => /saved on this device/.test(document.querySelector('[role=dialog] section span')?.textContent || '')", timeout=6_000)
    except Exception:
        pass


def main() -> None:
    results: dict = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in ONLY:
            for theme in THEMES:
                ctx, page = common.new_page(browser, vp, theme)
                try:
                    ride_and_finish(page, vp)
                    imgs = page.evaluate(READY)
                    time.sleep(0.6)
                    path = common.save(page, SCREEN, vp, theme)
                    m = common.measure(page)
                    m["rects"] = page.evaluate(RECTS)
                    m["imgs"] = imgs
                    m["errors"] = page.errors[:5]  # type: ignore[attr-defined]
                    results[common.shot_name(SCREEN, vp, theme)] = m
                    print(path.name, json.dumps(m))
                except Exception as e:  # keep going; report the failure
                    results[common.shot_name(SCREEN, vp, theme)] = {"error": str(e)[:300]}
                    print("FAIL", vp, theme, str(e)[:300])
                    try:
                        page.screenshot(path=str(common.OUT / f"_fail-{vp}-{theme}.png"))
                    except Exception:
                        pass
                finally:
                    ctx.close()
        browser.close()
    common.record(SCREEN, results)


if __name__ == "__main__":
    main()
