/**
 * The rider's ground on photoreal (meshHeightAt) is read with our own ray
 * cast through the tiles drawn this frame (meshRayCast, t_5b716f96) instead
 * of Cesium3DTileset.pick, without moving every tile vertex into world space.
 * Each tile is read as Cesium reads it, and the nearest hit over all of them
 * answers (t_5649bf24): pick lets the first tile by bounding-sphere distance
 * answer, which from above is the coarsest, and a coarse tile can be drawn
 * along with the fine ones far under them. The oracle here is Cesium's own
 * code: the real Cesium3DTileset.prototype.pick, Model3DTileContent.prototype
 * .pick and pickModel, run over the same fake tiles one tile at a time (only
 * ModelReader.forEachPrimitive, which walks a glTF scene graph, is faked).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';

import { createGroundSampler } from '@/lib/avatar';
import {
  clearMeshTopReads,
  getPhotorealTileset,
  meshGroundReadStats,
  meshHeightAt,
  meshRayCast,
  sampleGroundHeight,
  setIonToken,
} from '@/lib/cesiumUtils';

/** Lugano–Melide 2940 m, where the kerb is (cesiumUtils.meshHeightAt). */
const LON = 8.95;
const LAT = 45.98;
const GROUND = 363;
const M_LAT = 111_132;
const M_LON = 111_320 * Math.cos(Cesium.Math.toRadians(LAT));

/** The east-north-up frame at the ground point. */
const FRAME = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(LON, LAT, GROUND));
/** A world point as east / north / up metres from the ground point. */
function point(e: number, n: number, u: number) {
  return Cesium.Matrix4.multiplyByPoint(FRAME, new Cesium.Cartesian3(e, n, u), new Cesium.Cartesian3());
}
/** The spot e / n metres from the ground point. */
function spot(e: number, n: number) {
  return Cesium.Cartographic.fromDegrees(LON + e / M_LON, LAT + n / M_LAT);
}

/** The frame Cesium's pick reads (Cesium's own FrameState fields it touches). */
function frameState(over: Record<string, unknown> = {}) {
  return {
    context: { webgl2: true },
    mode: Cesium.SceneMode.SCENE3D,
    verticalExaggeration: 1,
    verticalExaggerationRelativeHeight: 0,
    ...over,
  };
}

const reader = (Cesium as unknown as {
  ModelReader: {
    forEachPrimitive: unknown;
    readAttributeAsTypedArray: (a: unknown) => unknown;
    readIndicesAsTypedArray: (i: unknown) => unknown;
  };
}).ModelReader;

interface FakePrimitive {
  attributes: Array<{
    semantic: string;
    type: string;
    count: number;
    componentDatatype: number;
    typedArray?: Float32Array;
    buffer?: unknown;
  }>;
  indices?: { count: number; indexDatatype: number; typedArray?: Uint32Array };
}
interface FakeModel {
  _ready: boolean;
  backFaceCulling: boolean;
  prims: FakePrimitive[];
  transforms: Cesium.Matrix4[];
  primSphere?: Cesium.BoundingSphere;
}
interface FakeTile {
  content: unknown;
  contentBoundingVolume: { boundingSphere: Cesium.BoundingSphere };
}

/** World triangles (3 corners each) as one primitive in the frame `transform` draws it in. */
function primitive(corners: Cesium.Cartesian3[], transform: Cesium.Matrix4): FakePrimitive {
  const inverse = Cesium.Matrix4.inverse(transform, new Cesium.Matrix4());
  const pos: number[] = [];
  for (const c of corners) {
    const l = Cesium.Matrix4.multiplyByPoint(inverse, c, new Cesium.Cartesian3());
    pos.push(l.x, l.y, l.z);
  }
  const idx = corners.map((_, i) => i);
  return {
    attributes: [
      {
        semantic: 'POSITION',
        type: 'VEC3',
        count: corners.length,
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        typedArray: new Float32Array(pos),
      },
    ],
    indices: { count: idx.length, indexDatatype: Cesium.IndexDatatype.UNSIGNED_INT, typedArray: new Uint32Array(idx) },
  };
}

