#!/usr/bin/env python3
"""WCAG contrast of the v2 token pairs. Usage: python3 scripts/v2-contrast.py docs/design/mockups/v2-kit.css"""
import colorsys, re, sys

css = open(sys.argv[1]).read()
def block(sel):
    m = re.search(re.escape(sel) + r'\s*\{(.*?)\n\}', css, re.S)
    return {k: (h, s, l) for k, h, s, l in re.findall(r'--([a-z-]+):\s*([0-9.]+) ([0-9.]+)% ([0-9.]+)%;', m.group(1))}
def rgb(v):
    h, s, l = (float(x) for x in v)
    return colorsys.hls_to_rgb(h / 360, l / 100, s / 100)
def lum(c):
    f = lambda v: v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = c
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
def cr(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
day = block(':root')
night = {**day, **block('.dark')}
pairs = [('foreground', 'background'), ('foreground', 'card'), ('muted-foreground', 'background'), ('muted-foreground', 'card'),
         ('muted-foreground', 'muted'), ('primary-foreground', 'primary'), ('primary', 'background'), ('primary', 'card'),
         ('destructive', 'background'), ('destructive-foreground', 'destructive'), ('hud-foreground', 'hud'), ('muted-foreground', 'hud'),
         ('border', 'background'), ('on-scrim', 'scrim')]
for name, t in (('paper day', day), ('deep night', night)):
    print(f'## {name}')
    for a, b in pairs:
        r = cr(rgb(t[a]), rgb(t[b]))
        print(f'{a:22s} on {b:12s} {r:5.2f}  {"AA" if r >= 4.5 else ("AA-large/UI" if r >= 3 else "FAIL")}')
