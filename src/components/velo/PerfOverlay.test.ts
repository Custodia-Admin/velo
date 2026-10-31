/**
 * Regression: the ride view's performance readout must expose the frame rate.
 *
 * The owner reported stutter on the Arc iGPU (31 Oct 2026) and there was no
 * on-screen number to point at. `?perf=1` shows the fps / frame-time / tile
 * readout, and `window.__veloPerf()` returns the same numbers to
 * scripts/perf-ride.py. These tests fail if the readout stops showing fps,
 * the measurement stops publishing, or the ride view stops mounting it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as Cesium from 'cesium';
import { PerfReadout } from '@/components/velo/PerfOverlay';
import { EMPTY_PERF, attachScenePerf, getPerfSnapshot, PUBLISH_MS, type ScenePerf } from '@/lib/perf/scenePerf';

type Listener = (...args: unknown[]) => void;
function fakeEvent() {
  const ls = new Set<Listener>();
  return {
    addEventListener: (l: Listener) => ls.add(l),
    removeEventListener: (l: Listener) => ls.delete(l),
    raise: (...args: unknown[]) => ls.forEach((l) => l(...args)),
    size: () => ls.size,
  };
}

function fakeViewer() {
  const postRender = fakeEvent();
  const tileLoadProgressEvent = fakeEvent();
  const tileset = { show: true, tilesLoaded: false, statistics: { numberOfPendingRequests: 3, numberOfTilesProcessing: 1 } };
  const viewer = {
    isDestroyed: () => false,
    resolutionScale: 0.85,
    scene: {
      postRender,
      globe: { tileLoadProgressEvent },
      primitives: { length: 1, get: () => tileset },
      canvas: { width: 1632, height: 918 },
      msaaSamples: 2,
      requestRenderMode: false,
    },
  };
  return { viewer: viewer as unknown as Cesium.Viewer, postRender, tileLoadProgressEvent };
}

const ROOT = resolve(__dirname, '../../..');

describe('perf overlay exposes fps', () => {
  const g = globalThis as unknown as { window?: Record<string, unknown> };
  let hadWindow = false;
  beforeEach(() => {
    hadWindow = 'window' in g;
    if (!hadWindow) g.window = { devicePixelRatio: 1.75 };
  });
  afterEach(() => {
    if (!hadWindow) delete g.window;
  });

  it('measures Cesium frames and publishes fps, frame time and tile streaming', () => {
    const { viewer, postRender, tileLoadProgressEvent } = fakeViewer();
    let t = 1000;
    const detach = attachScenePerf(viewer, () => t);
    tileLoadProgressEvent.raise(12);
    // 3 s at a steady 20 ms (50 fps) with one 120 ms hitch.
    for (let i = 0; i < 150; i++) {
      t += i === 75 ? 120 : 20;
      postRender.raise();
    }
    const snap = getPerfSnapshot();
    expect(snap.frames).toBeGreaterThan(100);
    expect(snap.fps).toBeGreaterThan(40);
    expect(snap.fps).toBeLessThan(55);
    expect(snap.worstMs).toBe(120);
    expect(snap.jankPct).toBeGreaterThan(0);
    expect(snap.tiles).toMatchObject({ globeQueued: 12, tilesetPending: 3, tilesetProcessing: 1, settled: false });
    expect(snap.msaa).toBe(2);
    expect(snap.resolutionScale).toBe(0.85);

    // The script reads the same numbers.
    const w = g.window as { __veloPerf?: () => ScenePerf };
    expect(typeof w.__veloPerf).toBe('function');
    expect(w.__veloPerf!().fps).toBeCloseTo(snap.fps, 0);

    detach();
    expect(postRender.size()).toBe(0);
    expect(w.__veloPerf).toBeUndefined();
    expect(getPerfSnapshot()).toBe(EMPTY_PERF);
  });

  it('does not count an idle gap (render-on-demand, hidden tab) as a slow frame', () => {
    const { viewer, postRender } = fakeViewer();
    let t = 1000;
    const detach = attachScenePerf(viewer, () => t);
    for (let i = 0; i < 60; i++) {
      t += i === 30 ? 5000 : 16;
      postRender.raise();
    }
    t += PUBLISH_MS;
    postRender.raise();
    expect(getPerfSnapshot().worstMs).toBeLessThan(PUBLISH_MS + 1);
    detach();
  });

  it('renders the fps, frame-time and tile lines', () => {
    const perf: ScenePerf = {
      ...EMPTY_PERF,
      fps: 47.6,
      avgMs: 21,
      p95Ms: 31.2,
      worstMs: 80,
      jankPct: 3,
      frames: 240,
      tiles: { globeQueued: 4, tilesetPending: 2, tilesetProcessing: 1, settled: false },
      canvas: [1632, 918],
      resolutionScale: 0.85,
      dpr: 1.75,
      msaa: 2,
    };
    const html = renderToStaticMarkup(createElement(PerfReadout, { perf, quality: 'medium' }));
    expect(html).toContain('48 fps');
    expect(html).toContain('data-perf-fps="48"');
    expect(html).toContain('p95 31.2 ms');
    expect(html).toContain('tiles loading 7');
    expect(html).toContain('aria-label="Performance"');
  });

  it('says it is measuring before the first frames arrive', () => {
    const html = renderToStaticMarkup(createElement(PerfReadout, { perf: EMPTY_PERF, quality: 'high' }));
    expect(html).toContain('Measuring');
    expect(html).not.toContain(' fps<');
  });

  it('the ride view mounts the overlay and the viewer attaches the measurement', () => {
    const ride = readFileSync(join(ROOT, 'src/routes/Ride.tsx'), 'utf8');
    const viewerSrc = readFileSync(join(ROOT, 'src/renderers/cesium/CesiumWorldView.tsx'), 'utf8');
    expect(ride).toMatch(/<PerfOverlay\b/);
    expect(viewerSrc).toMatch(/attachScenePerf\(/);
  });
});
