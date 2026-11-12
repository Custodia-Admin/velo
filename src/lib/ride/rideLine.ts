/**
 * The line the rider is drawn on: the route, rounded through its corners.
 *
 * Shipped routes are polylines of 10–40 m straight segments that meet at
 * sharp vertices (a 90° junction is one vertex). Physics, the trainer and the
 * HUD ride that polyline. Drawn on it at a smoothed heading (the old ±12 m
 * chord), the rider went straight into each vertex while already facing up
 * to half the corner across its own path, and slid sideways ("crabbed") out
 * of it: 30–75° off its direction of travel at real corners.
 *
 * This line is the route smoothed with a Gaussian whose width adapts along
 * the route: as wide as LINE_SIGMA_MAX_M where that keeps the line within
 * LINE_MAX_OFFSET_M of the route, narrower at sharp corners (never under
 * LINE_SIGMA_MIN_M, where a hairpin may cut a little more). The rider is
 * drawn ON it and faces along it: `heading` is the tangent of the drawn path
 * itself, so the way the rider faces and the way it moves are the same, and
 * it turns gradually into each bend from a few metres before the vertex.
 * `curvature` and `stretch` give the corner lean (cornerLean.ts).
 *
 * Built once per route (cached), then read in O(1) without allocating.
 * Engine-free (src/lib/ride rule).
 */

import type { Route } from '@/types';

/** Spacing of the precomputed line, metres. */
export const LINE_STEP_M = 1;
/** Farthest the line cuts inside an ordinary corner, metres: the rider stays on the road it is riding. */
export const LINE_MAX_OFFSET_M = 1;
/** Widest smoothing (Gaussian σ), metres: a long bend of short straight segments reads as one curve. */
export const LINE_SIGMA_MAX_M = 10;
/**
 * Narrowest smoothing (Gaussian σ), metres. At a hairpin or an acute junction
 * the line keeps turning over a few metres instead of pivoting on the spot,
 * and cuts up to ~1.35 m inside (a 180° turn smoothed at 2 m).
 */
export const LINE_SIGMA_MIN_M = 2;
/**
 * How fast the smoothing width may change along the route (σ metres per
 * metre). Under 1/3, a corner stays more than 3σ away wherever the width is
 * changing, so a changing width never bends the line.
 */
export const LINE_SIGMA_SLOPE = 0.3;
/**
 * Farthest off the line anything is drawn, metres: a steered rider (≤ 1.6 m)
 * and pace partners in their slots (~2.5 m giving way). They are moved across
 * the line's sideways frame (`frameHeading`), which turns with the line but
 * never tighter than LINE_FRAME_RADIUS_M. Across the line's own heading, an
 * offset path on the inside of a bend tighter than the offset (a sharp
 * junction, a GPX out-and-back) would loop back on itself.
 */
export const LINE_FRAME_REACH_M = 3;
/**
 * Tightest radius the sideways frame turns at, metres: well beyond
 * LINE_FRAME_REACH_M, so an offset path keeps moving forward through a
 * corner even while the frame trails the line's own heading.
 */
export const LINE_FRAME_RADIUS_M = 5;

const SIGMA_LADDER = [10, 8, 6.5, 5.2, 4.2, 3.4, 2.7, 2];
/** Share of the frame's own heading mixed into an offset facing (offsetFacing). */
const OFFSET_PIVOT = 0.15;
/** Width step for the line's derivative along a changing width (∂S/∂σ), metres. */
const SIGMA_DERIV_M = 0.1;
/** Smoothing of the sideways frame's turn (Gaussian σ), metres. */
const FRAME_SMOOTH_SIGMA_M = 2;
/** Kernel widths are quantised to this many metres (the final pass caches one kernel per width). */
const SIGMA_QUANTUM_M = 0.05;
/** Metres per degree of latitude (the route's own haversine radius, lib/utils). */
const M_PER_DEG = (6_371_008.8 * Math.PI) / 180;
const DEG = Math.PI / 180;

