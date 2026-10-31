import { describe, expect, it } from 'vitest';
import { createProjection } from './projection';

const PERUGIA = { type: 'tmerc', ellipsoid: 'WGS84', lat0: 43.1107, lon0: 12.3908, k0: 1 } as const;

// Reference values from PROJ 9 (pyproj): +proj=tmerc +lat_0=43.1107
// +lon_0=12.3908 +k=1 +x_0=0 +y_0=0 +ellps=WGS84.
const PROJ_REFERENCE: [number, number, number, number][] = [
  [43.1107, 12.3908, 0, 0],
  [43.05, 12.6, 17044.5348, -6722.1827],
  [43.16021, 12.31702, -6000.4385, 5502.9748],
  [43.03391, 12.63672, 20041.5283, -8501.5678],
  [44.0, 13.5, 88964.913, 99402.6398],
  [41.9, 12.5, 9061.455, -134482.5542],
];

describe('world projection (local transverse Mercator)', () => {
  const proj = createProjection(PERUGIA);

  it('matches PROJ to the millimetre, out to 135 km from the origin', () => {
    for (const [lat, lon, x, y] of PROJ_REFERENCE) {
      const [px, py] = proj.forward(lat, lon);
      expect(Math.abs(px - x)).toBeLessThan(0.001);
      expect(Math.abs(py - y)).toBeLessThan(0.001);
    }
  });

  it('round-trips world metres ↔ degrees below 1 mm', () => {
    for (let x = -20000; x <= 30000; x += 5000) {
      for (let y = -15000; y <= 15000; y += 5000) {
        const [lat, lon] = proj.inverse(x, y);
        const [bx, by] = proj.forward(lat, lon);
        expect(Math.abs(bx - x)).toBeLessThan(1e-3);
        expect(Math.abs(by - y)).toBeLessThan(1e-3);
      }
    }
  });

  it('puts the origin at (0, 0) with x east and y north', () => {
    expect(proj.forward(43.1107, 12.3908)).toEqual([0, 0]);
    const [ex] = proj.forward(43.1107, 12.4);
    const [, ny] = proj.forward(43.12, 12.3908);
    expect(ex).toBeGreaterThan(0);
    expect(ny).toBeGreaterThan(0);
  });

  it('rejects projections it does not implement', () => {
    expect(() => createProjection({ ...PERUGIA, type: 'merc' as 'tmerc' })).toThrow(/unsupported projection/);
  });
});
