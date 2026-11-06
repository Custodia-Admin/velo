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
  createAvatar,
  createGroundSampler,
  createMeshRoadFilter,
  DECK_RUN_M,
  followGround,
  GLOBE_OVER_MESH_M,
  GLOBE_STANDIN_M,
  GLOBE_STANDIN_UNDER_M,
  GROUND_SAMPLE_INTERVAL_MS,
  OVERHANG_GIVE_UP_M,
  OVERHANG_MIN_M,
  OVERHANG_STEP_GRADE,
  OVERHANG_STEP_M,
  OVERHANG_STEP_SPAN_M,
  UNDER_BARE_M,
} from '@/lib/avatar';
import {
  clearMeshTopReads,
  drawnGroundHeight,
  getPhotorealTileset,
  groundSettled,
  liftAboveTerrain,
  sampleGroundHeight,
  sceneGroundHeight,
  sceneFinestTerrain,
  setIonToken,
} from '@/lib/cesiumUtils';
import { createFinestTerrain } from '@/lib/finestTerrain';
import { ridePose } from '@/lib/ride/rideSim';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { GLOBE_SHOW_AFTER_MS, GroundGate } from '@/renderers/cesium/globeGate';
import { useRideStore } from '@/stores/rideStore';

async function photoreal(height: number | undefined, opts: { show?: boolean; tilesLoaded?: boolean } = {}) {
  const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
  Object.defineProperty(fake, 'show', { value: opts.show ?? true, writable: true });
  Object.defineProperty(fake, 'tilesLoaded', { value: opts.tilesLoaded ?? true, writable: true });
  // The mesh's height field (tests swap it with mockImplementation). The app
  // reads it down the local vertical (meshHeightAt → tileset.pick), so the
  // fake's pick answers from it at the spot the ray goes through: one surface,
  // missed by a ray that starts under it (a read under something).
  const getHeight = vi.fn((_c?: Cesium.Cartographic): number | undefined => height);
  Object.defineProperty(fake, 'getHeight', { value: getHeight });
  Object.defineProperty(fake, 'pick', {
    value: (ray: Cesium.Ray, frameState: unknown) => {
      requireFrameState(frameState);
      const c = Cesium.Cartographic.fromCartesian(ray.origin);
      const h = getHeight(c);
      return h === undefined || h > c.height ? undefined : Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, h);
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

  it('a drawn tile under the loaded one is about to refine: the rider waits on the loaded one, never sinks', () => {
    setIonToken('eyJ_test');
    // A chord within the 800 m bound of the route, 275 m under the loaded tile.
    const g: GlobeOpts = { height: -25.15, drawn: -300 };
    const { s } = scene(null, g);
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-25.15, 6);
    // Measured at the Lake Trasimeno start: level 11 drawn at 386.64 m, level
    // 12 loaded at 387.95 m and drawn the next frame. On the drawn tile the
    // rider was 1.31 m under the ground for that frame.
    g.height = 387.95;
    g.drawn = 386.64;
    expect(drawnGroundHeight(s, 12.1, 43.13, undefined, 388)).toBeCloseTo(387.95, 6);
    g.drawn = 387.95;
    expect(drawnGroundHeight(s, 12.1, 43.13, undefined, 388)).toBeCloseTo(387.95, 6);
    // Over the loaded tile the drawn one wins, however far (the start's 26 m step).
    g.height = -32.14;
    g.drawn = -5.87;
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-5.87, 6);
  });

  it('a loaded reading that is a chord leaves the drawn tile', () => {
    setIonToken('eyJ_test');
    const g: GlobeOpts = { height: -2400, drawn: -32.2 };
    const { s } = scene(null, g);
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-32.2, 6);
    // A chord over the route (a coarse tile spanning a valley) isn't the higher ground either.
    g.height = ROUTE_ELE + 900;
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-32.2, 6);
  });

  it('a drawn chord over the route leaves the loaded tile, for the rider and the camera', () => {
    setIonToken('eyJ_test');
    const { s } = scene(null, { height: -32.2, drawn: ROUTE_ELE + 900 });
    expect(drawnGroundHeight(s, lon, lat, undefined, ROUTE_ELE)).toBeCloseTo(-32.2, 6);
    // liftAboveTerrain's bound is 60 m from the rider's ground.
    const t = scene(null, { height: -32.2, drawn: -32.2 + 75 });
    const cam = Cesium.Cartesian3.fromDegrees(lon, lat, -31.7);
    expect(liftAboveTerrain(t.s, cam, -32.2, 1.5)).toBeCloseTo(1.0, 6);
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
    // …and over a finer loaded tile higher than the drawn one, drawn next frame (Trasimeno).
    const t = scene(tileset, { height: 387.95, drawn: 386.64 });
    const cam2 = Cesium.Cartesian3.fromDegrees(12.1, 43.13, 388.5);
    expect(liftAboveTerrain(t.s, cam2, 387.95, 1.5)).toBeCloseTo(0.95, 6);
  });
});

