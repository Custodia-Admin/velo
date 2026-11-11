# World bundle format (velo-world v1)

A **world** is a self-contained folder of real-place data that Velo's own
renderer draws without any API key: terrain, roads, water, land cover,
buildings, tree seeds, places and the scenic routes, all in one local metric
frame. Worlds are baked once from open data by `tools/worldbake/bake.mjs`
(sources and licences: [CREDITS.md](CREDITS.md)) and shipped as static files
under `public/worlds/<id>/`.

Code:

| Piece | File |
| --- | --- |
| Bake recipe per world | `tools/worldbake/worlds/<id>.json` |
| Recipe JSON Schema | `tools/worldbake/recipe.schema.json` |
| Bake pipeline | `tools/worldbake/{bake,demSource,fetchDem,fetchGlo30,geotiff,fetchOsm,buildHeightfield,buildVectors,snapRoutes,validateDem,p13Criterion,util}.mjs` |
| P1.3 check on a baked world, no re-bake | `tools/worldbake/validate.mjs` |
| Manifest JSON Schema | `tools/worldbake/manifest.schema.json` |
| Manifest types + validator | `src/lib/world/manifest.ts` |
| Loader (fetch, verify, decode, progress) | `src/lib/world/loadWorld.ts` |
| Heightfield sampling + chunking | `src/lib/world/heightfield.ts` |
| lat/lon ↔ world metres | `src/lib/world/projection.ts` |
| Last bake's report (timings, sizes, hashes, checks) | `tools/worldbake/reports/<id>.json` |

`projection.ts`, `heightfield.ts` and `manifest.ts` are shared by the app and
the bake (Node imports them through TypeScript type stripping), so the ground
the bake snaps routes to is computed by the same code the app samples.

## Folder layout

```
public/worlds/perugia/
  manifest.json        plain JSON, read first
  height.bin.gz        heightfield (u16-delta)
  roads.json.gz        road centrelines
  water.json.gz        lakes/rivers (areas) + waterways (lines)
  landcover.json.gz    forest, farmland, orchard, … polygons
  buildings.bin.gz     building footprints + heights
  vegetation.bin.gz    tree instance seeds
  routes.json.gz       scenic routes snapped onto the heightfield
  bridges.json.gz      bridge decks, piers, ridden spans (recipe "bridges" only)
```

A world baked with `"host": "remote"` (Chengdu and the other wishlist
worlds) has the same files under `tools/worldbake/remote/<id>/`, where only
`manifest.json` is committed; the app loads it from
`<remote base>/<id>/<hash>/`, the public R2 bucket by default
([ADDING-A-WORLD.md](ADDING-A-WORLD.md), "Hosting").

Every file except the manifest is gzip-compressed by the bake (gzip level 9,
mtime 0, so the bytes are reproducible). The loader recognises the gzip magic
bytes; when a host has already removed the compression (Content-Encoding
pass-through) it uses the bytes as they are. Hashes in the manifest cover both
the stored file (`sha256`) and the decompressed content (`contentSha256`,
which the loader checks when `crypto.subtle` exists).

## Coordinates

- **World metres**: local transverse Mercator on WGS84, scale 1 on the central
  meridian, origin `(0, 0)` at `projection.lat0/lon0`. `x` grows east, `y`
  grows north. Over a 30 km world the scale error stays below 6 ppm, so world
  metres are real metres. `createProjection(manifest.projection)` gives
  `forward(lat, lon) → [x, y]` and `inverse(x, y) → [lat, lon]` (matches PROJ to
  under 1 mm, see `projection.test.ts`).
- **Heights** are metres above mean sea level, as the source DEMs give them
  (the route profiles use the same convention). Copernicus GLO-30 heights are
  above the EGM2008 geoid; the Terrain Tiles mix national datums (EU-DEM in
  Europe).
- Vector layers store coordinates as **integer decimetres** in world metres
  (`"units": "dm"`); divide by 10.
- Renderers usually map world `(x, y, h)` → three.js `(x, h, −y)`.

## manifest.json

Validated by `validateManifest()`; schema in
`tools/worldbake/manifest.schema.json`. Fields:

| Field | Meaning |
| --- | --- |
| `format`, `version` | `"velo-world"`, `1`. Another value makes the loader fail with `unsupported`. |
| `id`, `name` | World id (folder name) and display name. |
| `origin` | Lat/lon of world `(0, 0)`. |
| `projection` | `{ type: "tmerc", ellipsoid: "WGS84", lat0, lon0, k0 }`. |
| `extent` | `{ xMin, xMax, yMin, yMax }` metres: exactly the heightfield grid. |
| `bbox` | WGS84 box of the extent, rounded outward to 1e-5°. The OSM query box. |
| `heightfield` | `{ file, cols, rows, cellSize, encoding: "u16-delta", heightOffset, heightScale, minHeight, maxHeight }`. |
| `layers` | File name per layer: `roads`, `water`, `landcover`, `buildings`, `vegetation`, `routes`, and `bridges` in a world baked with bridges as structures (`generator.bridges`). |
| `files[]` | `{ path, bytes, sha256, compression, contentBytes, contentSha256 }` for every file except the manifest. |
| `moods`, `defaultMood` | Scene moods that suit the world (ids from the mood catalogue). |
| `pois[]` | `{ name, kind, rank?, x, y, h, osm }`, kind ∈ town, village, peak, viewpoint, landmark, church. `h` is the ground height there. `rank` (1–3) is label prominence: 3 towns, 2 places with a Wikipedia/Wikidata tag or ≥ 1,000 people, 1 the rest. Bundles baked before ranks omit it; renderers then rank by kind. |
| `routes[]` | `{ id, name, lengthM, maxGapM, gradeMeanAbsDiffPct }` per snapped scenic route (ids match `src/lib/scenicRoutes.ts`). |
| `stats` | Counts (roads, buildings, trees, …) for logs and UI. |
| `credits[]` | `{ id, name, licence, url, attribution }`: show these wherever the world is shown. |
| `generator` | Tool version, recipe SHA-256, OSM snapshot date, `demSource` (`aws-terrain-tiles/terrarium` or `copernicus-dem-30m/glo30-cog`), `demZoom` (Terrain Tiles only; absent for GLO-30), `demTiles` (tile count), `flatLakes: true` when the bake levelled the lakes (the renderer then draws each level lake flat and keeps ground standing above it dry). |

## height.bin: the heightfield (`u16-delta`)

- A node-registered grid of `cols × rows` nodes, `cellSize` metres apart.
  Node `(c, r)` sits at `x = xMin + c·cellSize`, `y = yMax − r·cellSize`:
  **row 0 is the north edge**, columns run west → east. At most 2048 nodes per
  side.
- Height in metres = `heightOffset + q·heightScale`, `q` an unsigned 16-bit
  value. `heightScale` is a power of two (1/64 m for Perugia), so decoding is
  exact.
