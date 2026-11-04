#!/usr/bin/env python3
"""P2.4 build shots: the Devices page (/devices).

    BASE=http://localhost:5182 uv run --with playwright --with pillow python scripts/v2-build-shots/devices.py

Writes docs/design/screenshots/v2/build/devices-<1440|390|tv>[-night].jpg in the
mockup's state as far as honest fakes allow, plus devices-empty-1440.jpg (nothing
paired), devices-error-1440.jpg (heart-rate chooser came up empty) and
devices-nobt-390.jpg (browser without Web Bluetooth).

No hardware, no real Bluetooth: an init script replaces navigator.bluetooth with
fakes (same GATT layouts as scripts/ui-shots-controls.py and
scripts/ui-shots-trainer-reconnect.py). The trainer is a fake granted
"KICKR CORE 78C1" (getDevices) brought back with the row's Reconnect tap; the
handlebar is a fake LEFT "Zwift Ride" (advert byte 08, battery 76 %) paired from
the row's Pair tap, then one shift press so the row reads live. Heart rate
stays unpaired. The store models one controller, so there is no second
(right-side) row to fake.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SCREEN = "devices"



def open_page(browser, vp, theme, fake: dict):
    ctx, page = common.new_page(browser, vp, theme, fake=fake)
    page.goto(common.url("/devices", vp), wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("h1:has-text('Devices')", timeout=30000)
    common.fonts_ready(page)
    page.wait_for_timeout(600)
    return ctx, page


def tone(page, testid):
    return page.get_attribute(f"[data-testid={testid}]", "data-tone")


def mockup_state(page):
    """Trainer reconnected, left handlebar live with battery, HR unpaired."""
    page.get_by_role("button", name="Reconnect KICKR CORE 78C1").click()
    page.wait_for_selector("[data-testid=device-trainer][data-tone=ok]", timeout=10000)
    page.get_by_role("button", name="Pair handlebar controls").click()
    page.wait_for_selector("text=76 %", timeout=10000)
    # One shift press: a message came through, so the row reads live.
    page.evaluate("window.__fakeRide.notify('15')")
    page.evaluate("window.__fakeRide.notify('23 08 ff bf ff ff 0f')")
    page.evaluate("window.__fakeRide.notify('23 08 ff ff ff ff 0f')")
    page.wait_for_selector("[data-testid=device-handlebar][data-tone=ok]", timeout=10000)
    # Let toasts fade before the shot.
    page.wait_for_timeout(4200)
    page.mouse.move(0, 0)


RECTS = """() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  return { ride: r('[data-testid=devices-ride]'), trainer: r('[data-testid=device-trainer]'),
           handlebar: r('[data-testid=device-handlebar]'), hr: r('[data-testid=device-heart-rate]'),
           h1: r('h1'), vh: innerHeight };
}"""


def main() -> None:
    only = set(filter(None, os.environ.get("ONLY", "").split(",")))
    results: dict = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in common.VIEWPORTS:
            for theme in common.THEMES:
                name = common.shot_name(SCREEN, vp, theme)
                if only and name not in only:
                    continue
                ctx, page = open_page(browser, vp, theme, {"granted": True})
                mockup_state(page)
                path = common.save(page, SCREEN, vp, theme)
                m = common.measure(page)
                m["rects"] = page.evaluate(RECTS)
                m["tones"] = {t: tone(page, t) for t in ("device-trainer", "device-handlebar", "device-heart-rate")}
                m["errors"] = page.errors
                results[name] = m
                print(path.name, json.dumps(m))
                ctx.close()

        extras = [
            ("devices-empty-1440.jpg", "1440", {"granted": False}, None),
            ("devices-error-1440.jpg", "1440", {"granted": True}, "error"),
            ("devices-nobt-390.jpg", "390", {"noBluetooth": True}, None),
        ]
        for name, vp, fake, mode in extras:
            if only and name not in only:
                continue
            ctx, page = open_page(browser, vp, "day", fake)
            if mode == "error":
                mockup_state(page)
                page.get_by_role("button", name="Pair heart rate monitor via Bluetooth").click()
                page.wait_for_selector("[data-testid=device-heart-rate][data-tone=error]", timeout=10000)
                page.wait_for_timeout(300)
            common.OUT.mkdir(parents=True, exist_ok=True)
            from PIL import Image
            import io
            png = page.screenshot(type="png")
            Image.open(io.BytesIO(png)).convert("RGB").save(common.OUT / name, "JPEG", quality=84, optimize=True, progressive=True)
            m = common.measure(page)
            m["rects"] = page.evaluate(RECTS)
            m["errors"] = page.errors
            results[name] = m
            print(name, json.dumps(m))
            ctx.close()
        browser.close()
    if not only:
        common.record(SCREEN, results)


if __name__ == "__main__":
    main()
