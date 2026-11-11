#!/usr/bin/env python3
"""Design-gate shots: Home's "Map & terrain credits" disclosure, build vs mockup.

    BASE=http://localhost:5196 uv run --with playwright --with pillow \\
        python scripts/v2-build-shots/home-credits.py

For every gate viewport (1440, 1280 @2x, 390 @2x, tv = 1920x1080 ?layout=tv) and
theme (day, night) it shoots:

  * the mockup's page foot, closed and open
        -> OUT/mockup-credits[-open]-<vp>[-night].jpg
        (docs/design/mockups/v2-home-credits.html, ?open=1, ?theme=night)
  * the BUILT Home scrolled to its foot, closed and open
        -> OUT/home-credits[-open]-<vp>[-night].jpg
  * the BUILT Home's first screen (where the primary action is)
        -> OUT/home-top-<vp>[-night].jpg
  * mockup | build of the open disclosure
        -> OUT/compare/credits-open-<vp>[-night].jpg

and writes OUT/measurements-home-credits.json per shot: horizontal overflow, the
primary Ride button's rect (must end inside the first screen), the summary's
height (target), the smallest font and target inside the disclosure, the rows
(credit ids and their text) and the page height closed vs open.

BEFORE=1 shoots only the page foot of a pre-change build (e.g. BASE=main's
preview) as OUT/before-credits-<vp>[-night].jpg. MOCKUP=1 shoots only the
mockup. OUT defaults to $TMPDIR/home-credits; ONLY=1440,390
and THEMES=day narrow the run.
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ.get("OUT", Path(tempfile.gettempdir()) / "home-credits"))
MOCKUP = common.REPO / "docs/design/mockups/v2-home-credits.html"
BEFORE = os.environ.get("BEFORE") == "1"
MOCKUP_ONLY = os.environ.get("MOCKUP") == "1"

MEASURE = """(root) => {
  const scope = root ? document.querySelector(root) : null;
  const ride = document.querySelector('[data-testid=featured-scenic-ride] button[aria-label^="Ride "]:not([data-testid])');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  let minFont = 1e9, minFontEl = '', minTarget = 1e9, minTargetEl = '';
  if (scope) {
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const t = w.currentNode; if (!t.textContent.trim()) continue;
      const el = t.parentElement; if (!el || el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect(); if (!r.width) continue;
      const f = parseFloat(getComputedStyle(el).fontSize);
      if (f < minFont) { minFont = f; minFontEl = t.textContent.trim().slice(0, 40); }
    }
    for (const b of scope.querySelectorAll('summary, a[href], button')) {
      const r = b.getBoundingClientRect(); if (!r.height) continue;
      if (r.height < minTarget) { minTarget = r.height; minTargetEl = b.textContent.trim().slice(0, 50); }
    }
  }
  const summary = scope?.querySelector('summary');
  return {
    overflow: document.documentElement.scrollWidth > innerWidth, scrollWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight, innerHeight,
    ride: rect(ride), rideInFirstScreen: ride ? ride.getBoundingClientRect().bottom + scrollY <= innerHeight : null,
    open: scope ? scope.open : null, summary: rect(summary), summaryText: summary?.textContent.trim(),
    rows: scope ? [...scope.querySelectorAll('li')].map((li) => ({ id: li.dataset.credit, rect: rect(li), text: li.innerText.replace(/\\s+/g, ' ').trim() })) : [],
    links: scope ? [...scope.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, name: a.textContent.replace(/\\s+/g, ' ').trim() })) : [],
    // Credit rows flow in CSS columns: count the distinct left edges of the rows.
    columns: scope ? new Set([...scope.querySelectorAll('li')].map((li) => Math.round(li.getBoundingClientRect().left)).filter((x) => scope.open)).size : 0,
    minFont: scope ? minFont : null, minFontEl, minTarget: scope ? Math.round(minTarget) : null, minTargetEl,
    tv: document.documentElement.getAttribute('data-layout') === 'tv',
    dark: document.documentElement.classList.contains('dark'),
  };
}"""


def jpg(png: bytes, path: Path, quality: int = 82) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.open(io.BytesIO(png)).convert("RGB").save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    return path


def key(vp: str, theme: str) -> str:
    return f"{vp}{'-night' if theme == 'night' else ''}"


def side_by_side(left: Path, right: Path, out: Path, labels: tuple[str, str]) -> None:
    a, b = Image.open(left).convert("RGB"), Image.open(right).convert("RGB")
    gap, bar = 24, 44
    canvas = Image.new("RGB", (a.width + b.width + gap, max(a.height, b.height) + bar), (245, 241, 234))
    d = ImageDraw.Draw(canvas)
    for x, img, label in ((0, a, labels[0]), (a.width + gap, b, labels[1])):
        canvas.paste(img, (x, bar))
        d.text((x + 8, 14), label, fill=(40, 30, 24))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "JPEG", quality=80, optimize=True, progressive=True)


def to_foot(page) -> None:
    page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
    page.wait_for_timeout(300)


def shoot_mockup(browser, vp: str, theme: str, results: dict) -> None:
    w, h, scale = common.VIEWPORTS[vp]
    for opened in (False, True):
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=scale,
                                  is_mobile=vp == "390", has_touch=vp == "390")
        page = ctx.new_page()
        q = [p for p in ("theme=night" if theme == "night" else "", "open=1" if opened else "",
                         "layout=tv" if vp == "tv" else "layout=default") if p]
        page.goto(f"{MOCKUP.as_uri()}?{'&'.join(q)}", wait_until="load")
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(300)
        to_foot(page)
        name = f"mockup-credits{'-open' if opened else ''}-{key(vp, theme)}"
        results[name] = page.evaluate(MEASURE, "#credits")
        jpg(page.screenshot(type="png"), OUT / f"{name}.jpg")
        print(name, json.dumps({k: results[name][k] for k in ("overflow", "minFont", "minTarget", "columns")}))
        ctx.close()


def shoot_build(browser, vp: str, theme: str, results: dict) -> None:
    ctx, page = common.new_page(browser, vp, theme)
    page.goto(common.url("/app", vp), wait_until="load")
    page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=30000)
    page.wait_for_selector("[data-destination-section]", timeout=30000)
    common.fonts_ready(page)
    page.mouse.move(0, 0)
    page.wait_for_timeout(600)
    k = key(vp, theme)
    if BEFORE:
        to_foot(page)
        results[f"before-credits-{k}"] = page.evaluate(MEASURE, None)
        jpg(page.screenshot(type="png"), OUT / f"before-credits-{k}.jpg")
        ctx.close()
        return
    results[f"home-top-{k}"] = page.evaluate(MEASURE, "[data-world-credits]")
    jpg(page.screenshot(type="png"), OUT / f"home-top-{k}.jpg")
    to_foot(page)
    results[f"home-credits-{k}"] = page.evaluate(MEASURE, "[data-world-credits]")
    jpg(page.screenshot(type="png"), OUT / f"home-credits-{k}.jpg")
    # Open it the way a rider does: a click on the summary.
    page.locator("[data-world-credits] summary").click()
    page.wait_for_timeout(300)
    to_foot(page)
    page.mouse.move(0, 0)
    page.wait_for_timeout(200)
    m = page.evaluate(MEASURE, "[data-world-credits]")
    m["errors"] = page.errors  # type: ignore[attr-defined]
    results[f"home-credits-open-{k}"] = m
    jpg(page.screenshot(type="png"), OUT / f"home-credits-open-{k}.jpg")
    print("build", k, json.dumps({x: m[x] for x in ("overflow", "rideInFirstScreen", "minFont", "minTarget", "columns", "pageHeight")}),
          "rows", [r["id"] for r in m["rows"]])
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
                if not BEFORE:
                    shoot_mockup(browser, vp, theme, results)
                if MOCKUP_ONLY:
                    continue
                shoot_build(browser, vp, theme, results)
                if not BEFORE:
                    k = key(vp, theme)
                    side_by_side(OUT / f"mockup-credits-open-{k}.jpg", OUT / f"home-credits-open-{k}.jpg",
                                 OUT / "compare" / f"credits-open-{k}.jpg",
                                 (f"mockup: v2-home-credits.html ?open=1 ({k})", f"build: /app, credits opened ({k})"))
                    before = OUT / f"before-credits-{k}.jpg"
                    if before.exists():
                        side_by_side(before, OUT / f"home-credits-{k}.jpg", OUT / "compare" / f"credits-before-after-{k}.jpg",
                                     (f"before: main ({k})", f"after: credits closed ({k})"))
        browser.close()
    OUT.mkdir(parents=True, exist_ok=True)
    name = "measurements-home-credits-before.json" if BEFORE else "measurements-home-credits.json"
    path = OUT / name
    prev = json.loads(path.read_text()) if path.exists() and (only or themes) else {}
    prev.update(results)
    path.write_text(json.dumps(prev, indent=1, sort_keys=True) + "\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
