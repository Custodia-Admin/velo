/**
 * Ground height over the photoreal mesh must not use the GPU pick.
 *
 * scene.sampleHeight renders a pick pass and reads it back synchronously; on
 * the owner's Arc iGPU each call stalled the main thread 35–270 ms (~30 % of
 * the ride view's main thread in the 31 Oct profile). On WebGL 2 the rendered
 * photoreal tiles are intersected on the CPU instead (~3 ms).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Cesium from 'cesium';
import { getPhotorealTileset, liftAboveTerrain, sampleGroundHeight, setIonToken } from '@/lib/cesiumUtils';

async function photorealTileset(height: number | undefined) {
  const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
  Object.defineProperty(fake, 'show', { value: true, writable: true });
  // The mesh's height field. The app reads it down the local vertical
  // (meshHeightAt → tileset.pick), so the fake's pick answers from it at the
  // spot the ray goes through.
  const getHeight = vi.fn(() => height);
  Object.defineProperty(fake, 'getHeight', { value: getHeight });
  Object.defineProperty(fake, 'pick', {
    value: (ray: Cesium.Ray, frameState: unknown) => {
      // Like Cesium3DTileset.prototype.pick, which reads frameState.context
      // first: without the scene's frameState every photoreal frame throws.
      if (frameState !== FRAME_STATE) throw new TypeError("tileset.pick needs the scene's frameState");
      const c = Cesium.Cartographic.fromCartesian(ray.origin);
      const h = getHeight();
      return h === undefined ? undefined : Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, h);
    },
  });
  vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
  const tileset = await getPhotorealTileset();
  return { tileset, getHeight };
}

/** The fake scene's frameState (what the tile pick reads its GL context from). */
const FRAME_STATE = { context: { webgl2: true } };

function scene(tileset: Cesium.Cesium3DTileset | null, webgl2: boolean) {
  const sampleHeight = vi.fn(() => 999);
  const s = {
    context: { webgl2 },
    frameState: webgl2 ? FRAME_STATE : { context: { webgl2 } },
    primitives: { length: tileset ? 1 : 0, get: () => tileset },
    sampleHeightSupported: true,
    sampleHeight,
  } as unknown as Cesium.Scene;
  return { s, sampleHeight };
}

describe('sampleGroundHeight over the photoreal mesh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setIonToken(null);
  });

  it('uses the CPU tile intersection on WebGL 2, never the GPU pick', async () => {
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photorealTileset(331.4);
    const { s, sampleHeight } = scene(tileset, true);
    expect(sampleGroundHeight(s, 8.95, 46.0, [])).toBeCloseTo(331.4, 5);
    expect(getHeight).toHaveBeenCalledTimes(1);
    expect(sampleHeight).not.toHaveBeenCalled();
  });

  it('reports nothing (caller falls back to terrain) when the tiles under the spot are not loaded', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photorealTileset(undefined);
    const { s, sampleHeight } = scene(tileset, true);
    expect(sampleGroundHeight(s, 8.95, 46.0)).toBeUndefined();
    expect(sampleHeight).not.toHaveBeenCalled();
  });

  it('keeps the GPU pick on WebGL 1 (tiles hold no CPU copy there)', async () => {
    setIonToken('eyJ_test');
    const { tileset, getHeight } = await photorealTileset(331.4);
    const { s, sampleHeight } = scene(tileset, false);
    expect(sampleGroundHeight(s, 8.95, 46.0)).toBe(999);
    expect(getHeight).not.toHaveBeenCalled();
    expect(sampleHeight).toHaveBeenCalledTimes(1);
  });

  it('does not sample at all on the flat no-token globe', () => {
    setIonToken(null);
    const { s, sampleHeight } = scene(null, true);
    expect(sampleGroundHeight(s, 8.95, 46.0)).toBeUndefined();
    expect(sampleHeight).not.toHaveBeenCalled();
  });
});

describe('liftAboveTerrain (low chase / side cameras)', () => {
  afterEach(() => vi.restoreAllMocks());
  const heightOf = (c: Cesium.Cartesian3) => Cesium.Cartographic.fromCartesian(c).height;
  const terrainScene = (ground: number, tileset: Cesium.Cesium3DTileset | null = null) =>
    ({
      globe: { getHeight: () => ground },
      primitives: { length: tileset ? 1 : 0, get: () => tileset },
    }) as unknown as Cesium.Scene;

  it('lifts a camera that sank into a slope to the clearance', () => {
    const cam = Cesium.Cartesian3.fromDegrees(8.95, 46.0, 301);
    const lift = liftAboveTerrain(terrainScene(302), cam, 300, 1.2);
    expect(lift).toBeCloseTo(2.2, 3);
    expect(heightOf(cam)).toBeCloseTo(303.2, 3);
  });

  it('leaves a camera with enough clearance alone', () => {
    const cam = Cesium.Cartesian3.fromDegrees(8.95, 46.0, 305);
    expect(liftAboveTerrain(terrainScene(300), cam, 300, 1.2)).toBe(0);
    expect(heightOf(cam)).toBeCloseTo(305, 3);
  });

  it('ignores coarse-tile chords far from the rider height', () => {
    const cam = Cesium.Cartesian3.fromDegrees(8.95, 46.0, 302);
    expect(liftAboveTerrain(terrainScene(900), cam, 300, 1.2)).toBe(0);
  });

  it('lifts a camera out from under the opaque globe even while the photoreal mesh shows (the globe draws over it)', async () => {
    // Trasimeno shore, owner report 4 Nov: globe 309 m over a 300 m mesh; a
    // camera at 301 m sat under the globe and saw its underside as a ceiling.
    setIonToken('eyJ_test');
    const { tileset } = await photorealTileset(300);
    const cam = Cesium.Cartesian3.fromDegrees(8.95, 46.0, 301);
    expect(liftAboveTerrain(terrainScene(309, tileset), cam, 300, 1.2)).toBeCloseTo(9.2, 3);
    expect(heightOf(cam)).toBeCloseTo(310.2, 3);
    setIonToken(null);
  });

  it('does not lift for terrain the globe does not draw over the mesh (hidden or see-through)', async () => {
    setIonToken('eyJ_test');
    const { tileset } = await photorealTileset(300);
    const hidden = { ...terrainScene(309, tileset), globe: { show: false, getHeight: () => 309 } } as unknown as Cesium.Scene;
    expect(liftAboveTerrain(hidden, Cesium.Cartesian3.fromDegrees(8.95, 46.0, 301), 300, 1.2)).toBe(0);
    const veiled = {
      ...terrainScene(309, tileset),
      globe: { translucency: { enabled: true }, getHeight: () => 309 },
    } as unknown as Cesium.Scene;
    expect(liftAboveTerrain(veiled, Cesium.Cartesian3.fromDegrees(8.95, 46.0, 301), 300, 1.2)).toBe(0);
    setIonToken(null);
  });
});
