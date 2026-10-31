# ADR-001 — Ride rendering: own three.js worlds by default, Cesium photoreal opt-in

- **Status:** Proposed (awaiting Federico's review)
- **Date:** 2026-10-31
- **Deciders:** Federico Brooks (owner); architect consult 1 of 3
- **Full reasoning:** [`VELO-V2-BLUEPRINT.md`](./VELO-V2-BLUEPRINT.md) §0–1

## Context

Velo inherited GlobeRide's ride view: a Cesium globe whose good looks come from
Cesium ion. The "photoreal" look the household liked is Google Photorealistic
3D Tiles (ion asset 2275207). Google owns it, it needs a token, and no plan
lets anyone self-host it. Without a valid token the ride falls back to a flat
OSM map on a 0 m ellipsoid, and a bad token gives a black globe. That is how
the design works, not a bug we can fix.

Velo's mandate: real 3D is mandatory, the app works with **zero third-party
tokens**, there is no new spend, and it is published as open source with
upstream credit.

## Decision

**Hybrid, weighted toward our own worlds (blueprint option e → d).**

1. **Default ride renderer: our own three.js world renderer**
   (three.js + `@react-three/fiber` + `@react-three/drei` + `postprocessing`).
   It draws baked **world bundles** made from open data that needs no key:
   AWS/Tilezen terrarium elevation, OpenStreetMap vectors from Overpass (roads,
   water, landuse, buildings, POIs) and the p2e scenic routes. The geometry
   is real and the art is stylized: Perugia looks like Perugia, with no API
   key at runtime.
2. **Cesium photoreal is opt-in.** A "Photoreal (bring your own Cesium ion
   token)" ride mode sits behind the same renderer seam
   (`src/lib/world/renderer.ts`, setting `renderer: 'world' | 'photoreal'`,
   default `'world'`). Its feature scope is frozen. New ride features target
   the seam, and the Cesium path gets only what comes through the seam for
   free. Cesium also stays as the Explore globe, which already works without
   a token on OSM imagery.
3. **Token-free is a hard requirement.** It is checked in CI, not just
   promised: the smoke ride runs with no token and fails on any request to
   `cesium.com` / ion. The Cesium chunk only loads (via `import()`) for
   `renderer === 'photoreal'` or `/explore`.
4. **The route sim and the terrain come from the same bake.** The bake takes
   each route's render elevation from the world heightfield, so the rider
   always touches the ground. FTMS grade still uses the smoothed route
   profile. This removes the avatar-vs-terrain mismatch for good.
5. **Self-hosted Cesium terrain (option b) is deferred.** It is not built
   now; the seam leaves room for it later.

### Options considered

| Option | Verdict | Why |
| --- | --- | --- |
| (a) Cesium + ion | Opt-in only | Needs a token. Google 3D Tiles can't be self-hosted. |
| (b) Cesium + self-hosted terrain | Deferred | No free orthophotos at bike-seat resolution exist worldwide, so the looks would still depend on ion. |
| (c) MapLibre + terrarium + three overlay | Rejected | It is a map camera with a pitch cap and no real ground-level chase cam. A synced overlay is fragile and still reads as 2.5D. |
| (d) Own stylized worlds | Core | Token-free, self-hosted, cacheable offline per world (MBs, not GBs), and open to art direction. |
| (e) Hybrid | **Chosen** | (d) is the product. (a) stays behind the seam for people who bring a token, and for the upstream community. |

## Owner decisions (recorded verbatim, 2026-10-31)

- **Publication:** publication stays at Custodia-Admin/velo (MIT, upstream credit kept).
- **Visual direction:** "warm atlas" (calm, paper-day/deep-night, one accent).
- **Rider:** stylized GLTF (not the upstream billboard avatar).

These answer open questions 1–3 of the blueprint (§5). P1.5 mocks only the
warm-atlas direction, P1.4 uses a stylized GLTF rider under `public/models/`,
and P4.1 publishes under `Custodia-Admin/velo` instead of moving to another
org.

## Consequences

**Good**
- Velo rides real places with no account, token or spend. One world bundle
  is ≤ 8 MB brotli. Home worlds are precached by the PWA, and destination
  worlds come from Cloudflare R2 (free tier) and are cached after the first
  ride.
- One bake feeds terrain, roads, routes and POIs. Landmarks, postcards and
  the cinematic director all read the same manifest.
- The art can follow warm atlas across time of day, weather and the play
  layer, instead of whatever Google's imagery happens to show.

**Costs and risks**
- A new renderer (P1.4) and a bake pipeline (P1.3) are the critical path.
  Until P1.4 lands, token-free rides keep showing the flat-map fallback.
- Bundles derived from OSM are ODbL share-alike. They are published under
  ODbL with credits in `docs/worlds/CREDITS.md`. The app stays MIT.
- Two renderers have to be kept up. This is limited by freezing Cesium's
  feature scope and by an architecture test: no Cesium import under
  `src/lib/ride/` or `src/lib/world/`.
- Frame budget: the laptop has Intel Arc (Meteor Lake) graphics, newer than
  Iris Xe, so P1.4 targets 60 fps at 1080p "balanced". The tablet targets
  ≥ 30 fps at "low".

**Unchanged**
- FTMS/controller stack, virtual gears and weather→wind: no file moves and
  no behaviour change outside P2.5.
- The test count never goes down, and the `uiRules.test.ts` allow-list stays
  frozen.

## Follow-up

The phases and packets are in [`ROADMAP.md`](../../ROADMAP.md) and the
blueprint §2. Order: P0 → P1.1/P1.2/P1.3/P1.5 in parallel → P1.4 → P2 → P3 →
P4.
