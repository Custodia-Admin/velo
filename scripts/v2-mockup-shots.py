#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright", "pillow"]
# ///
"""Velo v2 identity mockups: render every screen at 1440x900, 390x844 and 1920x1080 (TV).

Usage (from the repo root):

    uv run --with playwright --with pillow python scripts/v2-mockup-shots.py [--only home,ride-hud] [--themes day,night]

Serves docs/design/ over a local http.server (no network), opens
docs/design/mockups/v2-<screen>.html in headless Chromium (/usr/sbin/chromium,
override with CHROMIUM) and writes viewport-sized JPGs to
docs/design/screenshots/v2/mockup/<screen>-<1440|390|tv>[-night].jpg.
390 renders at device scale 2 (like a phone). TV is 1920x1080 at scale 1;
the mockup kit sets data-layout="tv" at >= 1600 px (1rem = 28 px).

For each shot it also prints measurements used by the vision review:
  overflow   document scrollWidth > viewport width (horizontal scroll)
  minFont    smallest computed font-size of visible text, in CSS px
  minTarget  smallest height of a visible button / link / radio, in CSS px
"""
from __future__ import annotations

import argparse
import functools
import http.server
import io
import json
import os
import threading
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[1]
DESIGN = REPO / "docs/design"
OUT = DESIGN / "screenshots/v2/mockup"
SCREENS = ["home", "ride-hud", "devices", "show", "finish"]
VIEWPORTS = {"1440": (1440, 900, 1), "390": (390, 844, 2), "tv": (1920, 1080, 1)}

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
  return { overflow: document.documentElement.scrollWidth > innerWidth, scrollWidth: document.documentElement.scrollWidth,
           minFont, minFontEl, minTarget: Math.round(minTarget), minTargetEl,
           layout: document.documentElement.getAttribute('data-layout') || 'default',
           rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize) };
}"""


def serve(root: Path):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--themes", default="day,night")
    ap.add_argument("--viewports", default="1440,390,tv")
    args = ap.parse_args()
    screens = [s for s in SCREENS if not args.only or s in args.only.split(",")]
    OUT.mkdir(parents=True, exist_ok=True)
    httpd, port = serve(DESIGN)
    report = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM", "/usr/sbin/chromium"), headless=True)
            for screen in screens:
                for vp in args.viewports.split(","):
                    w, h, dpr = VIEWPORTS[vp]
                    for theme in args.themes.split(","):
                        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr)
                        page = ctx.new_page()
                        errs = []
                        page.on("pageerror", lambda e: errs.append(str(e)))
                        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
                        q = "?theme=night" if theme == "night" else ""
                        page.goto(f"http://127.0.0.1:{port}/mockups/v2-{screen}.html{q}")
                        page.wait_for_function("window.__mockReady === true", timeout=15000)
                        page.evaluate("document.fonts.ready")
                        page.wait_for_load_state("networkidle")
                        m = page.evaluate(MEASURE)
                        png = page.screenshot(full_page=False)
                        name = f"{screen}-{vp}{'-night' if theme == 'night' else ''}.jpg"
                        Image.open(io.BytesIO(png)).convert("RGB").save(OUT / name, "JPEG", quality=84, optimize=True, progressive=True)
                        m.update({"shot": name, "errors": errs})
                        report.append(m)
                        print(f"{name:28s} layout={m['layout']:7s} root={m['rootPx']:.0f}px overflow={m['overflow']} "
                              f"minFont={m['minFont']:.1f}px ({m['minFontEl']!r}) minTarget={m['minTarget']}px ({m['minTargetEl']!r})"
                              + (f" ERR {errs}" if errs else ""))
                        ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
    (OUT / "measurements.json").write_text(json.dumps(report, indent=1) + "\n")
    return 1 if any(r["errors"] or r["overflow"] for r in report) else 0


if __name__ == "__main__":
    raise SystemExit(main())
