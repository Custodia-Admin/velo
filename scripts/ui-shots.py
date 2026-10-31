"""Render Velo's home + route picker at 1440 and 390 for the design gate.

Usage (dev server already running):
    uv run --with playwright python scripts/ui-shots.py <out-dir> [base-url]

Writes home-*.png, route-picker-*.png and routes-tab-*.png for 1440x900 and
390x844 (full page, dark theme, onboarding dismissed). Uses the system
Chromium at /usr/sbin/chromium; set CHROMIUM=/path to override.
"""
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173"
out.mkdir(parents=True, exist_ok=True)

# Zustand persist envelope for the onboarding store (version must match).
INIT = """
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
"""

VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}

OPEN_ROUTE_PICKER = """() => {
  const d = document.querySelector('details[data-build-your-own]');
  if (d) d.open = true;
  const btn = [...document.querySelectorAll('button')].find(b => /Choose your route/i.test(b.textContent || ''));
  if (btn) { btn.click(); btn.scrollIntoView(); return 'opened'; }
  return 'not-found';
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"),
        args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
    )
    for vp, (w, h) in VIEWPORTS.items():
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="dark")
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(out / f"home-{vp}.png"), full_page=True)

        state = page.evaluate(OPEN_ROUTE_PICKER)
        page.wait_for_timeout(1500)
        page.screenshot(path=str(out / f"route-picker-{vp}.png"), full_page=True)

        page.goto(f"{base}/app?tab=routes", wait_until="domcontentloaded", timeout=60000)
        # Lazy route catalogs; wait for scenic cards when present (after P2a).
        try:
            page.wait_for_selector("[data-scenic-route]", timeout=8000)
        except Exception:
            pass
        page.wait_for_timeout(2500)
        page.screenshot(path=str(out / f"routes-tab-{vp}.png"), full_page=True)
        print(vp, "route picker:", state)
        ctx.close()
    browser.close()