- Byte stream: `cols·rows` little-endian 16-bit **deltas**, row by row. The
  first node of each row is stored as a delta from the first node of the row
  above (row 0 from 0), every other node as a delta from its left neighbour,
  all modulo 2¹⁶. A prefix sum restores `q`. Smooth terrain gives small deltas,
  which is what makes the file compress well.
- `Heightfield.sampleHeight(x, y)` is bilinear inside the cell and clamps to
  the edge outside the grid. **It is the ground.** `normal(x, y)` gives the
  surface normal; `chunks(nx, ny)` splits the grid into meshing chunks that
  share their edge nodes (no cracks).

### Decode cost

Recorded once on the laptop (Intel Meteor Lake, Node 24, vitest bench
`src/lib/world/heightfield.bench.ts`, synthetic 2048² terrain, 31 Oct 2026,
laptop busy with other agents, load average ≈ 13):

| Step | min | mean |
| --- | --- | --- |
| `u16-delta` → `Heightfield` | 13.5 ms | 72 ms |
| gunzip (Node `DecompressionStream`) | 103 ms | 384 ms |
| SHA-256 (`crypto.subtle`) | 6 ms | 28 ms |
| Full loader path (gunzip + SHA-256 + decode) | 107 ms | 299 ms |

Decoding is well inside the 300 ms budget; the full path including gzip
inflate averaged 299 ms under that load. Browsers run `DecompressionStream`
natively, without Node's web-stream wrapper.

## routes.json: scenic routes on the ground

```json
{ "version": 1, "routes": [
  { "id": "scenic-perugia-tiber-park", "name": "Tiber river park", "lengthM": 10882.31,
    "stepM": 10, "s": [0, 10, …], "x": [...], "y": [...], "h": [...] } ] }
```

- Samples every `stepM` metres along the route, on the **app's own distance
  scale** (`s` matches `Route.points[].distance` from
  `scenicRoutes.routeFromGeometry`, so `rideSim` distance maps straight onto
  it). `x`, `y` are world metres rounded to 1 cm.
- `h` is the **render elevation**: exactly `heightfield.sampleHeight(x, y)`
  (same code, same floating-point result), so the rider stands on the terrain
  with zero gap. A test re-checks every sample (`perugiaWorld.test.ts`).
- The trainer keeps using the route's own smoothed profile
  (`scenicRouteData.ts`) for grade. To keep what you see in step with what you
  feel, the bake re-grades the terrain under each route (`snapRoutes.mjs`):
  1. target = route profile + a slowly varying offset (400 m median, then
     1600 m mean of terrain − profile), so the road keeps the profile's shape
     but sits at the real terrain's level. A loop (its ends within one
     step) has the target ramped over 400 m at each end so both ends meet
     at their mean (`closeLoop`): the ground at the start/finish has one
     height, and without the ramp Chengdu's Xinglong loop stepped 3 m in
     its first 10 m. Perugia's Assisi loop was baked before this and still
     steps 2.2 m (a test names it until it is re-baked);
  2. nodes within `1.5 × cellSize` of the route take the target; the next
     40 m blend back to the natural terrain (smoothstep), like a road
     embankment or cutting.
- Checks per route (in the manifest and the report): `maxGapM` (0), and
  `gradeMeanAbsDiffPct`, the mean |render grade − profile grade| over a
  centred 200 m window (must be ≤ 1 percentage point; Perugia: 0.11 and 0.10).
  For comparison the raw DEM along the same line differs by 0.73 and 0.61.

## roads.json

```json
{ "version": 1, "units": "dm",
  "classes": ["motorway", "trunk", …], "widths": [12, 10, …],
  "flags": { "bridge": 1, "tunnel": 2, "unpaved": 4, "oneway": 8, "routeFill": 16 },
  "names": ["Via …", …],
  "roads": [ { "c": 2, "f": 1, "w": 6.5, "n": 0, "p": [x0, y0, x1, y1, …] } ] }
```

- `c` indexes `classes` (OSM `highway`, `_link` folded into its parent). The
  carriageway width is `w` (from the OSM `width` tag) or `widths[c]`.
- `f` is a bit set of `flags` (omitted when 0); `n` indexes `names`.
- Polylines are clipped to the extent and simplified (Douglas–Peucker 0.5 m).
  Heights come from the heightfield.
- `routeFill` pieces are not OSM ways: each is a way the OSM snapshot lacks
  under a scenic route. The bake fits the drawn roads to every route so its
  painted guide (centre line ± 0.29 m, its chevrons' reach) lies on ONE drawn surface:
  - where the paint leaves the road the route runs along (a path mapped a
    metre to the side, a corner the route cuts), the bake bends that road
    toward the route just far enough: only the nearest road within 60° of the
    route's heading at that step, never one it crosses and never two at once.
    Between nearby pulls the bend runs straight from one to the next; past
    them it eases back to the mapped line over 8 m, but never past a vertex
    where the road turns more than 60° off the route (the segment beyond
    pivots on its far end, the rest of the road keeps its line). Round the
    outside of a corner, or beside a stretch more than 30° off the route's
    heading, it bends at most 0.6 m: past that the route has left that road
    and gets a join instead. Where the paint runs past a road's flat end, that
    end grows along its own line. The road keeps its class, width and surface,
    and nothing is laid beside it;
  - every road end that lay in another road as mapped (a junction: the end's
    centre or a corner of its flat end) stays in it. When a bend moves one of
    the two roads there, the other moves with it: end to end, both take the
    larger move; where a road ends on another's side, the road the route bends
    leads (else the wider one) and only the move across that road is matched;
  - where no road runs along the route within 2.5 m (a way newer than
    `osmDate`, the join where an out-and-back was cut), it adds a `routeFill`
    piece along the route, reaching a metre into the drawn roads at either end
    like any mapped junction and never running alongside one. It takes the
    class and surface of the road it leaves (else an unpaved `path`).
    Renderers draw these under the mapped roads.

  Road ends count as drawn up to their last point (flat ends, as the renderer
  draws them), not as round caps. The guide is checked every 0.1 m along the
  route and at 13 points across its band. `tools/worldbake/routeCoverage.mjs
  <world>` reports each route's share near mapped roads, with its centreline
  on drawn roads, and with its whole guide on them; the bake report has the
  numbers under `routes[].roadCoverage` (`easedM` bent, `joinedM` added) and
  `routeFit`: `roadsBent`, `maxShiftM` (the largest final shift, the
  Hausdorff distance between a road's mapped and shipped line), `joins`, and
  `bent[]` with each moved road's index, shift and mapped polyline (dm,
  `"x,y x,y …"`). `src/lib/world/routeFit.test.ts` compares those mapped
  lines with the bundle: no moved road may newly lie over another drawn road
  and no junction end may leave the road it lay in.

## bridges.json: bridges as structures

Only in a world baked with `"bridges": true` (manifest `generator.bridges`,
`tools/worldbake/bridges.mjs`). Without it a bridge is a road ribbon drawn
straight between the ground at its two ends, and a route that rides it fills
the valley under it with an earth dam. With it:

```json
{ "version": 1, "units": "dm",
  "decks": [ { "r": 12, "t": 14, "a": 1, "z": [2249, 2252, …] } ],
  "piers": [ [x, y, ux, uy, halfAlong, halfAcross, bottom, top] ],
  "rides": { "<route id>": [ { "s0": 3007.1, "s1": 3799.32, "r": [12, 13] } ] } }
```

- `decks[]`: one per bridge road and per approach ramp. `r` indexes
  `roads.json` `roads`, `z` is the deck top at each of that road's vertices
  (dm, so the deck pieces carry a vertex at least every 6 m), `t` the deck
  thickness (top to underside, dm), `a: 1` marks an approach ramp: a ground
  road lifted to meet a raised deck.
- `piers[]`: boxes centred on (x, y), `halfAlong` along (ux, uy) (×1000),
  `halfAcross` across, from `bottom` to `top` (dm). Abutment blocks (where a
  ramp has no road to land on) use the same format.
- `rides`: per route, the stretches (route distance, metres) that ride decks,
  and the roads ridden.

How the bake decides, once and offline:

- **Deck heights.** Bridge pieces joined end to end form one deck. It stands
  on the ground at its abutments; inner joints take a length-weighted solve,
  so a chain is a straight line from abutment to abutment.
- **Headroom.** Where a route passes under a deck, the deck's underside
  stays 4.5 m over the route (`DECK_HEADROOM_M`): the deck is pinned there
  (with a vertex at the pin). GLO-30 carries no embankments and OSM maps an
  overpass as a short piece over the path, so its abutments come out at
  valley level: the bake lifts each abutment so the pin is reached at no more
  than the road class's grade (`DECK_GRADE`: 4 % motorway, 5 % primary and
  secondary, 6 % other roads, 8 % paths), and the road beyond becomes an
  approach ramp at that grade until it meets the ground (at most 450 m; a
  ramp onto a road a route rides is a bake error). Where the road ends first,
  an abutment block carries the deck down.
