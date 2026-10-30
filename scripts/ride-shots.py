"""Render the ride view with live weather for the design gate.

Usage (dev server already running):
    uv run --with playwright python scripts/ride-shots.py <out-dir> [base-url] [route-id]

Opens Home, clicks the scenic route card (default: Lugano lakefront), lets
the ride start in Demo Mode (no trainer, no Bluetooth), waits for live weather
and Cesium tiles, then writes ride-1440.png and ride-390.png. Also prints the
weather chip text and the conditions Open-Meteo returned. Uses the system
Chromium at /usr/sbin/chromium; set CHROMIUM=/path to override.

Env:
    LIVE=0        render with live weather switched off (the route's canned mood)
    GL=swiftshader  software WebGL instead of the host GPU via Vulkan
    SETTLE_MS     wait after the ride starts (default 25000)
    CLOCK         ISO time for the page clock (e.g. 2026-10-30T14:00:00+01:00) so
                  real-sun moods render in daylight; weather is still fetched live
    PREFIX        output file prefix (default "ride")
"""
import datetime
import json
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173"
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-lugano-melide"
out.mkdir(parents=True, exist_ok=True)

LIVE = os.environ.get("LIVE", "1") != "0"
INIT = """
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
""" + ("" if LIVE else """
localStorage.setItem('globeride.settings.v1', JSON.stringify({state:{liveWeatherEnabled:false},version:1}));
""")
SUFFIX = "" if LIVE else "-canned"
PREFIX = os.environ.get("PREFIX", "ride")
CLOCK = os.environ.get("CLOCK")
GL_ARGS = {
    "vulkan": ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"],
    "swiftshader": ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
}[os.environ.get("GL", "vulkan")]

VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"),
        args=GL_ARGS,
    )
    for vp, (w, h) in VIEWPORTS.items():
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="dark")
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        if CLOCK:
            page.clock.set_system_time(datetime.datetime.fromisoformat(CLOCK))
        meteo = []
        page.on("response", lambda r: meteo.append(r.url) if "open-meteo" in r.url else None)
        page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(f"[data-scenic-route='{route_id}']", timeout=20000)
        page.click(f"[data-scenic-route='{route_id}']")
        page.wait_for_url("**/ride**", timeout=20000)
        try:
            page.wait_for_selector("[data-testid='ride-weather-chip']", timeout=20000)
        except Exception:
            pass
        # Tiles, clouds and particles need a while under SwiftShader.
        page.wait_for_timeout(int(os.environ.get("SETTLE_MS", "25000")))
        page.screenshot(path=str(out / f"{PREFIX}{SUFFIX}-{vp}.png"))
        chip = page.evaluate(
            "() => [...document.querySelectorAll('[data-testid=ride-weather-chip]')].map(e => e.getAttribute('aria-label'))"
        )
        cache = page.evaluate("() => localStorage.getItem('globeride.velo.weather.v1')")
        print(vp, "chip:", chip, "meteo requests:", len(meteo))
        if cache:
            for k, v in json.loads(cache).items():
                wx = v["weather"]
                print("  ", k, "code", wx["weatherCode"], "temp", wx["temperatureC"], "wind", wx["windSpeedMs"], "from", wx["windFromDeg"], "vis", wx["visibilityM"], "at", wx["observedAt"])
        ctx.close()
    browser.close()
