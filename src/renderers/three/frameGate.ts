/**
 * Frames in flight: how far the world canvas may draw ahead of the GPU.
 *
 * A browser normally holds requestAnimationFrame back when the GPU falls
 * behind (swap-chain back pressure), so a slow GPU means a lower frame rate,
 * not a queue. Not every browser does. Playwright's headless shell (CI's
 * browser) has none: on SwiftShader the page kept submitting frames at the
 * rAF rate, ~10 s of riding at medium, 1920×1080 queued 35–75 s of GPU work,
 * and leaving the ride (the WebGL context is destroyed, which waits for every
 * queued command) froze the tab for that long before Home painted.
 *
 * The gate fences every frame it lets through (`fenceSync`) and polls the
 * fences without blocking (`clientWaitSync(fence, 0, 0)`). A frame it holds
 * back is not drawn at all; the scene still updates, and the next frame the
 * GPU has room for draws the latest state.
 *
 * It holds a frame while the unfinished frames add up to `budgetMs` or more of
 * GPU work, at the time the GPU has recently taken per frame. That time comes
 * from the fences: from when the GPU could start a frame (the frame before it
 * seen done, or the frame submitted, whichever came later) to when it was seen
 * done, smoothed. Until a frame has been timed, `untimedInFlight` frames is
 * the limit. A GPU slower than the budget per frame gets one frame at a time:
 * CI's runners took 6.6 s per 1080p frame on SwiftShader with a second test
 * running (run 43130528642), and two in flight there kept the way Home waiting
 * 13 s.
 *
 * Why not a frame count alone: Chrome reports a fence done well after the
 * frame was submitted on a real GPU, up to 1.2 s with vsync off on cat-bed's
 * Intel iGPU, where ~95 frames at a time read as unfinished at 105–113 fps.
 * A two-frame limit took the Arc laptop from 60 to 48 fps at 60 Hz, and
 * cat-bed down to as little as half its frames with vsync off. Counted in GPU
 * time, those frames stay far under the budget and a real GPU is not held
 * back, while a software rasterizer taking ~1.5 s per 1080p frame (SwiftShader
 * on 4 cores) is held to 2 frames.
 *
 * A GPU that suddenly gets much slower is caught once its slower frames are
 * seen done; until then frames go in at the old pace. Only a browser with no
 * back pressure queues at all, and CI's software GL is slow from its first
 * frame, so that is left as is.
 *
 * Pure: the WebGL calls come in through {@link FenceGL} and the clock as an
 * argument, so tests drive it with a fake GPU.
 */

/** A poll this long after the one before can't time what it sees done (ms): the frame may have finished any time in the gap. */
export const TIMED_POLL_GAP_MS = 250;

export interface FrameGateOptions {
  /** Unfinished frames allowed before the GPU's time per frame is known (two keep a GPU busy: one drawing, one queued). */
  untimedInFlight: number;
  /** GPU work (ms) the unfinished frames may add up to before the next frame is held. */
  budgetMs: number;
  /** Weight of the newest frame in the smoothed GPU time per frame (0–1). */
  smoothing: number;
}

export const FRAME_GATE_DEFAULTS: FrameGateOptions = { untimedInFlight: 2, budgetMs: 3000, smoothing: 0.2 };

/** The WebGL 2 sync calls the gate uses (a WebGL2RenderingContext has them all). */
export interface FenceGL {
  fenceSync(condition: number, flags: number): WebGLSync | null;
  clientWaitSync(sync: WebGLSync, flags: number, timeout: number): number;
  deleteSync(sync: WebGLSync | null): void;
  readonly SYNC_GPU_COMMANDS_COMPLETE: number;
  readonly TIMEOUT_EXPIRED: number;
}

/** A context that can fence (WebGL 2), or null (WebGL 1, a test double without sync objects). */
export function fenceGL(ctx: unknown): FenceGL | null {
  const gl = ctx as Partial<FenceGL> | null | undefined;
  return gl && typeof gl.fenceSync === 'function' && typeof gl.clientWaitSync === 'function' && typeof gl.deleteSync === 'function'
    ? (gl as FenceGL)
    : null;
}

export class FrameGate {
  /** Frames drawn. */
  drawn = 0;
  /** Frames held back because the GPU was behind. */
  held = 0;
  readonly options: FrameGateOptions;
  private frames: Array<{ sync: WebGLSync; at: number }> = [];
  /** Smoothed GPU time per frame (ms); null until a frame has been timed. */
  private frameMs: number | null = null;
  /** When the last frame was seen done. */
  private lastDoneAt = -Infinity;
  /** When the fences were last polled. */
  private lastPollAt = -Infinity;
  private gl: FenceGL | null = null;

  constructor(options: Partial<FrameGateOptions> = {}) {
    this.options = { ...FRAME_GATE_DEFAULTS, ...options };
  }

  /** Fenced frames the GPU has not finished yet (as of the last poll). */
  get inFlight(): number {
    return this.frames.length;
  }

  /** Smoothed GPU time per frame (ms), null until a frame has been timed. */
  get gpuFrameMs(): number | null {
    return this.frameMs;
  }

  /** GPU work still queued (ms): null while no frame has been timed yet. */
  queuedMs(): number | null {
    const n = this.frames.length;
    if (n === 0) return 0;
    return this.frameMs === null ? null : n * this.frameMs;
  }

  /**
   * Draws this frame (`draw`) and fences it, unless the GPU is too far behind
   * (see the module comment). `nowMs` is a monotonic clock. With no sync
   * objects (`gl` null) every frame draws. Returns whether it drew.
   */
  submit(gl: FenceGL | null, nowMs: number, draw: () => void): boolean {
    if (gl !== this.gl) this.dispose();
    this.gl = gl;
    if (gl) {
      // A frame is timed to the poll that saw it done, so only polls close after the last one
      // time anything (not the first one after the finish page or a hidden tab).
      const timed = nowMs - this.lastPollAt < TIMED_POLL_GAP_MS;
      this.lastPollAt = nowMs;
      // The GPU finishes frames in order: the oldest unfinished fence ends the scan.
      while (this.frames.length > 0 && gl.clientWaitSync(this.frames[0].sync, 0, 0) !== gl.TIMEOUT_EXPIRED) {
        // ALREADY_SIGNALED, CONDITION_SATISFIED, or WAIT_FAILED (a lost context: nothing is queued any more).
        const done = this.frames.shift()!;
        gl.deleteSync(done.sync);
        // The first frame seen done has no frame before it to time from (its time would be the
        // whole submit -> seen-done lag); timing starts with the second.
        if (timed && this.lastDoneAt > -Infinity) {
          const took = nowMs - Math.max(this.lastDoneAt, done.at);
          this.frameMs = this.frameMs === null ? took : this.frameMs + this.options.smoothing * (took - this.frameMs);
        }
        this.lastDoneAt = nowMs;
      }
      const queued = this.queuedMs();
      const behind = queued === null ? this.frames.length >= this.options.untimedInFlight : queued > 0 && queued >= this.options.budgetMs;
      if (behind) {
        this.held++;
        return false;
      }
    }
    draw();
    this.drawn++;
    if (gl) {
      // Null on a lost context: nothing to wait for.
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (sync) this.frames.push({ sync, at: nowMs });
    }
    return true;
  }

  /** Deletes the fences still held and forgets the GPU's pace (the canvas or its context goes away). */
  dispose(): void {
    if (this.gl) for (const f of this.frames) this.gl.deleteSync(f.sync);
    this.frames = [];
    this.frameMs = null;
    this.lastDoneAt = -Infinity;
    this.lastPollAt = -Infinity;
  }
}
