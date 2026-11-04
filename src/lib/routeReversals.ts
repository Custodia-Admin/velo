/**
 * Out-and-back detection for route polylines: on-the-spot U-turns
 * (`hairpins`) and stretches where the line runs back over itself
 * (`retracedStubs`), plus the cut that removes them (`removeRetraces`).
 *
 * The scenic generator (scripts/build-scenic-routes.mjs) cuts these out of
 * the OSRM geometry and refuses to write a route that still has one; the
 * route tests (scenicRouteData.test.ts) hold every shipped route to the same
 * measures. OSRM makes them when a waypoint sits off the through road: it
 * rides to the waypoint and straight back, which on screen is a pointless
 * U-turn.
 *
 * Import-free on purpose: plain Node runs it from the generator through type
 * stripping, so keep to erasable TypeScript syntax.
 */

/** [lat, lon, …] degrees; extra entries (elevation) are ignored. */
export type GeoPoint = readonly number[];

/** A vertex turning more than this is an on-the-spot U-turn, degrees. */
export const HAIRPIN_TURN_DEG = 150;
/** Points closer than this to the last kept one are merged first, metres. */
export const HAIRPIN_DEDUPE_M = 2;
/** Two stretches this close, heading opposite ways, retrace each other, metres. */
export const RETRACE_TOL_M = 12;
/**
 * Tangents further apart than this count as opposite, degrees (the hairpin
 * limit, so a sharp turn at an acute junction is a turn, not a retrace).
 */
export const RETRACE_OPPOSITE_DEG = HAIRPIN_TURN_DEG;
/**
 * A retrace whose two stretches are this far apart along the route (at most)
 * turns round on the spot or within a few metres of road: a stub. Further
 * apart is a loop that comes home on the road it left by (a lollipop), which
 * is real riding.
 */
export const STUB_MAX_SPAN_M = 250;
/** Below this span a pair is the same bend, not a stub, metres. */
export const STUB_MIN_SPAN_M = 20;
/** Retraced pairs this close share the very same road (the junction), metres. */
export const RETRACE_EXACT_M = 2;
/** A turnaround this close to either end is cut there instead of failing, metres. */
export const RETRACE_END_M = 300;

const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Local east/north metres around the route's mean latitude (good to ~0.3 % over 30 km). */
function projector(points: readonly GeoPoint[]) {
  let lat0 = 0;
  for (const p of points) lat0 += p[0];
  lat0 /= Math.max(1, points.length);
  const kx = R_EARTH * RAD * Math.cos(lat0 * RAD);
  const ky = R_EARTH * RAD;
  const lon0 = points.length ? points[0][1] : 0;
  const la0 = points.length ? points[0][0] : 0;
  return {
    x: (p: GeoPoint) => (p[1] - lon0) * kx,
    y: (p: GeoPoint) => (p[0] - la0) * ky,
    back: (x: number, y: number): [number, number] => [la0 + y / ky, lon0 + x / kx],
  };
}

export interface Hairpin {
  /** Index into the input points. */
  index: number;
  /** Distance along the route, metres. */
  distanceM: number;
  turnDeg: number;
}

/**
 * Vertices turning more than `maxTurnDeg` once points within `dedupeM` of the
 * previous kept point are merged (so GPS-style jitter doesn't count).
 */
export function hairpins(points: readonly GeoPoint[], maxTurnDeg = HAIRPIN_TURN_DEG, dedupeM = HAIRPIN_DEDUPE_M): Hairpin[] {
  const keep: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!keep.length) keep.push(i);
    else {
      const a = points[keep[keep.length - 1]];
      if (haversineM(a[0], a[1], points[i][0], points[i][1]) >= dedupeM) keep.push(i);
    }
  }
  const pr = projector(points);
  const out: Hairpin[] = [];
  let s = 0;
  for (let k = 1; k < keep.length - 1; k++) {
    const a = points[keep[k - 1]];
    const b = points[keep[k]];
    const c = points[keep[k + 1]];
    s += haversineM(a[0], a[1], b[0], b[1]);
    const ux = pr.x(b) - pr.x(a);
    const uy = pr.y(b) - pr.y(a);
    const vx = pr.x(c) - pr.x(b);
    const vy = pr.y(c) - pr.y(b);
    const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
    const turn = Math.acos(Math.max(-1, Math.min(1, cos))) / RAD;
    if (turn > maxTurnDeg) out.push({ index: keep[k], distanceM: s, turnDeg: turn });
  }
  return out;
}

