# Photoreal: the globe stands in under the Lugano–Melide bridges (card t_6a69c279)

Each image has three panels: **main 3442730 | PR #76 aa5a18b merged with main | this PR (merged with main)**.
- All three are shot from the same rider spot with the same chase camera.
- The shots come from cat-bed on 6 Nov 2026 (Intel iGPU via ANGLE GL-EGL). The probe is `pr76probe.py` with `PAINT=1 SHOT=1`; it lives in `~/.hermes/handoffs/velo/t_6a69c279/`.
- Bundles: main `index-Bo3XohaG.js`, PR #76 + main `index-Wh2kzbqs.js`, this PR + main `index-vfXvJqAy.js`.

At 7.57–7.63 km the route runs on the shore road (321.5 m) under the railway and A2 bridges. The photoreal tiles draw those as one slab 6 m over the road, with the motorway deck up to 16 m over it, and nothing under them.

| file | what changes |
|---|---|
| `lugano-7590/7600/7610-1280x648.jpg` | Main rides the slab top 6.3 m over the road. At 7600 its camera is inside the deck above (grey smear, no rider). PR #76 holds the road with the globe hidden, so the rider stands in a black void (29 % of the frame is black). This PR draws the globe in the mesh's place and the rider stands on it: 0 % black, and the rider within 0.02 m of the drawn depth at the wheels. |
| `lugano-7600-1440x900.jpg`, `lugano-7600-390x844.jpg` | The same spot at the other gate sizes. PR #76 is 30 % black; this PR is 0 %. |
| `cuyahoga-3000-1280x648.jpg` | The I-80 deck on the Cuyahoga towpath, unchanged from PR #76: mean pixel difference 0.06 out of 255. Main shows a near-black ground here. |

Sizes: 1280×648@2 (the owner's tab), 1440×900@1 and 390×844@3, each scaled to CSS px.
