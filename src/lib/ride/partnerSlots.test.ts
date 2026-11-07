/**
 * Pace partners' lateral slots (partnerSlots.ts): which side of the route
 * line each partner rides on, how far, how a road clamps it, the 0.9 m
 * floor that keeps it out of the rider and the partner beside it on narrow
 * paths, how partners give way to a steering rider (out on their own side,
 * back behind the rider on a narrow road, a second's hold before coming
 * back), and that the shift is across the heading, not along it.
 */
import { describe, expect, it } from 'vitest';

import { stepLane } from '@/lib/controllers/steerFeel';
import {
  baseSlotM,
  createPartnerSlotState,
  createPartnerYieldState,
  easeSlotM,
  LANE_REACH_S,
  laneReach,
  offsetLatLon,
  partnerClearsRider,
  partnerSlotM,
  PARTNER_DROP_GAP_M,
  PARTNER_DROP_MAX_M,
  PARTNER_DROP_MAX_RATE_MPS,
  PARTNER_EDGE_MARGIN_M,
  PARTNER_SLOT_FLOOR_M,
  PARTNER_SLOT_MAX_RATE_MPS,
  PARTNER_SLOT_TAU_S,
  PARTNER_YIELD_HOLD_S,
  PARTNER_YIELD_MARGIN_M,
  PARTNER_YIELD_VERGE_M,
  stepPartnerSlot,
  stepPartnerYield,
} from './partnerSlots';
import type { RiderBeside, RoadSpan as RoadSpanLike } from './partnerSlots';
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