- **Ridden decks.** On a deck a route rides, the rider is on the deck. The
  carve leaves the ground under its middle alone; where the carve still ran
  (a deck shorter than two end zones of 1.5 cells, the end zones of a longer
  one) the deck is pinned to the carved ground, so the rider never steps
  between ground and deck.
- **Ground under decks.** Terrain under a deck's middle stays 0.4 m under its
  underside, with a 1:1 bank out to 30 m beside it (a DSM that carries a
  viaduct loses its ridge), never touching a route's carved core.
- **Checks** (bake errors): every route crossing under a deck it does not
  ride keeps the headroom (tolerance 0.15 m); a route never passes through
  the footprint of a deck it rides elsewhere while off the ground there (the
  app finds the ridden deck by footprint). The report has `bridges` with the
  pins, lifts and ridden spans.

The renderer (`src/renderers/three/bridgeDecks.ts`, `Bridges.tsx`) draws
each deck's ribbon at these heights and a concrete slab, parapets and the
piers under it; where a deck comes down to the ground it blends into the
drawn terrain over 1 m of height, and a landed approach is a plain road. The
ridden route's surface (`worldScene.routeSurface`) is its decks where it
rides them and the drawn ground everywhere else, under every other deck too:
the rider, the chase camera, the partners and the painted guide stand on it.

## water.json

`areas[]`: `{ k, r }`, `k` indexes `areaKinds` (lake, river, pond) and `r` is
a list of rings: outer ring first, then holes. Rings are open (no repeated
first vertex), dm. `lines[]`: `{ k, w?, p }`, `k` indexes `lineKinds` (river,
canal, stream), width `w` or `lineWidths[k]`. Culverted waterways are dropped.

## landcover.json

`areas[]`: `{ k, r }`, `k` indexes `kinds`: forest, scrub, grass, park,
farmland, orchard, vineyard, residential, industrial, cemetery. Polygons are
clipped to the extent, simplified at 3 m, and dropped below 200 m².

## buildings.bin

Little-endian, outer rings only. `VWB2` (current) is `VWB1` plus one district
byte per building; loaders read both (a `VWB1` bundle reads as all suburb):

| Offset | Type | Content |
| --- | --- | --- |
| 0 | 4 bytes | magic `VWB2` (or `VWB1`) |
| 4 | u32 | `count` buildings |
| 8 | u32 | `totalVerts` |
| 12 | u16 × count | vertex count per building |
| … | u16 × count | height, decimetres above ground |
| … | u8 × count | kind (index into `BUILDING_KINDS`: generic, house, apartments, church, industrial, shed, civic) |
| … | u8 × count | `VWB2` only: district (index into `BUILDING_DISTRICTS`: suburb, old-town, rural, industrial) |
| … | 0–3 bytes | padding to a 4-byte boundary |
| … | (i32, i32) × count | first vertex (x, y) of each building, dm |
| … | (i16, i16) × (totalVerts − count) | remaining vertices as deltas from the previous vertex, dm, building by building |

Rings are counter-clockwise (walls extrude outward), open, at least 3
vertices. Heights come from `height`, else `building:levels × 3.2 + 1` m, else
a default per building type. Buildings under 8 m² are dropped.

Nothing the rider follows runs through a building (`buildingClearance` in
`tools/worldbake/buildVectors.mjs`):

- any footprint closer to a scenic route's centreline than the road it
  rides on is wide is dropped, for every route in the recipe, measured on
  the app's own route polyline: per 10 m piece, the nearest drawn road
  within 4 m sets the clearance to its half-width (OSM `width`, else the
  class default) + 1 m, clamped to 3.5–6 m (`ROUTE_CLEAR_MIN_M` /
  `ROUTE_CLEAR_MAX_M`; 6 m where no road is mapped). A narrow street keeps
  its frontage; nothing stands on the carriageway the route line is drawn
  on. The 3.5 m floor bounds the renderer's route-line depth bias
  (`ROUTE_MAX_PULL_M`, 2.5 m), so the line can never be pulled in front of
  a wall it is behind;
- any footprint a drawn road's centreline passes right through (crosses its
  outline twice or more) is dropped. Tunnels (including
  `tunnel=building_passage`) and steps are not drawn and don't count; a
  driveway ending inside a garage (one crossing) keeps its building.

Districts are classified before the drop, so the remaining buildings keep
their palettes. The bake logs the counts and records them in the report
(`buildingsDropped`); Perugia drops 44 on routes and 91 astride roads of
24,056.

Districts come from the built fabric (`classifyDistricts` in
`tools/worldbake/buildVectors.mjs`): industrial kinds or industrial landcover →
industrial; fewer than 5 buildings within 120 m → rural; footprints covering
≥ 36 % of a 70 m disc, among neighbours that are mostly that dense too →
old-town (Perugia's and Assisi's medieval cores); everything else suburb.
Renderers pick palettes and massing per district (stone old towns, plaster
suburbs, casali in the country, panel sheds on estates).

## vegetation.bin

Tree instance seeds:

