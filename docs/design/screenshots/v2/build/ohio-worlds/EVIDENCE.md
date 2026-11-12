# Evidence: Cuyahoga Valley and Cleveland lakefront worlds (P3.1b, card t_0e76502b, PR #103)

Two remote worlds with bridges built as structures. The bundles are on R2 (`velo-worlds`, public r2.dev):
- `worlds/ohio-erie-towpath/4d29e49bad1fa163/`
- `worlds/cleveland-lakefront/ea575d8369357cb0/` (re-baked in review, see below; the superseded `ce8ae47fe3276bbe` is deleted)

Figures and bake details:
- [WORLD-FORMAT.md § Cuyahoga Valley](../../../../worlds/WORLD-FORMAT.md#cuyahoga-valley-ohio--erie-towpath)
- [WORLD-FORMAT.md § Cleveland lakefront](../../../../worlds/WORLD-FORMAT.md#cleveland-lakefront)

How bridges are built: [WORLD-FORMAT.md § bridges.json](../../../../worlds/WORLD-FORMAT.md#bridgesjson-bridges-as-structures).

| Acceptance | Cuyahoga Valley (`ohio-erie-towpath`) | Cleveland lakefront |
| --- | --- | --- |
| P1.3 v2 gate | `standard`, registered **1.69 m ≤ 6.00 m, PASS** | `standard`, registered **0.52 m ≤ 6.00 m, PASS** |
| Bundle | 2.59 MB brotli; deterministic (an `--out` bake is byte-identical for all 9 files) | 1.05 MB brotli; deterministic (9/9 files identical) |
| First ride downloads ≤ 8 MB | 3.07 MB (`e2e/remote-world.spec.ts`) | 1.29 MB |
| Offline after one ride | The second ride starts with the network offline; no world request reaches the network | same |
| Routes | `scenic-cuyahoga-towpath` 17.43 km, `scenic-cuyahoga-towpath-north` 10.35 km | `scenic-cleveland-lakefront` 13.51 km, `scenic-wendy-park-lakewood` 8.11 km |
| fps ≥ 58, HUD on, medium | **60 fps** (vsync cap) on every route: 3 × 5 s rounds and a 60 s ride each, 0 % of frames over 20 ms, rider in frame 100 %. Measured on cat-bed's Intel iGPU (ANGLE gl-egl), 1920×1080, production build `index-0rY12TR2.js` (`scripts/world-hud-fps.py`). Perugia, run between them as the control, read the same. Each run had the iGPU alone; runs that another card's browser test overlapped were thrown away and redone | same: lakefront and Wendy Park both 60 fps |
| Home | Both world rides are in "Places we want to go" after Chengdu, with no "Map view" pill (`home-wishlist-*.jpg`, 1440 / 1280×648@2 / 390). No component code changed: each world's destination manifest now names it | same |

## Ride shots

There are 13 spots across the 4 routes, each shot at noon and golden hour, at 1280×648@2 and 390×844 (`ride-*.jpg`, made by `scripts/route-clearance-shots.py`):
- Cleveland: on cat-bed, build `index-WP0LN-kS.js`.
- Cuyahoga Valley: after the tree re-bake (bundle `4d29e49bad1fa163`), on the laptop, build `index-0rY12TR2.js`.

| Route | Spots | What each shows |
| --- | --- | --- |
| Ohio & Erie Canal Towpath | 0.50, **7.66, 7.79** (I-80), 8.70 km | 7.66: the twin Ohio Turnpike (I-80) decks on their piers, 40 m over the path; 7.79: under it, beside a pier; 8.70: a ridden creek bridge with its parapets |
| Towpath: Lock 39 to Station Road | 0.03, 4.97, 10.14 km | 0.03: Rockside Road lifted over the trail on approach ramps; 4.97: the I-271 decks over the trail; 10.14: the Brecksville–Northfield High Level Bridge piers |
| Cleveland lakefront | 0.23, 3.40, 4.76 km | 0.23: under the Memorial Shoreway; 3.40: riding the Detroit–Superior Bridge deck, up to 18.6 m over the Flats; 4.76: under the Shoreway at West 3rd Street |
| Wendy Park to Lakewood Park | 0.30, 0.54, 2.57 km | 0.54: the Wendy Park bridge ridden as a deck; 2.57: a footbridge over the path |

In every shot:
- The rider is on the drawn road.
- Under the rider there is one road surface. At-grade junctions are the exception, for example service roads crossing at 4.76 km on the lakefront route.
- There is no void.
- Decks over the path are drawn as structures (slab, parapets, piers) with clear headroom, and none is ever ground.

`src/renderers/three/bridgeDecks.test.ts` measures the same from the shipped bundles:
- every route keeps at least 4.35 m under every deck it doesn't ride;
- on the decks it does ride, the rider is on the deck;
- walked every 0.5 m of the line the rider follows, the rider is never more than 0.3 m above the ground off its ridden spans, and on a span it stands on that span's own deck;
- no deck kinks where pins fight (more than 2 m within 6 m while over 1 m up, unless the piece is straight end to end).

## Defect found in review and fixed: the lakefront route "rode" the Memorial Shoreway at 2.62 km

Review @86a8ecf found that `scenic-cleveland-lakefront` counted as riding road 1014, the Cleveland Memorial Shoreway (a motorway deck), at 2623.86–2630.09 m. The bikeway there runs on its own cycleway, 6.2 m off the Shoreway's centreline (half-width 6 m). The ride pins pinned the deck to the path 6 m from its headroom pin: a 112 % kink. The app then lifted the rider 6.27 m onto the deck at 2616.5–2617 m, where the route passes under it, and the chase camera rode on top of the slab, hiding the rider.

- **Rule.** A route rides only a deck it is on: never a motorway or trunk deck, not where it runs alongside a deck off its surface while its own ground road is nearer, and a ride must put the route on the deck's surface somewhere ([WORLD-FORMAT.md § bridges.json](../../../../worlds/WORLD-FORMAT.md#bridgesjson-bridges-as-structures)). Re-computed offline from both published bundles, the only span this changes is the Shoreway one; every real ride keeps its exact `s0`/`s1`.
- **Re-bake.** `cleveland-lakefront` → `ea575d8369357cb0`: only `roads`, `bridges` and the manifest changed (no ride pins on the Shoreway). An `--out` re-bake is byte-identical for 9/9 files. `ohio-erie-towpath` re-bakes byte-identical to its published `4d29e49bad1fa163`, so it is unchanged.
- **Checks every metre.** The bake's `footprintConflicts` now walks every metre of the line the rider follows, not the 10 m route samples, and checks that a ridden span is ridden on its own deck. A new `deckKinks` bake check rejects pins that fight. The shipped-world test walks every 0.5 m. On the old `ce8ae47fe3276bbe` bundle it fails ("6.30 m off its span's own deck at 2617.0 m"; "road 1014: 6.65 m within 6 m"). On the re-bake it passes.
- **Deck kinks, worst change within 6 m while over 1 m up.**
  - Cleveland: before 6.75 m (road 1014), after 1.63 m (a footway, 1.6 m up).
  - Towpath: unchanged at 2.33 m. Its three windows over 2 m (2.09–2.33 m) are straight Buckeye Trail footbridges up 34–39 % hillsides. They carry no pin, stand 1.1–1.6 m up and are over 750 m from any route.
- **Offline 0.5 m probe** (review's `review103d`). The lakefront rider runs at 2616.5 m and 2623.5–2629.5 m and the camera-reach run at 2613–2638 m are gone. What remains are the ≤ 1 m V-dips in the ground profile (lakefront 41–128 m, Wendy Park 2182–2248 m), as before. Perugia, Lugano and Chengdu read 0.
- **Browser, standard camera, held with `__veloWorldLight.place()`.** Token-free production builds were served locally: before `index-DSDES6Iy.js` (86a8ecf), after `index-H4aY-4Wf.js`. The composites below are made from the same spots: `review-shoreway-2600-2624-1280x648.jpg` and `review-shoreway-2600-2624-390x844.jpg`.

| Spot | Camera over rider, before → after | Rider root vs path, after | Rider visible, before → after |
| --- | --- | --- | --- |
| 2600 m | 2.60 → 2.60 m | 0.00 m | yes → yes |
| 2612 m | 2.60 → 2.60 m | −0.03 m | yes → yes |
| 2618 m | **6.85** → 2.60 m (camera on the Shoreway deck) | −0.02 m | **no** → yes |
| 2624 m | **6.97** → 2.60 m | +0.18 m | **no** → yes |

The figures are the same at 1280×648@2 and 390×844. At 2616.5, 2617 and 2627 m the rider used to stand +6.27, +6.27 and +3.07 m over the path; it now stands at −0.03, −0.03 and +0.02 m.

"Visible" means the shot changes when the rider object is hidden (pixels above the HUD that differ by more than 24 levels). After the fix that is 521–2,165 pixels at 1280×648@2 and 1,434–9,041 at 390×844 for every spot. Before, at 2618 and 2624 m, it was 0 in both viewports: the camera looked along the top of the slab.

## Defects found and fixed while shooting

- **Slab edges at deck bends.** The slab and parapets were built square per segment while the road ribbon is mitred, so the slab's edge stepped at each vertex of a curved deck. Both now share the ribbon's mitre.
- **Wendy Park start.** The route used to start on the bridge's spiral ramp and pass under its own deck 30 m from the abutment, at ground the DEM doesn't lift. It now starts at the foot of the ramp.
- **Ramps ending in mid-air.** Where an overpass lifted for headroom has no road to land on (a dead end), the ramp stopped in the air. An abutment block now carries it down. The bake errors if such a block would stand on a route.

## Known limit

GLO-30 is a surface model. At Peninsula the towpath leaves the forest and stands 6–9 m above the open ground, so Main Street's bridge over it gets a 15 m lift and a 300 m approach viaduct. Card t_06b010ec (canopy-aware route offset) is filed for this.
