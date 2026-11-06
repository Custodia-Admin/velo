/**
 * One height source on the photoreal renderer (owner report, 4 Nov 2026,
 * Lake Trasimeno shore): the globe stays drawn, opaque and depth-tested under
 * the Google photoreal mesh, and there its terrain sits 1–5 m ABOVE the mesh.
 * The rider rode the mesh, under the globe, with the chase camera between the
 * two surfaces: Cesium drew the globe's underside (with the road the corridor
 * paints on it) as a ceiling over the rider's own road, two roads stacked.
 *
 * The rider's ground is the surface you see: the higher of mesh and globe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';

import { rideAgain } from '@/components/velo/FinishCard';

import {
  createGroundSampler,
  createMeshRoadFilter,
  followGround,
  GLOBE_OVER_MESH_M,
  GROUND_SAMPLE_INTERVAL_MS,
  OVERHANG_GIVE_UP_M,
  OVERHANG_MIN_M,
  OVERHANG_STEP_GRADE,
  OVERHANG_STEP_M,
  OVERHANG_STEP_SPAN_M,
} from '@/lib/avatar';
import {
  drawnGroundHeight,
  DRAWN_UNDER_LOADED_MAX_M,
  getPhotorealTileset,
  groundSettled,
  liftAboveTerrain,
  sampleGroundHeight,
  sceneGroundHeight,
  setIonToken,
} from '@/lib/cesiumUtils';
import { ridePose } from '@/lib/ride/rideSim';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';

async function photoreal(height: number | undefined, opts: { show?: boolean; tilesLoaded?: boolean } = {}) {
  const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
  Object.defineProperty(fake, 'show', { value: opts.show ?? true, writable: true });
  Object.defineProperty(fake, 'tilesLoaded', { value: opts.tilesLoaded ?? true, writable: true });
  // The mesh's height field (tests swap it with mockImplementation). The app
  // reads it down the local vertical (meshHeightAt → tileset.pick), so the
  // fake's pick answers from it at the spot the ray goes through.
  const getHeight = vi.fn((_c?: Cesium.Cartographic): number | undefined => height);
  Object.defineProperty(fake, 'getHeight', { value: getHeight });
  Object.defineProperty(fake, 'pick', {
    value: (ray: Cesium.Ray, frameState: unknown) => {
      requireFrameState(frameState);
      const c = Cesium.Cartographic.fromCartesian(ray.origin);
      const h = getHeight(c);
      return h === undefined ? undefined : Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, h);
    },
  });
  vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
  const tileset = await getPhotorealTileset();
  return { tileset, getHeight };
}

/** The fake scenes' frameState (Cesium's own: what the tile pick reads its GL context from). */
const FRAME_STATE = { context: { webgl2: true } };

/**
 * The real Cesium3DTileset.prototype.pick reads `frameState.context` first:
 * called without the scene's frameState it throws, on every photoreal frame.
 * (The CI ride smoke test has no token, so no tileset: only these fakes see it.)
 */
function requireFrameState(frameState: unknown) {
  if (frameState !== FRAME_STATE) throw new TypeError("tileset.pick needs the scene's frameState");
}

interface GlobeOpts {
  height: number | undefined;
  show?: boolean;
  translucent?: boolean;
  tilesLoaded?: boolean;
  /**
   * The globe tile drawn last frame at the spot (Globe.pick): undefined for no
   * rendered tile there; leave the key out for a globe without `pick`.
   */
  drawn?: number | undefined;
}

function scene(tileset: Cesium.Cesium3DTileset | null, g: GlobeOpts, terrain: object = { worldTerrain: true }) {
  const globe = {
    show: g.show ?? true,
    translucency: { enabled: g.translucent ?? false },
    tilesLoaded: g.tilesLoaded ?? true,
    getHeight: vi.fn(() => g.height),
  } as {
    show: boolean;
    translucency: { enabled: boolean };
    tilesLoaded: boolean;
    getHeight: ReturnType<typeof vi.fn>;
    pick?: ReturnType<typeof vi.fn>;
  };
  const s = {
    context: FRAME_STATE.context,
    frameState: FRAME_STATE,
    primitives: { length: tileset ? 1 : 0, get: () => tileset },
    sampleHeightSupported: true,
    sampleHeight: vi.fn(() => undefined),
    globe,
    terrainProvider: terrain,
  } as unknown as Cesium.Scene;
  if ('drawn' in g) {
    // Cesium's Globe.pick(ray, scene, result) reads scene.mode and the
    // rendered tiles; the fake answers only a ray straight down the local
    // vertical, where it crosses the drawn height.
    globe.pick = vi.fn((ray: Cesium.Ray, sc: unknown) => {
      if (sc !== s) throw new TypeError('globe.pick needs the scene');
      const top = Cesium.Cartographic.fromCartesian(ray.origin);
      const down = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(top);
      if (g.drawn === undefined || Cesium.Cartesian3.dot(down, ray.direction) > -0.999999) return undefined;
      // A ray starting under the drawn surface never crosses it.
      if (g.drawn >= top.height) return undefined;
      return Cesium.Cartesian3.fromRadians(top.longitude, top.latitude, g.drawn);
    });
  }
  return { s, globe };
}

afterEach(() => {
  vi.restoreAllMocks();
  setIonToken(null);
});

