#!/usr/bin/env python3
"""Build shots: TV mode (P3.3), driven like a TV: keys only after pairing.

Mockups: docs/design/mockups/ (tv-* states in scripts/v2-mockup-shots.py). One
browser per viewport + theme walks the remote flow and shoots each state with
the mockup's name, so compare.py pairs them:

  tv-devices          /devices, trainer reconnected, the ring on Ride (lands there)
  tv-home             Back (Escape) -> Home, the ring on Ride (lands there)
  tv-ride-hud         Enter -> riding (staged as ride-hud.py), ArrowDown rings Pause
  tv-ride-hud-open    -> -> Enter opens the details; arrows up to the camera button
  tv-ride-hud-paused  Escape closes the details; <- <- Enter pauses, the ring on Resume
  tv-finish           -> Enter finishes, the ring on Home (lands there)
  tv-settings         Enter -> Home; Settings -> Visual, the ring on Layout: TV
  tv-devices-legend   /devices with the (fake) Zwift Ride paired: down to the handlebar row,
                      left to "What the buttons do", Enter opens it (riding, show, menus)

The browser context has touch and no mouse (no fine pointer), so the TV layout
turns on by itself at 1920x1080 (the auto rule; no ?layout=). tv4k is a
browser that reports the full 3840x2160: the same picture, sharper.

The dashed frame is the 5 % overscan line (a harness overlay, the mockups'
?safe=1), drawn on every TV shot except settings/legend.

At 1440 and 1280 (laptop, mouse) only tv-settings is shot (the Layout row in
the standard layout); the other screens' 1440 / 1280 shots come from their own
scripts (home.py, finish.py, devices.py, ride-hud.py).

    BASE=http://localhost:5191 uv run --with playwright --with pillow \\
        python scripts/v2-build-shots/tv.py [tv tv4k 1440 1280]

Needs a DEV server (BASE): the ride staging imports /src/stores/*.ts.
Env: THEMES=day,night, RIDE_S (default 8), LEGEND_ONLY=1 (just tv-devices-legend), OUT=<dir>.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from PIL import Image  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

_spec = importlib.util.spec_from_file_location("ride_hud", Path(__file__).resolve().parent / "ride-hud.py")
ride_hud = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ride_hud)  # type: ignore[union-attr]

VIEWPORTS = {"tv": (1920, 1080), "tv4k": (3840, 2160), "1440": (1440, 900), "1280": (1280, 648)}
SCALE = {"1280": 2}
RIDE_S = float(os.environ.get("RIDE_S", "8"))

SAFE_ON = """() => { const d = document.createElement('div'); d.id = '__safe';
  Object.assign(d.style, { position: 'fixed', inset: '5vh 5vw', zIndex: 2147483647, pointerEvents: 'none',
    border: '2px dashed hsl(var(--destructive) / 0.8)' }); document.body.appendChild(d); }"""
SAFE_OFF = "() => document.getElementById('__safe')?.remove()"

FOCUS = """() => { const e = document.activeElement; if (!e || e === document.body) return null;
  const s = getComputedStyle(e); const r = e.getBoundingClientRect();
  return { label: (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 60), outline: s.outlineStyle + ' ' + s.outlineWidth,
           rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
           layout: document.documentElement.getAttribute('data-layout'), rootFont: getComputedStyle(document.documentElement).fontSize }; }"""

# Every control's box against the overscan frame (5 % each edge).
FRAME = """() => { const W = innerWidth, H = innerHeight; const out = [];
  for (const el of document.querySelectorAll('button, a[href], [role=radio], [tabindex="0"]')) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || r.bottom < 0 || r.top > H) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (r.left < W * 0.05 - 0.5 || r.right > W * 0.95 + 0.5 || r.top < H * 0.05 - 0.5 || r.bottom > H * 0.95 + 0.5)
      out.push({ what: (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
  }
  return out; }"""


def new_page(browser, vp: str, theme: str):
    w, h = VIEWPORTS[vp]
    tv = vp.startswith("tv")
    ctx = browser.new_context(
        viewport={"width": w, "height": h},
        device_scale_factor=SCALE.get(vp, 1),
        has_touch=tv,  # a TV browser: no fine pointer, so the auto rule applies
        service_workers="block",
        timezone_id="Europe/Rome",
        locale="en-GB",
    )
    extra = f"localStorage.setItem('fakeDevices', {json.dumps(json.dumps({'granted': True}))});\n" + common.FAKE_BT + ride_hud.NO_HMR
    ctx.add_init_script(common.init_script(common.THEMES[theme], extra))
    common.stage_weather(ctx)
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.errors = errors  # type: ignore[attr-defined]
    return ctx, page


def focus_label(page) -> str:
    f = page.evaluate(FOCUS)
    return f["label"] if f else ""


def key(page, k: str, wait: int = 250) -> None:
    page.keyboard.press(k)
    page.wait_for_timeout(wait)


def ring_on(page, pattern: str, what: str, timeout_ms: int = 10000) -> dict:
    """Wait until the focused control's label matches `pattern`; raise with what it is on instead."""
    t0 = time.time()
    while True:
        f = page.evaluate(FOCUS)
        if f and re.search(pattern, f["label"]):
            return f
        if (time.time() - t0) * 1000 > timeout_ms:
            raise RuntimeError(f"{what}: ring on {f!r}, expected /{pattern}/")
        page.wait_for_timeout(200)


def toasts_gone(page) -> None:
    try:
        page.wait_for_selector('[aria-label="Dismiss notification"]', state="detached", timeout=9000)
    except Exception:
        pass


def shoot(page, screen: str, vp: str, theme: str, results: dict, safe: bool = True) -> None:
    common.fonts_ready(page)
    page.wait_for_timeout(300)
    if safe and vp.startswith("tv"):
        page.evaluate(SAFE_ON)
    png = page.screenshot(type="png")
    if safe and vp.startswith("tv"):
        page.evaluate(SAFE_OFF)
    common.OUT.mkdir(parents=True, exist_ok=True)
    name = common.shot_name(screen, vp, theme)
    Image.open(io.BytesIO(png)).convert("RGB").save(common.OUT / name, "JPEG", quality=84, optimize=True, progressive=True)
    m = common.measure(page)
    focus = page.evaluate(FOCUS)
    outside = page.evaluate(FRAME) if vp.startswith("tv") else []
    results[name] = {"measure": m, "focus": focus, "outsideOverscan": outside, "errors": page.errors[:5]}
    print(name, json.dumps({"focus": focus, "outsideOverscan": outside, "minFont": m["minFont"], "minTarget": m["minTarget"],
                            "overflow": m["overflow"], "tv": m["tv"], "errors": page.errors[:3]}), flush=True)


def walk_tv(page, vp: str, theme: str, results: dict) -> None:
    # Devices: pairing is a Bluetooth chooser (a tap by design); the harness presses Reconnect.
    page.goto(f"{common.BASE}/devices", wait_until="domcontentloaded", timeout=60000)
    page.get_by_role("button", name="Reconnect KICKR CORE 78C1").evaluate("el => el.click()")
    page.wait_for_selector("[data-testid=device-trainer][data-tone=ok]", timeout=15000)
    toasts_gone(page)
    ring_on(page, r"^Ride", "devices")
    shoot(page, "tv-devices", vp, theme, results)

    # From here on keys only (a TV remote's D-pad, OK and Back).
    key(page, "Escape", 800)
    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=30000)
    page.wait_for_function("() => !document.querySelector('[data-testid=featured-scenic-ride] .animate-pulse')", timeout=8000)
    ring_on(page, r"^Ride (?!.*and watch)", "home")
    shoot(page, "tv-home", vp, theme, results)

    key(page, "Enter")
    page.wait_for_url("**/ride**", timeout=30000)
    page.wait_for_selector('[aria-label="Pause ride"]', state="attached", timeout=90000)
    page.wait_for_selector("[data-world-status=ready]", timeout=90000)
    page.wait_for_timeout(3000)
    print("  staged", page.evaluate(ride_hud.STAGE, [ride_hud.STAGE_M, ride_hud.STAGE_S, ride_hud.TIME]), flush=True)
    page.wait_for_timeout(int(RIDE_S * 1000))
    key(page, "ArrowDown")
    ring_on(page, r"^Pause ride$", "ride: first arrow")
    shoot(page, "tv-ride-hud", vp, theme, results)

    key(page, "ArrowRight")
    key(page, "ArrowRight")
    ring_on(page, r"^Show ride details", "band")
    key(page, "Enter", 1200)
    page.wait_for_selector("[data-testid=ride-details]", timeout=10000)
    for _ in range(4):
        if re.search(r"camera", focus_label(page), re.I):
            break
        key(page, "ArrowUp")
    ring_on(page, r"(?i)camera", "details: up to the camera button", 2000)
    shoot(page, "tv-ride-hud-open", vp, theme, results)

    key(page, "Escape", 600)
    ring_on(page, r"^Show ride details", "details closed")
    key(page, "ArrowLeft")
    key(page, "ArrowLeft")
    ring_on(page, r"^Pause ride$", "band back")
    key(page, "Enter", 800)
    ring_on(page, r"^Resume ride$", "paused")
    shoot(page, "tv-ride-hud-paused", vp, theme, results)

    key(page, "ArrowRight")
    ring_on(page, r"^Finish ride$", "paused: finish")
    key(page, "Enter", 1500)
    page.wait_for_selector("[data-testid=finish-screen]", timeout=15000)
    toasts_gone(page)
    ring_on(page, r"^Home$", "finish")
    shoot(page, "tv-finish", vp, theme, results)

    key(page, "Enter", 1000)
    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=30000)
    ring_on(page, r"^Ride (?!.*and watch)", "home again")
    settings(page, vp, theme, results)