describe('overhangs: only the road is ground, not what stands over it', () => {
  // Spots 2 m apart along a path heading north from (lon0, lat0).
  const lon0 = -118.5;
  const at = (m: number) => 34 + m / 110_540;
  const HIGH = 1e9;
  /**
   * A mesh with one surface at each spot, read as tileset.pick reads it: from
   * the top, or from `under` down (nothing if the surface is over that).
   */
  const oneSurface =
    (h: (lat: number) => number | undefined) =>
    (_lon: number, lat: number, under?: number): number | undefined => {
      const v = h(lat);
      return v === undefined || under === undefined || v <= under ? v : undefined;
    };
  /** One surface: `from` up to 1 m on, `to` past it. */
  const step = (from: number, to: number) => oneSurface((lat) => (lat > at(1) ? to : from));

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

  it('within the climb allowance too, a tile refined higher under the rider is taken, not refused as a climb onto something', () => {
    // The road was taken on the terrain 12 m back (allowance 4.5 m). The tile
    // there and here refines 4.4 m higher with nothing drawn under it: more
    // than OVERHANG_MIN_M over the terrain the road was on, which no road
    // climbs to in 12 m, but the spot it was taken at rose too (roseAt).
    const f = createMeshRoadFilter();
    let refined = false;
    const readAt = oneSurface(() => (refined ? 164.4 : 160));
    expect(f.next(160, lon0, at(0), HIGH, readAt, -Infinity, 160)).toBe(160);
    refined = true;
    expect(f.next(164.4, lon0, at(12), HIGH, readAt, -Infinity, 160)).toBe(164.4);
    expect(f.status()).toBe('road');
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
    const readAt = oneSurface(lugano5k);
    expect([0, 2, 4, 4, 4].map((m) => f.next(lugano5k(at(m)), lon0, at(m), HIGH, readAt))).toEqual([326.0, 327.6, 331.2, 331.2, 331.2]);
    expect(f.status()).toBe('road');
    expect(f.next(lugano5k(at(10)), lon0, at(10), HIGH, readAt)).toBe(326.0); // and down again
    // From the path, 3.9 m up in one step (nothing under it) is ridden over;
    // 4.1 m (a low road bridge's deck) is over the road.
    const g = createMeshRoadFilter();
    g.next(100, lon0, at(0), HIGH, step(100, 103.9));
    expect(g.next(103.9, lon0, at(2), HIGH, step(100, 103.9))).toBe(103.9);
    const h = createMeshRoadFilter();
    h.next(100, lon0, at(0), HIGH, step(100, 104.1));
    expect(h.next(104.1, lon0, at(2), HIGH, step(100, 104.1))).toBe(100);
    expect(h.status()).toBe('overhang');
    expect(OVERHANG_MIN_M).toBe(4);
  });

  it('the sampler lifts a stopped rider onto the road edge, not under it', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
      lugano5k(Cesium.Math.toDegrees(c.latitude)),
    );
    // The globe there as the rider's sampler reads it (hidden by the gate, its
    // stale tiles 10 m over the path: cat-bed drill).
    const { s } = scene(tileset, { height: 336.6, show: false });
    const sampler = createGroundSampler(s);
    sampler.sample(lon0, at(0), 330, 0);
    sampler.sample(lon0, at(3), 330, GROUND_SAMPLE_INTERVAL_MS);
    // (Off the step's own edge at 4 m, where a read under it could round onto either side.)
    for (let i = 2; i < 6; i++) expect(sampler.sample(lon0, at(5), 330, i * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(331.2, 6);
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
    // 0.98 m: 9 reads besides the road spot's and one under the reading (for
    // a surface the road goes on along under it), the most there are. Read
    // 10.5 m apart, only the road spot is read again, and under the reading
    // (the plain rule takes the mound a few metres on).
    const readAt = (_lon: number, lat: number) => lugano(metres(lat));
    for (const [from, reads, status] of [
      [4990.2, 11, 'road'],
      [4989.5, 2, 'overhang'],
    ] as const) {
      let n = 0;
      const f = createMeshRoadFilter();
      f.next(lugano(from), lon0, at(from), HIGH, readAt);
      f.next(lugano(5000), lon0, at(5000), HIGH, (lon, lat) => (n++, readAt(lon, lat)));
      expect(f.status(), `from ${from} m`).toBe(status);
      expect(n, `from ${from} m`).toBe(reads);
    }
    // Under a deck 29 m up, from 9.5 m on, read every 6 m: under the deck
    // (nothing there) and the spot where the road was last taken (6 m). Its
    // edge at 12 m is out of reach of six 2 m steps, so nothing on the way is
    // read.
    const deck = (lat: number) => (lat > at(9.5) && lat < at(70) ? 189.3 : 160.2);
    const g = createMeshRoadFilter();
    const counts: number[] = [];
    for (let m = 0; m <= 78; m += 6) {
      let n = 0;
      g.next(deck(at(m)), lon0, at(m), HIGH, (_lon, lat) => (n++, deck(lat)));
      counts.push(n);
    }
    expect(counts).toEqual([0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0]);
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
    // of reach at once (only under it and the road spot are read), 9 m up
    // after two flat steps, 4.5 m up after five.
    expect(reRead(112.9)).toBe(2);
    expect(reRead(109)).toBe(2 + 2);
    expect(reRead(104.5)).toBe(2 + 5);
  });

  it('a tile refined higher under the rider: the road spot alone decides, nothing on the way is read', () => {
    let refined = false;
    let n = 0;
    const mesh = () => (refined ? -28.1 : -33.0);
    const f = createMeshRoadFilter();
    f.next(mesh(), lon0, at(0), HIGH, mesh);
    refined = true;
    expect(f.next(mesh(), lon0, at(6), HIGH, () => (n++, mesh()))).toBe(-28.1);
    // Under the reading (nothing nearer the road), the road spot's top, and
    // under it at the road (gone: the tile rose there): none on the way.
    expect(n).toBe(3);
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
    expect(sampler.ground()).toBe('globe');
    sampler.sample(lon, lat(0), 195, 0);
    expect(sampler.meshGround()).toBe(true);
    expect(sampler.ground()).toBe('mesh');
    // The I-80 deck 29 m over the towpath, nothing drawn under it: the rider
    // holds the road, and the globe (0.2 m off it) stands in for the ground,
    // without the painted road (it would paint the deck and its piers).
    deck = true;
    expect(sampler.sample(lon, lat(2), 195, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(160.4, 6);
    expect(sampler.meshGround()).toBe(false);
    // No finest terrain in this scene, only the globe's loaded tile: 'under'
    // (drawn after the usual wait), not 'standIn' (drawn at once).
    expect(sampler.ground()).toBe('under');
    deck = false;
    // A coarse tile 610 m up (the Cuyahoga start): not the ground.
    reading = 768.9;
    sampler.sample(lon, lat(4), 195, 2 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(false);
    expect(sampler.ground()).toBe('globe');
    // No tile under the rider.
    reading = undefined;
    sampler.sample(lon, lat(6), 195, 3 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(false);
    expect(sampler.ground()).toBe('globe');
    // Tileset hidden (camera over 5 km): the globe is the ground.
    reading = 160.2;
    sampler.sample(lon, lat(8), 195, 4 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(true);
    expect(sampler.ground()).toBe('mesh');
    (tileset as unknown as { show: boolean }).show = false;
    sampler.sample(lon, lat(10), 195, 5 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.meshGround()).toBe(false);
    expect(sampler.ground()).toBe('globe');
  });

  it('held under a deck with nothing drawn under it: the globe stands in only where it is near the road (up to 1.5 m over it, 2.5 m under it)', async () => {
    setIonToken('eyJ_test');
    for (const [globeH, standsIn] of [
      [160.2 + GLOBE_STANDIN_M - 0.01, true],
      [160.2 + 1.4, true],
      [160.2 - GLOBE_STANDIN_UNDER_M + 0.01, true],
      // The Cuyahoga towpath held under crowns 1.3–2 m over the terrain
      // (3.11–3.16, 4.08–4.10, 4.70–4.73 km): the rider sinks onto it.
      [160.2 - 1.7, true],
      [160.2 - 2.0, true],
      // 4.73 km: 1.97 m under, with room for the next sample.
      [160.2 - 2.2, true],
      // 26 m over the street (the Lugano shore): it would lift the rider.
      [186.2, false],
      [160.2 + GLOBE_STANDIN_M + 0.2, false],
      [160.2 + 1.6, false],
      [160.2 - GLOBE_STANDIN_UNDER_M - 0.2, false],
      [160.2 - 2.7, false],
      // A hidden globe's stale tile under the Lugano–Melide slab (7.59 km).
      [160.2 - 4.4, false],
    ] as const) {
      let deck = false;
      const { tileset } = await photoreal(undefined);
      (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
        deck && Cesium.Math.toDegrees(c.latitude) > lat(1) ? 215.3 : 160.2,
      );
      const { s, globe } = scene(tileset, { height: globeH, show: false });
      const sampler = createGroundSampler(s);
      sampler.sample(lon, lat(0), 160, 0);
      expect(sampler.meshGround()).toBe(true);
      deck = true;
      // Hidden, the globe's height isn't drawn: the rider holds the road.
      expect(sampler.sample(lon, lat(2), 160, GROUND_SAMPLE_INTERVAL_MS), `globe ${globeH}`).toBeCloseTo(160.2, 6);
      expect(sampler.meshGround(), `globe ${globeH}`).toBe(!standsIn);
      // No finest terrain in this scene: judged by the globe's loaded tile,
      // so drawn after the usual wait ('under'), not at once ('standIn').
      expect(sampler.ground(), `globe ${globeH}`).toBe(standsIn ? 'under' : 'mesh');
      // Drawn (the gate shows it a second later), it is the ground where it
      // stands in: the rider on it, not floating over it on the road held.
      globe.show = true;
      expect(sampler.sample(lon, lat(4), 160, 2 * GROUND_SAMPLE_INTERVAL_MS), `globe ${globeH} drawn`).toBeCloseTo(
        standsIn ? globeH : Math.max(160.2, globeH),
        6,
      );
    }
  });

  // Lugano–Melide 7.57–7.63 km (t_6a69c279, cat-bed): the route runs on the
  // shore road (321.5 m) under the railway and A2 bridges, drawn as one slab
  // 327.8 m with nothing under it. Ridden from the start, the hidden globe
  // still has the coarse tile it last loaded there: 317.1 m in one run, 323.6
  // in another. Its finest terrain (what it draws once shown) is 321.26 m.
  const slab = async (stale: number) => {
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
      Cesium.Math.toDegrees(c.latitude) > lat(1) ? 327.8 : 321.48,
    );
    return scene(tileset, { height: stale, show: false });
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('held under a slab, a hidden globe 4.4 m under the road but its finest 0.2 m: the globe stands in once the finest lands (Lugano–Melide 7.59 km)', async () => {
    setIonToken('eyJ_test');
    for (const stale of [317.1, 323.55]) {
      const { s, globe } = await slab(stale);
      const batches: [number, number][][] = [];
      const finest = createFinestTerrain(async (pts) => {
        batches.push(pts);
        return pts.map(() => 321.26);
      });
      const sampler = createGroundSampler(s, finest);
      sampler.sample(lon, lat(0), 322, 0);
      expect(sampler.ground()).toBe('mesh');
      expect(batches).toHaveLength(0);
      // Onto the slab: held under it, nothing drawn under it. Until the
      // finest lands the stale tile decides: hidden, a black void (as before).
      expect(sampler.sample(lon, lat(2), 322, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(321.48, 6);
      expect(sampler.ground(), `stale ${stale}`).toBe('mesh');
      // Fetched here and ahead (north, the way the rider moves).
      expect(batches).toHaveLength(1);
      expect(batches[0][0][1]).toBeCloseTo(lat(2), 9);
      expect(batches[0][batches[0].length - 1][1]).toBeGreaterThan(lat(30));
      await flush();
      // The globe stands in; hidden still, the rider holds the road.
      expect(sampler.sample(lon, lat(4), 322, 2 * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(321.48, 6);
      expect(sampler.ground(), `stale ${stale}`).toBe('standIn');
      expect(sampler.meshGround()).toBe(false);
      // Drawn (the gate a second later), refined: the rider on it.
      globe.show = true;
      globe.getHeight.mockReturnValue(321.3);
      expect(sampler.sample(lon, lat(6), 322, 3 * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(321.3, 6);
      expect(sampler.ground()).toBe('standIn');
      // The batch covers the next spots: no second fetch.
      expect(batches).toHaveLength(1);
    }
  });

  it('held under the slab: the finest under the road held is drawn at once, over it after the usual wait (it buries the street around it)', async () => {
    setIonToken('eyJ_test');
    // The road held 321.48. Cuyahoga 4.60 km: the finest 0.1 m over the
    // towpath, drawn at once, covered the towpath ahead for a second.
    for (const [finestH, kind, atOnce] of [
      [321.38, 'standIn', true],
      [321.47, 'standIn', true],
      [321.58, 'under', false],
      [321.48 + GLOBE_STANDIN_M - 0.1, 'under', false],
    ] as const) {
      const { s, globe } = await slab(321.3);
      const sampler = createGroundSampler(s, createFinestTerrain(async (pts) => pts.map(() => finestH)));
      const gate = new GroundGate();
      let t = 0;
      const frames = (ms: number) => {
        for (let k = 0; k < ms / 16; k++) globe.show = gate.update((t += 16), true, sampler.ground()).globe;
      };
      sampler.sample(lon, lat(0), 322, t);
      frames(1_000);
      expect(globe.show, `${finestH}`).toBe(false);
      // Onto the slab: the finest lands with the first sample under it.
      sampler.sample(lon, lat(2), 322, t);
      await flush();
      frames(256);
      sampler.sample(lon, lat(4), 322, t);
      expect(sampler.ground(), `${finestH}`).toBe(kind);
      frames(32);
      expect(globe.show, `${finestH}`).toBe(atOnce);
      // Over the road held it still stands in, after the usual wait.
      for (let m = 6; m <= 12; m += 2) {
        frames(256);
        sampler.sample(lon, lat(m), 322, t);
      }
      frames(256);
      expect(globe.show, `${finestH}`).toBe(true);
    }
  });

  it('a jump back under the slab, its finest fetched on the way through: the globe after the usual wait, not at once (Ride again)', async () => {
    setIonToken('eyJ_test');
    // The slab from 1 to 40 m, the shore road on either side.
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) => {
      const la = Cesium.Math.toDegrees(c.latitude);
      return la > lat(1) && la < lat(40) ? 327.8 : 321.48;
    });
    const { s, globe } = scene(tileset, { height: 321.26, show: false });
    const sampler = createGroundSampler(s, createFinestTerrain(async (pts) => pts.map(() => 321.26)));
    const gate = new GroundGate();
    let t = 0;
    const frames = (ms: number) => {
      for (let k = 0; k < ms / 16; k++) globe.show = gate.update((t += 16), true, sampler.ground()).globe;
    };
    const ride = async (from: number, to: number) => {
      for (let m = from; m <= to; m += 4) {
        sampler.sample(lon, lat(m), 322, t);
        frames(256);
        await flush();
      }
    };
    // Rolled in from the road: held under the slab, the globe stands in at
    // once (the finest lands on the first sample under it)…
    await ride(-8, 20);
    expect(sampler.ground()).toBe('standIn');
    expect(globe.show).toBe(true);
    // …and on along the road, 160 m past it: the mesh road, the globe hidden.
    await ride(44, 200);
    expect(sampler.ground()).toBe('mesh');
    expect(globe.show).toBe(false);
    // Ride again back to 10 m: under the slab again, its finest known from
    // the way through, but 190 m from the road held: no road to stand in for.
    sampler.sample(lon, lat(10), 322, t);
    expect(sampler.ground()).toBe('under');
    frames(GLOBE_SHOW_AFTER_MS - 50);
    expect(globe.show).toBe(false);
    frames(100);
    expect(globe.show).toBe(true);
  });

  it('the finest decides both ways: a stale tile near the road over a finest 26 m up (the Lugano shore) does not stand in, and the globe is never drawn', async () => {
    setIonToken('eyJ_test');
    const { s, globe } = await slab(321.6);
    let land: (() => void) | undefined;
    const finest = createFinestTerrain((pts) => new Promise((done) => (land = () => done(pts.map(() => 347.5)))));
    const sampler = createGroundSampler(s, finest);
    const gate = new GroundGate();
    let t = 0;
    const frames = (ms: number) => {
      for (let k = 0; k < ms / 16; k++) globe.show = gate.update((t += 16), true, sampler.ground()).globe;
    };
    sampler.sample(lon, lat(0), 322, 0);
    frames(1_000);
    expect(globe.show).toBe(false);
    sampler.sample(lon, lat(2), 322, t);
    // Before the finest lands, the stale tile 0.1 m off the road stands in,
    // but only as 'under': the globe is drawn after the usual wait…
    expect(sampler.ground()).toBe('under');
    frames(400);
    expect(globe.show).toBe(false);
    // …and the finest (26 m up: it would bury the street) lands first.
    land?.();
    await flush();
    expect(sampler.sample(lon, lat(4), 322, t)).toBeCloseTo(321.48, 6);
    expect(sampler.ground()).toBe('mesh');
    frames(2_000);
    expect(globe.show).toBe(false);
  });

  it('held under crowns 1.3–1.7 m over the finest terrain (Cuyahoga 3.11–3.16 km): the globe stands in all the way, is drawn at once, and the rider stands on it', async () => {
    setIonToken('eyJ_test');
    // cat-bed roll (t_c92a4576): the towpath taken at 162.92 m, then crowns
    // 180–190 m with nothing drawn under them for 60 m. The finest terrain
    // under them alternates 1.32 / 1.72 m under the road held: with a 1.5 m
    // bound both ways the stand-in flipped every sample, the gate's show
    // wait never ran out, and the rider rode over a black void.
    const road = 162.92;
    const finestAt = (m: number) => (Math.round(m / 4) % 2 ? 161.2 : 161.6);
    const metresOf = (la: number) => (la - 45.98) * 110_540;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) => {
      const m = metresOf(Cesium.Math.toDegrees(c.latitude));
      return m < 2 ? road : m < 60 ? 180 + (Math.round(m) % 9) : 163.74;
    });
    // Hidden, the globe holds a stale coarse tile far under the road.
    const { s, globe } = scene(tileset, { height: 158.0, show: false });
    globe.getHeight.mockImplementation((c: Cesium.Cartographic) =>
      globe.show ? finestAt(metresOf(Cesium.Math.toDegrees(c.latitude))) : 158.0,
    );
    const finest = createFinestTerrain(async (pts) => pts.map(([, la]) => finestAt(metresOf(la))));
    const sampler = createGroundSampler(s, finest);
    const gate = new GroundGate();
    let t = 0;
    const rows: { m: number; h: number | undefined; kind: string; shown: boolean }[] = [];
    // 30 km/h: 4 m a sample, 480 ms apart, the gate run every frame between.
    for (let m = 0; m <= 72; m += 4) {
      // Drawn, the globe is still streaming tiles on every other sample.
      globe.tilesLoaded = !(globe.show && m % 8 === 0);
      const h = sampler.sample(lon, lat(m), 162, t);
      rows.push({ m, h, kind: sampler.ground(), shown: globe.show });
      for (let k = 0; k < 29; k++) {
        t += 16.5;
        globe.show = gate.update(t, true, sampler.ground()).globe;
      }
      t = Math.round(t / 480) * 480 + 480;
      await flush();
    }
    // The first spot under the crowns waits for the finest (the stale tile is
    // 4.9 m under the road); from then on the globe stands in at every spot
    // ('under' where a new batch is on its way: drawn all the same).
    expect(rows.find((x) => x.m === 8)?.kind).toBe('standIn');
    for (const r of rows.filter((x) => x.m >= 8 && x.m < 60)) expect(['standIn', 'under'], `${r.m} m`).toContain(r.kind);
    // Drawn from the next frame on (the rider is over nothing drawn until it
    // is), not a second later, and kept.
    for (const r of rows.filter((x) => x.m >= 12 && x.m < 60)) expect(r.shown, `${r.m} m`).toBe(true);
    // On the drawn globe, 1.3–1.7 m under the road held, not over a void, and
    // not back up on the road held while the globe streams.
    for (const r of rows.filter((x) => x.m >= 24 && x.m < 60)) expect(r.h, `${r.m} m`).toBeCloseTo(finestAt(r.m), 6);
    // Out from under the crowns: the mesh road again.
    const out = rows.find((x) => x.m === 64)!;
    expect(out.kind).toBe('mesh');
    expect(out.h).toBeCloseTo(163.74, 6);
  });

  it('only a stand-in puts the rider on the streaming globe: with no mesh tile under it the rider holds the road (as before)', async () => {
    setIonToken('eyJ_test');
    // Held at 160.2, then no mesh tile: the globe is the ground once drawn,
    // but while it streams (coarse tiles of its own) the rider keeps the
    // road, even with the terrain 1.7 m under it.
    let reading: number | undefined = 160.2;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => reading);
    const { s, globe } = scene(tileset, { height: 158.5 });
    const sampler = createGroundSampler(s, createFinestTerrain(async (pts) => pts.map(() => 158.5)));
    expect(sampler.sample(lon, lat(0), 160, 0)).toBeCloseTo(160.2, 6);
    expect(sampler.ground()).toBe('mesh');
    reading = undefined;
    globe.tilesLoaded = false;
    expect(sampler.sample(lon, lat(2), 160, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(160.2, 6);
    expect(sampler.ground()).toBe('globe');
  });

  it("the finest is only fetched while held under something, and comes from the scene's terrain provider", async () => {
    setIonToken('eyJ_test');
    // A terrain provider as sampleTerrainMostDetailed reads it: one level, the
    // finest tile drawing 321.26 m everywhere.
    const tiles: string[] = [];
    const provider = {
      availability: { computeMaximumLevelAtPosition: () => 14 },
      tilingScheme: new Cesium.GeographicTilingScheme(),
      requestTileGeometry: (x: number, y: number, level: number) => {
        tiles.push(`${level}/${x}/${y}`);
        return Promise.resolve({ interpolateHeight: () => 321.26 });
      },
      loadTileDataAvailability: () => undefined,
    };
    const { tileset } = await photoreal(undefined);
    let onSlab = false;
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
      onSlab && Cesium.Math.toDegrees(c.latitude) > lat(9) ? 327.8 : 321.48,
    );
    const { s } = scene(tileset, { height: 317.1, show: false }, provider);
    const sampler = createGroundSampler(s);
    for (let i = 0; i < 4; i++) sampler.sample(lon, lat(2 * i), 322, i * GROUND_SAMPLE_INTERVAL_MS);
    await flush();
    // On the mesh road: nothing fetched.
    expect(tiles).toHaveLength(0);
    onSlab = true;
    sampler.sample(lon, lat(10), 322, 4 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.ground()).toBe('mesh');
    await flush();
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((t) => t.startsWith('14/'))).toBe(true);
    sampler.sample(lon, lat(12), 322, 5 * GROUND_SAMPLE_INTERVAL_MS);
    expect(sampler.ground()).toBe('standIn');
  });

  it('a new terrain provider on the scene: heights fetched from the old one are not used', async () => {
    setIonToken('eyJ_test');
    const provider = (h: number) => ({
      availability: { computeMaximumLevelAtPosition: () => 14 },
      tilingScheme: new Cesium.GeographicTilingScheme(),
      requestTileGeometry: () => Promise.resolve({ interpolateHeight: () => h }),
      loadTileDataAvailability: () => undefined,
    });
    const s = { terrainProvider: provider(321.26) } as unknown as Cesium.Scene;
    const finest = sceneFinestTerrain(s);
    finest.want(lon, lat(0), NaN, NaN, 0);
    await flush();
    expect(finest.near(lon, lat(0))).toBeCloseTo(321.26, 6);
    (s as unknown as { terrainProvider: object }).terrainProvider = provider(347.5);
    expect(finest.near(lon, lat(0))).toBeUndefined();
    finest.want(lon, lat(0), NaN, NaN, 10);
    await flush();
    expect(finest.near(lon, lat(0))).toBeCloseTo(347.5, 6);
    // The flat globe has no finest terrain.
    (s as unknown as { terrainProvider: object }).terrainProvider = new Cesium.EllipsoidTerrainProvider();
    finest.want(lon, lat(0), NaN, NaN, 20);
    expect(finest.near(lon, lat(0))).toBeUndefined();
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
    f.next(320, lon, lat(2), 400, (_lon, l, under) => (l > lat(1) ? (under === undefined ? 320 : undefined) : 300));
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

describe('under what stands over the road: the rider rides the road under it (t_148e9796)', () => {
  // Drill profiles from cat-bed: every up-facing surface down the vertical,
  // top first, as the rider's tiles drew them, with the globe there (World
  // Terrain as loaded) and the road (the surface that runs on; interpolated
  // where none is drawn). Each row: metres along, globe, road, surfaces….
  type Row = number[];
  // Cuyahoga towpath 2930–3062 m: crowns 9–25 m over the towpath, the I-80 deck (2996–3014 m) with nothing drawn under it.
  const cuyahoga3k: Row[] = [
    [2930, 158.77, 160.96, 170.22, 160.96],
    [2932, 158.82, 161.43, 171.99, 161.43],
    [2934, 158.88, 161.43, 174.06],
    [2936, 158.94, 160.9, 173.46, 160.9],
    [2938, 159, 160.92, 173.75, 160.92],
    [2940, 159.05, 161.62, 173.65, 161.62],
    [2942, 159.11, 161.71, 173.95],
    [2944, 159.18, 161.34, 173.1, 162.2],
    [2946, 159.25, 161.47, 174.87, 161.47],
    [2948, 159.32, 161.24, 177.09, 164.25, 161.24],
    [2950, 159.39, 161.85, 182.32, 177.56, 161.85],
    [2952, 159.46, 161.42, 182.99, 177.96, 161.42],
    [2954, 159.53, 161.06, 183, 177.93, 161.06],
    [2956, 159.61, 161.01, 176.58, 161.01],
    [2958, 159.68, 160.96, 176.42, 160.96],
    [2960, 159.75, 160.89, 175.8, 160.89],
    [2962, 159.82, 160.94, 160.94],
    [2964, 159.89, 160.99, 185.27, 179.79, 160.99],
    [2966, 159.96, 160.97, 185.39, 160.97],
    [2968, 160.03, 161.02, 184.77, 161.02],
    [2970, 160.11, 161.09, 184.9, 170.49, 161.09],
    [2972, 160.18, 161.33, 184.63, 161.77],
    [2974, 160.25, 161.34, 186.55, 172.39],
    [2976, 160.32, 161.34, 186.55],
    [2978, 160.39, 161.34, 185.56],
    [2980, 160.46, 161.35, 172.98],
    [2982, 160.53, 161.35, 173.93],
    [2984, 160.61, 161.35, 175.14],
    [2986, 160.68, 161.36, 175],
    [2988, 160.75, 161.36, 176.97],
    [2990, 160.82, 161.37, 175.96],
    [2992, 160.89, 161.37, 173.07],
    [2994, 160.96, 161.37, 170.91],
    [2996, 161.03, 161.38, 180.68, 170.82],
    [2998, 161.11, 161.38, 182.98, 169.54],
    [3000, 161.15, 161.38, 186.54],
    [3002, 161.16, 161.39, 187.08],
    [3004, 161.16, 161.39, 186.55, 182.66],
    [3006, 161.16, 161.39, 185.22],
    [3008, 161.16, 161.4, 189.48, 185.13],
    [3010, 161.17, 161.4, 184],
    [3012, 161.17, 161.41, 182.46, 171.72],
    [3014, 161.17, 161.41, 184.78, 181.61, 171.15],
    [3016, 161.17, 161.41, 177.8, 169.6],
    [3018, 161.18, 161.31, 178.41, 169.82, 161.31],
    [3020, 161.18, 161.02, 174.13, 165.24, 161.02],
    [3022, 161.18, 161.04, 161.04],
    [3024, 161.18, 161.18, 168.16, 161.18],
    [3026, 161.19, 161.41, 168.11],
    [3028, 161.19, 161.43, 172.41, 167.41],
    [3030, 161.19, 161.45, 167.44],
    [3032, 161.19, 161.46, 166.7, 161.92],
    [3034, 161.2, 161.03, 161.03],
    [3036, 161.2, 161.04, 181.03, 161.04],
    [3038, 161.21, 161.04, 169.02, 161.04],
    [3040, 161.23, 161.06, 161.06],
    [3042, 161.26, 161.14, 161.14],
    [3044, 161.28, 161.15, 161.15],
    [3046, 161.3, 161.11, 161.11],
    [3048, 161.32, 161.2, 161.2],
    [3050, 161.35, 161.14, 161.14],
    [3052, 161.37, 161.21, 172.32, 161.21],
    [3054, 161.39, 161.29, 173.46, 161.29],
    [3056, 161.41, 161.29, 183.78, 173.81, 161.29],
    [3058, 161.43, 161.28, 187.44, 177.03, 161.28],
    [3060, 161.46, 161.21, 187.07, 178.86, 176.43, 161.21],
    [3062, 161.48, 161.04, 187.31, 175.05, 161.04],
  ];

  // Cuyahoga towpath 4980–5040 m: a crown 12 m up, then a canopy 2.3–3 m over the towpath (no bridge in OSM); the globe 2.5 m over it.
  const cuyahoga5k: Row[] = [
    [4980, 164.81, 162.11, 162.11],
    [4982, 164.8, 162.13, 162.13],
    [4984, 164.8, 162.16, 173.96, 162.16],
    [4986, 164.8, 162.18, 174.13, 162.18],
    [4988, 164.79, 162.2, 174.31, 162.2],
    [4990, 164.79, 162.22, 175.07, 174.49, 162.22],
    [4992, 164.79, 162.24, 174.22, 162.24],
    [4994, 164.78, 162.26, 172.47, 162.26],
    [4996, 164.78, 162.28, 170.72, 162.28],
    [4998, 164.77, 162.31, 168.98, 162.31],
    [5000, 164.77, 162.32, 167.31, 162.32],
    [5002, 164.77, 162.33, 162.33],
    [5004, 164.77, 162.35, 165.29, 162.35],
    [5006, 164.77, 162.36, 165.26, 162.36],
    [5008, 164.77, 162.38, 165.22, 162.38],
    [5010, 164.77, 162.39, 165.19, 162.39],
    [5012, 164.76, 162.4, 165.16, 162.4],
    [5014, 164.76, 162.42, 165.12, 162.42],
    [5016, 164.76, 162.43, 165.09, 162.43],
    [5018, 164.76, 162.44, 165.06, 162.44],
    [5020, 164.76, 162.46, 165.02, 162.46],
    [5022, 164.76, 162.47, 164.99, 162.47],
    [5024, 164.75, 162.49, 164.96, 162.49],
    [5026, 164.75, 162.5, 164.92, 162.5],
    [5028, 164.75, 162.5, 164.89, 162.5],
    [5030, 164.75, 162.46, 164.86, 162.46],
    [5032, 164.75, 162.45, 164.82, 162.45],
    [5034, 164.75, 162.44, 164.79, 162.44],
    [5036, 164.74, 162.43, 164.76, 162.43],
    [5038, 164.74, 162.42, 164.72, 162.42],
    [5040, 164.74, 162.41, 164.69, 162.41],
  ];

  // Chengdu 1203–1228 m, every metre: the ramp onto the bridge, up to 0.58 m per m, 5 m over the terrain at its top.
  const chengduRamp: Row[] = [
    [1203, 448.36, 444.88, 444.88],
    [1204, 448.39, 444.99, 444.99],
    [1205, 448.43, 445.22, 445.22],
    [1206, 448.46, 445.5, 445.5],
    [1207, 448.49, 445.8, 445.8],
    [1208, 448.5, 446.08, 446.08],
    [1209, 448.52, 446.37, 446.37],
    [1210, 448.53, 446.65, 446.65],
    [1211, 448.54, 446.93, 446.93],
    [1212, 448.56, 447.22, 447.22],
    [1213, 448.57, 447.71, 447.71],
    [1214, 448.58, 448.28, 448.28],
    [1215, 448.6, 448.86, 448.86],
    [1216, 448.61, 449.44, 449.44],
    [1217, 448.68, 450.02, 450.02],
    [1218, 448.77, 450.61, 450.61],
    [1219, 448.86, 451.19, 451.19],
    [1220, 448.95, 451.76, 451.76],
    [1221, 449.04, 452.26, 452.26],
    [1222, 449.13, 452.68, 452.68],
    [1223, 449.22, 453.07, 453.07],
    [1224, 449.3, 453.46, 453.46],
    [1225, 449.39, 453.85, 453.85],
    [1226, 449.48, 454.17, 454.17],
    [1227, 449.57, 454.48, 454.48],
    [1228, 449.66, 454.79, 454.79],
  ];

  // Lugano–Melide 6940–7040 m: the causeway, one smooth deck 3–10 m over the lake (the globe).
  const melide: Row[] = [
    [6940, 317.23, 327.49, 327.49],
    [6942, 317.23, 327.49, 327.49],
    [6944, 317.23, 327.49, 327.49],
    [6946, 317.23, 327.48, 327.48],
    [6948, 317.23, 327.45, 327.45],
    [6950, 317.23, 327.44, 327.44],
    [6952, 317.23, 327.41, 327.41],
    [6954, 317.23, 327.36, 327.36],
    [6956, 317.23, 327.31, 327.31],
    [6958, 317.23, 327.26, 327.26],
    [6960, 317.23, 327.18, 327.18],
    [6962, 317.23, 327.09, 327.09],
    [6964, 317.23, 327, 327],
    [6966, 317.23, 326.92, 326.92],
    [6968, 317.22, 326.84, 326.84],
    [6970, 317.22, 326.76, 326.76],
    [6972, 317.22, 326.68, 326.68],
    [6974, 317.22, 326.6, 326.6],
    [6976, 317.22, 326.52, 326.52],
    [6978, 317.22, 326.38, 326.38],
    [6980, 317.22, 326.19, 326.19],
    [6982, 317.22, 326, 326],
    [6984, 317.22, 325.88, 325.88],
    [6986, 317.22, 325.69, 325.69],
    [6988, 317.23, 325.49, 325.49],
    [6990, 317.25, 325.27, 325.27],
    [6992, 317.28, 325.1, 325.1],
    [6994, 317.3, 324.85, 324.85],
    [6996, 317.32, 324.82, 324.82],
    [6998, 317.35, 324.58, 324.58],
    [7000, 317.37, 324.34, 324.34],
    [7002, 317.4, 324.1, 324.1],
    [7004, 317.42, 323.85, 323.85],
    [7006, 317.45, 323.63, 323.63],
    [7008, 317.47, 323.41, 323.41],
    [7010, 317.5, 323.2, 323.2],
    [7012, 317.52, 323, 323],
    [7014, 317.55, 322.82, 322.82],
    [7016, 317.57, 322.64, 322.64],
    [7018, 317.59, 322.46, 322.46],
    [7020, 317.62, 322.29, 322.29],
    [7022, 317.64, 322.13, 322.13],
    [7024, 317.67, 321.98, 321.98],
    [7026, 317.69, 321.85, 321.85],
    [7028, 317.72, 321.71, 321.71],
    [7030, 317.74, 321.6, 321.6],
    [7032, 317.77, 321.49, 321.49],
    [7034, 317.79, 321.38, 321.38],
    [7036, 317.82, 321.3, 321.3],
    [7038, 317.84, 321.21, 321.21],
    [7040, 317.87, 321.13, 321.13],
  ];

  // Lugano–Melide 4920–4970 m, every metre: the road onto the embankment (up to
  // 1.3 m per m, 8 m up), and under it a second layer of the same tile, flat at
  // 327.5 m, with nothing facing down between (drilled with back-face culling
  // off). The globe (coarse World Terrain on the steep shore) is 9–11 m over both.
  const lugano4900: Row[] = [
    [4920, 338.41, 328.76, 328.76, 327.72],
    [4921, 338.35, 328.7, 328.7, 327.7],
    [4922, 338.33, 328.64, 328.64, 327.68],
    [4923, 338.31, 328.61, 328.61, 327.67],
    [4924, 338.3, 328.6, 328.6, 327.67],
    [4925, 338.28, 328.58, 328.58, 327.66],
    [4926, 338.26, 328.55, 328.55, 327.66],
    [4927, 338.23, 328.53, 328.53, 327.65],
    [4928, 338.19, 328.53, 328.53, 327.64],
    [4929, 338.15, 328.53, 328.53, 327.63],
    [4930, 338.12, 328.52, 328.52, 327.62],
    [4931, 338.08, 328.52, 328.52, 327.61],
    [4932, 338.05, 328.52, 328.52, 327.6],
    [4933, 338.01, 328.92, 328.92, 327.59],
    [4934, 337.97, 330, 330, 327.58],
    [4935, 337.9, 331.19, 331.19, 327.56],
    [4936, 337.83, 332.53, 332.53, 327.55],
    [4937, 337.76, 333.95, 333.95, 327.53],
    [4938, 337.69, 335.22, 335.22, 327.51],
    [4939, 337.62, 335.6, 335.6, 327.5],
    [4940, 337.55, 335.74, 335.74, 327.49],
    [4941, 337.48, 335.87, 335.87, 327.47],
    [4942, 337.41, 336.19, 336.19, 327.46],
    [4943, 337.34, 335.95, 335.95, 327.39],
    [4944, 337.28, 335.6, 335.6, 327.32],
    [4945, 337.21, 335.26, 335.26, 327.29],
    [4946, 337.14, 334.93, 334.93, 327.28],
    [4947, 337.07, 334.57, 334.57, 334.48, 327.27],
    [4948, 337, 334.43, 334.43, 327.25],
    [4949, 336.93, 334.36, 334.36, 327.25],
    [4950, 336.86, 334.08, 334.08, 327.23],
    [4951, 336.79, 333.55, 333.55, 327.22],
    [4952, 336.72, 332.88, 332.88, 327.21],
    [4953, 336.65, 332.24, 332.24, 327.2],
    [4954, 336.58, 331.61, 331.61, 327.19],
    [4955, 336.53, 330.98, 330.98, 327.18],
    [4956, 336.53, 330.54, 330.54, 327.15],
    [4957, 336.53, 330.11, 330.11, 327.12],
    [4958, 336.53, 329.67, 329.67, 327.09],
    [4959, 336.54, 329.23, 329.23, 327.06],
    [4960, 336.54, 328.8, 328.8, 327.02],
    [4961, 336.54, 328.36, 328.36, 326.99],
    [4962, 336.54, 327.92, 327.92, 326.95],
    [4963, 336.54, 327.88, 327.88, 326.78],
    [4964, 336.54, 328.03, 328.03, 326.76],
    [4965, 336.54, 328.18, 328.18, 326.74],
    [4966, 336.55, 328.33, 328.33, 326.73],
    [4967, 336.55, 328.48, 328.48, 326.71],
    [4968, 336.55, 328.63, 328.63, 326.67],
    [4969, 336.55, 328.77, 328.77, 326.61],
    [4970, 336.55, 328.92, 328.92, 326.55],
  ];

  const lonC = -81.5;
  const atC = (m: number) => 41 + m / 110_540;
  const metresC = (lat: number) => (lat - 41) * 110_540;

  interface Read {
    m: number;
    /** What the rider stands on: the filter's road, else the globe. */
    shown: number;
    road: number;
    globe: number;
    /** The road is drawn here (one of the surfaces). */
    drawn: boolean;
    status: string;
  }
  /**
   * The filter rolled along `rows` (`step` m apart) read every `spacing` m
   * from `phase` on, as the sampler calls it: from a road read just before
   * the first row, or from nothing (a jump: the probes, Ride again).
   */
  function ride(rows: Row[], step: number, spacing: number, phase: number, from: 'road' | 'jump'): Read[] {
    const m0 = rows[0][0];
    const row = (m: number) => rows[Math.max(0, Math.min(rows.length - 1, Math.round((m - m0) / step)))];
    const readAt = (_lon: number, lat: number, under?: number) => {
      const hits = row(metresC(lat)).slice(3);
      return under === undefined ? hits[0] : hits.find((h) => h <= under);
    };
    const f = createMeshRoadFilter();
    if (from === 'road') f.next(rows[0][2], lonC, atC(m0 - step), 1e9, () => rows[0][2], -Infinity, rows[0][2]);
    const out: Read[] = [];
    for (let m = m0 + phase; m <= rows[rows.length - 1][0]; m += spacing) {
      const [, globe, road, ...hits] = row(m);
      const got = f.next(hits[0], lonC, atC(m), 1e9, readAt, -Infinity, globe);
      out.push({ m, shown: got ?? globe, road, globe, drawn: hits.some((h) => Math.abs(h - road) < 0.01), status: f.status() });
    }
    return out;
  }
  /** Every spacing 2–8 m the rows allow, at every phase. */
  function everyRide(rows: Row[], step: number, from: 'road' | 'jump'): Read[][] {
    const out: Read[][] = [];
    for (let s = Math.max(2, step); s <= 8; s += step) for (let o = 0; o < s; o += step) out.push(ride(rows, step, s, o, from));
    return out;
  }
  const worst = (reads: Read[], pick: (r: Read) => boolean = () => true) =>
    reads.filter(pick).reduce((w, r) => (Math.abs(r.shown - r.road) > Math.abs(w) ? r.shown - r.road : w), 0);

  it('Cuyahoga 3 km: under the crowns and the I-80 deck the rider rides the towpath, never what stands over it', () => {
    for (const reads of everyRide(cuyahoga3k, 2, 'road')) {
      const at = `read ${reads[1].m - reads[0].m} m apart from ${reads[0].m} m`;
      // Where the towpath is drawn, on it; where it isn't (under the deck,
      // under a crown with nothing under it), the road held, within 1 m.
      expect(Math.abs(worst(reads, (r) => r.drawn)), at).toBeLessThanOrEqual(0.3);
      expect(Math.abs(worst(reads)), at).toBeLessThan(1);
    }
  });

  it('Cuyahoga 3 km from a jump: never on a crown or the deck; on the globe until the towpath is read, then on it', () => {
    for (const reads of everyRide(cuyahoga3k, 2, 'jump')) {
      const at = `read ${reads[1].m - reads[0].m} m apart from ${reads[0].m} m`;
      for (const r of reads) expect(r.shown - r.road, `${at}, at ${r.m} m`).toBeLessThan(1);
      const first = reads.findIndex((r) => r.status === 'road');
      expect(first, at).toBeGreaterThanOrEqual(0);
      expect(Math.abs(worst(reads.slice(first), (r) => r.drawn)), at).toBeLessThanOrEqual(0.3);
    }
  });

  it('Cuyahoga 5 km: a crown and a low canopy over the towpath are passed under, rolled in or jumped in', () => {
    for (const from of ['road', 'jump'] as const) {
      for (const reads of everyRide(cuyahoga5k, 2, from)) expect(Math.abs(worst(reads)), `${from} ${reads[0].m}`).toBeLessThanOrEqual(0.3);
    }
  });

  it('the ramp onto the Chengdu bridge (0.58 m per m, 5 m over the terrain) is ridden, read 2–8 m apart', () => {
    for (const from of ['road', 'jump'] as const) {
      for (const reads of everyRide(chengduRamp, 1, from)) expect(Math.abs(worst(reads)), `${from} ${reads[0].m}`).toBeLessThanOrEqual(0.3);
    }
  });

  it('the Melide causeway from a jump: on the lake (the globe) until DECK_RUN_M of smooth deck is read, then on the deck', () => {
    for (const reads of everyRide(melide, 2, 'jump')) {
      const at = `read ${reads[1].m - reads[0].m} m apart from ${reads[0].m} m`;
      const first = reads.findIndex((r) => r.status === 'road');
      // From the first deck read, DECK_RUN_M of it before it is the road.
      expect(reads[first].m - reads[0].m, at).toBeGreaterThanOrEqual(DECK_RUN_M);
      expect(reads[first].m - reads[0].m, at).toBeLessThanOrEqual(DECK_RUN_M + 8);
      for (const r of reads.slice(0, first)) expect(r.shown, `${at}, at ${r.m} m`).toBe(r.globe);
      expect(Math.abs(worst(reads.slice(first))), at).toBeLessThanOrEqual(0.3);
    }
    // Rolled on from the shore, the deck is the road throughout.
    for (const reads of everyRide(melide, 2, 'road')) expect(Math.abs(worst(reads)), `road ${reads[0].m}`).toBeLessThanOrEqual(0.3);
  });
  it('Lugano–Melide 4.93 km: the rider rides the road onto the embankment, never the layer under it (read 2–8 m apart, rolled in or jumped in)', () => {
    // Taken as "the road under something" (the first look-under did, from
    // 4934 m on), that layer put the rider up to 8.7 m inside the embankment:
    // on cat-bed the camera saw no sky and the wheels 2.27 m inside the mesh.
    for (const from of ['road', 'jump'] as const) {
      for (const reads of everyRide(lugano4900, 1, from)) {
        expect(Math.abs(worst(reads)), `${from} read ${reads[1].m - reads[0].m} m apart from ${reads[0].m} m`).toBeLessThanOrEqual(0.3);
      }
    }
  });

  /**
   * A photoreal tileset with a stack of up-facing surfaces under each spot
   * (top first, by metres along). Its pick answers as Cesium3DTileset.pick
   * does down one stack: the highest surface at or under the ray's origin, so
   * a ray started under a crown reaches the ground under it.
   */
  async function stacked(column: (m: number) => number[], onPick?: () => void) {
    const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
    Object.defineProperty(fake, 'show', { value: true, writable: true });
    Object.defineProperty(fake, 'tilesLoaded', { value: true, writable: true });
    const stack = (c: Cesium.Cartographic) => column(metresC(Cesium.Math.toDegrees(c.latitude)));
    Object.defineProperty(fake, 'getHeight', { value: (c: Cesium.Cartographic) => stack(c)[0] });
    Object.defineProperty(fake, 'pick', {
      value: (ray: Cesium.Ray, frameState: unknown) => {
        requireFrameState(frameState);
        onPick?.();
        const c = Cesium.Cartographic.fromCartesian(ray.origin);
        const h = stack(c).find((x) => x <= c.height);
        return h === undefined ? undefined : Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, h);
      },
    });
    vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
    return (await getPhotorealTileset())!;
  }

  it('through the real reads (sampler → sampleGroundHeight → meshHeightAt → pick): under a crown the rider takes the towpath, on the mesh', async () => {
    setIonToken('eyJ_test');
    // The towpath climbs 5 cm a metre; from 1 m on a crown stands 15 m over
    // it. The globe (World Terrain) is 0.6 m under the towpath, within
    // GLOBE_STANDIN_M: were the towpath not read from under the crown, the
    // globe would stand in for it (meshGround false) and the rider would
    // hold the road it last took.
    const towpath = (m: number) => 160 + 0.05 * m;
    const tileset = await stacked((m) => (m > 1 ? [towpath(m) + 15, towpath(m)] : [towpath(m)]));
    const { s, globe } = scene(tileset, { height: undefined, show: false });
    (globe.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (c: Cesium.Cartographic) => towpath(metresC(Cesium.Math.toDegrees(c.latitude))) - 0.6,
    );
    const sampler = createGroundSampler(s);
    expect(sampler.sample(lonC, atC(0), 160, 0)).toBeCloseTo(towpath(0), 6);
    expect(sampler.ground()).toBe('mesh');
    for (let i = 1; i <= 12; i++) {
      const m = 2 * i;
      expect(sampler.sample(lonC, atC(m), 160, i * GROUND_SAMPLE_INTERVAL_MS), `${m} m`).toBeCloseTo(towpath(m), 6);
      expect(sampler.meshGround(), `${m} m`).toBe(true);
      expect(sampler.ground(), `${m} m`).toBe('mesh');
    }
  });

  it("one sample's reads copy the tile from the GPU once (withMeshReadCache); reads outside a sample copy it every time", async () => {
    setIonToken('eyJ_test');
    // Cesium's tile pick copies each tile's geometry back from the GPU
    // (pickModel -> ModelReader -> Buffer.getBufferData; WebGL 2 keeps no CPU
    // copy). Under a crown one sample reads the mesh several times (the top,
    // then down from under it): the copies are kept for those reads.
    let copies = 0;
    let picks = 0;
    const indices = {
      count: 3,
      indexDatatype: Cesium.IndexDatatype.UNSIGNED_SHORT,
      buffer: {
        isDestroyed: () => false,
        getBufferData: (out: Uint16Array) => {
          copies++;
          out.set([0, 1, 2]);
        },
      },
    };
    const reader = (Cesium as unknown as { ModelReader: { readIndicesAsTypedArray: (i: unknown) => Uint16Array } }).ModelReader;
    const towpath = (m: number) => 160 + 0.05 * m;
    const tileset = await stacked(
      (m) => (m > 1 ? [towpath(m) + 15, towpath(m)] : [towpath(m)]),
      () => {
        picks++;
        expect([...reader.readIndicesAsTypedArray(indices)]).toEqual([0, 1, 2]);
      },
    );
    const { s, globe } = scene(tileset, { height: undefined, show: false });
    (globe.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (c: Cesium.Cartographic) => towpath(metresC(Cesium.Math.toDegrees(c.latitude))) - 0.6,
    );
    clearMeshTopReads();
    const sampler = createGroundSampler(s);
    sampler.sample(lonC, atC(0), 160, 0);
    expect(copies).toBe(1);
    const before = picks;
    expect(sampler.sample(lonC, atC(4), 160, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(towpath(4), 6);
    // Under the crown: the top and at least one read from under it, one copy kept.
    expect(picks - before).toBeGreaterThan(1);
    expect(copies).toBe(1);
    // Outside a sample's reads nothing is served from the copies.
    reader.readIndicesAsTypedArray(indices);
    expect(copies).toBe(2);
    clearMeshTopReads();
  });

  it('a fresh start under a structure with nothing drawn under it: the globe is drawn under it (no painted road, the usual wait), not the top', async () => {
    setIonToken('eyJ_test');
    // A crown 15 m over the towpath with no ground drawn under it, the globe
    // at the towpath: no road to go on from, so the rider stands on the globe.
    const tileset = await stacked(() => [175.4]);
    const { s } = scene(tileset, { height: 160.4 });
    const sampler = createGroundSampler(s);
    expect(sampler.sample(lonC, atC(0), 160, 0)).toBeCloseTo(160.4, 6);
    expect(sampler.meshGround()).toBe(false);
    // No road held to stand in for: 'under' (a jump lands here too).
    expect(sampler.ground()).toBe('under');
    // With the tile gone, no mesh at all: the globe is the ground.
    const bare = await stacked(() => []);
    const open = createGroundSampler(scene(bare, { height: 160.4 }).s);
    open.sample(lonC, atC(0), 160, 0);
    expect(open.ground()).toBe('globe');
  });

  it('the avatar hands the ride view what its sampler stood it on: under a structure, not only "not the mesh"', async () => {
    setIonToken('eyJ_test');
    // CesiumWorldView's ground gate reads avatar.ground(): were it only
    // meshGround() (mesh or globe), the painted road would come back under
    // the crown with the globe.
    const tileset = await stacked(() => [175.4]);
    const { s } = scene(tileset, { height: 160.4 });
    const primitives = new Cesium.PrimitiveCollection({ destroyPrimitives: false });
    primitives.add(tileset);
    (s as unknown as { primitives: Cesium.PrimitiveCollection }).primitives = primitives;
    const a = createAvatar({ isDestroyed: () => false, scene: s } as unknown as Cesium.Viewer);
    try {
      a.update({ lon: lonC, lat: atC(0), ele: 160, heading: 0, speed: 0, cadence: 0, grade: 0, dt: 1 / 60 });
      expect(a.ground()).toBe('under');
      expect(a.meshGround()).toBe(false);
    } finally {
      a.dispose();
    }
  });

  it('only a surface within UNDER_BARE_M of the bare terrain is taken from under something; with no terrain, none', () => {
    // A crown 14 m over the towpath, the towpath drawn under it (Cuyahoga 2748 m).
    const readAt = (_lon: number, lat: number, under?: number) => {
      const hits = lat > atC(1) ? [175, 160.9] : [160.9];
      return under === undefined ? hits[0] : hits.find((h) => h <= under);
    };
    for (const [bare, taken] of [
      [160.4, true],
      [160.9 + UNDER_BARE_M - 0.01, true],
      [160.9 + UNDER_BARE_M + 0.01, false],
      [undefined, false],
    ] as const) {
      const f = createMeshRoadFilter();
      f.next(160.9, lonC, atC(0), 1e9, readAt, -Infinity, bare);
      // Held or taken, the rider stays on the towpath height; only the status
      // says whether the mesh road was read there (the globe gate goes by it).
      expect(f.next(175, lonC, atC(4), 1e9, readAt, -Infinity, bare), `bare ${bare}`).toBe(160.9);
      expect(f.status(), `bare ${bare}`).toBe(taken ? 'road' : 'overhang');
    }
  });
});