export interface RideLine {
  /** Sample spacing, metres (LINE_STEP_M). */
  readonly step: number;
  /** Samples every `step` metres from distance 0; the last one sits at `totalDistance`. */
  readonly n: number;
  readonly totalDistance: number;
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  /** Tangent of the line, radians clockwise from north. */
  readonly heading: Float64Array;
  /** Signed curvature of the drawn path, radians per metre of path (+ = turning right / clockwise). */
  readonly curvature: Float64Array;
  /** Metres of drawn path per metre of route distance (below 1 where the line cuts a corner). */
  readonly stretch: Float64Array;
  /** Distance from the route point at the same distance, metres. */
  readonly offset: Float64Array;
  /** Sideways frame: the heading offsets are applied across (LINE_FRAME_REACH_M), radians clockwise from north. */
  readonly frameHeading: Float64Array;
  /** Its turn, radians per metre of route (+ = clockwise). */
  readonly frameRate: Float64Array;
}

export interface LinePoint {
  lat: number;
  lon: number;
  /** Tangent of the drawn path, radians clockwise from north. */
  heading: number;
  /** Radians per metre of drawn path, + = turning right. */
  curvature: number;
  /** Metres of drawn path per metre of route distance. */
  stretch: number;
  /** The sideways frame offsets are applied across (RideLine.frameHeading), and its turn per metre of route. */
  frameHeading: number;
  frameRate: number;
}

export function createLinePoint(): LinePoint {
  return { lat: 0, lon: 0, heading: 0, curvature: 0, stretch: 1, frameHeading: 0, frameRate: 0 };
}

const cache = new WeakMap<Route, RideLine>();

/** The drawn line for `route` (built on first use, then cached for the route object). */
export function rideLineFor(route: Route): RideLine {
  let line = cache.get(route);
  if (!line) {
    line = buildRideLine(route);
    cache.set(route, line);
  }
  return line;
}

/** Signed smallest difference a − b of two angles, radians. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Normalised Gaussian half-kernel (taps 0..r) for width `sigma` metres at `step` spacing. */
function kernel(sigma: number, step: number, maxR: number): Float64Array {
  const s = sigma / step;
  const r = Math.min(maxR, Math.ceil(3 * s));
  const w = new Float64Array(r + 1);
  let sum = 0;
  for (let j = 0; j <= r; j++) {
    w[j] = Math.exp(-(j * j) / (2 * s * s));
    sum += j === 0 ? w[j] : 2 * w[j];
  }
  for (let j = 0; j <= r; j++) w[j] /= sum;
  return w;
}

/**
 * Builds the line (rideLineFor caches it). Exported for tests and for
 * tuning with explicit parameters.
 */
