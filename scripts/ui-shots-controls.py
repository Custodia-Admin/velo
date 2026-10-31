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

Side / diagnostics cases (fakeRideMode in localStorage; the fake device's
watchAdvertisements emits manufacturer data 0x094A → 08 = left, 07 = right):
  trainer-right-<vp>.png   right controller picked: warning + "Pair the other controller"
  trainer-silent-<vp>.png  left, connected, no message for 10 s: unlock recipe
  ride-right-<vp>.png      in-ride chip on the right controller
  ride-silent-<vp>.png     in-ride chip, silent → Locked + recipe
  ride-debug-<vp>.png      debug overlay (Controller debug on) after presses
  ride-nocontrols-<vp>.png chip before any pairing
Skip them with ONLY=base; run only them with ONLY=diag.
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
  device.name = 'Zwift Ride';
  device.id = 'fake-ride';
  // Left = 0x08, right = 0x07 (real adverts: 08 db f4 / 07 f7 0e). 'noadv' = API missing.
  if (mode !== 'noadv') {
    device.watchAdvertisements = async (o) => {
      setTimeout(() => {
        const ev = new Event('advertisementreceived');
        const side = mode === 'right' ? 0x07 : 0x08;
        ev.manufacturerData = new Map([[0x094a, new DataView(Uint8Array.of(side, 0xdb, 0xf4).buffer)]]);
        device.dispatchEvent(ev);
      }, 120);
    };
  }
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


def js_click(page, text):
    """Click the visible button with this text from JS. On the swiftshader ride
    page Playwright's stability wait (rAF-based) stalls, so pointer clicks time out."""
    page.evaluate(
        """(t) => [...document.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === t && b.offsetParent)?.click()""",
        text,
    )


def click_text(page, text):
    page.get_by_role("button", name=text).first.click()


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"),
        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    )
    only = os.environ.get("ONLY", "")
    for vp, (w, h) in (VIEWPORTS.items() if only != "diag" else []):
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
            page.wait_for_selector("text=Left controller · connected · buzzed · battery 85 %", timeout=8000)
            page.evaluate("window.__fakeRide.notify('15')")
            page.evaluate("window.__fakeRide.notify('23 08 ff ff ff ff 0f')")
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

    def ride_page(page):
        page.get_by_role("button", name=re.compile(r"^Ride ")).first.click()
        page.wait_for_url("**/ride**", timeout=15000, wait_until="commit")
        page.wait_for_timeout(2500)

    def chip_text(page):
        chip = page.locator("[aria-label='Handlebar controls'][role='group']:visible")
        return chip.inner_text().replace("\n", " | ") if chip.count() else "missing"

    def measure(page, vp, name):
        m = page.evaluate("""() => {
          const out = {scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth};
          for (const label of ['Handlebar controls', 'Controller debug']) {
            const el = [...document.querySelectorAll(`[aria-label='${label}'][role='group']`)].find((e) => e.offsetParent);
            if (el) { const r = el.getBoundingClientRect(); out[label] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
          }
          return out; }""")
        print(vp, name, "rects:", m)

    def diag_ctx(vp, mode, debug=False):
        w, h = VIEWPORTS[vp]
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="dark")
        ctx.add_init_script(f"localStorage.setItem('fakeRideMode', '{mode}');")
        if debug:
            ctx.add_init_script(
                "localStorage.setItem('globeride.controllers', JSON.stringify({state:{steeringEnabled:true,debugOverlay:true},version:1}));"
            )
        ctx.add_init_script(INIT)
        ctx.add_init_script("localStorage.setItem('globeride.theme', 'dark');")
        page = ctx.new_page()
        page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(TRAINER, timeout=20000)
        page.wait_for_timeout(1000)
        return ctx, page

    for vp in (VIEWPORTS if only in ("", "diag") and not before else []):
        # Right controller picked.
        ctx, page = diag_ctx(vp, "right")
        click_text(page, "Pair handlebar controls")
        page.wait_for_selector("text=Right controller paired", timeout=8000)
        shot_trainer(page, f"trainer-right-{vp}")
        ride_page(page)
        print(vp, "right chip:", chip_text(page))
        measure(page, vp, "right")
        page.screenshot(path=str(out / f"ride-right-{vp}.png"))
        ctx.close()

        # Left, connected, nothing ever arrives → silent after 10 s.
        ctx, page = diag_ctx(vp, "silent")
        click_text(page, "Pair handlebar controls")
        page.wait_for_selector("text=Left controller · connected · buzzed", timeout=8000)
        page.wait_for_selector("text=probably locked", timeout=15000)
        shot_trainer(page, f"trainer-silent-{vp}")
        ride_page(page)
        # JS click: Playwright's pointer path stalls behind the swiftshader globe at 1440.
        page.evaluate("""() => [...document.querySelectorAll('summary')]
          .filter((e) => e.textContent.includes('How to unlock') && e.offsetParent)
          .forEach((e) => e.click())""")
        page.wait_for_timeout(300)
        print(vp, "silent chip:", chip_text(page))
        measure(page, vp, "silent")
        page.screenshot(path=str(out / f"ride-silent-{vp}.png"))
        ctx.close()

        # Debug overlay on, left controller, presses flow.
        ctx, page = diag_ctx(vp, "ok", debug=True)
        ride_page(page)
        print(vp, "no-controls chip:", chip_text(page))
        page.screenshot(path=str(out / f"ride-nocontrols-{vp}.png"))
        # JS click (user activation still counts for requestDevice); see js_click.
        js_click(page, "Pair controls")
        page.wait_for_timeout(1500)
        for msg in ["15", "15", "19 08 55", "23 08 ff bf ff ff 0f", "23 08 ff ff ff ff 0f",
                    "23 08 ff bf ff ff 0f", "23 08 ff ff ff ff 0f",
                    "23 08 ff ff ff ff 0f 12 06 0a 04 08 01 10 64", "23 08 ff ff ff ff 0f"]:
            page.evaluate(f"window.__fakeRide.notify('{msg}')")
        page.wait_for_timeout(600)
        print(vp, "debug chip:", chip_text(page))
        dbg = page.locator("[aria-label='Controller debug'][role='group']:visible")
        print(vp, "debug overlay:", dbg.inner_text().replace("\n", " | ") if dbg.count() else "missing")
        measure(page, vp, "debug")
        page.screenshot(path=str(out / f"ride-debug-{vp}.png"))
        ctx.close()
    browser.close()
