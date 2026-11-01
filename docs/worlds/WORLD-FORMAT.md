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
| Bake pipeline | `tools/worldbake/{bake,fetchDem,fetchOsm,buildHeightfield,buildVectors,snapRoutes,validateDem,util}.mjs` |
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
```

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
  (the route profiles use the same convention).
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
| `layers` | File name per layer: `roads`, `water`, `landcover`, `buildings`, `vegetation`, `routes`. |
| `files[]` | `{ path, bytes, sha256, compression, contentBytes, contentSha256 }` for every file except the manifest. |
| `moods`, `defaultMood` | Scene moods that suit the world (ids from the mood catalogue). |
| `pois[]` | `{ name, kind, rank?, x, y, h, osm }`, kind ∈ town, village, peak, viewpoint, landmark, church. `h` is the ground height there. `rank` (1–3) is label prominence: 3 towns, 2 places with a Wikipedia/Wikidata tag or ≥ 1,000 people, 1 the rest. Bundles baked before ranks omit it; renderers then rank by kind. |
| `routes[]` | `{ id, name, lengthM, maxGapM, gradeMeanAbsDiffPct }` per snapped scenic route (ids match `src/lib/scenicRoutes.ts`). |
| `stats` | Counts (roads, buildings, trees, …) for logs and UI. |
| `credits[]` | `{ id, name, licence, url, attribution }`: show these wherever the world is shown. |
| `generator` | Tool version, recipe SHA-256, OSM snapshot date, DEM source/zoom/tile count. |

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
     but sits at the real terrain's level;
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
  "flags": { "bridge": 1, "tunnel": 2, "unpaved": 4, "oneway": 8 },
  "names": ["Via …", …],
  "roads": [ { "c": 2, "f": 1, "w": 6.5, "n": 0, "p": [x0, y0, x1, y1, …] } ] }
```

- `c` indexes `classes` (OSM `highway`, `_link` folded into its parent). The
  carriageway width is `w` (from the OSM `width` tag) or `widths[c]`.
- `f` is a bit set of `flags` (omitted when 0); `n` indexes `names`.
- Polylines are clipped to the extent and simplified (Douglas–Peucker 0.5 m).
  Heights come from the heightfield.

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
in fields (broadleaf). Every seed keeps 1.8 m clear of road edges, 1.5 m of
building walls and out of open water. Character kinds are kept whole;
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
bake, copy `public/worlds/<id>/`, `tools/worldbake/reports/<id>.json` and
`docs/worlds/CREDITS.md` back. Downloads are cached under
`tools/worldbake/cache/<id>/` (git-ignored). Needs Node ≥ 22.18 (TypeScript
type stripping), no npm packages.

- **Deterministic**: the same recipe and inputs give byte-identical files.
  OSM queries are pinned to the recipe's `osmDate` (Overpass attic data), so a
  clean-cache bake downloads the same OSM state. Terrain tiles are static.
- **Checks** the bake runs: manifest validation, height round-trip, route gap
  and grade, bundle size, and the heightfield against 50 seeded Open-Meteo
  (Copernicus GLO-90) samples (RMS ≤ 6 m).

Perugia, 31 Oct 2026 on cat-bed (Node 26), from a clean cache:

| Check | Result |
| --- | --- |
| Bake time | 342 s (Overpass ≈ 5 min of it) |
| Determinism | two clean-cache bakes, identical SHA-256 for every file |
| Size | 4.73 MB as shipped (gzip), 3.56 MB brotli, 9.5 MB raw |
| Heightfield vs Open-Meteo, 50 seeded points | RMS 5.96 m, bias −1.18 m, max 18.2 m |
| Routes | max gap 0 m; grade Δ 0.109 pp (Tiber park), 0.101 pp (Assisi valley) |

The 50-point RMS passes, but only just. Spot checks of 500 more points
(5 seeds × 100) gave RMS 6.0–8.2 m, about 7.0 m overall. The raw z12 and z13
terrarium tiles give the same figures, so the gap is between the two source
DEMs (EU-DEM in the Terrain Tiles and Copernicus GLO-90), not loss in the
bake. Most of it comes from steep slopes, where 90 m and 30 m cells disagree
most.

### Perugia coverage

The world is 26 × 14 km (`x −6000…20000`, `y −8501…5500` around Perugia's
centre). It covers Perugia's hill, the Tiber at Ponte San Giovanni and the
Assisi valley floor, so it holds both `scenic-perugia-tiber-park` and
`scenic-assisi-valley`. The blueprint's "~14 × 14 km" couldn't reach the
Assisi route, 18 km east of the centre. `scenic-trasimeno-shore`
(Castiglione del Lago, 30 km west) is left for its own world; stretching this
one to 45 km would cost resolution and budget.

### Adding a world

1. Write `tools/worldbake/worlds/<id>.json`. Set `origin` near the middle and
   size the `grid` to cover the routes plus 100 m (≤ 2048 nodes a side, about
   13 m cells). List the scenic route ids, choose an `osmDate` and moods.
2. Bake on the bake host and check the log: every route has gap 0 and grade
   Δ ≤ 1 pp, the bundle is ≤ 8 MB and validation passes.
3. Commit the bundle, the report and the updated CREDITS.md block.