export function buildRideLine(
  route: Route,
  opts: {
    maxOffsetM?: number;
    sigmaMaxM?: number;
    sigmaMinM?: number;
    sigmaSlope?: number;
  } = {},
): RideLine {
  let step = LINE_STEP_M;
  const maxOffset = opts.maxOffsetM ?? LINE_MAX_OFFSET_M;
  const sigmaMax = opts.sigmaMaxM ?? LINE_SIGMA_MAX_M;
  const sigmaMin = Math.min(sigmaMax, opts.sigmaMinM ?? LINE_SIGMA_MIN_M);
  const slope = opts.sigmaSlope ?? LINE_SIGMA_SLOPE;
  const totalDistance = Math.max(0, route.totalDistance);
  const pts = route.points;
  if (pts.length < 2 || totalDistance <= 0) {
    const p = pts[0] ?? { lat: 0, lon: 0 };
    const two = (v: number) => Float64Array.of(v, v);
    return {
      step,
      n: 2,
      totalDistance,
      lat: two(p.lat),
      lon: two(p.lon),
      heading: two(0),
      curvature: two(0),
      stretch: two(1),
      offset: two(0),
      frameHeading: two(0),
      frameRate: two(0),
    };
  }

  // The route every `step` metres, mirrored through its end points so a straight start or finish stays on it.
  // Evenly spaced samples, LINE_STEP_M or a little closer, the last one on the finish.
  const n = Math.ceil(totalDistance / LINE_STEP_M) + 1;
  step = totalDistance / (n - 1);
  const ext = Math.ceil((3 * sigmaMax) / step) + 1;
  const eLat = new Float64Array(n + 2 * ext);
  const eLon = new Float64Array(n + 2 * ext);
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const d = k === n - 1 ? totalDistance : k * step;
    while (seg < pts.length - 2 && pts[seg + 1].distance <= d) seg++;
    const a = pts[seg];
    const b = pts[seg + 1];
    const span = b.distance - a.distance;
    const t = span > 0 ? Math.max(0, Math.min(1, (d - a.distance) / span)) : 0;
    eLat[k + ext] = a.lat + (b.lat - a.lat) * t;
    eLon[k + ext] = a.lon + (b.lon - a.lon) * t;
  }
  for (let j = 1; j <= ext; j++) {
    const fwd = Math.min(n - 1, j);
    const back = Math.max(0, n - 1 - j);
    eLat[ext - j] = 2 * eLat[ext] - eLat[ext + fwd];
    eLon[ext - j] = 2 * eLon[ext] - eLon[ext + fwd];
    eLat[ext + n - 1 + j] = 2 * eLat[ext + n - 1] - eLat[ext + back];
    eLon[ext + n - 1 + j] = 2 * eLon[ext + n - 1] - eLon[ext + back];
  }

  let outLat = 0;
  let outLon = 0;
  const smooth = (k: number, w: Float64Array) => {
    const c = k + ext;
    let la = w[0] * eLat[c];
    let lo = w[0] * eLon[c];
    for (let j = 1; j < w.length; j++) {
      la += w[j] * (eLat[c - j] + eLat[c + j]);
      lo += w[j] * (eLon[c - j] + eLon[c + j]);
    }
    outLat = la;
    outLon = lo;
  };
  const offsetOf = (k: number) =>
    Math.hypot((outLat - eLat[k + ext]) * M_PER_DEG, (outLon - eLon[k + ext]) * M_PER_DEG * Math.cos(eLat[k + ext] * DEG));

  const kernels = new Map<number, Float64Array>();
  const kernelFor = (sg: number) => {
    const q = Math.round(sg / SIGMA_QUANTUM_M);
    let w = kernels.get(q);
    if (!w) {
      w = kernel(q * SIGMA_QUANTUM_M, step, ext - 1);
      kernels.set(q, w);
    }
    return w;
  };
  // At each sample, the widest ladder width that keeps the line within maxOffset of the route.
  const ladder = [sigmaMax, ...SIGMA_LADDER.filter((sg) => sg < sigmaMax && sg > sigmaMin)];
  const sigma = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    sigma[k] = sigmaMin;
    for (const sg of ladder) {
      smooth(k, kernelFor(sg));
      if (offsetOf(k) <= maxOffset) {
        sigma[k] = sg;
        break;
      }
    }
  }
  // The width a corner needs holds over the whole stretch it shapes (±3σ around it), and widens
  // from there by at most LINE_SIGMA_SLOPE metres per metre. A width that changed within a
  // corner's reach would kink the line there (σ narrowing to a point at the vertex bent it ~15°).
  const need = Float64Array.from(sigma);
  for (let j = 0; j < n; j++) {
    const r = Math.ceil((3 * need[j]) / step);
    for (let k = Math.max(0, j - r); k <= Math.min(n - 1, j + r); k++) if (need[j] < sigma[k]) sigma[k] = need[j];
  }
  const dS = slope * step;
  for (let k = 1; k < n; k++) sigma[k] = Math.min(sigma[k], sigma[k - 1] + dS);
  for (let k = n - 2; k >= 0; k--) sigma[k] = Math.min(sigma[k], sigma[k + 1] + dS);

  // The route's own direction at each extended sample (degrees per metre). Smoothed with a sample's
  // kernel it is the line's derivative at a fixed width; the width changing along the route adds
  // ∂S/∂σ · dσ/dd (central difference over ±SIGMA_DERIV_M), so the tangent is the drawn curve's own.
  const m = eLat.length;
  const tLat = new Float64Array(m);
  const tLon = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(m - 1, i + 1);
    tLat[i] = (eLat[b] - eLat[a]) / ((b - a) * step);
    tLon[i] = (eLon[b] - eLon[a]) / ((b - a) * step);
  }

  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const offset = new Float64Array(n);
  const heading = new Float64Array(n);
  const stretch = new Float64Array(n);
  const curvature = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const sg = Math.round(sigma[k] / SIGMA_QUANTUM_M) * SIGMA_QUANTUM_M;
    const w = kernelFor(sg);
    smooth(k, w);
    lat[k] = outLat;
    lon[k] = outLon;
    offset[k] = offsetOf(k);
    const c = k + ext;
    let dLat = w[0] * tLat[c];
    let dLon = w[0] * tLon[c];
    for (let j = 1; j < w.length; j++) {
      dLat += w[j] * (tLat[c - j] + tLat[c + j]);
      dLon += w[j] * (tLon[c - j] + tLon[c + j]);
    }
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    const dSigma = (sigma[b] - sigma[a]) / ((b - a) * step);
    if (dSigma !== 0) {
      const hi = Math.min(sigmaMax, sg + SIGMA_DERIV_M);
      const lo = Math.max(SIGMA_QUANTUM_M, sg - SIGMA_DERIV_M);
      smooth(k, kernelFor(hi));
      const hiLat = outLat;
      const hiLon = outLon;
      smooth(k, kernelFor(lo));
      dLat += ((hiLat - outLat) / (hi - lo)) * dSigma;
      dLon += ((hiLon - outLon) / (hi - lo)) * dSigma;
    }
    const dN = dLat * M_PER_DEG;
    const dE = dLon * M_PER_DEG * Math.cos(outLat * DEG);
    stretch[k] = Math.hypot(dN, dE);
    heading[k] = stretch[k] < 1e-9 ? (k > 0 ? heading[k - 1] : 0) : Math.atan2(dE, dN);
  }

  // Turn per metre of path.
  const len = (a: number, b: number) => {
    const c = Math.cos(((lat[a] + lat[b]) / 2) * DEG);
    return Math.hypot((lat[b] - lat[a]) * M_PER_DEG, (lon[b] - lon[a]) * M_PER_DEG * c);
  };
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    const path = len(a, k) + len(k, b);
    curvature[k] = path < 1e-6 ? 0 : angleDelta(heading[b], heading[a]) / path;
  }
  // The sideways frame: the line's heading followed no tighter than LINE_FRAME_RADIUS_M, forward and
  // backward, averaged so it neither lags nor leads a corner.
  const frameHeading = new Float64Array(n);
  const frameRate = new Float64Array(n);
  const back = new Float64Array(n);
  const follow = (from: number, target: number, k: number) => {
    const reach = (stretch[k] * step) / LINE_FRAME_RADIUS_M;
    return angleDelta(from + Math.max(-reach, Math.min(reach, angleDelta(target, from))), 0);
  };
  frameHeading[0] = heading[0];
  for (let k = 1; k < n; k++) frameHeading[k] = follow(frameHeading[k - 1], heading[k], k);
  back[n - 1] = heading[n - 1];
  for (let k = n - 2; k >= 0; k--) back[k] = follow(back[k + 1], heading[k], k);
  // Unwrapped, then smoothed over a couple of metres so its turn starts and stops gently (a
  // partner's facing, offsetFacing, follows the turn rate); smoothing keeps the radius bound.
  const unwrapped = back;
  unwrapped[0] = angleDelta(frameHeading[0] + angleDelta(back[0], frameHeading[0]) / 2, 0);
  for (let k = 1; k < n; k++) {
    const mid = frameHeading[k] + angleDelta(back[k], frameHeading[k]) / 2;
    unwrapped[k] = unwrapped[k - 1] + angleDelta(mid, unwrapped[k - 1]);
  }
  const fw = kernel(FRAME_SMOOTH_SIGMA_M, step, Math.ceil((3 * FRAME_SMOOTH_SIGMA_M) / step));
  for (let k = 0; k < n; k++) {
    let a = fw[0] * unwrapped[k];
    for (let j = 1; j < fw.length; j++) a += fw[j] * (unwrapped[Math.max(0, k - j)] + unwrapped[Math.min(n - 1, k + j)]);
    frameRate[k] = a;
  }
  for (let k = 0; k < n; k++) frameHeading[k] = frameRate[k];
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    frameRate[k] = (frameHeading[b] - frameHeading[a]) / ((b - a) * step);
  }
  for (let k = 0; k < n; k++) frameHeading[k] = angleDelta(frameHeading[k], 0);
  return { step, n, totalDistance, lat, lon, heading, curvature, stretch, offset, frameHeading, frameRate };
}

