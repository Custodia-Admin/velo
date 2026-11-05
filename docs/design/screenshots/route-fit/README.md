# Route fit: one drawn surface under the guide (PR #33 review N3)

Card t_7e8cd233. The bake no longer lays a `routeFill` piece beside a path the route runs along. It bends that path onto the route instead (`easeRoadsOntoRoutes`, tools/worldbake/routeCoverage.mjs), and only adds a `routeFill` join where no road runs along the route within 2.5 m.

**Before** is main 1a28b47. **After** is this branch. Both are the same build, with only `worlds/*/roads.json.gz` and `manifest.json` swapped. That makes the A/B the bake change alone. Every shot uses the world renderer at medium quality, noon and clear unless named. The rider is held with `__veloWorldLight.place(d)`.

## Coverage

These numbers come from `node --experimental-strip-types tools/worldbake/routeCoverage.mjs <world>` on the shipped bundles. "Paint" means the centre line ± 0.25 m.

| Route | Within 1 m of a mapped road | Strict centreline on a drawn road | Paint on drawn roads | Route fill |
| --- | --- | --- | --- | --- |
| Tiber park, before | 100 % | 97.8 % without the fill | 92.17 % without the fill | 16 pieces, 242 m, beside the paths |
| Tiber park, after | 100 % | **100 %** | **100 %** | none; 1,841 m of route on bent paths (≤ 0.97 m) |
| Assisi valley, before | 100 % | 99.62 % without the fill | 97.58 % without the fill | 8 pieces, 58 m |
| Assisi valley, after | 100 % | **100 %** | **100 %** | none; 720 m bent |
| Locarno–Brissago, before | 99.98 % | 98.81 % without the fill | 97.81 % without the fill | 4 pieces, 116 m |
| Locarno–Brissago, after | 99.98 % | 100 % | **100 %** | one 2.9 m join at 2,071 m; 310 m bent (≤ 2.07 m at the 2,072 m junction) |
| Lugano–Melide | 100 % | 100 % | 100 % | none, unchanged |

Perugia bends 20 paths, all by at most 0.97 m. Lugano bends 11, by at most 2.07 m. In both worlds, buildings, routes, terrain, water, landcover and vegetation are byte-identical to main.

## Chase shots, before | after

| Spot | 1440×900 | 390×844 | 1280×648 @2 |
| --- | --- | --- | --- |
| Tiber 1,961 m (owner's spot) | [jpg](perugia-tiber-park-1961-1440x900-clear.jpg) | [jpg](perugia-tiber-park-1961-390x844-clear.jpg) | [clear](perugia-tiber-park-1961-1280x648-2x-clear.jpg), [overcast](perugia-tiber-park-1961-1280x648-2x-overcast.jpg) |
| Tiber 2,490 m | [jpg](perugia-tiber-park-2490-1440x900-clear.jpg) | [jpg](perugia-tiber-park-2490-390x844-clear.jpg) | [jpg](perugia-tiber-park-2490-1280x648-2x-clear.jpg) |
| Tiber 4,160 m | [jpg](perugia-tiber-park-4160-1440x900-clear.jpg) | [jpg](perugia-tiber-park-4160-390x844-clear.jpg) | [jpg](perugia-tiber-park-4160-1280x648-2x-clear.jpg) |
| Tiber 9,480 m | [jpg](perugia-tiber-park-9480-1440x900-clear.jpg) | [jpg](perugia-tiber-park-9480-390x844-clear.jpg) | [jpg](perugia-tiber-park-9480-1280x648-2x-clear.jpg) |
| Locarno 2,072 m (largest bend + the join) | [jpg](locarno-brissago-2072-1440x900-clear.jpg) | [jpg](locarno-brissago-2072-390x844-clear.jpg) | – |
| Locarno 2,551 m (old 105 m fill) | [jpg](locarno-brissago-2551-1440x900-clear.jpg) | – | – |

Pixels that changed by more than 24 grey levels, before vs after:

| Spot | 1440 | 390 | 1280 @2 |
| --- | --- | --- | --- |
| Tiber 1,961 m | 0.11 % | 0.30 % | 0.08 % |
| Tiber 2,490 m | 1.73 % | 4.93 % | 1.62 % |
| Tiber 4,160 m | 1.40 % | 2.73 % | 0.96 % |
| Tiber 9,480 m | 2.43 % | 5.83 % | 1.88 % |

At the owner's spot the difference is water and cloud animation, i.e. noise. The camera there sees 1,961–2,100 m, which never had a fill, and nothing in that view changes. At 2,490, 4,160 and 9,480 m the before has a widened path with a square step in its edge where the fill piece starts. The after shows one path of constant width with the guide on it.

## Plan views, before | after

These are drawn from the bundles: a 50 × 34 m window, north up. Grey/tan strips are mapped roads, drawn the way the renderer draws them (real width, flat ends). Magenta is route fill. Terracotta is the painted guide.

- [Tiber 1,690](plan-perugia-tiber-park-1690.jpg)
- [Tiber 2,470](plan-perugia-tiber-park-2470.jpg)
- [Tiber 2,550](plan-perugia-tiber-park-2550.jpg)
- [Tiber 4,134](plan-perugia-tiber-park-4134.jpg)
- [Tiber 9,465](plan-perugia-tiber-park-9465.jpg)
- [Assisi 1,660](plan-assisi-valley-1660.jpg)
- [Locarno 2,072](plan-locarno-brissago-2072.jpg)
- [Locarno 2,600](plan-locarno-brissago-2600.jpg)

At Locarno 2,072 m a 13 m connector path bends by up to 2.07 m. Its corner now follows the route into the junction (77° of turning over 13 vertices, the largest 32°; before it was 72° over 3 vertices). The 2.9 m join covers the last metre to the wide road.

## Frame rate (cat-bed, Arrow Lake iGPU, gl-egl, 1920×1080, medium, Tiber park)

Before and after runs were interleaved. cat-bed was carrying qemu co-tenants (load 6–10), so the uncapped runs swing with that load.

| | before | after |
| --- | --- | --- |
| HUD on, vsync (3 pairs × 2 windows) | 59.2–60 fps (mean 59.8) | 60–60 fps (mean 60.0) |
| HUD on, uncapped (5 pairs × 2 windows) | 40.4–85.3 fps | 32.2–87.5 fps (the 32.2 is one window with a 1.5 s stall) |

Uncapped pairs move together: round 4 put both at ~40 and round 5 both at ~70–76. The road layer gains about 1.5 kB and loses 24 pieces, so no cost is expected, and none shows.
