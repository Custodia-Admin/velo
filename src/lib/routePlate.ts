/**
 * Geometry for the v2 "map plate" (a route on a 1 km graticule, for places
 * without a baked world) and the v2 route profile. Pure: no DOM, no React.
 */

import type { Route } from '@/types';

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

export interface MapPlateGeometry {
  /** SVG viewBox "x y w h" in plan metres (y grows south). */
  viewBox: string;
  /** Polyline points "x,y x,y …". */
  points: string;
  start: [number, number];
  end: [number, number];
  /** Graticule path (one "M … V …" / "M … H …" per line). */
  graticule: string;
  /** Radius of the start/end markers, plan metres. */
  endRadius: number;
}

/**
 * Project the route to local plan metres and frame it with padding, widened
 * to `aspect` (width / height) so the graticule fills the whole plate.
 */
export function mapPlateGeometry(route: Pick<Route, 'points'>, aspect: number, maxPoints = 240): MapPlateGeometry | null {
  const pts = route.points;
  if (pts.length < 2) return null;
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const lon0 = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
  const kx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
  const step = Math.max(1, Math.floor(pts.length / maxPoints));
  const xy: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i += step) xy.push([(pts[i].lon - lon0) * kx, -(pts[i].lat - lat0) * M_PER_DEG_LAT]);
  const last = pts[pts.length - 1];
  xy.push([(last.lon - lon0) * kx, -(last.lat - lat0) * M_PER_DEG_LAT]);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of xy) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 200);
  const pad = span * 0.14;
  let w = maxX - minX + pad * 2;
  let h = maxY - minY + pad * 2;
  // Widen the short side so the box matches the plate's aspect.
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;

  const r = (v: number) => Math.round(v * 10) / 10;
  let g = '';
  const KM = 1000;
  for (let x = Math.ceil(x0 / KM) * KM; x < x0 + w; x += KM) g += `M${r(x)},${r(y0)} V${r(y0 + h)} `;
  for (let y = Math.ceil(y0 / KM) * KM; y < y0 + h; y += KM) g += `M${r(x0)},${r(y)} H${r(x0 + w)} `;

  return {
    viewBox: `${r(x0)} ${r(y0)} ${r(w)} ${r(h)}`,
    points: xy.map(([x, y]) => `${r(x)},${r(y)}`).join(' '),
    start: [r(xy[0][0]), r(xy[0][1])],
    end: [r(xy[xy.length - 1][0]), r(xy[xy.length - 1][1])],
    graticule: g.trim(),
    endRadius: r(Math.max(w, h) / 70),
  };
}

export interface ProfileGeometry {
  /** Closed area path under the line. */
  area: string;
  /** Polyline points of the line. */
  line: string;
  /** Closed area of the ridden part (only when `at` is given). */
  done?: string;
  /** Marker position as fractions of the box (0..1), when `at` is given. */
  here?: { x: number; y: number };
}

/**
 * Elevation profile in a `W × H` box (y down). A flat ride must look flat:
 * the vertical range is at least `minSpanM` metres (v2 mockups use 60).
 */
export function profileGeometry(
  route: Pick<Route, 'points' | 'totalDistance'>,
  { W = 1000, H = 40, samples = 96, minSpanM = 60, at }: { W?: number; H?: number; samples?: number; minSpanM?: number; at?: number } = {},
): ProfileGeometry | null {
  const pts = route.points;
  if (pts.length < 2) return null;
  const total = route.totalDistance || pts[pts.length - 1].distance || 1;
  const ele: number[] = [];
  let j = 0;
  for (let i = 0; i < samples; i++) {
    const d = (i / (samples - 1)) * total;
    while (j < pts.length - 2 && pts[j + 1].distance < d) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const f = b.distance > a.distance ? (d - a.distance) / (b.distance - a.distance) : 0;
    ele.push(a.ele + (b.ele - a.ele) * Math.min(1, Math.max(0, f)));
  }
  const lo = Math.min(...ele);
  const hi = Math.max(...ele, lo + minSpanM);
  const X = (i: number) => (i / (samples - 1)) * W;
  const Y = (e: number) => H - 2 - ((e - lo) / (hi - lo)) * (H - 6);
  const r = (v: number) => Math.round(v * 10) / 10;
  const xy = ele.map((e, i) => `${r(X(i))},${r(Y(e))}`);
  const out: ProfileGeometry = {
    area: `M0,${H} L${xy.join(' L')} L${W},${H} Z`,
    line: xy.join(' '),
  };
  if (at != null && Number.isFinite(at)) {
    const t = Math.min(1, Math.max(0, at));
    const k = t * (samples - 1);
    const i0 = Math.floor(k);
    const i1 = Math.min(samples - 1, i0 + 1);
    const e = ele[i0] + (ele[i1] - ele[i0]) * (k - i0);
    const cut = xy.slice(0, i0 + 1);
    out.done = `M0,${H} L${cut.join(' L')} L${r(t * W)},${r(Y(e))} L${r(t * W)},${H} Z`;
    out.here = { x: t, y: Y(e) / H };
  }
  return out;
}
