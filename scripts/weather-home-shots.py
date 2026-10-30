"""Home with live weather, for the P2c design gate.

Usage (dev or preview server already running):
    uv run --with playwright python scripts/weather-home-shots.py <out-dir> [base-url]

Writes, at 1440x900 and 390x844 (full page):
    home-<vp>.png          dark theme, live weather from Open-Meteo
    home-light-<vp>.png    light theme, live weather
    home-loading-<vp>.png  weather request held open (skeleton lines)
    home-offline-<vp>.png  Open-Meteo unreachable (offline line + Retry)
    home-off-<vp>.png      live weather switched off (cards without weather)
Uses the system Chromium at /usr/sbin/chromium; set CHROMIUM=/path to override.
"""
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173"
out.mkdir(parents=True, exist_ok=True)

ONBOARDED = "localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));"
NO_CACHE = "localStorage.removeItem('globeride.velo.weather.v1');"
LIGHT = "localStorage.setItem('globeride.theme', 'light');"
DARK = "localStorage.setItem('globeride.theme', 'dark');"
LIVE_OFF = "localStorage.setItem('globeride.settings.v1', JSON.stringify({state:{liveWeatherEnabled:false},version:1}));"

VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}

# name -> (init script, open-meteo handling: None | 'abort' | 'hold')
SHOTS = {
    "home": (DARK, None),
    "home-light": (LIGHT, None),
    "home-loading": (DARK, "hold"),
    "home-offline": (DARK, "abort"),
    "home-off": (DARK + LIVE_OFF, None),
}

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"))
    for vp, (w, h) in VIEWPORTS.items():
        for name, (init, meteo) in SHOTS.items():
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
            ctx.add_init_script(ONBOARDED + NO_CACHE + init)
            if meteo == "abort":
                ctx.route("**/api.open-meteo.com/**", lambda route: route.abort("internetdisconnected"))
            elif meteo == "hold":
                ctx.route("**/api.open-meteo.com/**", lambda route: None)  # never answered
            page = ctx.new_page()
            page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_selector("[data-scenic-route]", timeout=20000)
            page.wait_for_timeout(3500)
            page.screenshot(path=str(out / f"{name}-{vp}.png"), full_page=True)
            line = page.evaluate(
                "() => { const f = document.querySelector('[data-testid=featured-scenic-ride]'); return f ? f.innerText.split('\\n').filter(l => /Now|Weather|°/.test(l)).join(' | ') : ''; }"
            )
            print(vp, name, "->", line)
            ctx.close()
    browser.close()
