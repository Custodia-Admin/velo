"""The trainer-lost toast and its Reconnect button, mid-ride, on a fake KICKR (no real Bluetooth).

Usage (dev server running):
    uv run --with playwright python scripts/ui-shots-trainer-lost-toast.py <out-dir> <base-url>
    BEFORE=1 ...   # a build without the toast action: only the first shot

The fake has no watchAdvertisements, as on the Linux laptop, so the retries
end with "then tap Reconnect". getDevices is faked only so the ride-start
reconnect connects the fake trainer. At 1440 and 390 it writes:
  ride-trainer-lost-toast-<vp>.png   retries ran out: toast + Reconnect
  ride-trainer-lost-retap-<vp>.png   tapped while the trainer is away: offered again
  ride-trainer-reconnected-<vp>.png  tapped with the trainer back
plus measurements.json (button rect, hit test, overflow, connects per tap).
"""
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright  # noqa: E402
from scenic_home import ride_scenic_route  # noqa: E402

out = pathlib.Path(sys.argv[1])
base = sys.argv[2]
out.mkdir(parents=True, exist_ok=True)

INIT = r"""
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
localStorage.setItem('velo.lastTrainer', JSON.stringify({ id: 'kickr-fake', name: 'KICKR CORE 78C1' }));
// Vite HMR off: another worker's edit must not reload the ride mid-shot.
(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, proto) {
    if (String(proto).includes('vite-hmr')) return new EventTarget();
    return new Real(url, proto);
  };
})();
(() => {
  const state = { away: false, connects: 0 };
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
      state.connects++;
      if (state.away) throw Object.assign(new Error('out of range'), { name: 'NetworkError' });
      gatt.connected = true; return gatt;
    },
    disconnect() { gatt.connected = false; },
    async getPrimaryService(u) {
      if (String(u).includes('180f') || u === 0x180f) throw Object.assign(new Error('none'), { name: 'NotFoundError' });
      return { getCharacteristic: async (c) => ch(c) };
    },
  };
  device.gatt = gatt;
  const bt = new EventTarget();
  bt.getAvailability = async () => true;
  bt.requestDevice = async () => { throw Object.assign(new Error('cancelled'), { name: 'NotFoundError' }); };
  bt.getDevices = async () => [device];
  Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true });
  window.__fakeTrainer = {
    state,
    goAway() { state.away = true; gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
    comeBack() { state.away = false; },
  };
})();
"""

VIEWPORTS = {"1440": (1440, 900), "390": (390, 844)}
# JS click: pointer clicks stall in Playwright's stability wait on the
# swiftshader ride page. Still a user gesture.
TAP_RECONNECT = """() => [...document.querySelectorAll('button')]
  .find((b) => b.textContent.trim() === 'Reconnect' && b.offsetParent)?.click()"""
TOAST = "[role=status], [role=alert]"

measure = {}
with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"),
        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    )
    for vp, (w, h) in VIEWPORTS.items():
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="dark")
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        page.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        branch = ride_scenic_route(page, "scenic-perugia-tiber-park")
        page.wait_for_url("**/ride**", timeout=20000, wait_until="commit")
        # The ride-start reconnect connects the fake trainer.
        page.wait_for_function("() => document.body.innerText.includes('KICKR CORE 78C1')", timeout=30000)
        page.wait_for_timeout(4000)
        page.evaluate("() => window.__fakeTrainer.goAway()")
        page.wait_for_function(
            "() => document.body.innerText.includes(\"Couldn't reconnect after several attempts\")", timeout=40000
        )
        page.wait_for_timeout(800)
        info = page.evaluate(
            """() => {
              const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Reconnect');
              const card = b && b.closest('li, [role=status], [role=alert], div.pointer-events-auto') ;
              const r = b?.getBoundingClientRect();
              const c = card?.getBoundingClientRect();
              const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
              return {
                button: r && { x: r.left, y: r.top, w: r.width, h: r.height },
                card: c && { x: c.left, y: c.top, w: c.width, h: c.height },
                hitIsButton: !!(hit && b && (hit === b || b.contains(hit))),
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                text: card?.innerText,
              };
            }"""
        )
        page.screenshot(path=str(out / f"ride-trainer-lost-toast-{vp}.png"))
        if os.environ.get("BEFORE"):
            measure[vp] = {"branch": branch, **info}
            ctx.close()
            continue
        connects_before = page.evaluate("() => window.__fakeTrainer.state.connects")
        # Tap too early: still away -> two quick attempts, the toast comes back.
        page.evaluate(TAP_RECONNECT)
        page.wait_for_function(
            """() => {
              const el = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.includes('Still no trainer'));
              const card = el?.closest('[role=alert],[role=status]');
              return card && parseFloat(getComputedStyle(card).opacity) > 0.99;
            }""",
            timeout=40000,
        )
        page.wait_for_timeout(300)
        early = page.evaluate(
            """() => {
              const el = [...document.querySelectorAll('div')].reverse().find((d) => d.textContent.includes('Still no trainer') && d.children.length === 0);
              const r = el?.getBoundingClientRect();
              const card = el?.closest('[role=alert],[role=status]');
              const cs = card ? getComputedStyle(card) : null;
              return {connects: window.__fakeTrainer.state.connects, back: !!el,
                rect: r && {x: r.left, y: r.top, w: r.width, h: r.height},
                opacity: cs?.opacity, visibility: cs?.visibility, display: cs?.display,
                topEl: r ? document.elementFromPoint(r.left + 5, r.top + 5)?.outerHTML.slice(0, 120) : null};
            }"""
        )
        page.screenshot(path=str(out / f"ride-trainer-lost-retap-{vp}.png"))
        page.evaluate("() => window.__fakeTrainer.comeBack()")
        page.evaluate(TAP_RECONNECT)
        page.wait_for_function("() => document.body.innerText.includes('Trainer reconnected')", timeout=40000)
        page.wait_for_timeout(500)
        page.screenshot(path=str(out / f"ride-trainer-reconnected-{vp}.png"))
        measure[vp] = {
            "branch": branch,
            **info,
            "earlyTapConnects": early["connects"] - connects_before,
            "earlyTapToastBack": early["back"],
        }
        ctx.close()
    browser.close()

(out / "measurements.json").write_text(json.dumps(measure, indent=2))
print(json.dumps(measure, indent=2))
