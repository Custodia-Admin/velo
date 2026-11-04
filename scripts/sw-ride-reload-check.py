#!/usr/bin/env python3
"""Real service-worker check: can a deploy reload the page mid-ride?

Serves two copies of a production build, A and B (B = A with a changed index.html revision in
sw.js and a <meta name="velo-build" content="B"> marker), from one origin, and swaps A -> B while
a headless Chromium (service workers ON, 1280x648 @2) is riding:

  ride      tab rides on A; the deploy (B) lands and is found by an update check mid-ride.
            PASS = no reload while on /ride (the page's marker survives, the ride keeps going,
            B waits); after Exit to Home the page reloads once onto B.
  two-tabs  tab 1 rides on A; tab 2 opens Home after the deploy. Tab 2 must not activate B while
            tab 1 rides; when B is forced active anyway (SKIP_WAITING posted to the waiting
            worker, as an old bundle or another browser would), tab 1 still does not reload
            until it leaves /ride.

    uv run --with playwright python scripts/sw-ride-reload-check.py <dist> [scenario ...]

  transition  B_DIST=<new dist> with <dist> = the build deployed before this change (autoUpdate):
            the old page rides on A, the new build lands. PASS = no reload mid-ride; the old code never
            activates the new (waiting) worker, so the page stays on A after Exit to Home; one hard
            reload loads the new code from the network, which activates the new worker (one reload).

<dist> is a token-free production build (`VITE_CESIUM_ION_TOKEN= npm run build`). Run it against
an old build's dist to see the old behaviour (autoUpdate reloaded the ride).
Env: PORT=4231, PW_CHROMIUM.
"""
from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import socketserver
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

SRC = Path(sys.argv[1]).resolve()
SCENARIOS = sys.argv[2:] or ["ride", "two-tabs"]
PORT = int(os.environ.get("PORT", "4231"))
GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
INIT = """
localStorage.removeItem('globeride.cesiumIonToken');
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
"""


def make_builds(tmp: Path) -> tuple[Path, Path]:
    a, b = tmp / "A", tmp / "B"
    shutil.copytree(SRC, a)
    shutil.copytree(Path(os.environ["B_DIST"]).resolve() if os.environ.get("B_DIST") else SRC, b)
    html = (b / "index.html").read_text()
    (b / "index.html").write_text(html.replace("<head>", '<head>\n    <meta name="velo-build" content="B" />', 1))
    sw = (b / "sw.js").read_text()
    sw2, n = re.subn(r'(url:"index\.html",revision:")([0-9a-f]+)"', r'\1b\2"', sw)
    assert n == 1, "index.html entry not found in sw.js"
    (b / "sw.js").write_text(sw2)
    return a, b


class State:
    root: Path


def serve(state: State) -> socketserver.TCPServer:
    class H(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            p = path.split("?", 1)[0].split("#", 1)[0]
            f = state.root / p.lstrip("/")
            if p == "/" or (not f.exists() and "." not in Path(p).name):
                f = state.root / "index.html"  # SPA fallback
            return str(f)

        def end_headers(self):
            if self.path.split("?")[0] in ("/sw.js", "/", "/index.html") or "." not in Path(self.path.split("?")[0]).name:
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def log_message(self, *a):
            pass

    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def safe(page, js: str, default):
    """Evaluate, tolerating a navigation (a reload destroys the execution context)."""
    for _ in range(20):
        try:
            return page.evaluate(js)
        except Exception:
            time.sleep(0.5)
    return default


def build_of(page) -> str:
    return safe(page, "() => document.querySelector('meta[name=velo-build]')?.content || 'A'", "?")


def marker(page) -> bool:
    return bool(safe(page, "() => window.__swCheckMarker === 1", False))


def controlled_on_a(ctx, base: str):
    page = ctx.new_page()
    page.goto(base + "/app")
    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=60000)
    # Reload only once the first worker is fully activated: then the reloaded page is controlled from
    # its first byte, as a returning rider's page is (a page that gets claimed later looks like a first
    # install to workbox-window, which then never reloads).
    t0 = time.time()
    while not page.evaluate("() => navigator.serviceWorker.getRegistration().then(r => !!(r && r.active && r.active.state === 'activated' && !r.installing))"):
        assert time.time() - t0 < 90, "first service worker never activated"
        time.sleep(0.5)
    # A plain navigation, not page.reload(): Playwright's reload comes back uncontrolled.
    page.goto(base + "/app")
    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=60000)
    assert page.evaluate("() => !!navigator.serviceWorker.controller"), "page not controlled at load"
    return page


