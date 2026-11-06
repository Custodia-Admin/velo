/**
 * cesiumUtils.ts — Centralized Cesium helpers for the GlobeRide viewer.
 *
 * No unit tests: this module is a direct wrapper around Cesium.Viewer,
 * Cesium.Ion, Cesium.JulianDate, and related runtime APIs. Every meaningful
 * function either mutates viewer state or delegates to Cesium internals that
 * cannot be instantiated in a Node/jsdom environment without a GPU context.
 * Integration coverage requires a real browser with WebGL or the Cesium
 * sandcastle emulator; no meaningful unit seam exists here.
 */

import * as Cesium from 'cesium';
import { createFinestTerrain, NO_FINEST_TERRAIN, type FinestTerrain } from '@/lib/finestTerrain';
import { IMAGERY_FALLBACK_EVENT } from '@/lib/imageryFallback';
import { NO_HIT, segmentMeetsSphere, segmentTriangleHit } from '@/lib/segmentHit';
import { tileReadCacheFor, type TileReadCache } from '@/lib/tileReadCache';
import type { Route } from '@/types';
import type { SkyConfig } from '@/lib/skyAndClouds';
import { ChaseCamSmoother, chaseCamTarget, lookAtHeadingPitch, type CameraPose } from '@/lib/cesiumCameras';
import type { ChaseFraming } from '@/lib/world/cameraFraming';

// Re-export SkyConfig so consumers can import it from this canonical module.
export type { SkyConfig };

/**
 * Centralized Cesium helpers. Keeps Cesium-specific knowledge out of the
 * React components so the viewer can stay a thin wrapper around `<div>`.
 */

// Tracks whether a valid-looking ion token has been installed. We use this
// (not Cesium.Ion.defaultAccessToken directly) because Cesium ships with a
// rotating demo token baked into the bundle that would otherwise make us
// think we have a token when production has none configured.
let _ionTokenInstalled = false;

/** Configure the Cesium ion access token from env var or localStorage. */
export function setIonToken(token: string | null | undefined): void {
  if (token && token.trim().length > 0) {
    Cesium.Ion.defaultAccessToken = token.trim();
    _ionTokenInstalled = true;
  } else {
    // No user-supplied token: clear any inherited default so ion-gated
    // assets (Bing Aerial, World Terrain, Google Photoreal Tiles) reject
    // fast instead of using Cesium's bundled demo token, which quietly
    // rate-limits and pollutes the console.
    Cesium.Ion.defaultAccessToken = '';
    _ionTokenInstalled = false;
  }
}

/** Whether a user-supplied ion token is currently active. */
export function hasIonToken(): boolean {
  return _ionTokenInstalled;
}

let terrainPromise: Promise<Cesium.TerrainProvider> | null = null;
/** World Terrain was requested with a token and ion refused it. */
let _worldTerrainFailed = false;
/**
 * Lazy, shared terrain provider.
 *
 * With a Cesium ion token: returns Cesium World Terrain (a global high-res
 * DEM hosted on ion). The viewer and the route generator both share the
 * same promise so only the first caller pays the network cost.
 *
 * Without a token: returns a flat `EllipsoidTerrainProvider`. The avatar
 * and polylines still position correctly because the route already carries
 * sampled elevations from the GPX (or Open-Elevation fallback). Mountains
 * appear flat, but the world is visible and the ride is playable.
 *
 * Pass `reset: true` to invalidate the cached promise (e.g. after the user
 * pastes a new ion token via Settings → Graphics).
 */
export function getTerrainProvider(reset = false): Promise<Cesium.TerrainProvider> {
  if (reset) terrainPromise = null;
  if (!terrainPromise) {
    if (!_ionTokenInstalled) {
      // Flat ellipsoid — no network, no ion auth, no console errors. Cesium
      // still renders the OSM imagery against this surface and the route's
      // own GPX elevations drive the avatar/camera height.
      terrainPromise = Promise.resolve(new Cesium.EllipsoidTerrainProvider());
    } else {
      terrainPromise = Cesium.createWorldTerrainAsync().then(
        (terrain) => {
          _worldTerrainFailed = false;
          return terrain;
        },
        (err) => {
          // Rejected token (ion 401) or offline: the globe stays the flat
          // ellipsoid, so the scene must sit at 0 m as without a token.
          _worldTerrainFailed = true;
          terrainPromise = null;
          throw err;
        },
      );
    }
  }
  return terrainPromise;
}

/**
 * Height to draw a route elevation at in the 3D scene.
 *
 * With an ion token the globe carries Cesium World Terrain, which matches the
 * route's GPX/DEM elevations. Without one the globe is the bare WGS84
 * ellipsoid (0 m) under the OSM map, and the road corridor is clamped to it,
 * so the rider, camera and route lines must sit at 0 m too: at GPX height
 * they would float hundreds of metres above the map. Only the scene uses
 * this; physics and the HUD keep the real elevation.
 */
export function sceneEle(ele: number): number {
  return onRealTerrain() ? ele : 0;
}

/** World Terrain is (or will be) under the globe: a token, and ion didn't refuse it. */
function onRealTerrain(): boolean {
  return _ionTokenInstalled && !_worldTerrainFailed;
}

/** A route sample moved onto the rendered surface (see {@link sceneEle}). */
export function onSceneSurface<T extends { ele: number }>(p: T): T {
  return onRealTerrain() ? p : { ...p, ele: 0 };
}

/** Convert a Route into a packed array of Cartesian3 positions (scene height). */
export function routeToCartesians(route: Route): Cesium.Cartesian3[] {
  const out: Cesium.Cartesian3[] = new Array(route.points.length);
  for (let i = 0; i < route.points.length; i++) {
    const p = route.points[i];
    out[i] = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, sceneEle(p.ele));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base imagery
// ---------------------------------------------------------------------------

/**
 * Add a base imagery layer to the viewer so the globe always shows the
 * world — never a black starfield with markers floating in space.
 *
 * Idempotent: if an imagery layer has already been added by this function the
 * call is a no-op (guarded by the _baseImageryAdded WeakSet).
 *
 * Source selection:
 *   - **With Cesium ion token**: Bing Maps Aerial (ion asset 2). Photoreal
 *     satellite imagery worldwide. Same behaviour as before.
 *   - **Without token**: OpenStreetMap raster tiles via the public
 *     tile.openstreetmap.org endpoint. No auth, no ion dependency. Looks
 *     like a paper map (roads + labels + terrain shading) rather than
 *     photoreal satellite — but the globe is visible and the ride is
 *     legible.
 *
 * If the with-token Bing fetch fails (revoked / lacks entitlement) we fall
 * back to OSM imagery rather than leaving the globe black — that guarantees
 * "broken token" still produces a visible globe.
 */
const _baseImageryAdded = new WeakSet<object>();

/** Public OSM tile server — also whitelisted in the production CSP. */
const OSM_TILE_URL = 'https://tile.openstreetmap.org/';

/**
 * Custom DOM event dispatched on `window` whenever the photoreal Bing path
 * silently stalls and we fall back to OSM at runtime. Consumed by
 * the photoreal notice (velo/PhotorealNotice, or any future status surface) so the user sees a soft
 * "photoreal unavailable" notice instead of just a downgraded-looking globe.
 */
export { IMAGERY_FALLBACK_EVENT };

/**
 * Milliseconds to wait for the Bing Aerial provider to produce any tile
 * progress signal before we consider it stalled and swap in OSM.
 *
 * Real-browser verification on production showed Bing tile requests staying
 * in the `pending` state indefinitely on some networks/CSP configurations —
 * the request ships but the response never arrives, leaving the user with a
 * black starfield. 4 seconds is short enough that the fallback feels snappy
 * on a real outage, long enough that a healthy network completes its first
 * batch comfortably.
 */
export const BING_TILE_STALL_TIMEOUT_MS = 12000;
// 4 s fired on healthy connections: with World Terrain on, the first Bing
// tiles only start ~4-5 s after the layer is added (terrain tiles go first),
// so every token ride fell back to OSM and showed the "temporarily
// unavailable" banner. The deadline is now longer AND the watchdog only
// fires when not a single Bing tile has arrived (see countLoadedTiles).

/**
 * Count imagery tiles the provider actually delivered. Wraps requestImage;
 * returns a getter. Inert (always 0) on stub providers without requestImage.
 */
function countLoadedTiles(layer: Cesium.ImageryLayer): () => number {
  let loaded = 0;
  const provider = (layer as { imageryProvider?: { requestImage?: (...a: unknown[]) => unknown } }).imageryProvider;
  const original = provider?.requestImage;
  if (provider && typeof original === 'function') {
    provider.requestImage = (...args: unknown[]) => {
      const result = original.apply(provider, args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(
          (img) => {
            if (img) loaded++;
          },
          () => undefined,
        );
      }
      return result;
    };
  }
  return () => loaded;
}

function buildOsmImagery(): Cesium.OpenStreetMapImageryProvider {
  return new Cesium.OpenStreetMapImageryProvider({
    url: OSM_TILE_URL,
    // OSM tiles are 256×256 and capped at zoom 19.
    maximumLevel: 19,
    // The OSM Foundation requires attribution — Cesium renders this in
    // the credit container at the bottom of the viewer.
    credit: new Cesium.Credit(
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      true,
    ),
  });
}

/**
 * Notify any UI listeners that the photoreal Bing layer was swapped for OSM
 * at runtime. Safe in non-DOM environments (Node test runner) — silently
 * no-ops when `window` is undefined or dispatch throws.
 */
function dispatchImageryFallback(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(IMAGERY_FALLBACK_EVENT));
  } catch {
    // CustomEvent unavailable (very old environments) — silently ignore;
    // the visual fallback already happened, the banner is just a nicety.
  }
}

