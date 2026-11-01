#!/usr/bin/env python3
"""P2.4 build shots: Home (/app) at 1440, 390 and tv, day and night.

    BASE=http://localhost:5181 uv run --with playwright --with pillow \
        python scripts/v2-build-shots/home.py

Viewport-only shots (like the mockup renders), taken after the fonts and
every visible plate image have loaded. Writes docs/design/screenshots/v2/build/
home-<vp>[-night].jpg and measurements-home.json; prints measure() and the
main rects per shot. ONLY=1440,tv / THEMES=day limit the run while iterating.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SCREEN = "home"

RECTS = """() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  return {
    header: r('header'), h1: r('h1'), riders: r('[role=radiogroup]'),
    hero: r('[data-testid=featured-scenic-ride]'), plate: r('[data-testid=featured-scenic-ride] > div'),
    label: r('[data-testid=featured-scenic-ride] figcaption'), h2: r('#todays-ride-title'),
    ride: r('[data-testid=featured-scenic-ride] button[aria-label^="Ride "]:not([data-testid])'),
    comfort: r('[aria-controls]'), area: r('section h3'), tile: r('[data-scenic-route]'),
    tilePlate: r('[data-scenic-route] > div'), devices: r('header nav button'),
  };
}"""

WAIT_READY = """async () => {
  await document.fonts.ready;
  const imgs = [...document.querySelectorAll('img')].filter((i) => {
    const b = i.getBoundingClientRect(); return b.width > 0 && b.top < innerHeight; });
  await Promise.all(imgs.map((i) => i.complete ? null : new Promise((res) => { i.onload = i.onerror = res; })));
  return imgs.length;
}"""


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
                ctx, page = common.new_page(browser, vp, theme)
                page.goto(common.url("/app", vp), wait_until="networkidle")
                page.wait_for_selector("[data-testid=featured-scenic-ride]", timeout=30000)
                page.wait_for_selector("[data-scenic-route]", timeout=30000)
                # Live weather (Open-Meteo) settles the tile lines.
                try:
                    page.wait_for_function(
                        "() => !document.querySelector('[data-testid=featured-scenic-ride] .animate-pulse')",
                        timeout=8000,
                    )
                except Exception:
                    pass
                n = page.evaluate(WAIT_READY)
                page.wait_for_timeout(400)
                path = common.save(page, SCREEN, vp, theme)
                m = common.measure(page)
                m["imgs"] = n
                m["rects"] = page.evaluate(RECTS)
                m["errors"] = page.errors  # type: ignore[attr-defined]
                results[path.stem] = m
                print(path.name, json.dumps(m))
                ctx.close()
        browser.close()
    common.record(SCREEN, results)


if __name__ == "__main__":
    main()
