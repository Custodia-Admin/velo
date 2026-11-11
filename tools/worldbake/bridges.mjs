// Bridges as structures (recipe `"bridges": true`).
//
// Without this step a bridge is just a road ribbon spanning straight between
// the ground at its two ends, and the route carve treats a bridge the route
// rides like any other ground: it fills the valley under it with an earth
// dam at deck level. With it the bake decides, once and offline:
//
// - **Deck heights.** Bridge pieces joined end to end form a network (the
//   three OSM ways of the Detroit–Superior Bridge are one deck). A network
//   stands on the ground at its abutments (an end no other bridge piece
//   continues, or where it meets a road on the ground); its inner joints
//   take a length-weighted Laplace solve, so a chain is one straight line
//   from abutment to abutment.
// - **Headroom.** Where a route passes under a deck, the deck's underside
//   stays `DECK_HEADROOM_M` over the route (the rider and the chase camera),
//   by pinning the deck there and solving again.
// - **Ridden decks.** Where a route rides a deck of at least
//   `2 · DECK_END_ZONE_M`, the carve leaves the ground under it alone, and
//   the route's render height is the deck itself.
// - **Ground under decks.** Terrain under a deck's middle (away from the
//   abutments) is kept `UNDER_DECK_MARGIN_M` under its underside, so the
//   ground can never poke through a deck.
// - **Piers** stand under every deck high enough to need them, never in a
//   route's corridor or on a drawn road.
//
// Output: the `bridges` layer (WORLD-FORMAT.md), one deck per bridge road
// with a height per vertex, the piers, and each route's ridden spans.

import { ROAD_FLAGS } from './buildVectors.mjs';

/** Deck thickness (top of the road to the underside) per road class, metres. */
export const DECK_THICKNESS_M = {
  motorway: 1.8, trunk: 1.8, primary: 1.4, secondary: 1.2, tertiary: 1.2,
  unclassified: 1, residential: 1, living_street: 1, service: 1, track: 1,
  pedestrian: 0.7, cycleway: 0.6, bridleway: 0.6, path: 0.6, footway: 0.6, steps: 0.6,
};
/** Headroom kept between a route and the underside of a deck crossing over it, metres. */
export const DECK_HEADROOM_M = 4.5;
/**
 * Steepest a deck or its approach ramp may climb to clear a route, per road
 * class (rise over run). GLO-30 carries no embankments, and OSM maps an
 * overpass as a short bridge piece over the path, so its abutments come out
 * at valley level: the deck is lifted, and where that lifts an abutment the
 * road beyond it becomes an approach ramp at this grade (`planApproaches`).
 */
export const DECK_GRADE = { motorway: 0.04, trunk: 0.04, primary: 0.05, secondary: 0.05, footway: 0.08, path: 0.08, cycleway: 0.08, bridleway: 0.08, pedestrian: 0.08, steps: 0.08 };
export const DECK_GRADE_DEFAULT = 0.06;
/** Longest approach ramp, metres: a lift that needs more is a bake error. */
export const APPROACH_MAX_M = 450;
/** Deck pieces and approach ramps carry a vertex at least this often, metres (heights are per vertex). */
export const DECK_VERTEX_M = 6;
/** A deck within this of the ground there is at grade: no slab, the renderer drapes it. */
export const AT_GRADE_M = 0.3;
/** Ground under a deck's middle stays this far under its underside, metres. */
export const UNDER_DECK_MARGIN_M = 0.4;
/**
 * Near an abutment the ground is left as it is, so the deck meets the road
 * on the ground: 1.5 cells, which is more than a bilinear sample's reach
 * (cell · √2), so the ground the abutment stands on is never moved.
 */
export const DECK_END_ZONE_CELLS = 1.5;
/** A route rides a deck within this distance beyond its half-width, heading within RIDE_HEADING_DEG. */
export const RIDE_SLACK_M = 1.5;
export const RIDE_HEADING_DEG = 35;
/** Shorter rides (a route crossing a bridge end) are ignored, metres. */
export const RIDE_MIN_M = 4;
/** Piers stand where the underside is at least this high, metres. */
export const PIER_MIN_CLEARANCE_M = 2.5;
/** No pier within this distance of a route centreline, metres. */
export const PIER_ROUTE_CLEAR_M = 4;
/** No pier within a drawn road's half-width plus this, metres. */
export const PIER_ROAD_CLEAR_M = 1;
/** Pier depth along the deck, metres. */
export const PIER_DEPTH_M = 1.2;
/**
 * Beside a deck the ground may rise at this slope from the underside's cap
 * (rise over run), up to BANK_REACH_M out: a DSM that carries the deck
 * (Cleveland's Main Avenue viaduct stands 15 m proud of the Flats in
 * GLO-30) loses its ridge instead of keeping two walls either side.
 */
export const BANK_SLOPE = 1;
export const BANK_REACH_M = 30;

const keyOf = (x, y) => `${x},${y}`;

/** Road piece i's polyline in metres and its cumulative length. */
function piecePath(road) {
  const p = road.p;
  const xy = [];
  const s = [];
  let acc = 0;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i] / 10, y = p[i + 1] / 10;
    if (i > 0) acc += Math.hypot(x - xy[xy.length - 2], y - xy[xy.length - 1]);
    xy.push(x, y);
    s.push(acc);
  }
  return { xy, s, len: acc };
}

export function roadWidth(roads, road) {
  return road.w ?? roads.widths[road.c];
}

export function deckThickness(roads, road) {
  return DECK_THICKNESS_M[roads.classes[road.c]] ?? 1;
}

export function deckGrade(roads, road) {
  return DECK_GRADE[roads.classes[road.c]] ?? DECK_GRADE_DEFAULT;
}

/** Give a road piece a vertex at least every `maxSegM` metres, in place (points on the same line, decimetres). */
export function densifyPiece(road, maxSegM = DECK_VERTEX_M) {
  const p = road.p;
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], ay = p[i - 1], bx = p[i], by = p[i + 1];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 10 / maxSegM);
    for (let k = 1; k < n; k++) out.push(Math.round(ax + ((bx - ax) * k) / n), Math.round(ay + ((by - ay) * k) / n));
    out.push(bx, by);
  }
  road.p = out;
}

