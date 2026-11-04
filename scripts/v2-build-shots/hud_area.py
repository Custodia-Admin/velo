#!/usr/bin/env python3
"""Compact ride HUD (owner-directed revision, 2 Nov 2026): how much of the screen the ride UI covers.

Shared by scripts/v2-build-shots/ride-hud.py and the owner-camera shot. HUD_AREA (page JS) finds every
visible SURFACE over the 3D canvas: any element with a background, border or shadow, that is not the
canvas, does not contain it and is smaller than 90 % of the viewport (layout wrappers and the ride root are
click-through boxes without a surface). Nested surfaces count once (the outermost). Rects are clipped to
the viewport.

  sumPct    = sum of those getBoundingClientRect areas / viewport area   (the directive's measure)
  unionPct  = the same rects rasterised on a 2 px grid (overlaps counted once)

Each surface is listed with its accessible name / test id so the PR can name what covers the screen.

Gate viewports (scripts/v2-build-shots/common.py VIEWPORTS): 1440x900, 1280x648 @2 (the OWNER'S LAPTOP,
Chrome on a 2560x1600 panel at scale 2), 390x844 @2 and the 1920x1080 TV layout. The collapsed ride UI
must stay within BUDGET_PCT at every one of them; 1280x648 is the shortest landscape gate, so a band
that only just passes at 1440x900 fails there first.
"""

GATE_VIEWPORTS = ("1440", "1280", "390", "tv")
BUDGET_PCT = 15.0


def budget(area: dict) -> str:
    """'ok' when the collapsed ride UI (sumPct) is within the owner's 15 % budget, else 'OVER'."""
    return "ok" if area["sumPct"] <= BUDGET_PCT else "OVER"


HUD_AREA = r"""() => {
  const vw = innerWidth, vh = innerHeight, va = vw * vh;
  const canvas = document.querySelector('[data-renderer] canvas') || document.querySelector('canvas');
  const vis = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
  const surface = (el) => { const s = getComputedStyle(el);
    const bg = s.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor);
    const img = s.backgroundImage && s.backgroundImage !== 'none';
    const border = ['Top','Right','Bottom','Left'].some(k => parseFloat(s['border' + k + 'Width']) > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(s['border' + k + 'Color']));
    const shadow = s.boxShadow && s.boxShadow !== 'none';
    return bg || img || border || shadow; };
  const cands = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el === canvas || (canvas && el.contains(canvas)) || (canvas && canvas.contains(el))) continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (!vis(el) || !surface(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= 0.9 * va) continue;
    cands.push(el);
  }
  const top = cands.filter((el) => !cands.some((o) => o !== el && o.contains(el)));
  const name = (el) => el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.id ||
    (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || el.tagName.toLowerCase();
  const rects = top.map((el) => { const r = el.getBoundingClientRect();
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(vw, r.right), y1 = Math.min(vh, r.bottom);
    return { name: name(el), x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), area: Math.round((x1 - x0) * (y1 - y0)) }; });
  const sum = rects.reduce((a, r) => a + r.area, 0);
  const G = 2, cols = Math.ceil(vw / G), rows = Math.ceil(vh / G); const grid = new Uint8Array(cols * rows);
  for (const r of rects) for (let y = Math.floor(r.y / G); y < Math.ceil((r.y + r.h) / G); y++) for (let x = Math.floor(r.x / G); x < Math.ceil((r.x + r.w) / G); x++) grid[y * cols + x] = 1;
  const union = grid.reduce((a, v) => a + v, 0) * G * G;
  const topmost = rects.length ? Math.min(...rects.map((r) => r.y)) : null;
  return { viewport: [vw, vh], sumPx: sum, sumPct: Math.round(1000 * sum / va) / 10, unionPct: Math.round(1000 * Math.min(union, va) / va) / 10,
           topmostY: topmost, topmostPct: topmost === null ? null : Math.round(1000 * topmost / vh) / 10,
           rects: rects.sort((a, b) => b.area - a.area) };
}"""