/**
 * Watchdog that swaps the Bing Aerial layer for OSM if no tile progress is
 * observed within {@link BING_TILE_STALL_TIMEOUT_MS}.
 *
 * Cesium's `globe.tileLoadProgressEvent` fires every time the tile load
 * queue length changes. We track *whether any progress event has fired at
 * all* — a healthy network triggers many of them in the first second; a
 * silent stall produces zero.
 *
 * State transitions:
 *   - `armed`             — timer running, listener subscribed, no progress
 *                           observed yet.
 *   - `disarmed-ok`       — progress observed before the deadline → no
 *                           fallback fires, timer cleared.
 *   - `disarmed-fallback` — deadline hit with zero progress and tiles still
 *                           not loaded → Bing layer removed, OSM added,
 *                           IMAGERY_FALLBACK_EVENT dispatched.
 *
 * Once the watchdog enters either disarmed state it tears down its timer
 * and listener; subsequent progress events are ignored so we never
 * double-add the OSM layer.
 */
function armBingTileStallWatchdog(
  viewer: Cesium.Viewer,
  bingLayer: Cesium.ImageryLayer,
): void {
  // Globe stub may not exist in some test paths — guard defensively.
  const globe = viewer.scene?.globe;
  if (!globe) return;

  let disarmed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bingTilesLoaded = countLoadedTiles(bingLayer);

  const cleanup = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // We deliberately do NOT subscribe to `tileLoadProgressEvent`. Cesium
  // fires that on tile-queue-length changes — including when tile REQUESTS
  // are dispatched, not just when they complete. On production, Bing tiles
  // were observed to dispatch successfully (queue length changes, event
  // fires, watchdog would disarm) but never paint (response stalls). The
  // resulting black globe is exactly the bug this watchdog is supposed to
  // catch. Check the authoritative `globe.tilesLoaded` flag at the deadline
  // instead — it's only true when tiles have actually finished loading.

  timer = setTimeout(() => {
    if (disarmed) return;
    disarmed = true;
    cleanup();

    if (viewer.isDestroyed()) return;
    // Re-check `tilesLoaded` at the deadline: if Cesium already finished
    // loading everything (rare but possible on a tiny visible area), don't
    // fall back — the photoreal layer is actually working.
    if (globe.tilesLoaded) return;
    // Bing is delivering, just slower than the whole globe: keep it.
    if (bingTilesLoaded() > 0) return;

    console.warn('[cesiumUtils] Bing tiles stalled, falling back to OSM');

    try {
      viewer.scene.imageryLayers.remove(bingLayer, true);
    } catch {
      // Layer already removed (e.g. by a parallel route change) — fine.
    }

    try {
      const fallback = buildOsmImagery();
      if (viewer.isDestroyed()) return;
      viewer.scene.imageryLayers.add(new Cesium.ImageryLayer(fallback, {}));
      dispatchImageryFallback();
    } catch {
      console.warn(
        '[cesiumUtils] Bing tiles stalled and OSM fallback construction failed; ' +
          'the globe will render without a base layer.',
      );
    }
  }, BING_TILE_STALL_TIMEOUT_MS);
}

export async function setupBaseImagery(viewer: Cesium.Viewer): Promise<void> {
  if (viewer.isDestroyed()) return;
  // Idempotency guard — the Viewer object is the key.
  if (_baseImageryAdded.has(viewer)) return;
  _baseImageryAdded.add(viewer);

  // No ion token — go straight to OSM. Skips the inevitable 401/403 from
  // IonImageryProvider that would otherwise spam the console on every mount.
  if (!_ionTokenInstalled) {
    try {
      const provider = buildOsmImagery();
      if (viewer.isDestroyed()) return;
      const layer = new Cesium.ImageryLayer(provider, {});
      viewer.scene.imageryLayers.add(layer);
    } catch {
      // OSM provider construction is synchronous and never throws in practice
      // — guard anyway so we never leave the user staring at a black globe.
      console.warn(
        '[CesiumViewer] OSM imagery unavailable; the globe will render without a base layer.',
      );
    }
    return;
  }

  // Asset 2 = Bing Maps Aerial with Labels — available with every Cesium ion
  // token (free tier included).
  try {
    const provider = await Cesium.IonImageryProvider.fromAssetId(2);
    if (viewer.isDestroyed()) return;
    const layer = new Cesium.ImageryLayer(provider, {});
    viewer.scene.imageryLayers.add(layer);
    // Arm the stall watchdog — if no tile progress is observed within the
    // timeout, swap this layer out for OSM so the user never sees a black
    // globe behind their route.
    armBingTileStallWatchdog(viewer, layer);
  } catch {
    // Ion token failed (revoked / lacks Bing entitlement). Fall back to OSM
    // rather than leaving the globe black.
    if (viewer.isDestroyed()) return;
    try {
      const fallback = buildOsmImagery();
      if (viewer.isDestroyed()) return;
      viewer.scene.imageryLayers.add(new Cesium.ImageryLayer(fallback, {}));
      dispatchImageryFallback();
    } catch {
      // Both failed — surface a single console warning and move on.
      console.warn(
        '[CesiumViewer] Bing Aerial and OSM fallback both unavailable; ' +
          'the globe will render without a base layer.',
      );
    }
  }
}

/** Cesium ion asset ID for Google Photorealistic 3D Tiles. */
const GOOGLE_PHOTOREAL_ASSET_ID = 2275207;

/**
 * Create a Google Photorealistic 3D Tiles tileset — a real-world photoreal
 * mesh (buildings, trees, terrain) — via Cesium ion.
 *
 * Not cached: a Cesium3DTileset is bound to one scene, so every viewer mount
 * needs its own. Rejects immediately if no ion token is installed (no point
 * making the network call) or if the token lacks access to the asset; callers
 * must fall back to terrain + OSM buildings.
 */
export function getPhotorealTileset(): Promise<Cesium.Cesium3DTileset> {
  if (!_ionTokenInstalled) {
    return Promise.reject(
      new Error('Photoreal tileset requires a Cesium ion token; falling back to base imagery.'),
    );
  }
  return Cesium.Cesium3DTileset.fromIonAssetId(GOOGLE_PHOTOREAL_ASSET_ID, PHOTOREAL_TILESET_OPTIONS).then(
    (tileset) => {
      photorealTilesets.add(tileset);
      return tileset;
    },
  );
}

/**
 * Streaming budget for the photoreal mesh at a chase camera a few metres off
 * the road. Its tile tree is deep (every level is an external JSON parsed on
 * the main thread), so the defaults keep the main thread busy loading detail
 * nobody can see from a moving bike:
 * - SSE 24: tiles a third coarser than the default 16 (16 → 24 cuts tiles in
 *   view roughly in half); the graphics tier can lower it again.
 * - cacheBytes 256 MB (default 512 MB): an iGPU shares system RAM.
 * - skip loading while the camera moves fast / for distant foveated tiles.
 */
export const PHOTOREAL_TILESET_OPTIONS = {
  maximumScreenSpaceError: 24,
  cacheBytes: 256 * 1024 * 1024,
  maximumCacheOverflowBytes: 128 * 1024 * 1024,
  dynamicScreenSpaceError: true,
  foveatedScreenSpaceError: true,
  cullRequestsWhileMoving: true,
  cullRequestsWhileMovingMultiplier: 30,
  preloadWhenHidden: false,
  preloadFlightDestinations: false,
} as const;

const photorealTilesets = new WeakSet<Cesium.Cesium3DTileset>();

/** Whether `tileset` is the Google photoreal mesh (vs. OSM buildings etc.). */
export function isPhotorealTileset(tileset: unknown): boolean {
  return tileset instanceof Cesium.Cesium3DTileset && photorealTilesets.has(tileset);
}

/**
 * True when a photoreal mesh tileset is part of the rendered scene, i.e. the
 * ground is a mesh that only a GPU sample (scene.sampleHeight) can measure.
 * Otherwise the rendered ground is the globe's terrain and the CPU height of
 * its loaded tiles (globe.getHeight) is exact and free.
 */
export function photorealGroundShown(scene: Cesium.Scene): boolean {
  const prims = (scene as { primitives?: Cesium.PrimitiveCollection }).primitives;
  if (!prims || typeof prims.length !== 'number') return false;
  for (let i = 0; i < prims.length; i++) {
    const p = prims.get(i) as Cesium.Cesium3DTileset;
    if (isPhotorealTileset(p) && p.show) return true;
  }
  return false;
}

/**
 * Clamp positions onto whatever surface the scene is rendering (the
 * photoreal tileset, or terrain) and optionally lift them a few metres so a
 * line/marker sits just above the ground instead of z-fighting it.
 *
 * Async — it loads the tiles it needs to a high detail level first.
 */