/**
 * Put a vertex at arclength `s` of a road piece, in place, unless one is
 * within `tolM` already. Returns the arclength of the vertex there.
 */
export function insertVertexAt(road, s, tolM = 0.3) {
  const path = piecePath(road);
  let k = 1;
  while (k < path.s.length - 1 && path.s[k] < s) k++;
  if (Math.abs(path.s[k] - s) <= tolM) return path.s[k];
  if (Math.abs(path.s[k - 1] - s) <= tolM) return path.s[k - 1];
  const t = (s - path.s[k - 1]) / (path.s[k] - path.s[k - 1]);
  const x = Math.round(road.p[2 * k - 2] + (road.p[2 * k] - road.p[2 * k - 2]) * t);
  const y = Math.round(road.p[2 * k - 1] + (road.p[2 * k + 1] - road.p[2 * k - 1]) * t);
  road.p.splice(2 * k, 0, x, y);
  return piecePath(road).s[k];
}

/**
 * Bridge pieces (bridge flag, not a tunnel) grouped into networks joined
 * end to end. A node is an abutment when no other bridge piece ends there
 * or a road on the ground touches it.
 */
export function bridgeNetworks(roads) {
  const isBridge = (r) => r.f && r.f & ROAD_FLAGS.bridge && !(r.f & ROAD_FLAGS.tunnel);
  const ground = new Set();
  roads.roads.forEach((r) => {
    if (isBridge(r) || (r.f && r.f & ROAD_FLAGS.tunnel)) return;
    for (let i = 0; i < r.p.length; i += 2) ground.add(keyOf(r.p[i], r.p[i + 1]));
  });
  const ends = new Map();
  const pieces = [];
  roads.roads.forEach((r, ri) => {
    if (!isBridge(r) || r.p.length < 4) return;
    pieces.push(ri);
    const n = r.p.length;
    for (const [end, k] of [[0, keyOf(r.p[0], r.p[1])], [1, keyOf(r.p[n - 2], r.p[n - 1])]]) {
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ ri, end });
    }
  });
  // Union-find over pieces sharing an end.
  const parent = new Map(pieces.map((ri) => [ri, ri]));
  const find = (a) => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)));
      a = parent.get(a);
    }
    return a;
  };
  for (const list of ends.values()) for (let i = 1; i < list.length; i++) {
    const a = find(list[0].ri), b = find(list[i].ri);
    if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
  }
  const byRoot = new Map();
  for (const ri of pieces) {
    const root = find(ri);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(ri);
  }
  const nets = [];
  for (const members of [...byRoot.values()].sort((a, b) => a[0] - b[0])) {
    const nodes = new Map();
    for (const ri of members) {
      const r = roads.roads[ri];
      const n = r.p.length;
      for (const [x, y] of [[r.p[0], r.p[1]], [r.p[n - 2], r.p[n - 1]]]) {
        const k = keyOf(x, y);
        if (!nodes.has(k)) nodes.set(k, { key: k, x: x / 10, y: y / 10, boundary: ends.get(k).length === 1 || ground.has(k) });
      }
    }
    nets.push({ pieces: members, nodes });
  }
  return nets;
}

