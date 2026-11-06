# Photoreal: a crown edge found under a crown is unproven road (card t_2835af4b)

Each image has two panels: **main 126597d + #90 b5072bb | this PR (f001955)**.
- Both panels are shot from the same rider spot with the same chase camera. The probe is `pr76probe.py` `spot:M`: it rolls in over the last 60 m, settles, then rolls in again over the last 20 m and takes 6 samples.
- The shots come from cat-bed on 6 Nov 2026 (Intel iGPU via ANGLE GL-EGL), with base and head in the same session. The probe and queues live in `~/.hermes/handoffs/velo/t_2835af4b/` (`queue.sh`, output `cat/q6/`).
- Bundles: base `index-CZpiDRKJ.js`, this PR `index-Dqtteiv9.js`.

On the Cuyahoga towpath at 4.73–4.76 km, every build took a crown as the road and rode it 5.5–10.5 m over the towpath. This PR keeps the rider on the drawn ground: the globe stand-in, at the towpath's height.

| file | what changes |
|---|---|
| `cuyahoga-4744-1280x648.jpg` | **Base:** the rider is on a crown at 170.12 m and the camera is buried in the crowns, with no ground in view. **This PR:** the rider is at 163.25 m, within 0.01 m of the drawn depth at the wheels, with the towpath and its shadow in view. |
| `cuyahoga-4752-1280x648.jpg` | **Base:** the rider is on a crown at 173.72 m, over a black void (6.8 % of the frame). **This PR:** the rider is at 163.25 m, with 0 % black. |
| `cuyahoga-4748-1440x900.jpg`, `cuyahoga-4748-390x844.jpg` | The other gate sizes. **Base:** 170.12 m, with 10.0 % (1440) and 3.9 % (390) black. **This PR:** 163.39 m, with 0.0 % and 0.2 % black. At 390 the rider stays clear of the ride HUD. |
| `cuyahoga-10300-1280x648.jpg`, `cuyahoga-10400-1280x648.jpg` | **Base:** the rider is on the forest canopy, at 193.5 and 200.2 m (19–28 m over the terrain). It got there by a tile that rose to the canopy height at the road spot. **This PR:** the rider is on the drawn towpath under the crowns, at 172.9 and 174.1 m, within 0.01 m of the drawn depth and on the drilled towpath. The route line draped up onto the crowns overhead is drawn the same way on main. |
| `cuyahoga-3000-1280x648.jpg` | The I-80 deck, unchanged (mean pixel difference 0.02 out of 255). |
| `lugano-7600-1280x648.jpg` | The Lugano–Melide bridges, unchanged (0.54 out of 255). |

Sizes are 1280×648@2 (the owner's tab), 1440×900@1 and 390×844@3, each scaled to CSS px. The thin teal line up the middle of every frame appears on every build; this change doesn't touch it.
