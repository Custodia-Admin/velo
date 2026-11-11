# Photoreal: the globe stands in up to 2.5 m under the road held (card t_c92a4576)

Each image has three panels: **main c83ff3c | PR #89 3dcb7d7 merged with main | this PR (merged with main)**.
- All three are shot from the same rider spot with the same chase camera (`pr76probe.py` `spot:M`: roll in over the last 60 m, settle, roll in again over the last 20 m, 6 samples).
- The shots come from the test host on 6 Nov 2026 (Intel iGPU via ANGLE GL-EGL). The probe and queues live in a scratch directory outside the repo.
- Bundles: main `index-Wh2kzbqs.js`, PR #89 + main `index-vfXvJqAy.js`, this PR + main `index-D1pQGIV9.js`.

On the Cuyahoga towpath at 3.11–3.16, 4.08–4.10 and 4.70–4.73 km the rider is held under tree crowns that the tiles draw with nothing under them. The towpath it holds sits 1.3–2.0 m over the finest World Terrain there.

| file | what changes |
|---|---|
| `cuyahoga-3116/4088/4716-1280x648.jpg` | Main and #89 hold the road with the globe hidden, so the rider stands over a black void: 29 / 21 / 17 % of the frame is black. This PR draws the globe in the mesh's place and the rider stands on it: 0 % black, and the rider within 0.01 m of the drawn depth at the wheels. |
| `cuyahoga-4716-1440x900.jpg`, `cuyahoga-4716-390x844.jpg` | The same spot at the other gate sizes. Main and #89 are 19 % (1440) and 25 % (390) black; this PR is 0 %. At 390 the rear wheel stays clear of the ride HUD. |
| `cuyahoga-3000-1280x648.jpg` | The I-80 deck, unchanged from #89 (mean pixel difference 0.06 out of 255). |
| `lugano-7600-1280x648.jpg` | The Lugano–Melide bridges (#89's case), unchanged from #89 (0.52 out of 255). Main shows #76's void there. |

Sizes: 1280×648@2 (the owner's tab), 1440×900@1 and 390×844@3, each scaled to CSS px. The thin teal line up the middle of every frame is on every build; this change doesn't touch it.
