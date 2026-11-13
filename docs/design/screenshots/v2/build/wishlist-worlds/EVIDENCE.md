# Wishlist worlds: evidence (card t_c1c94fd2)

The last six scenic routes that rode the classic (Cesium) view now ride in
baked worlds: the Engadin lakes, Lavaux (Lausanne to Chillon), Riviera dei
Fiori, Lake Annecy, Lake Garda (Peschiera to Lazise) and Hangzhou West Lake.
No scenic route is left outside a world. Bake figures, route lift over bare
ground and the data sources: `docs/worlds/WORLD-FORMAT.md`, "The wishlist
worlds".

## Before and after, at each route's start

`<route>-1440x900.jpg` and `<route>-390x844.jpg`: the rider held 40 m into the
route at noon, clear weather, medium quality. Before = main 18218ad (classic
view, Cesium photoreal with the household ion token); after = this branch
(three.js world; the world id is in the caption). Same harness and spot for
both (`startshots.py` in the card's scratch, laptop Arc GPU). Every after shot
rode the world renderer with no page errors.

Lake Annecy's route now starts on Rue des Marquisats, about 170 m on from its
old Pâquier start, so its before frame (main's route) and after frame are
170 m apart.

## Frame rate

cat-bed's Intel Arrow Lake iGPU (ANGLE gl-egl, Mesa), the stand-in for the
laptop's Arc: `scripts/world-hud-fps.py`, medium, 1920 × 1080, HUD on, rider
riding from the route start, 5 s windows, two rounds per route, the Perugia
Tiber park as the control. Production build from this branch
(`index-BO5GX0WN.js`), worlds from R2; every run reports `renderer: world` on
`ANGLE (Intel, Mesa Intel(R) Graphics (ARL), OpenGL ES 3.2)`. Uncapped runs add
`--disable-gpu-vsync --disable-frame-rate-limit`; their worst frames
(200–590 ms) are chunk uploads as the rider sets off. Raw windows: `fps.json`.

| Route | vsync-capped fps (p95 frame), HUD on | uncapped fps, HUD on |
| --- | --- | --- |
| Tiber park (Perugia, control) | 60.0 (16.7–16.8 ms), every window | 116–125 |
| Engadin lakes | 60.0 (16.7 ms) | 93–94 |
| Lausanne to Chillon (Lavaux) | 60.0 (16.7 ms) | 91–100 |
| Riviera dei Fiori | 60.0 (16.7–16.8 ms) | 115–118 |
| Lake Annecy | 60.0 (16.8 ms) | 90–96 |
| Peschiera to Lazise (Lake Garda) | 60.0 (16.8 ms) | 139–144 |
| West Lake loop (Hangzhou) | 60.0 (16.7 ms) | 127–144 |

Every capped window held 60 fps with no frame over 20 ms (worst 17 ms).