/** A route resampled every ~`step` metres, in local metres with distance along it. */
export interface Track {
  x: number[];
  y: number[];
  /** Distance along the route (haversine, the app's scale), metres. */
  s: number[];
}

export function densifyTrack(points: readonly GeoPoint[], step: number): Track {
  const pr = projector(points);
  const t: Track = { x: [], y: [], s: [] };
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const q = points[i - 1];
      const d = haversineM(q[0], q[1], p[0], p[1]);
      if (d < 0.01) continue;
      const k = Math.ceil(d / step);
      for (let j = 1; j < k; j++) {
        const f = j / k;
        t.x.push(pr.x(q) + (pr.x(p) - pr.x(q)) * f);
        t.y.push(pr.y(q) + (pr.y(p) - pr.y(q)) * f);
        t.s.push(acc + d * f);
      }
      acc += d;
    }
    t.x.push(pr.x(p));
    t.y.push(pr.y(p));
    t.s.push(acc);
  }
  return t;
}

/** Unit tangent at sample k, over ±`reach` samples. */
function tangent(t: Track, k: number, reach: number): [number, number] {
  const a = Math.max(0, k - reach);
  const b = Math.min(t.x.length - 1, k + reach);
  const dx = t.x[b] - t.x[a];
  const dy = t.y[b] - t.y[a];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Sample index pairs (i < j) that retrace each other within the span limits. */
function retracePairs(t: Track, opts: Required<RetraceOptions>): [number, number][] {
  const cell = opts.tolM;
  const grid = new Map<string, number[]>();
  const key = (gx: number, gy: number) => `${gx},${gy}`;
  for (let k = 0; k < t.x.length; k++) {
    const kk = key(Math.floor(t.x[k] / cell), Math.floor(t.y[k] / cell));
    const list = grid.get(kk);
    if (list) list.push(k);
    else grid.set(kk, [k]);
  }
  const cosOpp = Math.cos(opts.oppositeDeg * RAD);
  const reach = Math.max(1, Math.round(2 / opts.stepM));
  const tan = t.x.map((_, k) => tangent(t, k, reach));
  const out: [number, number][] = [];
  for (let i = 0; i < t.x.length; i++) {
    const gx = Math.floor(t.x[i] / cell);
    const gy = Math.floor(t.y[i] / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(key(gx + dx, gy + dy)) ?? []) {
          if (j <= i) continue;
          const span = t.s[j] - t.s[i];
          if (span < opts.minSpanM || span > opts.maxSpanM) continue;
          if (Math.hypot(t.x[j] - t.x[i], t.y[j] - t.y[i]) > opts.tolM) continue;
          if (tan[i][0] * tan[j][0] + tan[i][1] * tan[j][1] > cosOpp) continue;
          out.push([i, j]);
        }
      }
    }
  }
  return out;
}

export interface RetraceOptions {
  tolM?: number;
  oppositeDeg?: number;
  minSpanM?: number;
  maxSpanM?: number;
  /** Resampling step for the search, metres. */
  stepM?: number;
}

function withDefaults(o: RetraceOptions = {}): Required<RetraceOptions> {
  return {
    tolM: o.tolM ?? RETRACE_TOL_M,
    oppositeDeg: o.oppositeDeg ?? RETRACE_OPPOSITE_DEG,
    minSpanM: o.minSpanM ?? STUB_MIN_SPAN_M,
    maxSpanM: o.maxSpanM ?? STUB_MAX_SPAN_M,
    stepM: o.stepM ?? 2,
  };
}