/** A real Cesium Model / Model3DTileContent shell around the fake primitives (pick runs Cesium's own code). */
function tile(
  prims: FakePrimitive[],
  sphere: { e: number; n: number; u: number; r: number },
  opts: Partial<Omit<FakeModel, 'prims'>> & { contentReady?: boolean } = {},
): FakeTile {
  const model = Object.create(Cesium.Model.prototype) as FakeModel;
  Object.defineProperties(model, {
    _ready: { value: opts._ready ?? true, writable: true },
    backFaceCulling: { value: opts.backFaceCulling ?? true, writable: true },
    prims: { value: prims },
    transforms: { value: opts.transforms ?? [FRAME] },
    primSphere: { value: opts.primSphere },
  });
  const content = Object.create(Cesium.Model3DTileContent.prototype) as object;
  Object.defineProperties(content, {
    _model: { value: model, writable: true },
    _ready: { value: opts.contentReady ?? true, writable: true },
  });
  return {
    content,
    contentBoundingVolume: { boundingSphere: new Cesium.BoundingSphere(point(sphere.e, sphere.n, sphere.u), sphere.r) },
  };
}

/** A quad from e0..e1, n0..n1 at height u (two triangles), facing up, or down with `down`. */
function quad(e0: number, e1: number, n0: number, n1: number, u: number, down = false): Cesium.Cartesian3[] {
  const a = point(e0, n0, u);
  const b = point(e1, n0, u);
  const c = point(e1, n1, u);
  const d = point(e0, n1, u);
  return down ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
}

type Field = (e: number, n: number) => number | undefined;

/**
 * The field as tiles 8 m square with a height every 0.5 m, wound to face up.
 * Each tile is drawn in a frame of its own, turned every which way (Google's
 * tiles are not in east-north-up frames), and a jump between two samples is
 * a wall 0.5 m deep. Where the field is undefined nothing is drawn.
 */
function fieldTiles(field: Field, e0: number, e1: number, n0: number, n1: number, turn: () => Cesium.Matrix3): FakeTile[] {
  const tiles: FakeTile[] = [];
  const S = 8;
  const G = 0.5;
  for (let te = e0; te < e1; te += S) {
    for (let tn = n0; tn < n1; tn += S) {
      const corners: Cesium.Cartesian3[] = [];
      let lo = Infinity;
      let hi = -Infinity;
      for (let e = te; e < te + S - 1e-9; e += G) {
        for (let n = tn; n < tn + S - 1e-9; n += G) {
          const hs = [field(e, n), field(e + G, n), field(e + G, n + G), field(e, n + G)];
          if (hs.some((h) => h === undefined)) continue;
          const [a, b, c, d] = [point(e, n, hs[0]!), point(e + G, n, hs[1]!), point(e + G, n + G, hs[2]!), point(e, n + G, hs[3]!)];
          corners.push(a, b, c, a, c, d);
          for (const h of hs) {
            lo = Math.min(lo, h!);
            hi = Math.max(hi, h!);
          }
        }
      }
      if (!corners.length) continue;
      const centre = point(te + S / 2, tn + S / 2, (lo + hi) / 2);
      const transform = Cesium.Matrix4.fromRotationTranslation(turn(), centre, new Cesium.Matrix4());
      tiles.push(tile([primitive(corners, transform)], { e: te + S / 2, n: tn + S / 2, u: (lo + hi) / 2, r: Math.hypot(S / 2, S / 2, (hi - lo) / 2) + 0.5 }, { transforms: [transform] }));
    }
  }
  return tiles;
}

