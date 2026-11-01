import { describe, expect, it } from 'vitest';

import { THREE_QUALITY, renderDpr, threeQuality } from './quality';
import { MIN_REAL_SUN_ALTITUDE_DEG, fogDensity, isWorldMood, moodLook, sunDirection, sunFor } from './skyModel';
import { createThreeWorldRenderer } from './threeWorldRenderer';
import { useSettingsStore } from '@/stores/settingsStore';

describe('world renderer quality tiers', () => {
  it("'medium' is the balanced 1080p tier; low is lighter, high heavier", () => {
    const { low, medium, high } = THREE_QUALITY;
    expect(medium.maxRenderPixels).toBe(1920 * 1080);
    expect(low.maxRenderPixels).toBeLessThan(medium.maxRenderPixels);
    expect(high.viewDistanceM).toBeGreaterThan(medium.viewDistanceM);
    expect(low.nearStep).toBeGreaterThan(medium.nearStep);
    expect(low.shadows).toBe(false);
    expect(threeQuality(undefined)).toBe(medium);
  });

  it('caps the pixel ratio by tier and pixel budget', () => {
    const m = THREE_QUALITY.medium;
    expect(renderDpr(m, 1920, 1080, 1)).toBe(1);
    expect(renderDpr(m, 1920, 1080, 2)).toBe(1);
    expect(renderDpr(m, 1280, 800, 2)).toBeCloseTo(1.42, 2);
    expect(renderDpr(THREE_QUALITY.low, 1920, 1080, 1)).toBeCloseTo(0.67, 2);
    expect(renderDpr(m, 390, 844, 3)).toBe(1.5);
  });
});

describe('sky model', () => {
  it('clear moods follow the real sun, held at least 15° up; weather moods pin it', () => {
    const noonJune = new Date(Date.UTC(2026, 5, 21, 11, 10));
    const s = sunFor(moodLook('clear-noon'), noonJune, 43.11, 12.39);
    expect(s.altitude).toBeGreaterThan(60);
    const night = new Date(Date.UTC(2026, 5, 21, 23, 0));
    const n = sunFor(moodLook('clear-noon'), night, 43.11, 12.39);
    expect(n.altitude).toBeGreaterThanOrEqual(MIN_REAL_SUN_ALTITUDE_DEG);
    expect(sunFor(moodLook('overcast'), noonJune, 43.11, 12.39)).toEqual({ azimuth: 200, altitude: 50 });
  });

  it('sun direction: azimuth clockwise from north, three.js north = −z', () => {
    const [x, y, z] = sunDirection(90, 0);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
    expect(sunDirection(0, 0)[2]).toBeCloseTo(-1);
    expect(sunDirection(0, 90)[1]).toBeCloseTo(1);
  });

  it('unknown moods fall back; fog is denser in fog moods', () => {
    expect(moodLook('nope')).toBe(moodLook('clear-afternoon'));
    expect(isWorldMood('valley-fog')).toBe(true);
    expect(isWorldMood('nope')).toBe(false);
    expect(fogDensity(8000, moodLook('valley-fog').fogFar)).toBeGreaterThan(fogDensity(8000, moodLook('clear-noon').fogFar));
    // ~98 % haze at the far end of the view.
    const d = fogDensity(8000, 1);
    expect(1 - Math.exp(-((d * 8000) ** 2))).toBeGreaterThan(0.97);
  });
});

describe('three WorldRenderer handle', () => {
  it("is kind 'world', forwards rider/mood overrides, persists camera mode, disposes once", () => {
    const calls: string[] = [];
    const r = createThreeWorldRenderer({
      setRiderOverride: (p) => calls.push(p ? 'rider' : 'rider:null'),
      setMoodOverride: (m) => calls.push(`mood:${m}`),
    });
    expect(r.kind).toBe('world');
    expect(r.native).toBeUndefined();
    r.setMood('golden-hour');
    r.setMood('not-a-mood');
    r.setRider({ lat: 0, lon: 0, ele: 0, heading: 0, grade: 0, speed: 0, distance: 0, laneOffsetM: 0 });
    r.setCamera('drone');
    expect(useSettingsStore.getState().cameraMode).toBe('drone');
    r.dispose();
    r.dispose();
    r.setMood('golden-hour');
    expect(calls).toEqual(['mood:golden-hour', 'mood:null', 'rider', 'rider:null', 'mood:null']);
    useSettingsStore.getState().setCameraMode('chase');
  });
});
