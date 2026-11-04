"""Shared helpers for the P2.4 build shots (scripts/v2-build-shots/<screen>.py).

Every screen script renders the BUILT app at the three design-gate viewports
and both themes, with the same conventions as scripts/v2-mockup-shots.py:

  1440  = 1440x900  @1x
  1280  = 1280x648  @2x (the OWNER'S LAPTOP: Chrome on a 2560x1600 panel at
          scale 2 -> 1280x648 CSS px. Short and wide: the tightest landscape
          gate, everything above the fold must fit here without page scroll)
  390   = 390x844   @2x (phone; mobile + touch)
  tv    = 1920x1080 @1x with ?layout=tv (html[data-layout="tv"], 1rem = 28 px)

Output: docs/design/screenshots/v2/build/<screen>-<1440|1280|390|tv>[-night].jpg
(override the directory with OUT=<dir> while iterating). Then
`uv run --with pillow python scripts/v2-build-shots/compare.py` pairs each
build shot with docs/design/screenshots/v2/mockup/<same name>.jpg.

Run against a dev or preview server: BASE=http://localhost:5173 (default).
Headless Chromium on the real GPU (Intel Arc via ANGLE/Vulkan); the world
renderer needs it for the ride screens. Override with PW_CHROMIUM.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("OUT", REPO / "docs/design/screenshots/v2/build"))
BASE = os.environ.get("BASE", "http://localhost:5173").rstrip("/")
# "1280" is the owner's laptop (see the module docstring): a first-class gate viewport.
VIEWPORTS = {"1440": (1440, 900, 1), "1280": (1280, 648, 2), "390": (390, 844, 2), "tv": (1920, 1080, 1)}
THEMES = {"day": "light", "night": "dark"}
GPU_ARGS = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]

# The day the mockups show (Today's ride = Tiber river park on 1 Nov 2026),
# late afternoon. Date is shifted, timers still run (the ride loop needs them).
PINNED_MS = 1793547000000  # 2026-11-01T16:30:00+01:00 (Europe/Rome)


def init_script(theme: str, extra: str = "", pinned_ms: int = PINNED_MS) -> str:
    return f"""