/** A small deterministic generator (tests must not depend on Math.random). */
function lcg(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** A rotation drawn from `rnd` (a unit quaternion). */
function turnFrom(rnd: () => number) {
  return () => {
    const q = new Cesium.Quaternion(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
    Cesium.Quaternion.normalize(q, q);
    return Cesium.Matrix3.fromQuaternion(q, new Cesium.Matrix3());
  };
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

/** A photoreal tileset drawing `tiles`, a scene around it, and a counter on its own pick. */
async function world(tiles: FakeTile[], fsOver: Record<string, unknown> = {}) {
  setIonToken('eyJ_test');
  const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
  Object.defineProperty(fake, 'show', { value: true, writable: true });
  Object.defineProperty(fake, 'tilesLoaded', { value: true, writable: true });
  Object.defineProperty(fake, '_selectedTiles', { value: tiles, writable: true });
  const picks = vi.fn((ray: Cesium.Ray, fs: unknown, result?: Cesium.Cartesian3) =>
    Cesium.Cesium3DTileset.prototype.pick.call(fake, ray, fs as never, result),
  );
  Object.defineProperty(fake, 'pick', { value: picks, writable: true });
  vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
  const tileset = (await getPhotorealTileset())!;
  if (typeof reader.forEachPrimitive === 'function') fakeForEachPrimitive();
  const fs = frameState(fsOver);
  const scene = {
    context: fs.context,
    frameState: fs,
    primitives: { length: 1, get: () => tileset },
    sampleHeightSupported: true,
    sampleHeight: vi.fn(() => undefined),
    globe: { show: false, translucency: { enabled: false }, tilesLoaded: true, getHeight: vi.fn(() => GROUND + 20) },
    terrainProvider: { worldTerrain: true },
  } as unknown as Cesium.Scene;
  return { scene, tileset, picks, fs };
}

/** meshHeightAt's ray: down the local vertical from two Earth radii up. */
function verticalRay(carto: Cesium.Cartographic) {
  const ell = Cesium.Ellipsoid.WGS84;
  const origin = ell.cartographicToCartesian(new Cesium.Cartographic(carto.longitude, carto.latitude, 2 * ell.maximumRadius));
  const down = Cesium.Cartesian3.negate(ell.geodeticSurfaceNormalCartographic(carto), new Cesium.Cartesian3());
  return new Cesium.Ray(origin, down);
}

/** What Cesium's own Cesium3DTileset.pick reads down that ray. */
function cesiumHeight(tileset: Cesium.Cesium3DTileset, carto: Cesium.Cartographic, fs: unknown): number | undefined {
  const hit = Cesium.Cesium3DTileset.prototype.pick.call(tileset, verticalRay(carto), fs as never);
  return hit ? Cesium.Ellipsoid.WGS84.cartesianToCartographic(hit)?.height : undefined;
}

/**
 * The nearest hit along `ray` over every selected tile, each read by Cesium's
 * own pick with that tile alone selected (Cesium3DTileset.pick's sphere test,
 * Model3DTileContent.pick / pickModel): the distance along the ray.
 */
function cesiumNearest(tileset: Cesium.Cesium3DTileset, ray: Cesium.Ray, fs: unknown): number | undefined {
  const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
  const all = ts._selectedTiles;
  let best: number | undefined;
  try {
    for (const t of all) {
      ts._selectedTiles = [t];
      const hit = Cesium.Cesium3DTileset.prototype.pick.call(tileset, ray, fs as never);
      if (!hit) continue;
      const d = Cesium.Cartesian3.distance(ray.origin, hit);
      if (best === undefined || d < best) best = d;
    }
  } finally {
    ts._selectedTiles = all;
  }
  return best;
}

/** cesiumNearest down meshHeightAt's vertical ray, as a height. */
function cesiumNearestHeight(tileset: Cesium.Cesium3DTileset, carto: Cesium.Cartographic, fs: unknown): number | undefined {
  const ray = verticalRay(carto);
  const t = cesiumNearest(tileset, ray, fs);
  return t === undefined ? undefined : Cesium.Ellipsoid.WGS84.cartesianToCartographic(Cesium.Ray.getPoint(ray, t))?.height;
}

let restoreWalk: (() => void) | null = null;

afterEach(() => {
  restoreWalk?.();
  restoreWalk = null;
  vi.restoreAllMocks();
  setIonToken(null);
});

/** Road with a kerb, bumps, a 6 m block, a step and a gap; heights in metres over GROUND. */
const street: Field = (e, n) => {
  if (e > -2 && e < 2 && n > 60 && n < 64) return undefined;
  let h = 0.02 * n + 0.3 * Math.sin(e * 0.7) * Math.cos(n * 0.4);
  if (e < -3) h -= 0.6;
  if (e > 8 && e < 12 && n > 10 && n < 18) h += 6;
  if (n > 40) h += 1.5;
  return h;
};

describe("meshHeightAt casts its own ray: Cesium's per-tile pick, the nearest hit over every tile", () => {
  it('spot by spot over a street in tiles turned every which way, with decks, overlaps, mirrors and copies', async () => {
    const rnd = lcg(29_401);
    const turn = turnFrom(rnd);
    const mirror = Cesium.Matrix4.multiply(FRAME, Cesium.Matrix4.fromScale(new Cesium.Cartesian3(-1, 1, 1)), new Cesium.Matrix4());
    const shifted = Cesium.Matrix4.multiply(FRAME, Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(0, 6, 0)), new Cesium.Matrix4());
    const tiles = [
      ...fieldTiles(street, -16, 16, -8, 72, turn),
      // A deck facing up (read from above), one facing down (its underside: not), one drawn both sides.
      tile([primitive(quad(-4, 4, 30, 34, 5), FRAME)], { e: 0, n: 32, u: 5, r: 6 }),
      tile([primitive(quad(-4, 4, 20, 24, 7, true), FRAME)], { e: 0, n: 22, u: 7, r: 6 }),
      tile([primitive(quad(-4, 4, 44, 48, 9, true), FRAME)], { e: 0, n: 46, u: 9, r: 6 }, { backFaceCulling: false }),
      // A coarse tile under part of the street (its sphere is nearer the ray's origin: pick lets it answer).
      tile([primitive(quad(-14, -6, 50, 58, -2), FRAME)], { e: 0, n: 30, u: 0, r: 60 }),
      // A ramp drawn mirrored, and a slab drawn twice (two instances).
      tile([primitive(quad(-12, -8, 2, 6, 4), FRAME)], { e: 10, n: 4, u: 4, r: 6 }, { transforms: [mirror] }),
      tile([primitive(quad(4, 7, 0, 3, 3), FRAME)], { e: 5.5, n: 4.5, u: 3, r: 8 }, { transforms: [FRAME, shifted] }),
    ];
    const { scene, tileset, picks, fs } = await world(tiles);
    const before = meshGroundReadStats();
    let read = 0;
    let none = 0;
    let notPicks = 0;
    for (let k = 0; k < 1500; k++) {
      const c = spot((rnd() - 0.5) * 34, -10 + rnd() * 84);
      const want = cesiumNearestHeight(tileset, c, fs);
      const got = meshHeightAt(tileset, c, scene);
      if (want === undefined) {
        none++;
        expect(got).toBeUndefined();
      } else {
        read++;
        expect(Math.abs(got! - want)).toBeLessThan(1e-6);
        if (Math.abs(got! - cesiumHeight(tileset, c, fs)!) > 0.5) notPicks++;
      }
    }
    expect(read).toBeGreaterThan(1200);
    expect(none).toBeGreaterThan(20);
    // Over the coarse tile's quad, pick reads it, 3–4 m under the street drawn over it.
    expect(notPicks).toBeGreaterThan(20);
    expect(picks).not.toHaveBeenCalled();
    expect(meshGroundReadStats().casts - before.casts).toBe(1500);
    expect(meshGroundReadStats().picks).toBe(before.picks);
  });

  it('a ray that starts low (inside a tile, under a deck or a crown) gets the nearest hit under it too', async () => {
    // Reads that start under what stands over the road (PR #76's `under`) go through the same cast.
    const rnd = lcg(76_148);
    const tiles = [
      ...fieldTiles(street, -16, 16, -8, 40, turnFrom(rnd)),
      tile([primitive(quad(-4, 4, 0, 30, 5), FRAME)], { e: 0, n: 15, u: 5, r: 16 }),
      tile([primitive(quad(-4, 4, 4, 26, 9, true), FRAME)], { e: 0, n: 15, u: 9, r: 16 }),
      tile([primitive(quad(-14, -6, 2, 10, 3), FRAME)], { e: 0, n: 15, u: 0, r: 40 }),
      tile([primitive(quad(-12, 12, 12, 20, -2), FRAME)], { e: 0, n: 16, u: -2, r: 40 }),
    ];
    const { tileset, fs } = await world(tiles);
    const ell = Cesium.Ellipsoid.WGS84;
    let hits = 0;
    let misses = 0;
    let notPicks = 0;
    for (let k = 0; k < 800; k++) {
      const c = spot((rnd() - 0.5) * 34, -10 + rnd() * 52);
      const from = GROUND - 3 + rnd() * 16;
      const ray = new Cesium.Ray(
        ell.cartographicToCartesian(new Cesium.Cartographic(c.longitude, c.latitude, from)),
        Cesium.Cartesian3.negate(ell.geodeticSurfaceNormalCartographic(c), new Cesium.Cartesian3()),
      );
      const theirs = cesiumNearest(tileset, ray, fs);
      const ours = meshRayCast(tileset, ray, fs);
      if (theirs === undefined) {
        misses++;
        expect(ours).toBeUndefined();
      } else {
        hits++;
        expect(Math.abs(ours! - theirs)).toBeLessThan(1e-6);
        const pick = Cesium.Cesium3DTileset.prototype.pick.call(tileset, ray, fs as never);
        if (!pick || Math.abs(Cesium.Cartesian3.distance(ray.origin, pick) - theirs) > 0.5) notPicks++;
      }
    }
    expect(hits).toBeGreaterThan(400);
    expect(misses).toBeGreaterThan(50);
    // From inside both coarse spheres (distance 0 to every one), pick's order is the selection's.
    expect(notPicks).toBeGreaterThan(20);
  });

  it('the nearest hit over every tile answers, not the first tile by sphere distance (a coarse tile drawn under a fine one)', async () => {
    const fine = tile([primitive(quad(-4, 4, -4, 4, 1), FRAME)], { e: 0, n: 0, u: 1, r: 6 });
    const coarse = tile([primitive(quad(-2, 2, -2, 2, -3), FRAME)], { e: 0, n: 0, u: 0, r: 40 });
    const { scene, tileset, fs } = await world([coarse, fine]);
    // Inside the coarse tile's quad: the fine ground over it (pick reads the coarse one, 4 m under it).
    expect(meshHeightAt(tileset, spot(0.5, 0.5), scene)).toBeCloseTo(GROUND + 1, 3);
    expect(cesiumHeight(tileset, spot(0.5, 0.5), fs)).toBeCloseTo(GROUND - 3, 3);
    expect(meshHeightAt(tileset, spot(3, 3), scene)).toBeCloseTo(GROUND + 1, 3);
    // In either order, and a coarse tile drawn OVER the fine one answers: it is what is drawn there.
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    ts._selectedTiles = [fine, coarse];
    expect(meshHeightAt(tileset, spot(0.5, 0.5), scene)).toBeCloseTo(GROUND + 1, 3);
    const over = tile([primitive(quad(-2, 2, -2, 2, 3), FRAME)], { e: 0, n: 0, u: 0, r: 40 });
    ts._selectedTiles = [fine, over];
    expect(meshHeightAt(tileset, spot(0.5, 0.5), scene)).toBeCloseTo(GROUND + 3, 3);
    expect(meshHeightAt(tileset, spot(3, 3), scene)).toBeCloseTo(GROUND + 1, 3);
  });

  it('no tile is read whose sphere the ray enters past the nearest hit so far', async () => {
    const reads = vi.spyOn(reader, 'readAttributeAsTypedArray');
    const ground = tile([primitive(quad(-4, 4, -4, 4, 0), FRAME)], { e: 0, n: 0, u: 0, r: 6 });
    // A tile whose sphere lies wholly under the ground: the ray enters it 24 m past the hit.
    const deep = tile([primitive(quad(-4, 4, -4, 4, -30), FRAME)], { e: 0, n: 0, u: -30, r: 6 });
    // One the ray enters before the hit (its sphere reaches 3 m over the ground): read, and nothing nearer in it.
    const beside = tile([primitive(quad(-1, 1, 20, 22, -1), FRAME)], { e: 0, n: 3, u: 0, r: 6 });
    const { scene, tileset } = await world([deep, beside, ground]);
    clearMeshTopReads();
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND, 3);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("a tile's nearest face answers: a deck over the road from above, its underside not, unless drawn both sides", async () => {
    const road = primitive(quad(-4, 4, -4, 4, 0), FRAME);
    const { scene, tileset } = await world([tile([road, primitive(quad(-2, 2, -2, 2, 5), FRAME)], { e: 0, n: 0, u: 2, r: 8 })]);
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND + 5, 3);
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    ts._selectedTiles = [tile([primitive(quad(-2, 2, -2, 2, 5, true), FRAME), road], { e: 0, n: 0, u: 2, r: 8 })];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND, 3);
    ts._selectedTiles = [tile([primitive(quad(-2, 2, -2, 2, 5, true), FRAME), road], { e: 0, n: 0, u: 2, r: 8 }, { backFaceCulling: false })];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND + 5, 3);
  });

  it('a mirroring instance transform: faces turned as Cesium sees them in world space', async () => {
    const mirror = Cesium.Matrix4.multiply(FRAME, Cesium.Matrix4.fromScale(new Cesium.Cartesian3(-1, 1, 1)), new Cesium.Matrix4());
    // Wound to face up in its own frame at -3 east, mirrored to +3 east: in world space it faces down.
    const ownUp = tile([primitive(quad(-4, -2, -1, 1, 2), FRAME)], { e: 3, n: 0, u: 2, r: 3 }, { transforms: [mirror] });
    const { scene, tileset, fs } = await world([ownUp]);
    expect(meshHeightAt(tileset, spot(3, 0), scene)).toBeUndefined();
    expect(cesiumHeight(tileset, spot(3, 0), fs)).toBeUndefined();
    const ownDown = tile([primitive(quad(-4, -2, -1, 1, 2, true), FRAME)], { e: 3, n: 0, u: 2, r: 3 }, { transforms: [mirror] });
    (tileset as unknown as { _selectedTiles: FakeTile[] })._selectedTiles = [ownDown];
    expect(meshHeightAt(tileset, spot(3, 0), scene)).toBeCloseTo(GROUND + 2, 3);
    expect(cesiumHeight(tileset, spot(3, 0), fs)).toBeCloseTo(GROUND + 2, 3);
  });

  it('every instance of a primitive is read', async () => {
    const second = Cesium.Matrix4.multiply(FRAME, Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(0, 6, 1)), new Cesium.Matrix4());
    const { scene, tileset, fs } = await world([tile([primitive(quad(-1, 1, -1, 1, 2), FRAME)], { e: 0, n: 3, u: 2, r: 6 }, { transforms: [FRAME, second] })]);
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND + 2, 3);
    expect(meshHeightAt(tileset, spot(0, 6), scene)).toBeCloseTo(GROUND + 3, 3);
    // With several instances the primitive's own sphere (around the first) is no test, as in pickModel.
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    ts._selectedTiles = [
      tile([primitive(quad(-1, 1, -1, 1, 2), FRAME)], { e: 0, n: 3, u: 2, r: 6 }, {
        transforms: [FRAME, second],
        primSphere: new Cesium.BoundingSphere(new Cesium.Cartesian3(0, 0, 2), 1.5),
      }),
    ];
    expect(meshHeightAt(tileset, spot(0, 6), scene)).toBeCloseTo(GROUND + 3, 3);
    expect(cesiumHeight(tileset, spot(0, 6), fs)).toBeCloseTo(GROUND + 3, 3);
  });

  it('an unready content or model is passed over, as Cesium does; a tile with no model answers with its own pick', async () => {
    const low = tile([primitive(quad(-4, 4, -4, 4, 0), FRAME)], { e: 0, n: 0, u: 0, r: 6 });
    const mk = (opts: Parameters<typeof tile>[2]) => tile([primitive(quad(-4, 4, -4, 4, 2), FRAME)], { e: 0, n: 0, u: 2, r: 20 }, opts);
    const { scene, tileset, fs } = await world([mk({ contentReady: false }), low]);
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND, 3);
    expect(cesiumHeight(tileset, spot(0, 0), fs)).toBeCloseTo(GROUND, 3);
    ts._selectedTiles = [mk({ _ready: false }), low];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND, 3);
    expect(cesiumHeight(tileset, spot(0, 0), fs)).toBeCloseTo(GROUND, 3);
    ts._selectedTiles = [mk({}), low];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND + 2, 3);
    // An empty tile (no model, no pick) and one whose content picks for itself.
    const sphere = new Cesium.BoundingSphere(point(0, 0, 0), 30);
    const own = vi.fn(() => point(0, 0, 7));
    ts._selectedTiles = [{ content: {}, contentBoundingVolume: { boundingSphere: sphere } }, low];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND, 3);
    ts._selectedTiles = [{ content: { pick: own }, contentBoundingVolume: { boundingSphere: sphere } }, low];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND + 7, 3);
    expect(own).toHaveBeenCalledTimes(1);
    expect(cesiumHeight(tileset, spot(0, 0), fs)).toBeCloseTo(GROUND + 7, 3);
    // No content at all: not a candidate.
    ts._selectedTiles = [{ content: null, contentBoundingVolume: { boundingSphere: sphere } }, low];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND, 3);
  });

  it("a tile or primitive whose bounding sphere the ray misses is not read", async () => {
    const reads = vi.spyOn(reader, 'readAttributeAsTypedArray');
    const g = primitive(quad(-4, 4, -4, 4, 0), FRAME);
    // The tile's sphere is 30 m east: never looked at (in truth its ground is under the spot).
    const { scene, tileset, fs } = await world([tile([g], { e: 30, n: 0, u: 0, r: 6 })]);
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    // The tile's sphere is on the ray, the primitive's own (one instance) 30 m east.
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    ts._selectedTiles = [tile([g], { e: 0, n: 0, u: 0, r: 6 }, { primSphere: new Cesium.BoundingSphere(new Cesium.Cartesian3(30, 0, 0), 6) })];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeUndefined();
    expect(cesiumHeight(tileset, spot(0, 0), fs)).toBeUndefined();
    expect(reads.mock.calls.length).toBe(0);
    ts._selectedTiles = [tile([g], { e: 0, n: 0, u: 0, r: 6 }, { primSphere: new Cesium.BoundingSphere(new Cesium.Cartesian3(0, 0, 0), 6) })];
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND, 3);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(cesiumHeight(tileset, spot(0, 0), fs)).toBeCloseTo(GROUND, 3);
  });

  it('primitives without indices or 3D positions are passed over', async () => {
    const g = primitive(quad(-4, 4, -4, 4, 0), FRAME);
    const noIndices = { ...g, indices: undefined };
    const noPositions = { ...g, attributes: [{ ...g.attributes[0], semantic: 'NORMAL' }] };
    // (Cesium would read 2D positions as garbage: x, y and the next corner's x. glTF positions are 3D.)
    const vec2 = { ...g, attributes: [{ ...g.attributes[0], type: 'VEC2' }] };
    const { scene, tileset } = await world([]);
    const ts = tileset as unknown as { _selectedTiles: FakeTile[] };
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeUndefined();
    for (const p of [noIndices, noPositions, vec2]) {
      ts._selectedTiles = [tile([p], { e: 0, n: 0, u: 0, r: 6 })];
      expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeUndefined();
    }
  });

  it('the tile geometry a read copies back from the GPU is copied once across reads', async () => {
    let copies = 0;
    const g = primitive(quad(-4, 4, -4, 4, 0), FRAME);
    const data = g.attributes[0].typedArray!;
    const gpu: FakePrimitive = {
      ...g,
      attributes: [
        {
          ...g.attributes[0],
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
    const { scene, tileset } = await world([tile([gpu], { e: 0, n: 0, u: 0, r: 6 })]);
    clearMeshTopReads();
    for (let k = 0; k < 5; k++) expect(meshHeightAt(tileset, spot(k * 0.5, 0), scene)).toBeCloseTo(GROUND, 3);
    expect(copies).toBe(1);
  });

  it("where it can't cast as pick would, tileset.pick reads (no model reader, a projected or exaggerated frame, WebGL 1, no selected tiles)", async () => {
    const tiles = [tile([primitive(quad(-4, 4, -4, 4, 1), FRAME)], { e: 0, n: 0, u: 1, r: 6 })];
    const cases: Array<Record<string, unknown>> = [
      { verticalExaggeration: 2 },
      { mode: Cesium.SceneMode.COLUMBUS_VIEW, mapProjection: new Cesium.GeographicProjection() },
      { context: { webgl2: false } },
    ];
    for (const over of cases) {
      const { scene, tileset, picks } = await world(tiles, over);
      const before = meshGroundReadStats();
      meshHeightAt(tileset, spot(0, 0), scene);
      expect(picks).toHaveBeenCalledTimes(1);
      expect(meshGroundReadStats().picks - before.picks).toBe(1);
      expect(meshGroundReadStats().casts).toBe(before.casts);
      vi.restoreAllMocks();
    }
    const { scene, tileset, picks } = await world(tiles);
    expect(meshRayCast(tileset, verticalRay(spot(0, 0)), undefined)).toBeNull();
    // A tileset without Cesium's selected tiles list (a test fake): its own pick answers.
    (tileset as unknown as { _selectedTiles: unknown })._selectedTiles = undefined;
    picks.mockReturnValueOnce(point(0, 0, 4));
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND + 4, 3);
    expect(picks).toHaveBeenCalledTimes(1);
    (tileset as unknown as { _selectedTiles: unknown })._selectedTiles = tiles;
    const walk = reader.forEachPrimitive;
    reader.forEachPrimitive = undefined;
    restoreWalk = () => {
      reader.forEachPrimitive = walk;
    };
    expect(meshRayCast(tileset, verticalRay(spot(0, 0)), scene.frameState)).toBeNull();
    restoreWalk();
    restoreWalk = null;
    // The same frame and tiles with the walk back: our own cast, no pick.
    expect(meshHeightAt(tileset, spot(0, 0), scene)).toBeCloseTo(GROUND + 1, 3);
    expect(picks).toHaveBeenCalledTimes(1);
  });

  it('ground reads are counted and timed for probes', async () => {
    const { scene, tileset } = await world([tile([primitive(quad(-4, 4, -4, 4, 1), FRAME)], { e: 0, n: 0, u: 1, r: 6 })]);
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 0.25));
    const before = meshGroundReadStats();
    meshHeightAt(tileset, spot(0, 0), scene);
    meshHeightAt(tileset, spot(1, 0), scene);
    const after = meshGroundReadStats();
    expect(after.casts - before.casts).toBe(2);
    expect(after.ms - before.ms).toBeCloseTo(0.5, 9);
  });
});

