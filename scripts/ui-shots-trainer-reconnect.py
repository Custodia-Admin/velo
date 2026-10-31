"""Trainer reconnect without the chooser, on a fake granted KICKR (no real Bluetooth).

Usage (dev server or preview running):
    uv run --with playwright python scripts/ui-shots-trainer-reconnect.py <out-dir> [base-url]

The page gets a fake navigator.bluetooth whose getDevices() returns a
"KICKR CORE 78C1" with a minimal FTMS GATT layout, and localStorage says it
was the trainer paired last. Writes, at 1440 and 390:
  trainer-reconnect-<vp>.png         Home → Trainer offers "Reconnect KICKR CORE 78C1"
  trainer-reconnect-failed-<vp>.png  trainer out of reach: sentence + chooser fallback
  trainer-reconnected-<vp>.png       after the tap: connected, LIVE
and prints the connection pill text after opening a ride with the grant
(silent reconnect on Ride start: no DEMO MODE). Uses /usr/sbin/chromium.
"""
import os
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173"
out.mkdir(parents=True, exist_ok=True)

INIT = r"""
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
localStorage.setItem('velo.lastTrainer', JSON.stringify({ id: 'kickr-fake', name: 'KICKR CORE 78C1' }));
(() => {
  const mode = localStorage.getItem('fakeTrainerMode') || 'ok';
  class Char extends EventTarget {
    constructor() { super(); this.value = undefined; this.writes = []; }
    async startNotifications() { return this; }
    async writeValueWithResponse(b) { this.writes.push(Array.from(new Uint8Array(b.buffer || b))); }
    async writeValue(b) { return this.writeValueWithResponse(b); }
    async readValue() { return new DataView(Uint8Array.of(88).buffer); }
  }
  const chars = new Map();
  const ch = (u) => { if (!chars.has(u)) chars.set(u, new Char()); return chars.get(u); };
  const device = new EventTarget();
  device.id = 'kickr-fake';
  device.name = 'KICKR CORE 78C1';
  const gatt = {
    connected: false, device,
    async connect() {
      if (mode === 'away') throw Object.assign(new Error('out of range'), { name: 'NetworkError' });
      gatt.connected = true; return gatt;
    },
    disconnect() { gatt.connected = false; },
    async getPrimaryService() { return { getCharacteristic: async (u) => ch(u) }; },
  };
  device.gatt = gatt;
  const bt = new EventTarget();
  bt.getAvailability = async () => true;
  bt.requestDevice = async () => { throw Object.assign(new Error('cancelled'), { name: 'NotFoundError' }); };
  bt.getDevices = async () => [device];
  Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true });
  window.__fakeTrainer = { writes: () => [...chars.values()].map((c) => c.writes) };
})();
"""

VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}
TRAINER = "section[aria-labelledby='trainer-panel-title']"


def shot_trainer(page, name):
    page.locator(TRAINER).scroll_into_view_if_needed()
    page.wait_for_timeout(400)
    box = page.evaluate(
        """(sel) => { const r = document.querySelector(sel).getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; }""",
        TRAINER,
    )
    page.screenshot(path=str(out / f"{name}.png"), full_page=True, clip=box)


def js_click(page, pattern):
    page.evaluate(
        """(p) => [...document.querySelectorAll('button')]
          .find((b) => new RegExp(p).test(b.textContent.trim()) && b.offsetParent)?.click()""",
        pattern,
    )


def new_page(browser, w, h, mode):
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="dark")
    ctx.add_init_script(f"localStorage.setItem('fakeTrainerMode', '{mode}');")
    ctx.add_init_script(INIT)
    page = ctx.new_page()
    page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector(TRAINER, timeout=20000)
    page.wait_for_timeout(1200)
    return ctx, page


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"),
        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    )
    for vp, (w, h) in VIEWPORTS.items():
        ctx, page = new_page(browser, w, h, "ok")
        page.wait_for_selector("text=Reconnect KICKR CORE 78C1", timeout=5000)
        shot_trainer(page, f"trainer-reconnect-{vp}")
        js_click(page, "^Reconnect KICKR")
        page.wait_for_selector("text=Streaming", timeout=8000)
        shot_trainer(page, f"trainer-reconnected-{vp}")
        print(vp, "after tap:", page.locator(TRAINER).inner_text().split("\n")[:4])
        ctx.close()

        ctx, page = new_page(browser, w, h, "away")
        js_click(page, "^Reconnect KICKR")
        page.wait_for_selector("text=Could not reach it", timeout=30000)
        shot_trainer(page, f"trainer-reconnect-failed-{vp}")
        ctx.close()

        # Silent reconnect when a ride starts (the reload-mid-session case).
        ctx, page = new_page(browser, w, h, "ok")
        page.get_by_role("button", name=re.compile(r"^Ride ")).first.click()
        page.wait_for_url("**/ride**", timeout=15000, wait_until="commit")
        page.wait_for_timeout(3000)
        body = page.evaluate("document.body.innerText")
        print(vp, "ride start: DEMO MODE shown:", "DEMO MODE" in body.upper(), "| KICKR shown:", "KICKR CORE 78C1" in body)
        page.screenshot(path=str(out / f"ride-reconnected-{vp}.png"))
        ctx.close()
    browser.close()
