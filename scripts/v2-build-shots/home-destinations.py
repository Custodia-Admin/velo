#!/usr/bin/env python3
"""P2.2 design-gate shots: Home's destination sections, build vs mockup.

    BASE=http://localhost:5194 uv run --with playwright --with pillow \\
        python scripts/v2-build-shots/home-destinations.py

For every viewport (1440, 390 @2x, tv = 1920x1080 with ?layout=tv) and theme
(day, night) it shoots, in the mockups' staged state (scripts/v2-build-shots/common.py:
paired fake KICKR, fixed Open-Meteo reading, 1 Nov 2026 so Today's ride is the
Tiber river park):

  * the BUILT Home full page          -> OUT/home-full-<vp>[-night].jpg
  * each destination section (build)  -> OUT/build-<section>-<vp>[-night].jpg
  * the same section of the mockup    -> OUT/mockup-<section>-<vp>[-night].jpg
    (docs/design/mockups/v2-home-destinations.html, ?theme=night)
  * mockup | build side by side       -> OUT/compare/<section>-<vp>[-night].jpg

and writes OUT/measurements-home-destinations.json: horizontal overflow, the
smallest font and target inside the sections, section/tile counts and titles.
BEFORE=1 shoots only the full page (for a pre-change build, e.g. BASE=main's
preview). OUT defaults to ~/.hermes/cache/scratch/p22-shots; ONLY=1440,tv and
THEMES=day narrow the run.
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ.get("OUT", Path.home() / ".hermes/cache/scratch/p22-shots"))
MOCKUP = common.REPO / "docs/design/mockups/v2-home-destinations.html"
BEFORE = os.environ.get("BEFORE") == "1"
SECTION_IDS = ["perugia", "lugano", "wishlist"]

SECTIONS_MEASURE = """(sel) => {
  const secs = [...document.querySelectorAll(sel)];
  let minFont = 1e9, minFontEl = '', minTarget = 1e9, minTargetEl = '';
  for (const s of secs) {
    const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const t = w.currentNode; if (!t.textContent.trim()) continue;
      const el = t.parentElement; if (!el || el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect(); if (!r.width) continue;
      const f = parseFloat(getComputedStyle(el).fontSize);
      if (f < minFont) { minFont = f; minFontEl = t.textContent.trim().slice(0, 40); }
    }
    for (const b of s.querySelectorAll('button, a[href]')) {
      const h = b.getBoundingClientRect().height;
      if (h && h < minTarget) { minTarget = h; minTargetEl = (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 50); }
    }
  }
  return {
    overflow: document.documentElement.scrollWidth > innerWidth, scrollWidth: document.documentElement.scrollWidth,
    sections: secs.length,
    titles: secs.map((s) => s.querySelector('h3')?.textContent.trim()),
    details: secs.map((s) => s.querySelector('h3')?.parentElement?.querySelector('p, span')?.textContent.trim()),
    tiles: secs.map((s) => s.querySelectorAll('[data-scenic-route], a.tile').length),
    mapBadges: secs.map((s) => [...s.querySelectorAll('span')].filter((e) => e.textContent.trim() === 'Map view').length),
    columns: secs.map((s) => { const g = s.querySelector('.grid, div.grid'); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0; }),
    minFont, minFontEl, minTarget: Math.round(minTarget), minTargetEl,
    tv: document.documentElement.getAttribute('data-layout') === 'tv',
    dark: document.documentElement.classList.contains('dark'),
  };
}"""


def jpg(png: bytes, path: Path, quality: int = 82) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.open(io.BytesIO(png)).convert("RGB").save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    return path


def name(kind: str, section: str, vp: str, theme: str) -> str:
    return f"{kind}-{section}-{vp}{'-night' if theme == 'night' else ''}.jpg"


def side_by_side(left: Path, right: Path, out: Path, half: bool) -> None:
    def load(p: Path) -> Image.Image:
        img = Image.open(p).convert("RGB")
        return img.resize((img.width // 2, img.height // 2), Image.LANCZOS) if half else img

    a, b = load(left), load(right)
    gap, bar = 24, 40
    canvas = Image.new("RGB", (a.width + b.width + gap, max(a.height, b.height) + bar), (245, 241, 234))
    d = ImageDraw.Draw(canvas)
    for x, img, label in ((0, a, f"mockup: {left.stem}"), (a.width + gap, b, f"build: {right.stem}")):
        canvas.paste(img, (x, bar))
        d.text((x + 8, 12), label, fill=(40, 30, 24))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "JPEG", quality=80, optimize=True, progressive=True)


def shoot_build(browser, vp: str, theme: str, results: dict) -> None:
    ctx, page = common.new_page(browser, vp, theme, fake={"granted": True})
    common.connect_trainer(page, vp)
    common.go_home_in_app(page)
    page.wait_for_selector("[data-scenic-route]", timeout=30000)
    common.fonts_ready(page)
    page.mouse.move(0, 0)  # no hover underline on whichever tile the last click left the pointer over
    page.wait_for_timeout(600)
    key = f"{vp}{'-night' if theme == 'night' else ''}"
    jpg(page.screenshot(full_page=True, type="png"), OUT / f"{'before' if BEFORE else 'home'}-full-{key}.jpg", 78)
    if BEFORE:
        results[f"before-{key}"] = page.evaluate(SECTIONS_MEASURE, "main section")
        ctx.close()
        return
    m = page.evaluate(SECTIONS_MEASURE, "[data-destination-section]")
    m["errors"] = page.errors  # type: ignore[attr-defined]
    m["kicker"] = page.locator("[data-testid=featured-scenic-ride] figcaption span").first.inner_text()
    results[f"build-{key}"] = m
    for sid in SECTION_IDS:
        loc = page.locator(f"[data-destination-section={sid}]")
        jpg(loc.screenshot(type="png"), OUT / name("build", sid, vp, theme))
    print("build", key, json.dumps(m))
    ctx.close()


def shoot_mockup(browser, vp: str, theme: str, results: dict) -> None:
    w, h, scale = common.VIEWPORTS[vp]
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=scale,
                              is_mobile=vp == "390", has_touch=vp == "390")
    page = ctx.new_page()
    page.goto(f"{MOCKUP.as_uri()}{'?theme=night' if theme == 'night' else ''}", wait_until="load")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(500)
    key = f"{vp}{'-night' if theme == 'night' else ''}"
    m = page.evaluate(SECTIONS_MEASURE, "section.area")
    results[f"mockup-{key}"] = m
    secs = page.locator("section.area")
    for i, sid in enumerate(SECTION_IDS):
        jpg(secs.nth(i).screenshot(type="png"), OUT / name("mockup", sid, vp, theme))
    print("mockup", key, json.dumps(m))
    ctx.close()


def main() -> None:
    only = {s for s in os.environ.get("ONLY", "").split(",") if s}
    themes = {s for s in os.environ.get("THEMES", "").split(",") if s}
    results: dict = {}
    with sync_playwright() as p:
        browser = common.launch(p)
        for vp in common.VIEWPORTS:
            if only and vp not in only:
                continue
            for theme in common.THEMES:
                if themes and theme not in themes:
                    continue
                shoot_build(browser, vp, theme, results)
                if not BEFORE:
                    shoot_mockup(browser, vp, theme, results)
                    for sid in SECTION_IDS:
                        side_by_side(OUT / name("mockup", sid, vp, theme), OUT / name("build", sid, vp, theme),
                                     OUT / "compare" / name("compare", sid, vp, theme), half=vp == "390")
        browser.close()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"measurements-home-destinations{'-before' if BEFORE else ''}.json").write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