export async function clampCartesiansToScene(
  scene: Cesium.Scene,
  positions: Cesium.Cartesian3[],
  liftMeters = 0,
): Promise<Cesium.Cartesian3[]> {
  const clamped = await scene.clampToHeightMostDetailed(positions);
  return clamped.map((c, i) => {
    // A position the picker couldn't resolve comes back undefined — keep
    // the route's original point there rather than dropping it.
    const base = c ?? positions[i];
    if (liftMeters === 0) return base;
    const carto = Cesium.Cartographic.fromCartesian(base);
    if (!carto) return base;
    return Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      carto.height + liftMeters,
    );
  });
}

/**
 * Synchronously sample the height of the rendered surface at a lon/lat — used
 * each frame to sit the avatar on the terrain / photoreal mesh. Returns
 * `undefined` when there is nothing to sample yet (tiles still streaming) and
 * always on the flat no-token globe, where the surface is 0 m everywhere
 * (callers fall back to {@link sceneEle}).
 *
 * Pass the riders' own entities in `exclude`: `scene.sampleHeight` hits any
 * geometry, so a stationary rider (paused) would otherwise sample the top of
 * its own helmet, step up onto it, and climb into the sky frame by frame.
 *
 * `under`: read the photoreal mesh down from this height instead of from the
 * top: an up-facing surface at or under it, what Cesium3DTileset.pick hits
 * first from there (see meshHeightAt; under a tree crown or a deck, the
 * ground below it where the mesh draws one). Only the CPU mesh read can look
 * under something; without it (no WebGL 2, no mesh shown) the answer is
 * undefined.
 */
export function sampleGroundHeight(
  scene: Cesium.Scene,
  lon: number,
  lat: number,
  exclude?: object[],
  under?: number,
): number | undefined {
  if (!onRealTerrain()) return undefined;
  const carto = Cesium.Cartographic.fromDegrees(lon, lat);
  // Over the photoreal mesh on WebGL 2, intersect the rendered tiles on the
  // CPU (~3 ms, see meshHeightAt). scene.sampleHeight renders a pick
  // pass and reads it back synchronously, stalling until the GPU has drawn
  // the whole frame: 35–270 ms per call measured on the Arc iGPU, ~30 % of
  // the ride view's main thread. Riders aren't part of the tileset, so
  // nothing needs excluding.
  if (isWebGL2(scene)) {
    const prims = (scene as { primitives?: Cesium.PrimitiveCollection }).primitives;
    if (prims && typeof prims.length === 'number') {
      let best: number | undefined;
      let meshShown = false;
      for (let i = 0; i < prims.length; i++) {
        const p = prims.get(i) as Cesium.Cesium3DTileset;
        if (!isPhotorealTileset(p) || !p.show) continue;
        meshShown = true;
        const h = meshHeightAt(p, carto, scene, under);
        if (h !== undefined && Number.isFinite(h) && (best === undefined || h > best)) best = h;
      }
      if (meshShown) return best;
    }
  }
  if (under !== undefined || !scene.sampleHeightSupported) return undefined;
  return scene.sampleHeight(carto, exclude);
}

type TilesetPick = (ray: Cesium.Ray, frameState: unknown, result?: Cesium.Cartesian3) => Cesium.Cartesian3 | undefined;

/**
 * Height of the mesh `tileset` draws this frame at `carto`, straight down the
 * local vertical. This is Cesium3DTileset.getHeight with the ray fixed:
 * getHeight (Cesium 1.141) casts its ray through the Earth's centre, which
 * leaves the vertical by up to 0.19°, so at 363 m it crosses the mesh 1.2 m
 * towards the equator. On a kerb at Lugano–Melide 2940 m that read 362.84 m
 * where the road is drawn at 363.41 m (GPU pick and the main view's depth
 * agree), and the wheels sat 0.57 m in the road. Same tile walk otherwise:
 * the selected tiles nearest the ray's origin first, the first one hit wins.
 *
 * `under`: start the ray at this height instead (undefined without a tile
 * pick). The pick culls back faces, so every hit is a surface facing up, and
 * one read from under a tree crown is a surface below it, the ground where
 * the mesh draws one: on the Cuyahoga towpath it does at about half the
 * spots under the canopy, and under every road deck crossing it (I-271, Main
 * Street). Not always the highest surface under `under`: the first tile hit
 * wins, nearest bounding sphere to the origin first, and a low origin is
 * inside every candidate tile's sphere, so with tiles stacked there the
 * tileset's selection order decides which one answers.
 */
export function meshHeightAt(
  tileset: Cesium.Cesium3DTileset,
  carto: Cesium.Cartographic,
  scene: Cesium.Scene,
  under?: number,
): number | undefined {
  const pick = (tileset as unknown as { pick?: TilesetPick }).pick;
  if (typeof pick !== 'function') return under === undefined ? tileset.getHeight(carto, scene) : undefined;
  const ellipsoid = (scene as { ellipsoid?: Cesium.Ellipsoid }).ellipsoid ?? Cesium.Ellipsoid.WGS84;
  // From as far out as getHeight starts (two Earth radii), down the normal.
  const origin = ellipsoid.cartographicToCartesian(
    new Cesium.Cartographic(carto.longitude, carto.latitude, under ?? 2 * ellipsoid.maximumRadius),
  );
  const down = Cesium.Cartesian3.negate(ellipsoid.geodeticSurfaceNormalCartographic(carto), new Cesium.Cartesian3());
  const hit = pick.call(tileset, new Cesium.Ray(origin, down), (scene as { frameState?: unknown }).frameState);
  if (!hit) return undefined;
  return ellipsoid.cartesianToCartographic(hit)?.height;
}

function isWebGL2(scene: Cesium.Scene): boolean {
  return (scene as unknown as { context?: { webgl2?: boolean } }).context?.webgl2 === true;
}

/**
 * The side cameras can read what is drawn around them on the CPU: a photoreal
 * mesh is shown and the context is WebGL 2 (on WebGL 1 only a GPU pick could
 * read the mesh, a pipeline stall per spot, so they don't look).
 */
export function sightReadable(scene: Cesium.Scene): boolean {
  return isWebGL2(scene) && photorealGroundShown(scene);
}

/**
 * Tile geometry copies the sight's reads and the rider's ground reads reuse
 * (lib/tileReadCache), on Cesium's private ModelReader; null when this Cesium
 * has no such reads.
 */
let meshTopReads: TileReadCache | null | undefined;
function meshTopReadCache(): TileReadCache | null {
  if (meshTopReads === undefined) {
    meshTopReads = tileReadCacheFor((Cesium as unknown as { ModelReader?: unknown }).ModelReader);
  }
  return meshTopReads;
}

/** Drop the tile geometry the mesh reads kept (the view that read it is gone). */
export function clearMeshTopReads(): void {
  meshTopReads?.clear();
}

/**
 * Hits, copies, bytes and entries of the tile geometry cache the sight's and
 * the rider's ground reads share, for probes (null: no cache).
 */
export function meshTopReadStats(): ReturnType<TileReadCache['stats']> | null {
  return meshTopReads ? meshTopReads.stats() : null;
}

/**
 * Run `fn` with its photoreal mesh reads served from the same tile geometry
 * cache as the sight's: the rider's ground sample reads one spot two to four
 * times (the top, then under what stands over the road), all in the same
 * tiles, and copying a tile back from the GPU is most of a read's cost.
 */
export function withMeshReadCache<T>(fn: () => T): T {
  const reads = meshTopReadCache();
  return reads ? reads.run(fn) : fn();
}

/**
 * Top of the shown photoreal mesh at lon/lat (highest of the shown photoreal
 * tilesets), intersected on the CPU against the rendered tiles
 * (Cesium3DTileset.getHeight). Undefined with no tile there, no mesh shown,
 * or no WebGL 2. Unfiltered: the top of whatever stands there (roof, crown,
 * hillside), which is what a camera has to see past. The tile geometry each
 * read copies back from the GPU is kept for the next reads (lib/tileReadCache).
 */
export function meshTopHeight(scene: Cesium.Scene, lon: number, lat: number): number | undefined {
  if (!isWebGL2(scene)) return undefined;
  const prims = (scene as { primitives?: Cesium.PrimitiveCollection }).primitives;
  if (!prims || typeof prims.length !== 'number') return undefined;
  let carto: Cesium.Cartographic | undefined;
  let best: number | undefined;
  const reads = meshTopReadCache();
  for (let i = 0; i < prims.length; i++) {
    const p = prims.get(i) as Cesium.Cesium3DTileset;
    if (!isPhotorealTileset(p) || !p.show) continue;
    const at = (carto ??= Cesium.Cartographic.fromDegrees(lon, lat));
    const h = reads ? reads.run(() => p.getHeight(at, scene)) : p.getHeight(at, scene);
    if (h !== undefined && Number.isFinite(h) && (best === undefined || h > best)) best = h;
  }
  return best;
}