def ride(page) -> None:
    card = page.locator('[data-scenic-route="scenic-perugia-tiber-park"]')
    featured = page.get_by_test_id("featured-scenic-ride").get_by_role("button", name="Ride Tiber river park", exact=True)
    card.or_(featured).first.evaluate("el => el.click()")
    page.wait_for_url("**/ride**", timeout=30000)
    page.wait_for_selector('[aria-label="Pause ride"]', state="attached", timeout=90000)
    page.evaluate("() => { window.__swCheckMarker = 1; }")


def ride_distance(page) -> float:
    v = safe(page, "() => (window.__veloRideDebug?.() ?? {}).distance ?? null", 0)
    return float(v or 0)


def waiting(page) -> bool:
    return bool(safe(page, "() => navigator.serviceWorker.getRegistration().then(r => !!(r && r.waiting))", False))


def exit_to_home(page) -> None:
    page.locator('[aria-label="Exit ride and return to setup"]').first.evaluate("el => el.click()")


def scenario_ride(browser, base: str, state: State, a: Path, b: Path) -> dict:
    state.root = a
    ctx = browser.new_context(viewport={"width": 1280, "height": 648}, device_scale_factor=2)
    ctx.add_init_script(INIT)
    page = controlled_on_a(ctx, base)
    ride(page)
    d0 = ride_distance(page)
    state.root = b  # deploy
    page.evaluate("() => navigator.serviceWorker.getRegistration().then(r => r.update())")
    t0 = time.time()
    while time.time() - t0 < 60 and marker(page) and not waiting(page):
        time.sleep(0.5)
    found_waiting = marker(page) and waiting(page)
    time.sleep(10)  # mid-ride, after the deploy finished installing
    mid = {"markerKept": marker(page), "build": build_of(page), "url": page.url, "waiting": waiting(page) if marker(page) else None,
           "distanceAdvanced": ride_distance(page) > d0}
    reloaded_mid_ride = not mid["markerKept"]
    after = {}
    if not reloaded_mid_ride:
        exit_to_home(page)
        try:
            page.wait_for_function("() => document.querySelector('meta[name=velo-build]')?.content === 'B'", timeout=30000)
        except Exception:
            pass
        page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=60000)
        after = {"build": build_of(page), "url": page.url, "markerKept": marker(page)}
    ctx.close()
    ok = (not reloaded_mid_ride) and found_waiting and mid["distanceAdvanced"] and after.get("build") == "B"
    return {"PASS": ok, "deployWaitingMidRide": found_waiting, "midRide": mid, "reloadedMidRide": reloaded_mid_ride,
            "afterExitToHome": after}