| Offset | Type | Content |
| --- | --- | --- |
| 0 | 4 bytes | magic `VWV1` |
| 4 | u32 | `count` |
| 8 | f32 | `quantum`, metres per unit |
| 12 | u32 | reserved (0) |
| 16 | u16 × count | x = `extent.xMin + qx·quantum` |
| … | u16 × count | y = `extent.yMin + qy·quantum` |
| … | u8 × count | kind (index into `VEGETATION_KINDS`: broadleaf, conifer, scrub, olive, park, cypress, riparian, hedgerow, garden) |
| … | u8 × count | seed byte (scale, rotation, variant) |

Woodland seeds come from a jittered lattice per kind (forest 11 m, scrub
16 m, orchard/olive grove 7 m, park 20 m), kept where the point falls inside
the OSM polygon. Character kinds follow lines (`CHARACTER_DEFAULTS`, overridable
per recipe under `vegetation.character`): cypress rows round cemeteries
(5 m), poplars and willows along both banks of rivers and streams (9 m),
sparse field-edge trees on farmland boundaries (hedgerow), OSM
`natural=tree_row` ways (7 m), garden trees in residential land, and lone oaks
in fields (broadleaf). Every seed keeps 1.8 m clear of road edges (scenic
routes count as 5 m wide roads, `ROUTE_TREE_HALF_M`), 1.5 m of building walls
and out of open water. Character kinds are kept whole;
woodland is thinned uniformly to fit the recipe's `maxInstances` (480,000
for Perugia). Renderers draw a subset around the camera (the three.js
'balanced' tier caps at 150,000).

## Loading

```ts
import { loadWorld, WorldLoadError } from '@/lib/world/loadWorld';

const world = await loadWorld('/worlds/perugia/', {
  onProgress: (p) => setProgress(p.loadedBytes / p.totalBytes),
  signal: abortController.signal,
});
```

- Progress: one `manifest` event, one `file` event per finished file (bytes
  and file counts only grow), then `done`.
- Errors are always `WorldLoadError` with `code`:
  - `missing`: HTTP 404/410 for the manifest or any file;
  - `corrupt`: bad JSON, failed size or SHA-256 check, bad gzip, wrong magic,
    or a manifest that contradicts itself;
  - `unsupported`: another format/version/encoding;
  - `network`: transport failure or other HTTP error;
  - `aborted`: the caller's signal fired.
  `error.file` names the bundle file.

## Baking

```bash
node tools/worldbake/bake.mjs perugia              # cached inputs
node tools/worldbake/bake.mjs perugia --clean      # re-download everything first
```

Run bakes on the bake host (cat-bed), not the laptop: copy the repo there,
bake, copy `public/worlds/<id>/` (or `tools/worldbake/remote/<id>/`),
`tools/worldbake/reports/<id>.json`,
`tools/worldbake/worlds/<id>.json` (its `validation` block) and
`docs/worlds/CREDITS.md` back. Downloads are cached under
`tools/worldbake/cache/<id>/` (git-ignored). Needs Node ≥ 22.18 (TypeScript
type stripping), no npm packages.

`--out <dir>` moves only the bundle. In the tree it runs from, the bake
still rewrites `tools/worldbake/reports/<id>.json`, the recipe's
`validation` block (unless `--no-validate`) and the world's block in
`docs/worlds/CREDITS.md` (unless `--no-docs`). To bake for comparison, bake
from a `git archive` copy, not from a working tree you will commit from.
With `--no-validate` the report's `validation` is `null` and the recipe
keeps its previous block.

- **Deterministic**: the same recipe and inputs give byte-identical files.
  OSM queries are pinned to the recipe's `osmDate` (Overpass attic data), so a
  clean-cache bake downloads the same OSM state. Terrain tiles are static.
- **Checks** the bake runs: manifest validation, height round-trip, route gap
  and grade, bundle size (fails above 8 MB brotli; the grid is capped at 2048
  nodes a side), and the blueprint's P1.3 terrain accuracy check (v2): the
  heightfield against 50 seeded Open-Meteo (Copernicus GLO-90) samples, read
  at the GLO-90 node each answer comes from, against a bound set by the
  world's terrain class. See [Terrain accuracy check](#terrain-accuracy-check-p13-v2).
  The result is written into the recipe's `validation` and the report; a
  FAIL is reported, it doesn't stop the bake.
- After writing to its default place (`public/worlds/<id>/`, or
  `tools/worldbake/remote/<id>/` for `"host": "remote"`), it runs
  `syncDestinations.mjs`, which
  copies the world's bbox, routes, moods, towns and credits into its
  destination manifest (`docs/worlds/DESTINATIONS.md`).

Perugia, 31 Oct 2026 on cat-bed (Node 26), from a clean cache:

| Check | Result |
| --- | --- |
| Bake time | 342 s (Overpass ≈ 5 min of it) |
| Determinism | two clean-cache bakes, identical SHA-256 for every file |
| Size | 4.73 MB as shipped (gzip), 3.56 MB brotli, 9.5 MB raw |
| Heightfield vs Open-Meteo, 50 seeded points | at the points 5.96 m (bias −1.18 m, max 18.2 m); P1.3 v2 (5 Nov): `standard`, registered 4.54 m ≤ 6.00 m, **PASS** |
| Routes | max gap 0 m; grade Δ 0.109 pp (Tiber park), 0.101 pp (Assisi valley); painted guide 100 % on drawn roads, checked every 0.1 m across the band (the route fit bends 17 paths under 1.6 km of route, by at most 1.02 m, and grows 4 road ends; no joins) |

The 50-point point RMS passed v1's 6 m, but only just. Spot checks of 500 more points
(5 seeds × 100) gave RMS 6.0–8.2 m, about 7.0 m overall. The raw z12 and z13
terrarium tiles give the same figures, so the gap is between the two source
DEMs (EU-DEM in the Terrain Tiles and Copernicus GLO-90), not loss in the
bake. Most of it comes from steep slopes, where 90 m and 30 m cells disagree
most.

### Recipe

