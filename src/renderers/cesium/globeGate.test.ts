/**
 * One drawn ground on photoreal: the globe hides once the mesh is the road
 * under the rider and comes back where it isn't. Each flip moves the rider
 * (the globe sat up to 26 m over the mesh on the Lugano shore), so both
 * directions wait out a short dropout, and a hidden tileset brings the globe
 * back at once. A held stand-in (its finest terrain known near the road held)
 * draws it at once too: nothing is drawn under the rider until it is.
 */
import { describe, expect, it } from 'vitest';

import { GROUND_SAMPLE_INTERVAL_MS, type GroundKind } from '@/lib/avatar';
import {
  GLOBE_HIDE_AFTER_MS,
  GLOBE_SHOW_AFTER_MS,
  GLOBE_STANDIN_SHOW_AFTER_MS,
  GlobeGate,
  GroundGate,
} from '@/renderers/cesium/globeGate';

describe('GlobeGate', () => {
  it('starts on the globe and hides it once the mesh road has held under the rider', () => {
    const g = new GlobeGate();
    expect(g.shown).toBe(true);
    expect(g.update(0, true, true)).toBe(true);
    expect(g.update(GLOBE_HIDE_AFTER_MS - 1, true, true)).toBe(true);
    expect(g.update(GLOBE_HIDE_AFTER_MS, true, true)).toBe(false);
    expect(g.shown).toBe(false);
  });

  it('a mesh road that drops out before the hide delay starts the wait again', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS - 100, true, false);
    expect(g.update(GLOBE_HIDE_AFTER_MS + 50, true, true)).toBe(true);
    expect(g.update(GLOBE_HIDE_AFTER_MS + 50 + GLOBE_HIDE_AFTER_MS - 1, true, true)).toBe(true);
    expect(g.update(2 * GLOBE_HIDE_AFTER_MS + 50, true, true)).toBe(false);
  });

  it('a short hole in the mesh keeps the globe hidden; a lasting one brings it back', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS, true, true);
    const t0 = 10_000;
    expect(g.update(t0, true, false)).toBe(false);
    expect(g.update(t0 + GLOBE_SHOW_AFTER_MS - 1, true, false)).toBe(false);
    // The mesh came back in time: the wait is over.
    expect(g.update(t0 + GLOBE_SHOW_AFTER_MS - 1, true, true)).toBe(false);
    expect(g.update(t0 + 2 * GLOBE_SHOW_AFTER_MS, true, false)).toBe(false);
    expect(g.update(t0 + 3 * GLOBE_SHOW_AFTER_MS, true, false)).toBe(true);
  });

  it('a shorter show wait brings the globe back sooner; the hide wait is the same', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS, true, true);
    expect(g.update(10_000, true, false, 0)).toBe(true);
    expect(g.update(10_016, true, true, 0)).toBe(true);
    expect(g.update(10_016 + GLOBE_HIDE_AFTER_MS - 1, true, true, 0)).toBe(true);
    expect(g.update(10_016 + GLOBE_HIDE_AFTER_MS, true, true, 0)).toBe(false);
    expect(g.update(20_000, true, false, 300)).toBe(false);
    expect(g.update(20_299, true, false, 300)).toBe(false);
    expect(g.update(20_300, true, false, 300)).toBe(true);
  });

  it('the hide waits for a mesh sample taken the hide wait after the first: frames on an older reading keep the globe', () => {
    const g = new GlobeGate();
    // Samples at 0, 262 and 524 ms (each on the first frame 250 ms on).
    expect(g.update(17, true, true, GLOBE_SHOW_AFTER_MS, 0)).toBe(true);
    expect(g.update(17 + GLOBE_HIDE_AFTER_MS, true, true, GLOBE_SHOW_AFTER_MS, 524)).toBe(true);
    expect(g.update(17 + GLOBE_HIDE_AFTER_MS + 33, true, true, GLOBE_SHOW_AFTER_MS, 524)).toBe(true);
    // The fourth sample, 786 ms after the first, still on the mesh road.
    expect(g.update(803, true, true, GLOBE_SHOW_AFTER_MS, 786)).toBe(false);
  });

  it('nor sooner than the hide wait on the frame clock, however old the first reading (a reset under a reading from before)', () => {
    const g = new GlobeGate();
    expect(g.update(10_000, true, true, GLOBE_SHOW_AFTER_MS, 9_800)).toBe(true);
    expect(g.update(10_000 + GLOBE_HIDE_AFTER_MS - 1, true, true, GLOBE_SHOW_AFTER_MS, 9_800 + GLOBE_HIDE_AFTER_MS)).toBe(true);
    expect(g.update(10_000 + GLOBE_HIDE_AFTER_MS, true, true, GLOBE_SHOW_AFTER_MS, 9_800 + GLOBE_HIDE_AFTER_MS)).toBe(false);
  });

  it('a hidden tileset (camera over 5 km, no token, mobile) brings the globe back at once', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS, true, true);
    expect(g.shown).toBe(false);
    expect(g.update(GLOBE_HIDE_AFTER_MS + 1, false, true)).toBe(true);
    // Back under 5 km: the hide waits again.
    expect(g.update(GLOBE_HIDE_AFTER_MS + 2, true, true)).toBe(true);
  });

  it('reset: back on the globe (route change, no rider)', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS, true, true);
    g.reset();
    expect(g.shown).toBe(true);
    expect(g.update(GLOBE_HIDE_AFTER_MS + 1, true, true)).toBe(true);
  });
});

