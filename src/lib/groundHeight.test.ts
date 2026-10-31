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
import { getPhotorealTileset, sampleGroundHeight, setIonToken } from '@/lib/cesiumUtils';

async function photorealTileset(height: number | undefined) {
  const fake = Object.create(Cesium.Cesium3DTileset.prototype) as Cesium.Cesium3DTileset;
  Object.defineProperty(fake, 'show', { value: true, writable: true });
  const getHeight = vi.fn(() => height);
  Object.defineProperty(fake, 'getHeight', { value: getHeight });
  vi.spyOn(Cesium.Cesium3DTileset, 'fromIonAssetId').mockResolvedValue(fake);
  const tileset = await getPhotorealTileset();
  return { tileset, getHeight };
}

function scene(tileset: Cesium.Cesium3DTileset | null, webgl2: boolean) {
  const sampleHeight = vi.fn(() => 999);
  const s = {
    context: { webgl2 },
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