/** The parts of Cesium's private tile / model classes a segment cast walks (Cesium 1.141, engine 25). */
interface TileLike {
  content?: { _model?: ModelLike } | null;
  contentBoundingVolume?: { boundingSphere?: Cesium.BoundingSphere };
}
interface ModelLike {
  _ready?: boolean;
  backFaceCulling?: boolean;
}
interface PrimitiveLike {
  attributes?: Array<{ semantic?: string; type?: string }>;
  indices?: unknown;
}
type ForEachPrimitive = (
  model: ModelLike,
  options: undefined,
  callback: (
    runtimePrimitive: { boundingSphere?: Cesium.BoundingSphere },
    primitive: PrimitiveLike,
    instances: Array<{ transform: Cesium.Matrix4 }>,
    computedModelMatrix: Cesium.Matrix4,
  ) => void,
) => void;
interface SegmentReader {
  forEachPrimitive: ForEachPrimitive;
  readAttributeAsTypedArray: (attribute: unknown) => ArrayLike<number> | undefined;
  readIndicesAsTypedArray: (indices: unknown) => ArrayLike<number> | undefined;
}

function segmentReader(): SegmentReader | null {
  const r = (Cesium as unknown as { ModelReader?: Partial<SegmentReader> }).ModelReader;
  return r &&
    typeof r.forEachPrimitive === 'function' &&
    typeof r.readAttributeAsTypedArray === 'function' &&
    typeof r.readIndicesAsTypedArray === 'function'
    ? (r as SegmentReader)
    : null;
}

/**
 * The side cameras can cast segments through the shown photoreal mesh
 * ({@link meshSegmentHit}): it can be read on the CPU ({@link sightReadable})
 * and this Cesium has the model reader the cast walks the tiles with.
 */
export function sightRaysReadable(scene: Cesium.Scene): boolean {
  return sightReadable(scene) && segmentReader() !== null;
}

/** Scratch for segment casts, made on the first cast (module scope runs under test mocks of 'cesium' too). */
let segScratch:
  | { a: Cesium.Cartesian3; b: Cesium.Cartesian3; inverse: Cesium.Matrix4; sphere: Cesium.BoundingSphere }
  | undefined;

function meetsSphere(a: Cesium.Cartesian3, b: Cesium.Cartesian3, s: Cesium.BoundingSphere | undefined): boolean {
  if (!s) return true;
  return segmentMeetsSphere(a.x, a.y, a.z, b.x, b.y, b.z, s.center.x, s.center.y, s.center.z, s.radius);
}

/** A matrix whose rotation part mirrors (negative determinant) turns the triangles' winding round. */
function mirrors(m: Cesium.Matrix4): boolean {
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  return det < 0;
}

/**
 * Where the segment a -> b (world coordinates) first runs into the photoreal
 * mesh drawn this frame, as a fraction of the way from a (0..1). Undefined
 * when it runs into nothing, no mesh is shown, or the mesh can't be read
 * (WebGL 1, a Cesium without the model reader).
 *
 * Every tile drawn this frame whose bounding sphere the segment passes
 * through is read, and the nearest hit over all of them wins
 * (Cesium3DTileset.pick stops at the first tile, sorted by sphere distance,
 * that the endless ray hits anywhere). Faces turned away from a are not hits,
 * as in Cesium's pickModel, unless `bothSides`: then any face the segment
 * crosses is (the camera sees the front of a face whose back the rider's
 * bars see). The tile geometry copied back from the GPU is kept for the next
 * reads (lib/tileReadCache). Pure maths in lib/segmentHit.
 */
export function meshSegmentHit(
  scene: Cesium.Scene,
  a: Cesium.Cartesian3,
  b: Cesium.Cartesian3,
  bothSides = false,
): number | undefined {
  if (!isWebGL2(scene)) return undefined;
  const reader = segmentReader();
  const prims = (scene as { primitives?: Cesium.PrimitiveCollection }).primitives;
  if (!reader || !prims || typeof prims.length !== 'number') return undefined;
  const sc = (segScratch ??= {
    a: new Cesium.Cartesian3(),
    b: new Cesium.Cartesian3(),
    inverse: new Cesium.Matrix4(),
    sphere: new Cesium.BoundingSphere(),
  });
  let best = NO_HIT;
  const castTile = (tile: TileLike) => {
    const model = tile.content?._model;
    if (!model || model._ready !== true || !meetsSphere(a, b, tile.contentBoundingVolume?.boundingSphere)) return;
    const cull = !bothSides && (model.backFaceCulling ?? true);
    reader.forEachPrimitive(model, undefined, (runtime, primitive, instances, computed) => {
      if (runtime.boundingSphere && instances.length === 1) {
        if (!meetsSphere(a, b, Cesium.BoundingSphere.transform(runtime.boundingSphere, computed, sc.sphere))) return;
      }
      const position = primitive.attributes?.find((at) => at.semantic === 'POSITION');
      if (!position || position.type !== 'VEC3' || primitive.indices === undefined) return;
      const vertices = reader.readAttributeAsTypedArray(position);
      const indices = reader.readIndicesAsTypedArray(primitive.indices);
      if (!vertices || !indices) return;
      for (const instance of instances) {
        // The segment moves into the tile's frame, not the tile into the world's.
        Cesium.Matrix4.inverse(instance.transform, sc.inverse);
        const la = Cesium.Matrix4.multiplyByPoint(sc.inverse, a, sc.a);
        const lb = Cesium.Matrix4.multiplyByPoint(sc.inverse, b, sc.b);
        const t = segmentTriangleHit(vertices, 3, indices, la.x, la.y, la.z, lb.x, lb.y, lb.z, cull, mirrors(instance.transform));
        if (t < best) best = t;
      }
    });
  };
  const cast = () => {
    for (let i = 0; i < prims.length; i++) {
      const p = prims.get(i) as Cesium.Cesium3DTileset;
      if (!isPhotorealTileset(p) || !p.show) continue;
      const tiles = (p as unknown as { _selectedTiles?: TileLike[] })._selectedTiles;
      if (!Array.isArray(tiles)) continue;
      for (const tile of tiles) castTile(tile);
    }
  };
  const reads = meshTopReadCache();
  if (reads) reads.run(cast);
  else cast();
  return best <= 1 ? best : undefined;
}

/**
 * Height of whatever the globe is rendering right now at lon/lat, without
 * waiting for anything: the precise surface sample (terrain / photoreal mesh)
 * when available, else the height of the terrain tiles already loaded
 * (`globe.getHeight`: coarse World Terrain while it streams, 0 m on the flat
 * ellipsoid). Undefined only when no tile at all covers the spot yet.
 * Over a photoreal mesh this is the higher of the mesh and the globe, see
 * {@link drawnGroundHeight}.
 */
export function sceneGroundHeight(
  scene: Cesium.Scene,
  lon: number,
  lat: number,
  exclude?: object[],
  expectEle?: number,
  opts?: { terrainOnly?: boolean },
): number | undefined {
  // terrainOnly: the caller knows no mesh is rendered over the terrain, so the
  // GPU pick (a pipeline stall) would only re-measure the terrain tiles.
  const sampled = opts?.terrainOnly ? undefined : sampleGroundHeight(scene, lon, lat, exclude);
  return drawnGroundHeight(scene, lon, lat, sampled, expectEle);
}

/**
 * The ground the camera sees at lon/lat, given a surface sample `sampled`
 * (photoreal mesh or GPU pick; may be undefined). The globe stays drawn,
 * opaque and depth-tested under the photoreal mesh, so where its terrain is
 * higher than the mesh (by 1–5 m along Lake Trasimeno) the globe IS the
 * visible ground and the mesh, with the road the corridor paints on it, is
 * buried under it. Riding the mesh there put the rider and the chase camera
 * under the globe, which Cesium then draws from below with the road on it, so
 * the rider saw two roads. Here the higher of the two wins whenever the globe
 * draws opaque. Once the mesh is the road under the rider the globe is hidden
 * altogether (renderers/cesium/globeGate) and the mesh alone is the ground.
 * Readings more than 800 m off `expectEle` are coarse-tile
 * chords and are ignored.
 */
export function drawnGroundHeight(
  scene: Cesium.Scene,
  lon: number,
  lat: number,
  sampled: number | undefined,
  expectEle?: number,
): number | undefined {
  const plausible = (h: number | undefined): h is number =>
    h !== undefined &&
    Number.isFinite(h) &&
    (expectEle === undefined || Math.abs(h - expectEle) <= MAX_COARSE_TILE_ERROR_M);
  // Flat globe (no token, or World Terrain not assigned yet): the surface is
  // exactly 0 m. Don't ask the coarse tiles: a level-0 tile's chord sits
  // kilometres under the ellipsoid (-12 km measured on a throttled phone).
  if (isFlatGlobe(scene)) return plausible(sampled) ? sampled : 0;
  const globe = scene.globe as Cesium.Globe | undefined;
  if (!globe || typeof globe.getHeight !== 'function') return plausible(sampled) ? sampled : undefined;
  const h = globeDrawnHeight(scene, globe, Cesium.Cartographic.fromDegrees(lon, lat), plausible);
  // Same chord error on coarse World Terrain tiles while they stream in.
  const terrain = plausible(h) ? h : undefined;
  if (!plausible(sampled)) return terrain;
  return terrain !== undefined && globeDrawnOpaque(globe) ? Math.max(sampled, terrain) : sampled;
}