def settings(page, vp: str, theme: str, results: dict) -> None:
    """Settings -> Visual with the ring on Layout: TV; then Controls (the legend)."""
    page.get_by_role("button", name="Open settings").first.evaluate("el => el.click()")
    page.wait_for_selector('[role=dialog][aria-label="Rider settings"]', timeout=10000)
    page.locator('[role=tab]:has-text("Visual")').evaluate("el => el.click()")
    page.wait_for_selector('[role=radiogroup] [role=radio]:has-text("Standard")', timeout=10000)
    # The ring on Auto, then one press right: TV (as a remote reaches it).
    page.keyboard.press("Shift")  # remote input on (a key), nothing moves
    page.locator('[role=radio]:has-text("Auto")').evaluate("el => el.focus()")
    page.locator('[role=radio]:has-text("Auto")').evaluate("el => el.scrollIntoView({ block: 'center' })")
    key(page, "ArrowRight")
    ring_on(page, r"^TV", "settings: layout")
    shoot(page, "tv-settings", vp, theme, results, safe=False)
    if vp.startswith("tv"):
        legend(page, vp, theme, results)


def legend(page, vp: str, theme: str, results: dict) -> None:
    """The handlebar row's "What the buttons do" on /devices, opened with the keys."""
    page.goto(f"{common.BASE}/devices", wait_until="domcontentloaded", timeout=60000)
    page.get_by_role("button", name="Pair handlebar controls").evaluate("el => el.click()")
    page.wait_for_selector("text=76 %", timeout=10000)
    page.evaluate("window.__fakeRide.notify('15')")
    page.evaluate("window.__fakeRide.notify('23 08 ff ff ff ff 0f')")
    page.wait_for_selector("[data-testid=device-handlebar][data-tone=ok]", timeout=10000)
    toasts_gone(page)
    # Ride -> Reconnect -> Test buzz -> Disconnect (the handlebar row), then left: the legend.
    for _ in range(6):
        if focus_label(page) == "Disconnect":
            break
        key(page, "ArrowDown")
    ring_on(page, r"^Disconnect$", "devices: handlebar row", 2000)
    key(page, "ArrowLeft")
    ring_on(page, r"^What the buttons do", "devices: legend", 2000)
    key(page, "Enter", 500)
    page.locator("text=Menus: Home, Devices").first.evaluate("el => el.scrollIntoView({ block: 'center' })")
    page.wait_for_timeout(400)
    shoot(page, "tv-devices-legend", vp, theme, results)


def main() -> None:
    vps = sys.argv[1:] or ["tv", "tv4k", "1440", "1280"]
    themes = os.environ.get("THEMES", "day,night").split(",")
    results: dict = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in vps:
            for theme in themes:
                ctx, page = new_page(browser, vp, theme)
                t0 = time.time()
                if vp.startswith("tv") and os.environ.get("LEGEND_ONLY"):
                    legend(page, vp, theme, results)
                elif vp.startswith("tv"):
                    walk_tv(page, vp, theme, results)
                else:
                    page.goto(f"{common.BASE}/app", wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=30000)
                    settings(page, vp, theme, results)
                print(f"  {vp}/{theme} {round(time.time() - t0)} s", flush=True)
                ctx.close()
        browser.close()
    mp = common.OUT / "measurements-tv.json"
    prev = json.loads(mp.read_text()) if mp.exists() else {}
    prev.update(results)
    common.record("tv", prev)


if __name__ == "__main__":
    main()
