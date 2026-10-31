/**
 * Adaptive perf governor — pure logic over fake scene objects.
 * Mirrors the degrade ladder validated by CDP A/B on cat-bed (RTX 5090):
 * tier 'high' defaults ~18-36 fps → full ladder ~56 fps sustained.
 */
import { describe, it, expect } from 'vitest';
import type * as Cesium from 'cesium';

import {
  createPerfGovernor,
  PERF_EVAL_EVERY_MS,
  type PerfGovernor,
  type PerfGovernorDeps,
} from '@/lib/perf/perfGovernor';

// ---- fakes ----------------------------------------------------------------

interface FakeTileset {
  maximumScreenSpaceError: number;
  show: boolean;
  destroyed: boolean;
  isDestroyed: () => boolean;
}

function fakeTileset(sse = 16): FakeTileset {
  const t: FakeTileset = {
    maximumScreenSpaceError: sse,
    show: true,
    destroyed: false,
    isDestroyed: () => t.destroyed,
  };
  return t;
}

interface Fakes {
  deps: PerfGovernorDeps;
  viewer: {
    shadows: boolean;
    resolutionScale: number;
    isDestroyed: () => boolean;
    scene: {
      msaaSupported: boolean;
      msaaSamples: number;
      globe: { maximumScreenSpaceError: number };
      shadowMap: { enabled: boolean };
    };
  };
  photoreal: FakeTileset;
  osm: FakeTileset;
}

function fakes(opts: { withTilesets?: boolean; tierSse?: number } = {}): Fakes {
  const tierSse = opts.tierSse ?? 16;
  const photoreal = fakeTileset(tierSse);
  const osm = fakeTileset(tierSse);
  const viewer = {
    destroyed: false,
    shadows: true,
    resolutionScale: 1,
    isDestroyed() {
      return this.destroyed;
    },
    scene: {
      msaaSupported: true,
      msaaSamples: 4,
      globe: { maximumScreenSpaceError: 2 },
      shadowMap: { enabled: true },
    },
  };
  const withTilesets = opts.withTilesets ?? true;
  const deps: PerfGovernorDeps = {
    viewer: viewer as unknown as Cesium.Viewer,
    getTilesets: () => (withTilesets ? [photoreal, osm] : []),
  };
  return {
    deps,
    viewer: viewer as unknown as Fakes['viewer'],
    photoreal,
    osm,
  };
}

/** Advance simulated time at a fixed frame duration. */
function drive(g: PerfGovernor, clock: { t: number }, frameMs: number, durationMs: number): void {
  const frames = Math.floor(durationMs / frameMs);
  for (let i = 0; i < frames; i++) {
    clock.t += frameMs;
    g.frame(clock.t);
  }
}

// ---- tests ----------------------------------------------------------------

