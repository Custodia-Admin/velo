# Adding a world

How to bake a place (your hometown, say) as a three.js world that rides with
no token. Everything comes from open data and needs no API key: OpenStreetMap
for the roads, water, buildings and trees, Copernicus GLO-30 or the AWS
terrain tiles for the ground, and OSRM for routes that aren't a signed cycle
route. Chengdu Luxe Lakes (blueprint §P3.1) was the first world done this way;
Perugia and Lugano ship in the repo.

The details are in [WORLD-FORMAT.md](WORLD-FORMAT.md) (bundle, recipe, bake,
terrain gate) and [DESTINATIONS.md](DESTINATIONS.md) (how Home shows a place).

## 1. Routes first (at least two Easy & Scenic)

A world draws routes that already exist in `src/lib/scenicRoutes.ts`.

1. Add each new route to `scripts/scenicRouteSources.mjs`:
   - prefer a signed OSM cycle route (`relation: <id>`);
   - otherwise use OSRM bike waypoints (`waypoints: [[lat, lon], …]`).
   Check on the map that OSRM doesn't take a ferry or a boat line.
2. Build only the new route. A full rebuild re-routes everything:

   ```bash
   ONLY=scenic-<id> node scripts/build-scenic-routes.mjs
   ```

3. Give it its metadata in `src/lib/scenicRoutes.ts`: name, place, scenery and
   mood.
4. List it in the destination manifest's `routes`
   (`src/lib/world/destinations/<place>.json`).

The source list is shared with the bake: `"routeCredits": true` in the recipe
writes one manifest credit per route, linking the OSM relation or the exact
OSRM query.

## 2. Recipe

Write `tools/worldbake/worlds/<id>.json` (schema `recipe.schema.json`). Start
from `chengdu-luxelakes.json`:

- `origin`: near the middle of the routes.
- `grid`: the routes plus a margin, at most 2048 nodes a side. 12 m cells fit
  about 9 × 13 km; a bigger world needs bigger cells.
- `"dem": { "source": "copernicus-glo30" }`.
- `osmDate`: a fixed date, so a clean-cache bake downloads the same OSM.
- `routes`, `moods`, `defaultMood` (a mood from `skyModel.ts`), and
  `"validation": { "sample_seed": <int> }`.
- `"host": "remote"`: the bundle goes to an R2 bucket (step 4), not to
  `public/worlds/`. Leave it out to ship the bundle with the app in
  `public/worlds/<id>/`, like Perugia and Lugano. That is the simplest choice
  for your own hometown in a fork; keep it at most 8 MB brotli.
- `"routeCredits": true`.
- `vegetation.corridor` (`{ "m": 300, "keep": 0.3 }`) if the routes run
  through forest. Measure the render workload against Perugia first: ride
  with `velo.debug.three` and read `__veloRideDebug().triangles` every
  kilometre at medium, 1920×1080. If the new world draws much more than
  Perugia (1.31 M triangles on average, 1.54 M at most), keep the woods along
  the routes and thin the rest with the corridor rather than thinning
  everything: uniform thinning leaves the ride in open parkland (Cuyahoga
  Valley, WORLD-FORMAT.md).
