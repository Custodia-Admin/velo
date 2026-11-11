# Evidence: Cuyahoga Valley and Cleveland lakefront worlds (P3.1b, card t_0e76502b, PR #103)

Two remote worlds with bridges built as structures. The bundles are on R2 (`velo-worlds`, public r2.dev):
- `worlds/ohio-erie-towpath/4d29e49bad1fa163/`
- `worlds/cleveland-lakefront/ce8ae47fe3276bbe/`

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
- on the decks it does ride, the rider is on the deck.

## Defects found and fixed while shooting

- **Slab edges at deck bends.** The slab and parapets were built square per segment while the road ribbon is mitred, so the slab's edge stepped at each vertex of a curved deck. Both now share the ribbon's mitre.
- **Wendy Park start.** The route used to start on the bridge's spiral ramp and pass under its own deck 30 m from the abutment, at ground the DEM doesn't lift. It now starts at the foot of the ramp.
- **Ramps ending in mid-air.** Where an overpass lifted for headroom has no road to land on (a dead end), the ramp stopped in the air. An abutment block now carries it down. The bake errors if such a block would stand on a route.

## Known limit

GLO-30 is a surface model. At Peninsula the towpath leaves the forest and stands 6–9 m above the open ground, so Main Street's bridge over it gets a 15 m lift and a 300 m approach viaduct. Card t_06b010ec (canopy-aware route offset) is filed for this.
