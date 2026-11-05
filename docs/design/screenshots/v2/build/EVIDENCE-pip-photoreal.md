# Evidence: photoreal floating window frames the rider above the JourneyBar

Card t_2926df77, PR #36 review nit N3. Before = main 423c685, after = this branch. Route: the first
Home tile outside every baked world (Trasimeno shore: `data-renderer="photoreal"`), token-free,
software GL, rider held at one spot (`__veloCesium.place(1200)`) in an all-magenta kit and bike so
it is found in the shot's own pixels. Chase camera (show mode's director off). Probe:
`scripts/v2-build-shots/pip-photoreal.mjs` (headed Chrome under xvfb over the DevTools protocol, the
window sized to what `pipWindowSize` asks for on that screen).

Composites (before | after; cyan line = the bar's top edge, yellow cross = the renderer's rider
point `__veloRideDebug().riderScreen`, 1 m above the road): `compare/pipcesium-{laptop,1440,tv}-{corner,third,half}.jpg`,
night `compare/pipcesium-laptop-corner-night.jpg`.

## Rider against the bar (CSS px of the window)

`covered` is the window root's `data-hud-bottom`; the shift is half of it (at most a quarter of the
window), the rule the world renderer uses (`lib/world/hudLens`). The canvas reaches twice the shift
above the window and ends at its bottom edge.

| Screen | Size | Window | covered → shift | Canvas rect after | Rider point y before → after | Bar top | After: point above the bar by |
|---|---|---|---|---|---|---|---|
| 1280×648 @2 (owner's laptop) | S | 448×252 | 78 → 39 | 0,−78 448×330 | 184 → 145 | 174 | 29 |
| | M | 512×288 | 80 → 40 | 0,−80 512×368 | 210 → 170 | 208 | 38 |
| | L | 637×358 (Chrome's cap) | 88 → 44 | 0,−88 637×446 | 262 → 218 | 270 | 52 |
| 1440×900 @1 | S | 448×252 | 78 → 39 | 0,−78 448×330 | 184 → 145 | 174 | 29 |
| | M | 512×288 | 80 → 40 | 0,−80 512×368 | 210 → 170 | 208 | 38 |
| | L | 720×405 | 93 → 47 | 0,−94 720×499 | 296 → 249 | 312 | 63 |
| TV 1920×1080 @1 | S | 480×270 | 78 → 39 | 0,−78 480×348 | 197 → 158 | 192 | 34 |
| | M | 640×360 | 88 → 44 | 0,−88 640×448 | 263 → 219 | 272 | 53 |
| | L | 923×518 (Chrome's cap) | 105 → 53 | 0,−106 923×624 | 379 → 326 | 413 | 87 |

- Before, the rider point was on or under the bar at S and M on the laptop and at 1440, and at S on
  the TV screen; about 85–90 % of the rider was behind the bar at the laptop's S.
- The magenta pixels move by the same amount as the renderer's point (laptop S: rider box top
  161.5 → 122.5, M 185.5 → 145.5, L 230 → 185.5), so the point is where the rider is drawn. The rider's size
  is unchanged (1.7 m = 91 / 104 / 130 px at laptop S / M / L, before and after): a shift, no zoom.
- Same framing as the world renderer: at the laptop's S the horizon sits at ~0.22 of the window in
  both (read off the shots, not measured; world: `pipwin-corner-1280.jpg`).
- The tab is untouched: no `data-hud-bottom` there, so the container keeps `0,0` and the viewport
  size, `top` empty and `lensShiftPx` 0, before and after on all three screens, and again after
  "Back to the Velo tab". No page errors in any run.

## What is left (follow-up t_a67fb090)

The rider's wheels (the bottom ~0.4 m, ~23 px) still sit behind the bar at every size: the rider's
ground point is ~23 px under the bar top (laptop S: point 145 + 91/1.7 ≈ 198 vs bar 174). The world
renderer's wheels clear it (~6 px at S). The cause is not the shift. Both renderers share the chase
framing (7 m back, 2.6 m up) and "fov 60", but three.js measures it vertically and Cesium across
the width (~36° vertical at 16:9). Photoreal is therefore zoomed in ~1.7x and puts the rider lower,
in the tab too. Changing that changes the tab's photoreal look, which needs an owner decision, so it
is its own card.

## Why a cropped canvas, not `PerspectiveFrustum.yOffset`

In Cesium 1.141 the scene renders from `camera.frustum.clone(scratch)`, and `clone()` doesn't copy
x/yOffset. The offset is also in near-plane units, while the scene sets its own near for every
frustum it draws. Both are pinned in `src/renderers/cesium/hudLensCrop.test.ts`. A taller canvas
cropped by the window is the same off-centre frustum. It costs the hidden strip's pixels (+31 % at
the laptop's S, +25 % at L), in a window a fraction of the screen.

## Pins

- `src/renderers/cesium/hudLensCrop.test.ts` (12) covers four things:
  - Equivalence under Cesium's own projection: every test point lands where the uncropped view puts
    it, moved up by the shift. This holds at S/M/L on both screens and for portrait windows (fov
    widened to keep the scale).
  - The per-frame applier: the tab never touches anything; the window crops once and resizes the
    canvas in the same frame; the crop follows the window size and the bar, and undoes itself.
  - The two Cesium facts above.
  - The CesiumWorldView wiring.
- `src/lib/world/hudLens.test.ts` (4): the shared shift rule. `directorCamera.test.ts` still passes
  on it.
- Mutations: 19 of 19 killed (`~/.hermes/handoffs/velo/t_2926df77/mutations.py`). They cover the
  wiring, the window-px rider point, extend = shift, the fov compensation, height/top/sign, the
  resize, the self-measure, the base fov, the state, the undo, the cap, and three ignoring the rule.
