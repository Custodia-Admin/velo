# Velo v2 — Architectural Blueprint

Architect consult 1 of 3 (claude-fable-5-1), 2026-10-31. Owner: Federico Brooks.
Repo: `/home/federicob/Projects/velo` (fork of masonwyatt23/globeride, MIT).
Running tonight: `velo/ride-tonight` worktree, 2,001 tests green.

Mandate: full creative liberty, best riding app in the world, real 3D is
mandatory, works with **zero third-party tokens**, no new spend, then open
source with upstream credit.

---

## 0. The decision in one paragraph

Pick **(e) Hybrid, weighted toward (d)**: Velo's default and only *required*
ride renderer becomes an **own three.js world renderer** fed by **baked
"world bundles" generated from real open data** (Mapzen/Tilezen terrarium
DEM + OpenStreetMap vectors + the p2e OSRM/Open-Meteo routes). Real geometry,
stylized art direction — Perugia looks like Perugia, Lugano like Lugano,
without a single API key at runtime. Cesium stays in the codebase as (1) the
Explore globe (token-free with OSM imagery, already works) and (2) an
**opt-in "Photoreal (bring your own Cesium ion token)"** ride mode behind the
same renderer interface, frozen in feature scope. Option (b) (self-hosted
quantized-mesh terrain) is explicitly **not** built now; the seam leaves room
for it later.

### Why not the others

| Option | Verdict | Reason |
| --- | --- | --- |
| (a) Cesium + ion | Opt-in only, never default | Violates the token-free hard requirement; the "photoreal" the household liked was Google Photorealistic 3D Tiles (ion asset 2275207), which is Google-owned, token-gated and **cannot be self-hosted** under any plan. Tonight's black globe is the structural outcome, not a bug. |
| (b) Cesium + self-hosted terrain | Deferred | Removes the token, but at bike-seat height a 30 m DEM draped with free imagery (OSM raster, EOX Sentinel-2 at 10 m/px, Esri with attribution caveats) looks worse than tonight's flat-map fallback with buildings. Baking quantized-mesh (ctb-tile) is fine; the **imagery** is the dead end. Free orthophotos at ≤0.5 m/px don't exist globally. Beauty would still depend on ion. |
| (c) MapLibre + terrarium + three overlay | Rejected | MapLibre's terrain is a map camera (pitch cap, no true ground-level chase cam); a synced three.js overlay is fragile and still reads as 2.5D. Full ride-view rewrite for a worse ceiling than (d). |
| (d) Own stylized worlds | **Core** | Zwift's actual recipe, but generated from real data instead of hand-built. Token-free, self-hosted, offline-cacheable per world (a bundle is MBs, not GBs), art-directable (time of day, moods, weather, game layer), and the **route sim and the terrain come from the same bake**, which structurally fixes the avatar-vs-terrain mismatch. |
| (e) Hybrid | **Chosen** | (d) as the product; Cesium photoreal retained behind a seam for people who bring a token (and for the upstream community). No second feature track: new ride features target the renderer interface, and the Cesium path only gets what falls out of the seam for free. |

### Engine

three.js + `@react-three/fiber` + `@react-three/drei` + `postprocessing`.
Not Babylon: smaller bundle for what we use, larger worker familiarity, r3f
keeps scene composition in React alongside the existing stores. Not raw
three without r3f: the ride view must stay declarative and testable
(`@react-three/test-renderer`).

### Bake pipeline (who builds worlds, from what)

Node ESM scripts in `tools/worldbake/`, run on the laptop (minutes per world;
no spot VMs needed unless we bake dozens — then the standard Alibaba spot
skill). Inputs, all key-free:

- **Elevation:** AWS Terrain Tiles (`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`), z12–13 for a 12–20 km world; attribution per Tilezen's `joerd` attribution list. Keep Copernicus GLO-90 via Open-Meteo for route profiles (already in p2e).
- **Vectors:** Overpass API (bbox query, one bake per world, raw response cached under `tools/worldbake/cache/` git-ignored): roads (highway=*), water (natural=water, waterway, coastline), landuse/forest (→ tree instancing seeds), buildings (footprint + height/levels), POIs with names (→ landmarks, postcards). ODbL attribution.
- **Routes:** `scripts/build-scenic-routes.mjs` output (OSRM bike profile + Open-Meteo). The bake **resamples each route's render elevation from the world heightfield** so the rider always touches the ground; the FTMS grade keeps using the smoothed route profile.

