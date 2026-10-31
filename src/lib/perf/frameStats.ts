/**
 * Frame-time statistics for the ride view — the numbers behind the perf
 * overlay (`?perf=1`) and `window.__veloPerf()` (read by
 * scripts/perf-ride.py). Pure ring buffer; no Cesium, no DOM.
 */

/** Frames kept for the rolling window (~4 s at 60 fps). */
export const FRAME_WINDOW = 240;
/** A frame slower than this misses a 30 fps beat — counted as a stutter. */
export const JANK_MS = 1000 / 30 + 0.5;

export interface FrameSnapshot {
  /** Frames per second over the window (frames ÷ summed frame time). */
  fps: number;
  /** Mean frame time, ms. */
  avgMs: number;
  /** 95th-percentile frame time, ms — the stutter you feel. */
  p95Ms: number;
  /** Slowest frame in the window, ms. */
  worstMs: number;
  /** Share of frames slower than {@link JANK_MS}, 0–100. */
  jankPct: number;
  /** Frames in the window. */
  frames: number;
}

export const EMPTY_SNAPSHOT: FrameSnapshot = { fps: 0, avgMs: 0, p95Ms: 0, worstMs: 0, jankPct: 0, frames: 0 };

export class FrameStats {
  private readonly buf: Float64Array;
  private next = 0;
  private count = 0;

  constructor(readonly size = FRAME_WINDOW) {
    this.buf = new Float64Array(size);
  }

  /** Record one frame's duration (ms). Non-finite / non-positive values are ignored. */
  push(frameMs: number): void {
    if (!(frameMs > 0) || !Number.isFinite(frameMs)) return;
    this.buf[this.next] = frameMs;
    this.next = (this.next + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  reset(): void {
    this.next = 0;
    this.count = 0;
  }

  snapshot(): FrameSnapshot {
    const n = this.count;
    if (n === 0) return EMPTY_SNAPSHOT;
    const values = Array.from(this.buf.subarray(0, n));
    let sum = 0;
    let worst = 0;
    let jank = 0;
    for (const v of values) {
      sum += v;
      if (v > worst) worst = v;
      if (v > JANK_MS) jank++;
    }
    values.sort((a, b) => a - b);
    const p95 = values[Math.min(n - 1, Math.floor(n * 0.95))];
    return {
      fps: round1(1000 / (sum / n)),
      avgMs: round1(sum / n),
      p95Ms: round1(p95),
      worstMs: round1(worst),
      jankPct: round1((100 * jank) / n),
      frames: n,
    };
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Tile streaming state read from the scene each sample. */
export interface TileLoadState {
  /** Globe terrain/imagery tiles still queued (Cesium's tileLoadProgressEvent). */
  globeQueued: number;
  /** 3D tiles (photoreal / OSM buildings) requested but not yet received. */
  tilesetPending: number;
  /** 3D tiles received and still being decoded/uploaded. */
  tilesetProcessing: number;
  /** All visible tiles loaded (globe and every shown tileset). */
  settled: boolean;
}

export const EMPTY_TILES: TileLoadState = { globeQueued: 0, tilesetPending: 0, tilesetProcessing: 0, settled: true };

/** One-line readout for the overlay and bug reports. */
export function formatPerfLine(f: FrameSnapshot, t: TileLoadState): string {
  if (f.frames === 0) return 'measuring…';
  const tiles = t.settled
    ? 'tiles settled'
    : `tiles ${t.globeQueued + t.tilesetPending + t.tilesetProcessing} loading`;
  return `${Math.round(f.fps)} fps · ${f.avgMs.toFixed(1)} ms (p95 ${f.p95Ms.toFixed(1)}) · ${tiles}`;
}