/**
 * The painted road (corridor, centre line, edge stripes) is a ground
 * classification: it paints the mesh in its footprint too. It is drawn only
 * where the globe is the ground, never where the globe stands in under tree
 * crowns or a deck (Cuyahoga towpath under I-80: asphalt and edge lines ran
 * up the piers), and never without the globe.
 */
describe('GroundGate: the globe, and the painted road only where the globe is the ground', () => {
  /** Rolls the gate every 16 ms from `t` for `ms` on one ground; returns the last frame and the end time. */
  const hold = (g: GroundGate, t: number, ms: number, ground: GroundKind, meshShown = true) => {
    let last = g.update(t, meshShown, ground);
    const seen = { globe: new Set<boolean>([last.globe]), road: new Set<boolean>([last.road]) };
    for (let dt = 16; dt <= ms; dt += 16) {
      last = g.update(t + dt, meshShown, ground);
      seen.globe.add(last.globe);
      seen.road.add(last.road);
    }
    return { last, seen, t: t + ms };
  };
  /** On the mesh road long enough that both are hidden. */
  const onMesh = () => {
    const g = new GroundGate();
    const { last, t } = hold(g, 0, GLOBE_HIDE_AFTER_MS + 100, 'mesh');
    expect(last).toEqual({ globe: false, road: false });
    return { g, t };
  };

  it('starts on the globe with its painted road (no mesh road yet, as before)', () => {
    const g = new GroundGate();
    expect(g.update(0, true, 'globe')).toEqual({ globe: true, road: true });
    expect(hold(g, 16, 3_000, 'globe').last).toEqual({ globe: true, road: true });
  });

  it('on the mesh road both hide after the hide wait', () => {
    const g = new GroundGate();
    expect(g.update(0, true, 'mesh')).toEqual({ globe: true, road: true });
    expect(g.update(GLOBE_HIDE_AFTER_MS - 1, true, 'mesh')).toEqual({ globe: true, road: true });
    expect(g.update(GLOBE_HIDE_AFTER_MS, true, 'mesh')).toEqual({ globe: false, road: false });
  });

  it('a stand-in under crowns or a deck brings the globe back, never the painted road; back on the mesh both stay hidden', () => {
    for (const kind of ['standIn', 'under'] as const) {
      const { g, t } = onMesh();
      const under = hold(g, t, 4_000, kind);
      expect(under.last, kind).toEqual({ globe: true, road: false });
      expect([...under.seen.road], kind).toEqual([false]);
      // From the start (globe and painted road drawn): the globe stays.
      expect(new GroundGate().update(0, true, kind), kind).toEqual({ globe: true, road: true });
      const back = hold(g, under.t + 16, 2_000, 'mesh');
      expect(back.last, kind).toEqual({ globe: false, road: false });
      expect([...back.seen.road], kind).toEqual([false]);
    }
  });

  it('a held stand-in draws the globe on its first frame: nothing is drawn under the rider until it is', () => {
    expect(GLOBE_STANDIN_SHOW_AFTER_MS).toBe(0);
    const { g, t } = onMesh();
    expect(g.update(t, true, 'standIn')).toEqual({ globe: true, road: false });
    // Back on the mesh road, it hides after the usual hide wait…
    expect(g.update(t + 16, true, 'mesh')).toEqual({ globe: true, road: false });
    expect(g.update(t + 16 + GLOBE_HIDE_AFTER_MS - 1, true, 'mesh')).toEqual({ globe: true, road: false });
    // …and a stand-in again before then keeps it.
    expect(g.update(t + 16 + GLOBE_HIDE_AFTER_MS - 1, true, 'standIn')).toEqual({ globe: true, road: false });
    expect(hold(g, t + GLOBE_HIDE_AFTER_MS + 16, 3 * GLOBE_HIDE_AFTER_MS, 'standIn').last).toEqual({ globe: true, road: false });
    const back = hold(g, t + 4 * GLOBE_HIDE_AFTER_MS + 32, GLOBE_HIDE_AFTER_MS + 16, 'mesh');
    expect(back.last).toEqual({ globe: false, road: false });
  });

  it("under something with no road held, or the finest terrain still on its way ('under'): the globe after the same wait as a hole in the mesh", () => {
    const { g, t } = onMesh();
    expect(g.update(t, true, 'under')).toEqual({ globe: false, road: false });
    expect(g.update(t + GLOBE_SHOW_AFTER_MS - 1, true, 'under')).toEqual({ globe: false, road: false });
    expect(g.update(t + GLOBE_SHOW_AFTER_MS, true, 'under')).toEqual({ globe: true, road: false });
  });

  it("the finest lands near the road held ('under' to 'standIn'): the globe at once, not the rest of the wait", () => {
    const { g, t } = onMesh();
    expect(hold(g, t, 400, 'under').last).toEqual({ globe: false, road: false });
    expect(g.update(t + 416, true, 'standIn')).toEqual({ globe: true, road: false });
    // A batch on its way again ('under') keeps the drawn globe drawn.
    expect(hold(g, t + 432, 2_000, 'under').last).toEqual({ globe: true, road: false });
  });

  it('a mesh road sample between held stand-in samples does not hide the drawn globe (the crown edges)', () => {
    const { g, t } = onMesh();
    // 250 ms a sample: stand-in, mesh, stand-in, mesh…
    let last = g.update(t, true, 'standIn');
    for (let i = 1; i < 16; i++) {
      const r = hold(g, t + i * 250, 234, i % 2 ? 'mesh' : 'standIn');
      expect([...r.seen.globe], `sample ${i}`).toEqual([true]);
      last = r.last;
    }
    expect(last).toEqual({ globe: true, road: false });
  });

  it('from a stand-in onto ground with no mesh road: the painted road after the show wait of its own', () => {
    const { g, t } = onMesh();
    const under = hold(g, t, 3_000, 'standIn');
    const t0 = under.t + 16;
    expect(g.update(t0, true, 'globe')).toEqual({ globe: true, road: false });
    // The stand-in time doesn't count towards it.
    expect(g.update(t0 + GLOBE_SHOW_AFTER_MS - 1, true, 'globe')).toEqual({ globe: true, road: false });
    expect(g.update(t0 + GLOBE_SHOW_AFTER_MS, true, 'globe')).toEqual({ globe: true, road: true });
  });

  it('from ground with no mesh road in under a structure: the painted road goes after the hide wait, the globe stays', () => {
    for (const kind of ['standIn', 'under'] as const) {
      const g = new GroundGate();
      const t0 = hold(g, 0, 2_000, 'globe').t + 16;
      expect(g.update(t0, true, kind), kind).toEqual({ globe: true, road: true });
      expect(g.update(t0 + GLOBE_HIDE_AFTER_MS - 1, true, kind), kind).toEqual({ globe: true, road: true });
      expect(g.update(t0 + GLOBE_HIDE_AFTER_MS, true, kind), kind).toEqual({ globe: true, road: false });
    }
  });

  it('a hidden tileset brings both back at once, whatever the rider stood on', () => {
    for (const ground of ['mesh', 'standIn', 'under', 'globe'] as const) {
      const { g, t } = onMesh();
      expect(g.update(t + 1, false, ground), ground).toEqual({ globe: true, road: true });
    }
  });

  it('never draws the painted road without the globe, over any sequence of grounds', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const kinds: GroundKind[] = ['mesh', 'standIn', 'under', 'globe'];
    for (let run = 0; run < 40; run++) {
      const g = new GroundGate();
      let t = 0;
      let ground: GroundKind = 'globe';
      for (let i = 0; i < 2_000; i++) {
        if (rnd() < 0.02) ground = kinds[Math.floor(rnd() * kinds.length)];
        t += 16;
        const d = g.update(t, rnd() > 0.01, ground);
        expect(!d.road || d.globe, `run ${run} frame ${i}`).toBe(true);
      }
    }
  });

  it('reset: back on the globe and its painted road', () => {
    const { g, t } = onMesh();
    hold(g, t, 2_000, 'standIn');
    g.reset();
    expect(g.update(t + 3_000, true, 'standIn')).toEqual({ globe: true, road: true });
  });
});