Output per world (`<id>/`): `manifest.json` (name, bbox, origin, EPSG-local
projection params, moods, POIs, routes, credits), `height.bin` (16-bit
heightfield, ≤2048²), `roads.json`, `water.json`, `vegetation.bin`
(instance seeds), `buildings.bin` (extrusion data), gzip/brotli. Target
≤8 MB per world compressed.

### Hosting and delivery

- App: Cloudflare Pages (free). Vercel config stays for upstream parity.
- Home worlds (Perugia, Lugano) ship in `public/worlds/` and are precached by
  the PWA (raise `maximumFileSizeToCacheInBytes` accordingly, cap total precache ≤40 MB).
- Destination worlds: Cloudflare R2 public bucket (free tier: 10 GB storage,
  zero egress). `VITE_WORLDS_BASE_URL` points there; a world is fetched on
  first ride and stored in the Cache API via workbox `runtimeCaching`
  (CacheFirst, 180 days). Offline rides work for any world ridden once.
- No sentinel-pro-max involvement. No new subscriptions.

### Licensing summary (goes into `docs/worlds/CREDITS.md`)

OSM ODbL (share-alike applies to the derived vector data, not the app — bakes
are published under ODbL); Tilezen terrain tiles (mixed public-domain/open
sources, attribution list required); Copernicus DEM (ESA/EU free with credit);
Open-Meteo CC-BY 4.0; OSRM demo server is **bake-time only** and documented as
such (contributors scaling up self-host OSRM/Valhalla). All compatible with an
MIT app.

---

## 1. Target architecture (file map)

```
src/
  lib/ride/                      # renderer-agnostic ride domain (new)
    rideFsm.ts(.test.ts)         # explicit FSM: idle|ready|riding|paused|finished × source trainer|demo|workout|replay
    rideSim.ts(.test.ts)         # one pure step(): inputs → physics → position/grade/speed; wraps lib/physics.ts
    rideInputs.ts                # unified input bus: FTMS, handlebars, keyboard, demo
  lib/world/                     # world bundles (extend existing worldLayer.ts)
    manifest.ts                  # schema + zod-free validator, types
    loadWorld.ts(.test.ts)       # fetch/cache/decode, progress events
    heightfield.ts(.test.ts)     # sampleHeight(x,y), normal, chunking
    projection.ts(.test.ts)      # lat/lon ↔ world metres (local transverse Mercator)
    renderer.ts                  # WorldRenderer interface (mount, setRider, setCamera, setMood, dispose)
    director.ts(.test.ts)        # cinematic camera director (shot list, triggers)
  renderers/
    three/                       # default renderer
      ThreeWorldView.tsx         # r3f <Canvas>, implements WorldRenderer
      Terrain.tsx  Roads.tsx  Water.tsx  Vegetation.tsx  Buildings.tsx
      Sky.tsx  Weather.tsx  Rider.tsx  Ghost.tsx  ChaseCamera.tsx  Landmarks.tsx
      materials/ (toonTerrain.ts, road.ts, water.ts, foliage.ts)
      quality.ts                 # maps lib/graphicsQuality to r3f settings
    cesium/
      CesiumWorldView.tsx        # moved from components/ride/CesiumViewer.tsx, implements WorldRenderer, opt-in
  components/ride/RideView.tsx   # picks renderer from settings; HUD overlays
  components/velo/               # v2 UI (design-gated)
tools/worldbake/
  bake.mjs  fetchDem.mjs  fetchOsm.mjs  buildHeightfield.mjs  buildVectors.mjs  snapRoutes.mjs  manifest.schema.json
  worlds/*.json                  # per-world bake recipes (bbox, routes, moods, POIs picks)
public/worlds/perugia/  public/worlds/lugano/
docs/architecture/ADR-001-rendering.md  docs/worlds/CREDITS.md  docs/worlds/WORLD-FORMAT.md
docs/design/mockups/v2-*.html  docs/design/v2-identity.md
```

