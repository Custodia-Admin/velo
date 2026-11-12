#!/usr/bin/env python3
"""HOTFIX t_f9fb2a57 evidence: real Ride frames -> gear, keyboard + tap fallback, HUD shots.

    BASE=http://127.0.0.1:5197 OUT=<dir> LABEL=after uv run --with playwright --with pillow \
        python gear_shots.py 1440 1280 390

Runs the real app on a dev server with the fake KICKR + fake LEFT Zwift Ride of
scripts/v2-build-shots/common.py (no hardware). Pairs both on /devices, sends
the real-hardware 0x23 frames through the fake Ride's notify characteristic
(so the app's own decoder, ride map, TV layer and store run), and records the
gear the HUD shows after every press. Then the keyboard and the on-screen gear
buttons. Shoots /devices (last-press line) and the closed ride HUD, and
records the HUD area.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

WT = Path(os.environ.get("WT", str(Path(__file__).resolve().parents[2])))
sys.path.insert(0, str(WT / "scripts/v2-build-shots"))
import common  # noqa: E402
from hud_area import HUD_AREA, budget  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

spec = importlib.util.spec_from_file_location("ridehud", WT / "scripts/v2-build-shots/ride-hud.py")
ridehud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ridehud)  # type: ignore[union-attr]

LABEL = os.environ.get("LABEL", "after")
OUT = common.OUT
REL = "23 08 ff ff ff ff 0f"
FRAMES = {
    "LS1 (left upper, 0x100)": "23 08 ff fd ff ff 0f",
    "LS2 (left lower, 0x200)": "23 08 ff fb ff ff 0f",
    "RS1 (right upper, 0x1000)": "23 08 ff df ff ff 0f",
    "RS2 (right lower, 0x2000)": "23 08 ff bf ff ff 0f",
    "LB (left drop, 0x400)": "23 08 ff f7 ff ff 0f",
}
GEAR = """() => { const el = document.querySelector('[aria-label^="Gear "][aria-label$=" of 11"]');
  return el ? Number(el.getAttribute('aria-label').split(' ')[1]) : null; }"""
LAST = """() => document.querySelector('[data-testid=handlebar-last-press]')?.textContent ?? null"""


def press(page, frame: str, n: int = 1) -> None:
    for _ in range(n):
        page.evaluate(f"window.__fakeRide.notify('{frame}')")
        page.wait_for_timeout(60)
        page.evaluate(f"window.__fakeRide.notify('{REL}')")
        page.wait_for_timeout(60)


def main() -> None:
    vps = sys.argv[1:] or ["1440", "1280", "390"]
    results: dict = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in vps:
            r: dict = {"steps": []}
            ctx, page = common.new_page(browser, vp, "day", ridehud.NO_HMR, fake={"granted": True})
            page.goto(common.url("/devices", vp), wait_until="domcontentloaded", timeout=60000)
            page.get_by_role("button", name="Reconnect KICKR CORE 78C1").click()
            page.wait_for_selector("[data-testid=device-trainer][data-tone=ok]", timeout=15000)
            page.get_by_role("button", name="Pair handlebar controls").click()
            page.wait_for_selector("text=76 %", timeout=15000)
            page.evaluate("window.__fakeRide.notify('15')")
            r["devicesBefore"] = page.evaluate(LAST)
            press(page, FRAMES["LS2 (left lower, 0x200)"])
            page.wait_for_timeout(300)
            r["devicesAfterLS2"] = page.evaluate(LAST)
            page.wait_for_timeout(4200)  # toasts fade
            common.fonts_ready(page)
            row = page.locator("[data-testid=device-handlebar]")
            row.scroll_into_view_if_needed()
            common.save(page, f"devices-lastpress-{LABEL}", vp, "day")
            # Ride (same staging as ride-hud.py), the handlebar stays paired.
            common.go_home_in_app(page)
            card = page.locator(f'[data-scenic-route="{ridehud.ROUTE}"]')
            featured = page.locator('[data-testid=featured-scenic-ride] button[aria-label^="Ride "]:not([data-testid])')
            card.or_(featured).first.wait_for(state="visible", timeout=30000)
            card.or_(featured).first.evaluate("el => el.click()")
            page.wait_for_url("**/ride**", timeout=30000)
            page.wait_for_selector('[aria-label="Pause ride"]', state="attached", timeout=90000)
            page.wait_for_selector('[data-world-status=ready]', timeout=90000)
            page.wait_for_timeout(2500)
            print("  staged", page.evaluate(ridehud.STAGE, [ridehud.STAGE_M, ridehud.STAGE_S, ridehud.TIME]), flush=True)

            def step(name: str) -> None:
                g = page.evaluate(GEAR)
                st = page.evaluate("async () => (await import('/src/stores/rideStore.ts')).useRideStore.getState().rideState")
                r["steps"].append([name, g, st])
                print(f"  {vp} {LABEL}: {name} -> gear {g} ({st})", flush=True)

            step("start")
            press(page, FRAMES["RS1 (right upper, 0x1000)"], 6)
            step("RS1 x6")
            press(page, FRAMES["LS2 (left lower, 0x200)"], 12)
            step("LS2 x12")
            press(page, FRAMES["RS2 (right lower, 0x2000)"], 3)
            step("RS2 x3")
            press(page, FRAMES["LS1 (left upper, 0x100)"], 2)
            step("LS1 x2")
            press(page, FRAMES["LB (left drop, 0x400)"], 2)
            step("LB x2")
            page.mouse.move(5, 5)
            step("mouse moved")
            for _ in range(3):
                page.keyboard.press("=")
            step("key = x3")
            page.keyboard.press("[")
            step("key [ x1")
            harder = page.locator('button[aria-label="Harder gear"]:visible')
            easier = page.locator('button[aria-label="Easier gear"]:visible')
            r["tapButtons"] = {"harder": harder.count(), "easier": easier.count()}
            if harder.count():
                if vp == "390":
                    harder.first.tap(force=True)
                    harder.first.tap(force=True)
                    easier.first.tap(force=True)
                else:
                    harder.first.click(force=True)
                    harder.first.click(force=True)
                    easier.first.click(force=True)
                step("tap harder x2, easier x1")
                r["buttonRects"] = page.evaluate("""() => [...document.querySelectorAll('button[aria-label$=" gear"]')]
                  .map(b => { const x = b.getBoundingClientRect(); return [b.getAttribute('aria-label'), Math.round(x.x), Math.round(x.y), Math.round(x.width), Math.round(x.height), b.disabled]; })
                  .filter(v => v[3] > 0)""")
            page.mouse.move(5, 5)
            page.wait_for_timeout(1500)
            common.fonts_ready(page)
            area = page.evaluate(HUD_AREA)
            m = common.measure(page)
            common.save(page, f"ride-hud-gear-{LABEL}", vp, "day")
            r["hudArea"] = {k: area[k] for k in ("sumPct", "unionPct", "topmostPct")}
            r["budget"] = budget(area)
            r["surfaces"] = [(x["name"], x["w"], x["h"]) for x in area["rects"]]
            r["measure"] = m
            r["errors"] = page.errors[:5]
            print(vp, LABEL, json.dumps({k: r[k] for k in ("hudArea", "budget", "tapButtons")}), flush=True)
            results[vp] = r
            ctx.close()
        browser.close()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"gear-{LABEL}.json").write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