describe('the kerb at Lugano–Melide 2940 m, read through tile geometry', () => {
  // The road is drawn at 363.41 m with a kerb about 0.5 m south and the mesh
  // 362.8 m beyond it. getHeight's ray runs through the Earth's centre and
  // crosses 363 m 1.21 m south of the spot: it read 362.84 m, and the wheels
  // sat 0.57 m in the road. Here the kerb is real triangles, and both reads
  // run their own code over them (ours cast, Cesium's getHeight → pick).
  it("the rider stands on the road beside the kerb, where getHeight's leaning ray reads past it", async () => {
    const kerbN = -0.5;
    const turn = turnFrom(lcg(2_940));
    const t1 = Cesium.Matrix4.fromRotationTranslation(turn(), point(0, 10, 0), new Cesium.Matrix4());
    const t2 = Cesium.Matrix4.fromRotationTranslation(turn(), point(0, -10, 0), new Cesium.Matrix4());
    const tiles = [
      tile([primitive(quad(-20, 20, kerbN, 20, 0.4), t1)], { e: 0, n: 10, u: 0, r: 25 }, { transforms: [t1] }),
      tile([primitive(quad(-20, 20, -20, kerbN, -0.2), t2)], { e: 0, n: -10, u: 0, r: 25 }, { transforms: [t2] }),
    ];
    const { scene, tileset, picks } = await world(tiles);
    expect(sampleGroundHeight(scene, LON, LAT)).toBeCloseTo(363.4, 3);
    expect(createGroundSampler(scene).sample(LON, LAT, 303.3, 0)).toBeCloseTo(363.4, 3);
    expect(picks).not.toHaveBeenCalled();
    // Cesium's own reading through the same triangles lands past the kerb.
    // (If an upgrade fixes getHeight, this flips, and meshHeightAt's ray could be getHeight's.)
    expect(tileset.getHeight(Cesium.Cartographic.fromDegrees(LON, LAT), scene)).toBeCloseTo(362.8, 3);
  });
});

