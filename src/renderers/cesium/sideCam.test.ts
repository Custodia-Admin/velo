/**
 * placeSideCam: the view's side / orbit pose against a synthetic photoreal
 * world (t_1ec01b75, t_ee2165b8). The rider rides north; what stands east or
 * west of it is drawn as a height field, both as triangle tiles (what the
 * segment casts read, through the real meshSegmentHit walk) and through the
 * tileset's getHeight (what the top reads read when the casts can't be made).
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
import {
  clearMeshTopReads,
  getPhotorealTileset,
  meshSegmentHit,
  meshTopHeight,
  setIonToken,
  sightRaysReadable,
  sightReadable,
} from '@/lib/cesiumUtils';
import { createSideCamSight, SIGHT_MIN_OFFSET_M, SIGHT_RAY_READS_PER_FRAME } from '@/lib/sideCamSight';
import { placeSideCam, type SideCamInput } from '@/renderers/cesium/sideCam';

/** Every segment the view casts through the mesh, in the order cast (a, b, tile copies from the GPU it made). */
const casts = vi.hoisted(
  () => [] as Array<[{ x: number; y: number; z: number }, { x: number; y: number; z: number }, number]>,
);
vi.mock('@/lib/cesiumUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cesiumUtils')>();
  return {
    ...actual,
    meshSegmentHit: (scene: Cesium.Scene, a: Cesium.Cartesian3, b: Cesium.Cartesian3) => {
      const copies = actual.meshTopReadStats()?.misses ?? 0;
      const hit = actual.meshSegmentHit(scene, a, b);
      casts.push([Cesium.Cartesian3.clone(a), Cesium.Cartesian3.clone(b), (actual.meshTopReadStats()?.misses ?? 0) - copies]);
      return hit;
    },
  };
});

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

/** The rider's east-north-up frame (at its ground) and its inverse. */
const FRAME = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(LON, LAT, GROUND));
const UNFRAME = Cesium.Matrix4.inverse(FRAME, new Cesium.Matrix4());
/** A world point as east / north / up metres from the rider's ground point. */
function local(p: { x: number; y: number; z: number }) {
  const l = Cesium.Matrix4.multiplyByPoint(UNFRAME, new Cesium.Cartesian3(p.x, p.y, p.z), new Cesium.Cartesian3());
  return { e: l.x, n: l.y, u: l.z };
}
/** East / north / up metres from the rider's ground point to a world point. */
function point(e: number, n: number, u: number) {
  return Cesium.Matrix4.multiplyByPoint(FRAME, new Cesium.Cartesian3(e, n, u), new Cesium.Cartesian3());
}

type Field = (e: number, n: number) => number | undefined;

/** Cesium's private ModelReader: the casts walk tile primitives with forEachPrimitive. */
const reader = (Cesium as unknown as {
  ModelReader: {
    forEachPrimitive: unknown;
    readIndicesAsTypedArray: (i: unknown) => Uint16Array;
    readAttributeAsTypedArray: (a: unknown) => unknown;
  };
}).ModelReader;

interface FakePrimitive {
  attributes: Array<{ semantic: string; type: string; count: number; componentDatatype: number; typedArray?: Float32Array; buffer?: unknown }>;
  indices?: { count: number; indexDatatype: number; typedArray?: Uint32Array; buffer?: unknown };
}
interface FakeModel {
  _ready: boolean;
  backFaceCulling?: boolean;
  prims: FakePrimitive[];
  /** Instance transforms (one per instance); each primitive is drawn once per instance. */
  transforms: Cesium.Matrix4[];
  /** Bounding sphere of each primitive in its own frame (runtimePrimitive.boundingSphere), if any. */
  primSphere?: Cesium.BoundingSphere;
}
interface FakeTile {
  content: { _model: FakeModel } | null;
  contentBoundingVolume: { boundingSphere: Cesium.BoundingSphere };
}

/** A primitive from east / north / up positions and triangle indices. */
function primitive(positions: number[], indices: number[]): FakePrimitive {
  return {
    attributes: [
      {
        semantic: 'POSITION',
        type: 'VEC3',
        count: positions.length / 3,
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        typedArray: new Float32Array(positions),
      },
    ],
    indices: { count: indices.length, indexDatatype: Cesium.IndexDatatype.UNSIGNED_INT, typedArray: new Uint32Array(indices) },
  };
}