export interface RetracedStub {
  /** Where the route turns round, metres along it. */
  tipM: number;
  /** Outermost retraced pair found: the route there at `inM` and again at `outM`. */
  inM: number;
  outM: number;
}

/**
 * Places where the route turns round and rides back over (or right beside)
 * the road it came on: two stretches within `tolM` of each other, heading
 * opposite ways, at most `maxSpanM` apart along the route. One entry per
 * turnaround.
 */
export function retracedStubs(points: readonly GeoPoint[], options?: RetraceOptions): RetracedStub[] {
  const opts = withDefaults(options);
  const t = densifyTrack(points, opts.stepM);
  const pairs = retracePairs(t, opts);
  const stubs: RetracedStub[] = [];
  for (const [i, j] of pairs) {
    const tip = (t.s[i] + t.s[j]) / 2;
    const near = stubs.find((s) => Math.abs(s.tipM - tip) <= opts.maxSpanM / 2 && t.s[i] <= s.outM && t.s[j] >= s.inM);
    if (near) {
      near.inM = Math.min(near.inM, t.s[i]);
      near.outM = Math.max(near.outM, t.s[j]);
    } else stubs.push({ tipM: tip, inM: t.s[i], outM: t.s[j] });
  }
  return stubs.sort((a, b) => a.tipM - b.tipM);
}

/**
 * Drop exact node-for-node retraces: OSRM reaches a waypoint that sits off
 * its path by riding to it and back over the same nodes (A, B, C, B, A).
 * Each one collapses to its junction (A). Returns the remaining points and
 * the removed stretches (metres along the input).
 */
export function dropSpikes(points: readonly GeoPoint[]): { points: GeoPoint[]; cuts: RetraceCut[] } {
  const out = points.slice();
  const s: number[] = [0];
  for (let k = 1; k < out.length; k++) s.push(s[k - 1] + haversineM(out[k - 1][0], out[k - 1][1], out[k][0], out[k][1]));
  const same = (a: GeoPoint, b: GeoPoint) => haversineM(a[0], a[1], b[0], b[1]) <= 0.5;
  const cuts: RetraceCut[] = [];
  for (let i = 1; i < out.length - 1; i++) {
    if (!same(out[i - 1], out[i + 1])) continue;
    let m = 1;
    while (i - m - 1 >= 0 && i + m + 1 < out.length && same(out[i - m - 1], out[i + m + 1])) m++;
    cuts.push({ kind: 'stub', fromM: s[i - m], toM: s[i + m] });
    out.splice(i - m + 1, 2 * m);
    s.splice(i - m + 1, 2 * m);
    i = Math.max(0, i - m - 1);
  }
  return { points: out, cuts };
}

export interface RetraceCut {
  kind: 'stub' | 'head' | 'tail';
  /** Removed stretch, metres along the route before the cut. */
  fromM: number;
  toM: number;
}

export interface RemoveRetracesResult {
  /** [lat, lon] every ~`stepM` metres (simplify afterwards). */
  points: [number, number][];
  cuts: RetraceCut[];
}

/**
 * Cut every retraced stub out of a route. From the sharpest turnaround
 * outward, the walk follows both stretches while they stay within `tolM`;
 * the cut joins them where they share the very same road (the junction the
 * stub left from) or, failing that, where they part. A turnaround within
 * `RETRACE_END_M` of either end ends (or starts) the route at the turn. A
 * cut that would still leave the route reversing is an error: the waypoints
 * need moving.
 */