/**
 * Top of what is drawn at lon/lat for the side cameras' sight: the mesh top
 * (`meshTop`, {@link meshTopHeight}) and the globe where it draws over it, as
 * {@link drawnGroundHeight}. A hidden or see-through globe never stands in for
 * a mesh read that missed: it is not drawn there (on the Lugano shore it sits
 * up to 26 m over the street, so the camera moved in from a wall that isn't).
 */
export function drawnTopHeight(
  scene: Cesium.Scene,
  lon: number,
  lat: number,
  meshTop: number | undefined,
  expectEle?: number,
): number | undefined {
  const globe = scene.globe as Cesium.Globe | undefined;
  if (globe && !globeDrawnOpaque(globe)) {
    const plausible =
      meshTop !== undefined &&
      Number.isFinite(meshTop) &&
      (expectEle === undefined || Math.abs(meshTop - expectEle) <= MAX_COARSE_TILE_ERROR_M);
    return plausible ? meshTop : undefined;
  }
  return drawnGroundHeight(scene, lon, lat, meshTop, expectEle);
}

/**
 * Height of the globe's terrain under `carto`: the higher of the tile it
 * DREW last frame (Globe.pick) and the deepest tile LOADED there
 * (Globe.getHeight).
 *
 * getHeight alone isn't the ground the camera sees: while World Terrain
 * streams in, the globe often draws a coarser tile than the deepest loaded
 * one (it refines a tile only once its screen-space error asks for it and the
 * children it needs have loaded; a tile loaded for an earlier view stays
 * loaded). At the Santa Monica start the drawn tile sat over getHeight's by
 * 0.4–1.6 m (level 14 over 15) for up to 7 frames, by 7 m (level 8 over 14)
 * and by 26 m (level 10/11 over 13/14): the rider stood on getHeight, under
 * the ground the camera saw, often with the camera under it too
 * (t_b6dbd3d2).
 *
 * The drawn tile alone isn't either: it is the last frame's (the avatar is
 * placed before the frame selects its tiles: Cesium updates primitives before
 * the globe), and the globe refines to the loaded tile, often the very next
 * frame. Standing on a drawn tile lower than the loaded one put the rider
 * 1.3 m under for that frame at the Lake Trasimeno start (level 11 refined to
 * 12), and a coarse tile's chord can lie hundreds of metres under (a level-4
 * tile 796 m under the level-8 one at Santa Monica). So the higher wins: the
 * rider floats over a lower drawn tile until it refines, as before, and is
 * never under one drawn over the loaded tile. A coarser tile drawn over both
 * for the first time is still stood on one frame late.
 *
 * Readings that fail `accept` (coarse chords far off the route) are dropped;
 * with no rendered tile under the spot (off screen, before the first frame)
 * or the globe hidden (its rendered tiles stop updating), getHeight decides.
 */
export function globeDrawnHeight(
  scene: Cesium.Scene,
  globe: Cesium.Globe,
  carto: Cesium.Cartographic,
  accept: (h: number) => boolean = () => true,
): number | undefined {
  const loaded = globe.getHeight(carto);
  if ((globe as { show?: boolean }).show === false || typeof globe.pick !== 'function') return loaded;
  const ellipsoid = (scene as { ellipsoid?: Cesium.Ellipsoid }).ellipsoid ?? Cesium.Ellipsoid.WGS84;
  const s = (drawnScratch ??= { ray: new Cesium.Ray(), hit: new Cesium.Cartesian3(), high: new Cesium.Cartographic() });
  // Straight down the local vertical, from as far out as meshHeightAt starts.
  s.high.longitude = carto.longitude;
  s.high.latitude = carto.latitude;
  s.high.height = 2 * ellipsoid.maximumRadius;
  ellipsoid.cartographicToCartesian(s.high, s.ray.origin);
  Cesium.Cartesian3.negate(ellipsoid.geodeticSurfaceNormalCartographic(carto, s.ray.direction), s.ray.direction);
  const hit = globe.pick(s.ray, scene, s.hit);
  const drawn = hit ? ellipsoid.cartesianToCartographic(hit)?.height : undefined;
  const ok = (h: number | undefined): h is number => h !== undefined && Number.isFinite(h) && accept(h);
  if (!ok(drawn)) return loaded;
  return ok(loaded) ? Math.max(drawn, loaded) : drawn;
}
let drawnScratch: { ray: Cesium.Ray; hit: Cesium.Cartesian3; high: Cesium.Cartographic } | null = null;

/** The globe draws its terrain as an opaque surface (not hidden, not see-through). */
function globeDrawnOpaque(globe: Cesium.Globe): boolean {
  if ((globe as { show?: boolean }).show === false) return false;
  return (globe as { translucency?: { enabled?: boolean } }).translucency?.enabled !== true;
}

/**
 * The ground under the rider has streamed in: World Terrain is the globe's
 * terrain, and either the ground under the rider is plausible (`stable`,
 * from the view's renderers/cesium/startGround watch: no coarse chord, held
 * still) or every globe tile for this view is loaded and so is the shown
 * photoreal mesh. Always true on the flat no-token globe (nothing streams).
 * The ride start waits for this for a short while (lib/ride/startHold), so
 * the rider doesn't set off on a coarse tile hundreds of metres off the
 * ground.
 */
export function groundSettled(scene: Cesium.Scene, stable = false): boolean {
  if (!onRealTerrain()) return true;
  if (isFlatGlobe(scene)) return false;
  if (stable) return true;
  const globe = scene.globe as Cesium.Globe | undefined;
  // A hidden globe (the mesh is the ground, renderers/cesium/globeGate) stops
  // updating, so its load queues freeze: they say nothing about the ground.
  if (globe && globe.show !== false && globe.tilesLoaded === false) return false;
  const prims = (scene as { primitives?: Cesium.PrimitiveCollection }).primitives;
  if (prims && typeof prims.length === 'number') {
    for (let i = 0; i < prims.length; i++) {
      const p = prims.get(i) as Cesium.Cesium3DTileset;
      if (isPhotorealTileset(p) && p.show && !p.tilesLoaded) return false;
    }
  }
  return true;
}

/**
 * World Terrain is coming (a token, ion hasn't refused it) but the globe is
 * still the flat 0 m ellipsoid it starts on: nothing real is drawn under the
 * rider yet, and a ride that set off now would jump hundreds of metres when
 * the terrain lands.
 */
export function worldTerrainPending(scene: Cesium.Scene): boolean {
  return onRealTerrain() && isFlatGlobe(scene);
}

/** Larger gaps between loaded-tile height and route height are coarse-tile chord error. */
const MAX_COARSE_TILE_ERROR_M = 800;

function isFlatGlobe(scene: Cesium.Scene): boolean {
  const provider = (scene as { terrainProvider?: unknown }).terrainProvider;
  return !provider || provider instanceof Cesium.EllipsoidTerrainProvider;
}

const finestByScene = new WeakMap<object, { provider: unknown; finest: FinestTerrain }>();

/** The scene's terrain provider's finest heights (one cache per scene and provider), if it has levels. */
function finestFor(scene: Cesium.Scene): FinestTerrain {
  const provider = (scene as { terrainProvider?: Cesium.TerrainProvider }).terrainProvider;
  // The flat ellipsoid has no levels (sampleTerrainMostDetailed rejects on
  // it), nor has a provider without tile availability.
  if (isFlatGlobe(scene) || !(provider as { availability?: unknown }).availability) return NO_FINEST_TERRAIN;
  let e = finestByScene.get(scene);
  if (!e || e.provider !== provider) {
    const p = provider as Cesium.TerrainProvider;
    e = {
      provider,
      finest: createFinestTerrain(async (points) => {
        const cs = await Cesium.sampleTerrainMostDetailed(
          p,
          // NaN until a tile answers: a point no tile covered is no height.
          points.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat, NaN)),
        );
        // Undefined where a tile failed (createFinestTerrain skips those).
        return cs.map((c) => c.height);
      }),
    };
    finestByScene.set(scene, e);
  }
  return e.finest;
}

/**
 * The finest terrain the globe has at a spot (lib/finestTerrain): what it
 * draws there once shown, not the coarse tile a hidden globe last loaded.
 * Shared by every rider on the scene; follows a change of terrain provider.
 */
export function sceneFinestTerrain(scene: Cesium.Scene): FinestTerrain {
  return {
    near: (lon, lat) => finestFor(scene).near(lon, lat),
    want: (lon, lat, fromLon, fromLat, nowMs) => finestFor(scene).want(lon, lat, fromLon, fromLat, nowMs),
  };
}

/**
 * Scene height to use when {@link sceneGroundHeight} has nothing yet. The
 * route elevation only once World Terrain is actually the globe's terrain;
 * before that (token ride, terrain still being set up or refused) the globe
 * is the 0 m ellipsoid, and route height would leave rider and camera
 * hanging hundreds of metres over the void on a slow phone.
 */
export function fallbackSceneEle(scene: Cesium.Scene, ele: number): number {
  return isFlatGlobe(scene) ? 0 : sceneEle(ele);
}

