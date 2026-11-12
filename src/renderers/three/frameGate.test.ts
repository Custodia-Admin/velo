/**
 * The frame gate (frameGate.ts) against a simulated GPU: frames queue in
 * order, each takes `gpuMs` of GPU time, and a frame's fence reads as done
 * `lagMs` after the GPU finished it (Chrome reports fences late), polled once
 * per requestAnimationFrame.
 */
import { describe, expect, it } from 'vitest';

import { fenceGL, FRAME_GATE_DEFAULTS, FrameGate, type FenceGL } from './frameGate';

const ALREADY_SIGNALED = 0x911a;
const TIMEOUT_EXPIRED = 0x911b;
const WAIT_FAILED = 0x911d;
const RAF_MS = 1000 / 60;

interface SimFrame {
  submitted: number;
  done: number;
  deleted: boolean;
}

/** A GPU on a clock the test advances: in-order frames, `gpuMs(i)` each, fences seen `lagMs` late. */
function simGpu(opts: { gpuMs: number | ((i: number) => number); lagMs?: number }) {
  const cost = typeof opts.gpuMs === 'number' ? () => opts.gpuMs as number : opts.gpuMs;
  const lag = opts.lagMs ?? 0;
  const frames: SimFrame[] = [];
  let now = 0;
  let freeAt = 0;
  let lost = false;
  const live = new Set<SimFrame>();
  const gl: FenceGL & { polls: number } = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    TIMEOUT_EXPIRED,
    polls: 0,
    fenceSync: (condition, flags) => {
      expect([condition, flags]).toEqual([0x9117, 0]);
      if (lost) return null;
      // Fenced right after the frame's draw.
      const f = frames[frames.length - 1];
      live.add(f);
      return f as unknown as WebGLSync;
    },
    clientWaitSync: (sync, flags, timeout) => {
      // Non-blocking polls only.
      expect([flags, timeout]).toEqual([0, 0]);
      gl.polls++;
      if (lost) return WAIT_FAILED;
      return now >= (sync as unknown as SimFrame).done + lag ? ALREADY_SIGNALED : TIMEOUT_EXPIRED;
    },
    deleteSync: (sync) => {
      const f = sync as unknown as SimFrame;
      expect(live.has(f)).toBe(true);
      live.delete(f);
      f.deleted = true;
    },
  };
  return {
    gl,
    frames,
    live,
    get now() {
      return now;
    },
    set now(t: number) {
      now = t;
    },
    /** The draw callback: one frame's commands go in now. */
    draw: () => {
      const start = Math.max(now, freeAt);
      freeAt = start + cost(frames.length);
      frames.push({ submitted: now, done: freeAt, deleted: false });
    },
    /** GPU work still queued (ms). */
    backlogMs: () => Math.max(0, freeAt - now),
    lose: () => {
      lost = true;
    },
  };
}

/** `ticks` rAF callbacks through the gate; the worst backlog and frames in flight seen. */
function run(gpu: ReturnType<typeof simGpu>, gate: FrameGate, ticks: number, from = 0) {
  let worstBacklog = 0;
  let worstInFlight = 0;
  let drawn = 0;
  for (let k = 0; k < ticks; k++) {
    gpu.now = from + k * RAF_MS;
    if (gate.submit(gpu.gl, gpu.now, gpu.draw)) drawn++;
    worstBacklog = Math.max(worstBacklog, gpu.backlogMs());
    worstInFlight = Math.max(worstInFlight, gate.inFlight);
  }
  return { drawn, worstBacklog, worstInFlight, end: from + ticks * RAF_MS };
}