/**
 * Where the line is at `distance` along the route (clamped to the route):
 * position, tangent heading, curvature and stretch. Writes into `out` (no
 * allocation) and returns it.
 */
export function lineAt(route: Route, distance: number, out: LinePoint = createLinePoint()): LinePoint {
  return lineSample(rideLineFor(route), distance, out);
}

/**
 * lineAt on a built line. Between samples the position follows a cubic
 * Hermite curve through both samples along their tangents, and the heading
 * is that curve's own direction, so the drawn rider faces exactly the way it
 * moves even where the line turns tens of degrees per metre.
 */
export function lineSample(line: RideLine, distance: number, out: LinePoint = createLinePoint()): LinePoint {
  const f = Math.max(0, Math.min(line.n - 1, (Number.isFinite(distance) ? distance : 0) / line.step));
  const k = Math.min(line.n - 2, Math.floor(f));
  const t = f - k;
  const la0 = line.lat[k];
  const lo0 = line.lon[k];
  const cos = Math.cos(((la0 + line.lat[k + 1]) / 2) * DEG);
  // The chord and both tangents scaled to it, metres north / east.
  const dN = (line.lat[k + 1] - la0) * M_PER_DEG;
  const dE = (line.lon[k + 1] - lo0) * M_PER_DEG * cos;
  // The curve's own derivatives at both samples (tangent × stretch), per step.
  const h0 = line.heading[k];
  const h1 = line.heading[k + 1];
  const s0 = line.stretch[k] * line.step;
  const s1 = line.stretch[k + 1] * line.step;
  const n0 = Math.cos(h0) * s0;
  const e0 = Math.sin(h0) * s0;
  const n1 = Math.cos(h1) * s1;
  const e1 = Math.sin(h1) * s1;
  // Hermite position (relative to sample k) and direction.
  const t2 = t * t;
  const t3 = t2 * t;
  const b1 = t3 - 2 * t2 + t;
  const b2 = -2 * t3 + 3 * t2;
  const b3 = t3 - t2;
  out.lat = la0 + (b1 * n0 + b2 * dN + b3 * n1) / M_PER_DEG;
  out.lon = lo0 + (cos > 1e-9 ? (b1 * e0 + b2 * dE + b3 * e1) / (M_PER_DEG * cos) : 0);
  const d1 = 3 * t2 - 4 * t + 1;
  const d2 = -6 * t2 + 6 * t;
  const d3 = 3 * t2 - 2 * t;
  const vN = d1 * n0 + d2 * dN + d3 * n1;
  const vE = d1 * e0 + d2 * dE + d3 * e1;
  out.heading = vN === 0 && vE === 0 ? h0 + angleDelta(h1, h0) * t : Math.atan2(vE, vN);
  out.curvature = line.curvature[k] + (line.curvature[k + 1] - line.curvature[k]) * t;
  // Metres of path per metre of route: the curve's own speed.
  const speed = Math.hypot(vN, vE) / line.step;
  out.stretch = speed > 1e-9 ? speed : line.stretch[k] + (line.stretch[k + 1] - line.stretch[k]) * t;
  // The sideways frame through both samples at their turn rates (cubic Hermite), and its exact turn there.
  const f0 = line.frameHeading[k];
  const df = angleDelta(line.frameHeading[k + 1], f0);
  const m0 = line.frameRate[k] * line.step;
  const m1 = line.frameRate[k + 1] * line.step;
  out.frameHeading = angleDelta(f0 + b1 * m0 + b2 * df + b3 * m1, 0);
  out.frameRate = (d1 * m0 + d2 * df + d3 * m1) / line.step;
  return out;
}