(() => {{
  const shift = {pinned_ms} - Date.now();
  const RealDate = Date;
  class PinnedDate extends RealDate {{
    constructor(...a) {{ if (a.length === 0) super(RealDate.now() + shift); else super(...a); }}
    static now() {{ return RealDate.now() + shift; }}
  }}
  globalThis.Date = PinnedDate;
}})();
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({{state:{{hasSeenOnboarding:true}},version:2}}));
localStorage.setItem('globeride.theme', {json.dumps(theme)});
localStorage.removeItem('globeride.cesiumIonToken');
if (!localStorage.getItem('globeride.velo.riders.v1')) {{
  localStorage.setItem('globeride.velo.riders.v1', JSON.stringify({{state:{{activeRiderId:'rider-1', riders:[
    {{id:'rider-1', name:'Federico', settings:null, profile:null}},
    {{id:'rider-2', name:'Rider 2', settings:null, profile:null}}
  ]}}, version:1}}));
}}
{extra}
"""


# ---------------------------------------------------------------------------
# Staging (P2.4 rework): the build is shot in the mockups' state, so the
# composites compare design, not demo placeholders. Honest fakes only: a
# granted "KICKR CORE 78C1" + a LEFT Zwift Ride over a fake navigator.bluetooth
# (no hardware), Open-Meteo answered locally with one fixed reading, and the
# world pinned to golden hour. localStorage 'fakeDevices' = JSON options:
# {granted, noBluetooth, ftms}.
# ---------------------------------------------------------------------------

FAKE_BT = r"""
(() => {
  const opts = JSON.parse(localStorage.getItem('fakeDevices') || '{}');
  if (opts.noBluetooth) return;
  if (opts.granted) localStorage.setItem('velo.lastTrainer', JSON.stringify({ id: 'kickr-fake', name: 'KICKR CORE 78C1' }));
  else localStorage.removeItem('velo.lastTrainer');
  const hex = (h) => Uint8Array.from(h.trim().split(/\s+/).map((b) => parseInt(b, 16)));
  class Char extends EventTarget {
    constructor(read, uuid) { super(); this.read = read; this.uuid = String(uuid || ''); this.value = undefined; this.writes = [];
      this.properties = { write: true, writeWithoutResponse: true, notify: true }; }
    async startNotifications() {
      // Staged trainer data (FTMS Indoor Bike Data): speed + cadence + power,
      // 4 Hz, like a KICKR. opts.ftms = hex frame; default 24.6 km/h, 142 W
      // (no cadence field: the mockup strip has no cadence figure).
      if (this.uuid.includes('2ad2') && !this.feed) {
        const frame = opts.ftms || '40 00 9c 09 8e 00';
        this.feed = setInterval(() => this.notify(frame), 250);
      }
      return this;
    }
    async writeValue(b) { this.writes.push(Array.from(new Uint8Array(b.buffer || b))); }
    async writeValueWithResponse(b) { return this.writeValue(b); }
    async writeValueWithoutResponse(b) { return this.writeValue(b); }
    async readValue() { return new DataView(Uint8Array.of(this.read || 0).buffer); }
    notify(h) { const b = hex(h); this.value = new DataView(b.buffer); this.dispatchEvent(new Event('characteristicvaluechanged')); }
  }
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const isBattery = (u) => u === 0x180f || u === 'battery_service' || String(u).startsWith('0000180f');

  // Trainer: granted in an earlier session (mains powered: no battery service).
  const tChars = new Map();
  const tch = (u) => { if (!tChars.has(u)) tChars.set(u, new Char(0, u)); return tChars.get(u); };
  const kickr = new EventTarget();
  kickr.id = 'kickr-fake'; kickr.name = 'KICKR CORE 78C1';
  const kgatt = { connected: false, device: kickr,
    async connect() { kgatt.connected = true; return kgatt; },
    disconnect() { kgatt.connected = false; },
    async getPrimaryService(u) { if (isBattery(u)) throw notFound(); return { getCharacteristic: async (c) => tch(c) }; } };
  kickr.gatt = kgatt;

  // Left Zwift Ride handlebar (advert type byte 0x08), battery 76 %.
  const asyncCh = new Char(), rx = new Char(), tx = new Char(), bas = new Char(76);
  const rChars = {
    '00000002-19ca-4651-86e5-fa29dcdd09d1': asyncCh,
    '00000003-19ca-4651-86e5-fa29dcdd09d1': rx,
    '00000004-19ca-4651-86e5-fa29dcdd09d1': tx,
  };
  const ride = new EventTarget();
  ride.name = 'Zwift Ride'; ride.id = 'fake-ride';
  ride.watchAdvertisements = async () => {
    setTimeout(() => {
      const ev = new Event('advertisementreceived');
      ev.manufacturerData = new Map([[0x094a, new DataView(Uint8Array.of(0x08, 0xdb, 0xf4).buffer)]]);
      ride.dispatchEvent(ev);
    }, 120);
  };
  const rgatt = { connected: false, device: ride,
    async connect() { rgatt.connected = true; return rgatt; },
    disconnect() { rgatt.connected = false; },
    async getPrimaryService(u) {
      if (u === '0000fc82-0000-1000-8000-00805f9b34fb') return { getCharacteristic: async (c) => rChars[c] };
      if (isBattery(u)) return { getCharacteristic: async () => bas };
      throw notFound();
    } };
  ride.gatt = rgatt;

  const bt = new EventTarget();
  bt.getAvailability = async () => true;
  bt.getDevices = async () => (opts.granted ? [kickr] : []);
  bt.requestDevice = async (o) => {
    const wantsHr = JSON.stringify(o || {}).includes('0000180d');
    if (wantsHr) throw Object.assign(new Error('No devices found.'), { name: 'NotFoundError' });
    if (JSON.stringify(o || {}).includes('Zwift') || (o && o.acceptAllDevices)) return ride;
    throw Object.assign(new Error('User cancelled the requestDevice() chooser.'), { name: 'NotFoundError' });
  };
  Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true });
  window.__fakeRide = { notify: (h) => asyncCh.notify(h) };
})();
"""


# Open-Meteo "current" block for every requested point: clear, 14 °C, 2.4 m/s.
WEATHER = {"time": "2026-11-01T16:30", "interval": 900, "temperature_2m": 14.0, "is_day": 1,
           "weather_code": 0, "precipitation": 0.0, "snowfall": 0.0, "cloud_cover": 5,
           "wind_speed_10m": 2.4, "wind_direction_10m": 250, "wind_gusts_10m": 4.1, "visibility": 30000}


def stage_weather(ctx) -> None:
    """Answer every Open-Meteo request with WEATHER (one entry per requested point)."""
    from urllib.parse import parse_qs, urlparse

    def handle(route):
        q = parse_qs(urlparse(route.request.url).query)
        lats = (q.get("latitude") or ["0"])[0].split(",")
        lons = (q.get("longitude") or ["0"])[0].split(",")
        locs = [{"latitude": float(a), "longitude": float(b), "current": WEATHER} for a, b in zip(lats, lons)]
        body = json.dumps(locs if len(locs) > 1 else locs[0])
        route.fulfill(status=200, content_type="application/json", body=body,
                      headers={"access-control-allow-origin": "*"})

    ctx.route("**/api.open-meteo.com/**", handle)


FONTS_READY = """async () => {
  await document.fonts.ready;
  await document.fonts.load('600 16px "Source Serif 4 Variable"');
  return document.fonts.check('600 16px "Source Serif 4 Variable"');
}"""


def fonts_ready(page) -> None:
    if not page.evaluate(FONTS_READY):
        raise RuntimeError("Source Serif 4 did not load")


def connect_trainer(page, vp: str) -> None:
    """Pair state as mocked: /devices -> Reconnect KICKR CORE 78C1 -> trainer connected."""
    page.goto(url("/devices", vp), wait_until="domcontentloaded", timeout=60000)
    page.get_by_role("button", name="Reconnect KICKR CORE 78C1").click()
    page.wait_for_selector("[data-testid=device-trainer][data-tone=ok]", timeout=15000)


def go_home_in_app(page) -> None:
    """Back to Home with client-side navigation (keeps the trainer connected)."""
    page.locator("header button:has-text('Home')").first.evaluate("el => el.click()")
    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=30000)
    # Let the "connected" toast fade before any shot.
    try:
        page.wait_for_selector('[aria-label="Dismiss notification"]', state="detached", timeout=9000)
    except Exception:
        pass


def launch(p):
    return p.chromium.launch(
        headless=True,
        executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
        args=GPU_ARGS,
    )


def new_page(browser, vp: str, theme_key: str, extra_init: str = "", fake: dict | None = None,
             pinned_ms: int = PINNED_MS):
    w, h, scale = VIEWPORTS[vp]
    ctx = browser.new_context(
        viewport={"width": w, "height": h},
        device_scale_factor=scale,
        is_mobile=vp == "390",
        has_touch=vp == "390",
        service_workers="block",
        timezone_id="Europe/Rome",
        locale="en-GB",
    )
    if fake is not None:
        extra_init = f"localStorage.setItem('fakeDevices', {json.dumps(json.dumps(fake))});\n" + FAKE_BT + extra_init
    ctx.add_init_script(init_script(THEMES[theme_key], extra_init, pinned_ms))
    stage_weather(ctx)
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.errors = errors  # type: ignore[attr-defined]
    return ctx, page


def url(path: str, vp: str) -> str:
    sep = "&" if "?" in path else "?"
    return f"{BASE}{path}{sep}layout={'tv' if vp == 'tv' else 'default'}"


def shot_name(screen: str, vp: str, theme_key: str) -> str:
    return f"{screen}-{vp}{'-night' if theme_key == 'night' else ''}.jpg"


def save(page, screen: str, vp: str, theme_key: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    png = page.screenshot(type="png")
    path = OUT / shot_name(screen, vp, theme_key)
    Image.open(io.BytesIO(png)).convert("RGB").save(path, "JPEG", quality=84, optimize=True, progressive=True)
    return path


MEASURE = """() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
  let minFont = 1e9, minFontEl = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode; if (!t.textContent.trim()) continue;
    const el = t.parentElement; if (!el || !vis(el) || el.closest('[aria-hidden="true"]')) continue;
    const f = parseFloat(getComputedStyle(el).fontSize);
    if (f < minFont) { minFont = f; minFontEl = t.textContent.trim().slice(0, 40); }
  }
  let minTarget = 1e9, minTargetEl = '';
  for (const el of document.querySelectorAll('button, a[href], [role=radio], [role=switch]')) {
    if (!vis(el)) continue; const h = el.getBoundingClientRect().height;
    if (h < minTarget) { minTarget = h; minTargetEl = (el.getAttribute('aria-label') || el.textContent).trim().slice(0, 40); }
  }
  const backdrop = [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e);
    return (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none'); }).length;
  return { overflow: document.documentElement.scrollWidth > innerWidth, scrollWidth: document.documentElement.scrollWidth,
           minFont, minFontEl, minTarget: Math.round(minTarget), minTargetEl, backdrop,
           tv: document.documentElement.getAttribute('data-layout') === 'tv',
           dark: document.documentElement.classList.contains('dark') };
}"""


def measure(page) -> dict:
    return page.evaluate(MEASURE)


def record(screen: str, results: dict) -> None:
    """Write this screen's measurements to OUT/measurements-<screen>.json."""
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"measurements-{screen}.json").write_text(json.dumps(results, indent=1, sort_keys=True))
