/**
 * Mood fog must stay see-through at rider height. Cesium's Fog multiplies
 * density by heightScalar (default 0.001); assigning the moods' ~1.0 values
 * raw made fog ~1000x too dense and blacked out the ground.
 */
import { describe, it, expect } from 'vitest';
import * as Cesium from 'cesium';
import { MOODS, applySceneMood, CESIUM_FOG_HEIGHT_SCALAR, type MoodId } from '@/lib/cesiumUtils';

/** Fog.update() density for a camera `heightM` above the ellipsoid, looking at the horizon. */
function effectiveDensity(fog: Cesium.Fog, heightM: number): number {
  const f = fog as Cesium.Fog & { heightScalar: number; maxHeight: number; heightFalloff: number };
  return f.density * f.heightScalar * Math.pow(Math.max(heightM / f.maxHeight, 1e-4), -f.heightFalloff);
}

function fakeViewer(): Cesium.Viewer {
  const scene = { fog: new Cesium.Fog(), skyAtmosphere: undefined, atmosphere: undefined };
  return { isDestroyed: () => false, scene } as unknown as Cesium.Viewer;
}

describe('mood fog', () => {
  it.each(Object.keys(MOODS) as MoodId[])('%s: heightScalar is a multiple of the Cesium default', (mood) => {
    const viewer = fakeViewer();
    applySceneMood(viewer, mood);
    const fog = viewer.scene.fog as Cesium.Fog & { heightScalar: number };
    expect(fog.heightScalar).toBeCloseTo(CESIUM_FOG_HEIGHT_SCALAR * MOODS[mood].fogHeightScalar, 9);
  });

  it.each(Object.keys(MOODS) as MoodId[])('%s: fog at 30 m stays light enough to see the road', (mood) => {
    const viewer = fakeViewer();
    applySceneMood(viewer, mood);
    // Cesium's own default fog at 30 m, times 3: generous headroom for
    // valley-fog, far below the old blackout (~1000x).
    const ref = new Cesium.Fog();
    expect(effectiveDensity(viewer.scene.fog, 30)).toBeLessThan(effectiveDensity(ref, 30) * 3);
  });

  it('valley fog is the densest mood', () => {
    const d = (m: MoodId) => MOODS[m].fogDensity * MOODS[m].fogHeightScalar;
    for (const m of Object.keys(MOODS) as MoodId[]) {
      if (m !== 'valley-fog') expect(d('valley-fog')).toBeGreaterThan(d(m));
    }
  });
});
