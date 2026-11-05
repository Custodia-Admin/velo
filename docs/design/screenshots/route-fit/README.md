# Route fit: one drawn surface under the guide (PR #33 review N3)

> **Superseded figures.** The PR #42 review found a connector bent onto the road beside it at Locarno 2,072 m, junction notches, and a paint check that missed corner overhangs. The fit and the bundles were redone for those findings; current numbers and before/after shots are in [route-fit-nits](../route-fit-nits/README.md).

Card t_7e8cd233. The bake no longer lays a `routeFill` piece beside a path the route runs along. It bends that path onto the route instead (`easeRoadsOntoRoutes`, tools/worldbake/routeCoverage.mjs). It adds a `routeFill` join only where no road runs along the route within 2.5 m. The guide band is the centre line ± 0.29 m: the chevron arms reach 0.24 m and the stroke adds 0.045 m (`ROUTE_GUIDE`, pinned by routeGuide.test.ts).

**Before** is main 1a28b47 and **after** is this branch. Both are one build (bundle `index-CXudCUwe.js`) with only `worlds/*/roads.json.gz` and `manifest.json` swapped, so the A/B isolates the bake change. Every shot uses the world renderer at medium, noon and clear unless named, with the rider held by `__veloWorldLight.place(d)`.

## Coverage

Measured on the shipped bundles. Coverage tool: `node --experimental-strip-types tools/worldbake/routeCoverage.mjs <world>`.

| Route | Strict centreline on a drawn road | Guide band on drawn roads | Route fill | Bent |
| --- | --- | --- | --- | --- |
| Tiber park, before | 97.8 % without the fill | 90.12 % without the fill | 16 pieces (242 m) beside the paths | – |
| Tiber park, after | **100 %** | **100 %** | none | 2.3 km of route, paths ≤ 0.99 m |
| Assisi valley, before | 99.62 % without the fill | 96.91 % without the fill | 8 pieces (58 m) | – |
| Assisi valley, after | **100 %** | **100 %** | none | 870 m, ≤ 0.92 m |
| Locarno–Brissago, before | 98.81 % without the fill | 97.53 % without the fill | 4 pieces (116 m) | – |
| Locarno–Brissago, after | **100 %** | **100 %** | one 2.9 m join at 2,071 m | 348 m: ≤ 0.85 m, plus 2.51 m at the 2,072 m junction |
| Lugano–Melide | 100 % | 100 % | none | none |

Perugia bends 19 paths and Lugano 10. In both worlds, buildings, routes, terrain, water, landcover and vegetation are byte-identical to main.

## Chase shots, before | after (HUD on)

| Spot | 1440×900 | 390×844 | 1280×648 @2 |
| --- | --- | --- | --- |
| Tiber 1,961 m (owner's spot) | [jpg](perugia-tiber-park-1961-1440x900-clear.jpg) | [jpg](perugia-tiber-park-1961-390x844-clear.jpg) | [clear](perugia-tiber-park-1961-1280x648-2x-clear.jpg), [overcast](perugia-tiber-park-1961-1280x648-2x-overcast.jpg) |
| Tiber 2,490 m | [jpg](perugia-tiber-park-2490-1440x900-clear.jpg) | [jpg](perugia-tiber-park-2490-390x844-clear.jpg) | [jpg](perugia-tiber-park-2490-1280x648-2x-clear.jpg) |
| Tiber 4,160 m | [jpg](perugia-tiber-park-4160-1440x900-clear.jpg) | [jpg](perugia-tiber-park-4160-390x844-clear.jpg) | [jpg](perugia-tiber-park-4160-1280x648-2x-clear.jpg) |
| Tiber 9,480 m | [jpg](perugia-tiber-park-9480-1440x900-clear.jpg) | [jpg](perugia-tiber-park-9480-390x844-clear.jpg) | [jpg](perugia-tiber-park-9480-1280x648-2x-clear.jpg) |
| Locarno 2,072 m (largest bend and the join) | [jpg](locarno-brissago-2072-1440x900-clear.jpg) | [jpg](locarno-brissago-2072-390x844-clear.jpg) | – |
| Locarno 2,551 m (old 105 m fill) | [jpg](locarno-brissago-2551-1440x900-clear.jpg) | [jpg](locarno-brissago-2551-390x844-clear.jpg) | – |

Share of pixels that changed by more than 24 grey levels, before vs after:

| Spot | 1440 | 390 | 1280 @2 |
| --- | --- | --- | --- |
| Tiber 1,961 m | 0.16 % | 0.29 % | 0.03 % (overcast 0.18 %) |
| Tiber 2,490 m | 1.84 % | 4.69 % | 1.27 % |
| Tiber 4,160 m | 1.31 % | 2.91 % | 0.84 % |
| Tiber 9,480 m | 2.43 % | 6.28 % | 1.91 % |

- **At the owner's spot** the only differences are water and cloud animation. The camera there sees 1,961–2,100 m, a stretch that never had a fill.
- **At 2,490, 4,160 and 9,480 m** the before shows a widened path, with a square step in its edge where the fill piece starts. The after shows one path of constant width with the guide on it.

## Overhead (the app's overhead camera, HUD hidden), before | after

- [Tiber 2,490](perugia-tiber-park-2490-1440x900-clear-overhead.jpg)
- [Tiber 4,140](perugia-tiber-park-4140-1440x900-clear-overhead.jpg)
- [Tiber 9,470](perugia-tiber-park-9470-1440x900-clear-overhead.jpg)
- [Locarno 2,066](locarno-brissago-2066-1440x900-clear-overhead.jpg)

## Plan views, before | after

Each plan view is drawn from the bundles: a 50 × 34 m window, north up. Grey and tan are mapped roads, drawn as the renderer draws them (real width, flat ends). Magenta is route fill and terracotta is the guide band.

- [Tiber 1,690](plan-perugia-tiber-park-1690.jpg)
- [Tiber 2,470](plan-perugia-tiber-park-2470.jpg)
- [Tiber 2,550](plan-perugia-tiber-park-2550.jpg)
- [Tiber 4,134](plan-perugia-tiber-park-4134.jpg)
- [Tiber 9,465](plan-perugia-tiber-park-9465.jpg)
- [Assisi 1,660](plan-assisi-valley-1660.jpg)
- [Locarno 2,072](plan-locarno-brissago-2072.jpg)
- [Locarno 2,600](plan-locarno-brissago-2600.jpg)

**Locarno 2,072 m.** A 13 m connector path is bent by up to 2.51 m (OSM way geometry from the 1 Oct snapshot; the route is today's OSRM line). Its corner now follows the route into the junction with the wide road, and the 2.9 m join covers the last metre. It reads as one path, but it hugs the wide road for a few metres. It is the only bend over 1 m in either world.

## Frame rate (cat-bed, Arrow Lake iGPU, gl-egl, 1920×1080, medium, Tiber park, HUD on)

Before and after runs were interleaved, 3 pairs × 2 windows each, on an idle host (load 0.8–1.6).

| | before | after |
| --- | --- | --- |
| vsync | 60 fps in all 6 windows | 60 fps in all 6 windows |
| uncapped | 97.1–110.6 fps (mean 106.5) | 88.4–116.3 fps (mean 102.8) |

An earlier set on the 0.25 m bake ran under qemu co-tenants (load 6–10). It gave 59.2–60 vs 60 with vsync, and the uncapped pairs swung together between 40 and 87 fps. The road layer gains about 1.5 kB and loses 24 pieces.