describe('the ramp onto the Chengdu Luxe Lakes bridge (1.26 km), a coarse tile drawn under it', () => {
  // The ramp rises from 4 to 6 m over the bare terrain (World Terrain at
  // 453.5 m, the ramp 457–460 m), the route's own elevation 25 m over the
  // ground (479 m), so the plausible floor is 35 m under the ground. Along
  // with the ramp's tiles Cesium draws a level-11 tile 52 km across for the
  // distance, and its surface runs under the ramp: 280–340 m under it on
  // cat-bed (t_5649bf24 logs), and in one ride in five 40 m under it, just
  // over the floor. Its sphere is the biggest, so pick read it first: the
  // rider took the fall, rode 40 m under the ramp for a second with nothing
  // drawn at its wheels, the camera under the world.
  const ramp: Field = (_e, n) => 4 + 0.05 * n;
  const ride = async (coarseUnder: number) => {
    const tiles = [
      tile([primitive(quad(-30, 30, 10, 30, coarseUnder), FRAME)], { e: 0, n: 0, u: coarseUnder, r: 5000 }),
      ...fieldTiles(ramp, -8, 8, -8, 48, turnFrom(lcg(1_260))),
    ];
    const { scene, picks } = await world(tiles);
    (scene.globe as unknown as { getHeight: () => number }).getHeight = () => GROUND;
    const sampler = createGroundSampler(scene);
    const out: Array<{ n: number; got: number | undefined; want: number; ground: string }> = [];
    // Off the tiles' 0.5 m grid lines (a ray down a shared edge can miss both triangles).
    for (let n = 0.27; n <= 40; n += 4) {
      const c = spot(0.3, n);
      const got = sampler.sample(Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude), GROUND + 25, n * 75);
      out.push({ n, got, want: GROUND + ramp(0.3, n)!, ground: sampler.ground() });
    }
    expect(picks).not.toHaveBeenCalled();
    return out;
  };

  it('40 m under the ramp (over the floor): the rider rides the ramp, not the fall', async () => {
    for (const s of await ride(-34)) {
      expect(s.got! - s.want, `n ${s.n}`).toBeCloseTo(0, 2);
      expect(s.ground, `n ${s.n}`).toBe('mesh');
    }
  });

  it('290 m under it (under the floor): the ramp is still the ground, not a coarse reading the globe stands in for', async () => {
    for (const s of await ride(-290)) {
      expect(s.got! - s.want, `n ${s.n}`).toBeCloseTo(0, 2);
      expect(s.ground, `n ${s.n}`).toBe('mesh');
    }
  });
});
