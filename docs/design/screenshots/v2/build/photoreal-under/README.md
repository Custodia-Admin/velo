# Photoreal ground under crowns and decks: painted road (PR #76 rework, card t_ad6a338a)

Each image shows three panels side by side: **main 039a962 | before: PR #76 b4ba361 | after: this rework**.
- All three are shot from the same rider spot and the same chase camera.
- All come from one cat-bed session on 6 Nov 2026, on the Intel iGPU via ANGLE GL-EGL.
- The probe is `pr76probe.py`, run with `PAINT=1 SHOT=1`; it lives in `~/.hermes/handoffs/velo/t_ad6a338a/`.
- Bundles: main `index-lcBpN1Fk.js`, b4ba361 `index-Ciaeha6x.js`, rework `index-o0LXSY5f.js`.

The painted road is the asphalt corridor, the centre line and the edge stripes. It is a ground classification, so it paints whatever stands in its footprint.

| file | spot | what changes |
|---|---|---|
| `cuyahoga-3000-*.jpg` | Cuyahoga towpath 3.0 km, under the I-80 deck | b4ba361 paints asphalt and edge lines up the pier and the slab beside it. The rework draws the globe as a stand-in (the mesh draws nothing under the deck), the rider stands on it, and nothing is painted. Main has no globe there and leaves a near-black ground. |
| `cuyahoga-2730-*.jpg` | Cuyahoga towpath 2.73 km, under the canopy | b4ba361 paints a column rising into the crowns. The rework does not paint; the rider rides the globe's imagery (the river and canal in Bing). |
| `lugano-7600-1280x648.jpg` | Lugano–Melide 7.6 km | **Not fixed here; fixed in `../photoreal-slab/` (card t_6a69c279).** The tiles draw a slab 6 m over the shore road and nothing under it. The globe is 4.4 m below the road and stays hidden. b4ba361 and the rework ride the road held, over a black void. Main rides the slab top with the camera buried in it. |

Sizes: 1280×648@2 (the owner's tab), 1440×900@1 and 390×844@3, each scaled to CSS px.

Painted-road pixels on the mesh (paintMesh, 6 rows a spot):

| spot | main | b4ba361 | rework |
|---|---|---|---|
| 3000 at 1280×648 / 1440 / 390 | 0 / 0 / 0 | 4,432 / 4,797 / 7,770 | 0 / 0 / 0 |
| 2730 at 1280×648 / 1440 / 390 | 0 / 0 / 0 | 3,925 / 4,321 / 7,541 | 0 / 0 / 0 |