def scenario_two_tabs(browser, base: str, state: State, a: Path, b: Path) -> dict:
    state.root = a
    ctx = browser.new_context(viewport={"width": 1280, "height": 648}, device_scale_factor=2)
    ctx.add_init_script(INIT)
    t1 = controlled_on_a(ctx, base)
    ride(t1)
    state.root = b
    t2 = ctx.new_page()
    t2.goto(base + "/app")  # tab 2 registers -> finds B -> must not activate it while tab 1 rides
    t2.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=60000)
    t0 = time.time()
    while time.time() - t0 < 60 and not waiting(t2):
        time.sleep(0.5)
    time.sleep(3)
    step1 = {"waiting": waiting(t2), "tab1MarkerKept": marker(t1), "tab2Build": build_of(t2)}
    # Force it (an old bundle or another browser would): tab 1 must still not reload mid-ride.
    t2.evaluate("() => navigator.serviceWorker.getRegistration().then(r => r.waiting && r.waiting.postMessage({ type: 'SKIP_WAITING' }))")
    time.sleep(8)
    step2 = {"tab1MarkerKept": marker(t1), "tab1Url": t1.url, "tab1Build": build_of(t1)}
    after = {}
    if step2["tab1MarkerKept"]:
        exit_to_home(t1)
        try:
            t1.wait_for_function("() => document.querySelector('meta[name=velo-build]')?.content === 'B'", timeout=30000)
        except Exception:
            pass
        after = {"tab1Build": build_of(t1), "tab1MarkerKept": marker(t1)}
    ctx.close()
    ok = step1["waiting"] and step1["tab1MarkerKept"] and step2["tab1MarkerKept"] and after.get("tab1Build") == "B"
    return {"PASS": ok, "tab2FoundDeployButWaited": step1, "afterForcedActivation": step2, "tab1AfterExitToHome": after}


def scenario_transition(browser, base: str, state: State, a: Path, b: Path) -> dict:
    state.root = a
    ctx = browser.new_context(viewport={"width": 1280, "height": 648}, device_scale_factor=2)
    ctx.add_init_script(INIT)
    page = controlled_on_a(ctx, base)
    ride(page)
    state.root = b
    page.evaluate("() => navigator.serviceWorker.getRegistration().then(r => r.update())")
    t0 = time.time()
    while time.time() - t0 < 60 and marker(page) and not waiting(page):
        time.sleep(0.5)
    time.sleep(8)
    mid = {"markerKept": marker(page), "waiting": waiting(page), "url": page.url}
    exit_to_home(page)
    time.sleep(6)
    home = {"markerKept": marker(page), "build": build_of(page)}
    # Ctrl+Shift+R: a reload that bypasses the cache and the service worker.
    ctx.new_cdp_session(page).send("Page.reload", {"ignoreCache": True})
    t0 = time.time()
    while time.time() - t0 < 40 and build_of(page) != "B":
        time.sleep(0.5)
    hard = {"build": build_of(page), "waiting": waiting(page),
            "controlled": bool(safe(page, "() => !!navigator.serviceWorker.controller", False))}
    # The hard-reloaded page runs the new code uncontrolled (it activated the new worker); the next
    # load is controlled by it.
    page.goto(base + "/app")
    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=60000)
    nxt = {"build": build_of(page), "controlled": bool(safe(page, "() => !!navigator.serviceWorker.controller", False))}
    ctx.close()
    ok = mid["markerKept"] and mid["waiting"] and hard["build"] == "B" and not hard["waiting"] and nxt == {"build": "B", "controlled": True}
    hard["nextLoad"] = nxt
    return {"PASS": ok, "midRide": mid, "afterExitToHome": home, "afterOneHardReload": hard}


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="sw-check-", dir=os.environ.get("TMPDIR")))
    a, b = make_builds(tmp)
    state = State()
    state.root = a
    srv = serve(state)
    base = f"http://127.0.0.1:{PORT}"
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"), args=GPU)
        for s in SCENARIOS:
            fn = {"ride": scenario_ride, "two-tabs": scenario_two_tabs, "transition": scenario_transition}[s]
            try:
                results[s] = fn(browser, base, state, a, b)
            except Exception as e:
                results[s] = {"PASS": False, "error": str(e)[:400]}
            print(s, json.dumps(results[s]), flush=True)
        browser.close()
    srv.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps({"dist": str(SRC), "results": results}, indent=1))


if __name__ == "__main__":
    main()
