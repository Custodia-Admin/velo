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

import {
  acceptMeshReading,
  createGroundSampler,
  followGround,
  GROUND_SAMPLE_INTERVAL_MS,
  OVERHANG_GIVE_UP_MS,
} from '@/lib/avatar';
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

describe('overhangs: a palm canopy over the path is not the road', () => {
  it('rejects a reading that rises faster than a road climbs, takes falls and real climbs', () => {
    expect(acceptMeshReading(undefined, -18, 0)).toBe(true);
    expect(acceptMeshReading(-28.2, -18.0, 5)).toBe(false); // Santa Monica Strand, 10 m palm canopy
    expect(acceptMeshReading(-28.2, -40, 5)).toBe(true); // falls always
    expect(acceptMeshReading(300, 301.2, 1)).toBe(true); // a 1.2 m kerb/ramp step
    expect(acceptMeshReading(300, 302.4, 5)).toBe(true); // 20 % over 5 m + slack
    expect(acceptMeshReading(300, 312, 40)).toBe(true); // 40 m on it is the road
    // A tile that refines 4 m higher under a stopped rider is taken after a moment.
    expect(acceptMeshReading(-33, -28.1, 0, OVERHANG_GIVE_UP_MS - 1)).toBe(false);
    expect(acceptMeshReading(-33, -28.1, 0, OVERHANG_GIVE_UP_MS)).toBe(true);
  });

  it('the sampler keeps the road under a canopy and the rider stays on it', async () => {
    setIonToken('eyJ_test');
    const readings = [-28.2, -18.0, -28.3];
    let i = 0;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => readings[Math.min(i++, 2)]);
    const { s } = scene(tileset, { height: -32.5 });
    const sampler = createGroundSampler(s);
    expect(sampler.sample(-118.5, 34.0, -30, 0)).toBeCloseTo(-28.2, 6);
    expect(sampler.sample(-118.5, 34.00005, -30, GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(-28.2, 6);
    expect(sampler.sample(-118.5, 34.0001, -30, 2 * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(-28.3, 6);
  });

  it('a higher surface that stays (a refined tile) is taken after OVERHANG_GIVE_UP_MS of rejections', async () => {
    setIonToken('eyJ_test');
    const readings = [-33.0, -28.1];
    let i = 0;
    const { tileset } = await photoreal(undefined);
    (tileset.getHeight as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => readings[Math.min(i++, 1)]);
    const sampler = createGroundSampler(scene(tileset, { height: -40 }).s);
    expect(sampler.sample(-118.5, 34.0, -30, 0)).toBeCloseTo(-33, 6);
    let t = 0;
    for (; t < OVERHANG_GIVE_UP_MS; t += GROUND_SAMPLE_INTERVAL_MS) {
      expect(sampler.sample(-118.5, 34.0, -30, t + GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(-33, 6);
    }
    expect(sampler.sample(-118.5, 34.0, -30, t + 2 * GROUND_SAMPLE_INTERVAL_MS)).toBeCloseTo(-28.1, 6);
  });
});

describe('followGround: the avatar never lags under a rising surface', () => {
  it('rises at once on a climb, eases up a big step in ~0.2 s, eases down', () => {
    expect(followGround(null, 300, 1 / 60)).toBe(300);
    expect(followGround(300, 300.4, 1 / 60)).toBe(300.4);
    let h = 300;
    let frames = 0;
    while (h < 304 && frames < 60) {
      h = followGround(h, 304, 1 / 60);
      frames++;
    }
    expect(h).toBe(304);
    expect(frames).toBeGreaterThan(5);
    expect(frames).toBeLessThanOrEqual(12);
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
