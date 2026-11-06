/**
 * One drawn ground on photoreal: the globe hides once the mesh is the road
 * under the rider and comes back where it isn't. Each flip moves the rider
 * (the globe sat up to 26 m over the mesh on the Lugano shore), so both
 * directions wait out a short dropout, and a hidden tileset brings the globe
 * back at once.
 */
import { describe, expect, it } from 'vitest';

import type { GroundKind } from '@/lib/avatar';
import { GLOBE_HIDE_AFTER_MS, GLOBE_SHOW_AFTER_MS, GlobeGate, GroundGate } from '@/renderers/cesium/globeGate';

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
    const { g, t } = onMesh();
    const under = hold(g, t, 4_000, 'standIn');
    expect(under.last).toEqual({ globe: true, road: false });
    expect([...under.seen.road]).toEqual([false]);
    // The globe after the usual show wait.
    expect(new GroundGate().update(0, true, 'standIn')).toEqual({ globe: true, road: true });
    const back = hold(g, under.t + 16, 2_000, 'mesh');
    expect(back.last).toEqual({ globe: false, road: false });
    expect([...back.seen.road]).toEqual([false]);
  });

  it('a stand-in shows the globe after the same wait as a hole in the mesh', () => {
    const { g, t } = onMesh();
    expect(g.update(t, true, 'standIn')).toEqual({ globe: false, road: false });
    expect(g.update(t + GLOBE_SHOW_AFTER_MS - 1, true, 'standIn')).toEqual({ globe: false, road: false });
    expect(g.update(t + GLOBE_SHOW_AFTER_MS, true, 'standIn')).toEqual({ globe: true, road: false });
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
    const g = new GroundGate();
    const t0 = hold(g, 0, 2_000, 'globe').t + 16;
    expect(g.update(t0, true, 'standIn')).toEqual({ globe: true, road: true });
    expect(g.update(t0 + GLOBE_HIDE_AFTER_MS - 1, true, 'standIn')).toEqual({ globe: true, road: true });
    expect(g.update(t0 + GLOBE_HIDE_AFTER_MS, true, 'standIn')).toEqual({ globe: true, road: false });
  });

  it('a hidden tileset brings both back at once, whatever the rider stood on', () => {
    for (const ground of ['mesh', 'standIn', 'globe'] as const) {
      const { g, t } = onMesh();
      expect(g.update(t + 1, false, ground), ground).toEqual({ globe: true, road: true });
    }
  });

  it('never draws the painted road without the globe, over any sequence of grounds', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const kinds: GroundKind[] = ['mesh', 'standIn', 'globe'];
    for (let run = 0; run < 40; run++) {
      const g = new GroundGate();
      let t = 0;
      let ground: GroundKind = 'globe';
      for (let i = 0; i < 2_000; i++) {
        if (rnd() < 0.02) ground = kinds[Math.floor(rnd() * 3)];
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