/**
 * The ground the gate reads comes from a sample every 250 ms, each on the
 * first frame after that (lib/avatar createGroundSampler), and the gate runs
 * before the frame's sample (CesiumWorldView). With frame jitter the samples
 * drift later than a timer on the frame clock: timed on it alone, a mesh run
 * of three samples between stand-ins (a crown edge on the Cuyahoga towpath)
 * hid the globe a frame or three before the fourth sample said 'standIn',
 * and the globe was drawn again on the next frame: 5–36 ms drop-outs in every
 * test-host ride, up to a quarter of the frame black.
 */
describe('GroundGate on the sample cadence: the globe hides only on a sample', () => {
  const PROFILES = {
    // 60 fps with jitter: 5 % of frames take two vsyncs.
    jittered: (rnd: () => number) => (rnd() < 0.05 ? 33.3 : 14 + rnd() * 5.3),
    // A loaded machine: 25–40 ms frames, 10 % of them 67 ms.
    loaded: (rnd: () => number) => (rnd() < 0.1 ? 66.7 : 25 + rnd() * 15),
  };
  const PHASES = [0, 1, 2, 3, 4, 5, 6, 7];

  interface Frame {
    t: number;
    globe: boolean;
    /** The same frames through the gate on the frame clock alone (sample time not passed). */
    frameClock: boolean;
    ground: GroundKind;
    sampledAt: number;
    /** When the mesh run behind this reading began (its first mesh sample). */
    runFrom: number;
  }

  /**
   * One ride over the sample kinds: on the mesh road long enough that the globe
   * is hidden, stand-ins, `n` mesh samples, stand-ins again.
   */
  const ride = (n: number, phase: number, frameMs: (rnd: () => number) => number) => {
    let seed = 11 + phase * 7919 + n;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const kinds: GroundKind[] = [
      ...Array<GroundKind>(8).fill('mesh'),
      ...Array<GroundKind>(4).fill('standIn'),
      ...Array<GroundKind>(n).fill('mesh'),
      ...Array<GroundKind>(6).fill('standIn'),
    ];
    const gate = new GroundGate();
    const frameClock = new GroundGate();
    const frames: Frame[] = [];
    const samples: number[] = [];
    let t = 1_000 + phase * 2.1;
    let ground: GroundKind = 'globe';
    let sampledAt = -Infinity;
    let runFrom = NaN;
    for (let i = 0; i <= kinds.length; ) {
      t += frameMs(rnd);
      frames.push({
        t,
        globe: gate.update(t, true, ground, sampledAt).globe,
        frameClock: frameClock.update(t, true, ground).globe,
        ground,
        sampledAt,
        runFrom,
      });
      if (t - sampledAt >= GROUND_SAMPLE_INTERVAL_MS) {
        if (i === kinds.length) break;
        if (kinds[i] === 'mesh' && ground !== 'mesh') runFrom = t;
        ground = kinds[i++];
        sampledAt = t;
        samples.push(t);
      }
    }
    return { frames, samples, run: samples[12], after: samples[12 + n] };
  };
  /** The frames where the globe went from drawn to hidden. */
  const hides = (frames: Frame[], key: 'globe' | 'frameClock' = 'globe') =>
    frames.filter((f, k) => k > 0 && frames[k - 1][key] && !f[key]);

  it('every hide is on a mesh sample taken the hide wait or more after the run began', () => {
    for (const [name, frameMs] of Object.entries(PROFILES)) {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        for (const phase of PHASES) {
          const { frames } = ride(n, phase, frameMs);
          const at = `${name} run ${n} phase ${phase}`;
          expect(hides(frames).length, at).toBeGreaterThan(0);
          for (const f of hides(frames)) {
            expect(f.ground, at).toBe('mesh');
            expect(f.sampledAt - f.runFrom, at).toBeGreaterThanOrEqual(GLOBE_HIDE_AFTER_MS);
          }
        }
      }
    }
  });

  it('a mesh run of one to three samples between stand-ins never hides the drawn globe', () => {
    for (const [name, frameMs] of Object.entries(PROFILES)) {
      for (const n of [1, 2, 3]) {
        for (const phase of PHASES) {
          const { frames, samples } = ride(n, phase, frameMs);
          // Drawn on the first frame after the first stand-in sample, and kept.
          const drawn = frames.filter((f) => f.t > samples[8]);
          expect(
            drawn.filter((f) => !f.globe).map((f) => Math.round(f.t - samples[8])),
            `${name} run ${n} phase ${phase}`,
          ).toEqual([]);
        }
      }
    }
  });

  it('a run of four mesh samples or more still hides it, within a second of its first sample and at most a sample later than on the frame clock', () => {
    for (const [name, frameMs] of Object.entries(PROFILES)) {
      for (const n of [4, 5, 6]) {
        for (const phase of PHASES) {
          const { frames, run, after } = ride(n, phase, frameMs);
          const at = `${name} run ${n} phase ${phase}`;
          const hide = hides(frames).find((f) => f.t > run);
          const frameClockHide = hides(frames, 'frameClock').find((f) => f.t > run);
          expect(hide, at).toBeDefined();
          expect(frameClockHide, at).toBeDefined();
          expect(hide!.t - run, at).toBeLessThanOrEqual(GLOBE_HIDE_AFTER_MS + GROUND_SAMPLE_INTERVAL_MS + 70);
          if (name === 'jittered') expect(hide!.t - run, at).toBeLessThanOrEqual(1_000);
          expect(hide!.t, at).toBeGreaterThanOrEqual(frameClockHide!.t);
          expect(hide!.t - frameClockHide!.t, at).toBeLessThanOrEqual(GROUND_SAMPLE_INTERVAL_MS);
          // Hidden until the next stand-in sample, then drawn on the frame after it.
          const span = frames.filter((f) => f.t >= hide!.t && f.t <= after);
          expect(span.every((f) => !f.globe), at).toBe(true);
          expect(frames.filter((f) => f.t > after).every((f) => f.globe), at).toBe(true);
        }
      }
    }
  });
});
