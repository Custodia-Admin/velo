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

import { createGroundSampler, createMeshRoadFilter, followGround, GROUND_SAMPLE_INTERVAL_MS, OVERHANG_MIN_M } from '@/lib/avatar';
import { drawnGroundHeight, getPhotorealTileset, groundSettled, sceneGroundHeight, setIonToken } from '@/lib/cesiumUtils';

async function photoreal(height: number | undefined, opts: { show?: boolean; tilesLoaded?: boolean } = {}) {
  const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
  Object.defineProperty(fake, 'show', { value: opts.show ?? true, writable: true });
  Object.defineProperty(fake, 'tilesLoaded', { value: opts.tilesLoaded ?? true, writable: true });
  const getHeight = vi.fn(() => height);
  Object.defineProperty(fake, 'getHeight', { value: getHeight });
  vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
  const tileset = await getPhotorealTileset();
  return { tileset, getHeight };
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
    context: { webgl2: true },
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

  it("a camera's filter takes the top of whatever is drawn (a palm crown 10 m up), still not a coarse tile", () => {
    const cam = createMeshRoadFilter({ overhangs: false });
    const none = () => undefined;
    expect(cam.next(-28.6, lon, lat(0), 40, none)).toBe(-28.6);
    expect(cam.next(-18.6, lon, lat(2), 40, () => -28.6)).toBe(-18.6);
    expect(cam.status()).toBe('road');
    expect(cam.next(505.7, lon, lat(4), 40, none)).toBe(-18.6);
    expect(cam.status()).toBe('coarse');
    // The rider's filter holds the path under the same crown.
    const rider = createMeshRoadFilter();
    rider.next(-28.6, lon, lat(0), 40, none);
    expect(rider.next(-18.6, lon, lat(2), 40, () => -28.6)).toBe(-28.6);
  });

  it("the camera's sampler stands on the crown the rider rides under (Santa Monica Strand palms)", async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation((c: Cesium.Cartographic) =>
      Cesium.Math.toDegrees(c.latitude) > lat(1) ? -18.6 : -28.6,
    );
    const { s } = scene(tileset, { height: -32.6, show: false });
    const cam = createGroundSampler(s, { overhangs: false });
    const rider = createGroundSampler(s);
    cam.sample(lon, lat(0), -30, 0);
    rider.sample(lon, lat(0), -30, 0);
    expect(cam.sample(lon, lat(2), -30, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(-18.6, 6);
    expect(rider.sample(lon, lat(2), -30, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(-28.6, 6);
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
    expect(got).toEqual([362, 363.8, 365.6, 367.4]);
  });

  it("groundSettled ignores a hidden globe's frozen load queue", () => {
    setIonToken('eyJ_test');
    expect(groundSettled(scene(null, { height: 300, tilesLoaded: false, show: false }).s)).toBe(true);
    expect(groundSettled(scene(null, { height: 300, tilesLoaded: false }).s)).toBe(false);
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