- `"bridges": true` if a route rides a bridge or passes under one (any
  viaduct, overpass or footbridge over it). The bake then builds bridges as
  structures ([WORLD-FORMAT.md](WORLD-FORMAT.md#bridgesjson-bridges-as-structures)):
  decks over every route with 4.5 m headroom, approach ramps where that lifts
  an abutment, the rider on the decks the route rides and on the ground under
  every other one. The log line `bridges:` gives the decks, pins and lifts;
  the bake fails when a route would pass under a deck without the headroom.
  A route that starts or ends on a spiral ramp under its own bridge (Wendy
  Park) cannot be fitted: move that end of the route off the ramp.
- `"flatLakes": true` if the place has lakes dug after 2015. GLO-30 was flown
  in 2011–2015, so it still carries the land those lakes were dug from, and
  the water would be drawn as a tilted, bulging sheet. The step
  (`tools/worldbake/flatLakes.mjs`):
  - levels each OSM lake and pond at the lowest point of its shore;
  - lowers the one-cell strip round it to that level;
  - caps the banks at 1:2.
  The route carve runs after this; lake nodes it lifts are put back to level,
  except the route's core, so a route crossing a lake arm keeps its
  embankment. The manifest then carries `generator.flatLakes: true`, and the
  renderer draws each level lake flat, keeping the ground that stands above
  it dry. Check the report's `flatLakes` entries: `before` is the terrain range
  the lake used to cover. Expect the P1.3 registered RMS to rise a little: the
  reference DEM is as old as GLO-30, so points on a dug lake now disagree with
  it (Chengdu: 1.09 m before, 2.35 m after, 0.99 m away from the water).
- `"coast": true` if the world reaches the sea. OSM has no sea polygons, only
  `natural=coastline` ways (land on the left, water on the right). The bake
  fetches one more Overpass layer for them (and `natural=beach`/`sand`), and
  `tools/worldbake/coast.mjs`:
  - joins the coastline ways into chains, clips them to the extent and closes
    them along its edge into the sea, islands as holes, shipped as a water
    area of kind `sea`;
  - sets every node under the sea to 0 m and the one-cell strip round it no
    higher (GLO-30 and the coastline disagree by metres, and the DSM carries
    piers and boats);
  - slopes each `natural=beach` down to the water at 1:25 (GLO-30 reads a
    beach as a shelf 4–7 m above the sea that hides the water from the road
    behind it; `natural=sand` also maps dunes, so it is left alone);
  - ships beaches and sand as landcover kind `beach`.
  The route carve runs after this; sea nodes it lifts go back to 0 m except
  the route's core. A coastline that stops inside the world fails the bake:
  the snapshot is broken, pick another `osmDate`. Give the grid an extra
  1–1.5 km on the sea side so the water runs out to the edge; the renderer
  carries it on past the edge to the far plane (`seaApron`). Recipes without
  the flag fetch and bake exactly as before.

## 3. Bake

The bake needs Node ≥ 22.18 (TypeScript type stripping) and nothing else: no
npm packages, no keys.

```bash
node tools/worldbake/bake.mjs <id>
```

A clean bake of a Perugia-sized world takes 5–6 minutes, nearly all of it
Overpass downloads. They are cached under `tools/worldbake/cache/<id>/`
(git-ignored), so a re-bake takes about 20 seconds. To keep a laptop free,
bake on another machine: copy the tree there, bake, and copy the outputs
listed below back.

```bash
rsync -a --exclude node_modules --exclude .git --exclude dist ./ <bake-host>:velo-bake/repo/
ssh <bake-host> 'cd ~/velo-bake/repo && node tools/worldbake/bake.mjs <id>'
```

To check determinism, run the same bake once more with `--out <dir> --no-docs`.
Every file must be identical: compare them with `cmp`.

The log must show:

- every route with max gap 0 m and grade Δ ≤ 1 pp;
- every route 100 % on drawn roads;
- with `bridges`, no bake error, and the report's `bridges.approaches` read
  through: a lift of many metres means the route fit sits above the ground
  there (see the Cuyahoga Valley notes in WORLD-FORMAT.md);
- a bundle of at most 8 MB brotli;
- `validate (P1.3 v2): … PASS`. The bound is registered RMS ≤ 6.00 m for a
  standard world, or ≤ 6.24 m for a mountain world.

Play mode's postcards come from the manifest's named places (`pois`) that
each route passes (`routeLandmarks`). A route that passes fewer than 3 gets
evenly spaced, unnamed postcards instead (`worldPostcards` in
`src/lib/play/threePlayLayer.ts`), so it still plays, but without place
names. Chengdu's loops are like this: its only OSM places are districts.
`threePlayLayer.test.ts` walks every catalog world, so a new world needs no
test change for this.

The bake writes (copy these back if it ran elsewhere):

- `public/worlds/<id>/`, or `tools/worldbake/remote/<id>/` for a remote world
  (the manifest and the layer files);
- `tools/worldbake/reports/<id>.json`;
- the recipe, which now has its `validation` block;
- `docs/worlds/CREDITS.md`;
- `src/lib/world/destinations/<place>.json`.

The last one is there because a bake that writes to its default place also
syncs the destination.

To link a new world to its destination, set the destination's `world` to
`{ "id": "<id>" }` before the bake. `syncDestinations.mjs` fills in the rest.

## 4. Hosting: publish to R2

Only `manifest.json` of a remote world is committed. `.gitignore` keeps the
layer files out.

```bash
node tools/worldbake/publish.mjs <id> --dry-run   # shows the target and the files
node tools/worldbake/publish.mjs <id>
```

- The bundle goes to `worlds/<id>/<hash>/` in the public bucket `velo-worlds`
  (in a fork: your own bucket with `--bucket <name> --public-url <base>`, and
  the same base in `DEFAULT_REMOTE_WORLDS_URL` below).
- `<hash>` is the first 16 hex digits of the manifest's SHA-256. The manifest
  pins the SHA-256 of every file, so the hash names the whole bundle.
- A re-bake that changes any byte gets a new directory. A published URL never
  changes, so objects are uploaded with
  `Cache-Control: public, max-age=31536000, immutable`.
- Layers are uploaded first and the manifest last. Files already published at
  the same size are skipped.
- Every file is then read back from the public URL and checked against its
  SHA-256.
- It needs `wrangler` logged in to the Cloudflare account (`npx wrangler@4 whoami`).
  The bucket is on the free tier: r2.dev public access, CORS GET/HEAD from any
  origin.

Once the new destination is pushed, delete the bundle it replaces, so the
bucket holds only bundles a destination points at. Every file is listed in
the old manifest's `files`, plus `manifest.json` itself:

```bash
B=https://pub-26367e714cf944b59b97a34ecb76922b.r2.dev/worlds/<id>/<old-hash>
for f in $(curl -s $B/manifest.json | jq -r '.files[].path') manifest.json; do
  npx wrangler@4 r2 object delete "velo-worlds/worlds/<id>/<old-hash>/$f" --remote
done
```

The app reads remote worlds from `DEFAULT_REMOTE_WORLDS_URL` in
`src/lib/world/catalog.ts`. That must be the same value as in
`tools/worldbake/worldBundles.mjs`, and `worldCache.test.ts` pins the two
together.

- **A different host.** For a self-hosted mirror (e.g. an nginx serving
  `<root>/worlds/` with the same `<id>/<hash>/` layout), build with
  `VITE_WORLDS_REMOTE_URL=<base>/worlds/`. Worlds in `public/worlds/` are not
  affected.
- **CSP.** The origin has to be in `connect-src` in `vercel.json`, and a test
  checks it.

Get the files back in a fresh checkout (CI does this before the unit tests):

```bash
node tools/worldbake/fetchPublished.mjs [id…]
```

- It downloads only missing or wrong-size files.
- It keeps a file only on a SHA-256 match.
- The served manifest must be byte-identical to the committed one.

The bundle tests (route fit, route surface, water budget, P1.3 reload, partner
continuity) read every world whose files are on disk. With
`VELO_REQUIRE_REMOTE_WORLDS=1`, which CI sets, a remote world without its files
fails instead of being skipped.

## 5. Loading and offline

- `loadWorld(url, { cache })` reads the Cache API store `velo-worlds-v1` first.
- It stores a file only after the file passes its size and SHA-256 checks.
- A cached copy that fails a check is dropped and fetched again.
- The ride (`ThreeWorldView`) and the landmarks hook pass the cache only for
  remote worlds. Bundles in `public/worlds/` are rewritten in place by a
  re-bake, so a cached copy would go stale.
- The service worker has a CacheFirst rule for the same URLs under the same
  cache name (`vite.config.ts`), so whichever fetched a file first serves the
  other.
- The rider model is precached, so after one ride the next one starts with the
  browser offline. `e2e/remote-world.spec.ts` checks this, and also checks that
  the first ride downloads at most 8 MB.

## 6. Tests and evidence

- Add the world's water triangle count to `BUDGET` in `waterMesh.test.ts`. The
  failure message gives the number. The sea is tessellated at
  `SEA_EDGE_FACTOR` × the lattice edge (it is level), so a coast world stays
  near a lake world's count.
- `destinations.test.ts`, `catalog.test.ts` and `ScenicHome.test.ts` pin where
  the place shows on Home. A wishlist place with a world leads
  "Places we want to go".
- Take ride shots at 1280×648@2 and 390×844, at noon and golden hour, at 0.5, 3
  and 6 km of each route (`scripts/route-clearance-shots.py`, env `ROUTE`,
  `SPOTS`, `TIMES`, `SIZES`). Check that:
  - the rider is on the drawn road;
  - there is one road surface;
  - there is no void;
  - on a coast world, that the coast reads as coast: pick spots where the
    route runs within ~100 m of the water (a wide beach or a row of hotels
    hides the sea from the road, as it does in life).
- Measure fps with the HUD on, at medium, on an Intel iGPU (the reference is
  an Arrow Lake iGPU through ANGLE GL-EGL; `scripts/world-hud-fps.py`). The
  bar is ≥ 58 fps. Measure with nothing else on that GPU: no other
  `world-hud-fps.py` or `route-clearance-shots.py` before or during a run.
  Note `/proc/loadavg`, and interleave with a reference world (Perugia reads
  60). Buildings are what a dense city costs: each tier draws at most
  `buildingTris` building triangles, nearest chunks first (`quality.ts`), so
  a metro world stops short of `buildingM`. Past `buildingDetailM`, chunks
  draw boxes with a plain material and no shadows. If a city's footprints are
  surveyed to the corner (Los Angeles County: 9.6 vertices a building, against
  Lugano's 6.4), also set `"buildingSimplifyM": 1` in the recipe.
- Add a section for the world to WORLD-FORMAT.md with the bake figures.
