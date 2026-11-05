/**
 * Pace partners' lateral slots (partnerSlots.ts): which side of the route
 * line each partner rides on, how far, how a road clamps it, and that the
 * shift is across the heading, not along it.
 */
import { describe, expect, it } from 'vitest';

import { baseSlotM, offsetLatLon, partnerSlotM, PARTNER_EDGE_MARGIN_M } from './partnerSlots';

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