`tools/worldbake/worlds/<id>.json`, schema `tools/worldbake/recipe.schema.json`:
`id`, `name`, `description`, `origin` (world `(0, 0)`), `grid` (`xMin`, `yMax`,
`cellSize`, `cols`, `rows`, ≤ 2048 a side), `dem` (below), `osmDate`, `routes`
(+ `routesOutside` with reasons), `snap`, `vegetation`, `moods`,
`defaultMood`, the optional `host` (`"remote"`), `routeCredits`,
`flatLakes` and `bridges` ([ADDING-A-WORLD.md](ADDING-A-WORLD.md),
[bridges.json](#bridgesjson-bridges-as-structures)), and `validation`
(`sample_seed`, plus an optional mountain
override; the bake writes the rest, see
[Terrain accuracy check](#terrain-accuracy-check-p13-v2)).
`manifest.generator.recipeSha256` is the SHA-256 of the parsed recipe without
its `validation` block (`recipeBundleBytes` in `bake.mjs`): the check never
shapes the bundle, and writing its result back into the recipe must not
change the next bake's bytes.

### DEM source (`dem`)

| `dem` | Source | Notes |
| --- | --- | --- |
| `{ "zoom": 13 }` (no `source`, or `"source": "aws-terrain-tiles"`) | AWS Terrain Tiles, terrarium PNGs (`fetchDem.mjs`). **The default.** | Web Mercator tiles at `zoom`; EU-DEM in Europe. Perugia uses it. |
| `{ "source": "copernicus-glo30" }` | Copernicus DEM GLO-30 Public, 1″ Cloud Optimized GeoTIFFs (`fetchGlo30.mjs` + `geotiff.mjs`). Opt-in; the default for mountain worlds. Lugano uses it. | No `zoom` (the bake refuses one). The manifest gets `demSource: "copernicus-dem-30m/glo30-cog"`, no `demZoom`, and the `copernicus-glo30` credit (notice plus the licence's Art. 6(c) liability disclaimer, see [CREDITS.md](CREDITS.md)) in place of `terrain-tiles`. |

Both sources give `buildHeightfield.sampleGrid` the same thing: a bilinear
`sample(lat, lon)` on the source's pixel centres. Every grid node is projected
to WGS84 lat/lon (`projection.inverse`) and sampled, so the world grid, CRS
and quantisation are the same whichever source fed them. A recipe without
`dem.source` bakes exactly as before, to the byte.

GLO-30 details, checked against the bucket and the tiles' own tags:

- **Tiles**: one 1° × 1° tile per whole-degree south-west corner,
  `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_<N|S>dd_00_<E|W>ddd_00_DEM/Copernicus_DSM_COG_10_<N|S>dd_00_<E|W>ddd_00_DEM.tif`
  (e.g. `N46_00_E008_00` covers 46–47°N, 8–9°E). They are fetched whole over
  plain HTTPS (17–43 MB each). The bake takes only the tiles whose pixels a
  bilinear read inside the world's bbox (+ 500 m) touches: 1 for Perugia
  (`N43_00_E012_00`) and 2 for Lugano (`N46_00_E008_00`, `N45_00_E008_00`:
  the world crosses 46°N, and its east edge, 8.9925°E with the margin, stays
  west of 9°E).
- **Grid**: `GTRasterTypeGeoKey` is PixelIsPoint and the tiepoint is the
  tile's NW corner, so pixel centres sit on whole arc-seconds: row j at
  lat S+1 − j/3600, column i at lon W + i/C. The bucket's tiles drop the
  original shared south row and east column, so a tile owns latitudes
  (S, S+1] and longitudes [W, W+1). Rows are 1″ everywhere; above 50° the
  columns widen (C = 2400 per degree to 60°, 1800 to 70°, 1200 to 80°, 720 to
  85°, 360 beyond). The sampler reads C and R from `ModelPixelScale`, checks
  them against the tile's size and tiepoint, and interpolates each row with
  its own band's spacing, so it stays bilinear across tile seams and bands.
- **Decoding** (`geotiff.mjs`, Node built-ins only): TIFF and BigTIFF IFDs in
  either byte order; tile or strip offsets and byte counts; uncompressed or
  DEFLATE blocks (`zlib.inflateSync`); no predictor, or the floating-point
  predictor (3) undone row by row, first the byte-wise horizontal
  differencing, then the byte-plane de-interleave (most significant plane
  first); float32 samples; the first full-resolution IFD (IFD 0 in a COG,
  reduced-resolution overviews skipped). A tile that declares a nodata value
  is refused, because void filling isn't implemented. Blocks are inflated
  lazily, so a small world decodes only the 1024² blocks it reads. Each of
  these paths has a tifffile-written fixture in `tools/worldbake/fixtures/`.
- **Missing tiles**: the bucket has no tile over open ocean (HTTP 404), and
  those read 0 m. GLO-30 *Public* also lacks a few unreleased land tiles (e.g.
  `N40_00_E044_00`, Armenia), which 404 too. So each 404 is checked against the
  same tile in the GLO-90 bucket: 404 there too means ocean; 200 means land
  without public GLO-30, and the bake stops (bake that world from the default
  source).
- **Cache**: `<cache>/<id>/copernicus-glo30/<name>.tif`, plus `<name>.404` for
  an ocean tile, under `tools/worldbake/cache/` or `--cache`. A warm cache
  never touches the network; `--clean` clears it with the rest of the world's
  cache.
- **It is a surface model.** Copernicus DEM includes buildings and tree
  canopy (water is flattened). The route corridor carve still re-grades the
  road itself, but expect towns and forests to stand a few metres proud of
  the Terrain Tiles version.

Checks on cat-bed, 4 Nov 2026 (Node 26):

| Check | Result |
| --- | --- |
| Decoder vs tifffile, full tiles N46_00_E008_00 and N45_00_E008_00 (3600² each) | bit-identical, every pixel |
| Sampler vs tifffile + numpy bilinear (PixelIsPoint), 50 points over 4 tiles (the pre-#32 Lugano experiment box) | max difference 3·10⁻¹⁰ m |
| N52_00_E004_00 (2400 columns per degree) + N52_00_E003_00 (ocean) | identical to tifffile inside E004, 0 m over the sea; a warm-cache re-read with `fetch` disabled gives identical samples |
| Default source: Perugia from the same cache, main vs this change | all 8 files byte-identical (and equal to the committed bundle) |
| Perugia with `copernicus-glo30`, baked twice | byte-identical; 4.95 MB brotli (Terrain Tiles 4.58 MB); 24 s from cache |
| Perugia vs Open-Meteo (50 seeded points) | Terrain Tiles: point RMS 5.96 m, at the GLO-90 node 4.54 m. GLO-30: point RMS 8.47 m, at the GLO-90 node 2.18 m |

Open-Meteo answers with the nearest north-west GLO-90 node, not an
interpolated value, so a sharper DEM scores *worse* at the sample point and
better at the node. The Lugano experiment (`cat-bed:~/velo-bake/glo30.py`) read
the tiles as PixelIsArea, which put it half a pixel (~15 m) off. Its 6.53 m
"GLO-30 at the GLO-90 node" figure becomes 1.71 m on the tiles' real
PixelIsPoint grid (and 16.58 m → 20.63 m at the points).

### Terrain accuracy check (P1.3 v2)

The blueprint's normative text is
[VELO-V2-BLUEPRINT.md § "P1.3 terrain accuracy criterion (v2)"](../architecture/VELO-V2-BLUEPRINT.md)
(amended 4 Nov 2026, card t_20471c47). The code is
`tools/worldbake/p13Criterion.mjs` (constants, node rule, class, bound,
block) and `validateDem.mjs` (sampling, Open-Meteo). In short:

1. **Samples.** 50 points uniform over the extent from `mulberry32(sample_seed)`
   (x then y per point), inverse-projected and rounded to 1e-5°: the v1
   protocol and seeds, unchanged. One batched Open-Meteo query gives each
   sample's reference: the value of one GLO-90 node, not an interpolation.
2. **Registration** (`glo90-nw-node`). The node is the north-west corner of
   the half-open 3″ cell holding the sample: `lon_node = ⌊lon/Δ⌋·Δ`,
   `lat_node = (⌊lat/Δ⌋ + 1)·Δ`, Δ = 3″ (below 50°; the bake refuses a
   sample further north or south). On a node row that's the next node north,
   which is Open-Meteo's answer there.
3. **Figures.** `registered_rms_m`: the heightfield read bilinearly at the
   node against the sample's reference. It **gates**. `point_rms_m` (the
   heightfield at the sample itself) and `max_abs_registered_err_m` are
   reported only: on a slope the point figure mostly measures where in its
   90 m cell the sample fell.
4. **Terrain class.** `steep_fraction` is the share of heightfield nodes
   (all but the outer ring) whose Horn 3×3 slope is ≥ 15°. A world is
   `mountain` from 0.2000 (to 4 decimals), otherwise `standard`. A recipe
   can force `mountain` with a reason; it can never force `standard`.
5. **Bound.** `√(floor² + 6.00²)`, rounded half-up to 2 decimals. The floor
   is a measured constant: 0 for `standard`, and 1.71 m for `mountain`
   (Copernicus GLO-30, read as PixelIsPoint, at Lugano's 50 nodes; card
   t_045a5081). That gives **6.00 m standard** and **6.24 m mountain**.
   **PASS iff `registered_rms_m ≤ bound_m`.**

Mountain worlds default to `dem.source: "copernicus-glo30"`. A mountain world
baked from Terrain Tiles gets a log note; the gate itself doesn't care which
source the heightfield came from.

The block the bake writes into the recipe's `validation`, and into the
report's `validation` with extras:

| Field | Meaning |
| --- | --- |
| `sample_seed` | Author input: seed of the 50 samples. |
| `terrain_class_override`, `terrain_class_override_reason` | Optional author input: `"mountain"` and a non-empty reason, always together. Anything else is a bake error. |
| `criterion` | `"p1.3-v2-registered-rms"` |
| `reference` | `"open-meteo-elevation/copernicus-glo90"` |
| `registration` | `"glo90-nw-node"` |
| `sample_count` | `50` |
| `dem_source` | The recipe's `dem.source` id (`aws-terrain-tiles` or `copernicus-glo30`). |
| `terrain_class`, `terrain_class_source` | `standard` or `mountain`; `auto`, or `override` when the override changed the class. |
| `slope_threshold_deg`, `steep_fraction_threshold` | `15`, `0.2` |
| `steep_fraction` | The computed share of steep nodes, 4 decimals, override or not. |
| `floor_source`, `floor_rms_m` | `"none"`, `0` (standard) or `"copernicus-glo30-cog/lugano-t_045a5081"`, `1.71` (mountain). |
| `own_error_allowance_m` | `6` |
| `bound_m` | `6` or `6.24` |
| `registered_rms_m` | **Gating**, 2 decimals. |
| `point_rms_m`, `max_abs_registered_err_m` | Reported only, 2 decimals. |
| `pass` | `registered_rms_m ≤ bound_m` |

The report's block adds `diagnostics` (mean bias at the node and at the
point, the point's max error, and `node_answer_mismatches`: how many samples
Open-Meteo answered from another node than the rule picked, measured by a
second query a quarter cell inside each node's cell) and `points` (the 50
rows: sample, node, both heightfield readings, both answers, whether the
sample lies on a route corridor). The bound, floor and thresholds come from
code, never from the recipe: a recipe still carrying v1's `seed`, `samples`
or `maxRmsM` stops the bake.

Re-run the check on a world that's already baked, without re-baking:

```bash
node tools/worldbake/validate.mjs lugano [--bundle dir] [--cache dir] [--no-write]
```

It reads the bundle's heightfield and routes, checks they match the recipe,
and writes the same block into the recipe and the report. With the same
cached Open-Meteo answers it gives the bake's block to the byte. It exits 0
on PASS and FAIL alike. It refuses ("re-bake") a bundle the recipe didn't
bake: another id, grid, origin or DEM source, or a `generator.recipeSha256`
other than the hash of the recipe without its `validation`. Editing only the
`validation` block keeps the bundle valid; any other recipe edit (routes,
snap, `osmDate`…) needs a re-bake first.

### Perugia coverage

The world is 26 × 14 km (`x −6000…20000`, `y −8501…5500` around Perugia's
centre). It covers Perugia's hill, the Tiber at Ponte San Giovanni and the
Assisi valley floor, so it holds both `scenic-perugia-tiber-park` and
`scenic-assisi-valley`. The blueprint's "~14 × 14 km" couldn't reach the
Assisi route, 18 km east of the centre. `scenic-trasimeno-shore`
(Castiglione del Lago, 30 km west) is left for its own world; stretching this
one to 45 km would cost resolution and budget.

### Lugano

The world is 23 × 27 km at 15 m (`x −11500…11495`, `y −13500…13500` around
46.0593° N 8.8386° E, 1534 × 1801 nodes). It holds `scenic-lugano-melide`
and `scenic-locarno-brissago`, about 22 km apart across Monte Ceneri. The other
Ticino and Lombardy routes (Magadino plain, Valle Maggia, Lake Varese, Lake
Como) are 20–45 km further out; one world reaching them would pass 2048
nodes a side and the 8 MB budget, so they stay map rides in the Lugano
destination until they get worlds of their own. Baked 4 Nov 2026 on cat-bed
from Terrain Tiles (EU-DEM), re-baked 6 Nov 2026 from Copernicus GLO-30
(`"dem": { "source": "copernicus-glo30" }`, card t_49b58e90). The shipped
bundle is the GLO-30 one:

| Check | Result |
| --- | --- |
| Bake time | 516 s from an empty cache (Overpass ≈ 7 min of it); the GLO-30 re-bake takes 87 s from cache (2 tiles, `N46_00_E008_00` and `N45_00_E008_00`) |
| Determinism | two bakes from cache and one from an empty cache: identical bytes for all 8 files (re-bake after the route fixes: two bakes from cache, identical). GLO-30: two `--out` bakes and the committed bake, identical bytes for all 8 files |
| Size | 9.73 MB as shipped (gzip), 7.41 MB brotli, 19.26 MB raw (EU-DEM: 9.46 / 7.12 / 19.26 MB). Only `height.bin.gz`, `routes.json.gz` and `manifest.json` change; the 2-D layers are byte-identical |
| Routes | max gap 0 m; grade Δ 0.86 pp (Lugano–Melide), 0.68 pp (Locarno–Brissago); painted guide 100 % on drawn roads, checked every 0.1 m across the band (Locarno–Brissago: 99.98 % within 1 m of mapped roads; the route fit moves 20 roads by at most 0.85 m: 8 bent under 247 m of route, 7 junction neighbours moved with them, 5 road ends grown ≤ 0.22 m; at the 2,072 m junction it adds one 7.6 m join instead of bending the connector path onto the wide road; a 116 m route fill used to lie beside the paths) |
| Heightfield vs Open-Meteo, 50 seeded points | P1.3 v2: `mountain` (steep fraction 0.5503), registered **1.81 m ≤ 6.24 m, PASS**; at the points 19.47 m (reported only) |

Before and after, same 50 samples (seed 46059), same cache, same rule
(`glo90-nw-node`):

| | EU-DEM (Terrain Tiles z13) | GLO-30 |
| --- | --- | --- |
| **Registered RMS (gates, bound 6.24 m)** | **8.88 m, FAIL** (9.12 m under v1's node query) | **1.81 m, PASS** |
| Registered mean bias / max abs | −1.79 m / 29.52 m | −0.05 m / 7.49 m |
| Samples off by more than 6.24 m at the node | 16 | 1 |
| Point RMS (reported only) | 18.17 m | 19.47 m |
| Gentle 32 (EU-DEM relief point-to-node < 10 m): registered / point | 5.03 m / 5.72 m | 1.78 m / 5.32 m |
| Steep 18: registered / point | 13.20 m / 29.31 m | 1.86 m / 31.67 m |
| Steep fraction | 0.5177 | 0.5503 |
| Heightfield range | 180.9–1907.8 m | 191.3–1949.2 m |
| Route vs swissALTI3D, every 250 m (Lugano–Melide 32 / Locarno–Brissago 39 points): RMS, mean | 10.14 m, +7.83 m / 13.87 m, +11.05 m | 8.02 m, +4.93 m / 7.79 m, +4.70 m |

Lugano–Melide's grade Δ was 1.127 pp at the first bake: its geometry rode
~800 m up a street and back down it with a different profile each way. The
route generator now cuts that stub (#33), and the re-bake brings it to 0.61 pp.
Locarno–Brissago first crossed Lago Maggiore for 3.6 km on the "Ascona -
Ronco" boat line; it now takes the shore road, and `routeSurface.test.ts`
fails any shipped route that runs over water or off its drawn roads.

Under v1 (point RMS ≤ 6 m) this world failed at 18.17 m, and no 30 m DEM
could pass: on Ticino's 30–40° slopes neighbouring GLO-90 nodes differ by
70 m, so the point figure mostly measures where in its cell a sample fell.
GLO-30 is sharper than EU-DEM, so it scores *worse* at the points (19.47 m)
and far better at the node. Under v2 the gate reads the heightfield at the
node, and the GLO-30 bundle passes with 1.81 m, 4.43 m inside the bound. In
quadrature that is an own error of √(1.81² − 1.71²) = 0.59 m against the
6.00 m allowance. EU-DEM's own error was √(8.88² − 1.71²) = 8.71 m.

- **Against the floor.** The 1.71 m mountain floor (`MOUNTAIN_FLOOR_RMS_M`)
  was measured on the 50 draws of the pre-#32 Lugano extent (four tiles, card
  t_045a5081), and re-measuring it there gives 1.71 m again. On the shipped
  extent's 50 samples, raw GLO-30 at the node scores 2.41 m (bias −0.10 m,
  max 9.89 m). The bundle scores 1.81 m: 0.10 m above the floor constant and
  0.60 m under raw GLO-30 on the same samples. Bundle and raw GLO-30 differ
  by 0.67 m RMS at the nodes (max 2.41 m) and 0.33 m at the points: the 15 m
  transverse Mercator resample and the 1/32 m quantisation. No sample lies on
  a route corridor, so the carve isn't in either figure. (The ruling's
  original 6.53 m floor came from a prototype that read the PixelIsPoint
  tiles as PixelIsArea; see "DEM source" above.)
- **Datum.** GLO-30 and Open-Meteo's GLO-90 are both EGM2008 heights from the
  same WorldDEM lineage, so no datum term enters the gate. Bias at the node
  is −0.05 m.
- **The worst sample** is −7.49 m at (46.1148, 8.91291): Open-Meteo 726 m,
  heightfield 718.5 m, raw GLO-30 at the node 716.1 m. GLO-30's pixel and
  GLO-90's node disagree there, and the resample is in fact 2.4 m closer.
  It's the only sample over 6.24 m.
- Open-Meteo answered every one of the 50 samples from the node the rule
  picks (`node_answer_mismatches` 0). The per-point rows are in
  `tools/worldbake/reports/lugano.json`.

**On the routes.** swissALTI3D (2 m lidar terrain, `api3.geo.admin.ch`,
LN02 heights) every 250 m puts the GLO-30 route 4.7–4.9 m high on average.
The EU-DEM route was 7.8–11.1 m high. The GLO-90 profile itself is 16.0 m RMS
off on Locarno–Brissago (mean +10.9 m), most likely because Open-Meteo's
north-west node lies upslope of that shore road. So the bigger
`maxRenderMinusProfileM` in the report (20.69 m, 23.08 m; EU-DEM 14.94 m,
9.82 m) measures the profile, not the bundle. The largest remaining error is
Lugano–Melide above Paradiso: GLO-30 sits 16–21 m over swissALTI3D at 2.25–2.5
and 3.25–3.5 km, where EU-DEM sat 10–18 m over it (at most 5.9 m less, at
2.5 km). At 5 km the road drops 14.8 m to within 0.6 m of swissALTI3D. From that
lower eye height the nearer slope hides a switchback (road 27116) that showed
on the EU-DEM hillside: line of sight 37/37 points before, 0/37 after.

GLO-30 is a surface model (buildings and canopy in, water flattened); see
"DEM source" above. Chase shots before and after (one build, bundles
swapped) at Lugano–Melide 2.4, 3.25 and 5 km and Locarno–Brissago 6.75 and
7.35 km, at 1440 and 390, show no spikes, no terrain through roads or
buildings, and the rider on the road. The steep slopes get more relief, and
more of the pale steep-face shading. Four of them are in
`docs/design/screenshots/v2/build/lugano-glo30/`.

### Chengdu Luxe Lakes

The first remote world (card t_55f6c646): 8.8 × 12.9 km at 12 m (`x
−4400…4408`, `y −6400…6500` around 30.432° N 104.075° E, 735 × 1076 nodes) in
Tianfu New Area, holding the Luxe Lakes (Luhu) loop and Xinglong Lake's signed
clockwise cycle loop (OSM relation 18146670), 11 km apart north to south.
Baked 11 Nov 2026 on cat-bed from Copernicus GLO-30 and OSM as of 1 Nov 2026,
published as `worlds/chengdu-luxelakes/80e66bc0c3354d4b/`.

| Check | Result |
| --- | --- |
| Bake time | 10 s from cache |
| Determinism | an `--out` bake and the committed bake from cache: identical bytes for all 8 files (checked at each of the six bakes on this card) |
| Size | 1.84 MB as shipped (gzip), 1.51 MB brotli, 3.41 MB raw; the first ride downloads 1.78 MB (`e2e/remote-world.spec.ts`) |
| Routes | Luxe Lakes 11.18 km, Xinglong Lake 8.19 km: max gap 0 m; grade Δ 0.315 / 0.585 pp; both loops meet themselves at one height (steepest 10 m step 5.8 % / 4.2 %); 100 % within 1 m of mapped roads; painted guide 100 % on drawn roads (37.3 m and 1 m eased; the fit bends 8 roads by at most 0.45 m, no joins) |
| Heightfield vs Open-Meteo, 50 seeded points (seed 30432) | P1.3 v2: `standard` (steep fraction 0.0638), registered **2.35 m ≤ 6.00 m, PASS**; point RMS 5.66 m, max \|registered\| 11.06 m (reported only); 0/50 answers from another node. The two worst points (−11.06 m, −9.73 m) lie on dug lakes, where the GLO-90 reference also has the land the lakes were dug from; the 39 points more than 100 m from any water give 0.99 m. Before `flatLakes` the whole set gave 1.09 m |
| Heightfield range | 451.0–538.5 m; 157 lakes and ponds levelled (37,926 nodes under water; Xinglong Lake spanned 455.7–483.7 m and now lies at 456.26 m; max cut 33.6 m); 15,339 nodes carved under the routes (max 19.6 m), 260 lake nodes put back to level after the carve; 120 m and 68 m of the routes run in mapped underpasses |
| Content | 4,913 road pieces, 165 water areas + 72 waterways, 776 landcover areas, 794 buildings, 154,675 trees |

Tianfu's towers are thinly mapped in OSM (794 buildings over 114 km²), so the
skyline is sparser than the real one; parks, lakes and the planted lakeshore
carry the world.

### Cuyahoga Valley (Ohio & Erie towpath)

Remote world `ohio-erie-towpath` (card t_0e76502b): 8.0 × 23.7 km at 12 m
(`x −4000…4016`, `y −11836…11900` around 41.292° N 81.587° W, 669 × 1979
nodes) down the Cuyahoga Valley from Rockside Road to Peninsula, holding
`scenic-cuyahoga-towpath` and `scenic-cuyahoga-towpath-north` (Lock 39 to
Station Road Bridge), both on the Ohio & Erie Canal Towpath Trail. Baked
11 Nov 2026 on cat-bed from Copernicus GLO-30 and OSM as of 1 Nov 2026, with
`bridges`.

| Check | Result |
| --- | --- |
| Bake time | 15 s from cache |
| Determinism | an `--out` bake and the committed bake: identical bytes for all 9 files |
| Size | 4.06 MB as shipped (gzip), 3.39 MB brotli, 7.43 MB raw |
| Routes | 17.43 km and 10.35 km: max gap 0 m; grade Δ 0.328 / 0.177 pp; 100 % within 1 m of mapped roads; guide 100 % on drawn roads (218 m and 219 m eased, no joins) |
| Heightfield vs Open-Meteo, 50 seeded points (seed 41292) | P1.3 v2: `standard` (steep fraction 0.1254), registered **1.69 m ≤ 6.00 m, PASS**; point RMS 4.37 m |
| Heightfield range | 168.6–389.6 m; 22,182 nodes carved under the routes (max 26.1 m) |
| Bridges | 207 decks, 19 pieces ridden (the Beaver Marsh boardwalk, 514 m, and the trail's creek bridges); the towpath passes under the Ohio Turnpike (I-80) with 40 m clearance, I-271 with 15–19 m, the Brecksville–Northfield High Level Bridge with 41 m; Rockside Road, East Pleasant Valley Road, Main Street (Peninsula) and three footbridges were lifted to the 4.5 m headroom; 96 piers |
| Content | 8,176 road pieces, 353 water areas + 257 waterways, 1,763 landcover areas, 1,755 buildings, 480,000 trees |

Known limit: GLO-30 is a surface model, and in this forested valley the
canopy pulls the route fit's offset up 10–17 m. Where the towpath leaves the
trees (Peninsula) it stands 6–9 m over the open ground, so Main Street's
bridge over it has a 15 m lift at its west abutment and a 300 m approach
viaduct into the village. It is drawn as a structure, but real Main Street is
at grade there; a canopy-aware route offset is the fix.

### Cleveland lakefront

Remote world `cleveland-lakefront` (card t_0e76502b): 14.7 × 7.1 km at 12 m
(`x −7400…7276`, `y −2640…4500` around 41.505° N 81.718° W, 1224 × 596
nodes) along Lake Erie from Lakewood Park to Gordon Park, holding
`scenic-cleveland-lakefront` (the Lakefront Bikeway, OSM relation 13620723)
and `scenic-wendy-park-lakewood` (Wendy Park, Whiskey Island, Edgewater and
Lake Avenue to Lakewood Park). Baked 11 Nov 2026 on cat-bed from Copernicus
GLO-30 and OSM as of 1 Nov 2026, with `bridges`.

| Check | Result |
| --- | --- |
| Bake time | 7 s from cache |
| Determinism | an `--out` bake and the committed bake: identical bytes for all 9 files |
| Size | 1.35 MB as shipped (gzip), 1.05 MB brotli, 3.67 MB raw |
| Routes | 13.51 km and 8.11 km: max gap 0 m; grade Δ 0.339 / 0.362 pp; 100 % within 1 m of mapped roads; guide 100 % on drawn roads (37 m and 202 m eased, no joins) |
| Heightfield vs Open-Meteo, 50 seeded points (seed 41505) | P1.3 v2: `standard` (steep fraction 0.0095), registered **0.52 m ≤ 6.00 m, PASS**; point RMS 2.02 m |
| Heightfield range | 163.5–228.4 m; 16,591 nodes carved (max 25.1 m) |
| Bridges | 222 decks, 12 pieces ridden, among them the Detroit–Superior Bridge (792 m, up to 18.6 m over the Flats) and West 3rd Street over the railway; the route passes under the Memorial Shoreway at six places and the Lakeland Freeway at two, each lifted onto 64–154 m approach ramps (lift ≤ 6.2 m) to keep 4.5 m headroom; 1,343 nodes lowered under decks (the Main Avenue viaduct's DSM ridge, max 14.1 m); 442 piers and abutment blocks |
| Content | 15,627 road pieces, 30 water areas + 6 waterways, 1,376 landcover areas, 16,014 buildings, 26,469 trees |

Lake Erie is the world's largest water area (61.6 km² of lake polygon in the
extent), drawn level with the shore; the route stays on the shore paths.

### Adding a world

The full procedure, hosting included, is [ADDING-A-WORLD.md](ADDING-A-WORLD.md).

1. Write `tools/worldbake/worlds/<id>.json`. Set `origin` near the middle and
   size the `grid` to cover the routes plus 100 m (≤ 2048 nodes a side, about
   13 m cells). List the scenic route ids, choose an `osmDate` and moods, the
   DEM source (`"dem": { "zoom": 13 }`, or `"dem": { "source": "copernicus-glo30" }`,
   the default for mountain terrain) and `"validation": { "sample_seed": <int> }`.
2. Bake on the bake host and check the log: every route has gap 0 and grade
   Δ ≤ 1 pp, the bundle is ≤ 8 MB and the P1.3 check says PASS (registered
   RMS ≤ 6.00 m standard, ≤ 6.24 m mountain).
3. Commit the bundle, the report, the recipe (with the validation block the
   bake wrote into it) and the updated CREDITS.md block.