/**
 * The way something drawn `offsetM` metres right of the line at `point`
 * (across its `frameHeading`) moves along the route, radians clockwise from
 * north: the line's direction, bent by the frame's turn. On the line, and
 * wherever the frame turns with the line, it is the line's heading. On the
 * inside of a corner much tighter than the offset, where that path all but
 * stops, it leans on the frame's heading (OFFSET_PIVOT), so a partner
 * pivots round the apex instead of spinning on the spot.
 */
export function offsetFacing(point: LinePoint, offsetM: number): number {
  if (!offsetM) return point.heading;
  // d/dd (line point + offset · right(frame)) = stretch · forward(line) − offset · frameRate · forward(frame).
  const k = offsetM * point.frameRate - OFFSET_PIVOT * point.stretch;
  const east = point.stretch * Math.sin(point.heading) - k * Math.sin(point.frameHeading);
  const north = point.stretch * Math.cos(point.heading) - k * Math.cos(point.frameHeading);
  return Math.hypot(east, north) < 1e-6 ? point.heading : Math.atan2(east, north);
}

const scratch = createLinePoint();

/** The line's tangent at `distance`, radians clockwise from north. */
export function lineHeadingAt(route: Route, distance: number): number {
  return lineAt(route, distance, scratch).heading;
}
