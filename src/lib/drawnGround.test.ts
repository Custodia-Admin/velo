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
  GROUND_SAMPLE_INTERVAL_MS,
  OVERHANG_GIVE_UP_M,
  OVERHANG_MIN_M,
} from '@/lib/avatar';
import {
  drawnGroundHeight,
  getPhotorealTileset,
  groundSettled,
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
}

function scene(tileset: Cesium.Cesium3DTileset | null, g: GlobeOpts, terrain: object = { worldTerrain: true }) {
  const globe = {
    show: g.show ?? true,
    translucency: { enabled: g.translucent ?? false },
    tilesLoaded: g.tilesLoaded ?? true,
    getHeight: vi.fn(() => g.height),
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

  it("the avatar's throttled sampler reuses the mesh reading but reads the globe fresh every frame", async () => {
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photoreal(306.2);
    const g: GlobeOpts = { height: 309.2 };
    const { s, globe } = scene(tileset, g);
    globe.getHeight.mockImplementation(() => g.height);
    const sampler = createGroundSampler(s);
    expect(sampler.sample(12.1, 43.2, 259, 1000)).toBeCloseTo(309.2, 6);
    // Next frame, a metre on: the globe rose, the mesh sample is reused.
    g.height = 309.9;
    expect(sampler.sample(12.10001, 43.2, 259, 1016)).toBeCloseTo(309.9, 6);
    expect(getHeight).toHaveBeenCalledTimes(1);
    // The globe dips under the mesh: the (cached) mesh is the ground again.
    g.height = 305;
    expect(sampler.sample(12.10002, 43.2, 259, 1032)).toBeCloseTo(306.2, 6);
    // After the interval the mesh is sampled again.
    sampler.sample(12.10003, 43.2, 259, 1032 + GROUND_SAMPLE_INTERVAL_MS);
    expect(getHeight).toHaveBeenCalledTimes(2);
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