/** A tile holding one model (drawn in the rider's frame unless told otherwise) and a bounding sphere around it. */
function tile(prims: FakePrimitive[], sphere: { e: number; n: number; u: number; r: number }, model: Partial<FakeModel> = {}): FakeTile {
  return {
    content: { _model: { _ready: true, prims, transforms: [FRAME], ...model } },
    contentBoundingVolume: { boundingSphere: new Cesium.BoundingSphere(point(sphere.e, sphere.n, sphere.u), sphere.r) },
  };
}

const GRID_M = 0.5;
const TILE_M = 16;

/**
 * The field as triangle tiles (16 m square, a height every 0.5 m, east -24..24
 * and north -24..72 of the rider), wound counter-clockwise seen from above as
 * glTF has them. A jump in height between two samples is a wall 0.5 m deep.
 * Where the field is undefined no triangle is drawn.
 */
function heightTiles(field: Field): FakeTile[] {
  const tiles: FakeTile[] = [];
  const steps = TILE_M / GRID_M;
  for (let e0 = -24; e0 < 24; e0 += TILE_M) {
    for (let n0 = -24; n0 < 72; n0 += TILE_M) {
      const pos: number[] = [];
      const hole: boolean[] = [];
      let lo = Infinity;
      let hi = -Infinity;
      for (let a = 0; a <= steps; a++) {
        for (let b = 0; b <= steps; b++) {
          const e = e0 + a * GRID_M;
          const n = n0 + b * GRID_M;
          const h = field(e, n);
          hole.push(h === undefined);
          pos.push(e, n, h ?? 0);
          if (h !== undefined) {
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
        }
      }
      const idx: number[] = [];
      const v = (a: number, b: number) => a * (steps + 1) + b;
      for (let a = 0; a < steps; a++) {
        for (let b = 0; b < steps; b++) {
          const q = [v(a, b), v(a + 1, b), v(a + 1, b + 1), v(a, b + 1)];
          if (q.some((k) => hole[k])) continue;
          idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
        }
      }
      if (!idx.length) continue;
      const mid = (lo + hi) / 2;
      const r = Math.hypot(TILE_M / 2, TILE_M / 2, (hi - lo) / 2) + 1;
      tiles.push(tile([primitive(pos, idx)], { e: e0 + TILE_M / 2, n: n0 + TILE_M / 2, u: mid, r }));
    }
  }
  return tiles;
}

/** ModelReader.forEachPrimitive over the fake models (the real one walks a glTF scene graph). */
function fakeForEachPrimitive() {
  return vi
    .spyOn(reader as unknown as { forEachPrimitive: (...a: unknown[]) => void }, 'forEachPrimitive')
    .mockImplementation((...args: unknown[]) => {
      const [model, , callback] = args as [FakeModel, unknown, (...c: unknown[]) => void];
      for (const p of model.prims) {
        callback({ boundingSphere: model.primSphere }, p, model.transforms.map((transform) => ({ transform })), model.transforms[0]);
      }
    });
}

/** Without the model reader's walk (a Cesium without it), the sight falls back to the top reads. */
let restoreWalk: (() => void) | null = null;
function withoutCasts() {
  const walk = reader.forEachPrimitive;
  reader.forEachPrimitive = undefined;
  restoreWalk = () => {
    reader.forEachPrimitive = walk;
  };
}

async function world(
  mesh: Field,
  opts: {
    globe?: Field;
    globeShown?: boolean;
    webgl2?: boolean;
    others?: unknown[];
    pick?: () => void;
    /** Extra tiles drawn by the photoreal tileset (shapes a height field can't draw: a canopy). */
    extra?: FakeTile[];
  } = {},
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
  Object.defineProperty(fake, '_selectedTiles', { value: [...heightTiles(mesh), ...(opts.extra ?? [])], writable: true });
  vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
  const tileset = await getPhotorealTileset();
  if (typeof reader.forEachPrimitive === 'function') fakeForEachPrimitive();
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
  casts.length = 0;
  return { scene, getHeight, tileset: fake };
}

afterEach(() => {
  restoreWalk?.();
  restoreWalk = null;
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

/** The camera spot (east / north) of every cast from the bars (1 m up) so far. */
const lineCastSpots = () =>
  casts.filter(([a]) => Math.abs(local(a).u - 1) < 1e-2).map(([, b]) => local(b));

// A house front from 2.5 m east of the road, 12 m tall.
const houseEast: Field = (e) => (e > 2.5 ? 12 : 0);

describe('placeSideCam (segment casts)', () => {
  it('casts are what it reads when the model reader is there', async () => {
    const { scene, getHeight } = await world(() => 0);
    expect(sightRaysReadable(scene)).toBe(true);
    settle(input(scene, createSideCamSight()));
    expect(casts.length).toBeGreaterThan(0);
    expect(getHeight).not.toHaveBeenCalled();
  });

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

  it('casts from the bars, 1 m over the ground, to the camera spot 3.2 m up, where the rider will be', async () => {
    // The house starts 4 m ahead of the rider: at 8 m/s the spots are read 5.6 m on.
    const { scene } = await world((e, n) => (n > 4 && e > 2.5 ? 12 : 0));
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeLessThan(0);
    for (const [a, b] of casts.filter(([s]) => Math.abs(local(s).u - 1) < 1e-2)) {
      const la = local(a);
      const lb = local(b);
      // From the bars on the route line to the spot, both at the lead.
      expect(la.e).toBeCloseTo(0, 6);
      expect(lb.u).toBeCloseTo(SIDE_TRACK_UP_M, 6);
      expect(la.n).toBeCloseTo(lb.n, 6);
    }
    const spots = lineCastSpots();
    // Its own (east) side is read only at the lead...
    const east = spots.filter((c) => c.e > 0);
    expect(east.length).toBeGreaterThan(0);
    for (const c of east) expect(c.n).toBeCloseTo(5.6, 1);
    // ...and the west side at the lead and, before the cut, beside the rider.
    const west = new Set(spots.filter((c) => c.e < 0).map((c) => Math.round(c.n * 10) / 10));
    expect([...west].sort()).toEqual([0, 5.6]);
    // Standing still the spots are beside the rider, where it is open.
    const still = settle(input(scene, createSideCamSight(), { speed: 0 }));
    expect(still.offsetENU.x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
  });

  it('riding past a house front: in before it, held in all along it, out after it', async () => {
    // A 12 m house front from 5 m east of the road, 20-32 m along it; walled west from 3 m.
    const { scene } = await world((e, n) => (n >= 20 && n <= 32 && e > 5 ? 12 : e < -3 ? 12 : 0));
    const sight = createSideCamSight();
    // The world stays put; the rider rides north through it.
    const at = (n: number, t: number) =>
      placeSideCam(input(scene, sight, { lat: LAT + n / M_LAT, distanceM: n, nowMs: t, speed: 8 })).offsetENU.x;
    const offsets: Array<[number, number]> = [];
    for (let f = 0; f <= 60 * 8; f++) {
      const n = (8 * f) / 60;
      offsets.push([n, at(n, f * (1000 / 60))]);
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

  it('a hedge between the spots the tops are read at: not filmed through, and not filmed from behind', async () => {
    // A 3 m hedge 5.5-6.5 m east: under neither the 9, 6.75 nor 4.5 m spot.
    const hedge: Field = (e) => (e >= 5.5 && e <= 6.5 ? 3 : 0);
    const { scene } = await world(hedge);
    // Across the road it is open: it cuts there.
    expect(settle(input(scene, createSideCamSight())).offsetENU.x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
    // Kept on its side (the orbit never crosses): in front of the hedge.
    const orbit = computeCameraPose('cinematic', RIDER, 0);
    const r0 = Math.hypot(orbit.offsetENU.x, orbit.offsetENU.y);
    const { scene: s2 } = await world((e, n) => {
      const along = (e * orbit.offsetENU.x + n * orbit.offsetENU.y) / r0;
      return along >= 5.5 && along <= 6.5 ? 3 : 0;
    });
    const p = settle(input(s2, createSideCamSight(), { mode: 'cinematic', pose: orbit }));
    expect(Math.hypot(p.offsetENU.x, p.offsetENU.y)).toBeLessThan(5.5);
  });

  it('a 3 m hedge 5-7 m out and 3 m long, ridden past at 8 m/s: never filmed from behind', async () => {
    // Lugano 427 / 461 m (PR #47): a hedge this long fitted between two reads 3 m apart.
    const { scene } = await world((e, n) => (n >= 30 && n <= 33 && e >= 5 && e <= 7 ? 3 : e < -3 ? 12 : 0));
    const sight = createSideCamSight();
    for (let f = 0; f <= 60 * 6; f++) {
      const n = (8 * f) / 60;
      const x = placeSideCam(input(scene, sight, { lat: LAT + n / M_LAT, distanceM: n, nowMs: f * (1000 / 60), speed: 8 })).offsetENU.x;
      // Beside the hedge the camera stands in front of it (the west side is walled: no cut).
      if (n >= 30 && n <= 33) expect(x).toBeLessThan(5);
    }
  });

  it('under a canopy over the line it stays out; a solid there moves it in', async () => {
    // A crown 4-7 m up over 4-12 m east, open under it; the camera spot (9 m, 3.2 m up) is under it.
    const { scene } = await world(() => 0, { extra: [box({ e0: 4, e1: 12, n0: -6, n1: 12, u0: 4, u1: 7 })] });
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
    // The same crown down to the ground (a solid): not seen through.
    const { scene: s2 } = await world(() => 0, { extra: [box({ e0: 4, e1: 12, n0: -6, n1: 12, u0: -1, u1: 7 })] });
    expect(settle(input(s2, createSideCamSight())).offsetENU.x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
  });

  it('the globe drawn over the mesh is in the way too', async () => {
    const { scene } = await world(() => 0, { globeShown: true, globe: (e) => (e > 5 ? 9 : 0) });
    const p = settle(input(scene, createSideCamSight(), { roadPainted: true }));
    // The painted road is drawn: no crossing, and no closer than its corridor.
    expect(p.offsetENU.x).toBeCloseTo(4.5, 2);
  });

  it('the globe drawn over the mesh is read along the line too (a bank between the bars and the spot)', async () => {
    // The orbit stands 10 m east, 3.5 m up. Shown globe: a 4 m bank 7.3-7.7 m
    // east, open under the 10 m spot; the mesh flat. Read at the 7.5 m spot
    // on the way, it hides the bars from 10 m; 5 m is the farthest seen.
    const orbit = computeCameraPose('cinematic', RIDER, 0);
    expect(orbit.offsetENU.x).toBeCloseTo(10, 6);
    const { scene } = await world(() => 0, { globeShown: true, globe: (e) => (e >= 7.3 && e <= 7.7 ? 4 : 0) });
    const p = settle(input(scene, createSideCamSight(), { mode: 'cinematic', pose: orbit }));
    expect(p.offsetENU.x).toBeCloseTo(5, 6);
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
    expect(casts).toEqual([]);
  });

  it('a 2.2 m garden wall under the camera spot: it moves in (the camera is 3.2 m up, not higher)', async () => {
    // At 3.2 m the camera keeps 1.2 m of air only over tops up to 2.0 m:
    // the cast down from the spot runs into the wall's top.
    const { scene } = await world((e) => (e > 8 ? 2.2 : 0));
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeCloseTo(0.75 * SIDE_TRACK_OFFSET_M, 2);
    expect(p.offsetENU.z).toBeCloseTo(SIDE_TRACK_UP_M, 6);
    // The cast under a spot: straight down 1.2 m from it.
    const under = casts.filter(([a]) => Math.abs(local(a).u - SIDE_TRACK_UP_M) < 1e-3);
    expect(under.length).toBeGreaterThan(0);
    for (const [a, b] of under) {
      const la = local(a);
      const lb = local(b);
      expect(lb.e).toBeCloseTo(la.e, 6);
      expect(lb.n).toBeCloseTo(la.n, 6);
      expect(lb.u).toBeCloseTo(SIDE_TRACK_UP_M - 1.2, 6);
    }
    // 2.0 m is clear.
    const { scene: s2 } = await world((e) => (e > 8 ? 1.95 : 0));
    expect(settle(input(s2, createSideCamSight())).offsetENU.x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
  });

  it('a hidden globe is not in the way where the mesh has a hole', async () => {
    // No mesh 5 m out and beyond (a hole, or not loaded); the hidden
    // globe there is 9 m up (World Terrain over the shore).
    const { scene } = await world((e) => (e > 5 ? undefined : 0), { globeShown: false, globe: () => 9 });
    const p = settle(input(scene, createSideCamSight()));
    expect(p.offsetENU.x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6);
    // Shown, the same globe is: across the road (where it is the same 9 m) the camera can't go either.
    const shown = await world((e) => (e > 5 ? undefined : 0), { globeShown: true, globe: (e) => (e > 5 ? 9 : 0) });
    const q = settle(input(shown.scene, createSideCamSight()));
    expect(q.offsetENU.x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
  });

  it('a frame stops casting after the cast that first copied a tile back from the GPU', async () => {
    const { scene, tileset } = await world(houseEast);
    // The tiles' positions on the GPU only (WebGL 2: no CPU copy), each copy counted.
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    for (const t of ts._selectedTiles) {
      for (const prim of t.content!._model.prims) {
        const data = prim.attributes[0].typedArray!;
        prim.attributes[0] = {
          ...prim.attributes[0],
          typedArray: undefined,
          buffer: { isDestroyed: () => false, sizeInBytes: data.byteLength, getBufferData: (out: Float32Array) => out.set(data) },
        };
      }
    }
    clearMeshTopReads();
    const sight = createSideCamSight();
    const i = input(scene, sight);
    const frames: Array<typeof casts> = [];
    let p = i.pose;
    for (let f = 0; f < 90; f++) {
      const from = casts.length;
      p = placeSideCam({ ...i, nowMs: i.nowMs + (f * 1000) / 60 });
      frames.push(casts.slice(from));
    }
    const fromBars = ([a]: (typeof casts)[number]) => Math.abs(local(a).u - 1) < 1e-2;
    // The first cast copies the tiles on its line: that frame asks one spot.
    expect(frames[0].filter(fromBars)).toHaveLength(1);
    expect(frames[0][0][2]).toBeGreaterThan(0);
    // No spot is asked after a cast that copied, in the same frame...
    for (const fc of frames) {
      const k = fc.findIndex(([, , copies]) => copies > 0);
      if (k >= 0) expect(fc.slice(k + 1).filter(fromBars)).toEqual([]);
    }
    // ...and with the tiles copied, up to four spots a frame.
    expect(Math.max(...frames.map((fc) => fc.filter(fromBars).length))).toBe(SIGHT_RAY_READS_PER_FRAME);
    // It still crosses the road.
    expect(p.offsetENU.x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
  });

  it('spots read a frame: at most SIGHT_RAY_READS_PER_FRAME, riding past a house front', async () => {
    const { scene } = await world((e, n) => (n >= 20 && n <= 32 && e > 5 ? 12 : e < -3 ? 12 : 0));
    const sight = createSideCamSight();
    const perFrame: number[] = [];
    for (let f = 0; f <= 60 * 8; f++) {
      const n = (8 * f) / 60;
      const before = lineCastSpots().length;
      placeSideCam(input(scene, sight, { lat: LAT + n / M_LAT, distanceM: n, nowMs: f * (1000 / 60), speed: 8 }));
      perFrame.push(lineCastSpots().length - before);
    }
    expect(Math.max(...perFrame)).toBe(SIGHT_RAY_READS_PER_FRAME);
    // Re-read about every metre (8 m/s: some 60 refreshes in 8 s).
    expect(sight.debug().rays).toBe(true);
    expect(perFrame.filter((k) => k > 0).length).toBeGreaterThan(50);
  });
});

/** A closed box (six faces, each wound counter-clockwise seen from outside), as a tile. */
function box(b: { e0: number; e1: number; n0: number; n1: number; u0: number; u1: number }): FakeTile {
  const { e0, e1, n0, n1, u0, u1 } = b;
  // Corners: bit 0 east, bit 1 north, bit 2 up.
  const c = (i: number) => [i & 1 ? e1 : e0, i & 2 ? n1 : n0, i & 4 ? u1 : u0];
  const pos = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(c);
  const quad = (a: number, b2: number, c2: number, d: number) => [a, b2, c2, a, c2, d];
  const idx = [
    ...quad(0, 2, 3, 1), // bottom (faces down)
    ...quad(4, 5, 7, 6), // top (faces up)
    ...quad(0, 1, 5, 4), // south
    ...quad(2, 6, 7, 3), // north
    ...quad(0, 4, 6, 2), // west
    ...quad(1, 3, 7, 5), // east
  ];
  return tile([primitive(pos, idx)], {
    e: (e0 + e1) / 2,
    n: (n0 + n1) / 2,
    u: (u0 + u1) / 2,
    r: Math.hypot(e1 - e0, n1 - n0, u1 - u0) / 2 + 0.1,
  });
}

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

  it('riding east or west, the spots are cast to where the rider will be (ahead along the heading)', async () => {
    // Riding east at 8 m/s: a house on the right (south) from 4 m ahead; cast 5.6 m on.
    const east = await world((e, n) => (n < -2.5 && e > 4 ? 12 : 0));
    const pe = settle(input(east.scene, createSideCamSight(), {
      heading: Math.PI / 2,
      pose: computeCameraPose('sideTracking', { ...RIDER, heading: Math.PI / 2 }, 0),
    }));
    expect(pe.offsetENU.y).toBeCloseTo(SIDE_TRACK_OFFSET_M, 6); // crossed to the north
    const south = lineCastSpots().filter((c) => c.n < 0);
    expect(south.length).toBeGreaterThan(0);
    for (const c of south) expect(c.e).toBeCloseTo(5.6, 1);
    // Riding west: a house on the right (north) from 4 m ahead (west).
    const west = await world((e, n) => (n > 2.5 && e < -4 ? 12 : 0));
    const pw = settle(input(west.scene, createSideCamSight(), {
      heading: -Math.PI / 2,
      pose: computeCameraPose('sideTracking', { ...RIDER, heading: -Math.PI / 2 }, 0),
    }));
    expect(pw.offsetENU.y).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6); // crossed to the south
    const north = lineCastSpots().filter((c) => c.n > 0);
    expect(north.length).toBeGreaterThan(0);
    for (const c of north) expect(c.e).toBeCloseTo(-5.6, 1);
  });
});

describe('placeSideCam without the model reader: the top reads (t_1ec01b75)', () => {
  it('reads tops, no casts', async () => {
    withoutCasts();
    const { scene, getHeight } = await world(() => 0);
    expect(sightReadable(scene)).toBe(true);
    expect(sightRaysReadable(scene)).toBe(false);
    settle(input(scene, createSideCamSight()));
    expect(getHeight).toHaveBeenCalled();
    expect(casts).toEqual([]);
  });

  it('a house front on its side: crosses the road', async () => {
    withoutCasts();
    const { scene } = await world(houseEast);
    expect(settle(input(scene, createSideCamSight())).offsetENU.x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
  });

  it('reads the spots where the rider will be (0.7 s ahead at ride speed)', async () => {
    withoutCasts();
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
  });

  it('a 2.2 m garden wall under the camera spot: it moves in', async () => {
    withoutCasts();
    const { scene } = await world((e) => (e > 8 ? 2.2 : 0));
    expect(settle(input(scene, createSideCamSight())).offsetENU.x).toBeCloseTo(0.75 * SIDE_TRACK_OFFSET_M, 2);
  });

  it("a coarse mesh tile's chord far over the route is not the top; the globe drawn there is", async () => {
    withoutCasts();
    // 5 m out and beyond: a coarse photoreal tile reads 900 m up; the shown globe 9 m.
    const { scene } = await world((e) => (e > 5 ? 900 : 0), { globeShown: true, globe: (e) => (e > 5 ? 9 : 0) });
    const p = settle(input(scene, createSideCamSight(), { roadPainted: true }));
    expect(p.offsetENU.x).toBeCloseTo(4.5, 2);
  });

  it('under a canopy the tops say solid: it moves away (what the casts fix)', async () => {
    withoutCasts();
    const crown: Field = (e) => (e >= 4 && e <= 12 ? 7 : 0);
    const { scene } = await world(crown);
    expect(settle(input(scene, createSideCamSight())).offsetENU.x).toBeCloseTo(-SIDE_TRACK_OFFSET_M, 6);
  });

  it('one tile read a frame, riding past a house front', async () => {
    withoutCasts();
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
    expect(sight.debug().rays).toBe(false);
  });
});

describe('meshTopHeight / sightReadable', () => {
  it('reads the top of the shown photoreal mesh on WebGL 2 only', async () => {
    const { scene, getHeight } = await world(() => 7.5);
    expect(sightReadable(scene)).toBe(true);
    expect(meshTopHeight(scene, LON, LAT)).toBeCloseTo(GROUND + 7.5, 6);
    const gl1 = await world(() => 7.5, { webgl2: false });
    expect(sightReadable(gl1.scene)).toBe(false);
    expect(sightRaysReadable(gl1.scene)).toBe(false);
    expect(meshTopHeight(gl1.scene, LON, LAT)).toBeUndefined();
    expect(gl1.getHeight).not.toHaveBeenCalled();
    expect(getHeight).toHaveBeenCalledTimes(1);
  });

  it('a hidden mesh is not read', async () => {
    const { scene, getHeight } = await world(() => 7.5);
    const tileset = (scene.primitives as unknown as { get: () => { show: boolean } }).get();
    tileset.show = false;
    expect(sightReadable(scene)).toBe(false);
    expect(sightRaysReadable(scene)).toBe(false);
    expect(meshTopHeight(scene, LON, LAT)).toBeUndefined();
    expect(getHeight).not.toHaveBeenCalled();
  });
});

describe('meshTopHeight reuses the tile geometry it copies back from the GPU', () => {
  it('this Cesium has the reads the cache wraps and the walk the casts use', () => {
    expect(typeof reader.readIndicesAsTypedArray).toBe('function');
    expect(typeof reader.readAttributeAsTypedArray).toBe('function');
    expect(typeof reader.forEachPrimitive).toBe('function');
    // A tileset keeps the tiles it draws this frame where the casts look.
    expect(Array.isArray((new Cesium.Cesium3DTileset({}) as unknown as { _selectedTiles: unknown })._selectedTiles)).toBe(true);
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
    withoutCasts();
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

/** A 2 x 2 m wall `x` m east of the rider, 1 m to 3 m up, facing west (towards the rider). */
function wallEast(x: number): FakePrimitive {
  // Seen from the west (looking east, north to the left): corners (n, u)
  // (1, 1) (-1, 1) (-1, 3) (1, 3) run counter-clockwise.
  return primitive([x, 1, 1, x, -1, 1, x, -1, 3, x, 1, 3], [0, 1, 2, 0, 2, 3]);
}

describe('meshSegmentHit: the nearest face of every tile drawn this frame', () => {
  const A = () => point(0, 0, 2);
  const B = () => point(10, 0, 2);

  it('the nearest hit over all tiles, not the first tile by sphere distance (Cesium3DTileset.pick)', async () => {
    const { scene, tileset } = await world(() => undefined);
    // A wide tile centred at the start holds a wall 8 m out; a small one 3 m out holds a wall there.
    (tileset as unknown as { _selectedTiles: FakeTile[] })._selectedTiles = [
      tile([wallEast(8)], { e: 0, n: 0, u: 2, r: 9 }),
      tile([wallEast(3)], { e: 3, n: 0, u: 2, r: 2 }),
    ];
    expect(meshSegmentHit(scene, A(), B())).toBeCloseTo(0.3, 6);
    // Only the far wall: 0.8. Neither on the segment (it ends at 2 m): undefined.
    (tileset as unknown as { _selectedTiles: FakeTile[] })._selectedTiles = [tile([wallEast(8)], { e: 0, n: 0, u: 2, r: 9 })];
    expect(meshSegmentHit(scene, A(), B())).toBeCloseTo(0.8, 6);
    expect(meshSegmentHit(scene, A(), point(2, 0, 2))).toBeUndefined();
  });

  it('faces turned away from the start are not hits, unless the model draws both sides', async () => {
    const { scene, tileset } = await world(() => undefined);
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    ts._selectedTiles = [tile([wallEast(5)], { e: 5, n: 0, u: 2, r: 2 })];
    expect(meshSegmentHit(scene, B(), A())).toBeUndefined();
    ts._selectedTiles = [tile([wallEast(5)], { e: 5, n: 0, u: 2, r: 2 }, { backFaceCulling: false })];
    expect(meshSegmentHit(scene, B(), A())).toBeCloseTo(0.5, 6);
  });

  it('a mirroring instance transform: faces turned as Cesium sees them in world space', async () => {
    const { scene, tileset } = await world(() => undefined);
    // The wall drawn at -5 east (facing west), mirrored east-west: at +5. Its
    // corners keep their order, so in world space it still faces west; in its
    // own frame the cast now comes at it from behind.
    const mirror = Cesium.Matrix4.multiply(FRAME, Cesium.Matrix4.fromScale(new Cesium.Cartesian3(-1, 1, 1)), new Cesium.Matrix4());
    (tileset as unknown as { _selectedTiles: FakeTile[] })._selectedTiles = [
      tile([wallEast(-5)], { e: 5, n: 0, u: 2, r: 2 }, { transforms: [mirror] }),
    ];
    expect(meshSegmentHit(scene, A(), B())).toBeCloseTo(0.5, 6);
    expect(meshSegmentHit(scene, B(), A())).toBeUndefined();
  });

  it('every instance of a primitive is cast against', async () => {
    const { scene, tileset } = await world(() => undefined);
    const second = Cesium.Matrix4.multiply(FRAME, Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(-4, 0, 0)), new Cesium.Matrix4());
    (tileset as unknown as { _selectedTiles: FakeTile[] })._selectedTiles = [
      tile([wallEast(8)], { e: 6, n: 0, u: 2, r: 5 }, { transforms: [FRAME, second] }),
    ];
    // The second instance stands at 4 m.
    expect(meshSegmentHit(scene, A(), B())).toBeCloseTo(0.4, 6);
  });

  it("a tile or primitive whose bounding sphere the segment misses is not read; nor an unready model", async () => {
    const { scene, tileset } = await world(() => undefined);
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    const reads = vi.spyOn(reader, 'readAttributeAsTypedArray');
    // Its sphere is 20 m north: the wall in it is never looked at (in truth it is on the line).
    ts._selectedTiles = [tile([wallEast(5)], { e: 5, n: 20, u: 2, r: 2 })];
    expect(meshSegmentHit(scene, A(), B())).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    // The tile's sphere is on the line, the primitive's own sphere (in its frame) 20 m north.
    ts._selectedTiles = [tile([wallEast(5)], { e: 5, n: 0, u: 2, r: 2 }, { primSphere: new Cesium.BoundingSphere(new Cesium.Cartesian3(5, 20, 2), 2) })];
    expect(meshSegmentHit(scene, A(), B())).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    ts._selectedTiles = [tile([wallEast(5)], { e: 5, n: 0, u: 2, r: 2 }, { primSphere: new Cesium.BoundingSphere(new Cesium.Cartesian3(5, 0, 2), 2) })];
    expect(meshSegmentHit(scene, A(), B())).toBeCloseTo(0.5, 6);
    expect(reads).toHaveBeenCalledTimes(1);
    ts._selectedTiles = [tile([wallEast(5)], { e: 5, n: 0, u: 2, r: 2 }, { _ready: false })];
    expect(meshSegmentHit(scene, A(), B())).toBeUndefined();
    ts._selectedTiles = [{ content: null, contentBoundingVolume: { boundingSphere: new Cesium.BoundingSphere(point(5, 0, 2), 2) } }];
    expect(meshSegmentHit(scene, A(), B())).toBeUndefined();
  });

  it('primitives without positions or indices, or with positions that are not 3D, are skipped', async () => {
    const { scene, tileset } = await world(() => undefined);
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    const w = wallEast(5);
    const noIndices = { ...w, indices: undefined };
    const noPositions = { ...w, attributes: [{ ...w.attributes[0], semantic: 'NORMAL' }] };
    const vec2 = { ...w, attributes: [{ ...w.attributes[0], type: 'VEC2' }] };
    for (const p of [noIndices, noPositions, vec2]) {
      ts._selectedTiles = [tile([p], { e: 5, n: 0, u: 2, r: 2 })];
      expect(meshSegmentHit(scene, A(), B())).toBeUndefined();
    }
  });

  it('only the shown photoreal mesh: other tilesets, a hidden mesh and WebGL 1 are not cast against', async () => {
    const osm = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
    Object.defineProperty(osm, 'show', { value: true, writable: true });
    Object.defineProperty(osm, '_selectedTiles', { value: [tile([wallEast(5)], { e: 5, n: 0, u: 2, r: 2 })] });
    const { scene, tileset } = await world(() => undefined, { others: [{ show: true }, osm] });
    expect(meshSegmentHit(scene, A(), B())).toBeUndefined();
    (tileset as unknown as { _selectedTiles: FakeTile[] })._selectedTiles = [tile([wallEast(5)], { e: 5, n: 0, u: 2, r: 2 })];
    expect(meshSegmentHit(scene, A(), B())).toBeCloseTo(0.5, 6);
    tileset.show = false;
    expect(meshSegmentHit(scene, A(), B())).toBeUndefined();
    tileset.show = true;
    const gl1 = { ...scene, context: { webgl2: false } } as unknown as Cesium.Scene;
    expect(meshSegmentHit(gl1, A(), B())).toBeUndefined();
    // No model reader walk in this Cesium: nothing is cast.
    withoutCasts();
    expect(meshSegmentHit(scene, A(), B())).toBeUndefined();
  });

  it('the tile geometry a cast copies back from the GPU is copied once across casts', async () => {
    const { scene, tileset } = await world(() => undefined);
    let copies = 0;
    const w = wallEast(5);
    const data = w.attributes[0].typedArray!;
    const gpu: FakePrimitive = {
      ...w,
      attributes: [
        {
          ...w.attributes[0],
          typedArray: undefined,
          buffer: {
            isDestroyed: () => false,
            sizeInBytes: data.byteLength,
            getBufferData: (out: Float32Array) => {
              copies++;
              out.set(data);
            },
          },
        },
      ],
    };
    (tileset as unknown as { _selectedTiles: FakeTile[] })._selectedTiles = [tile([gpu], { e: 5, n: 0, u: 2, r: 2 })];
    clearMeshTopReads();
    for (let k = 0; k < 5; k++) expect(meshSegmentHit(scene, A(), B())).toBeCloseTo(0.5, 6);
    expect(copies).toBe(1);
  });
});