describe('giving way to a steering rider', () => {
  const DT = 1 / 60;
  const WIDE: RoadSpanLike = { leftM: -5, rightM: 5 };
  /** A 1.5 m path with the line on its centre. */
  const NARROW: RoadSpanLike = { leftM: -0.75, rightM: 0.75 };

  function rider(laneOffsetM: number, distance = 100, reach?: [number, number]): RiderBeside {
    const [leftM, rightM] = reach ?? [laneOffsetM, laneOffsetM];
    return { distance, speed: 8, laneOffsetM, leftM, rightM };
  }

  /** Drawn distance from partner to rider on a straight road (the solver's own picture without riderAt). */
  function clearance(step: { slotM: number; backM: number }, r: RiderBeside, partnerDistance: number): number {
    return Math.hypot(step.slotM - r.laneOffsetM, partnerDistance - step.backM - r.distance);
  }

  describe('partnerSlotM with the rider off the line', () => {
    it('is the home slot with the rider on the line', () => {
      for (let i = 0; i < 4; i++) expect(partnerSlotM(i, WIDE, 0)).toBe(partnerSlotM(i, WIDE));
    });

    it('moves the partner on the rider’s side out to 0.9 m beyond it, leaving the other side alone', () => {
      expect(partnerSlotM(0, WIDE, 1)).toBeCloseTo(1 + PARTNER_SLOT_FLOOR_M, 12);
      expect(partnerSlotM(1, WIDE, 1)).toBe(-1.2);
      expect(partnerSlotM(1, WIDE, -1.6)).toBeCloseTo(-1.6 - PARTNER_SLOT_FLOOR_M, 12);
      // Partner 2 keeps 0.9 m beyond partner 0 as it moves.
      expect(partnerSlotM(2, WIDE, 1.6)).toBeCloseTo(1.6 + 2 * PARTNER_SLOT_FLOOR_M, 12);
    });

    it('never moves a partner in from its home, so it never changes sides', () => {
      for (let x = -1.6; x <= 1.6; x += 0.05) {
        for (const span of [WIDE, NARROW, null]) {
          for (let i = 0; i < 4; i++) {
            const side = Math.sign(baseSlotM(i));
            expect(side * partnerSlotM(i, span, x)).toBeGreaterThanOrEqual(side * partnerSlotM(i, span) - 1e-12);
          }
        }
      }
    });

    it('stops at the road edge (or a step onto the verge) where the road is too narrow, and says so', () => {
      expect(partnerSlotM(0, NARROW, 0.4)).toBeCloseTo(PARTNER_SLOT_FLOOR_M + PARTNER_YIELD_VERGE_M, 12);
      expect(partnerClearsRider(0, NARROW, 0.4)).toBe(false);
      expect(partnerClearsRider(0, NARROW, 0)).toBe(true);
      // A rider a few centimetres off the line: the partner steps out onto the verge, it doesn't drop back.
      expect(partnerSlotM(0, NARROW, 0.1)).toBeCloseTo(0.1 + PARTNER_SLOT_FLOOR_M, 12);
      expect(partnerClearsRider(0, NARROW, PARTNER_YIELD_VERGE_M)).toBe(true);
      expect(partnerClearsRider(0, WIDE, 1.6)).toBe(true);
      expect(partnerClearsRider(0, null, 1.6)).toBe(true);
    });

    it('is continuous in the rider’s lateral: a move of ε moves the slot by at most ε', () => {
      for (const span of [WIDE, NARROW, { leftM: -1.4, rightM: 2.1 }, null]) {
        for (let i = 0; i < 4; i++) {
          for (let x = -1.6; x < 1.6; x += 0.01) {
            expect(Math.abs(partnerSlotM(i, span, x + 0.01) - partnerSlotM(i, span, x))).toBeLessThanOrEqual(0.01 + 1e-9);
          }
        }
      }
    });
  });

  describe('laneReach', () => {
    it('is where the rider rides with the levers released at rest', () => {
      expect(laneReach({ offsetM: 0, velMs: 0 }, 0)).toEqual({ leftM: 0, rightM: 0 });
      const r = laneReach({ offsetM: 0.7, velMs: 0 }, 0);
      expect(r.rightM).toBe(0.7);
      expect(r.leftM).toBeLessThan(0.7);
    });

    it('runs the lane forward through the real spring (stepLane) over LANE_REACH_S', () => {
      const lane = { offsetM: 0.2, velMs: 0.5 };
      const reach = laneReach(lane, 1);
      // The lane itself is untouched.
      expect(lane).toEqual({ offsetM: 0.2, velMs: 0.5 });
      const ahead = { ...lane };
      let hi = ahead.offsetM;
      for (let t = 0; t < LANE_REACH_S - 1e-9; t += 0.05) hi = Math.max(hi, stepLane(ahead, 1, 0.05).offsetM);
      expect(reach.rightM).toBeCloseTo(hi, 12);
      expect(reach.leftM).toBe(0.2);
      // Full lock right is foreseen almost at once.
      expect(reach.rightM).toBeGreaterThan(1.5);
    });
  });

  describe('stepPartnerYield', () => {
    it('rides its home slot while the rider keeps 0.9 m clear of it (no twitch)', () => {
      const state = createPartnerYieldState();
      for (let f = 0; f < 120; f++) {
        const s = stepPartnerYield(state, 0, WIDE, { distance: 100, speed: 8 }, rider(0.3), DT);
        expect(s.slotM).toBe(1.2);
        expect(s.backM).toBe(0);
      }
    });

    it('moves out as the rider steers in, holds for a second after it moves away, then eases home', () => {
      const state = createPartnerYieldState();
      const p = { distance: 100, speed: 8 };
      let s = stepPartnerYield(state, 0, WIDE, p, rider(0), DT);
      for (let f = 0; f < 240; f++) s = stepPartnerYield(state, 0, WIDE, p, rider(1.6), DT);
      expect(s.slotM).toBeCloseTo(1.6 + PARTNER_SLOT_FLOOR_M, 3);
      // The rider moves back to the line: the partner stays out for PARTNER_YIELD_HOLD_S…
      let frames = 0;
      while (frames < 600) {
        s = stepPartnerYield(state, 0, WIDE, p, rider(0), DT);
        frames++;
        if (s.targetM < 1.6 + PARTNER_SLOT_FLOOR_M - 1e-9) break;
      }
      const heldS = frames * DT;
      expect(heldS).toBeGreaterThanOrEqual(PARTNER_YIELD_HOLD_S);
      expect(heldS).toBeLessThanOrEqual(PARTNER_YIELD_HOLD_S + 0.15);
      // …then eases home at the drift rate, never jumping.
      let prev = s.slotM;
      for (let f = 0; f < 120; f++) {
        s = stepPartnerYield(state, 0, WIDE, p, rider(0), DT);
        expect(prev - s.slotM).toBeLessThanOrEqual(PARTNER_SLOT_MAX_RATE_MPS * DT + 1e-12);
        expect(s.slotM).toBeLessThanOrEqual(prev);
        prev = s.slotM;
      }
      expect(s.slotM).toBeCloseTo(1.2, 4);
    });

    it('restarts the hold while a weaving rider keeps coming back', () => {
      const state = createPartnerYieldState();
      const p = { distance: 100, speed: 8 };
      let s = stepPartnerYield(state, 0, WIDE, p, rider(0), DT);
      for (let t = 0; t < 6; t += DT) {
        // In toward the partner for 0.2 s of every 0.8 s: it never starts back.
        s = stepPartnerYield(state, 0, WIDE, p, rider(t % 0.8 < 0.2 ? 1.2 : 0), DT);
        expect(s.targetM).toBeGreaterThanOrEqual(1.2 + PARTNER_SLOT_FLOOR_M - 1e-12);
        expect(s.targetM).toBeLessThanOrEqual(1.2 + PARTNER_SLOT_FLOOR_M + PARTNER_YIELD_MARGIN_M + 1e-12);
        // Once out, it stays out (to the margin it may take while held off the teleported rider).
        if (t > 1.2) expect(s.slotM).toBeGreaterThanOrEqual(1.2 + PARTNER_SLOT_FLOOR_M - 1e-3);
      }
    });

    it('moves out ahead of where the rider is heading (its reach), not only where it is', () => {
      const state = createPartnerYieldState();
      const s = stepPartnerYield(state, 0, WIDE, { distance: 100, speed: 8 }, rider(0, 100, [0, 1.6]), DT);
      expect(s.targetM).toBeCloseTo(1.6 + PARTNER_SLOT_FLOOR_M, 12);
      expect(s.slotM).toBeCloseTo(s.targetM, 12); // the first frame seats it
    });

    it('never crosses: a rider steering away leaves the partner home, a rider at full lock on its side pushes it out', () => {
      for (let i = 0; i < 4; i++) {
        const side = Math.sign(baseSlotM(i));
        const away = stepPartnerYield(createPartnerYieldState(), i, WIDE, { distance: 100, speed: 8 }, rider(-side * 1.6), DT);
        expect(away.slotM).toBe(partnerSlotM(i, WIDE));
        const toward = stepPartnerYield(createPartnerYieldState(), i, WIDE, { distance: 100, speed: 8 }, rider(side * 1.6), DT);
        expect(side * toward.slotM).toBeGreaterThanOrEqual(1.6 + PARTNER_SLOT_FLOOR_M - 1e-9);
      }
    });

    it('drops back behind the rider where the road is too narrow, 0.9 m clear every frame, and moves up again', () => {
      const state = createPartnerYieldState();
      let d = 100;
      const at = () => ({ distance: d, speed: 8 });
      let s = stepPartnerYield(state, 0, NARROW, at(), rider(0, d), DT);
      expect(s.slotM).toBeCloseTo(PARTNER_SLOT_FLOOR_M, 12);
      let prevSlot = s.slotM;
      let prevBack = s.backM;
      let maxBack = 0;
      const check = (r: RiderBeside) => {
        s = stepPartnerYield(state, 0, NARROW, at(), r, DT);
        expect(clearance(s, r, d)).toBeGreaterThanOrEqual(PARTNER_SLOT_FLOOR_M - 1e-9);
        expect(Math.sign(s.slotM)).toBe(1);
        expect(Math.abs(s.slotM - prevSlot)).toBeLessThanOrEqual(PARTNER_SLOT_MAX_RATE_MPS * DT + 1e-12);
        expect(Math.abs(s.backM - prevBack)).toBeLessThanOrEqual(PARTNER_DROP_MAX_RATE_MPS * DT + 1e-12);
        prevSlot = s.slotM;
        prevBack = s.backM;
        maxBack = Math.max(maxBack, s.backM);
        d += 8 * DT;
      };
      // The rider, through the real spring: full lock right for 3 s, then the levers released.
      const lane = { offsetM: 0, velMs: 0 };
      const ride = (steer: number, seconds: number) => {
        for (let t = 0; t < seconds; t += DT) {
          stepLane(lane, steer, DT);
          const reach = laneReach(lane, steer);
          check(rider(lane.offsetM, d, [reach.leftM, reach.rightM]));
        }
      };
      ride(1, 3);
      expect(s.backM).toBeCloseTo(PARTNER_DROP_GAP_M, 3);
      expect(s.blocked).toBe(true);
      // Back to the line: it moves up once the rider has kept clear for a second.
      ride(0, 8);
      expect(maxBack).toBeLessThanOrEqual(PARTNER_DROP_MAX_M);
      expect(s.backM).toBe(0);
      expect(s.slotM).toBeCloseTo(PARTNER_SLOT_FLOOR_M, 4);
    });

    it('takes partner 2 back with partner 0 when partner 0 has no room', () => {
      const s0 = stepPartnerYield(createPartnerYieldState(), 0, NARROW, { distance: 100, speed: 8 }, rider(1.6), DT);
      const s2 = stepPartnerYield(createPartnerYieldState(), 2, WIDE, { distance: 100, speed: 8 }, rider(1.6), DT, {
        innerTargetM: s0.targetM,
        innerBlocked: s0.blocked,
      });
      expect(s0.blocked).toBe(true);
      expect(s2.blocked).toBe(true);
      expect(s2.backM).toBeCloseTo(s0.backM, 12);
    });

    it('rides its slot without a rider, and seats afresh after a seek', () => {
      const state = createPartnerYieldState();
      expect(stepPartnerYield(state, 1, WIDE, { distance: 100, speed: 8 }, null, DT)).toMatchObject({ slotM: -1.2, backM: 0 });
      for (let f = 0; f < 60; f++) stepPartnerYield(state, 1, WIDE, { distance: 100, speed: 8 }, rider(-1.6), DT);
      const s = stepPartnerYield(state, 1, WIDE, { distance: 100 + 2 * YAW_SNAP_M, speed: 8 }, rider(0, 100 + 2 * YAW_SNAP_M), DT);
      expect(s.slotM).toBe(-1.2);
    });
  });
});
