import { describe, it, expect } from 'vitest';
import { offsetSideways } from './laneOffset';

describe('offsetSideways', () => {
  const m = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const dLat = (b.lat - a.lat) * 111_195;
    const dLon = (b.lon - a.lon) * 111_195 * Math.cos((a.lat * Math.PI) / 180);
    return { east: dLon, north: dLat };
  };
  const p = { lat: 46.0, lon: 8.95 };

  it('riding north, right is east', () => {
    const d = m(p, offsetSideways(p.lat, p.lon, 0, 1.5));
    expect(d.east).toBeCloseTo(1.5, 2);
    expect(d.north).toBeCloseTo(0, 3);
  });

  it('riding east, right is south', () => {
    const d = m(p, offsetSideways(p.lat, p.lon, Math.PI / 2, 1));
    expect(d.north).toBeCloseTo(-1, 2);
    expect(d.east).toBeCloseTo(0, 3);
  });

  it('zero offset returns the same point', () => {
    expect(offsetSideways(p.lat, p.lon, 1, 0)).toEqual(p);
  });
});