Keep untouched (own solid assets): `src/lib/ftms*.ts`, `src/lib/controllers/*`,
`src/lib/virtualGears.ts`, `src/lib/laneOffset.ts`, weather→wind mapping
(p2c), `src/lib/scenicRoutes*.ts` + `scripts/build-scenic-routes.mjs`,
`showStore` (p2b), `src/test/uiRules.test.ts` allow-list (frozen).

---

## 2. Phases, packets, acceptance

Legend: size S/M/L; worker = Opus 5.5 unless noted; every UI packet carries the
design gate (`docs/design/UI-RULES.md` §0: mockup → vision review → build →
1440/390 compare, tokens/shared components only, no raw px/hex in
`src/components/velo/`, `uiRules.test.ts` allow-list must not grow). Full
suites run in GitHub CI only.

### Phase 0 — Land tonight (packet 7: migration/sequencing)

**P0.1 Merge the stack to main.** (M, operator)
Order: #1 p2a → fix-road-corridor-material → #2 p2b → #3 p2c → #4 p2d → p3 →
p2e (when its data is baked). Rebase each onto the updated main, merge with a
merge commit (keep branch history), run CI each time.
Then `git diff main..velo/ride-tonight` must be **only** integration glue
(conflict resolutions, tonight's hotfixes). Open PR "integration: ride-tonight
fixes" for that residue; merge; delete worktrees except p2e.
AVC:
- CI green on main after the last merge; test count ≥ 2,001.
- `git diff main..velo/ride-tonight --stat` is empty after the residue PR.
- A token-free `npm run dev` on main starts a ride (currently flat-map fallback) without a black globe; `NoTokenBanner` shows but does not block.
- Tonight's five hotfixes each have a regression test or a named follow-up packet (P1.1 covers the ride-loop; overlay pointer-events, avatar height, BT copy, truncated-token guard each get a test in the residue PR).

**P0.2 ADR + brief update.** (S)
Files: `docs/architecture/ADR-001-rendering.md` (this decision, condensed),
`docs/VELO-BRIEF.md` (home = Perugia, hometown = Lugano; "no paid services"
→ "no tokens required; photoreal is opt-in with your own token"), `ROADMAP.md`.
AVC: docs reviewed by Federico; brief non-goals no longer mention the ion
token as a requirement.

### Phase 1 — Foundations (depends on P0)

**P1.1 Ride FSM.** (M)
Files: `src/lib/ride/rideFsm.ts`, `rideFsm.test.ts`; `src/stores/rideStore.ts`
delegates transitions; `src/hooks/useRideLoop.ts` consumes the FSM.
States: `idle → ready → riding ⇄ paused → finished`, orthogonal `source:
trainer|demo|workout|replay`, `trainer: disconnected|connecting|connected|lost`.
Transitions are a table; illegal transitions throw in dev, no-op in prod.
AVC:
- Table-driven tests cover every (state, event) pair; ≥ 95 % line coverage on `rideFsm.ts`.
- Regression tests named for tonight's failures: standstill (power 0 for 5 s keeps `riding`, speed decays to 0, no auto-pause unless setting on), pause/resume (FTMS resistance held on pause, restored on resume), trainer disconnect mid-ride (→ `trainer: lost`, ride keeps `riding` in demo-physics with a HUD state, reconnect restores without a second `startRide`), demo→trainer swap while `ready`.
- `rideStore.test.ts` still green; `rideState` strings unchanged for HUD consumers.

**P1.2 Renderer seam.** (L)
Files: `src/lib/world/renderer.ts`, `src/lib/ride/rideSim.ts(.test.ts)`,
`src/components/ride/RideView.tsx`, move `CesiumViewer.tsx` →
`src/renderers/cesium/CesiumWorldView.tsx` (re-export shim at the old path so
imports/tests keep working), `src/stores/settingsStore.ts` (`renderer:
'world' | 'photoreal'`, default `'world'`).
AVC:
- `rideSim.step()` is pure: given FSM state + inputs + route, returns position/heading/grade/speed; no Cesium import anywhere under `src/lib/ride/` or `src/lib/world/` (lint rule `no-restricted-imports`, tested in `src/test/architecture.test.ts`).
- Cesium path behaves identically (existing ride tests + a Playwright smoke ride in CI with a dummy token unset).
- Bundle: Cesium chunk is lazy (`import()` only when `renderer === 'photoreal'` or on `/explore`); initial JS for `/app` ≤ 600 kB gzip measured by `vite build` report.

**P1.3 World bake v0 (Perugia).** (L)
Files: `tools/worldbake/*`, `tools/worldbake/worlds/perugia.json`,
`public/worlds/perugia/*`, `docs/worlds/WORLD-FORMAT.md`,
`docs/worlds/CREDITS.md`, `src/lib/world/{manifest,loadWorld,heightfield,projection}.ts` + tests.
Bbox: ~14×14 km around Perugia covering the p2e home routes.
AVC:
- `node tools/worldbake/bake.mjs perugia` runs on the laptop in < 10 min from a clean cache, deterministic (same inputs → byte-identical outputs; hashes in `manifest.json`).
- Bundle ≤ 8 MB brotli; heightfield RMS error vs 50 random Open-Meteo samples ≤ 6 m.
- Every p2e Perugia route lies on the heightfield: `snapRoutes` reports max vertical gap 0 after snapping; grade series vs the p2e smoothed profile differs by ≤ 1 % mean absolute.
- Loader tests: corrupt/missing files fail with a typed error; progress events emitted; decode of a 2048² heightfield ≤ 300 ms on the laptop (vitest bench, recorded once, not a recurring benchmark).
- Credits file lists every source with licence text and the exact tile ids/bbox used.

**P1.4 three.js renderer v0.** (L, depends on P1.2, P1.3)
Files: `src/renderers/three/{ThreeWorldView,Terrain,Roads,Rider,ChaseCamera,Sky}.tsx`, `materials/toonTerrain.ts`, `quality.ts`; `package.json` deps (three, r3f, drei, postprocessing, @react-three/test-renderer).
Scope: chunked terrain mesh from heightfield (e.g. 8×8 chunks, 2 LODs), road ribbons with the real width class, route line, rider (reuse `lib/avatar*` colourways on a stylized GLTF under `public/models/`), chase cam driven by `rideSim`, lane steering from `controllerStore`, sky gradient + sun by time of day, fog.
AVC:
- Token-free `npm run dev`, pick a Perugia route, Ride: the rider moves on real terrain; `renderer: 'world'` by default; no network request to `cesium.com`/`ion` during the ride (Playwright asserts on request log).
- 60 fps at 1920×1080 on the laptop's iGPU with quality "balanced" (measure with the existing `graphicsQuality` overlay; record once in the PR), ≥ 30 fps at "low" on the tablet in Chrome.
- Rider never intersects/floats: a test samples 200 route points and asserts |riderY − heightfield(x,z)| < 0.05 m.
- Existing HUD, FTMS, gears, steering, show overlay, ghosts (as a simple capsule) work unchanged through `RideView`.
- `@react-three/test-renderer` unit tests for Terrain chunking, ChaseCamera smoothing, Roads ribbon generation; 2,001 existing tests still green.

**P1.5 Visual identity v2 — direction and mockups.** (M, design gate)
Files: `docs/design/v2-identity.md`, `docs/design/mockups/v2-{home,ride-hud,devices,show,finish}.html`, `docs/design/screenshots/v2/mockup/*`, token changes proposed (not yet applied) for `src/index.css` and `tailwind.config.ts`.
Direction to explore (worker has latitude, these are the constraints): calm
and warm, "lean-back atlas"; 10-foot type scale (body ≥ 18 px equivalent on
the TV layout via a `tv` breakpoint/`data-layout="tv"`), one accent, deep
night / paper day themes, large photographic-feel world thumbnails rendered
from the three.js worlds themselves (no stock imagery), no cards-in-cards,
no gradient blobs (UI-RULES §7).
AVC:
- Mockups at 1440×900, 390×844 **and 1920×1080 "TV"** for all five screens; vision review written against UI-RULES §9 with each rubric line answered.
- Federico signs off on the direction before any P2 UI packet starts.
- Token delta documented (names only, HSL values) so P2.4 can apply it without raw values in components.

### Phase 2 — Beautiful (depends on P1)

**P2.1 World materials, light, weather, time of day.** (L)
Files: `src/renderers/three/{Water,Vegetation,Buildings,Weather,Landmarks}.tsx`, `materials/*`, `src/lib/world/moods.ts(.test.ts)`; `tools/worldbake/buildVectors.mjs` extended (water, landuse, buildings, POIs).
Scope: stylized water with reflections, instanced trees by landuse class,
extruded buildings with per-class palettes (old town vs suburb), landmark
labels at POIs, live Open-Meteo weather (p2c) drives rain/fog/cloud cover
and the light, time of day follows the clock with a "golden hour" override
from the route mood.
AVC:
- Draw calls ≤ 400 and ≤ 150 k instanced trees at "balanced"; frame budget from P1.4 holds (same measurement, same laptop).
- Four reference screenshots (dawn, noon, golden, night; one in rain) at 1920×1080 of Perugia committed under `docs/design/screenshots/world/` and vision-reviewed as "would I want to ride here" by Federico.
- All of p2c's wind→FTMS behaviour unchanged (tests green).

**P2.2 Lugano world + destination system.** (M, depends on P1.3)
Files: `tools/worldbake/worlds/lugano.json`, `public/worlds/lugano/*`, `src/lib/world/destinations.ts(.test.ts)`, `src/components/velo/ScenicHome.tsx` (Home shows "Home · Perugia" and "Hometown · Lugano" sections, then "Places we want to go").
AVC:
- Destination = world + routes + moods + POIs + credits in one manifest; Home is generated from manifests, no hard-coded lists in components.
- Lugano bake passes the P1.3 criteria; Lugano→Melide and Locarno routes ride on it.
- 390/1440/TV screenshots through the design gate.

**P2.3 Show & journey mode v2.** (L, design gate; depends on P1.4)
Files: `src/stores/showStore.ts` (extend), `src/components/velo/{ShowSurface,JourneyBar}.tsx`, `src/lib/world/director.ts(.test.ts)`, `src/lib/show/pip.ts(.test.ts)`, `docs/show-mode.md`.
Two modes, because streaming services cannot be embedded in a PWA (DRM/iframe):
1. **Local video overlay** (exists in p2b): File System Access handles kept in IDB so the next episode reopens without a picker; handlebar buttons map to play/pause/next.
2. **Ride-over-anything**: the ride view opens as a **Document Picture-in-Picture** window (Chrome ≥ 116) that floats over Netflix/YouTube/anything on the TV; sizes: corner, third, half. HUD condenses to time/distance/grade/next landmark.
Cinematic director: shot list (chase, side dolly, drone orbit at landmarks, front, POV), change every 20–40 s with eased blends, suspended while the rider steers or brakes, landmark triggers from manifest POIs.
AVC:
- Director tests: never two cuts within 15 s, no cut during steering input, orbit only within 300 m of a POI, deterministic with a seeded RNG.
- PiP: Playwright test opens the PiP window (headed Chrome in CI job `show-mode`), asserts ride loop keeps ticking and FIT export records while the main tab is backgrounded.
- Local video: reopening the app resumes the last file without a picker (manual check on the laptop, recorded in the PR).
- TV layout at 1920×1080 passes the design gate; everything readable at 2 m (type ≥ 28 px equivalent for figures).

**P2.4 Visual identity v2 — build.** (L, design gate; depends on P1.5 sign-off)
Files: `src/index.css`, `tailwind.config.ts` (tokens only), `src/components/velo/*` (Home, RiderPanel, TrainerPanel, ControllerPanel, new RideHud v2, DevicesPanel, FinishCard v2), `src/components/ride/RideView.tsx` (HUD slot).
AVC:
- Side-by-side with the P1.5 mockups at 1440/390/TV in the PR; UI-RULES §9 rubric filled.
- `uiRules.test.ts` allow-list unchanged; `grep -E "#[0-9a-f]{3,6}|[0-9]+px" src/components/velo` returns nothing outside SVG `viewBox`.
- Legacy upstream components not on the ride path untouched (no scope creep into landing/training).

**P2.5 Device layer extensions.** (M)
Files: `src/lib/controllers/rideController.ts`, `rideProtocol.ts` (+tests), `src/lib/controllers/battery.ts(.test.ts)`, `src/lib/controllers/reconnect.ts(.test.ts)`, `src/lib/controllers/steerFeel.ts(.test.ts)`, `src/components/velo/ControllerPanel.tsx`, `docs/devices/zwift-ride-v2.md`.
Scope: battery via standard BLE Battery Service (0x180F) for handlebars and trainer; auto-reconnect using the retained `BluetoothDevice` (and `navigator.bluetooth.getDevices()` where available) with backoff; steering feel (deadzone, expo curve, lane-centring spring); gear-change haptics **only if the clean-room protocol notes identify a haptic/vibration write** — otherwise a 1-hour spike documents the finding and the packet ships without it (no guessing on BLE writes); handlebar button map for show mode and camera.
AVC:
- Protocol parsers 100 % branch-covered with recorded frames; no BLE control command sent outside a rider-started ride (existing rule, tested).
- Reconnect test: simulated `gattserverdisconnected` → reconnected within 3 attempts, FTMS control re-requested, SIM grade re-applied.
- Battery shown in ControllerPanel/TrainerPanel through the design gate; copy for pairing rewritten (the misleading troubleshooting text goes).
- Hardware check by Federico on the Ride V2 + KICKR CORE 2, recorded in the PR.

### Phase 3 — Destinations and play (depends on P2)

**P3.1 Wishlist worlds.** (L, batchable to Haiku/Flash for recipe writing, Opus for review)
Files: `tools/worldbake/worlds/{chengdu-luxelakes,ohio-erie-towpath,cleveland-lakefront,berkeley,santa-monica-venice,puerto-vallarta}.json`, bakes pushed to R2 (`worlds/<id>/<hash>/`), `src/lib/world/loadWorld.ts` (R2 base URL + Cache API), `vite.config.ts` runtimeCaching, p2e routes for each.
AVC:
- Each world passes P1.3 criteria; each has ≥ 2 Easy & Scenic routes from `build-scenic-routes.mjs` with source links (OSM relation ids, OSRM query) in the manifest credits.
- First ride of a destination downloads ≤ 8 MB and the second ride is served from cache (Playwright: offline mode after one ride still starts the world).
- R2 bucket public, versioned by content hash; a `tools/worldbake/publish.mjs` uploads with `wrangler` (existing Cloudflare account; no new paid tier).

**P3.2 Play layer on the new renderer.** (M, depends on P1.4)
Files: `src/lib/play/*` (port `cesiumPlayLayer.ts` → `threePlayLayer.ts`), `src/renderers/three/Collectibles.tsx`, `src/components/velo/PlayMode.tsx`, `src/stores/playStore.ts`.
Scope: postcards at POIs, riding buddy (p3) rendered as a stylized rider, **couple ghost** (ride against your partner's last ride on this route, from `rideHistory`), gentle collectibles on the Easy routes.
AVC:
- Postcards/buddy tests ported and green; ghost from history replays within 1 m of recorded positions; no gameplay element blocks the FTMS loop (ride tick ≤ 16 ms with play layer on, measured once).
- Design gate for PlayMode UI at 1440/390/TV.

**P3.3 TV mode polish.** (M, design gate)
Files: `src/components/velo/TvLayout.tsx`, `src/hooks/useLayoutMode.ts(.test.ts)`, `src/stores/settingsStore.ts`.
Scope: `data-layout="tv"` auto when viewport ≥ 1600 and coarse pointer absent or user-set; HUD margins for overscan; companion phone/tablet stays the control surface via existing `lib/companion`.
AVC: screenshots at 1920×1080 and 3840×2160 (scaled), text sizes per UI-RULES §5 TV addendum (added in P1.5), no interactive element relies on hover.

### Phase 4 — Open source (depends on P2; can start docs in parallel)

**P4.1 Repo hygiene and attribution.** (M)
Files: `package.json` (name `velo`, author Federico Brooks, `contributors` Mason Wyatt, `homepage`/`repository` updated), `LICENSE` (MIT; keep "Copyright (c) Mason Wyatt" line, add "Copyright (c) 2026 Federico Brooks"), `NOTICE.md` (upstream + data credits), `README.md` (story: a household wanted Zwift without the subscription and without the token; what Velo is, what it keeps from GlobeRide, the world bake, how to add your own hometown), `CONTRIBUTING.md`, `docs/worlds/CREDITS.md`, `.github/workflows/ci.yml` (typecheck/lint/unit; Playwright smoke; bake-validate on `tools/worldbake/**` changes), `CODE_OF_CONDUCT.md`.
Privacy: `riderRosterStore` seed becomes `Rider 1`/`Rider 2` (rename on first run); family names/profile data live only in IndexedDB; `docs/VELO-BRIEF.md` scrubbed of personal detail beyond "two riders"; remove `scripts/vercel-env-push.sh` secrets paths from history if any (`git log -p` audit, documented result).
AVC:
- `npm run check` + build pass on a fresh clone with no `.env`.
- `grep -ri "federico\|custodia\|sentinel" src tools docs` returns only LICENSE/NOTICE/README author lines.
- Upstream is credited in README first paragraph, LICENSE, footer (existing UI-RULES §6 rule), and `package.json`.
- Owner decision recorded: publish under `Custodia-Admin/velo` or transfer to a personal org (architect note: the job-search rule hides founder work from the employer; a personal namespace avoids tying this to Custodia).

**P4.2 Release.** (S)
Files: `CHANGELOG.md`, GitHub release `v2.0.0`, Cloudflare Pages deploy, R2 worlds published.
AVC: public URL rides Perugia token-free in a fresh Chrome profile; README quick-start verified by a worker on a clean machine (CI job `fresh-clone`).

---

## 3. Dependencies and order

```
P0.1 → P0.2
P0 → P1.1, P1.2, P1.3, P1.5   (parallel)
P1.2 + P1.3 → P1.4
P1.4 → P2.1, P2.3, P3.2
P1.3 → P2.2 → P3.1
P1.5 (sign-off) → P2.4 → P3.3
P1.1 → P2.5 (reconnect uses the FSM)
P2.* → P4.1 → P4.2
```

Critical path: P0.1 → P1.2/P1.3 → P1.4 → P2.1 → P4. Everything UI-facing waits
on P1.5 sign-off, which Federico should do early.

## 4. Invariants through the migration

1. FTMS/controller stack, virtual gears, weather→wind: **no file moves**, no behaviour changes outside P2.5.
2. Test count never decreases; `uiRules.test.ts` allow-list frozen.
3. Every ride feature consumes `rideSim`/`WorldRenderer`, never a renderer directly (architecture test).
4. Token-free is a CI assertion, not a promise: the smoke ride runs with no token and fails on any `cesium.com` request.
5. No raw px/hex in `src/components/velo/`; screenshots at 1440/390 (+TV) looked at before "done".
6. No new spend: Cloudflare Pages + R2 free tier, laptop bakes, CI in GitHub; spot VMs only via the standard skill if a bake batch outgrows the laptop.

## 5. Open questions for Federico (answer before P1.5 / P4.1)

Answers 1–3 are owner decisions, recorded in
[ADR-001](./ADR-001-rendering.md) (2026-10-31).

1. Publish namespace: `Custodia-Admin/velo` or a personal org?
   **Answered:** publication stays at Custodia-Admin/velo (MIT, upstream credit kept).
2. Visual direction preference between "warm atlas" and "night-first cinema" (P1.5 will mock both; a one-word steer saves a round).
   **Answered:** "warm atlas" (calm, paper-day/deep-night, one accent). P1.5 mocks this direction only.
3. Is a stylized rider GLTF acceptable, or do you want the upstream avatar look preserved?
   **Answered:** stylized GLTF (not the upstream billboard avatar).
4. Laptop GPU model (sets the P1.4 frame budget; if it's an iGPU older than Iris Xe, "balanced" targets 1080p/45 fps instead of 60).
   **Observed (lspci, 2026-10-31):** Intel Arc Graphics (Meteor Lake-P), newer than Iris Xe, so the 1080p/60 fps "balanced" target stands.
