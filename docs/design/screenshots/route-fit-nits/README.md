# Route fit, PR #42 review nits: junction-safe bends, dense paint check

Card t_f684b0be, a follow-up to the PR #42 review (VERDICT APPROVE-WITH-NITS @f64dcc8). The bake fit in `tools/worldbake/routeCoverage.mjs` (`easeRoadsOntoRoutes`) changed in five ways:

1. **Bends stay on the route's line.**
   - A bend never carries past a vertex where the road turns more than 60° off the route. The segment beyond pivots on its far end, and the rest of the road keeps its mapped line.
   - Round the outside of a corner, or beside a stretch more than 30° off the route's heading, the bend is capped at 0.6 m (`ROUTE_EASE_CORNER_M`). Past that the route has left that road, so it gets a join.
   - Each route step bends only the nearest road running within 60° of its heading, never two at once.
2. **Junctions hold.** Every road end that lay in another road as mapped stays in it. This covers the end's centre and both corners of its flat end. The other road moves with it.
3. **The paint check covers the whole band.** It samples every 0.1 m along the route and at 13 points across the band (centre line ± 0.29 m). Before, it checked only the midpoint of each 1 m step. Where the band runs past a road's flat end, that end grows along its own line.
4. **The fill probe sees short pieces** (test side).
5. **The bake reports the final shift.** That is the Hausdorff distance between each moved road's mapped and shipped line, not the first-pass demand. The report's new `routeFit.bent[]` also carries each moved road's mapped polyline, so `routeFit.test.ts` can compare it with the bundle.

**Before** is main with PR #42's bundle (f64dcc8). **After** is this branch. Both use one build (`index-UViO8Y6E.js`); only `worlds/*/roads.json.gz` and `manifest.json` are swapped. Shots are from the test host (gl-egl iGPU), world renderer at medium, noon, clear, with the rider held by `__veloWorldLight.place(d)`.

## What changed in the bundles

Measured on the shipped bundles. Dense paint means 0.1 m along and 13 points across the band, the reviewer's `densepaint.mjs`.

