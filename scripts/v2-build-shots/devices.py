#!/usr/bin/env python3
"""P2.4 build shots: the Devices page (/devices).

    BASE=http://localhost:5182 uv run --with playwright --with pillow python scripts/v2-build-shots/devices.py

Writes docs/design/screenshots/v2/build/devices-<1440|390|tv>[-night].jpg in the
mockup's state as far as honest fakes allow, plus devices-empty-1440.jpg (nothing
paired), devices-error-1440.jpg (heart-rate chooser came up empty) and
devices-nobt-390.jpg (browser without Web Bluetooth).

No hardware, no real Bluetooth: an init script replaces navigator.bluetooth with
fakes (same GATT layouts as scripts/ui-shots-controls.py and
scripts/ui-shots-trainer-reconnect.py). The trainer is a fake granted
"KICKR CORE 78C1" (getDevices) brought back with the row's Reconnect tap; the
handlebar is a fake LEFT "Zwift Ride" (advert byte 08, battery 76 %) paired from
the row's Pair tap, then one shift press so the row reads live. Heart rate
stays unpaired. The store models one controller, so there is no second
(right-side) row to fake.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SCREEN = "devices"

FAKE_BT = r"""
(() => {
  const opts = JSON.parse(localStorage.getItem('fakeDevices') || '{}');
  if (opts.noBluetooth) return;
  if (opts.granted) localStorage.setItem('velo.lastTrainer', JSON.stringify({ id: 'kickr-fake', name: 'KICKR CORE 78C1' }));
  else localStorage.removeItem('velo.lastTrainer');
  const hex = (h) => Uint8Array.from(h.trim().split(/\s+/).map((b) => parseInt(b, 16)));
  class Char extends EventTarget {
    constructor(read) { super(); this.read = read; this.value = undefined; this.writes = [];
      this.properties = { write: true, writeWithoutResponse: true, notify: true }; }
    async startNotifications() { return this; }
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
  const tch = (u) => { if (!tChars.has(u)) tChars.set(u, new Char(0)); return tChars.get(u); };
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


def open_page(browser, vp, theme, fake: dict):
    extra = f"localStorage.setItem('fakeDevices', {json.dumps(json.dumps(fake))});\n" + FAKE_BT
    ctx, page = common.new_page(browser, vp, theme, extra)
    page.goto(common.url("/devices", vp), wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("h1:has-text('Devices')", timeout=30000)
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(600)
    return ctx, page


def tone(page, testid):
    return page.get_attribute(f"[data-testid={testid}]", "data-tone")


def mockup_state(page):
    """Trainer reconnected, left handlebar live with battery, HR unpaired."""
    page.get_by_role("button", name="Reconnect KICKR CORE 78C1").click()
    page.wait_for_selector("[data-testid=device-trainer][data-tone=ok]", timeout=10000)
    page.get_by_role("button", name="Pair handlebar controls").click()
    page.wait_for_selector("text=76 %", timeout=10000)
    # One shift press: a message came through, so the row reads live.
    page.evaluate("window.__fakeRide.notify('15')")
    page.evaluate("window.__fakeRide.notify('23 08 ff bf ff ff 0f')")
    page.evaluate("window.__fakeRide.notify('23 08 ff ff ff ff 0f')")
    page.wait_for_selector("[data-testid=device-handlebar][data-tone=ok]", timeout=10000)
    # Let toasts fade before the shot.
    page.wait_for_timeout(4200)
    page.mouse.move(0, 0)


RECTS = """() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  return { ride: r('[data-testid=devices-ride]'), trainer: r('[data-testid=device-trainer]'),
           handlebar: r('[data-testid=device-handlebar]'), hr: r('[data-testid=device-heart-rate]'),
           h1: r('h1'), vh: innerHeight };
}"""


def main() -> None:
    only = set(filter(None, os.environ.get("ONLY", "").split(",")))
    results: dict = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in common.VIEWPORTS:
            for theme in common.THEMES:
                name = common.shot_name(SCREEN, vp, theme)
                if only and name not in only:
                    continue
                ctx, page = open_page(browser, vp, theme, {"granted": True})
                mockup_state(page)
                path = common.save(page, SCREEN, vp, theme)
                m = common.measure(page)
                m["rects"] = page.evaluate(RECTS)
                m["tones"] = {t: tone(page, t) for t in ("device-trainer", "device-handlebar", "device-heart-rate")}
                m["errors"] = page.errors
                results[name] = m
                print(path.name, json.dumps(m))
                ctx.close()

        extras = [
            ("devices-empty-1440.jpg", "1440", {"granted": False}, None),
            ("devices-error-1440.jpg", "1440", {"granted": True}, "error"),
            ("devices-nobt-390.jpg", "390", {"noBluetooth": True}, None),
        ]
        for name, vp, fake, mode in extras:
            if only and name not in only:
                continue
            ctx, page = open_page(browser, vp, "day", fake)
            if mode == "error":
                mockup_state(page)
                page.get_by_role("button", name="Pair heart rate monitor via Bluetooth").click()
                page.wait_for_selector("[data-testid=device-heart-rate][data-tone=error]", timeout=10000)
                page.wait_for_timeout(300)
            common.OUT.mkdir(parents=True, exist_ok=True)
            from PIL import Image
            import io
            png = page.screenshot(type="png")
            Image.open(io.BytesIO(png)).convert("RGB").save(common.OUT / name, "JPEG", quality=84, optimize=True, progressive=True)
            m = common.measure(page)
            m["rects"] = page.evaluate(RECTS)
            m["errors"] = page.errors
            results[name] = m
            print(name, json.dumps(m))
            ctx.close()
        browser.close()
    if not only:
        common.record(SCREEN, results)


if __name__ == "__main__":
    main()