describe('createPerfGovernor', () => {
  it('does not degrade a scene that holds the frame budget', () => {
    const f = fakes();
    const g = createPerfGovernor(f.deps);
    const clock = { t: 1000 };
    drive(g, clock, 16.7, 10_000); // 60 fps for 10 s
    expect(g.state().level).toBe(0);
    expect(f.viewer.scene.msaaSamples).toBe(4);
    expect(f.viewer.scene.shadowMap.enabled).toBe(true);
    expect(f.photoreal.maximumScreenSpaceError).toBe(16);
    expect(f.viewer.resolutionScale).toBe(1);
  });

  it('steps the full ladder down when frames stay over budget', () => {
    const f = fakes();
    const g = createPerfGovernor(f.deps);
    const clock = { t: 1000 };
    // 30 fps for 60 s — every window is over the 18 ms budget.
    drive(g, clock, 33.3, 60_000);
    const st = g.state();
    expect(st.steps).toEqual([
      'msaa-off',
      'globe-sse-4',
      'tileset-sse-24',
      'tileset-sse-32',
      'shadow-map-off',
      'tileset-sse-48',
      'resolution-scale-075',
    ]);
    expect(st.level).toBe(7);
    expect(f.viewer.scene.msaaSamples).toBe(1);
    expect(f.viewer.scene.globe.maximumScreenSpaceError).toBe(4);
    expect(f.photoreal.maximumScreenSpaceError).toBe(48);
    expect(f.osm.maximumScreenSpaceError).toBe(48);
    expect(f.viewer.scene.shadowMap.enabled).toBe(false);
    expect(f.viewer.shadows).toBe(false);
    expect(f.viewer.resolutionScale).toBe(0.75);
  });

  it('honours hysteresis — one bad window alone never degrades', () => {
    const f = fakes();
    const g = createPerfGovernor(f.deps);
    const clock = { t: 1000 };
    drive(g, clock, 16.7, 4_000);                    // two good windows
    drive(g, clock, 33.3, PERF_EVAL_EVERY_MS + 100); // one bad window
    expect(g.state().level).toBe(0);
    drive(g, clock, 16.7, 4_000);                    // recovers
    expect(g.state().level).toBe(0);
    expect(g.state().lastAvgFrameMs).toBeLessThan(18);
  });

  it('stops degrading once the budget holds, and never steps back up', () => {
    const f = fakes();
    const g = createPerfGovernor(f.deps);
    const clock = { t: 1000 };
    drive(g, clock, 33.3, 12_000); // long enough for the first steps
    const mid = g.state();
    expect(mid.level).toBeGreaterThan(0);
    // Scene suddenly becomes fast (e.g. tiles finished streaming). At most
    // one straggler window (mixed slow+fast frames) may still step; after
    // that the good budget must hold the ladder still — and never rewind.
    drive(g, clock, 10, 30_000);
    const settled = g.state().level;
    expect(settled).toBeLessThanOrEqual(mid.level + 1);
    const msaaSettled = f.viewer.scene.msaaSamples;
    drive(g, clock, 10, 30_000);
    expect(g.state().level).toBe(settled); // no further degrade
    expect(f.viewer.scene.msaaSamples).toBe(msaaSettled); // and no upgrade
    expect(g.state().lastAvgFrameMs).toBeLessThan(18);
  });

  it('paces steps by the cooldown, not per window', () => {
    const f = fakes();
    const g = createPerfGovernor(f.deps, {
      evalEveryMs: 500,
      cooldownMs: 2_000,
      hysteresis: 1,
    });
    const clock = { t: 1000 };
    drive(g, clock, 33.3, 1_000); // 2 bad windows in 1 s — hysteresis met
    expect(g.state().level).toBe(1); // but only ONE step (cooldown gates the rest)
    drive(g, clock, 33.3, 1_500);
    expect(g.state().level).toBe(1); // still cooling down
    drive(g, clock, 33.3, 1_000);
    expect(g.state().level).toBe(2);
  });

  it('skips ladder steps that do not apply to this scene', () => {
    const f = fakes({ withTilesets: false });
    const g = createPerfGovernor(f.deps);
    const clock = { t: 1000 };
    drive(g, clock, 33.3, 60_000);
    const st = g.state();
    // Tileset SSE steps are skipped; the rest still apply.
    expect(st.steps).toEqual([
      'msaa-off',
      'globe-sse-4',
      'shadow-map-off',
      'resolution-scale-075',
    ]);
    expect(f.viewer.scene.msaaSamples).toBe(1);
    expect(f.viewer.scene.shadowMap.enabled).toBe(false);
    expect(f.viewer.resolutionScale).toBe(0.75);
  });

  it('never raises quality above the tier baseline (low tier stays put)', () => {
    // A 'low'-tier scene: MSAA 1, globe SSE 4, tile SSE 32, shadows off,
    // resolution 0.75 — only the beyond-tier SSE step and nothing else may
    // apply, and values must never move the wrong way.
    const f = fakes({ tierSse: 32 });
    f.viewer.scene.msaaSamples = 1;
    f.viewer.scene.globe.maximumScreenSpaceError = 4;
    f.viewer.scene.shadowMap.enabled = false;
    f.viewer.shadows = false;
    f.viewer.resolutionScale = 0.75;
    const g = createPerfGovernor(f.deps);
    const clock = { t: 1000 };
    drive(g, clock, 33.3, 60_000);
    expect(g.state().steps).toEqual(['tileset-sse-48']);
    expect(f.photoreal.maximumScreenSpaceError).toBe(48);
    expect(f.viewer.scene.msaaSamples).toBe(1);
    expect(f.viewer.resolutionScale).toBe(0.75);
  });

  it('ignores tab-out stalls instead of counting them as frames', () => {
    const f = fakes();
    const g = createPerfGovernor(f.deps);
    const clock = { t: 1000 };
    drive(g, clock, 16.7, 4_000);
    clock.t += 60_000; // tab hidden for a minute
    g.frame(clock.t);
    drive(g, clock, 16.7, 4_000);
    expect(g.state().level).toBe(0);
  });

  it('disposes: no further state changes, and a destroyed viewer self-disposes', () => {
    const f = fakes();
    const g = createPerfGovernor(f.deps);
    const clock = { t: 1000 };
    g.dispose();
    drive(g, clock, 33.3, 30_000);
    expect(g.state().level).toBe(0);
    expect(g.state().disposed).toBe(true);

    const f2 = fakes();
    const g2 = createPerfGovernor(f2.deps);
    (f2.viewer as unknown as { destroyed: boolean }).destroyed = true;
    drive(g2, clock, 33.3, 30_000);
    expect(g2.state().level).toBe(0);
    expect(g2.state().disposed).toBe(true);
  });
});