/** Tuning for the trailing follow camera. */
export interface FollowCamOptions {
  /**
   * The rider's drawn heading, radians clockwise from north: the filtered
   * heading (lib/ride/rideHeading) the avatar is drawn at, as in the world
   * renderer. The camera trails along it.
   */
  heading: number;
  /** Chase framing for the camera-distance setting (back, up, look-ahead). */
  framing: ChaseFraming;
  /**
   * Keep the camera at least this far above the terrain under it (m). A
   * camera 2–3 m up trails into a climb behind the rider on descents.
   */
  minClearanceMeters?: number;
}

// Eased follow-cam state, held across frames so the camera glides rather
// than snapping. Cleared by resetFollowCam() on route change / ride restart.
// The camera and its look point are smoothed relative to the rider (in the
// rider's local east-north-up frame): easing a world position instead makes
// the camera lag v/k metres behind its target (3–5 m at riding speed), so a
// close camera would breathe with speed.
const followCam = new ChaseCamSmoother();
let seededWorldPos: Cesium.Cartesian3 | null = null;
let seededHeading = 0;
let seededPitch = 0;

/** Clear eased follow-cam state — call on route change or ride (re)start. */
export function resetFollowCam(): void {
  followCam.reset();
  seededWorldPos = null;
}

/**
 * Start the eased follow-cam from an existing camera pose (e.g. when another
 * camera mode hands back to chase) so it glides in instead of snapping or
 * easing from a stale position.
 */
export function seedFollowCam(position: Cesium.Cartesian3, heading: number, pitch: number): void {
  seededWorldPos = Cesium.Cartesian3.clone(position, new Cesium.Cartesian3());
  seededHeading = heading;
  seededPitch = pitch;
}

let camScratchCache: {
  enu: Cesium.Matrix4;
  inv: Cesium.Matrix4;
  current: Cesium.Cartesian3;
  next: Cesium.Cartesian3;
  localNext: Cesium.Cartesian3;
  offset: Cesium.Cartesian3;
  camPos: Cesium.Cartesian3;
} | null = null;

/** Per-frame scratch objects, created on first use (keeps module load Cesium-free). */
function camScratch() {
  camScratchCache ??= {
    enu: new Cesium.Matrix4(),
    inv: new Cesium.Matrix4(),
    current: new Cesium.Cartesian3(),
    next: new Cesium.Cartesian3(),
    localNext: new Cesium.Cartesian3(),
    offset: new Cesium.Cartesian3(),
    camPos: new Cesium.Cartesian3(),
  };
  return camScratchCache;
}

/**
 * Place the chase camera behind the rider the way the world renderer's chase
 * rig does (lib/cesiumCameras `chaseCamTarget`): trailing along the rider's
 * drawn heading, looking at the point `lookAheadM` ahead turned half the bend
 * toward the route (≤12°), at the shared look height (lib/world/cameraFraming
 * `chaseLookHeight`: the route point + 1 m, flat-road pitch on a climb).
 * Camera and look point ease toward that target relative to the rider each
 * frame.
 *
 * @param viewer Cesium viewer.
 * @param currentDeg The rider's ground contact (lat/lon, drawn ground height).
 * @param nextDeg The route point `opts.framing.lookAheadM` ahead, at the same ground.
 * @param opts Heading, framing and terrain clearance.
 * @param dt Seconds since the previous frame — keeps easing framerate-independent.
 * @returns The pose applied, rider-relative (for a transition into another mode).
 */
export function applyFollowCam(
  viewer: Cesium.Viewer,
  currentDeg: { lat: number; lon: number; ele: number },
  nextDeg: { lat: number; lon: number; ele: number },
  opts: FollowCamOptions,
  dt: number,
): CameraPose {
  const s = camScratch();
  const current = Cesium.Cartesian3.fromDegrees(currentDeg.lon, currentDeg.lat, currentDeg.ele, undefined, s.current);
  const next = Cesium.Cartesian3.fromDegrees(nextDeg.lon, nextDeg.lat, nextDeg.ele, undefined, s.next);

  // The rider's local ENU frame (x east, y north, z up): the route point
  // ahead and the camera live in it.
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(current, undefined, s.enu);
  const inv = Cesium.Matrix4.inverseTransformation(enu, s.inv);
  const localNext = Cesium.Matrix4.multiplyByPoint(inv, next, s.localNext);

  if (seededWorldPos) {
    const local = Cesium.Matrix4.multiplyByPoint(inv, seededWorldPos, new Cesium.Cartesian3());
    followCam.seed({ x: local.x, y: local.y, z: local.z }, seededHeading, seededPitch);
    seededWorldPos = null;
  }
  followCam.step(chaseCamTarget(opts.heading, localNext, opts.framing), Math.min(Math.max(dt, 0), 0.1));

  const eye = followCam.position;
  s.offset.x = eye.x;
  s.offset.y = eye.y;
  s.offset.z = eye.z;
  const camPos = Cesium.Matrix4.multiplyByPoint(enu, s.offset, s.camPos);

  // Terrain clearance under the camera: a camera 2–3 m up trails into the
  // slope behind the rider on a descent. A lifted camera still looks at the
  // same point, so the rider stays framed.
  const minClear = opts.minClearanceMeters ?? 0;
  const lift = minClear > 0 ? liftAboveTerrain(viewer.scene, camPos, currentDeg.ele, minClear) : 0;
  const from = { x: eye.x, y: eye.y, z: eye.z + lift };
  // Heading/pitch are relative to the camera's own ENU frame; a few metres
  // from the rider it differs from the rider's by microradians.
  const { heading, pitch } = lookAtHeadingPitch(from, followCam.look);

  viewer.camera.setView({
    destination: camPos,
    orientation: { heading, pitch, roll: 0 },
  });
  return { offsetENU: from, heading, pitch, roll: 0 };
}

/**
 * Lift a camera position so it stays at least `minClear` metres above the
 * loaded terrain under it (CPU tile height, no GPU pick). Readings more than
 * 60 m from the rider's own ground are coarse-tile chords and are ignored.
 * Over the photoreal mesh the globe still draws (opaque, depth-tested), so a
 * camera under its terrain sees the globe from below: lift for it unless the
 * globe is hidden or see-through there.
 * Mutates and returns `camPos`; the second value is the lift applied (m).
 */
export function liftAboveTerrain(
  scene: Cesium.Scene,
  camPos: Cesium.Cartesian3,
  riderEle: number,
  minClear: number,
): number {
  const globe = scene.globe as Cesium.Globe | undefined;
  if (!globe || typeof globe.getHeight !== 'function') return 0;
  if (photorealGroundShown(scene) && !globeDrawnOpaque(globe)) return 0;
  liftScratch ??= new Cesium.Cartographic();
  const carto = Cesium.Cartographic.fromCartesian(camPos, undefined, liftScratch);
  if (!carto) return 0;
  // The terrain as drawn: a camera over getHeight's finer tile can still be
  // under the coarser one drawn there, and see it from below.
  const ground = globeDrawnHeight(scene, globe, carto, (h) => Math.abs(h - riderEle) < 60);
  if (ground === undefined || !Number.isFinite(ground) || Math.abs(ground - riderEle) >= 60) return 0;
  const lift = ground + minClear - carto.height;
  if (lift <= 0) return 0;
  carto.height += lift;
  Cesium.Cartographic.toCartesian(carto, undefined, camPos);
  return lift;
}
let liftScratch: Cesium.Cartographic | null = null;

/** Frame the entire route nicely on the globe. */
export function flyToRoute(viewer: Cesium.Viewer, positions: Cesium.Cartesian3[]): void {
  if (positions.length === 0) return;
  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.4,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), sphere.radius * 2.8),
  });
}

/**
 * Fly the camera to a (lat, lon) target — used by the route-search flow to
 * preview a geocoded place before the user commits to generating a ride.
 *
 * `boundingBox` (south, north, west, east in degrees) is honored when present
 * so cities frame at city scale and peaks frame tightly; without it we fall
 * back to a fixed 4 km altitude that feels right for a single point.
 */
export function flyToPoint(
  viewer: Cesium.Viewer,
  target: {
    lat: number;
    lon: number;
    boundingBox?: [number, number, number, number];
  },
): void {
  const { lat, lon, boundingBox } = target;

  if (boundingBox) {
    const [south, north, west, east] = boundingBox;
    const rect = Cesium.Rectangle.fromDegrees(west, south, east, north);
    viewer.camera.flyTo({
      destination: rect,
      duration: 1.6,
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
    });
    return;
  }

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 4000),
    duration: 1.6,
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
  });
}

// ---------------------------------------------------------------------------
// Scene mood / time-of-day atmosphere
// ---------------------------------------------------------------------------

/**
 * A "mood" is a coherent set of scene-atmosphere parameters that makes the
 * globe feel like a specific time of day or weather condition.  We keep it
 * subtle — just enough variety to feel alive, never garish.
 *
 * Mood catalog:
 *   clear-noon         — bright midday, deep blue sky, minimal fog
 *   clear-afternoon    — warm ~16:00 afternoon light (legacy, kept for compat)
 *   golden-hour        — low amber sun, hazy horizon, saturated sky
 *   overcast           — flat grey sky, muted light, soft ground
 *   fjord-rain         — cool blue, heavy low cloud, dense desaturated fog
 *   alpine-storm       — dark dramatic sky, cold blue-purple, partial rays
 *   mediterranean-mist — warm hazy yellow sun, light sea-salt fog
 *   dusk-cool          — purple/pink horizon, low blue twilight
 *   valley-fog         — real low fog: bright milky grey, short visibility
 */
