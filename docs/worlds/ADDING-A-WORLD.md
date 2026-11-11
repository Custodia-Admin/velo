# Adding a world

How to bake a place as a three.js world and ship it without growing the repo.
Chengdu Luxe Lakes (card t_55f6c646, blueprint §P3.1) was the first world done
this way. The other wishlist worlds follow the same steps.

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
- `"host": "remote"`: the bundle goes to R2, not to `public/worlds/`.
- `"routeCredits": true`.
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

## 3. Bake on cat-bed

Heavy work runs on cat-bed, never on the laptop. Copy the tree there and bake:

```bash
rsync -a --exclude node_modules --exclude .git --exclude dist ./ cat-bed:velo-bake/<card>/repo/
ssh cat-bed 'cd ~/velo-bake/<card>/repo && node tools/worldbake/bake.mjs <id> --cache ~/velo-bake/repo/tools/worldbake/cache'
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

Copy these back:

- `tools/worldbake/remote/<id>/` (the manifest and the layer files);
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

- The bundle goes to `worlds/<id>/<hash>/` in the public bucket `velo-worlds`.
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

- **A different host.** For a household mirror (e.g. cat-bed's nginx,
  `~/velo-serve/worlds/` with the same `<id>/<hash>/` layout), build with
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
  failure message gives the number.
- `destinations.test.ts`, `catalog.test.ts` and `ScenicHome.test.ts` pin where
  the place shows on Home. A wishlist place with a world leads
  "Places we want to go".
- Take ride shots at 1280×648@2 and 390×844, at noon and golden hour, at 0.5, 3
  and 6 km of each route (`scripts/route-clearance-shots.py`, env `ROUTE`,
  `SPOTS`, `TIMES`, `SIZES`). Check that:
  - the rider is on the drawn road;
  - there is one road surface;
  - there is no void.
- Measure fps with the HUD on, at medium, on cat-bed's iGPU
  (`scripts/world-hud-fps.py`). The bar is ≥ 58 fps.
- Add a section for the world to WORLD-FORMAT.md with the bake figures.