/** Segment index over bridge pieces for nearest-piece queries. */
function pieceIndex(roads, pieces, cell = 50) {
  const grid = new Map();
  const paths = new Map();
  for (const ri of pieces) {
    const path = piecePath(roads.roads[ri]);
    paths.set(ri, path);
    const { xy } = path;
    for (let k = 0; k + 3 < xy.length; k += 2) {
      const c0 = Math.floor(Math.min(xy[k], xy[k + 2]) / cell), c1 = Math.floor(Math.max(xy[k], xy[k + 2]) / cell);
      const r0 = Math.floor(Math.min(xy[k + 1], xy[k + 3]) / cell), r1 = Math.floor(Math.max(xy[k + 1], xy[k + 3]) / cell);
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
        const key = `${c},${r}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push([ri, k / 2]);
      }
    }
  }
  const near = (x, y, reach) => {
    const out = new Set();
    for (let c = Math.floor((x - reach) / cell); c <= Math.floor((x + reach) / cell); c++) {
      for (let r = Math.floor((y - reach) / cell); r <= Math.floor((y + reach) / cell); r++) {
        for (const e of grid.get(`${c},${r}`) ?? []) out.add(e);
      }
    }
    return [...out];
  };
  return { paths, near };
}

/** Nearest point of segment k of `path` to (x, y): distance, arclength, unit direction. */
function onSegment(path, k, x, y) {
  const { xy, s } = path;
  const ax = xy[2 * k], ay = xy[2 * k + 1], bx = xy[2 * k + 2], by = xy[2 * k + 3];
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const l = Math.sqrt(l2) || 1;
  return { d: Math.hypot(ax + dx * t - x, ay + dy * t - y), s: s[k] + (s[k + 1] - s[k]) * t, ux: dx / l, uy: dy / l };
}

/**
 * Where each route rides a bridge: runs of route samples (≈1 m apart,
 * routeCoverage.sampleAppRoute) within a piece's half-width + RIDE_SLACK_M
 * and heading along it. Returns per route `[{ s0, s1, net, pieces }]`
 * (`pieces`: the road indices ridden).
 */
export function riddenSpans(routeSamples, roads, nets) {
  const netOf = new Map();
  nets.forEach((n, i) => n.pieces.forEach((ri) => netOf.set(ri, i)));
  const idx = pieceIndex(roads, [...netOf.keys()]);
  const cosMax = Math.cos((RIDE_HEADING_DEG * Math.PI) / 180);
  return routeSamples.map((r) => {
    const on = new Array(r.x.length).fill(-1);
    const pieceAt = new Array(r.x.length).fill(-1);
    for (let i = 0; i < r.x.length; i++) {
      const j = Math.min(r.x.length - 1, i + 1), h = Math.max(0, i - 1);
      const hx = r.x[j] - r.x[h], hy = r.y[j] - r.y[h];
      const hl = Math.hypot(hx, hy) || 1;
      let best = Infinity;
      for (const [ri, k] of idx.near(r.x[i], r.y[i], 25)) {
        const road = roads.roads[ri];
        const q = onSegment(idx.paths.get(ri), k, r.x[i], r.y[i]);
        if (q.d > roadWidth(roads, road) / 2 + RIDE_SLACK_M) continue;
        if (Math.abs((q.ux * hx + q.uy * hy) / hl) < cosMax) continue;
        if (q.d < best) {
          best = q.d;
          on[i] = netOf.get(ri);
          pieceAt[i] = ri;
        }
      }
    }
    const spans = [];
    let i = 0;
    while (i < on.length) {
      if (on[i] < 0) {
        i++;
        continue;
      }
      const net = on[i];
      let j = i;
      // Bridge short gaps (≤ 3 samples) on the same network.
      for (let k = i + 1; k < on.length && k <= j + 4; k++) if (on[k] === net) j = k;
      while (j + 1 < on.length && on[j + 1] === net) {
        j++;
        for (let k = j + 1; k < on.length && k <= j + 4; k++) if (on[k] === net) j = k;
      }
      if (r.s[j] - r.s[i] >= RIDE_MIN_M) {
        const pieces = [...new Set(pieceAt.slice(i, j + 1).filter((ri) => ri >= 0))].sort((a, b) => a - b);
        spans.push({ s0: r.s[i], s1: r.s[j], net, pieces });
      }
      i = j + 1;
    }
    return spans;
  });
}

/**
 * Heights of every node of a network: Dirichlet nodes keep theirs, the
 * rest take the length-weighted mean of their neighbours (Gauss–Seidel), so
 * along a chain the deck is linear by arclength between pinned nodes.
 * `pins` adds Dirichlet points inside pieces: `{ ri, s, z }`; `abutZ`
 * (node key → z) lifts abutments that stand on an approach ramp. A pin
 * between two vertices is lost in the per-vertex output: put a vertex
 * there first (`insertVertexAt`).
 */
export function solveNetwork(net, roads, groundAt, pins = [], abutZ = new Map()) {
  // Split every piece at its pins into edges between graph nodes.
  const nodes = new Map();
  for (const n of net.nodes.values()) nodes.set(n.key, { z: n.boundary ? (abutZ.get(n.key) ?? groundAt(n.x, n.y)) : NaN, fixed: n.boundary, nb: [] });
  const pieceNodes = new Map();
  for (const ri of net.pieces) {
    const r = roads.roads[ri];
    const path = piecePath(r);
    const n = r.p.length;
    const a = keyOf(r.p[0], r.p[1]), b = keyOf(r.p[n - 2], r.p[n - 1]);
    const chain = [{ key: a, s: 0 }];
    pins.filter((p) => p.ri === ri).sort((p, q) => p.s - q.s).forEach((p, i) => {
      const key = `pin:${ri}:${i}`;
      nodes.set(key, { z: p.z, fixed: true, nb: [] });
      chain.push({ key, s: p.s });
    });
    chain.push({ key: b, s: path.len });
    for (let i = 1; i < chain.length; i++) {
      const w = 1 / Math.max(0.5, chain[i].s - chain[i - 1].s);
      nodes.get(chain[i - 1].key).nb.push([chain[i].key, w]);
      nodes.get(chain[i].key).nb.push([chain[i - 1].key, w]);
    }
    pieceNodes.set(ri, chain);
  }
  const free = [...nodes.entries()].filter(([, v]) => !v.fixed);
  if (free.length && free.length === nodes.size) {
    // No abutment at all (a closed loop of bridge pieces): stand every node on the ground.
    for (const [k, v] of free) {
      const n = net.nodes.get(k);
      v.z = groundAt(n.x, n.y);
      v.fixed = true;
    }
  } else if (free.length) {
    const fixedMean = [...nodes.values()].filter((v) => v.fixed).reduce((a, v, _, arr) => a + v.z / arr.length, 0);
    for (const [, v] of free) v.z = fixedMean;
    for (let it = 0; it < 5000; it++) {
      let change = 0;
      for (const [, v] of free) {
        let sw = 0, sz = 0;
        for (const [k, w] of v.nb) {
          sw += w;
          sz += w * nodes.get(k).z;
        }
        const z = sz / sw;
        change = Math.max(change, Math.abs(z - v.z));
        v.z = z;
      }
      if (change < 1e-5) break;
    }
  }
  // Per-vertex heights, linear by arclength between the chain's graph nodes.
  const z = new Map();
  for (const ri of net.pieces) {
    const chain = pieceNodes.get(ri);
    const { s } = piecePath(roads.roads[ri]);
    z.set(ri, s.map((sv) => {
      let k = 1;
      while (k < chain.length - 1 && chain[k].s < sv) k++;
      const a = chain[k - 1], b = chain[k];
      const za = nodes.get(a.key).z, zb = nodes.get(b.key).z;
      const t = b.s > a.s ? Math.min(1, Math.max(0, (sv - a.s) / (b.s - a.s))) : 0;
      return za + (zb - za) * t;
    }));
  }
  return z;
}

/** Deck height of piece `ri` at arclength `s` from per-vertex heights `zs`. */
export function zAlong(path, zs, s) {
  const S = path.s;
  if (s <= 0) return zs[0];
  if (s >= path.len) return zs[zs.length - 1];
  let k = 1;
  while (k < S.length - 1 && S[k] < s) k++;
  const t = S[k] > S[k - 1] ? (s - S[k - 1]) / (S[k] - S[k - 1]) : 0;
  return zs[k - 1] + (zs[k] - zs[k - 1]) * t;
}

/** 2D intersections of polyline (flat [x, y, …]) with a piece: `{ s, k, t }` on the polyline and the piece arclength. */
function crossings(lineX, lineY, path) {
  const out = [];
  const { xy } = path;
  for (let i = 1; i < lineX.length; i++) {
    const ax = lineX[i - 1], ay = lineY[i - 1], bx = lineX[i], by = lineY[i];
    for (let k = 0; k + 3 < xy.length; k += 2) {
      const cx = xy[k], cy = xy[k + 1], dx = xy[k + 2], dy = xy[k + 3];
      const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
      const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      // A vertex of either line on the other is one crossing, not two.
      if ((t === 0 && i > 1) || (u === 0 && k > 0)) continue;
      out.push({ i, t, ps: path.s[k / 2] + (path.s[k / 2 + 1] - path.s[k / 2]) * u });
    }
  }
  return out;
}

/**
 * Deck heights for every network. `groundAt` is the terrain (after the
 * carve); `routes` are the carve's prepared routes (x, y, s, target) with
 * their ridden `spans`. Returns `{ z: Map(ri → per-vertex heights), pins }`.
 */
export function deckHeights({ roads, nets, groundAt, routes, abutZ = new Map() }) {
  const result = new Map();
  const pinsOut = [];
  const pathOf = new Map();
  nets.forEach((net) => net.pieces.forEach((ri) => pathOf.set(ri, piecePath(roads.roads[ri]))));
  const solved = nets.map((net) => solveNetwork(net, roads, groundAt, [], abutZ));
  // A route's height at polyline point (segment i, t): the deck it rides, else the carved ground.
  const routeHeightAt = (r, i, t) => {
    const s = r.s[i - 1] + (r.s[i] - r.s[i - 1]) * t;
    const x = r.x[i - 1] + (r.x[i] - r.x[i - 1]) * t, y = r.y[i - 1] + (r.y[i] - r.y[i - 1]) * t;
    const span = r.spans.find((sp) => s >= sp.s0 && s <= sp.s1);
    if (span) {
      let best = null;
      for (const ri of span.pieces) {
        const path = pathOf.get(ri);
        for (let k = 0; k + 1 < path.s.length; k++) {
          const q = onSegment(path, k, x, y);
          if (!best || q.d < best.d) best = { d: q.d, z: zAlong(path, solved[span.net].get(ri), q.s) };
        }
      }
      if (best) return Math.max(best.z, groundAt(x, y));
    }
    return groundAt(x, y);
  };
  nets.forEach((net, ni) => {
    // Headroom over every route passing under this network (not riding it there).
    const pins = [];
    for (const r of routes) {
      for (const ri of net.pieces) {
        const path = pathOf.get(ri);
        const road = roads.roads[ri];
        for (const c of crossings(r.x, r.y, path)) {
          const s = r.s[c.i - 1] + (r.s[c.i] - r.s[c.i - 1]) * c.t;
          if (r.spans.some((sp) => sp.net === ni && s >= sp.s0 - 2 && s <= sp.s1 + 2)) continue;
          const need = routeHeightAt(r, c.i, c.t) + DECK_HEADROOM_M + deckThickness(roads, road);
          const have = zAlong(path, solved[ni].get(ri), c.ps);
          const [x, y] = pointAt(path, c.ps);
          if (have < need) pins.push({ ri, s: c.ps, x, y, z: need, route: r.id, routeS: s, liftM: need - have });
        }
      }
    }
    if (pins.length) {
      result.set(ni, solveNetwork(net, roads, groundAt, pins, abutZ));
      pinsOut.push(...pins);
    } else {
      result.set(ni, solved[ni]);
    }
  });
  const z = new Map();
  for (const m of result.values()) for (const [ri, zs] of m) z.set(ri, zs);
  return { z, pins: pinsOut };
}

/** Re-find each pin's arclength on its (possibly re-vertexed) piece and put a vertex there. */
export function anchorPins(roads, pins) {
  for (const p of pins) {
    const road = roads.roads[p.ri];
    const path = piecePath(road);
    let best = null;
    for (let k = 0; k + 1 < path.s.length; k++) {
      const q = onSegment(path, k, p.x, p.y);
      if (!best || q.d < best.d) best = q;
    }
    p.s = insertVertexAt(road, best.s);
  }
}

/** Shortest distance along the network from (piece ri, arclength s) to every graph node. */
function networkDistances(net, roads, ri, s) {
  const adj = new Map();
  const link = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push([b, w]);
  };
  for (const pj of net.pieces) {
    const r = roads.roads[pj];
    const n = r.p.length;
    const a = keyOf(r.p[0], r.p[1]), b = keyOf(r.p[n - 2], r.p[n - 1]);
    const len = piecePath(r).len;
    if (pj === ri) {
      link('src', a, s);
      link('src', b, len - s);
    }
    link(a, b, len);
    link(b, a, len);
  }
  const dist = new Map([['src', 0]]);
  const done = new Set();
  for (;;) {
    let u = null;
    for (const [k, d] of dist) if (!done.has(k) && (u === null || d < dist.get(u))) u = k;
    if (u === null) break;
    done.add(u);
    for (const [v, w] of adj.get(u) ?? []) {
      const d = dist.get(u) + w;
      if (!dist.has(v) || d < dist.get(v)) dist.set(v, d);
    }
  }
  return dist;
}

/**
 * Lift abutments so every headroom pin is reached at no more than the
 * pinned piece's DECK_GRADE, and turn the road beyond each lifted abutment
 * into an approach ramp: walked from the abutment along the ground road
 * that continues the bridge (same name, then class, then the straightest),
 * at that grade until it meets the ground. Approach pieces get a vertex
 * every DECK_VERTEX_M and one where the ramp lands (in place); a ramp may
 * not touch a road a route rides (`ridden`), nor run past APPROACH_MAX_M.
 * Returns `{ abutZ, approaches: Map(ri → per-vertex z), lifts }`.
 */
export function planApproaches({ roads, nets, pins, groundAt, ridden }) {
  const abutZ = new Map();
  const lifts = [];
  const isStructure = (r) => r.f && r.f & (ROAD_FLAGS.bridge | ROAD_FLAGS.tunnel);
  // Ground road ends by node key.
  const ends = new Map();
  roads.roads.forEach((r, ri) => {
    if (isStructure(r) || r.p.length < 4) return;
    const n = r.p.length;
    for (const [end, k] of [[0, keyOf(r.p[0], r.p[1])], [1, keyOf(r.p[n - 2], r.p[n - 1])]]) {
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ ri, end });
    }
  });
  const bridgeKeys = new Set();
  for (const net of nets) for (const k of net.nodes.keys()) bridgeKeys.add(k);
  nets.forEach((net) => {
    const netPins = pins.filter((p) => net.pieces.includes(p.ri));
    if (!netPins.length) return;
    for (const pin of netPins) {
      const g = deckGrade(roads, roads.roads[pin.ri]);
      const dist = networkDistances(net, roads, pin.ri, pin.s);
      for (const node of net.nodes.values()) {
        if (!node.boundary || !dist.has(node.key)) continue;
        const need = pin.z - g * dist.get(node.key);
        const ground = groundAt(node.x, node.y);
        if (need > ground + 0.05 && need > (abutZ.get(node.key)?.z ?? -Infinity)) abutZ.set(node.key, { z: need, grade: g, node, pin });
      }
    }
  });
  const approaches = new Map();
  for (const [key, a] of abutZ) {
    const { node, grade } = a;
    const lift = a.z - groundAt(node.x, node.y);
    const rampM = lift / grade;
    if (rampM > APPROACH_MAX_M) {
      throw new Error(`bridges: ${roads.names[roads.roads[a.pin.ri].n] ?? 'a bridge'} needs a ${lift.toFixed(1)} m lift over route ${a.pin.route} at ${a.pin.routeS.toFixed(0)} m: a ${rampM.toFixed(0)} m approach, over APPROACH_MAX_M`);
    }
    // Outward direction: from the bridge piece ending here, away from it.
    const bridgeRi = net0(nets, key, roads);
    const br = roads.roads[bridgeRi.ri];
    const bp = br.p;
    const n = bp.length;
    let dir = bridgeRi.end === 0 ? [bp[0] - bp[2], bp[1] - bp[3]] : [bp[n - 2] - bp[n - 4], bp[n - 1] - bp[n - 3]];
    let at = key;
    let walked = 0;
    let from = -1;
    const walk = [];
    while (walked < rampM) {
      const cands = (ends.get(at) ?? []).filter((c) => c.ri !== from);
      if (!cands.length || (walk.length && bridgeKeys.has(at))) break;
      const dl = Math.hypot(dir[0], dir[1]) || 1;
      let best = null;
      for (const c of cands) {
        const r = roads.roads[c.ri];
        const p = r.p, m = p.length;
        const v = c.end === 0 ? [p[2] - p[0], p[3] - p[1]] : [p[m - 4] - p[m - 2], p[m - 3] - p[m - 1]];
        const cos = (v[0] * dir[0] + v[1] * dir[1]) / ((Math.hypot(v[0], v[1]) || 1) * dl);
        const score = (r.n !== undefined && r.n === br.n ? 2 : 0) + (r.c === br.c ? 1 : 0) + cos;
        if (!best || score > best.score) best = { ...c, score };
      }
      if (ridden.has(best.ri)) {
        throw new Error(`bridges: the approach ramp of ${roads.names[br.n] ?? 'a bridge'} (lift ${lift.toFixed(1)} m over route ${a.pin.route} at ${a.pin.routeS.toFixed(0)} m) would run onto a road a route rides`);
      }
      const road = roads.roads[best.ri];
      densifyPiece(road);
      const len = piecePath(road).len;
      const t0 = walked;
      if (walked + len > rampM) insertVertexAt(road, best.end === 0 ? rampM - walked : len - (rampM - walked));
      walk.push({ ri: best.ri, reversed: best.end === 1, t0 });
      walked += len;
      const p = road.p, m = p.length;
      at = best.end === 0 ? keyOf(p[m - 2], p[m - 1]) : keyOf(p[0], p[1]);
      dir = best.end === 0 ? [p[m - 2] - p[m - 4], p[m - 1] - p[m - 3]] : [p[0] - p[2], p[1] - p[3]];
      from = best.ri;
    }
    for (const w of walk) {
      const road = roads.roads[w.ri];
      const path = piecePath(road);
      const zs = path.s.map((sv, k) => {
        const tm = w.t0 + (w.reversed ? path.len - sv : sv);
        return Math.max(groundAt(road.p[2 * k] / 10, road.p[2 * k + 1] / 10), a.z - grade * tm);
      });
      const prev = approaches.get(w.ri);
      approaches.set(w.ri, prev ? zs.map((v, k) => Math.max(v, prev[k] ?? -Infinity)) : zs);
    }
    // No road to land on (a dead end, a T-junction mid-road): the ramp stops
    // in the air, so an abutment block carries it down to the ground there.
    let block = null;
    if (walked < rampM) {
      let x = node.x, y = node.y, ux = dir[0], uy = dir[1];
      if (walk.length) {
        const last = walk[walk.length - 1];
        const lp = roads.roads[last.ri].p;
        const m = lp.length;
        [x, y] = last.reversed ? [lp[0] / 10, lp[1] / 10] : [lp[m - 2] / 10, lp[m - 1] / 10];
      }
      const ul = Math.hypot(ux, uy) || 1;
      const road = walk.length ? roads.roads[walk[walk.length - 1].ri] : br;
      block = { x, y, ux: ux / ul, uy: uy / ul, top: a.z - grade * walked - deckThickness(roads, br), halfAcross: roadWidth(roads, road) / 2 + 0.25 };
    }
    lifts.push({ bridge: roads.names[br.n] ?? null, route: a.pin.route, routeS: a.pin.routeS, liftM: lift, rampM: Math.min(rampM, walked), walkedM: walked, pieces: walk.length, block });
  }
  const abut = new Map([...abutZ].map(([k, v]) => [k, v.z]));
  return { abutZ: abut, approaches, lifts };
}

/** Half-length of an abutment block along the road, metres. */
export const BLOCK_HALF_ALONG_M = 1.5;

/**
 * Abutment blocks where a ramp stops in the air (`planApproaches` lifts with
 * a `block`), in the piers' format: centred BLOCK_HALF_ALONG_M back from the
 * end, from under the ground to the deck's underside. A block that would
 * stand within PIER_ROUTE_CLEAR_M of a route is a bake error.
 */
export function abutmentBlocks(lifts, groundAt, routeLines) {
  const out = [];
  for (const l of lifts) {
    const b = l.block;
    if (!b) continue;
    const cx = b.x - b.ux * BLOCK_HALF_ALONG_M, cy = b.y - b.uy * BLOCK_HALF_ALONG_M;
    const reach = Math.hypot(BLOCK_HALF_ALONG_M, b.halfAcross) + PIER_ROUTE_CLEAR_M;
    for (const line of routeLines) {
      for (let i = 0; i < line.x.length; i++) {
        if (Math.hypot(line.x[i] - cx, line.y[i] - cy) < reach) {
          throw new Error(`bridges: the abutment block of ${l.bridge ?? 'a bridge'} (lift ${l.liftM.toFixed(1)} m over route ${l.route} at ${l.routeS.toFixed(0)} m) would stand on route ${line.id}`);
        }
      }
    }
    const bottom = groundAt(cx, cy) - 0.5;
    if (b.top - bottom < 0.6) continue;
    out.push([Math.round(cx * 10), Math.round(cy * 10), Math.round(b.ux * 1000), Math.round(b.uy * 1000), Math.round(BLOCK_HALF_ALONG_M * 10), Math.round(b.halfAcross * 10), Math.round(bottom * 10), Math.round(b.top * 10)]);
  }
  return out;
}

/** The bridge piece that ends at node `key`, and which end. */
function net0(nets, key, roads) {
  for (const net of nets) {
    if (!net.nodes.has(key)) continue;
    for (const ri of net.pieces) {
      const p = roads.roads[ri].p, n = p.length;
      if (keyOf(p[0], p[1]) === key) return { ri, end: 0 };
      if (keyOf(p[n - 2], p[n - 1]) === key) return { ri, end: 1 };
    }
  }
  throw new Error(`bridges: no piece ends at ${key}`);
}

/** Approach heights on a final ground: max(ground, the ramp) per vertex, the ramp re-read along the piece. */
export function approachHeights(roads, approaches, groundAt) {
  const out = new Map();
  for (const [ri, zs] of approaches) {
    const road = roads.roads[ri];
    out.set(ri, zs.map((z, k) => Math.max(z, groundAt(road.p[2 * k] / 10, road.p[2 * k + 1] / 10))));
  }
  return out;
}

/** Ground road pieces a route rides: route samples within half-width + RIDE_SLACK_M, heading along. */
export function riddenGroundRoads(routeSamples, roads) {
  const pieces = [];
  roads.roads.forEach((r, ri) => {
    if (!(r.f && r.f & (ROAD_FLAGS.bridge | ROAD_FLAGS.tunnel)) && r.p.length >= 4) pieces.push(ri);
  });
  const idx = pieceIndex(roads, pieces);
  const cosMax = Math.cos((RIDE_HEADING_DEG * Math.PI) / 180);
  const out = new Set();
  for (const r of routeSamples) {
    for (let i = 0; i < r.x.length; i += 2) {
      const j = Math.min(r.x.length - 1, i + 1), h = Math.max(0, i - 1);
      const hx = r.x[j] - r.x[h], hy = r.y[j] - r.y[h];
      const hl = Math.hypot(hx, hy) || 1;
      for (const [ri, k] of idx.near(r.x[i], r.y[i], 25)) {
        const q = onSegment(idx.paths.get(ri), k, r.x[i], r.y[i]);
        if (q.d > roadWidth(roads, roads.roads[ri]) / 2 + RIDE_SLACK_M) continue;
        if (Math.abs((q.ux * hx + q.uy * hy) / hl) < cosMax) continue;
        out.add(ri);
      }
    }
  }
  return out;
}

/**
 * Every place a route crosses under a deck it does not ride must keep
 * DECK_HEADROOM_M under the deck's underside, unless the deck is an
 * approach ramp (`approaches`) that has landed there. Returns the failures.
 */
export function headroomFailures({ roads, routes, zdm, surfaces, groundAt, rides, approaches = new Set() }) {
  const out = [];
  const paths = new Map([...zdm.keys()].map((ri) => [ri, piecePath(roads.roads[ri])]));
  routes.forEach((r, i) => {
    const mine = new Set(rides[i]);
    for (const [ri, path] of paths) {
      if (mine.has(ri)) continue;
      const zs = zdm.get(ri).map((v) => v / 10);
      for (const c of crossings(r.x, r.y, path)) {
        const x = r.x[c.i - 1] + (r.x[c.i] - r.x[c.i - 1]) * c.t, y = r.y[c.i - 1] + (r.y[c.i] - r.y[c.i - 1]) * c.t;
        const routeH = surfaces[i](x, y) ?? groundAt(x, y);
        const top = zAlong(path, zs, c.ps);
        // A landed approach ramp crossing the route at grade is a junction, not an underpass.
        if (approaches.has(ri) && top - groundAt(...pointAt(path, c.ps)) < AT_GRADE_M && Math.abs(top - routeH) < AT_GRADE_M * 2) continue;
        const clear = top - deckThickness(roads, roads.roads[ri]) - routeH;
        if (clear < DECK_HEADROOM_M - 0.15) {
          out.push({ route: r.id, s: Math.round(r.s[c.i - 1] + (r.s[c.i] - r.s[c.i - 1]) * c.t), road: ri, name: roads.names[roads.roads[ri].n] ?? null, clearM: Math.round(clear * 100) / 100 });
        }
      }
    }
  });
  return out;
}

/**
 * Keep the ground under every deck's middle UNDER_DECK_MARGIN_M under its
 * underside: nodes whose cells reach the deck (half-width + cell · √2),
 * projected more than the end zone from an abutment, then a bank of
 * BANK_SLOPE out to BANK_REACH_M beyond. Only lowers, and never a node
 * `keep(i)` names (the carved core of a route on the ground: a deck's
 * headroom already clears it). Returns the number of nodes moved and the
 * largest cut.
 */
export function capUnderDecks({ grid, heights, roads, nets, z, keep = () => false }) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const endZone = DECK_END_ZONE_CELLS * cellSize;
  const reachExtra = cellSize * Math.SQRT2;
  let moved = 0;
  let maxCut = 0;
  for (const net of nets) {
    for (const ri of net.pieces) {
      const road = roads.roads[ri];
      const path = piecePath(road);
      if (path.len < 2 * endZone) continue;
      const n = road.p.length;
      const atA = net.nodes.get(keyOf(road.p[0], road.p[1])).boundary;
      const atB = net.nodes.get(keyOf(road.p[n - 2], road.p[n - 1])).boundary;
      const reach = roadWidth(roads, road) / 2 + reachExtra;
      const outer = reach + BANK_REACH_M;
      const under = deckThickness(roads, road) + UNDER_DECK_MARGIN_M;
      const zs = z.get(ri);
      const { xy } = path;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let k = 0; k < xy.length; k += 2) {
        x0 = Math.min(x0, xy[k]); x1 = Math.max(x1, xy[k]); y0 = Math.min(y0, xy[k + 1]); y1 = Math.max(y1, xy[k + 1]);
      }
      const c0 = Math.max(0, Math.floor((x0 - outer - xMin) / cellSize)), c1 = Math.min(cols - 1, Math.ceil((x1 + outer - xMin) / cellSize));
      const r0 = Math.max(0, Math.floor((yMax - y1 - outer) / cellSize)), r1 = Math.min(rows - 1, Math.ceil((yMax - y0 + outer) / cellSize));
      for (let r = r0; r <= r1; r++) {
        const ny = yMax - r * cellSize;
        for (let c = c0; c <= c1; c++) {
          const nx = xMin + c * cellSize;
          let best = null;
          for (let k = 0; k + 1 < path.s.length; k++) {
            const q = onSegment(path, k, nx, ny);
            if (!best || q.d < best.d) best = q;
          }
          if (best.d > outer) continue;
          if ((atA && best.s < endZone) || (atB && path.len - best.s < endZone)) continue;
          if (best.s <= 0 || best.s >= path.len) continue;
          const cap = zAlong(path, zs, best.s) - under + Math.max(0, best.d - reach) * BANK_SLOPE;
          const i = r * cols + c;
          if (keep(i)) continue;
          if (heights[i] > cap) {
            maxCut = Math.max(maxCut, heights[i] - cap);
            heights[i] = cap;
            moved++;
          }
        }
      }
    }
  }
  return { moved, maxCutM: maxCut };
}

/**
 * Where a route rides a deck and the carve still shaped the ground under it
 * (a deck shorter than two end zones, the end zones of a longer one), the
 * deck is the carved ground: one pin per route sample there, at the nearest
 * ridden piece. The rider then never steps from the carved ground onto a
 * deck under or over it.
 */
export function ridePins({ roads, routes, skip, groundAt }) {
  const pins = [];
  routes.forEach((r, i) => {
    for (const sp of r.spans) {
      const paths = sp.pieces.map((ri) => [ri, piecePath(roads.roads[ri])]);
      for (let k = 0; k < r.s.length; k++) {
        if (r.s[k] < sp.s0 || r.s[k] > sp.s1) continue;
        const prev = Math.max(0, k - 1), next = Math.min(r.s.length - 1, k + 1);
        if (skip(i, r.s[prev], r.s[k]) && skip(i, r.s[k], r.s[next])) continue;
        let best = null;
        for (const [ri, path] of paths) {
          for (let j = 0; j + 1 < path.s.length; j++) {
            const q = onSegment(path, j, r.x[k], r.y[k]);
            if (!best || q.d < best.d) best = { d: q.d, ri, s: q.s };
          }
        }
        if (best) pins.push({ ri: best.ri, s: best.s, z: groundAt(r.x[k], r.y[k]), route: r.id, routeS: r.s[k] });
      }
    }
  });
  return pins;
}

/**
 * The app finds the deck a route rides by footprint alone (any point within
 * a ridden piece's half-width + RIDE_SLACK_M), not by route distance. So a
 * route sample outside its ridden spans that falls in such a footprint must
 * be where the deck meets the ground. Returns the worst offenders.
 */
export function footprintConflicts({ roads, routes, surfaces, groundAt, tolM = 0.3 }) {
  const out = [];
  routes.forEach((r, i) => {
    for (let k = 0; k < r.s.length; k++) {
      if (r.spans.some((sp) => r.s[k] >= sp.s0 && r.s[k] <= sp.s1)) continue;
      const z = surfaces[i](r.x[k], r.y[k]);
      if (z === null) continue;
      const g = groundAt(r.x[k], r.y[k]);
      if (Math.abs(z - g) > tolM) out.push({ route: r.id, s: Math.round(r.s[k]), deckM: Math.round((z - g) * 100) / 100 });
    }
  });
  return out;
}

/** Per-vertex heights quantised to decimetres (what the bundle stores and the app reads). */
export function quantiseZ(zs) {
  return zs.map((v) => Math.round(v * 10));
}

/**
 * What a route rides over its decks, read exactly as the app reads it
 * (renderers/three/bridgeDecks.ts): the nearest of the ridden pieces whose
 * half-width + RIDE_SLACK_M covers (x, y), linear in the stored decimetre
 * heights along it and never under the ground; null off every ridden deck.
 */
export function rideSurface(roads, pieces, zdm, groundAt) {
  const items = pieces.map((ri) => {
    const road = roads.roads[ri];
    const path = piecePath(road);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < path.xy.length; k += 2) {
      x0 = Math.min(x0, path.xy[k]); x1 = Math.max(x1, path.xy[k]); y0 = Math.min(y0, path.xy[k + 1]); y1 = Math.max(y1, path.xy[k + 1]);
    }
    const reach = roadWidth(roads, road) / 2 + RIDE_SLACK_M;
    return { path, zs: zdm.get(ri).map((v) => v / 10), reach, x0: x0 - reach, x1: x1 + reach, y0: y0 - reach, y1: y1 + reach };
  });
  return (x, y) => {
    let best = null;
    for (const it of items) {
      if (x < it.x0 || x > it.x1 || y < it.y0 || y > it.y1) continue;
      for (let k = 0; k + 1 < it.path.s.length; k++) {
        const q = onSegment(it.path, k, x, y);
        if (q.d <= it.reach && (!best || q.d < best.d)) best = { d: q.d, z: zAlong(it.path, it.zs, q.s) };
      }
    }
    return best ? Math.max(best.z, groundAt(x, y)) : null;
  };
}

/**
 * Piers under every piece whose underside clears the ground by
 * PIER_MIN_CLEARANCE_M: evenly spaced by height, kept out of route
 * corridors and off drawn roads (shifted along the deck when one would land
 * there, dropped when no spot works).
 */
export function placePiers({ roads, pieces, zdm, groundAt, routeLines, cellSize }) {
  const endZone = DECK_END_ZONE_CELLS * cellSize;
  // Grid index of route samples and of drawn ground roads.
  const cell = 25;
  const routeGrid = new Map();
  for (const line of routeLines) {
    for (let i = 0; i < line.x.length; i++) {
      const k = `${Math.floor(line.x[i] / cell)},${Math.floor(line.y[i] / cell)}`;
      if (!routeGrid.has(k)) routeGrid.set(k, []);
      routeGrid.get(k).push([line.x[i], line.y[i]]);
    }
  }
  const roadGrid = new Map();
  roads.roads.forEach((r, ri) => {
    if (r.f && r.f & (ROAD_FLAGS.bridge | ROAD_FLAGS.tunnel)) return;
    const half = roadWidth(roads, r) / 2;
    for (let i = 2; i < r.p.length; i += 2) {
      const ax = r.p[i - 2] / 10, ay = r.p[i - 1] / 10, bx = r.p[i] / 10, by = r.p[i + 1] / 10;
      for (let c = Math.floor((Math.min(ax, bx) - half) / cell); c <= Math.floor((Math.max(ax, bx) + half) / cell); c++) {
        for (let q = Math.floor((Math.min(ay, by) - half) / cell); q <= Math.floor((Math.max(ay, by) + half) / cell); q++) {
          const k = `${c},${q}`;
          if (!roadGrid.has(k)) roadGrid.set(k, []);
          roadGrid.get(k).push([ax, ay, bx, by, half, ri]);
        }
      }
    }
  });
  const segD = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(ax + dx * t - px, ay + dy * t - py);
  };
  const clearOf = (corners) => {
    for (const [x, y] of corners) {
      for (let c = Math.floor((x - PIER_ROUTE_CLEAR_M) / cell); c <= Math.floor((x + PIER_ROUTE_CLEAR_M) / cell); c++) {
        for (let q = Math.floor((y - PIER_ROUTE_CLEAR_M) / cell); q <= Math.floor((y + PIER_ROUTE_CLEAR_M) / cell); q++) {
          for (const [rx, ry] of routeGrid.get(`${c},${q}`) ?? []) if (Math.hypot(rx - x, ry - y) < PIER_ROUTE_CLEAR_M) return false;
        }
      }
      for (const [ax, ay, bx, by, half] of roadGrid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []) {
        if (segD(x, y, ax, ay, bx, by) < half + PIER_ROAD_CLEAR_M) return false;
      }
    }
    return true;
  };
  const piers = [];
  {
    for (const ri of pieces) {
      const road = roads.roads[ri];
      const path = piecePath(road);
      const zs = zdm.get(ri).map((v) => v / 10);
      const t = deckThickness(roads, road);
      const width = roadWidth(roads, road);
      const halfAcross = Math.max(0.75, width * 0.3);
      const usable = path.len - 2 * endZone;
      if (usable <= 0) continue;
      const mid = path.len / 2;
      const midZ = zAlong(path, zs, mid);
      const spacing = Math.min(60, Math.max(18, 12 + 1.2 * (midZ - t - groundAt(...pointAt(path, mid)))));
      const count = Math.floor(usable / spacing);
      for (let k = 0; k <= count; k++) {
        const s0 = endZone + (usable - count * spacing) / 2 + k * spacing;
        for (const shift of [0, spacing / 4, -spacing / 4]) {
          const s = s0 + shift;
          if (s < endZone || s > path.len - endZone) continue;
          const [x, y, ux, uy] = pointAt(path, s);
          const top = zAlong(path, zs, s) - t;
          const bottom = groundAt(x, y);
          if (top - bottom < PIER_MIN_CLEARANCE_M) break;
          const ax = -uy * halfAcross, ay = ux * halfAcross, dx = ux * PIER_DEPTH_M / 2, dy = uy * PIER_DEPTH_M / 2;
          const corners = [[x + ax + dx, y + ay + dy], [x + ax - dx, y + ay - dy], [x - ax + dx, y - ay + dy], [x - ax - dx, y - ay - dy], [x, y]];
          if (!clearOf(corners)) continue;
          piers.push([Math.round(x * 10), Math.round(y * 10), Math.round(ux * 1000), Math.round(uy * 1000), Math.round((PIER_DEPTH_M / 2) * 10), Math.round(halfAcross * 10), Math.round((bottom - 0.5) * 10), Math.round(top * 10)]);
          break;
        }
      }
    }
  }
  return piers;
}

/** Point and unit direction at arclength s of a piece path. */
export function pointAt(path, s) {
  const { xy, s: S } = path;
  let k = 1;
  while (k < S.length - 1 && S[k] < s) k++;
  const l = S[k] - S[k - 1];
  const t = l > 0 ? Math.min(1, Math.max(0, (s - S[k - 1]) / l)) : 0;
  const ax = xy[2 * k - 2], ay = xy[2 * k - 1], bx = xy[2 * k], by = xy[2 * k + 1];
  const ll = Math.hypot(bx - ax, by - ay) || 1;
  return [ax + (bx - ax) * t, ay + (by - ay) * t, (bx - ax) / ll, (by - ay) / ll];
}

export { piecePath };

/** World point at arclength s of a road piece. */
export function pieceXY(road, s) {
  const [x, y] = pointAt(piecePath(road), s);
  return [x, y];
}
