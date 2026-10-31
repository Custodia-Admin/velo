"""Render show mode (P2b) for the design gate and check it end to end.

Usage (dev or preview server already running):
    uv run --with playwright python scripts/show-shots.py <out-dir> <video> [<video> ...]
Env:
    BASE        server URL (default http://localhost:5173)
    GL          vulkan (default, host GPU) | swiftshader
    SETTLE_MS   wait after the ride starts for tiles (default 20000)
    CLOCK       ISO time for the page clock so real-sun moods render in daylight
    ONLY        comma list of widths to render (default 1440,390)
    THEME       dark (default) | light; light files get a "-light" suffix
    SHORT=1     skip the drone wait and the finish/.FIT step

For each width: opens Home, presses "Ride and watch" on today's ride, picks the
given local video files in the file chooser (the File System Access picker is
removed so Playwright can drive the plain <input type=file> path), lets the
ride start in Demo Mode (no trainer, no Bluetooth), then writes:
    show-playing-<w>.png   controls awake
    show-dimmed-<w>.png    after 5 s without input (HUD faded, controls hidden)
    show-drone-<w>.png     ~60 s into show mode (auto camera on the drone shot)
    show-chooser-<w>.png   show mode toggled off and on again (choose state)
    show-finished-1440.png ride finished, .FIT exported
and prints the video position, ride stats and the exported .FIT size.
"""
import datetime
import json
import os
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
videos = [str(pathlib.Path(v).resolve()) for v in sys.argv[2:]]
assert videos, "pass at least one video file"
base = os.environ.get("BASE", "http://localhost:5173")
out.mkdir(parents=True, exist_ok=True)

THEME = os.environ.get("THEME", "dark")
SFX = "" if THEME == "dark" else f"-{THEME}"
SHORT = os.environ.get("SHORT") == "1"
INIT = f"localStorage.setItem('globeride.theme', '{THEME}');" + """
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
try { delete window.showOpenFilePicker; } catch (e) {}
Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
"""
GL_ARGS = {
    "vulkan": ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"],
    "swiftshader": ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
}[os.environ.get("GL", "vulkan")]
VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}
ONLY = os.environ.get("ONLY", "1440,390").split(",")
CLOCK = os.environ.get("CLOCK")
SETTLE_MS = int(os.environ.get("SETTLE_MS", "20000"))

STATE_JS = """() => {
  const v = document.querySelector('[data-testid=show-video]');
  const strip = [...document.querySelectorAll('[data-testid=show-ride-strip]')].find(e => e.offsetParent);
  const panel = document.querySelector('[data-testid=show-panel]');
  const r = panel ? panel.getBoundingClientRect() : null;
  return {
    video: v ? { t: +v.currentTime.toFixed(1), paused: v.paused, ready: v.readyState, w: v.videoWidth } : null,
    title: document.querySelector('[data-testid=show-title]')?.textContent ?? null,
    strip: strip ? strip.innerText.replace(/\\s+/g, ' ') : null,
    camera: document.querySelector('[data-testid=show-camera]')?.textContent ?? null,
    controlsVisible: !!document.querySelector('[data-testid=show-controls]')?.offsetParent,
    panel: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  };
}"""


def wake(page, w, h):
    page.mouse.move(w // 2, h // 2)
    page.mouse.move(w // 2 + 5, h // 2 + 5)
    page.wait_for_timeout(400)


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"),
        args=GL_ARGS,
    )
    for vp, (w, h) in VIEWPORTS.items():
        if vp not in ONLY:
            continue
        ctx = browser.new_context(
            viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=THEME, accept_downloads=True
        )
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        page.on("dialog", lambda d: d.accept())
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if CLOCK:
            page.clock.set_system_time(datetime.datetime.fromisoformat(CLOCK))
        page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("[data-testid=ride-and-watch]", timeout=30000)
        page.screenshot(path=str(out / f"home-{vp}{SFX}.png"), full_page=True)

        with page.expect_file_chooser() as fc:
            page.click("[data-testid=ride-and-watch]")
        fc.value.set_files(videos)
        page.wait_for_url("**/ride**", timeout=20000)
        t0 = time.time()
        page.wait_for_function(
            "() => { const v = document.querySelector('[data-testid=show-video]'); return v && v.currentTime > 1; }",
            timeout=60000,
        )
        page.wait_for_timeout(SETTLE_MS)
        wake(page, w, h)
        s1 = page.evaluate(STATE_JS)
        page.screenshot(path=str(out / f"show-playing-{vp}{SFX}.png"))
        print(vp, "playing", json.dumps(s1))

        page.wait_for_timeout(5500)
        s2 = page.evaluate(STATE_JS)
        page.screenshot(path=str(out / f"show-dimmed-{vp}{SFX}.png"))
        print(vp, "dimmed", json.dumps(s2))

        if not SHORT:
            # Auto camera: chase for the first 45 s, then the drone shot.
            remaining = 60 - (time.time() - t0)
            if remaining > 0:
                page.wait_for_timeout(int(remaining * 1000))
            s3 = page.evaluate(STATE_JS)
            page.screenshot(path=str(out / f"show-drone-{vp}{SFX}.png"))
            print(vp, "drone", json.dumps(s3), "show elapsed ~", round(time.time() - t0), "s")

        wake(page, w, h)
        page.click("[data-testid=show-toggle]")
        page.wait_for_timeout(300)
        page.click("[data-testid=show-toggle]")
        page.wait_for_selector("[data-testid=show-chooser]", timeout=5000)
        page.wait_for_timeout(500)
        page.screenshot(path=str(out / f"show-chooser-{vp}{SFX}.png"))
        print(vp, "chooser", json.dumps(page.evaluate(STATE_JS)))

        # Picture-in-picture guidance, then the PiP bar.
        page.click("[data-testid=show-chooser] summary")
        page.wait_for_timeout(400)
        page.screenshot(path=str(out / f"show-pip-help-{vp}{SFX}.png"))
        page.click("text=Use picture-in-picture")
        page.wait_for_selector("[data-testid=show-pip-bar]", timeout=5000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(out / f"show-pip-bar-{vp}{SFX}.png"))

        if vp == "1440" and not SHORT:
            page.click("[aria-label='Finish ride']")
            page.wait_for_selector("[aria-label='Download ride as .FIT file']", timeout=10000)
            with page.expect_download() as dl:
                page.click("[aria-label='Download ride as .FIT file']")
            path = dl.value.path()
            print(vp, "fit", dl.value.suggested_filename, os.path.getsize(path), "bytes")
            page.wait_for_timeout(800)
            page.screenshot(path=str(out / f"show-finished-{vp}{SFX}.png"))
        resume = page.evaluate("() => localStorage.getItem('globeride.velo.showResume.v1')")
        print(vp, "resume", resume)
        print(vp, "page errors", errors[:5])
        ctx.close()
    browser.close()