| | main (PR #42) | this branch |
| --- | --- | --- |
| Locarno 2,059.3–2,060 m corner | paint up to **0.41 m** off the roads | 0 samples > 2 cm off |
| Tiber / Assisi dense paint, worst | 0.041 m / 0.066 m | 0.00 m / 0.00 m |
| Locarno 2,072 m connector 40009 | bent 2.51 m; 5.1 m of it over tertiary road 110 (0.78 m deep) | keeps its mapped line; a 7.6 m join bridges the grass to road 110 |
| Junction ends opened (bendcheck logic) | Lugano 40009/40011 (0.57 / 0.44 m), 25517, 25525, 28237, 31639 (0.06–0.12 m); Perugia 17803 corner (0.34 m) | none |
| Roads moved, largest final shift | Perugia 19 (0.99 m), Lugano 10 (2.51 m); the log said 22 (1.01 m) and 11 (2.89 m) | Perugia 21 (1.02 m), Lugano 20 (0.85 m); the log and report say the same |
| `routeCoverage.mjs` near / strict / paint | 100 % | 100 % |

Lugano's 20 moved roads break down as:
- 8 bent under 247 m of route;
- 7 junction neighbours moved with them;
- 5 road ends grown by ≤ 0.22 m along their own line.

Perugia's 21 are 17 paths, footways and one cycleway bent under 1.6 km of route, plus 4 road ends grown.

Buildings, routes, terrain, water, landcover and vegetation are byte-identical to main. Each world was baked twice on the test host, and the two bakes are byte-identical. Lugano is 7.12 MB brotli and Perugia 4.58 MB.

## Plan views (mapped | PR #42 | this branch)

These are drawn from the bundles: north up, mapped roads at real width with flat ends, magenta for route fill, terracotta for the guide band.

- [Locarno 2,066 m](plan-locarno-brissago-2066.jpg). Connector 40009 is no longer dragged onto the wide road beside it. The junction with footway 40011 is closed. The guide crosses the grass on a 7.6 m join.
- [Assisi 1,591 m](plan-assisi-valley-1591.jpg). Footway 17803's corner sits back inside path 17806, with no notch.

## Shots, before | after

| Spot | 1280×648 @2 | 1440×900 | 390×844 | overhead 1440×900 |
| --- | --- | --- | --- | --- |
| Locarno 2,060 m (the corner overhang) | [jpg](locarno-brissago-2060-1280x648-2x-clear.jpg) | [jpg](locarno-brissago-2060-1440x900-clear.jpg) | [jpg](locarno-brissago-2060-390x844-clear.jpg) | [2,066 m](locarno-brissago-2066-1440x900-clear-overhead.jpg) |
| Locarno 2,072 m (the connector on the road edge) | [jpg](locarno-brissago-2072-1280x648-2x-clear.jpg) | [jpg](locarno-brissago-2072-1440x900-clear.jpg) | [jpg](locarno-brissago-2072-390x844-clear.jpg) | [2,074 m](locarno-brissago-2074-1440x900-clear-overhead.jpg) |
| Assisi 1,583 / 1,591 m (17803 junction) | [1,583](assisi-valley-1583-1280x648-2x-clear.jpg), [1,591](assisi-valley-1591-1280x648-2x-clear.jpg) | | | [1,591 m](assisi-valley-1591-1440x900-clear-overhead.jpg) |
| Tiber 1,961 m (owner's spot) | [jpg](perugia-tiber-park-1961-1280x648-2x-clear.jpg) | | | |
| Tiber 4,160 m | [jpg](perugia-tiber-park-4160-1280x648-2x-clear.jpg) | | | |

Pixel difference before → after (fraction of pixels changed by more than 30 in RGB sum):

| Spot | Changed |
| --- | --- |
| Locarno 2,072 m | 7.3–8.5 % (the tan apron along road 110 is gone) |
| Locarno 2,060 m | 1.7–4.8 % |
| Overheads | 1.5–1.8 % |
| Assisi | 0.4–1.1 % |
| Tiber 1,961 and 4,160 m | 0.42 % (unchanged apart from a few path vertices) |

At Locarno 2,060 m in chase, route-paint pixels behind the rider are equal or higher after in every 100 px column.

## Fps (test host, gl-egl iGPU, medium, 1920×1080, Tiber park, interleaved)

Three before/after pairs, each with two rounds of HUD, HUD-glass and canvas windows. Every window held 60 fps, p95 16.7–16.8 ms, 0 frames over 20 ms, before and after. The ≥ 58 HUD-on budget holds.

## Pins and mutations

`src/lib/world/routeFit.test.ts` now runs these checks on every shipped bundle, against the mapped lines in `tools/worldbake/reports/<id>.json`:
- no moved road newly lies over another drawn road by more than 0.1 m, outside their junctions;
- every road end that lay in another road stays within 0.05 m of it;
- the reported shifts equal the measured Hausdorff distances;
- the paint band is 100 % on drawn roads, checked densely;
- no fill lies over a mapped road away from where it joins one.

The synthetic tests pin each rule on a small fixture.

The mutation list is `mutations.py` (kept outside the repo), run in a second detached worktree. Code mutations re-fit both worlds with the mutated code, which reproduces the bake-host bake byte for byte, so the shipped pins bite too. Results: 35 of 36 killed. Killed:
- F1–F9 (the N3 list);
- the reviewer's X1a–X4, including X3b, the 3 m fill;
- PR #42's own bundles, Lugano (D1) and Perugia (D2), which fail paint, overlap and junction pins;
- a report that overstates a shift (D3), drops a bent road (D4), or hides a junction notch (D5).

The one survivor is M5a, the bake measuring Hausdorff at vertices only. It is equivalent on both worlds' data: every reported shift still matches the test's 0.1 m measure within 0.011 m.
