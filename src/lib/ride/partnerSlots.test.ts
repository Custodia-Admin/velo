/**
 * Pace partners' lateral slots (partnerSlots.ts): which side of the route
 * line each partner rides on, how far, how a road clamps it, the 0.9 m
 * floor that keeps it out of the rider and the partner beside it on narrow
 * paths, and that the shift is across the heading, not along it.
 */
import { describe, expect, it } from 'vitest';

import {
  baseSlotM,
  createPartnerSlotState,
  easeSlotM,
  offsetLatLon,
  partnerSlotM,
  PARTNER_EDGE_MARGIN_M,
  PARTNER_SLOT_FLOOR_M,
  PARTNER_SLOT_MAX_RATE_MPS,
  PARTNER_SLOT_TAU_S,
  stepPartnerSlot,
} from './partnerSlots';
import type { RoadSpan as RoadSpanLike } from './partnerSlots';
import { YAW_SNAP_M } from './rideHeading';

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
/** Local (east, north) metres from (lat0, lon0) to (lat, lon). */
function enu(lat0: number, lon0: number, lat: number, lon: number): [number, number] {
  return [rad(lon - lon0) * R * Math.cos(rad(lat0)), rad(lat - lat0) * R];
}

describe('partner slots', () => {
  it('puts index 0 1.2 m right, 1 1.2 m left, 2 2.4 m right of the line', () => {
    expect(partnerSlotM(0)).toBeCloseTo(1.2, 9);
    expect(partnerSlotM(1)).toBeCloseTo(-1.2, 9);
    expect(partnerSlotM(2)).toBeCloseTo(2.4, 9);
    // Past the three-partner roster the pattern carries on, alternating sides.
    expect(baseSlotM(3)).toBeCloseTo(-2.4, 9);
    expect(baseSlotM(4)).toBeCloseTo(3.6, 9);
  });

  it('gives no two partners the same slot and never the line itself', () => {
    const slots = [0, 1, 2, 3].map((i) => partnerSlotM(i));
    expect(new Set(slots).size).toBe(4);
    for (const s of slots) expect(Math.abs(s)).toBeGreaterThanOrEqual(1.2);
  });

  it('leaves slots alone on a road wide enough for them', () => {
    const wide = { leftM: -3.5, rightM: 3.5 };
    expect([0, 1, 2].map((i) => partnerSlotM(i, wide))).toEqual([1.2, -1.2, 2.4]);
  });

  it('clamps a slot to the road, keeping the wheels 0.1 m inside its edge', () => {
    expect(PARTNER_EDGE_MARGIN_M).toBe(0.1);
    // A 5 m road with the route line 0.26 m right of its centre (Tiber start).
    const span = { leftM: -2.76, rightM: 2.24 };
    expect(partnerSlotM(0, span)).toBeCloseTo(1.2, 9);
    expect(partnerSlotM(1, span)).toBeCloseTo(-1.2, 9);
    expect(partnerSlotM(2, span)).toBeCloseTo(2.14, 9);
    // A 3.5 m track with the line 0.5 m left of its centre: the near side
    // clamps (1.15 m, still clear of the floor), the far side holds.
    const track = { leftM: -1.25, rightM: 2.25 };
    expect(partnerSlotM(0, track)).toBeCloseTo(1.2, 9);
    expect(partnerSlotM(1, track)).toBeCloseTo(-1.15, 9);
    expect(partnerSlotM(2, track)).toBeCloseTo(2.15, 9);
  });

  it('never seats a partner closer than 0.9 m to the line: on a 1.5 m path it rides the verge', () => {
    expect(PARTNER_SLOT_FLOOR_M).toBe(0.9);
    // A 1.5 m path (most of the Tiber route): the clamp alone left both
    // partners 0.65 m off the line, and partners 0 and 2 on the same edge.
    const path = { leftM: -0.75, rightM: 0.75 };
    expect([0, 1, 2, 3].map((i) => partnerSlotM(i, path))).toEqual([0.9, -0.9, 1.8, -1.8]);
    // The line 0.3 m right of the path's centre: the near side is floored,
    // the far side keeps its clamp (0.95 m, on the path).
    const offCentre = { leftM: -1.05, rightM: 0.45 };
    expect(partnerSlotM(0, offCentre)).toBeCloseTo(0.9, 9);
    expect(partnerSlotM(1, offCentre)).toBeCloseTo(-0.95, 9);
    expect(partnerSlotM(2, offCentre)).toBeCloseTo(1.8, 9);
    // Mirrored: partner 0 keeps its 0.95 m clamp and partner 2 rides 0.9 m beyond it.
    const mirrored = { leftM: -0.45, rightM: 1.05 };
    expect(partnerSlotM(0, mirrored)).toBeCloseTo(0.95, 9);
    expect(partnerSlotM(1, mirrored)).toBeCloseTo(-0.9, 9);
    expect(partnerSlotM(2, mirrored)).toBeCloseTo(1.85, 9);
  });

  it('keeps the next partner out on a side 0.9 m beyond the one inside it', () => {
    // A 3 m road: partner 2's clamp (1.4 m) would leave it 0.2 m from partner 0.
    const road = { leftM: -1.5, rightM: 1.5 };
    expect([0, 1, 2, 3].map((i) => partnerSlotM(i, road))).toEqual([1.2, -1.2, 2.1, -2.1]);
    // Further out the pattern carries on: index 4 is 0.9 m beyond index 2.
    expect(partnerSlotM(4, road)).toBeCloseTo(3.0, 9);
  });

  it('never puts a partner across the line: a road wholly to one side floors the other side', () => {
    // A ribbon from 0.5 m to 3 m right of the line (a junction, a route
    // point just off the drawn road): the clamp would pull partner 1 to the right.
    const right = { leftM: 0.5, rightM: 3 };
    expect([0, 1, 2].map((i) => partnerSlotM(i, right))).toEqual([1.2, -0.9, 2.4]);
    const left = { leftM: -3, rightM: -0.5 };
    expect([0, 1, 2].map((i) => partnerSlotM(i, left))).toEqual([0.9, -1.2, 1.8]);
  });

  it('floors a partner on a road narrower than its margins, each on its own side', () => {
    // The clamp's middle-of-the-road (0.025 m) is right of the line for both.
    const sliver = { leftM: -0.05, rightM: 0.1 };
    expect([0, 1, 2].map((i) => partnerSlotM(i, sliver))).toEqual([0.9, -0.9, 1.8]);
  });

  describe('over random roads', () => {
    // mulberry32: a fixed sequence, so a failure reproduces.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /** Spans that contain the line, sit wholly to one side, are slivers or inverted, or are missing. */
    const spans: (RoadSpanLike | null)[] = [null];
    for (let k = 0; k < 4000; k++) {
      const a = -4 + 8 * rand();
      const w = k % 7 === 0 ? 0.3 * rand() : 9 * rand();
      spans.push({ leftM: a, rightM: a + w });
    }
    const INDICES = [0, 1, 2, 3];
    /** The clamp on its own (the rule before the floor). */
    const clamp = (i: number, s: RoadSpanLike | null) => {
      if (!s) return baseSlotM(i);
      const lo = s.leftM + PARTNER_EDGE_MARGIN_M;
      const hi = s.rightM - PARTNER_EDGE_MARGIN_M;
      return lo > hi ? (s.leftM + s.rightM) / 2 : Math.min(hi, Math.max(lo, baseSlotM(i)));
    };

    it('keeps every partner on its own side, at least 0.9 m from the line and from every other partner', () => {
      const bad: unknown[] = [];
      for (const s of spans) {
        const m = INDICES.map((i) => partnerSlotM(i, s));
        m.forEach((v, i) => {
          if (Math.sign(v) !== Math.sign(baseSlotM(i))) bad.push({ side: i, v, s });
          if (Math.abs(v) < PARTNER_SLOT_FLOOR_M - 1e-12) bad.push({ line: i, v, s });
          for (let j = 0; j < i; j++) if (Math.abs(v - m[j]) < PARTNER_SLOT_FLOOR_M - 1e-12) bad.push({ pair: [j, i], m, s });
        });
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });

    it('leaves the clamp alone wherever it already clears the floor and the partner inside', () => {
      let kept = 0;
      const bad: unknown[] = [];
      for (const s of spans) {
        const c = INDICES.map((i) => clamp(i, s));
        INDICES.forEach((i) => {
          const side = Math.sign(baseSlotM(i));
          const inner = i >= 2 ? partnerSlotM(i - 2, s) : 0;
          if (side * c[i] >= PARTNER_SLOT_FLOOR_M && (i < 2 || side * (c[i] - inner) >= PARTNER_SLOT_FLOOR_M)) {
            if (partnerSlotM(i, s) !== c[i]) bad.push({ i, s, got: partnerSlotM(i, s), clamp: c[i] });
            kept++;
          }
        });
      }
      expect(bad.slice(0, 5)).toEqual([]);
      // The case is common, not vacuous.
      expect(kept).toBeGreaterThan(spans.length);
    });

    it('moves at most as far as the road edge moves (no jumps of its own)', () => {
      const eps = 0.01;
      const bad: unknown[] = [];
      let moves = 0;
      for (const s of spans) {
        if (!s) continue;
        for (const moved of [
          { leftM: s.leftM + eps, rightM: s.rightM },
          { leftM: s.leftM - eps, rightM: s.rightM },
          { leftM: s.leftM, rightM: s.rightM + eps },
          { leftM: s.leftM, rightM: s.rightM - eps },
        ]) {
          for (const i of INDICES) {
            const d = Math.abs(partnerSlotM(i, moved) - partnerSlotM(i, s));
            if (d > eps + 1e-9) bad.push({ i, s, moved, d });
            if (d > 1e-9) moves++;
          }
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
      // The edges do move the slots (the clamp is live), so the bound is not vacuous.
      expect(moves).toBeGreaterThan(spans.length);
    });
  });
});

describe('slot easing', () => {
  const DT = 1 / 60;

  it('drifts a partner over at no more than 2.5 m/s (0.042 m a 60 fps frame), never jumping', () => {
    expect(PARTNER_SLOT_MAX_RATE_MPS).toBe(2.5);
    // A long move (2.4 m → 0.65 m): at the cap, then the damped tail.
    let m = 2.4;
    const steps: number[] = [];
    for (let f = 0; f < 120; f++) {
      const next = easeSlotM(m, 0.65, DT);
      steps.push(m - next);
      m = next;
    }
    expect(Math.max(...steps)).toBeCloseTo(PARTNER_SLOT_MAX_RATE_MPS * DT, 9);
    for (const s of steps) expect(s).toBeGreaterThanOrEqual(0);
    // At the cap for the first ~0.6 s, then the damped tail: in the slot within 1.2 s.
    expect(steps[0]).toBeCloseTo(2.5 / 60, 9);
    expect(m).toBeCloseTo(0.65, 3);
  });

  it('settles small moves on the time constant and never overshoots the target', () => {
    expect(PARTNER_SLOT_TAU_S).toBe(0.15);
    // 0.1 m (under the cap): 63 % of the way in one time constant.
    let m = 0;
    for (let t = 0; t < PARTNER_SLOT_TAU_S - 1e-9; t += DT) m = easeSlotM(m, 0.1, DT);
    expect(m).toBeCloseTo(0.1 * (1 - Math.exp(-1)), 3);
    // Toward a target either side, from either side: never past it.
    for (const [from, to] of [[1.2, -0.65], [-1.2, 0.1], [0.65, 0.66]]) {
      let x = from;
      for (let f = 0; f < 240; f++) {
        x = easeSlotM(x, to, DT);
        expect((x - to) * Math.sign(from - to)).toBeGreaterThanOrEqual(0);
      }
      expect(x).toBeCloseTo(to, 6);
    }
    // A paused frame (dt 0) moves nothing.
    expect(easeSlotM(1.2, 0.65, 0)).toBe(1.2);
  });

  it('is frame-rate independent at the cap: a second at 30 or 144 fps covers the same 2.5 m', () => {
    for (const fps of [30, 60, 144]) {
      let m = 0;
      for (let f = 0; f < fps; f++) m = easeSlotM(m, 10, 1 / fps);
      expect(m).toBeCloseTo(2.5, 6);
    }
  });

  it('seats a partner in its slot on the first frame and after a jump along the route, and eases it otherwise', () => {
    const s = createPartnerSlotState();
    expect(stepPartnerSlot(s, 2.4, 0, DT)).toBe(2.4);
    // Riding on onto a 1.5 m path: partner 2's slot narrows to 1.8 m; the drawn slot drifts.
    expect(stepPartnerSlot(s, 1.8, 0.13, DT)).toBeCloseTo(2.4 - 2.5 / 60, 9);
    // A seek or Ride again (further than the heading filter's snap): straight into the slot.
    expect(stepPartnerSlot(s, 1.2, 0.13 + YAW_SNAP_M + 1, DT)).toBe(1.2);
    // Back to the start line after a finish: seated, not drifting in from the finish.
    expect(stepPartnerSlot(s, 0.9, 0, DT)).toBe(0.9);
    // A jump of up to YAW_SNAP_M is riding (a slow frame), eased.
    expect(stepPartnerSlot(s, 2.4, YAW_SNAP_M, DT)).toBeCloseTo(0.9 + 2.5 / 60, 9);
  });
});

describe('offsetLatLon', () => {
  const lat = 43.07;
  const lon = 12.6;

  it('moves a north-facing partner east for a right slot, west for a left one', () => {
    const r = offsetLatLon(lat, lon, 0, 1.2);
    const right = enu(lat, lon, r.lat, r.lon);
    expect(right[0]).toBeCloseTo(1.2, 3);
    expect(right[1]).toBeCloseTo(0, 6);
    const left = offsetLatLon(lat, lon, 0, -1.2);
    const [e, n] = enu(lat, lon, left.lat, left.lon);
    expect(e).toBeCloseTo(-1.2, 3);
    expect(n).toBeCloseTo(0, 6);
  });

  it('moves an east-facing partner south for a right slot, north for a left one', () => {
    const r = offsetLatLon(lat, lon, Math.PI / 2, 2.4);
    const [e, n] = enu(lat, lon, r.lat, r.lon);
    expect(e).toBeCloseTo(0, 6);
    expect(n).toBeCloseTo(-2.4, 3);
    const l = offsetLatLon(lat, lon, Math.PI / 2, -1.2);
    const [e2, n2] = enu(lat, lon, l.lat, l.lon);
    expect(e2).toBeCloseTo(0, 6);
    expect(n2).toBeCloseTo(1.2, 3);
  });

  it('shifts across the heading at any bearing, never along it', () => {
    for (const deg of [0, 37, 90, 145, 200, 300]) {
      const h = rad(deg);
      const p = offsetLatLon(lat, lon, h, 1.2);
      const [e, n] = enu(lat, lon, p.lat, p.lon);
      // Along the heading (sin h, cos h): nothing. Across it: the slot.
      expect(e * Math.sin(h) + n * Math.cos(h)).toBeCloseTo(0, 4);
      expect(e * Math.cos(h) - n * Math.sin(h)).toBeCloseTo(1.2, 3);
    }
  });

  it('leaves the point where it is for a zero slot', () => {
    expect(offsetLatLon(lat, lon, 1, 0)).toEqual({ lat, lon });
  });
});