export type SceneMood =
  | 'clear-noon'
  | 'clear-afternoon'
  | 'golden-hour'
  | 'overcast'
  | 'fjord-rain'
  | 'alpine-storm'
  | 'mediterranean-mist'
  | 'dusk-cool'
  | 'valley-fog';

/** Convenience alias exported for route-metadata typing. */
export type MoodId = SceneMood;

interface MoodParams {
  /** UTC hour offset from the route's local noon for the sun angle. */
  sunHourFromNoon: number;
  fogDensity: number;
  fogMinimumBrightness: number;
  /**
   * Multiplier on Cesium's default Fog.heightScalar (0.001). Cesium multiplies
   * density by heightScalar directly, so these ~1.0 values must not be
   * assigned raw: that made fog ~1000x too dense and blacked out the ground.
   */
  fogHeightScalar: number;
  atmosphereHueShift: number;
  atmosphereSaturationShift: number;
  atmosphereBrightnessShift: number;
  /** SkyAtmosphere: enable per-fragment scattering for richer limb glow. */
  perFragmentAtmosphere: boolean;
  /** SkyAtmosphere light intensity multiplier (default ~50). */
  atmosphereLightIntensity: number;
  /**
   * scene.atmosphere (ground scattering) tuning.
   * hue/saturation/brightness shifts applied to the ground-level haze band.
   */
  groundHueShift: number;
  groundSaturationShift: number;
  groundBrightnessShift: number;
  // ---- Sky + clouds descriptor ----
  sky: SkyConfig;
}

export const MOODS: Record<SceneMood, MoodParams> = {
  // ------------------------------------------------------------------
  // clear-noon — bright midday, deep blue sky, minimal fog
  // ------------------------------------------------------------------
  'clear-noon': {
    sunHourFromNoon: 0,   // exactly noon — sun high, short shadows, crisp light
    fogDensity: 0.00008,
    fogMinimumBrightness: 0.20,
    fogHeightScalar: 1.0,
    atmosphereHueShift: 0.0,
    atmosphereSaturationShift: 0.08,   // punchy deep blue sky
    atmosphereBrightnessShift: 0.05,   // bright high-altitude feel
    perFragmentAtmosphere: true,
    atmosphereLightIntensity: 60,      // strongest direct sun
    groundHueShift: 0.0,
    groundSaturationShift: 0.06,
    groundBrightnessShift: 0.03,
    sky: {
      useRealSun: true,
      cloudCount: 6,          // sparse fair-weather cumulus
      cloudAltitudeM: 2800,
      starsVisible: false,
    },
  },
  // ------------------------------------------------------------------
  // clear-afternoon — warm ~16:00 light (legacy mood, kept for compat)
  // ------------------------------------------------------------------
  'clear-afternoon': {
    sunHourFromNoon: 4,   // ~16:00 local — long shadows, warm directional light
    fogDensity: 0.00012,
    fogMinimumBrightness: 0.25,
    fogHeightScalar: 1.0,
    atmosphereHueShift: 0.0,
    atmosphereSaturationShift: 0.05,   // slightly more vivid blue sky
    atmosphereBrightnessShift: 0.02,
    perFragmentAtmosphere: true,       // smooth limb glow on terrain silhouettes
    atmosphereLightIntensity: 55,      // slightly brighter than default 50
    groundHueShift: 0.0,
    groundSaturationShift: 0.05,
    groundBrightnessShift: 0.0,
    sky: {
      useRealSun: true,
      cloudCount: 8,          // afternoon convective cumulus
      cloudAltitudeM: 3000,
      starsVisible: false,
    },
  },
  'golden-hour': {
    sunHourFromNoon: 6.5, // ~18:30 local — low sun, golden haze
    fogDensity: 0.00022,
    fogMinimumBrightness: 0.18,
    fogHeightScalar: 0.8,              // fog lingers higher — hazy horizon feel
    atmosphereHueShift: 0.04,          // warm orange sky push
    atmosphereSaturationShift: 0.18,   // rich saturated sunset sky
    atmosphereBrightnessShift: -0.04,
    perFragmentAtmosphere: true,
    atmosphereLightIntensity: 45,      // softer — sun is low
    groundHueShift: 0.03,              // warm cast on ground haze
    groundSaturationShift: 0.12,
    groundBrightnessShift: -0.05,
    sky: {
      useRealSun: true,
      cloudCount: 10,         // dramatic sunset clouds
      cloudAltitudeM: 2500,
      starsVisible: false,
    },
  },
  'overcast': {
    sunHourFromNoon: 2,  // sun near zenith but diffuse through clouds
    fogDensity: 0.00035,
    fogMinimumBrightness: 0.55,        // brighter fog = milky overcast sky
    fogHeightScalar: 1.2,              // fog cuts off sharply at altitude
    atmosphereHueShift: 0.0,
    atmosphereSaturationShift: -0.20,  // desaturate — flat cloud light
    atmosphereBrightnessShift: 0.08,
    perFragmentAtmosphere: false,      // per-fragment limb glow looks odd under clouds
    atmosphereLightIntensity: 38,      // dimmer diffuse light
    groundHueShift: 0.0,
    groundSaturationShift: -0.15,
    groundBrightnessShift: 0.05,
    sky: {
      useRealSun: false,      // pinned clock — overcast has flat diffuse light
      cloudCount: 28,         // heavy cloud deck
      cloudAltitudeM: 1800,   // low ceiling
      starsVisible: false,
    },
  },
  // ------------------------------------------------------------------
  // fjord-rain — cool blue, heavy cloud, dense desaturated fog.
  // Norwegian fjords: low ceiling, dripping slate, moody silver light.
  // ------------------------------------------------------------------
  'fjord-rain': {
    sunHourFromNoon: 1,   // near-overhead but heavily diffused through cloud
    fogDensity: 0.00065,  // heavy — fjord mist blots the mid-distance
    fogMinimumBrightness: 0.60,        // bright silver-grey fog fills the valleys
    fogHeightScalar: 1.4,              // fog clings tight to the valley floor
    atmosphereHueShift: -0.04,         // cool blue push
    atmosphereSaturationShift: -0.30,  // heavily desaturated grey sky
    atmosphereBrightnessShift: 0.10,   // diffuse cloud brightness
    perFragmentAtmosphere: false,
    atmosphereLightIntensity: 32,      // very low — thick cloud cover
    groundHueShift: -0.03,             // cool blue ground haze
    groundSaturationShift: -0.25,
    groundBrightnessShift: 0.08,
    sky: {
      useRealSun: false,      // pinned — rain scenes look better with fixed flat light
      cloudCount: 32,         // near-solid cloud deck
      cloudAltitudeM: 1200,   // very low ceiling — fjord scale
      starsVisible: false,
    },
  },
  // ------------------------------------------------------------------
  // alpine-storm — dramatic dark clouds, cold blue-purple, partial rays.
  // Galibier in August when a front rolls in from the west.
  // ------------------------------------------------------------------
  'alpine-storm': {
    sunHourFromNoon: 3,   // mid-afternoon but storm light — low effective elevation
    fogDensity: 0.00045,
    fogMinimumBrightness: 0.35,        // dark, brooding fog layer
    fogHeightScalar: 1.3,
    atmosphereHueShift: -0.06,         // cold blue-purple sky tint
    atmosphereSaturationShift: -0.10,  // slight desaturation — bruised storm sky
    atmosphereBrightnessShift: -0.08,  // darker overall — storm shadow
    perFragmentAtmosphere: true,       // partial rays between cloud gaps look great
    atmosphereLightIntensity: 36,      // muted sun piercing cloud
    groundHueShift: -0.05,             // cold purple-grey ground cast
    groundSaturationShift: -0.12,
    groundBrightnessShift: -0.06,
    sky: {
      useRealSun: false,      // storm — dramatic fixed light sculpts the clouds better
      cloudCount: 35,         // aggressive storm deck, many overlapping layers
      cloudAltitudeM: 2200,
      starsVisible: false,
    },
  },
  // ------------------------------------------------------------------
  // mediterranean-mist — warm hazy yellow sun, light sea-salt fog.
  // Mallorca, Nice, Côte d'Azur: warm, bright, slightly washed out.
  // ------------------------------------------------------------------
  'mediterranean-mist': {
    sunHourFromNoon: 2.5, // mid-afternoon — sun still high but soft haze
    fogDensity: 0.00020,
    fogMinimumBrightness: 0.30,        // warm creamy sea haze
    fogHeightScalar: 0.9,              // haze lingers above the coastline
    atmosphereHueShift: 0.02,          // slight warm-yellow sky push
    atmosphereSaturationShift: 0.06,   // modest — haze softens colour
    atmosphereBrightnessShift: 0.06,   // bright bleached-out noon feel
    perFragmentAtmosphere: true,
    atmosphereLightIntensity: 58,      // strong Mediterranean sun
    groundHueShift: 0.02,              // warm ochre/sea-salt ground tint
    groundSaturationShift: 0.04,
    groundBrightnessShift: 0.04,
    sky: {
      useRealSun: true,
      cloudCount: 4,          // almost cloudless Mediterranean sky
      cloudAltitudeM: 3500,   // high cirrus-like layer
      starsVisible: false,
    },
  },
  // ------------------------------------------------------------------
  // valley-fog — a real foggy morning: bright milky grey that swallows the
  // far shore, soft shadowless light. Driven by live weather (WMO 45/48).
  // ------------------------------------------------------------------
  'valley-fog': {
    sunHourFromNoon: 1.5,
    fogDensity: 0.0009,                // dense — the far side of the lake fades out
    fogMinimumBrightness: 0.75,        // bright milky fog, not murk
    fogHeightScalar: 1.6,              // hugs the valley floor
    atmosphereHueShift: 0.0,
    atmosphereSaturationShift: -0.35,  // colour washed out by the fog
    atmosphereBrightnessShift: 0.12,
    perFragmentAtmosphere: false,
    atmosphereLightIntensity: 34,
    groundHueShift: 0.0,
    groundSaturationShift: -0.30,
    groundBrightnessShift: 0.10,
    sky: {
      useRealSun: false,      // flat diffuse light
      cloudCount: 20,         // low grey deck above the fog
      cloudAltitudeM: 900,
      starsVisible: false,
    },
  },
  // ------------------------------------------------------------------
  // dusk-cool — purple/pink horizon, low blue twilight.
  // Post-golden-hour: sun just below the horizon, blue-hour quality.
  // ------------------------------------------------------------------
  'dusk-cool': {
    sunHourFromNoon: 7.5, // ~19:30 — sun at/below horizon, blue-hour ambience
    fogDensity: 0.00030,
    fogMinimumBrightness: 0.15,        // dark purplish twilight murk
    fogHeightScalar: 0.75,             // haze spreads wide at low angles
    atmosphereHueShift: -0.08,         // cool blue-purple horizon tint
    atmosphereSaturationShift: 0.14,   // vivid purple-pink twilight band
    atmosphereBrightnessShift: -0.10,  // distinctly dark — twilight
    perFragmentAtmosphere: true,       // beautiful limb-glow at dusk
    atmosphereLightIntensity: 30,      // very low — sun is gone
    groundHueShift: -0.06,             // cool blue-violet ground haze
    groundSaturationShift: 0.08,
    groundBrightnessShift: -0.08,
    sky: {
      useRealSun: false,      // twilight — fixed time captures the blue-hour look
      cloudCount: 5,          // a few silhouetted clouds on the horizon
      cloudAltitudeM: 2000,
      starsVisible: true,     // Milky Way visible at dusk
    },
  },
};

