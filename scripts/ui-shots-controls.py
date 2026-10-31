"""Render the handlebar-controls UI at 1440 and 390 for the design gate (P2d).

Usage (dev server already running):
    uv run --with playwright python scripts/ui-shots-controls.py <out-dir> [base-url] [--before]

The page gets a fake navigator.bluetooth that behaves like a Ride V2 left
controller (same GATT layout as src/lib/controllers/rideController.test.ts),
so the real pairing code runs end to end in the browser: chooser → RideOn
handshake → battery → button messages. Nothing touches real Bluetooth.

Writes trainer-<state>-<vp>.png for idle / connected / locked (and with
--before only trainer-idle, for the pre-change build), plus ride-chip-<vp>.png
after two shift-up presses on a scenic route. Dark theme; connected also in
light. Uses /usr/sbin/chromium; set CHROMIUM=/path to override.
"""
import os
import re
import pathlib
import sys

from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith("--")]
before = "--before" in sys.argv
out = pathlib.Path(args[0])
base = args[1] if len(args) > 1 else "http://localhost:5173"
out.mkdir(parents=True, exist_ok=True)

INIT = r"""
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
(() => {
  const mode = localStorage.getItem('fakeRideMode') || 'ok';
  const hex = (h) => Uint8Array.from(h.trim().split(/\s+/).map((b) => parseInt(b, 16)));
  class Char extends EventTarget {
    constructor(read) { super(); this.read = read; this.value = undefined; this.writes = [];
      this.properties = { write: true, writeWithoutResponse: true, notify: true }; }
    async startNotifications() { return this; }
    async writeValue(b) { this.writes.push(Array.from(new Uint8Array(b.buffer || b))); }
    async writeValueWithoutResponse(b) { return this.writeValue(b); }
    async readValue() { return new DataView(Uint8Array.of(this.read || 0).buffer); }
    notify(h) { const b = hex(h); this.value = new DataView(b.buffer); this.dispatchEvent(new Event('characteristicvaluechanged')); }
  }
  const asyncCh = new Char(), rx = new Char(), tx = new Char(), bas = new Char(85);
  const chars = {
    '00000002-19ca-4651-86e5-fa29dcdd09d1': asyncCh,
    '00000003-19ca-4651-86e5-fa29dcdd09d1': rx,
    '00000004-19ca-4651-86e5-fa29dcdd09d1': tx,
  };
  const device = new EventTarget();
  device.name = 'Handlebar test device';
  device.id = 'fake-ride';
  const gatt = {
    connected: false, device,
    async connect() { gatt.connected = true; return gatt; },
    disconnect() { gatt.connected = false; },
    async getPrimaryService(u) {
      if (u === '0000fc82-0000-1000-8000-00805f9b34fb' && mode !== 'locked') return { getCharacteristic: async (c) => chars[c] };
      if (u === 0x180f) return { getCharacteristic: async () => bas };
      throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
    },
  };
  device.gatt = gatt;
  const bt = new EventTarget();
  bt.getAvailability = async () => true;
  bt.requestDevice = async () => device;
  bt.getDevices = async () => [];
  Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true });
  window.__fakeRide = { notify: (h) => asyncCh.notify(h), writes: () => rx.writes };
})();
"""

VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}

TRAINER = "section[aria-labelledby='trainer-panel-title']"


def shot_trainer(page, name):
    el = page.locator(TRAINER)
    el.scroll_into_view_if_needed()
    page.wait_for_timeout(400)
    # Element shots clip to the viewport on tall panels; clip a full-page shot instead.
    box = page.evaluate(
        """(sel) => { const r = document.querySelector(sel).getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; }""",
        TRAINER,
    )
    page.screenshot(path=str(out / f"{name}.png"), full_page=True, clip=box)


def click_text(page, text):
    page.get_by_role("button", name=text).first.click()


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"),
        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    )
    for vp, (w, h) in VIEWPORTS.items():
        for scheme in (["dark"] if before else ["dark", "light"]):
            suffix = vp if scheme == "dark" else f"light-{vp}"
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme)
            ctx.add_init_script(INIT)
            ctx.add_init_script(
                f"localStorage.setItem('globeride.theme', '{scheme}');"
            )
            page = ctx.new_page()
            page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_selector(TRAINER, timeout=20000)
            page.wait_for_timeout(1500)
            shot_trainer(page, f"trainer-idle-{suffix}")
            if before:
                ctx.close()
                continue

            click_text(page, "Pair handlebar controls")
            page.wait_for_selector("text=Connected · battery 85 %", timeout=5000)
            page.evaluate("window.__fakeRide.notify('15')")
            page.locator("summary", has_text="What the buttons do").click()
            shot_trainer(page, f"trainer-connected-{suffix}")

            if scheme == "dark":
                # Ride page: two shift-up presses, check the chip and that the
                # RideOn handshake + buzzes went to the controller only.
                page.get_by_role("button", name=re.compile(r"^Ride ")).first.click()
                page.wait_for_url("**/ride**", timeout=15000, wait_until="commit")
                page.wait_for_timeout(2500)
                for _ in range(2):
                    page.evaluate("window.__fakeRide.notify('23 08 ff bf ff ff 0f')")
                    page.evaluate("window.__fakeRide.notify('23 08 ff ff ff ff 0f')")
                page.evaluate("window.__fakeRide.notify('23 08 fd ff ff ff 0f')")  # D-pad up: hills +5 %
                page.evaluate("window.__fakeRide.notify('23 08 ff ff ff ff 0f')")
                page.wait_for_timeout(800)
                chip = page.locator("[aria-label='Handlebar controls'][role='group']:visible")
                print(vp, "chip:", chip.inner_text().replace("\n", " ") if chip.count() else "missing")
                print(vp, "writes:", page.evaluate("window.__fakeRide.writes().map(w => w.map(b => b.toString(16).padStart(2,'0')).join(' '))"))
                page.screenshot(path=str(out / f"ride-chip-{vp}.png"))
            ctx.close()

            if scheme == "dark":
                ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme)
                ctx.add_init_script("localStorage.setItem('fakeRideMode', 'locked');")
                ctx.add_init_script(INIT)
                page = ctx.new_page()
                page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
                page.wait_for_selector(TRAINER, timeout=20000)
                page.wait_for_timeout(1000)
                click_text(page, "Pair handlebar controls")
                page.wait_for_selector("text=Locked", timeout=5000)
                shot_trainer(page, f"trainer-locked-{vp}")
                ctx.close()
    browser.close()
