/**
 * placeSideCam: the view's side / orbit pose against a synthetic photoreal
 * world (t_1ec01b75). The rider rides north; what stands east or west of it
 * is read through the real meshTopHeight / drawnGroundHeight path from a fake
 * photoreal tileset and globe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';

import {
  computeCameraPose,
  SIDE_TRACK_OFFSET_M,
  SIDE_TRACK_UP_M,
  sideTrackSideFromPose,
  type CameraMode,
} from '@/lib/cesiumCameras';
import { clearMeshTopReads, getPhotorealTileset, meshTopHeight, setIonToken, sightReadable } from '@/lib/cesiumUtils';
import { createSideCamSight, SIGHT_MIN_OFFSET_M } from '@/lib/sideCamSight';
import { placeSideCam, type SideCamInput } from '@/renderers/cesium/sideCam';

const LON = 8.95;
const LAT = 45.98;
const GROUND = 280;
const M_LAT = 110_574;
const M_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);

/** East / north metres of a cartographic from the rider. */
function enu(c: Cesium.Cartographic) {
  return {
    e: (Cesium.Math.toDegrees(c.longitude) - LON) * M_LON,
    n: (Cesium.Math.toDegrees(c.latitude) - LAT) * M_LAT,
  };
}

type Field = (e: number, n: number) => number | undefined;

async function world(
  mesh: Field,
  opts: { globe?: Field; globeShown?: boolean; webgl2?: boolean; others?: unknown[]; pick?: () => void } = {},
) {
  setIonToken('eyJ_test');
  const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
  Object.defineProperty(fake, 'show', { value: true, writable: true });
  const getHeight = vi.fn((c: Cesium.Cartographic) => {
    // What pickModel does per tile under the ray (reads its buffers), if the test says.
    opts.pick?.();
    const { e, n } = enu(c);
    const h = mesh(e, n);
    return h === undefined ? undefined : GROUND + h;
  });
  Object.defineProperty(fake, 'getHeight', { value: getHeight });
  vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
  const tileset = await getPhotorealTileset();
  const globeField = opts.globe ?? (() => -2);
  const scene = {
    context: { webgl2: opts.webgl2 ?? true },
    // Other primitives the scene draws (the rider, the painted road) come first.
    primitives: {
      length: (opts.others?.length ?? 0) + 1,
      get: (i: number) => (i < (opts.others?.length ?? 0) ? opts.others![i] : tileset),
    },
    globe: {
      show: opts.globeShown ?? false,
      translucency: { enabled: false },
      tilesLoaded: true,
      getHeight: vi.fn((c: Cesium.Cartographic) => {
        const { e, n } = enu(c);
        const h = globeField(e, n);
        return h === undefined ? undefined : GROUND + h;
      }),
    },
    terrainProvider: { worldTerrain: true },
  } as unknown as Cesium.Scene;
  return { scene, getHeight };
}

afterEach(() => {
  vi.restoreAllMocks();
  setIonToken(null);
});

const RIDER = { lat: LAT, lon: LON, ele: GROUND, heading: 0, cadence: 85, speed: 8 };

function input(scene: Cesium.Scene, sight: ReturnType<typeof createSideCamSight>, over: Partial<SideCamInput> = {}): SideCamInput {
  const mode: CameraMode = over.mode ?? 'sideTracking';
  return {
    scene,
    sight,
    mode,
    pose: computeCameraPose(mode, RIDER, 0),
    heading: 0,
    lon: LON,
    lat: LAT,
    routeEle: GROUND - 3,
    groundEle: GROUND,
    speed: 8,
    distanceM: 100,
    nowMs: 1000,
    dt: 1 / 60,
    roadPainted: false,
    ...over,
  };
}

/** Run frames at 60 fps (rider standing in place) and return the last pose. */
function settle(i: SideCamInput, ms = 1500) {
  let p = placeSideCam(i);
  for (let t = 0; t < ms; t += 1000 / 60) p = placeSideCam({ ...i, nowMs: i.nowMs + t });
  return p;
}

// A house front from 2.5 m east of the road, 12 m tall.
const houseEast: Field = (e) => (e > 2.5 ? 12 : 0);

