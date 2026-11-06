# Photoreal: a held stand-in draws the globe at once (card t_16592284)

Each image has two panels: **main 0123703 | this PR**. Each panel is the canvas (no HUD) at the same metre of a continuous ride at 8.33 m/s (30 km/h).
- The rider is driven from an in-page timer, so the ground sampler and the globe gate run on real time, as in a ride (`entryride.py` with `SHOTS`). Each shot is taken the first time the ride passes that metre.
- Captured on cat-bed, 6 Nov 2026 (Intel iGPU via ANGLE GL-EGL). Probe and queues: `~/.hermes/handoffs/velo/t_16592284/`.
- Bundles: main `index-CZpiDRKJ.js`, this PR `index-CCfmgKR5.js`.
- Each label gives the metre, the sampler's ground kind, whether the globe is drawn, and the share of the panel darker than luminance 12.

Under tree crowns and decks the tiles draw nothing under the road, so the globe stands in for the ground (#76, #89, #90). Main draws it only after `GlobeGate`'s 1 s show wait, so at every crown onset the rider rides over a black void for about a second. This PR draws it on the next frame, wherever the finest terrain is known at or under the road held.

| file | what changes |
|---|---|
| `cuyahoga-2306/3214/4157/4704-1280x648.jpg` | Four crown onsets on the Cuyahoga towpath, a fraction of a second after the first stand-in sample. Main: globe hidden, 28–43 % of the frame black. This PR: globe drawn, 0 % black. At 4704 the 12 % is a dark mesh block at the bottom right, on both builds. |
| `lugano-7586-1280x648.jpg` | Under the Lugano–Melide railway and A2 bridges (#89's slab), from a 7300–7640 m ride. Main: 52 % black. This PR: 1 %. The flat olive hillside on the right is the globe streaming in during its first second. Main shows the same once its globe is drawn, at 7592. |
| `cuyahoga-2306-1440x900.jpg`, `cuyahoga-2306-390x844.jpg` | The 2306 onset at the other gate sizes, from separate 2250–2760 m rides. Main: 41 % / 44 % black. This PR: 0 %. |
| `cuyahoga-4604-over-the-road-1280x648.jpg` | Why the stand-in must lie at or under the road held. The left panel is the first push (0 ms for any finest near the road), the right is this PR. At 4.60 km the finest terrain is 0.1 m over the towpath. Drawn at once, it covered the towpath ahead for a second. This PR waits there, as main does. |
| `cuyahoga-toggle-pair-1280x648.jpg` | What a globe hide on the mesh road changes (main, 2315 m): the same frame drawn and with the globe hidden. Every build hides the globe 750 ms after the crowns. |

Sizes: 1280×648@2 (the owner's tab), 1440×900@1 and 390×844@3. The thin teal line up the middle of every frame appears on every build; this change doesn't touch it.