export function removeRetraces(points: readonly GeoPoint[], options?: RetraceOptions & { maxCutM?: number }): RemoveRetracesResult {
  const opts = withDefaults({ ...options, stepM: options?.stepM ?? 1, minSpanM: options?.minSpanM ?? 4 });
  const maxCut = options?.maxCutM ?? 2500;
  const spikes = dropSpikes(points);
  const pr = projector(spikes.points);
  for (const c of spikes.cuts) {
    if (c.toM - c.fromM > maxCut) {
      throw new Error(`a ${Math.round(c.toM - c.fromM)} m out-and-back at ${Math.round(c.fromM)} m is longer than ${maxCut} m: move a waypoint onto the through road`);
    }
  }
  let t = densifyTrack(spikes.points, opts.stepM);
  const cuts: RetraceCut[] = spikes.cuts.slice();
  // Distance along the ORIGINAL route of each current sample (cuts shift it).
  let orig = t.s.slice();
  for (let guard = 0; guard < 200; guard++) {
    const pairs = retracePairs(t, opts);
    if (!pairs.length) break;
    // Sharpest turnaround first: the pair closest together along the route.
    let [i, j] = pairs[0];
    for (const [a, b] of pairs) if (b - a < j - i) [i, j] = [a, b];
    const tipK = Math.round((i + j) / 2);
    const n = t.x.length;
    const dist = (a: number, b: number) => Math.hypot(t.x[a] - t.x[b], t.y[a] - t.y[b]);
    let exact: [number, number] | null = dist(i, j) <= RETRACE_EXACT_M ? [i, j] : null;
    const look = Math.max(2, Math.round(8 / opts.stepM));
    while (i > 0 && j < n - 1) {
      const ni = i - 1;
      let bj = -1;
      let bd = Infinity;
      for (let jj = j; jj <= Math.min(n - 1, j + look); jj++) {
        const d = dist(ni, jj);
        if (d < bd) {
          bd = d;
          bj = jj;
        }
      }
      if (bd > opts.tolM) break;
      i = ni;
      j = bj;
      if (bd <= RETRACE_EXACT_M) exact = [i, j];
    }
    const [ci, cj] = exact ?? [i, j];
    const keep = (from: number, to: number) => ({
      x: t.x.slice(from, to),
      y: t.y.slice(from, to),
      o: orig.slice(from, to),
    });
    let parts: { x: number[]; y: number[]; o: number[] }[];
    let cut: RetraceCut;
    const reverses = () => {
      // Heading over the 25 m before the join vs the 25 m after it.
      const back = Math.max(0, ci - Math.round(25 / opts.stepM));
      const ahead = Math.min(n - 1, cj + Math.round(25 / opts.stepM));
      const ux = t.x[ci] - t.x[back], uy = t.y[ci] - t.y[back];
      const vx = t.x[ahead] - t.x[cj], vy = t.y[ahead] - t.y[cj];
      const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
      return Math.acos(Math.max(-1, Math.min(1, cos))) / RAD > HAIRPIN_TURN_DEG;
    };
    if (ci === 0 || (t.s[tipK] <= RETRACE_END_M && (exact === null || reverses()))) {
      parts = [keep(tipK, n)];
      cut = { kind: 'head', fromM: orig[0], toM: orig[tipK] };
    } else if (cj === n - 1 || (t.s[n - 1] - t.s[tipK] <= RETRACE_END_M && (exact === null || reverses()))) {
      parts = [keep(0, tipK + 1)];
      cut = { kind: 'tail', fromM: orig[tipK], toM: orig[n - 1] };
    } else {
      if (reverses()) {
        throw new Error(`route turns back at ${Math.round(orig[tipK])} m and keeps going back the way it came: move a waypoint onto the through road`);
      }
      parts = [keep(0, ci + 1), keep(cj, n)];
      cut = { kind: 'stub', fromM: orig[ci], toM: orig[cj] };
    }
    if (cut.toM - cut.fromM > maxCut) {
      throw new Error(`a ${Math.round(cut.toM - cut.fromM)} m out-and-back at ${Math.round(orig[tipK])} m is longer than ${maxCut} m: move a waypoint onto the through road`);
    }
    cuts.push(cut);
    const x = parts.flatMap((p) => p.x);
    const y = parts.flatMap((p) => p.y);
    orig = parts.flatMap((p) => p.o);
    const s = [0];
    for (let k = 1; k < x.length; k++) s.push(s[k - 1] + Math.hypot(x[k] - x[k - 1], y[k] - y[k - 1]));
    t = { x, y, s };
  }
  return { points: t.x.map((x, k) => pr.back(x, t.y[k])), cuts };
}
