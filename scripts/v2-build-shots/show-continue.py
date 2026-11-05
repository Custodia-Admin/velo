#!/usr/bin/env python3
"""P2.3 build shots: the show chooser when "Continue" can't carry on.

`continueLastShow` says why (src/lib/show/continueShow.ts) and the chooser
puts that in one sentence, with choosing again as its one filled button
(ShowPanel.tsx `continueFailureText`; review of PR #36 @bbe04db, D4).

Staged with real File System Access handles, no picker: a folder "Episodes"
with three empty .webm files is made in the page's origin-private file system
(navigator.storage.getDirectory(); its handles store in IndexedDB like a
picked folder's), remembered with `rememberFolder` / `rememberHandles`, then:

  denied        the folder; Chrome's permission answer is "denied" (the
                prompt's No: queryPermission/requestPermission stubbed, the
                one fake here)
  missing       the folder, deleted after it was remembered
  done          the folder, with its last episode watched to the end
  files-denied  the three files (not a folder), Chrome says "denied"

The ride starts token-free from Home (Assisi valley), show mode opens from
the ride details, the chooser's Continue is clicked, and the chooser is shot
with the sentence showing. Needs a DEV server (staging imports the modules):

    BASE=http://localhost:5196 uv run --with playwright --with pillow \
        python scripts/v2-build-shots/show-continue.py [vp ...]

Writes docs/design/screenshots/v2/build/show-continue-<state>-<vp>[-night].jpg
and measurements-show-continue.json (panel rect, sentence rect + font size,
which button is filled, document overflow, smallest text and target).
Env: THEMES=day,night, STATES=denied,missing,done,files-denied.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
import scenic_home  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SCREEN = "show-continue"
STATES = os.environ.get("STATES", "denied,missing,done,files-denied").split(",")
PINNED_MS = common.PINNED_MS + 86_400_000  # 2 Nov 2026: Today's ride is Assisi valley.

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

STAGE = """async (state) => {
  const lib = await import('/src/lib/show/showLibrary.ts');
  localStorage.removeItem(lib.LAST_WATCHED_KEY);
  localStorage.removeItem(lib.RESUME_STORAGE_KEY);
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('Episodes', { recursive: true }); } catch (e) {}
  const dir = await root.getDirectoryHandle('Episodes', { create: true });
  const handles = [];
  for (const n of ['Episode 1.webm', 'Episode 2.webm', 'Episode 3.webm']) {
    // Empty files are enough: a failed Continue never plays them.
    handles.push(await dir.getFileHandle(n, { create: true }));
  }
  if (state === 'files-denied') await lib.rememberHandles(handles);
  else await lib.rememberFolder(dir);
  const ep = async (i) => { const f = await handles[i].getFile(); return { key: lib.fileKey(f), name: lib.titleFromFileName(f.name) }; };
  if (state === 'done') {
    lib.markWatched({ ...(await ep(2)), positionS: 1500, durationS: 1500, ended: true });
  } else {
    // Part-way through episode 2: the chooser offers "Continue Episode 2 · 12:34".
    const e2 = await ep(1);
    lib.saveResume({ ...e2, positionS: 754, durationS: 1500 });
    lib.markWatched({ ...e2, positionS: 754, durationS: 1500 });
  }
  if (state === 'missing') await root.removeEntry('Episodes', { recursive: true });
  const P = window.FileSystemHandle && FileSystemHandle.prototype;
  if (P) {
    if (!window.__realPerm) window.__realPerm = { q: P.queryPermission, r: P.requestPermission };
    if (state.endsWith('denied')) {
      P.queryPermission = async function () { return 'prompt'; };
      P.requestPermission = async function () { return 'denied'; };
    } else {
      P.queryPermission = window.__realPerm.q;
      P.requestPermission = window.__realPerm.r;
    }
  }
  return state;
}"""

MEASURE = """() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && el.checkVisibility({ contentVisibilityAuto: true }); };
  const probe = document.createElement('div'); probe.className = 'bg-primary'; document.body.append(probe);
  const primaryBg = getComputedStyle(probe).backgroundColor; probe.remove();
  const chooser = document.querySelector('[data-testid=show-chooser]');
  const panel = document.querySelector('[data-testid=show-panel]');
  const msg = document.querySelector('[data-testid=show-continue-failure]');
  const buttons = chooser ? [...chooser.querySelectorAll('button')].filter(vis).map((b) => ({
    text: (b.getAttribute('aria-label') || b.textContent).trim(), rect: rect(b),
    filled: getComputedStyle(b).backgroundColor === primaryBg })) : [];
  const pr = panel && panel.getBoundingClientRect();
  return {
    panel: rect(panel), panelScroll: panel ? [panel.scrollHeight, panel.clientHeight] : null,
    panelInView: !!pr && pr.top >= 0 && pr.left >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight,
    message: msg ? { reason: msg.dataset.reason, role: msg.getAttribute('role'), text: msg.textContent, rect: rect(msg),
      font: getComputedStyle(msg).fontSize, color: getComputedStyle(msg).color,
      overflow: msg.scrollWidth > msg.clientWidth } : null,
    continueShown: !!document.querySelector('[data-testid=show-continue]'),
    buttons,
    filled: buttons.filter((b) => b.filled).map((b) => b.text),
    canFloat: 'documentPictureInPicture' in window,
  };
}"""


def open_chooser(page) -> None:
    btn = page.locator('button[aria-label="Watch a show while you ride"]').first
    if not btn.is_visible():
        page.locator('button[aria-label^="Show ride details"]').first.evaluate("el => el.click()")
    btn.wait_for(state="visible", timeout=20000)
    btn.evaluate("el => el.click()")
    page.wait_for_selector("[data-testid=show-chooser]", timeout=20000)


def close_chooser(page) -> None:
    page.locator('[data-testid=show-chooser] button[aria-label="Close show"]').first.evaluate("el => el.click()")
    page.wait_for_selector("[data-testid=show-chooser]", state="detached", timeout=10000)


def persistent_page(p, vp: str, theme: str):
    """common.new_page, but in a persistent profile: Chromium 153 crashes when an
    off-the-record context (Playwright's new_context) reads a File System Access
    handle back from IndexedDB."""
    w, h, scale = common.VIEWPORTS[vp]
    gl = os.environ.get("GL")
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(prefix="velo-show-continue-"),
        headless=True,
        executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
        args=gl.split() if gl else common.GPU_ARGS,
        viewport={"width": w, "height": h},
        device_scale_factor=scale,
        is_mobile=vp == "390",
        has_touch=vp == "390",
        service_workers="block",
        timezone_id="Europe/Rome",
        locale="en-GB",
    )
    ctx.add_init_script(common.init_script(common.THEMES[theme], NO_HMR, PINNED_MS))
    common.stage_weather(ctx)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.errors = errors  # type: ignore[attr-defined]
    return ctx, page


def main() -> None:
    vps = sys.argv[1:] or ["1440", "1280", "390", "tv"]
    themes = os.environ.get("THEMES", "day,night").split(",")
    results = {}
    with sync_playwright() as p:
        for vp in vps:
            for theme in themes:
                ctx, page = persistent_page(p, vp, theme)
                page.goto(common.url("/app", vp), wait_until="domcontentloaded", timeout=60000)
                scenic_home.ride_scenic_route(page, "scenic-assisi-valley")
                page.wait_for_url("**/ride**", timeout=30000)
                page.wait_for_selector("[data-world-status=ready]", timeout=120000)
                page.wait_for_timeout(1500)
                for state in STATES:
                    page.evaluate(STAGE, state)
                    open_chooser(page)
                    cont = page.locator("[data-testid=show-continue]")
                    cont.wait_for(state="visible", timeout=15000)
                    label = cont.inner_text()
                    cont.evaluate("el => el.click()")
                    page.wait_for_selector("[data-testid=show-continue-failure]", timeout=15000)
                    common.fonts_ready(page)
                    page.wait_for_timeout(600)
                    info = page.evaluate(MEASURE)
                    m = common.measure(page)
                    name = common.shot_name(f"{SCREEN}-{state}", vp, theme)
                    common.save(page, f"{SCREEN}-{state}", vp, theme)
                    results[name] = {"continueLabel": label, "chooser": info, "measure": m, "errors": page.errors[:5]}
                    print(name, json.dumps(results[name]), flush=True)
                    close_chooser(page)
                ctx.close()
    mp = common.OUT / f"measurements-{SCREEN}.json"
    prev = json.loads(mp.read_text()) if mp.exists() else {}
    prev.update(results)
    common.record(SCREEN, prev)


if __name__ == "__main__":
    main()