describe('the rider stands on the drawn ground over the photoreal mesh', () => {
  it('globe drawn 3 m above the mesh (Trasimeno shore): the globe is the ground, not the buried mesh', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(306.2);
    const { s } = scene(tileset, { height: 309.2 });
    expect(sceneGroundHeight(s, 12.1, 43.2, [], 259)).toBeCloseTo(309.2, 6);
  });

  it('mesh above the globe (embankment, bridge): the mesh is the ground', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(312.5);
    const { s } = scene(tileset, { height: 309.2 });
    expect(sceneGroundHeight(s, 12.1, 43.2, [], 259)).toBeCloseTo(312.5, 6);
  });

  it('a globe that is hidden or see-through near the camera does not count', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(306.2);
    expect(sceneGroundHeight(scene(tileset, { height: 309.2, show: false }).s, 12.1, 43.2, [], 259)).toBeCloseTo(306.2, 6);
    expect(sceneGroundHeight(scene(tileset, { height: 309.2, translucent: true }).s, 12.1, 43.2, [], 259)).toBeCloseTo(306.2, 6);
  });

  it('coarse chords are ignored on either surface (the root mesh tile sat at −39 837 m)', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(-39_837);
    expect(sceneGroundHeight(scene(tileset, { height: 310.9 }).s, 12.1, 43.2, [], 259)).toBeCloseTo(310.9, 6);
    const { tileset: fine } = await photoreal(307.3);
    expect(sceneGroundHeight(scene(fine, { height: -69_770 }).s, 12.1, 43.2, [], 259)).toBeCloseTo(307.3, 6);
  });

  it('drawnGroundHeight without a sample is the globe; on the flat globe it is 0 m', () => {
    setIonToken('eyJ_test');
    expect(drawnGroundHeight(scene(null, { height: 309.2 }).s, 12.1, 43.2, undefined, 259)).toBeCloseTo(309.2, 6);
    const flat = scene(null, { height: 0 }, new Cesium.EllipsoidTerrainProvider()).s;
    expect(drawnGroundHeight(flat, 12.1, 43.2, undefined, 259)).toBe(0);
  });

  it("the avatar's throttled sampler reuses the mesh reading while the mesh is the ground; the globe is read fresh every frame", async () => {
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photoreal(306.2);
    const g: GlobeOpts = { height: 305 };
    const { s, globe } = scene(tileset, g);
    globe.getHeight.mockImplementation(() => g.height);
    const sampler = createGroundSampler(s);
    expect(sampler.sample(12.1, 43.2, 259, 1000)).toBeCloseTo(306.2, 6);
    // Next frame, a metre on: the globe rose but stays under the mesh, the mesh sample is reused.
    g.height = 305.9;
    expect(sampler.sample(12.10001, 43.2, 259, 1016)).toBeCloseTo(306.2, 6);
    expect(getHeight).toHaveBeenCalledTimes(1);
    // The globe rises over the mesh: it is the ground at once (read fresh).
    g.height = 309.9;
    expect(sampler.sample(12.10002, 43.2, 259, 1032)).toBeCloseTo(309.9, 6);
    // Under the mesh again: the mesh, sampled again after the interval.
    g.height = 305;
    sampler.sample(12.10003, 43.2, 259, 1048);
    const calls = getHeight.mock.calls.length;
    expect(sampler.sample(12.10004, 43.2, 259, 1064)).toBeCloseTo(306.2, 6);
    expect(getHeight).toHaveBeenCalledTimes(calls);
    sampler.sample(12.10005, 43.2, 259, 1048 + GROUND_SAMPLE_INTERVAL_MS);
    expect(getHeight).toHaveBeenCalledTimes(calls + 1);
  });

  it('on the globe over a coarse mesh reading, the mesh is read every frame: a finer tile landing over the globe is stood on at once', async () => {
    // Santa Monica start, photoreal at the ride's 60° field (t_a67fb090): a
    // coarse tile read 11 m under the drawn globe, the street landed 4.2 m
    // over it a few frames later, and the throttled sampler kept the rider on
    // the globe, under the street, for 150–290 ms (camera under the road).
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photoreal(295.0);
    const g: GlobeOpts = { height: 306.0 };
    const { s, globe } = scene(tileset, g);
    globe.getHeight.mockImplementation(() => g.height);
    const sampler = createGroundSampler(s);
    expect(sampler.sample(12.1, 43.2, 259, 1000)).toBeCloseTo(306.0, 6);
    expect(sampler.meshGround()).toBe(true);
    // The street's tile lands, one frame and a metre on.
    getHeight.mockImplementation(() => 310.2);
    expect(sampler.sample(12.10001, 43.2, 259, 1016)).toBeCloseTo(310.2, 6);
    // On the mesh now: its reading is reused until the interval.
    const calls = getHeight.mock.calls.length;
    expect(sampler.sample(12.10002, 43.2, 259, 1032)).toBeCloseTo(310.2, 6);
    expect(getHeight).toHaveBeenCalledTimes(calls);
  });

  it('on the globe over the mesh, a globe within GLOBE_OVER_MESH_M of the reading keeps the throttle', async () => {
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photoreal(306.2);
    const g: GlobeOpts = { height: 306.2 + GLOBE_OVER_MESH_M - 0.01 };
    const { s, globe } = scene(tileset, g);
    globe.getHeight.mockImplementation(() => g.height);
    const sampler = createGroundSampler(s);
    sampler.sample(12.1, 43.2, 259, 1000);
    sampler.sample(12.10001, 43.2, 259, 1016);
    expect(getHeight).toHaveBeenCalledTimes(1);
    g.height = 306.2 + GLOBE_OVER_MESH_M + 0.01;
    sampler.sample(12.10002, 43.2, 259, 1032);
    expect(getHeight).toHaveBeenCalledTimes(2);
  });

  it('a hidden globe over the mesh reading is not stood on: the mesh reading keeps the throttle', async () => {
    // Once the mesh is the road under the rider, renderers/cesium/globeGate
    // hides the globe (globe.show = false). Its tiles still read 3.7 m over
    // the mesh here, but nothing draws them: the mesh is the ground, and its
    // reading (a tile pick each) is reused until the interval, not taken
    // every frame as while the globe is drawn over it.
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photoreal(306.2);
    const g: GlobeOpts = { height: 309.9, show: false };
    const { s, globe } = scene(tileset, g);
    globe.getHeight.mockImplementation(() => g.height);
    const sampler = createGroundSampler(s);
    expect(sampler.sample(12.1, 43.2, 259, 1000)).toBeCloseTo(306.2, 6);
    expect(sampler.meshGround()).toBe(true);
    expect(getHeight).toHaveBeenCalledTimes(1);
    // 36 km/h, 60 fps (0.16 m a frame): every frame inside the interval reuses the reading.
    const lonAt = (frame: number) => 12.1 + frame * 2e-6;
    let frame = 1;
    for (; 1000 + 16 * frame < 1000 + GROUND_SAMPLE_INTERVAL_MS; frame++) {
      expect(sampler.sample(lonAt(frame), 43.2, 259, 1000 + 16 * frame)).toBeCloseTo(306.2, 6);
    }
    expect(frame).toBeGreaterThan(10);
    expect(getHeight).toHaveBeenCalledTimes(1);
    // The interval is up: read again, once.
    sampler.sample(lonAt(frame), 43.2, 259, 1000 + GROUND_SAMPLE_INTERVAL_MS);
    sampler.sample(lonAt(frame + 1), 43.2, 259, 1016 + GROUND_SAMPLE_INTERVAL_MS);
    expect(getHeight).toHaveBeenCalledTimes(2);
    // The same globe drawn again: it is the ground, and the mesh is read every frame.
    globe.show = true;
    expect(sampler.sample(lonAt(frame + 2), 43.2, 259, 1032 + GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(309.9, 6);
    expect(sampler.sample(lonAt(frame + 3), 43.2, 259, 1048 + GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(309.9, 6);
    expect(getHeight).toHaveBeenCalledTimes(4);
  });
});

describe("the globe as drawn, not its deepest loaded tile (Santa Monica start, t_b6dbd3d2)", () => {
  // Measured per frame at the Santa Monica start (1280×648 @2, cat-bed, main
  // and PR #74): no photoreal tile under the rider yet, the globe drew a
  // level-14 tile at -32.15 m while globe.getHeight read the level-15 tile
  // loaded under it at -33.70 m. The rider stood on getHeight for 4 frames,
  // 1.1-1.4 m under the ground the camera saw, which hid its wheels.
  const lon = -118.4972;
  const lat = 34.0089;
  const ROUTE_ELE = 3;

  it('the rider stands on the drawn tile, over the finer one loaded under it', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(undefined);
    const g: GlobeOpts = { height: -33.7, drawn: -32.15 };
    const { s, globe } = scene(tileset, g);
    const sampler = createGroundSampler(s);
    expect(sampler.sample(lon, lat, ROUTE_ELE, 1000)).toBeCloseTo(-32.15, 6);
    expect(globe.pick).toHaveBeenCalled();
    // The globe refines there: the level-15 tile is drawn, and stood on.
    g.drawn = -33.69;
    expect(sampler.sample(lon, lat, ROUTE_ELE, 1016)).toBeCloseTo(-33.69, 6);
    expect(sampler.meshGround()).toBe(false);
  });

  it('the drawn globe over the mesh is the ground; a mesh over it still wins', async () => {
    setIonToken('eyJ_test');
    const { s } = scene(null, { height: -33.7, drawn: -32.15 });
    expect(drawnGroundHeight(s, lon, lat, -32.6, ROUTE_ELE)).toBeCloseTo(-32.15, 6);
    expect(drawnGroundHeight(s, lon, lat, -31.9, ROUTE_ELE)).toBeCloseTo(-31.9, 6);
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-32.15, 6);
  });

  it('no rendered tile under the spot: the loaded tiles decide (getHeight)', () => {
    setIonToken('eyJ_test');
    const { s, globe } = scene(null, { height: -33.7, drawn: undefined });
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-33.7, 6);
    expect(globe.pick).toHaveBeenCalledTimes(1);
  });

  it('high ground: the drawn tile on a 2,100 m pass is found from above it', () => {
    setIonToken('eyJ_test');
    const { s } = scene(null, { height: 2098.6, drawn: 2100.2 });
    expect(drawnGroundHeight(s, 9.65, 46.45, undefined, 2101)).toBeCloseTo(2100.2, 6);
  });

  it("a hidden globe's rendered tiles are stale: getHeight decides, the pick is never run", () => {
    setIonToken('eyJ_test');
    const { s, globe } = scene(null, { height: -33.7, drawn: -25.12, show: false });
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-33.7, 6);
    expect(globe.pick).not.toHaveBeenCalled();
  });

  it("a drawn tile far off the ground (a coarse tile's chord) is not stood on: the loaded tiles decide", () => {
    setIonToken('eyJ_test');
    // Measured: a drawn level-4 tile at -821 m over a loaded level-8 one at -25 m.
    const { s } = scene(null, { height: -25.15, drawn: -821.27 });
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-25.15, 6);
    expect(drawnGroundHeight(s, lon, lat, -32.4, ROUTE_ELE)).toBeCloseTo(-25.15, 6);
    const cam = Cesium.Cartesian3.fromDegrees(lon, lat, -24.1);
    expect(liftAboveTerrain(s, cam, -25.15, 1.5)).toBeCloseTo(0.45, 6);
  });

  it('a drawn tile far under the loaded one is a chord about to refine: the rider does not sink onto it', () => {
    setIonToken('eyJ_test');
    // Within the 800 m chord bound of the route, but 275 m under the loaded tile.
    const g: GlobeOpts = { height: -25.15, drawn: -300 };
    const { s } = scene(null, g);
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-25.15, 6);
    // Up to DRAWN_UNDER_LOADED_MAX_M under, the drawn tile is the ground:
    // measured, a level-15 tile drawn 1.14 m under the level-16 one loaded.
    g.height = -32.55;
    g.drawn = -33.69;
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-33.69, 6);
    g.drawn = -32.55 - DRAWN_UNDER_LOADED_MAX_M + 0.01;
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(g.drawn, 6);
    g.drawn = -32.55 - DRAWN_UNDER_LOADED_MAX_M - 0.01;
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-32.55, 6);
    g.drawn = -44.6;
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-32.55, 6);
    // Over the loaded tile there is no such limit (the start's 26 m step).
    g.height = -32.14;
    g.drawn = -5.87;
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-5.87, 6);
  });

  it('the chase camera keeps its clearance over the drawn tile, not the finer one under it', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(undefined);
    const { s } = scene(tileset, { height: -33.7, drawn: -32.15 });
    // 2.6 m over getHeight's tile, 1.05 m over the drawn one.
    const cam = Cesium.Cartesian3.fromDegrees(lon, lat, -31.1);
    const lift = liftAboveTerrain(s, cam, -32.15, 1.5);
    expect(lift).toBeCloseTo(0.45, 6);
    expect(Cesium.Cartographic.fromCartesian(cam).height).toBeCloseTo(-30.65, 6);
  });
});

