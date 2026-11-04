#!/usr/bin/env python3
"""P2.4 build shots: show mode (docs/design/mockups/v2-show.html).

Staged as mocked (common.py): the fake KICKR is reconnected on /devices, then
Home (/app) -> "Ride and watch" on Today's ride (Assisi valley floor on the
pinned 2 Nov 2026, the mockup's place) -> the file chooser picks a local test
video -> the ride starts token-free with the video playing -> the ride is
staged at the mockup still's spot (3.0 km, 18:05; drone camera, afternoon
light, clear) -> shot with the controls awake, at 1440 / 390 / tv, day and
night. The video size is set to L (the mockup's size). Needs a DEV server.

The File System Access picker is removed in an init script so Playwright's
expect_file_chooser drives the plain <input type=file> fallback (as in
scripts/show-shots.py). The test video is generated, never third-party
footage:

    ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -t 120 \
        -c:v libvpx-vp9 -b:v 600k -an "Episode 4.webm"

    BASE=http://localhost:5183 VIDEO="/path/Episode 4.webm" uv run --with playwright \
        --with pillow python scripts/v2-build-shots/show.py [vp ...]

Env: SETTLE_S (seconds after the video starts, default 20), THEMES=day,night,
LOST=1 (also drop the fake KICKR for real and shoot show-lost-*: the status
chip over the show, no toast card).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SCREEN = "show"
SETTLE_S = float(os.environ.get("SETTLE_S", "12"))
# 2 Nov 2026 16:30 Europe/Rome: Today's ride is Assisi valley floor.
PINNED_MS = common.PINNED_MS + 86_400_000
STAGE = """async () => {
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  const { useSettingsStore } = await import('/src/stores/settingsStore.ts');
  const { useShowStore } = await import('/src/stores/showStore.ts');
  useShowStore.getState().setAutoCamera(false);
  useRideStore.setState({ distance: 3000, elapsedMs: 1085 * 1000 });
  useSettingsStore.getState().setCameraMode('drone');
  window.__veloWorldLight?.set({ time: 'golden', weather: 'clear' });
  return { route: useRideStore.getState().route?.id, conn: useRideStore.getState().connection, light: !!window.__veloWorldLight };
}"""
VIDEO = os.environ.get("VIDEO", "")

INIT = """
try { delete window.showOpenFilePicker; } catch (e) {}
Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
localStorage.setItem('globeride.velo.show.v1', JSON.stringify({ state: { size: 'l' }, version: 1 }));
"""

# Shared dev server: block Vite's HMR socket so another worker's edit can't
# reload the page mid-ride (see ride-hud.py).
NO_HMR = """
(() => {
  const RealWS = window.WebSocket;
  function isHmr(p) { return p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr')); }
  const Fake = function (url, protocols) {
    if (!isHmr(protocols)) return new RealWS(url, protocols);
    return { readyState: 0, url: String(url), protocol: 'vite-hmr', send() {}, close() {},
             addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
  };
  Fake.prototype = RealWS.prototype;
  Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Fake;
})();
"""

STATE = """() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const v = document.querySelector('[data-testid=show-video]');
  const corner = [...document.querySelectorAll('[data-testid=show-toggle]')].find(vis);
  const dbg = window.__veloRideDebug ? window.__veloRideDebug() : null;
  return {
    panel: rect(document.querySelector('[data-testid=show-panel]')),
    controls: rect(document.querySelector('[data-testid=show-controls]')),
    strip: rect(document.querySelector('[data-testid=show-ride-strip]')),
    chip: rect([...document.querySelectorAll('[data-testid=ride-status-chip]')].find(vis)),
    chipText: [...document.querySelectorAll('[data-testid=ride-status-chip]')].find(vis)?.textContent ?? null,
    toastCards: document.querySelectorAll('[aria-label="Notifications"] > *').length,
    corner: corner ? rect(corner) : null,
    camera: rect([...document.querySelectorAll('[data-testid=show-camera]')].find(vis)),
    video: v ? { t: +v.currentTime.toFixed(1), paused: v.paused, w: v.videoWidth } : null,
    title: document.querySelector('[data-testid=show-title]')?.textContent ?? null,
    stripText: document.querySelector('[data-testid=show-ride-strip]')?.innerText.replace(/\\s+/g, ' ') ?? null,
    rider: dbg && dbg.riderScreen ? dbg.riderScreen : null,
    renderer: dbg ? dbg.renderer : null,
  };
}"""


# LOST=1: after the normal shot, the fake KICKR drops for real (as in
# ride-hud.py) and show-lost-<vp>[-night].jpg records the chip over the show.
LOST = os.environ.get("LOST", "0") == "1"
DROP = """async () => {
  const [k] = await navigator.bluetooth.getDevices();
  k.gatt.connect = async () => { throw Object.assign(new Error('fake: out of range'), { name: 'NetworkError' }); };
  k.gatt.connected = false;
  k.dispatchEvent(new Event('gattserverdisconnected'));
  return true;
}"""


def open_show(page, vp):
    common.connect_trainer(page, vp)
    common.go_home_in_app(page)
    btn = page.locator("[data-testid=featured-scenic-ride] [data-testid=ride-and-watch], [data-testid=ride-and-watch]").first
    btn.wait_for(state="visible", timeout=30000)
    page.wait_for_timeout(800)
    with page.expect_file_chooser(timeout=15000) as fc:
        btn.click()
    fc.value.set_files([VIDEO])
    page.wait_for_url("**/ride**", timeout=30000)
    page.wait_for_function(
        "() => { const v = document.querySelector('[data-testid=show-video]'); return v && v.currentTime > 1; }",
        timeout=90000,
    )


def main() -> None:
    assert VIDEO and Path(VIDEO).exists(), "set VIDEO to a local test video"
    vps = sys.argv[1:] or ["1440", "390", "tv"]
    themes = os.environ.get("THEMES", "day,night").split(",")
    results = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in vps:
            for theme in themes:
                ctx, page = common.new_page(browser, vp, theme, INIT + NO_HMR, fake={"granted": True},
                                            pinned_ms=PINNED_MS)
                for attempt in range(3):
                    try:
                        open_show(page, vp)
                        break
                    except Exception as e:  # Home may be mid-edit (shared tree)
                        print(f"  open_show attempt {attempt + 1}: {str(e).splitlines()[0]}", flush=True)
                else:
                    raise SystemExit("could not open show mode")
                page.wait_for_selector('[data-world-status=ready]', timeout=90000)
                page.wait_for_timeout(2000)
                print("  staged", page.evaluate(STAGE), flush=True)
                page.wait_for_timeout(int(SETTLE_S * 1000))
                common.fonts_ready(page)
                w, h, _ = common.VIEWPORTS[vp]
                page.mouse.move(w // 2, h // 2)
                page.mouse.move(w // 2 + 7, h // 2 + 7)
                page.wait_for_timeout(500)
                info = page.evaluate(STATE)
                m = common.measure(page)
                common.save(page, SCREEN, vp, theme)
                name = common.shot_name(SCREEN, vp, theme)
                results[name] = {"measure": m, "state": info, "errors": page.errors[:5]}
                print(name, json.dumps({"measure": m, "errors": page.errors[:3]}))
                print("  state", json.dumps(info))
                if LOST:
                    page.evaluate(DROP)
                    timeline = []
                    for i in range(20):
                        page.wait_for_timeout(1000)
                        st = page.evaluate(STATE)
                        timeline.append([i + 1, st["chipText"], st["toastCards"]])
                        if st["chipText"] and st["chipText"].startswith("Trainer lost") and i >= 12:
                            break
                    print("  lost timeline", json.dumps(timeline), flush=True)
                    page.mouse.move(w // 2, h // 2)
                    page.wait_for_timeout(500)
                    info = page.evaluate(STATE)
                    m = common.measure(page)
                    common.save(page, f"{SCREEN}-lost", vp, theme)
                    name = common.shot_name(f"{SCREEN}-lost", vp, theme)
                    results[name] = {"measure": m, "state": info, "timeline": timeline, "errors": page.errors[:5]}
                    print(name, json.dumps({"measure": m, "errors": page.errors[:3]}))
                    print("  state", json.dumps(info))
                ctx.close()
        browser.close()
    mp = common.OUT / f"measurements-{SCREEN}.json"
    prev = json.loads(mp.read_text()) if mp.exists() else {}
    prev.update(results)
    common.record(SCREEN, prev)


if __name__ == "__main__":
    main()