/**
 * Pick a scene mood from the route's characteristics when no explicit mood is
 * attached to the route.  Callers should prefer the route's own `mood` field
 * (set on IconicRouteInfo / WorldTourStageInfo) when available.
 *
 * Heuristics:
 *   - Very long flat rides → golden-hour (dramatic light on open roads)
 *   - Big alpine ascents   → clear-noon  (mountains look best in crisp sun)
 *   - Medium routes        → golden-hour
 *   - Default              → clear-noon
 */
export function moodForRoute(route: { totalDistance: number; ascent: number }): SceneMood {
  const km = route.totalDistance / 1000;
  const ascentPerKm = route.ascent / Math.max(km, 1);

  if (km >= 40 && ascentPerKm < 10) return 'golden-hour'; // long flat/rolling
  if (ascentPerKm >= 20) return 'clear-noon';              // big mountains — crisp
  if (km >= 20) return 'golden-hour';                      // medium routes
  return 'clear-noon';
}

/**
 * Apply a SceneMood to the viewer.  Should be called after the clock time is
 * already set (so sun position is set first, then atmosphere is layered on top).
 */
/** Cesium's default Fog.heightScalar (engine/Source/Scene/Fog.js). */
export const CESIUM_FOG_HEIGHT_SCALAR = 0.001;

export function applySceneMood(viewer: Cesium.Viewer, mood: SceneMood): void {
  if (viewer.isDestroyed()) return;
  const p = MOODS[mood];
  const scene = viewer.scene;

  // Fog — density + height falloff for atmospheric depth.
  // FogExtended narrows the subset of private Cesium.Fog fields we probe at runtime.
  type FogExtended = Cesium.Fog & { minimumBrightness?: number; heightScalar?: number };
  scene.fog.density = p.fogDensity;
  const fog = scene.fog as FogExtended;
  if ('minimumBrightness' in fog) fog.minimumBrightness = p.fogMinimumBrightness;
  if ('heightScalar' in fog) fog.heightScalar = CESIUM_FOG_HEIGHT_SCALAR * p.fogHeightScalar;

  // Sky atmosphere — limb glow, saturation, warmth.
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.hueShift = p.atmosphereHueShift;
    scene.skyAtmosphere.saturationShift = p.atmosphereSaturationShift;
    scene.skyAtmosphere.brightnessShift = p.atmosphereBrightnessShift;
    scene.skyAtmosphere.perFragmentAtmosphere = p.perFragmentAtmosphere;
    // atmosphereLightIntensity controls how bright the Rayleigh scattering appears.
    if ('atmosphereLightIntensity' in scene.skyAtmosphere) {
      scene.skyAtmosphere.atmosphereLightIntensity = p.atmosphereLightIntensity;
    }
  }

  // Ground atmosphere (scene.atmosphere) — haze band at terrain level.
  // Available in Cesium 1.107+; guard with 'atmosphere' in scene check.
  // AtmosphereExtended narrows the private Cesium ground-atmosphere fields we probe.
  type AtmosphereExtended = {
    hueShift?: number;
    saturationShift?: number;
    brightnessShift?: number;
    dynamicLighting?: number;
  };
  if ('atmosphere' in scene && scene.atmosphere) {
    const atm = scene.atmosphere as AtmosphereExtended;
    if ('hueShift' in atm) atm.hueShift = p.groundHueShift;
    if ('saturationShift' in atm) atm.saturationShift = p.groundSaturationShift;
    if ('brightnessShift' in atm) atm.brightnessShift = p.groundBrightnessShift;
    // Tie ground atmosphere lighting to the sun so it shifts with mood.
    if ('dynamicLighting' in atm && Cesium.DynamicAtmosphereLightingType) {
      atm.dynamicLighting = Cesium.DynamicAtmosphereLightingType.SUNLIGHT;
    }
  }
}

/**
 * Compute the UTC JulianDate that places the sun at the user's current local
 * time of day at the route's longitude — so morning rides look like morning
 * and evening rides look like evening.
 *
 * The sun elevation is clamped to at least MIN_SUN_ELEVATION_DEG above the
 * horizon so we never end up in midnight darkness mid-ride, regardless of the
 * user's actual wall-clock time.
 *
 * The `hoursFromNoon` parameter is used as a fallback when the clamping
 * logic overrides the real time (e.g. for night-time users who still want
 * a readable daytime scene).
 *
 * @param lonDeg         Route's representative longitude (degrees, -180...180).
 * @param hoursFromNoon  Mood-requested offset from local noon; used only when
 *                       real local time would place the sun below the 15-degree
 *                       floor.
 */
export function julianDateForMood(lonDeg: number, hoursFromNoon: number): Cesium.JulianDate {
  const now      = new Date();
  const todayIso = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const utcBase  = Cesium.JulianDate.fromIso8601(`${todayIso}T00:00:00Z`);

  // Current UTC decimal hour (0-24).
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;

  // Solar offset: how many hours ahead of UTC the route longitude is.
  // (lon/15 gives the offset in hours; +ve east, -ve west.)
  const solarOffset = lonDeg / 15;

  // Local solar decimal hour at the route's longitude.
  const localSolar = utcHour + solarOffset;

  // Hours from local solar noon — in the range (-12, 12].
  const localFromNoon = ((localSolar - 12) % 24 + 36) % 24 - 12;

  // Sun elevation at solar noon is approximately 90 - |latitude|.  We don't
  // have the latitude here, so use a conservative 60-degree estimate that
  // holds for latitudes 0-50 degrees.  The sun drops ~15 deg/hr from noon.
  const noonElevDeg = 60;    // degrees, conservative estimate
  const minSunDeg   = 15;    // never allow the sun below this elevation
  // Maximum |hoursFromNoon| where the sun is still above minSunDeg.
  const maxAbsHours = (noonElevDeg - minSunDeg) / 15; // = 3.0 hours

  // If it's currently daytime at the route location, use the real time.
  // If it's night or very low sun, fall back to the mood-requested offset,
  // clamped so the sun stays above the floor.
  let chosenFromNoon: number;
  if (Math.abs(localFromNoon) <= maxAbsHours) {
    chosenFromNoon = localFromNoon;
  } else {
    // Night at route location — use mood offset but keep sun readable.
    chosenFromNoon = Math.max(-maxAbsHours, Math.min(maxAbsHours, hoursFromNoon));
  }

  // UTC noon at the route's longitude = 12 - solarOffset.
  const utcNoon     = 12 - solarOffset;
  const targetUtcHr = utcNoon + chosenFromNoon;

  return Cesium.JulianDate.addHours(utcBase, targetUtcHr, new Cesium.JulianDate());
}
