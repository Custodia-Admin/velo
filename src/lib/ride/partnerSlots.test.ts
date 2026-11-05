/**
 * Pace partners' lateral slots (partnerSlots.ts): which side of the route
 * line each partner rides on, how far, how a road clamps it, and that the
 * shift is across the heading, not along it.
 */
import { describe, expect, it } from 'vitest';

import {
  baseSlotM,
  createPartnerSlotState,
  easeSlotM,
  offsetLatLon,
  partnerSlotM,
  PARTNER_EDGE_MARGIN_M,
  PARTNER_SLOT_MAX_RATE_MPS,
  PARTNER_SLOT_TAU_S,
  stepPartnerSlot,
} from './partnerSlots';
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
    // A 1.5 m path (most of the Tiber route): both partners 0.65 m off the line.
    const path = { leftM: -0.75, rightM: 0.75 };
    expect(partnerSlotM(0, path)).toBeCloseTo(0.65, 9);
    expect(partnerSlotM(1, path)).toBeCloseTo(-0.65, 9);
    // The line off-centre on the path: the near side shrinks, the far side holds.
    expect(partnerSlotM(0, { leftM: -1.05, rightM: 0.45 })).toBeCloseTo(0.35, 9);
    expect(partnerSlotM(1, { leftM: -1.05, rightM: 0.45 })).toBeCloseTo(-0.95, 9);
  });

  it('puts a partner on the middle of a road narrower than its margins', () => {
    expect(partnerSlotM(0, { leftM: -0.05, rightM: 0.1 })).toBeCloseTo(0.025, 9);
    expect(partnerSlotM(1, { leftM: -0.05, rightM: 0.1 })).toBeCloseTo(0.025, 9);
  });
});

describe('slot easing', () => {
  const DT = 1 / 60;

  it('drifts a partner over at no more than 2.5 m/s (0.042 m a 60 fps frame), never jumping', () => {
    expect(PARTNER_SLOT_MAX_RATE_MPS).toBe(2.5);
    // 2.4 m → 0.65 m (a 7 m road becoming a 1.5 m path, partner 2).
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
    // Riding on: the clamp narrows to 0.65 m; the drawn slot drifts.
    expect(stepPartnerSlot(s, 0.65, 0.13, DT)).toBeCloseTo(2.4 - 2.5 / 60, 9);
    // A seek or Ride again (further than the heading filter's snap): straight into the slot.
    expect(stepPartnerSlot(s, 1.2, 0.13 + YAW_SNAP_M + 1, DT)).toBe(1.2);
    // Back to the start line after a finish: seated, not drifting in from the finish.
    expect(stepPartnerSlot(s, -0.65, 0, DT)).toBe(-0.65);
    // A jump of up to YAW_SNAP_M is riding (a slow frame), eased.
    expect(stepPartnerSlot(s, 1.2, YAW_SNAP_M, DT)).toBeCloseTo(-0.65 + 2.5 / 60, 9);
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