describe('placeSideCam', () => {
  it('open ground: the sideTracking pose unchanged (east of a rider riding north)', async () => {
    const { scene } = await world(() => 0);
    const i = input(scene, createSideCamSight());
    const p = settle(i);
    expect(p.offsetENU.x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
    expect(p.offsetENU.y).toBeCloseTo(0, 6);
    expect(Math.cos(p.heading - i.pose.heading)).toBeCloseTo(1, 9);
    expect(p.pitch).toBeCloseTo(i.pose.pitch, 6);
  });

  it('a house front on its side: crosses the road and looks back east at the rider', async () => {
    const { scene } = await world(houseEast);
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
    expect(p.offsetENU.z).toBeCloseTo(SIDE_TRACK_UP_M, 6);
    expect(p.heading).toBeCloseTo(Math.PI / 2, 6);
  });

  it('reads the spots where the rider will be (0.7 s ahead at ride speed)', async () => {
    // The house starts 4 m ahead of the rider: at 8 m/s the spots are read 5.6 m on.
    const { scene, getHeight } = await world((e, n) => (n > 4 && e > 2.5 ? 12 : 0));
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeLessThan(0);
    const reads = getHeight.mock.calls.map(([c]) => enu(c));
    // Its own (east) side is read only at the lead...
    const east = reads.filter((c) => c.e > 0).map((c) => c.n);
    expect(east.length).toBeGreaterThan(0);
    for (const n of east) expect(n).toBeCloseTo(5.6, 1);
    // ...and the west side at the lead and, before the cut, beside the rider.
    const west = new Set(reads.filter((c) => c.e < 0).map((c) => Math.round(c.n * 10) / 10));
    expect([...west].sort()).toEqual([0, 5.6]);
    // Standing still the spots are beside the rider, where it is open.
    const still = settle(input(scene, createSideCamSight(), { speed: 0 }));
    expect(still.offsetENU.x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
  });

  it('riding past a house front: in before it, held in all along it, out after it', async () => {
    // A 12 m house front from 5 m east of the road, 20-32 m along it; walled west from 3 m.
    const { scene } = await world((e, n) => (n >= 20 && n <= 32 && e > 5 ? 12 : e < -3 ? 12 : 0));
    const sight = createSideCamSight();
    const at = (n: number, t: number) =>
      placeSideCam(input(scene, sight, { lat: LAT + n / M_LAT, distanceM: n, nowMs: t, speed: 8 }));
    const offsets: Array<[number, number]> = [];
    for (let f = 0; f <= 60 * 8; f++) {
      const n = (8 * f) / 60;
      offsets.push([n, at(n, f * (1000 / 60)).offsetENU.x]);
    }
    const x = (n: number) => offsets.find(([m]) => m >= n)![1];
    expect(x(10)).toBeCloseTo(SIDE_TRACK_OFFSET_M, 3);
    // In to half its offset from before the house to past it (the reads run 5.6 m ahead).
    for (let n = 20; n <= 32; n += 1) {
      expect(x(n)).toBeGreaterThan(4.4);
      expect(x(n)).toBeLessThan(4.8);
    }
    // Out again as a slow dolly after it.
    expect(x(62)).toBeGreaterThan(SIDE_TRACK_OFFSET_M - 0.3);
  });

  it('the globe drawn over the mesh is in the way too', async () => {
    const { scene } = await world(() => 0, { globeShown: true, globe: (e) => (e > 5 ? 9 : 0) });
    const p = settle(input(scene, createSideCamSight(), { roadPainted: true }));
    // The painted road is drawn: no crossing, and no closer than its corridor.
    expect(p.offsetENU.x).toBeCloseTo(4.5, 2);
  });

  it('with the painted road drawn the camera stays on its side, outside the corridor', async () => {
    const { scene } = await world(houseEast);
    const p = settle(input(scene, createSideCamSight(), { roadPainted: true }));
    expect(p.offsetENU.x).toBeCloseTo(4.5, 2);
  });

  it('the orbit camera moves in along its radius, never crossing', async () => {
    const orbit = computeCameraPose('cinematic', RIDER, 0);
    const r0 = Math.hypot(orbit.offsetENU.x, orbit.offsetENU.y);
    const ux = orbit.offsetENU.x / r0;
    const uy = orbit.offsetENU.y / r0;
    // A bank from 6 m out on the camera's side only; open behind the rider.
    const { scene } = await world((e, n) => (e * ux + n * uy > 6 ? 10 : 0));
    const sight = createSideCamSight();
    const i = input(scene, sight, { mode: 'cinematic', pose: orbit });
    const p = settle(i);
    const r = Math.hypot(p.offsetENU.x, p.offsetENU.y);
    expect(r).toBeCloseTo(r0 / 2, 1);
    // Same bearing from the rider.
    expect(Math.atan2(p.offsetENU.x, p.offsetENU.y)).toBeCloseTo(Math.atan2(i.pose.offsetENU.x, i.pose.offsetENU.y), 6);
    expect(sight.debug().switches).toBe(0);
  });

  it('closed on both sides: the road edge on its own side', async () => {
    const { scene } = await world((e) => (Math.abs(e) > 4 ? 12 : 0));
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeCloseTo(SIGHT_MIN_OFFSET_M, 2);
  });

  it('leaves other modes, WebGL 1 and the globe-only view alone (and resets)', async () => {
    const { scene } = await world(houseEast);
    const sight = createSideCamSight();
    settle(input(scene, sight));
    expect(sight.debug().switches).toBe(1);
    const chase = input(scene, sight, { mode: 'chase', pose: computeCameraPose('chase', RIDER, 0) });
    expect(placeSideCam(chase)).toBe(chase.pose);
    expect(sight.debug().side).toBeNull();

    const gl1 = await world(houseEast, { webgl2: false });
    const i1 = input(gl1.scene, createSideCamSight());
    expect(placeSideCam(i1)).toBe(i1.pose);
    expect(gl1.getHeight).not.toHaveBeenCalled();
  });
});

describe('meshTopHeight / sightReadable', () => {
  it('reads the top of the shown photoreal mesh on WebGL 2 only', async () => {
    const { scene, getHeight } = await world(() => 7.5);
    expect(sightReadable(scene)).toBe(true);
    expect(meshTopHeight(scene, LON, LAT)).toBeCloseTo(GROUND + 7.5, 6);
    const gl1 = await world(() => 7.5, { webgl2: false });
    expect(sightReadable(gl1.scene)).toBe(false);
    expect(meshTopHeight(gl1.scene, LON, LAT)).toBeUndefined();
    expect(gl1.getHeight).not.toHaveBeenCalled();
    expect(getHeight).toHaveBeenCalledTimes(1);
  });

  it('a hidden mesh is not read', async () => {
    const { scene, getHeight } = await world(() => 7.5);
    const tileset = (scene.primitives as unknown as { get: () => { show: boolean } }).get();
    tileset.show = false;
    expect(sightReadable(scene)).toBe(false);
    expect(meshTopHeight(scene, LON, LAT)).toBeUndefined();
    expect(getHeight).not.toHaveBeenCalled();
  });
});

/**
 * Frames of the view's side feedback, as CesiumWorldView runs it: the placed
 * pose's side becomes the corridor's preferred side, which places the next
 * frame's pose, which goes through placeSideCam. The rider stands at 100 m.
 * Returns the camera's offset to the right of the rider's heading per frame.
 */
function rideFrames(
  scene: Cesium.Scene,
  sight: ReturnType<typeof createSideCamSight>,
  startSide: 1 | -1,
  frames: number,
  heading = 0,
) {
  let preferred = startSide;
  const right: number[] = [];
  const rider = { ...RIDER, heading };
  for (let f = 0; f < frames; f++) {
    const corridor = { points: [], riderDistanceM: 100, preferredSide: preferred };
    const pose = computeCameraPose('sideTracking', rider, 0, undefined, corridor);
    const placed = placeSideCam(input(scene, sight, { pose, heading, nowMs: 1000 + (f * 1000) / 60 }));
    preferred = sideTrackSideFromPose(placed, heading);
    right.push(placed.offsetENU.x * Math.cos(heading) - placed.offsetENU.y * Math.sin(heading));
  }
  return right;
}

/** Number of times a per-frame series changes sign. */
const signFlips = (xs: number[]) => xs.slice(1).filter((x, k) => Math.sign(x) !== Math.sign(xs[k])).length;

describe('placeSideCam in the view loop (the placed side is the next pose\'s side)', () => {
  it('a house front on the right: one cut to the left, and it stays there frame after frame', async () => {
    const { scene } = await world(houseEast);
    const right = rideFrames(scene, createSideCamSight(), 1, 240);
    const cut = right.findIndex((x) => x < 0);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(15);
    for (const x of right.slice(0, cut)) expect(x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
    for (const x of right.slice(cut)) expect(x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
    expect(signFlips(right)).toBe(1);
  });

  it('a pose starting on the left with a house front there: one cut to the right, kept', async () => {
    const { scene } = await world((e) => (e < -2.5 ? 12 : 0));
    const sight = createSideCamSight();
    const right = rideFrames(scene, sight, -1, 240);
    expect(right[0]).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
    const cut = right.findIndex((x) => x > 0);
    expect(cut).toBeGreaterThan(0);
    for (const x of right.slice(cut)) expect(x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
    expect(signFlips(right)).toBe(1);
    expect(sight.cuts()).toBe(1);
  });

  it('a pose starting on the left on open ground stays on the left', async () => {
    const { scene } = await world(() => 0);
    const right = rideFrames(scene, createSideCamSight(), -1, 120);
    for (const x of right) expect(x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
  });

  it('riding east or west, the cut keeps the camera across the road from the house', async () => {
    // Riding east the right side is south; riding west it is north.
    const east = await world((e, n) => (n < -2.5 ? 12 : 0));
    const r1 = rideFrames(east.scene, createSideCamSight(), 1, 120, Math.PI / 2);
    expect(r1[r1.length - 1]).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
    expect(signFlips(r1)).toBe(1);
    const west = await world((e, n) => (n > 2.5 ? 12 : 0));
    const r2 = rideFrames(west.scene, createSideCamSight(), 1, 120, -Math.PI / 2);
    expect(r2[r2.length - 1]).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
    expect(signFlips(r2)).toBe(1);
  });
});

describe('placeSideCam: where it reads, how high it stands', () => {
  it('riding east or west, the spots are read where the rider will be (ahead along the heading)', async () => {
    // Riding east at 8 m/s: a house on the right (south) from 4 m ahead; reads 5.6 m on.
    const east = await world((e, n) => (n < -2.5 && e > 4 ? 12 : 0));
    const pe = settle(input(east.scene, createSideCamSight(), {
      heading: Math.PI / 2,
      pose: computeCameraPose('sideTracking', { ...RIDER, heading: Math.PI / 2 }, 0),
    }));
    expect(pe.offsetENU.y).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6); // crossed to the north
    const southReads = east.getHeight.mock.calls.map(([c]) => enu(c)).filter((c) => c.n < 0);
    expect(southReads.length).toBeGreaterThan(0);
    for (const c of southReads) expect(c.e).toBeCloseTo(5.6, 1);
    // Riding west: a house on the right (north) from 4 m ahead (west).
    const west = await world((e, n) => (n > 2.5 && e < -4 ? 12 : 0));
    const pw = settle(input(west.scene, createSideCamSight(), {
      heading: -Math.PI / 2,
      pose: computeCameraPose('sideTracking', { ...RIDER, heading: -Math.PI / 2 }, 0),
    }));
    expect(pw.offsetENU.y).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6); // crossed to the south
    const northReads = west.getHeight.mock.calls.map(([c]) => enu(c)).filter((c) => c.n > 0);
    for (const c of northReads) expect(c.e).toBeCloseTo(-5.6, 1);
  });

  it('a 2.2 m garden wall under the camera spot: it moves in (the camera is 3.2 m up, not higher)', async () => {
    // At 3.2 m the camera keeps 1.2 m of air only over tops up to 2.0 m.
    const { scene } = await world((e) => (e > 8 ? 2.2 : 0));
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeCloseTo(0.75 * SIDE_TRACK_OFFSET_M, 2);
    expect(p.offsetENU.z).toBeCloseTo(SIDE_TRACK_UP_M, 6);
  });

  it('a hidden globe is not in the way where the mesh read misses', async () => {
    // No mesh tile 5 m out and beyond (a hole, or not loaded); the hidden
    // globe there is 9 m up (World Terrain over the shore).
    const { scene } = await world((e) => (e > 5 ? undefined : 0), { globeShown: false, globe: () => 9 });
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
    // Shown, the same globe is: across the road (where it is the same 9 m) the camera can't go either.
    const shown = await world((e) => (e > 5 ? undefined : 0), { globeShown: true, globe: (e) => (e > 5 ? 9 : 0) });
    const q = settle(input(shown.scene, createSideCamSight()));
    expect(q.offsetENU.x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
  });

  it("a coarse mesh tile's chord far over the route is not the top; the globe drawn there is", async () => {
    // 5 m out and beyond: a coarse photoreal tile reads 900 m up; the shown globe 9 m.
    const { scene } = await world((e) => (e > 5 ? 900 : 0), { globeShown: true, globe: (e) => (e > 5 ? 9 : 0) });
    const p = settle(input(scene, createSideCamSight(), { roadPainted: true }));
    expect(p.offsetENU.x).toBeCloseTo(4.5, 2);
  });

  it('one tile read a frame, riding past a house front', async () => {
    const { scene, getHeight } = await world((e, n) => (n >= 20 && n <= 32 && e > 5 ? 12 : e < -3 ? 12 : 0));
    const sight = createSideCamSight();
    const perFrame: number[] = [];
    for (let f = 0; f <= 60 * 8; f++) {
      const n = (8 * f) / 60;
      const before = getHeight.mock.calls.length;
      placeSideCam(input(scene, sight, { lat: LAT + n / M_LAT, distanceM: n, nowMs: f * (1000 / 60), speed: 8 }));
      perFrame.push(getHeight.mock.calls.length - before);
    }
    expect(Math.max(...perFrame)).toBe(1);
    expect(perFrame.reduce((a, b) => a + b, 0)).toBeGreaterThan(40);
  });
});

describe('meshTopHeight reuses the tile geometry it copies back from the GPU', () => {
  /** Cesium's private ModelReader, the reads pickModel makes per tile primitive. */
  const reader = (Cesium as unknown as {
    ModelReader: { readIndicesAsTypedArray: (i: unknown) => Uint16Array; readAttributeAsTypedArray: (a: unknown) => unknown };
  }).ModelReader;

  it('this Cesium has the two reads the cache wraps', () => {
    expect(typeof reader.readIndicesAsTypedArray).toBe('function');
    expect(typeof reader.readAttributeAsTypedArray).toBe('function');
  });

  it("a tile's indices are copied once across reads; outside the sight's reads every time", async () => {
    let copies = 0;
    // A GPU-backed index buffer, as on WebGL 2 (no CPU typedArray).
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
    // getHeight picks the tile: pickModel reads its indices through ModelReader.
    const { scene } = await world(() => 7.5, {
      pick: () => expect([...reader.readIndicesAsTypedArray(indices)]).toEqual([0, 1, 2]),
    });
    clearMeshTopReads();
    for (let k = 0; k < 5; k++) expect(meshTopHeight(scene, LON, LAT)).toBeCloseTo(GROUND + 7.5, 6);
    expect(copies).toBe(1);
    reader.readIndicesAsTypedArray(indices);
    reader.readIndicesAsTypedArray(indices);
    expect(copies).toBe(3);
    // The view is gone: its copies with it.
    clearMeshTopReads();
    meshTopHeight(scene, LON, LAT);
    expect(copies).toBe(4);
  });
});

describe('meshTopHeight: only the photoreal mesh', () => {
  it('two photoreal meshes shown (a remount mid-swap): the higher top counts', async () => {
    const second = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
    Object.defineProperty(second, 'show', { value: true, writable: true });
    Object.defineProperty(second, 'getHeight', { value: vi.fn(() => GROUND + 3) });
    vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValueOnce(second);
    setIonToken('eyJ_test');
    const low = await getPhotorealTileset();
    const { scene } = await world(() => 7.5, { others: [low] });
    expect(meshTopHeight(scene, LON, LAT)).toBeCloseTo(GROUND + 7.5, 6);
    const { scene: s2 } = await world(() => 1, { others: [low] });
    expect(meshTopHeight(s2, LON, LAT)).toBeCloseTo(GROUND + 3, 6);
  });

  it('skips the other primitives the scene draws (no getHeight on them)', async () => {
    const rider = { show: true };
    const osm = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
    Object.defineProperty(osm, 'show', { value: true, writable: true });
    const osmHeight = vi.fn(() => GROUND + 40);
    Object.defineProperty(osm, 'getHeight', { value: osmHeight });
    const { scene, getHeight } = await world(() => 7.5, { others: [rider, osm] });
    expect(sightReadable(scene)).toBe(true);
    expect(meshTopHeight(scene, LON, LAT)).toBeCloseTo(GROUND + 7.5, 6);
    expect(getHeight).toHaveBeenCalledTimes(1);
    expect(osmHeight).not.toHaveBeenCalled();
    // Placed through it each frame: 7.5 m tops on both sides, the road edge.
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeCloseTo(SIGHT_MIN_OFFSET_M, 2);
  });
});