describe('overhangs: only the road is ground, not what stands over it', () => {
  // Spots 2 m apart along a path heading north from (lon0, lat0).
  const lon0 = -118.5;
  const at = (m: number) => 34 + m / 110_540;
  const HIGH = 1e9;

  it('a palm canopy over the path (10 m up, the path before it still low) is not the road', () => {
    const f = createMeshRoadFilter();
    const mesh = (lat: number) => (lat > at(3) && lat < at(15) ? -18.0 : -28.2);
    const readAt = (_lon: number, lat: number) => mesh(lat);
    const got = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18].map((m) => f.next(mesh(at(m)), lon0, at(m), HIGH, readAt));
    expect(got).toEqual([-28.2, -28.2, -28.2, -28.2, -28.2, -28.2, -28.2, -28.2, -28.2, -28.2]);
  });

  it('a viaduct 29 m over the towpath is not the road, however long the rider is under it', () => {
    const f = createMeshRoadFilter();
    const mesh = (lat: number) => (lat > at(10) && lat < at(70) ? 189.3 : 160.2);
    const readAt = (_lon: number, lat: number) => mesh(lat);
    for (let m = 0; m <= 80; m += 2) expect(f.next(mesh(at(m)), lon0, at(m), HIGH, readAt)).toBe(160.2);
  });

  it('a tile refining higher under the rider is taken at once (the last road spot rose too)', () => {
    const f = createMeshRoadFilter();
    let refined = false;
    const mesh = () => (refined ? -28.1 : -33.0);
    const readAt = () => mesh();
    expect(f.next(mesh(), lon0, at(0), HIGH, readAt)).toBe(-33.0);
    refined = true;
    expect(f.next(mesh(), lon0, at(2), HIGH, readAt)).toBe(-28.1);
    // Stopped: the same spot.
    const g = createMeshRoadFilter();
    refined = false;
    g.next(mesh(), lon0, at(0), HIGH, readAt);
    refined = true;
    expect(g.next(mesh(), lon0, at(0), HIGH, readAt)).toBe(-28.1);
  });

  it('climbs, falls and holes: climbs and falls taken, a hole leaves the globe to decide but keeps the road', () => {
    const f = createMeshRoadFilter();
    const none = () => undefined;
    expect(f.next(300, lon0, at(0), HIGH, none)).toBe(300);
    expect(f.next(301.9, lon0, at(2), HIGH, none)).toBe(301.9); // 20 % + slack
    expect(f.next(290, lon0, at(4), HIGH, none)).toBe(290); // falls always
    expect(f.next(undefined, lon0, at(6), HIGH, none)).toBeUndefined();
    expect(f.next(299.5, lon0, at(8), HIGH, none)).toBe(290); // after the hole, still measured from the road
  });

  it('a coarse tile 600 m up is never the road (over the terrain ceiling)', () => {
    const f = createMeshRoadFilter();
    expect(f.next(768.9, lon0, at(0), 160 + 60, () => 768.9)).toBeUndefined();
    expect(f.next(158.4, lon0, at(2), 220, () => 158.4)).toBe(158.4);
    expect(f.next(768.9, lon0, at(4), 220, () => 768.9)).toBe(158.4);
  });

  // Lugano–Melide at 5 km, as measured on the mesh along the route: the
  // lakeside path at 326.0 m, then 4 m where the route clips the road edge,
  // 3.6 m up, then back down. Held under it, the rider sat inside the mesh
  // and the chase camera (2.5 m up) looked at a dark wall.
  const lugano5k = (lat: number) => (lat >= at(4) && lat < at(8) ? 331.2 : lat >= at(2) && lat < at(4) ? 327.6 : 326.0);

  it('anything lower than the chase camera could pass under is ridden over (Lugano–Melide 5 km), moving or stopped', () => {
    const f = createMeshRoadFilter();
    const readAt = (_lon: number, lat: number) => lugano5k(lat);
    expect([0, 2, 4, 4, 4].map((m) => f.next(lugano5k(at(m)), lon0, at(m), HIGH, readAt))).toEqual([326.0, 327.6, 331.2, 331.2, 331.2]);
    expect(f.status()).toBe('road');
    expect(f.next(lugano5k(at(10)), lon0, at(10), HIGH, readAt)).toBe(326.0); // and down again
    // From the path, 3.9 m up in one step is ridden over; 4.1 m (a low road bridge's deck) is over the road.
    const g = createMeshRoadFilter();
    g.next(100, lon0, at(0), HIGH, () => 100);
    expect(g.next(103.9, lon0, at(2), HIGH, () => 100)).toBe(103.9);
    const h = createMeshRoadFilter();
    h.next(100, lon0, at(0), HIGH, () => 100);
    expect(h.next(104.1, lon0, at(2), HIGH, () => 100)).toBe(100);
    expect(h.status()).toBe('overhang');
    expect(OVERHANG_MIN_M).toBe(4);
  });

  it('the sampler lifts a stopped rider onto the road edge, not under it', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
      lugano5k(Cesium.Math.toDegrees(c.latitude)),
    );
    const { s } = scene(tileset, { height: 300 });
    const sampler = createGroundSampler(s);
    sampler.sample(lon0, at(0), 330, 0);
    sampler.sample(lon0, at(2), 330, GROUND_SAMPLE_INTERVAL_MS);
    for (let i = 2; i < 6; i++) expect(sampler.sample(lon0, at(4), 330, i * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(331.2, 6);
  });

  // The mesh down the vertical along the route, every half metre, as the
  // rider's tiles drew it (cat-bed, PR #52 follow-up; linear in between, as
  // the mesh's triangles are).
  /** A height profile sampled every half metre from `m0`; flat beyond its ends. */
  const profile = (m0: number, h: number[]) => (m: number) => {
    const x = (m - m0) * 2;
    if (x <= 0) return h[0];
    if (x >= h.length - 1) return h[h.length - 1];
    const i = Math.floor(x);
    return h[i] + (h[i + 1] - h[i]) * (x - i);
  };
  /** Metres along the test path (north from lat 34) of a latitude. */
  const metres = (lat: number) => (lat - 34) * 110_540;
  /**
   * A straight path through Lugano–Melide 5 km heading `deg` (0 north, 90
   * east): where the spot `m` metres along the route is, and how far along
   * the route a spot is.
   */
  const path = (deg: number) => {
    // The route at 5000 m.
    const [lon0, lat0, m0] = [8.947537, 45.96563, 5000];
    const cosLat = Math.cos((lat0 * Math.PI) / 180);
    const [n, e] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
    return {
      spot: (m: number): [number, number] => [lon0 + ((m - m0) * e) / (111_320 * cosLat), lat0 + ((m - m0) * n) / 110_540],
      along: (lon: number, lat: number) => m0 + (lat - lat0) * 110_540 * n + (lon - lon0) * 111_320 * cosLat * e,
    };
  };
  // Lugano–Melide 4928–5010 m: the embankment the route climbs at 4.93 km
  // (6.7 m in 5.5 m, up to 1.46 m per m), its top, then down to the lakeside
  // path and a mound the route clips at 5 km (4.7 m in 6 m).
  const lugano = profile(
    4928,
    [
      328.53, 328.53, 328.53, 328.52, 328.52, 328.52, 328.52, 328.52, 328.53, 328.55, 328.92, 329.29, 330.0, 330.73, 331.19,
      331.8, 332.53, 333.26, 333.95, 334.58, 335.22, 335.4, 335.6, 335.81, 335.74, 335.72, 335.86, 336.03, 336.19, 336.17,
      335.95, 335.77, 335.6, 335.43, 335.26, 335.1, 334.93, 334.76, 334.57, 334.42, 334.43, 334.44, 334.36, 334.25, 334.08,
      333.92, 333.55, 333.2, 332.88, 332.56, 332.24, 331.93, 331.61, 331.26, 330.98, 330.76, 330.54, 330.32, 330.11, 329.89,
      329.67, 329.45, 329.23, 329.01, 328.8, 328.58, 328.36, 328.14, 327.91, 327.78, 327.88, 327.96, 328.03, 328.1, 328.18,
      328.25, 328.33, 328.4, 328.48, 328.55, 328.63, 328.7, 328.77, 328.85, 328.92, 329.0, 329.03, 328.78, 328.53, 328.27,
      328.01, 327.73, 327.42, 327.08, 326.74, 326.56, 326.53, 326.5, 326.48, 326.46, 326.44, 326.41, 326.39, 326.37, 326.35,
      326.33, 326.31, 326.29, 326.26, 326.24, 326.23, 326.22, 326.2, 326.19, 326.17, 326.16, 326.14, 326.12, 326.11, 326.09,
      326.08, 326.06, 326.05, 326.03, 326.04, 326.04, 326.05, 326.05, 326.06, 326.06, 326.07, 326.07, 326.07, 326.08, 326.16,
      326.56, 327.09, 327.67, 328.29, 328.72, 329.05, 329.38, 329.83, 330.29, 330.74, 331.19, 331.65, 332.03, 331.96, 331.74,
      331.52, 331.29, 331.07, 330.81, 330.57, 330.32, 330.07, 329.83, 329.58, 329.36, 329.13, 328.91, 328.7, 328.54, 328.37,
    ],
  );
  // Tree crowns over the Cuyahoga towpath (161 m) at 2400–2430 and 3016–3036 m,
  // and palms over the Santa Monica Strand (−32.3 m) at 1510–1546 m.
  const canopies = [
    profile(
      2400,
      [
        161.09, 161.05, 177.42, 177.69, 177.96, 177.9, 177.47, 176.09, 176.24, 161.05, 161.02, 161.01, 161.06, 161.48, 161.91,
        162.35, 162.78, 163.21, 163.22, 164.25, 165.3, 165.31, 165.38, 165.52, 165.67, 165.62, 167.33, 167.81, 167.69, 167.13,
        167.01, 167.14, 167.44, 167.53, 167.47, 167.21, 166.84, 166.31, 165.77, 165.33, 165.0, 161.2, 161.23, 161.25, 161.28,
        161.3, 161.36, 161.54, 164.47, 164.6, 164.59, 164.58, 164.56, 167.86, 167.61, 167.36, 167.27, 167.42, 167.21, 166.67,
        161.12,
      ],
    ),
    profile(
      3016,
      [
        177.8, 178.31, 178.43, 178.56, 178.41, 178.19, 178.21, 178.03, 174.13, 161.02, 161.02, 161.02, 161.04, 164.87, 165.52,
        167.86, 168.16, 168.47, 168.32, 168.11, 168.11, 172.06, 172.14, 172.27, 172.41, 172.55, 172.52, 172.44, 167.44, 167.37,
        167.15, 166.93, 166.7, 165.67, 161.06, 161.03, 161.03, 161.04, 161.04, 161.04, 181.03,
      ],
    ),
    profile(
      1510,
      [
        -32.33, -32.33, -32.33, -32.33, -32.33, -32.33, -32.33, -32.33, -32.33, -32.33, -32.31, -32.29, -32.28, -28.13, -27.91,
        -27.85, -27.87, -28.41, -32.27, -32.26, -32.24, -32.23, -22.02, -21.96, -21.93, -22.0, -22.2, -22.5, -22.26, -22.21,
        -24.52, -25.66, -26.4, -26.66, -26.85, -26.93, -14.59, -14.41, -14.29, -14.17, -14.25, -32.34, -28.12, -27.54, -26.59,
        -26.7, -24.53, -23.92, -23.42, -23.33, -23.24, -23.14, -22.72, -32.26, -32.29, -32.31, -32.33, -32.35, -24.15, -24.15,
        -24.15, -24.39, -24.58, -24.76, -25.82, -26.51, -26.75, -32.45, -32.48, -32.5, -32.5, -32.5, -32.5, -32.5,
      ],
    ),
  ];
  const canopySpans: [number, number][] = [
    [2400, 2430],
    [3016, 3036],
    [1510, 1546],
  ];

  /** The filter as it was before the re-read: the mesh is read only where the road was last taken. */
  function withoutReRead() {
    const f = createMeshRoadFilter();
    let roadLat = NaN;
    return {
      next(reading: number | undefined, lon: number, lat: number, readAt: (lon: number, lat: number) => number | undefined) {
        const got = f.next(reading, lon, lat, HIGH, (l, la) => (la === roadLat ? readAt(l, la) : undefined));
        if (f.status() === 'road') roadLat = lat;
        return got;
      },
      status: () => f.status(),
    };
  }

  /** Every way a rider rolls from `from` to `to` read `s` metres apart (2–8 m), at every half-metre phase. */
  function rollIns(from: number, to: number): number[][] {
    const out: number[][] = [];
    for (let s = 2; s <= 8; s++) {
      for (let o = 0; o < s; o += 0.5) {
        const spots: number[] = [];
        for (let m = from + o; m < to; m += s) spots.push(m);
        out.push([...spots, to]);
      }
    }
    return out;
  }

  it('a rise refused across a long gap is read again every metre: the Lugano–Melide ramps are ridden however far apart they are read', () => {
    // Rolled in from the flat before each ramp and stopped on it: on the
    // embankment's top at 4940 m (where the probes jump to) and on the mound
    // at 5000 m (4994 → 5000 m in one read is 4.67 m up, over the 4 m floor).
    // Every reading on the way is the road (the embankment rises 4.03 m in
    // 3 m at 4935 m). Along the route's own heading there (−155°, 2.5 m east
    // to west per 6 m) and due east: the re-read follows the path in
    // longitude as well as latitude.
    for (const deg of [-155, 90]) {
      const { spot, along } = path(deg);
      const readAt = (lon: number, lat: number) => lugano(along(lon, lat));
      for (const [from, stop] of [
        [4920, 4940],
        [4980, 5000],
      ]) {
        for (const spots of rollIns(from, stop)) {
          const f = createMeshRoadFilter();
          for (const m of spots) {
            const [lon, lat] = spot(m);
            const got = f.next(lugano(m), lon, lat, HIGH, readAt);
            expect(got, `${deg}°, read at ${spots.join(', ')} m: at ${m} m`).toBeCloseTo(lugano(m), 6);
            expect(f.status()).toBe('road');
          }
        }
      }
    }
    // Without the re-read the rider stayed in the mound (and in the embankment).
    const readAt = (_lon: number, lat: number) => lugano(metres(lat));
    const old = withoutReRead();
    for (const m of [4990, 4994, 5000, 5000]) old.next(lugano(m), lon0, at(m), readAt);
    expect(old.status()).toBe('overhang');
    // The embankment's steepest metre, which the re-read must allow.
    expect(lugano(4936.5) - lugano(4935.5)).toBeGreaterThan(1.45);
    expect(OVERHANG_STEP_M).toBe(1);
    expect(OVERHANG_STEP_GRADE).toBe(2);
  });

  it('the sampler lifts a rider read 6 m apart onto the mound and keeps it there, stopped', async () => {
    // Along the route's heading there (−155°): the mesh is read where the
    // route is, in longitude too.
    const { spot, along } = path(-155);
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
      lugano(along(Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude))),
    );
    const { s } = scene(tileset, { height: 352.6, show: false });
    const sampler = createGroundSampler(s);
    expect(sampler.sample(...spot(4994), 288.1, 0)).toBeCloseTo(326.07, 6);
    for (let i = 1; i <= 4; i++) {
      expect(sampler.sample(...spot(5000), 288.0, i * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(330.74, 6);
      expect(sampler.meshGround()).toBe(true);
    }
  });

  it('tree crowns and palms: what the re-read takes over the filter alone, a rider read every metre stood on too', () => {
    // The re-read allows 2 m per metre where the filter, read every metre,
    // allows 4. Read however far apart, the first reading the re-read takes
    // that the filter alone kept the rider under is one a rider read every
    // metre (14 km/h) was already standing on.
    let taken = 0;
    canopies.forEach((canopy, k) => {
      const [from, to] = canopySpans[k];
      const readAt = (_lon: number, lat: number) => canopy(metres(lat));
      for (const spots of rollIns(from, to)) {
        const fine = createMeshRoadFilter();
        const byMetre = new Map<number, number | undefined>();
        for (let m = spots[0]; m <= to; m += 1) byMetre.set(m, fine.next(canopy(m), lon0, at(m), HIGH, readAt));
        const f = createMeshRoadFilter();
        const old = withoutReRead();
        for (const m of spots) {
          const got = f.next(canopy(m), lon0, at(m), HIGH, readAt) as number;
          const was = old.next(canopy(m), lon0, at(m), readAt) as number;
          if (got === was) continue;
          // The two part here (afterwards they read from different roads).
          taken++;
          expect(f.status()).toBe('road');
          expect(old.status()).toBe('overhang');
          expect(byMetre.has(m), `${from} m, read at ${spots.join(', ')} m: ${m} m on the metre grid`).toBe(true);
          expect(got, `${from} m, read at ${spots.join(', ')} m: at ${m} m`).toBeLessThanOrEqual((byMetre.get(m) as number) + 1e-9);
          break;
        }
      }
    });
    // (It does take some: crowns whose near side slopes up gently.)
    expect(taken).toBeGreaterThan(0);
  });

  it('a tree crown is no ramp: read 4 to 6 m apart from the towpath, its edge is not climbed (Cuyahoga 3 km)', () => {
    const crown = canopies[1];
    const readAt = (_lon: number, lat: number) => crown(metres(lat));
    // (Read so that one sample lands within 4 m under it, its 3.85 m edge is
    // taken by the 4 m floor, as before: forest canopy over the road is card
    // t_148e9796.)
    for (const spots of [[3020.5, 3024.5], [3020.5, 3024.5, 3028.5], [3020.5, 3026.5], [3020.5, 3026.5, 3032.5], [3021, 3025, 3029], [3020.5, 3025.5, 3030.5]]) {
      const f = createMeshRoadFilter();
      const got = spots.map((m) => f.next(crown(m), lon0, at(m), HIGH, readAt));
      expect(got, `read at ${spots.join(', ')} m`).toEqual(spots.map(() => crown(spots[0])));
    }
    // Its edge: 3.85 m up within half a metre, steeper than a ramp.
    expect(crown(3022.5) - crown(3022)).toBeGreaterThan(OVERHANG_STEP_GRADE * OVERHANG_STEP_M);
  });

  // Cuyahoga 2060–2080 m: the towpath (161.3 m), then a crown whose edge rises
  // 4.2 m within half a metre at 2070.5 m, its top (165.6 m) and back down.
  const crownEdge = profile(
    2060,
    [
      161.33, 161.4, 161.45, 161.42, 161.4, 161.38, 161.38, 161.39, 161.38, 161.38, 161.36, 161.34, 161.33, 161.32, 161.31,
      161.3, 161.31, 161.31, 161.31, 161.3, 161.27, 161.24, 165.41, 165.49, 165.56, 165.56, 165.29, 164.89, 161.11, 161.09,
      161.08, 161.11, 161.12, 161.08, 161.05, 161.04, 161.05, 161.06, 161.05, 161.04, 161.05,
    ],
  );

  it('a crown edge 4.2 m up within half a metre is no ramp, however the steps fall on it (Cuyahoga 2.07 km)', () => {
    // From the towpath, read 4 to 10 m short of the crown's top: the rider
    // stays on the towpath. From 2.15 m per metre on, steps that split the
    // edge in two climb it from some of those spots (at 2.5, from 6.1 m short
    // of 2072.5 m): the rider 4.2 m up on the crown.
    const readAt = (_lon: number, lat: number) => crownEdge(metres(lat));
    for (let j = 0; j <= 5; j++) {
      const end = 2071.5 + j / 4;
      for (let k = 0; k < 120; k++) {
        const from = end - (4 + k / 20);
        const f = createMeshRoadFilter();
        f.next(crownEdge(from), lon0, at(from), HIGH, readAt);
        const got = f.next(crownEdge(end), lon0, at(end), HIGH, readAt);
        expect(got, `${from.toFixed(2)} → ${end} m`).toBe(crownEdge(from));
        expect(f.status()).toBe('overhang');
      }
    }
    // A rider read every metre (on the half-metre marks) is still on the
    // towpath at 2072.5 m.
    const fine = createMeshRoadFilter();
    for (let m = 2060.5; m <= 2072.5; m += 1) fine.next(crownEdge(m), lon0, at(m), HIGH, readAt);
    expect(fine.status()).toBe('overhang');
  });

  it('a ramp is judged per metre, however the gap splits into steps: 1.9 m per metre is ridden, 2.1 is not', () => {
    // Read from its foot 2.5 to 9.2 m on: steps of 0.83–0.93 m.
    for (const gap of [2.5, 3.7, 5.5, 6.5, 7.3, 9.2]) {
      for (const [grade, ridden] of [
        [1.9, true],
        [2.1, false],
      ] as const) {
        const ramp = (lat: number) => 100 + grade * Math.max(0, metres(lat));
        const readAt = (_lon: number, lat: number) => ramp(lat);
        const f = createMeshRoadFilter();
        f.next(100, lon0, at(0), HIGH, readAt);
        const got = f.next(ramp(at(gap)), lon0, at(gap), HIGH, readAt);
        expect(got, `${grade} m per m, read ${gap} m on`).toBeCloseTo(ridden ? 100 + grade * gap : 100, 6);
        expect(f.status()).toBe(ridden ? 'road' : 'overhang');
      }
    }
  });

  it('palm and deck edges stay over the road read 6 m apart', () => {
    const palm = (lat: number) => (lat > at(3) && lat < at(15) ? -18.0 : -28.2);
    const f = createMeshRoadFilter();
    expect([0, 6, 12, 18].map((m) => f.next(palm(at(m)), lon0, at(m), HIGH, (_lon, lat) => palm(lat)))).toEqual([
      -28.2, -28.2, -28.2, -28.2,
    ]);
    const deck = (lat: number) => (lat > at(9.5) && lat < at(70) ? 189.3 : 160.2);
    const g = createMeshRoadFilter();
    for (let m = 0; m <= 78; m += 6) expect(g.next(deck(at(m)), lon0, at(m), HIGH, (_lon, lat) => deck(lat))).toBe(160.2);
    // A low road bridge's deck 4.1 m up, from 1 m on: over the road read 2 m
    // apart (above), and read 6 m apart too.
    const low = (lat: number) => (lat > at(1) ? 104.1 : 100);
    const h = createMeshRoadFilter();
    h.next(100, lon0, at(0), HIGH, (_lon, lat) => low(lat));
    expect(h.next(104.1, lon0, at(6), HIGH, (_lon, lat) => low(lat))).toBe(100);
    expect(h.status()).toBe('overhang');
  });

  it('a spot with no reading on the way proves nothing: the rider keeps the road', () => {
    for (const none of [undefined, NaN]) {
      const holed = (lat: number) => (metres(lat) > 4995.5 && metres(lat) < 4999 ? none : lugano(metres(lat)));
      const f = createMeshRoadFilter();
      f.next(lugano(4994), lon0, at(4994), HIGH, (_lon, lat) => holed(lat));
      expect(f.next(lugano(5000), lon0, at(5000), HIGH, (_lon, lat) => holed(lat)), `${none}`).toBeCloseTo(326.07, 6);
      expect(f.status()).toBe('overhang');
    }
  });

  it("no reading at the last road spot now (its tile gone) doesn't stop the re-read: the mound is still ridden", () => {
    const readAt = (_lon: number, lat: number) => (lat === at(4994) ? undefined : lugano(metres(lat)));
    const f = createMeshRoadFilter();
    f.next(lugano(4994), lon0, at(4994), HIGH, readAt);
    expect(f.next(lugano(5000), lon0, at(5000), HIGH, readAt)).toBeCloseTo(330.74, 6);
    expect(f.status()).toBe('road');
  });

  it('a dip on the way gives the next step no head start: a wall face just past a gutter is no ramp', () => {
    // From the road at 100 m, read 4.5 m on (five 0.9 m steps, 1.8 m each at
    // most): the gutter 1 m down, then a face 1.9 m up from it (0.9 m over the
    // road), then 1.7 m a step to 106 m. Measured from the gutter the face is
    // too steep; from the road before it, it would pass.
    const mesh = (m: number) => (m < 0.45 ? 100 : m < 1.35 ? 99 : m < 2.25 ? 100.9 : m < 3.15 ? 102.6 : m < 4.05 ? 104.3 : 106);
    const readAt = (_lon: number, lat: number) => mesh(metres(lat));
    const f = createMeshRoadFilter();
    f.next(100, lon0, at(0), HIGH, readAt);
    expect(f.next(106, lon0, at(4.5), HIGH, readAt)).toBe(100);
    expect(f.status()).toBe('overhang');
  });

  it('the re-reads are bounded: two samples back at most, none further on under a deck', () => {
    // The mound read 9.8 m apart (4990.2 → 5000 m, 4.7 m up) is re-read every
    // 0.98 m: 9 reads besides the road spot's, the most there are. Read
    // 10.5 m apart, only the road spot is read again (the plain rule takes
    // the mound a few metres on).
    const readAt = (_lon: number, lat: number) => lugano(metres(lat));
    for (const [from, reads, status] of [
      [4990.2, 10, 'road'],
      [4989.5, 1, 'overhang'],
    ] as const) {
      let n = 0;
      const f = createMeshRoadFilter();
      f.next(lugano(from), lon0, at(from), HIGH, readAt);
      f.next(lugano(5000), lon0, at(5000), HIGH, (lon, lat) => (n++, readAt(lon, lat)));
      expect(f.status(), `from ${from} m`).toBe(status);
      expect(n, `from ${from} m`).toBe(reads);
    }
    // Under a deck 29 m up, from 9.5 m on, read every 6 m: only the spot where
    // the road was last taken (6 m), as before. Its edge at 12 m is out of
    // reach of six 2 m steps, so nothing on the way is read.
    const deck = (lat: number) => (lat > at(9.5) && lat < at(70) ? 189.3 : 160.2);
    const g = createMeshRoadFilter();
    const counts: number[] = [];
    for (let m = 0; m <= 78; m += 6) {
      let n = 0;
      g.next(deck(at(m)), lon0, at(m), HIGH, (_lon, lat) => (n++, deck(lat)));
      counts.push(n);
    }
    expect(counts).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(OVERHANG_STEP_SPAN_M).toBe(10);
  });

  it('the re-read stops reading as soon as the reading is out of reach of the steps left', () => {
    /** Mesh reads from a road at 100 m to a reading 6.2 m on, flat until 5.5 m. */
    const reRead = (reading: number) => {
      let n = 0;
      const mesh = (lat: number) => (metres(lat) > 5.5 ? reading : 100);
      const f = createMeshRoadFilter();
      f.next(100, lon0, at(0), HIGH, () => 100);
      f.next(reading, lon0, at(6.2), HIGH, (_lon, lat) => (n++, mesh(lat)));
      expect(f.status()).toBe('overhang');
      return n;
    };
    // Seven 0.89 m steps of up to 1.77 m reach 12.4 m: a palm 12.9 m up is out
    // of reach at once (only the road spot is read), 9 m up after two flat
    // steps, 4.5 m up after five.
    expect(reRead(112.9)).toBe(1);
    expect(reRead(109)).toBe(1 + 2);
    expect(reRead(104.5)).toBe(1 + 5);
  });

  it('a tile refined higher under the rider: the road spot alone decides, nothing on the way is read', () => {
    let refined = false;
    let n = 0;
    const mesh = () => (refined ? -28.1 : -33.0);
    const f = createMeshRoadFilter();
    f.next(mesh(), lon0, at(0), HIGH, mesh);
    refined = true;
    expect(f.next(mesh(), lon0, at(6), HIGH, () => (n++, mesh()))).toBe(-28.1);
    expect(n).toBe(1);
  });

  it('the sampler keeps the road under a canopy and the rider stays on it', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(undefined);
    let canopy = false;
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
      canopy && Cesium.Math.toDegrees(c.latitude) > at(1) ? -18.0 : -28.2,
    );
    const { s } = scene(tileset, { height: -32.5 });
    const sampler = createGroundSampler(s);
    expect(sampler.sample(lon0, at(0), -30, 0)).toBeCloseTo(-28.2, 6);
    canopy = true;
    expect(sampler.sample(lon0, at(2), -30, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(-28.2, 6);
    expect(sampler.sample(lon0, at(4), -30, 2 * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(-28.2, 6);
  });
});

describe('one drawn ground: the globe hidden, the rider on the mesh (Lugano–Melide)', () => {
  // Lugano–Melide 3 km: World Terrain as drawn 387.1 m, the photoreal mesh
  // 361.4 m, the real street (swissALTI3D + geoid) within ~1 m of the mesh.
  const lon = 8.95;
  const lat = (m: number) => 45.98 + m / 110_540;

  it('globe drawn: the rider rides it, 26 m over the street; globe hidden: the rider rides the mesh', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(361.4);
    const shown = scene(tileset, { height: 387.1 });
    expect(createGroundSampler(shown.s).sample(lon, lat(0), 312, 0)).toBeCloseTo(387.1, 6);
    const hidden = scene(tileset, { height: 387.1, show: false });
    expect(createGroundSampler(hidden.s).sample(lon, lat(0), 312, 0)).toBeCloseTo(361.4, 6);
  });

  it('meshGround: the road or something over it, never a coarse floating tile, no tile, or no mesh', async () => {
    setIonToken('eyJ_test');
    let reading: number | undefined = 160.2;
    let deck = false;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
      deck && Cesium.Math.toDegrees(c.latitude) > lat(1) ? 189.3 : reading,
    );
    const { s } = scene(tileset, { height: 160.4 });
    const sampler = createGroundSampler(s);
    expect(sampler.meshGround()).toBe(false);
    sampler.sample(lon, lat(0), 195, 0);
    expect(sampler.meshGround()).toBe(true);
    // The I-80 deck 29 m over the towpath: mesh is there, the rider holds the road.
    deck = true;
    expect(sampler.sample(lon, lat(2), 195, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(160.4, 6);
    expect(sampler.meshGround()).toBe(true);
    deck = false;
    // A coarse tile 610 m up (the Cuyahoga start): not the ground.
    reading = 768.9;
    sampler.sample(lon, lat(4), 195, 2 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(false);
    // No tile under the rider.
    reading = undefined;
    sampler.sample(lon, lat(6), 195, 3 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(false);
    // Tileset hidden (camera over 5 km): the globe is the ground.
    reading = 160.2;
    sampler.sample(lon, lat(8), 195, 4 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(true);
    (tileset as unknown as { show: boolean }).show = false;
    sampler.sample(lon, lat(10), 195, 5 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(false);
  });

  it("the root tile's chord far under the route is not mesh ground: the globe stays (Lugano–Melide start)", async () => {
    setIonToken('eyJ_test');
    // Measured at the start: the mesh read −27 979 m for ~4 s (only root
    // tiles selected), the globe a coarse 1 257 m, the street 321.6 m.
    let reading: number | undefined = -27_979.09;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => reading);
    const g: GlobeOpts = { height: 1_257.6 };
    const { s, globe } = scene(tileset, g);
    globe.getHeight.mockImplementation(() => g.height);
    const sampler = createGroundSampler(s);
    sampler.sample(lon, lat(0), 322, 0);
    expect(sampler.meshGround()).toBe(false);
    // The finer tiles land: the street is the mesh ground.
    reading = 321.6;
    g.height = 355.1;
    sampler.sample(lon, lat(0), 322, GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(true);
    // Globe hidden, a jump onto the chord again: not mesh ground (the gate
    // brings the globe back), and the rider keeps the street meanwhile.
    globe.show = false;
    reading = -27_979.09;
    expect(sampler.sample(lon, lat(4), 322, 2 * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(321.6, 6);
    expect(sampler.meshGround()).toBe(false);
  });

  it("the filter's status names each reading", () => {
    const f = createMeshRoadFilter();
    const none = () => undefined;
    expect(f.status()).toBe('none');
    f.next(300, lon, lat(0), 400, none);
    expect(f.status()).toBe('road');
    expect(f.road()).toBe(300);
    f.next(320, lon, lat(2), 400, () => 300);
    expect(f.status()).toBe('overhang');
    f.next(900, lon, lat(4), 400, none);
    expect(f.status()).toBe('coarse');
    // The root tile's chord, 28 km under the Lugano shore: coarse too, the road kept.
    expect(f.next(-27_979, lon, lat(5), 400, none, 262)).toBe(300);
    expect(f.status()).toBe('coarse');
    f.next(undefined, lon, lat(6), 400, none);
    expect(f.status()).toBe('none');
    expect(f.road()).toBe(300);
    f.reset();
    expect(f.status()).toBe('none');
    expect(f.road()).toBeUndefined();
  });

  it('a hole in the mesh under a hidden globe keeps the road; under a drawn globe the globe decides', async () => {
    setIonToken('eyJ_test');
    let reading: number | undefined = 361.4;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => reading);
    const g: GlobeOpts = { height: 387.1, show: false };
    const { s, globe } = scene(tileset, g);
    const sampler = createGroundSampler(s);
    expect(sampler.sample(lon, lat(0), 312, 0)).toBeCloseTo(361.4, 6);
    reading = undefined;
    // Not the hidden globe's stale 387 m, not undefined (the route's 312 m): the road.
    expect(sampler.sample(lon, lat(2), 312, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(361.4, 6);
    expect(sampler.meshGround()).toBe(false);
    globe.show = true;
    expect(sampler.sample(lon, lat(4), 312, 2 * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(387.1, 6);
  });

  it('a globe back from hiding with a stale chord far below holds the road until it has streamed in (Chengdu 5 km)', async () => {
    setIonToken('eyJ_test');
    let reading: number | undefined = 446.6;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => reading);
    const g: GlobeOpts = { height: -349.9, show: false, tilesLoaded: false };
    const { s, globe } = scene(tileset, g);
    const sampler = createGroundSampler(s);
    expect(sampler.sample(lon, lat(0), 434, 0)).toBeCloseTo(446.6, 6);
    reading = undefined; // a jump onto ground the mesh hasn't streamed yet
    globe.show = true; // the gate brings the globe back, its tiles 2 km stale
    expect(sampler.sample(lon, lat(2), 434, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(446.6, 6);
    // Streamed in: the globe's real terrain decides again.
    globe.tilesLoaded = true;
    globe.getHeight.mockReturnValue(439.8);
    expect(sampler.sample(lon, lat(4), 434, 2 * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(439.8, 6);
  });

  it("a hidden globe's stale tiles don't cap the road: the road the rider is on bounds the ceiling too", async () => {
    setIonToken('eyJ_test');
    // Route elevation 305 m (orthometric; the ellipsoid sits ~50 m higher
    // here), the hidden globe's last coarse tile reads 300 m: terrain-only
    // ceiling 365 m. The street climbs past it, 1.8 m per 2 m step.
    let reading: number | undefined;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => reading);
    const { s } = scene(tileset, { height: 300, show: false });
    const sampler = createGroundSampler(s);
    const got: number[] = [];
    [362, 363.8, 365.6, 367.4].forEach((h, i) => {
      reading = h;
      got.push(sampler.sample(lon, lat(2 * i), 305, i * GROUND_SAMPLE_INTERVAL_MS) as number);
      expect(sampler.meshGround()).toBe(true);
    });
    // (Read back through a ray hit: equal to the micrometre.)
    [362, 363.8, 365.6, 367.4].forEach((h, i) => expect(got[i]).toBeCloseTo(h, 6));
  });

  it("groundSettled ignores a hidden globe's frozen load queue", () => {
    setIonToken('eyJ_test');
    expect(groundSettled(scene(null, { height: 300, tilesLoaded: false, show: false }).s)).toBe(true);
    expect(groundSettled(scene(null, { height: 300, tilesLoaded: false }).s)).toBe(false);
  });
});

describe('a jump with the globe hidden: the old road is not the ground where the rider lands', () => {
  // Lugano–Melide, measured (PR #40 review): the road at 940 m is 322.6 m
  // (route 275.8 m). 2 km on, at 2940 m, the mesh is 363.4 m (route 303.3 m)
  // and the hidden globe's stale tile reads 383.75 m. Ride again (or a placed
  // rider) lands there before any mesh reading; holding 322.6 m put the rider
  // 41 m under the mesh and the camera 38.5 m under the drawn top for a second.
  const lon = 8.95;
  const lat = (m: number) => 45.98 + m / 110_540;
  const north = (c: Cesium.Cartographic, m: number) => Cesium.Math.toDegrees(c.latitude) > lat(m);

  async function landing(
    at: number,
    meshThere: number | undefined,
    globeThere: number | undefined,
    globeOpts: Partial<GlobeOpts> = { show: false },
  ) {
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photoreal(undefined);
    getHeight.mockImplementation((c?: Cesium.Cartographic) => (north(c!, at / 2) ? meshThere : 322.6));
    const g: GlobeOpts = { height: 337.2, ...globeOpts };
    const { s, globe } = scene(tileset, g);
    globe.getHeight.mockImplementation(((c: Cesium.Cartographic) => (north(c, at / 2) ? globeThere : g.height)) as () => number);
    const sampler = createGroundSampler(s);
    expect(sampler.sample(lon, lat(0), 275.8, 0)).toBeCloseTo(322.6, 6);
    expect(sampler.meshGround()).toBe(true);
    return sampler;
  }

  it('no mesh reading 2 km on: the globe decides, as at a fresh start, not the old road', async () => {
    const sampler = await landing(2_000, undefined, 383.75);
    const h = sampler.sample(lon, lat(2_000), 303.3, 16) as number;
    expect(Math.abs(h - 322.6)).toBeGreaterThan(30);
    expect(h).toBeCloseTo(383.75, 6);
    expect(sampler.meshGround()).toBe(false);
  });

  it("a coarse globe chord there is not stood on either: the road, carried along the route's climb", async () => {
    // A globe hidden for kilometres: one read 780 m under the road at Chengdu.
    const chord = await landing(2_000, undefined, -349.9);
    expect(chord.sample(lon, lat(2_000), 303.3, 16)).toBeCloseTo(322.6 + (303.3 - 275.8), 6);
    expect(chord.meshGround()).toBe(false);
    // And it stays that road while the mesh there is still missing: the climb
    // is carried from where the road was last READ, not from the last sample
    // (from the 2nd sample on that would be the old road again, 41 m under).
    for (const nowMs of [16 + GROUND_SAMPLE_INTERVAL_MS, 16 + 2 * GROUND_SAMPLE_INTERVAL_MS, 16 + 3 * GROUND_SAMPLE_INTERVAL_MS]) {
      expect(chord.sample(lon, lat(2_000), 303.3, nowMs)).toBeCloseTo(322.6 + (303.3 - 275.8), 6);
      expect(chord.meshGround()).toBe(false);
    }
    const none = await landing(2_000, undefined, undefined);
    expect(none.sample(lon, lat(2_000), 303.3, 16)).toBeCloseTo(350.1, 6);
    expect(none.sample(lon, lat(2_000), 303.3, 16 + GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(350.1, 6);
  });

  it('a chord is judged against the road carried up the climb, not the old road (a GPX mountain route)', async () => {
    // 2 km up a 5 % climb: the route rises 100 m (275.8 → 375.8 m), so the road
    // carried there is 422.6 m. The hidden globe's stale tile reads 300 m:
    // within 60 m of the OLD road (322.6 m) but 122.6 m under the road there,
    // a chord. Stood on, the rider would be over 100 m under the mesh street.
    const sampler = await landing(2_000, undefined, 300);
    expect(sampler.sample(lon, lat(2_000), 375.8, 16)).toBeCloseTo(322.6 + (375.8 - 275.8), 6);
    expect(sampler.meshGround()).toBe(false);
  });

  it('a jump onto a globe drawn but still streaming: that globe decides too, not the old road', async () => {
    // Ride again with the globe back on (the gate drew it: no mesh road for a
    // second; on the old road it was drawn under the mesh) and its tiles still
    // loading. 2 km on and 20 m down the route (275.8 → 255.8 m) the drawn
    // globe reads 300 m. Holding the old road (322.6 m) would float the rider
    // 22.6 m over the drawn ground. (Near the old road a streaming globe still
    // holds the road: the Chengdu test above.)
    const sampler = await landing(2_000, undefined, 300, { height: 318.0, show: true, tilesLoaded: false });
    expect(sampler.sample(lon, lat(2_000), 255.8, 16)).toBeCloseTo(300, 6);
    expect(sampler.meshGround()).toBe(false);
    expect(sampler.sample(lon, lat(2_000), 255.8, 16 + GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(300, 6);
  });

  it("a coarse mesh reading there (the root tile's chord) doesn't bring back the old road", async () => {
    const sampler = await landing(2_000, -27_979.09, 383.75);
    expect(sampler.sample(lon, lat(2_000), 303.3, 16)).toBeCloseTo(383.75, 6);
    expect(sampler.meshGround()).toBe(false);
  });

  it('the globe decides there even a little under the road carried there (that is only a guess)', async () => {
    const sampler = await landing(2_000, undefined, 341.9);
    expect(sampler.sample(lon, lat(2_000), 303.3, 16)).toBeCloseTo(341.9, 6);
  });

  it('a hole near the road still keeps it; from OVERHANG_GIVE_UP_M on the globe decides', async () => {
    const sampler = await landing(100, undefined, 383.75);
    expect(sampler.sample(lon, lat(OVERHANG_GIVE_UP_M - 1), 275.8, 16)).toBeCloseTo(322.6, 6);
    expect(sampler.sample(lon, lat(OVERHANG_GIVE_UP_M + 0.5), 275.8, 16 + GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(383.75, 6);
    expect(OVERHANG_GIVE_UP_M).toBe(100);
  });

  it('the road carried along the route bounds the ceiling there: a street 77 m over the old one is taken', async () => {
    // Route 335.0 m there (59.2 m up), the mesh street 400 m, the hidden
    // globe's stale tile 300 m. Bounded by the old road (322.6 + 60 m over
    // the 335 m route) the street read as a coarse tile.
    const sampler = await landing(2_000, 400, 300);
    expect(sampler.sample(lon, lat(2_000), 335.0, 16)).toBeCloseTo(400, 6);
    expect(sampler.meshGround()).toBe(true);
  });
});

describe('Ride again on photoreal: the finish line road is not the ground on the start line', () => {
  it('the rider back at 0 m stands on the globe there until the mesh road there is read', async () => {
    // The real user path: the store, FinishCard's Ride again and the pose the
    // ride view samples the ground at, on the real Lugano–Melide route.
    const route = scenicRouteById('scenic-lugano-melide')!.route;
    const finish = ridePose(route, 2_940);
    const start = ridePose(route, 0);
    const nearStart = (c: Cesium.Cartographic) =>
      Math.abs(Cesium.Math.toDegrees(c.latitude) - start.lat) < Math.abs(Cesium.Math.toDegrees(c.latitude) - finish.lat);
    let startMesh: number | undefined = undefined;
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photoreal(undefined);
    getHeight.mockImplementation((c?: Cesium.Cartographic) => (nearStart(c!) ? startMesh : 363.4));
    const { s, globe } = scene(tileset, { height: 0, show: false });
    // The hidden globe's last tiles: refined on the start line, coarse at the finish.
    globe.getHeight.mockImplementation(((c: Cesium.Cartographic) => (nearStart(c) ? 330.0 : 375.2)) as () => number);
    const sampler = createGroundSampler(s);
    const frame = (nowMs: number) => {
      const pose = ridePose(route, useRideStore.getState().distance);
      return sampler.sample(pose.lon, pose.lat, pose.ele, nowMs);
    };
    useRideStore.getState().setRoute(route);
    useRideStore.getState().start();
    useRideStore.setState({ distance: 2_940 });
    expect(frame(0)).toBeCloseTo(363.4, 6);
    useRideStore.getState().finish();
    rideAgain();
    expect(useRideStore.getState().distance).toBe(0);
    // The start line's mesh hasn't streamed back yet.
    const h = frame(16) as number;
    expect(h).toBeCloseTo(330.0, 6);
    expect(sampler.meshGround()).toBe(false);
    // It has: the rider is on the street.
    startMesh = 321.6;
    expect(frame(32)).toBeCloseTo(321.6, 6);
    expect(sampler.meshGround()).toBe(true);
    useRideStore.getState().reset();
  });
});

describe('the mesh is read straight down the vertical (Cesium3DTileset.getHeight leans up to 0.19°)', () => {
  // Lugano–Melide 2940 m, measured on cat-bed: the road is drawn at 363.41 m
  // (GPU pick and the main view's depth at the wheels agree), with a kerb
  // about 0.5 m south and the mesh 362.8 m beyond it. getHeight's ray runs
  // through the Earth's centre, so it crosses 363 m 1.21 m south of the spot:
  // it read 362.84 m, and the wheels sat 0.57 m in the road.
  const lon = 8.95;
  const lat0 = 45.98;
  const kerb = Cesium.Math.toRadians(lat0 - 0.5 / 110_540);

  /** Where a downward ray crosses height h (it heads for the Earth's centre); none behind its origin. */
  function crossing(ray: Cesium.Ray, h: number): Cesium.Cartesian3 | undefined {
    const surface = Cesium.Cartesian3.magnitude(ray.origin) - 6_367_000;
    let lo = surface - 50_000;
    let hi = surface + 50_000;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (Cesium.Cartographic.fromCartesian(Cesium.Ray.getPoint(ray, mid)).height > h) lo = mid;
      else hi = mid;
    }
    return lo < 0 ? undefined : Cesium.Ray.getPoint(ray, (lo + hi) / 2);
  }

  async function kerbTileset() {
    const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
    Object.defineProperty(fake, 'show', { value: true, writable: true });
    Object.defineProperty(fake, 'tilesLoaded', { value: true, writable: true });
    // The road at 363.4 m north of the kerb, 362.8 m south of it. Only
    // `pick` is faked: Cesium's own getHeight casts its ray through it.
    Object.defineProperty(fake, 'pick', {
      value: (ray: Cesium.Ray, frameState: unknown) => {
        requireFrameState(frameState);
        const top = crossing(ray, 363.4);
        if (top && Cesium.Cartographic.fromCartesian(top).latitude >= kerb) return top;
        return crossing(ray, 362.8);
      },
    });
    vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
    return getPhotorealTileset();
  }

  it("the rider stands on the road beside the kerb, where getHeight's leaning ray read past it", async () => {
    setIonToken('eyJ_test');
    const tileset = (await kerbTileset())!;
    const { s } = scene(tileset, { height: 383.75, show: false });
    expect(sampleGroundHeight(s, lon, lat0)).toBeCloseTo(363.4, 3);
    expect(createGroundSampler(s).sample(lon, lat0, 303.3, 0)).toBeCloseTo(363.4, 3);
    // Cesium's own reading through the same mesh lands past the kerb. (If an
    // upgrade fixes getHeight, this flips, and meshHeightAt can go.)
    expect(tileset.getHeight(Cesium.Cartographic.fromDegrees(lon, lat0), s)).toBeCloseTo(362.8, 3);
  });
});

describe('followGround: the avatar never lags under a rising surface', () => {
  it('rises at once (a tile loading 4 m higher), eases down', () => {
    expect(followGround(null, 300, 1 / 60)).toBe(300);
    expect(followGround(300, 300.4, 1 / 60)).toBe(300.4);
    expect(followGround(-32.4, -28.2, 1 / 60)).toBe(-28.2);
    const down = followGround(303.7, 300, 1 / 60);
    expect(down).toBeLessThan(303.7);
    expect(down).toBeGreaterThan(300);
  });
});

describe('groundSettled: the ride start waits for the ground under the rider', () => {
  it('no token: nothing streams, always settled', () => {
    setIonToken(null);
    expect(groundSettled(scene(null, { height: 0, tilesLoaded: false }, new Cesium.EllipsoidTerrainProvider()).s)).toBe(true);
  });

  it('token: waits for World Terrain, the globe tiles and the shown photoreal mesh', async () => {
    setIonToken('eyJ_test');
    expect(groundSettled(scene(null, { height: 0 }, new Cesium.EllipsoidTerrainProvider()).s)).toBe(false);
    expect(groundSettled(scene(null, { height: 300, tilesLoaded: false }).s)).toBe(false);
    expect(groundSettled(scene(null, { height: 300 }).s)).toBe(true);
    const { tileset } = await photoreal(306, { tilesLoaded: false });
    expect(groundSettled(scene(tileset, { height: 300 }).s)).toBe(false);
    (tileset as unknown as { show: boolean }).show = false;
    expect(groundSettled(scene(tileset, { height: 300 }).s)).toBe(true);
  });

  it('a ground that has held still counts as settled, but never the flat pre-terrain globe', () => {
    setIonToken('eyJ_test');
    expect(groundSettled(scene(null, { height: 300, tilesLoaded: false }).s, true)).toBe(true);
    expect(groundSettled(scene(null, { height: 0 }, new Cesium.EllipsoidTerrainProvider()).s, true)).toBe(false);
  });
});
