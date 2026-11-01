"""Shared helpers for the P2.4 build shots (scripts/v2-build-shots/<screen>.py).

Every screen script renders the BUILT app at the three design-gate viewports
and both themes, with the same conventions as scripts/v2-mockup-shots.py:

  1440  = 1440x900  @1x
  390   = 390x844   @2x (phone; mobile + touch)
  tv    = 1920x1080 @1x with ?layout=tv (html[data-layout="tv"], 1rem = 28 px)

Output: docs/design/screenshots/v2/build/<screen>-<1440|390|tv>[-night].jpg
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
VIEWPORTS = {"1440": (1440, 900, 1), "390": (390, 844, 2), "tv": (1920, 1080, 1)}
THEMES = {"day": "light", "night": "dark"}
GPU_ARGS = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]

# The day the mockups show (Today's ride = Tiber river park on 1 Nov 2026),
# late afternoon. Date is shifted, timers still run (the ride loop needs them).
PINNED_MS = 1793547000000  # 2026-11-01T16:30:00+01:00 (Europe/Rome)


def init_script(theme: str, extra: str = "") -> str:
    return f"""
(() => {{
  const shift = {PINNED_MS} - Date.now();
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


def launch(p):
    return p.chromium.launch(
        headless=True,
        executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
        args=GPU_ARGS,
    )


def new_page(browser, vp: str, theme_key: str, extra_init: str = ""):
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
    ctx.add_init_script(init_script(THEMES[theme_key], extra_init))
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
