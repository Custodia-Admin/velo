# Home-area worlds: evidence (card t_3d81f73f)

Five routes that rode the classic (Cesium) view now ride in baked worlds:
Lake Trasimeno (Perugia) and Valle Maggia, the Magadino plain, Lake Varese
and Lake Como (Lugano). Details and bake figures: `docs/worlds/WORLD-FORMAT.md`,
"The home-area worlds".

## Before and after, at each route's start

`<route>-1440x900.jpg` and `<route>-390x844.jpg`: the rider held 40 m into
the route at noon, clear weather, medium quality. Before = main a2623de
(classic view, Cesium photoreal); after = this branch (three.js world, the
world id is in the caption). Same harness and spot for both.

`lake-como-tunnel-910m-1440x900.jpg`: one of Lake Como's galleries, drawn as
the cut the carve leaves (no tunnel geometry, no road in it), as tunnels are
in the other worlds.

## Frame rate

cat-bed's Intel Arrow Lake iGPU (ANGLE gl-egl, Mesa), the stand-in for the
laptop's Arc: `scripts/world-hud-fps.py`, medium, 1920 × 1080, HUD on, rider
riding from the route start, 5 s windows, two rounds per route (Magadino
three, interleaved with the Perugia control). Token-free production builds
from this branch (`index-BS03SpBA.js`; Magadino's re-bake on `index-_4UzWQJK.js`),
worlds from R2. Uncapped runs add `--disable-gpu-vsync --disable-frame-rate-limit`;
their worst frames (200–350 ms) are chunk uploads as the rider sets off.

| Route | vsync-capped fps (p95 frame) | uncapped fps |
| --- | --- | --- |
| Tiber park (Perugia, control) | 60.0 (16.7 ms), every window | 112–122 |
| Lake Trasimeno shore | 60.0 (16.7 ms) | 130–148 |
| Valle Maggia | 60.0 (16.7–16.8 ms) | 116–121 |
| Bellinzona to Locarno (Magadino) | 60.0 (16.7 ms), 3 rounds; first bundle 57.8–58.6 | 84–87 (first bundle) |
| Lake Varese shore | 60.0 (16.7 ms) | 105–113 |
| Menaggio to Gravedona (Lake Como) | 60.0 (16.7–16.8 ms) | 99–104 |

Magadino's first bundle missed 2–5 % of frames (33 ms) at the Bellinzona
start; hiding buildings, vegetation or roads each brought it to 60, so the
re-bake thins the far woods (`vegetation.corridor` 300 m, keep 0.3, 200k
trees, as the Ohio towpath). In the first 5 s after the world appears, before
it settles, Magadino still reads 53.6–57.4 fps.

Render workload at medium, 1920 × 1080 (triangles, draw calls; the same on
any machine): Perugia Tiber 1.22–1.62 M, 122–125; Lugano Melide 1.47–2.08 M,
89–102; Trasimeno 1.06–1.55 M, 134–142; Valle Maggia 1.14–1.39 M, 106–140;
Magadino (first bundle) 1.58–1.77 M, 151–188; Lake Varese 1.76–1.93 M,
121–224; Lake Como 1.03–1.35 M, 104–146.