/** A plain two-frame count limit on the same fences (the first version of the gate): frames held in `ticks` rAFs. */
function countLimited(gpu: ReturnType<typeof simGpu>, ticks: number): number {
  const syncs: WebGLSync[] = [];
  let held = 0;
  for (let k = 0; k < ticks; k++) {
    gpu.now = k * RAF_MS;
    while (syncs.length > 0 && gpu.gl.clientWaitSync(syncs[0], 0, 0) !== TIMEOUT_EXPIRED) gpu.gl.deleteSync(syncs.shift()!);
    if (syncs.length >= 2) {
      held++;
      continue;
    }
    gpu.draw();
    syncs.push(gpu.gl.fenceSync(gpu.gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!);
  }
  return held;
}

describe('FrameGate', () => {
  it('defaults: two frames until the GPU is timed, then up to 3 s of GPU work', () => {
    expect(FRAME_GATE_DEFAULTS).toEqual({ untimedInFlight: 2, budgetMs: 3000, smoothing: 0.2 });
  });

  it('never holds back a GPU that keeps up', () => {
    const gpu = simGpu({ gpuMs: 8 });
    const gate = new FrameGate();
    const r = run(gpu, gate, 600);
    expect([r.drawn, gate.held]).toEqual([600, 0]);
    // Seen done at the next rAF's poll: one rAF interval a frame (an over-estimate, on the safe side).
    expect(gate.gpuFrameMs).toBeLessThanOrEqual(RAF_MS + 0.01);
  });

  it("never holds back a real GPU whose fences Chrome reports late (a frame count would)", () => {
    // 60 fps, fences seen 150-900 ms after the GPU finished (cat-bed iGPU: up to 1.2 s, vsync off): 10-55 frames look unfinished.
    for (const lagMs of [150, 400, 900]) {
      const gpu = simGpu({ gpuMs: 14, lagMs });
      const gate = new FrameGate();
      // Until two frames are seen done, two frames is the limit: about the first two lags of the ride.
      const warm = run(gpu, gate, 180);
      expect(gate.held, `lag ${lagMs} ms, warm-up`).toBeLessThanOrEqual((2 * lagMs) / RAF_MS);
      const held = gate.held;
      const r = run(gpu, gate, 1200, warm.end);
      expect(gate.held - held, `lag ${lagMs} ms`).toBe(0);
      expect(r.worstInFlight).toBeGreaterThan(lagMs / RAF_MS - 1);
      // The same GPU behind a two-frame count limit loses frames.
      expect(countLimited(simGpu({ gpuMs: 14, lagMs }), 1380), `lag ${lagMs} ms, two-frame limit`).toBeGreaterThan(600);
    }
  });

  it('after a pause (the finish page, a hidden tab) a real GPU draws on at once', () => {
    const gpu = simGpu({ gpuMs: 14, lagMs: 150 });
    const gate = new FrameGate();
    const warm = run(gpu, gate, 180);
    const held = gate.held;
    const pace = gate.gpuFrameMs!;
    expect(gate.inFlight).toBeGreaterThan(5);
    // 30 s with no frames, then riding again: the frames left in flight are seen done at the first
    // poll, which can't time them (they read as 30 s frames otherwise), and the pace carries on.
    gpu.now = warm.end + 30_000;
    gate.submit(gpu.gl, gpu.now, gpu.draw);
    expect(gate.gpuFrameMs).toBe(pace);
    run(gpu, gate, 600, gpu.now + RAF_MS);
    expect(gate.held - held).toBe(0);
  });

  it('a GPU-bound real GPU keeps every frame it can draw', () => {
    // 25 ms a frame against 16.7 ms rAF (a browser without back pressure): the GPU's own rate, 40 fps.
    const gpu = simGpu({ gpuMs: 25, lagMs: 150 });
    const gate = new FrameGate();
    const warm = run(gpu, gate, 60);
    const finishedBy = (t: number) => gpu.frames.filter((f) => f.done <= t).length;
    const start = finishedBy(warm.end);
    const r = run(gpu, gate, 1200, warm.end);
    // 20 s: the GPU can finish 800 frames, and the queue it is allowed keeps it busy all the way.
    expect(finishedBy(r.end) - start).toBeGreaterThanOrEqual(799);
    expect(r.worstBacklog).toBeLessThanOrEqual(FRAME_GATE_DEFAULTS.budgetMs + 25);
  });

  it('holds a software rasterizer (2 s a frame) to two frames: ~4 s of work, not a minute', () => {
    const gpu = simGpu({ gpuMs: 2000, lagMs: 20 });
    const gate = new FrameGate();
    // 10 s of riding at 60 rAF/s, as on CI's headless shell.
    const r = run(gpu, gate, 600);
    expect(r.worstInFlight).toBe(2);
    expect(r.worstBacklog).toBeLessThanOrEqual(4000);
    // Every frame it drew the GPU had room for: two to start, then one per finished frame.
    expect(r.drawn).toBe(2 + gpu.frames.filter((f) => f.done + 20 <= r.end - RAF_MS).length);
    expect(gate.held).toBe(600 - r.drawn);
    // Without the gate those 600 frames would queue 20 minutes of work.
    expect(600 * 2000).toBeGreaterThan(1_000_000);
  });

  it("a GPU slower than the budget per frame gets one frame at a time once timed (CI's runners: 6.6 s)", () => {
    const gpu = simGpu({ gpuMs: 6600, lagMs: 20 });
    const gate = new FrameGate();
    // Two frames until two are seen done and the second is timed (~13 s), then one at a time.
    const warm = run(gpu, gate, 60 * 15);
    expect(gate.gpuFrameMs).toBeCloseTo(6600, -2);
    const r = run(gpu, gate, 60 * 60, warm.end);
    expect(r.worstInFlight).toBe(1);
    // Leaving the ride never waits for more than the one frame on the GPU.
    expect(r.worstBacklog).toBeLessThanOrEqual(6600 + 1e-6);
    // And the GPU stays busy: ~9 frames a minute.
    expect(r.drawn).toBeGreaterThanOrEqual(8);
  });

  it('a mid-speed GPU queues up to the budget, not past it', () => {
    const gpu = simGpu({ gpuMs: 300 });
    const gate = new FrameGate();
    const r = run(gpu, gate, 1200);
    expect(r.worstBacklog).toBeLessThanOrEqual(FRAME_GATE_DEFAULTS.budgetMs + 300);
    expect(r.worstInFlight).toBeLessThanOrEqual(11);
    expect(r.worstInFlight).toBeGreaterThanOrEqual(9);
  });

  it('until a frame has finished, two frames is the limit', () => {
    const gpu = simGpu({ gpuMs: 500 });
    const gate = new FrameGate();
    const r = run(gpu, gate, 20); // 333 ms: nothing finished yet
    expect([r.drawn, gate.held, gate.inFlight]).toEqual([2, 18, 2]);
    expect(gate.gpuFrameMs).toBeNull();
  });

  it('a GPU that gets slower: once its slower frames are seen done, the queue comes back under the budget', () => {
    // 100 ms frames for 10 s, then 400 ms frames.
    const gpu = simGpu({ gpuMs: (i) => (i < 100 ? 100 : 400) });
    const gate = new FrameGate();
    const before = run(gpu, gate, 600);
    const after = run(gpu, gate, 1200, before.end);
    // Frames went in at the old pace for a while (left as is: only browsers with no back pressure queue at all)...
    expect(after.worstBacklog).toBeGreaterThan(FRAME_GATE_DEFAULTS.budgetMs);
    // ...and the gate caught up with the new one.
    expect(gate.gpuFrameMs).toBeCloseTo(400, -1);
    expect(gpu.backlogMs()).toBeLessThanOrEqual(FRAME_GATE_DEFAULTS.budgetMs + 400);
  });

  it('a held frame runs nothing: no draw, no fence', () => {
    const gpu = simGpu({ gpuMs: 1000 });
    const gate = new FrameGate();
    gpu.now = 0;
    gate.submit(gpu.gl, 0, gpu.draw);
    gate.submit(gpu.gl, 1, gpu.draw);
    let ran = false;
    expect(gate.submit(gpu.gl, 2, () => (ran = true))).toBe(false);
    expect(ran).toBe(false);
    expect(gpu.live.size).toBe(2);
  });

  it('frees every finished frame in one poll, oldest first, and stops at the first unfinished one', () => {
    const gpu = simGpu({ gpuMs: 10 });
    const gate = new FrameGate({ untimedInFlight: 10 });
    for (let k = 0; k < 4; k++) gate.submit(gpu.gl, 0, gpu.draw);
    gpu.now = 25; // frames 0 and 1 done (10, 20), 2 and 3 not (30, 40)
    gpu.gl.polls = 0;
    gate.submit(gpu.gl, 25, gpu.draw);
    expect(gpu.frames.map((f) => f.deleted)).toEqual([true, true, false, false, false]);
    expect(gpu.gl.polls).toBe(3);
    expect(gate.inFlight).toBe(3);
  });

  it('times a frame from when the GPU could start it: the frame before done, or its submit if later', () => {
    // Queued behind the frame before: from that frame's done.
    const a = simGpu({ gpuMs: 100 });
    const queued = new FrameGate({ smoothing: 1, untimedInFlight: 10 });
    a.now = 0;
    queued.submit(a.gl, 0, a.draw); // GPU 0-100
    a.now = 10;
    queued.submit(a.gl, 10, a.draw); // GPU 100-200
    a.now = 100;
    queued.submit(a.gl, 100, a.draw);
    // The first frame seen done has nothing before it to time from.
    expect(queued.gpuFrameMs).toBeNull();
    a.now = 200;
    queued.submit(a.gl, 200, a.draw);
    // Seen done at 200; it could start at 100 (the first done), not at its submit (10).
    expect(queued.gpuFrameMs).toBe(100);

    // Submitted to an idle GPU: from its submit, to when it was seen done.
    const b = simGpu({ gpuMs: 100 });
    const idle = new FrameGate({ smoothing: 1 });
    b.now = 0;
    idle.submit(b.gl, 0, b.draw); // GPU 0-100
    b.now = 150;
    idle.submit(b.gl, 150, b.draw); // first seen done (untimed); GPU 150-250
    b.now = 300;
    idle.submit(b.gl, 300, b.draw);
    // Including the 50 ms until the poll saw it.
    expect(idle.gpuFrameMs).toBe(150);
  });

  it('a lost context queues nothing: its fences are dropped and every frame draws', () => {
    const gpu = simGpu({ gpuMs: 1000 });
    const gate = new FrameGate();
    gate.submit(gpu.gl, 0, gpu.draw);
    gate.submit(gpu.gl, 0, gpu.draw);
    gpu.lose();
    // WAIT_FAILED frees the old fences; fenceSync returns null, so nothing is held.
    for (let k = 1; k <= 5; k++) expect(gate.submit(gpu.gl, k, gpu.draw)).toBe(true);
    expect(gate.inFlight).toBe(0);
    expect(gpu.live.size).toBe(0);
  });

  it('without sync objects (WebGL 1, a test double) every frame draws', () => {
    expect(fenceGL({ drawArrays() {} })).toBeNull();
    expect(fenceGL(null)).toBeNull();
    const gpu = simGpu({ gpuMs: 1 });
    expect(fenceGL(gpu.gl)).toBe(gpu.gl);
    const gate = new FrameGate();
    let n = 0;
    for (let k = 0; k < 10; k++) gate.submit(null, k, () => n++);
    expect([n, gate.drawn, gate.held]).toEqual([10, 10, 0]);
  });

  it('a new context starts afresh: the old fences are deleted, the pace forgotten', () => {
    const a = simGpu({ gpuMs: 1000 });
    const gate = new FrameGate();
    run(a, gate, 200);
    expect(gate.gpuFrameMs).toBeCloseTo(1000, -1);
    // 1 s frames: three of them make the 3 s budget.
    expect(gate.inFlight).toBe(3);
    // The canvas remounts on a new context.
    const b = simGpu({ gpuMs: 1 });
    expect(gate.submit(b.gl, 0, b.draw)).toBe(true);
    expect(a.live.size).toBe(0);
    expect(gate.gpuFrameMs).toBeNull();
    gate.dispose();
    expect(b.live.size).toBe(0);
    expect(gate.inFlight).toBe(0);
  });
});
