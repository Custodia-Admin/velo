"""Screenshot the Settings → Visual → Camera section (distance picker) from the
ride view at 1440 and 390. Demo Mode only; nothing is paired.
Usage: uv run --with playwright python scripts/settings-shots.py <out-dir> [base]
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4173"
GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/sbin/chromium", args=GPU)
    for vp, (w, h) in {"1440": (1440, 900), "390": (390, 844)}.items():
        ctx = b.new_context(viewport={"width": w, "height": h}, color_scheme="dark", service_workers="block",
                            is_mobile=vp == "390", has_touch=vp == "390")
        ctx.add_init_script("localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));"
                            "localStorage.setItem('globeride.settings.v1', JSON.stringify({state:{liveWeatherEnabled:false},version:1}));")
        pg = ctx.new_page()
        pg.goto(f"{base}/app", wait_until="domcontentloaded")
        pg.wait_for_selector("[data-scenic-route='scenic-lugano-melide']")
        pg.evaluate("() => document.querySelector(\"[data-scenic-route='scenic-lugano-melide']\").click()")
        pg.wait_for_url("**/ride**")
        pg.wait_for_timeout(6000)
        # The in-app "open settings" event (what NoTokenBanner uses), straight to Visual.
        pg.evaluate("() => window.dispatchEvent(new CustomEvent('globeride:open-settings', { detail: { tab: 'visual' } }))")
        group = pg.get_by_role("radiogroup", name="Distance")
        group.scroll_into_view_if_needed()
        pg.wait_for_timeout(500)
        checked = group.get_by_role("radio", checked=True).inner_text()
        pg.screenshot(path=str(out / f"settings-camera-{vp}.png"))
        group.get_by_role("radio", name="Close").click()
        pg.wait_for_timeout(300)
        after = pg.evaluate("() => JSON.parse(localStorage.getItem('globeride.settings.v1')).state.cameraDistance")
        print(vp, "default checked:", checked, "| after clicking Close, persisted:", after, flush=True)
        ctx.close()
    b.close()
