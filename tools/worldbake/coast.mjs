// The sea and the beach, for worlds on a coast (recipe `"coast": true`).
//
// OpenStreetMap has no sea polygons: the sea is whatever lies on the water
// side of the `natural=coastline` ways, which by convention keep the land on
// their LEFT and the water on their RIGHT. `buildSea` joins those ways into
// chains, clips them to the world's extent and closes each run of coast
// along the extent's edge into sea polygons, with islands as holes
// (`assembleSea`). They ship as water areas of kind `sea`.
//
// Copernicus DEM reads the open sea as 0 m (and Open-Meteo's GLO-90 answers
// 0 there too), but along the shore the coastline and the DEM's own water
// mask disagree by a few metres, and a DSM carries harbour walls, piers and
// moored boats. `flattenSea` sets every node inside the sea to sea level and
// lowers the one-cell strip outside it to sea level at most (as flatLakes
// does for a lake's beach), so the water meets the shore cleanly; the
// renderer draws the sea flat at that level. `relevelSea` puts sea nodes the
// route carve lifted back, except the route's core.
//
// `natural=beach` and `natural=sand` areas become the landcover kind `beach`.
//
// Worlds without the flag never fetch the coast layer, and their water and
// landcover layers keep their kinds lists exactly (same bytes).

/** Overpass body for the coast layer (`{{bbox}}` as in fetchOsm's OSM_LAYERS). */
export const COAST_LAYER =
  '(way[natural=coastline]({{bbox}});way[natural~"^(beach|sand)$"]({{bbox}});relation[natural~"^(beach|sand)$"]({{bbox}}););out geom;';

/** Kind appended to a coast world's water `areaKinds`. */
export const SEA_KIND = 'sea';
/** Kind appended to a coast world's landcover `kinds`. */
export const BEACH_KIND = 'beach';
/** Height of the sea surface, m (EGM2008, as the DEM and the route profiles). */
export const SEA_LEVEL_M = 0;

/** A boundary point counts as on the extent's edge within this, m. */
const EDGE_EPS_M = 1e-3;

/**
 * Position of a point on the extent's edge, measured clockwise (east along
 * the north edge from the NW corner, then south, west, north), in metres.
 * Null when the point is not on the edge.
 */
export function edgePosition(x, y, ext) {
  const W = ext.xMax - ext.xMin;
  const H = ext.yMax - ext.yMin;
  const d = [
    [Math.abs(y - ext.yMax), () => x - ext.xMin],
    [Math.abs(x - ext.xMax), () => W + (ext.yMax - y)],
    [Math.abs(y - ext.yMin), () => W + H + (ext.xMax - x)],
    [Math.abs(x - ext.xMin), () => 2 * W + H + (y - ext.yMin)],
  ];
  let best = null;
  for (const [dist, pos] of d) if (dist <= EDGE_EPS_M && (!best || dist < best[0])) best = [dist, pos];
  if (!best) return null;
  const P = 2 * (W + H);
  return ((best[1]() % P) + P) % P;
}

/** The extent's corners with their clockwise edge positions. */
function corners(ext) {
  const W = ext.xMax - ext.xMin;
  const H = ext.yMax - ext.yMin;
  return [
    { t: 0, x: ext.xMin, y: ext.yMax },
    { t: W, x: ext.xMax, y: ext.yMax },
    { t: W + H, x: ext.xMax, y: ext.yMin },
    { t: 2 * W + H, x: ext.xMin, y: ext.yMin },
  ];
}

function signedArea(flat) {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += flat[2 * j] * flat[2 * i + 1] - flat[2 * i] * flat[2 * j + 1];
  return a / 2;
}

function pointInRing(x, y, ring) {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], yi = ring[2 * i + 1], xj = ring[2 * j], yj = ring[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Sea polygons from coastline pieces already clipped to the extent (flat
 * metre arrays, in the coastline's own direction: land left, water right).
 *
 * - A piece that starts and ends on the extent's edge is a run of coast
 *   across the world. From its end the sea follows the edge clockwise (the
 *   sea on the right) to the start of the next run, and so on round, until
 *   the ring closes: one sea polygon per ring.
 * - A closed piece is an island when it runs counter-clockwise (land inside,
 *   on its left): a hole in the sea polygon round it. A clockwise closed
 *   piece is a sea of its own (an enclosed bay).
 * - With no run across the world, islands alone mean the whole extent is sea.
 *
 * Returns polygons as [outerRing, ...holes], rings open (no repeated first
 * vertex), clockwise outer rings. Throws when a piece ends inside the world:
 * the coastline is broken there, and guessing the water side would flood the
 * land.
 */
export function assembleSea(pieces, ext) {
  const runs = [];
  const islands = [];
  const bays = [];
  for (const p of pieces) {
    const n = p.length / 2;
    if (n < 2) continue;
    const closed = p[0] === p[2 * n - 2] && p[1] === p[2 * n - 1];
    if (closed) {
      const ring = p.slice(0, -2);
      if (ring.length < 6) continue;
      (signedArea(ring) > 0 ? islands : bays).push(ring);
      continue;
    }
    const a = edgePosition(p[0], p[1], ext);
    const b = edgePosition(p[2 * n - 2], p[2 * n - 1], ext);
    if (a === null || b === null) {
      const [x, y] = a === null ? [p[0], p[1]] : [p[2 * n - 2], p[2 * n - 1]];
      throw new Error(`coastline ends inside the world at (${x.toFixed(1)}, ${y.toFixed(1)}): broken coastline in the OSM snapshot`);
    }
    runs.push({ p, a, b });
  }
  const P = 2 * (ext.xMax - ext.xMin + ext.yMax - ext.yMin);
  const cs = corners(ext);
  const seas = [...bays];
  const used = new Uint8Array(runs.length);
  for (let s = 0; s < runs.length; s++) {
    if (used[s]) continue;
    const ring = [];
    let k = s;
    for (let guard = 0; guard <= runs.length; guard++) {
      used[k] = 1;
      const run = runs[k];
      for (let i = 0; i < run.p.length; i++) ring.push(run.p[i]);
      // Next run start clockwise from this run's end (ties: the run itself last).
      let next = -1;
      let gap = Infinity;
      for (let j = 0; j < runs.length; j++) {
        let d = (((runs[j].a - run.b) % P) + P) % P;
        if (d === 0 && j === k) d = P;
        if (d < gap) {
          gap = d;
          next = j;
        }
      }
      // Corners passed on the way, in order.
      const passed = cs
        .map((c) => ({ ...c, d: (((c.t - run.b) % P) + P) % P }))
        .filter((c) => c.d > 0 && c.d < gap)
        .sort((u, v) => u.d - v.d);
      for (const c of passed) ring.push(c.x, c.y);
      if (next === s) break;
      if (used[next]) throw new Error('coastline runs do not close into rings');
      k = next;
    }
    seas.push(ring);
  }
  if (!runs.length && !bays.length && islands.length) {
    const c = corners(ext);
    seas.push([c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y]);
  }
  return seas.map((outer) => [outer, ...islands.filter((h) => pointInRing(h[0], h[1], outer))]);
}

/** Join coastline ways end to start (never reversed: the water side is the way's right). */
export function joinCoastline(ways) {
  const key = (g) => `${g.lat},${g.lon}`;
  const parts = ways.map((w) => w.geometry.slice());
  const byStart = new Map();
  parts.forEach((p, i) => byStart.set(key(p[0]), i));
  const used = new Uint8Array(parts.length);
  const hasPred = new Uint8Array(parts.length);
  parts.forEach((p) => {
    const j = byStart.get(key(p[p.length - 1]));
    if (j !== undefined) hasPred[j] = 1;
  });
  const chains = [];
  const walk = (i) => {
    let chain = parts[i].slice();
    used[i] = 1;
    for (;;) {
      const j = byStart.get(key(chain[chain.length - 1]));
      if (j === undefined || used[j]) break;
      used[j] = 1;
      chain = chain.concat(parts[j].slice(1));
    }
    chains.push(chain);
  };
  // Open chains from their first way, then whatever is left is closed loops.
  for (let i = 0; i < parts.length; i++) if (!used[i] && !hasPred[i]) walk(i);
  for (let i = 0; i < parts.length; i++) if (!used[i]) walk(i);
  return chains;
}

/**
 * Liang–Barsky: clip a polyline to the extent → list of polylines. Unlike
 * buildVectors' clipLine, a vertex inside the extent keeps its exact
 * coordinates (x0 + dx·1 can differ from x1 in the last bit, which would cut
 * the coast into pieces that end inside the world).
 */
export function clipCoast(flat, ext) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const x0 = flat[i], y0 = flat[i + 1], x1 = flat[i + 2], y1 = flat[i + 3];
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const p = [-dx, dx, -dy, dy];
    const q = [x0 - ext.xMin, ext.xMax - x0, y0 - ext.yMin, ext.yMax - y0];
    let visible = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) { visible = false; break; }
      } else {
        const t = q[k] / p[k];
        if (p[k] < 0) { if (t > t1) { visible = false; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { visible = false; break; } if (t < t1) t1 = t; }
      }
    }
    if (!visible) { flush(); continue; }
    const ax = t0 === 0 ? x0 : x0 + dx * t0, ay = t0 === 0 ? y0 : y0 + dy * t0;
    const bx = t1 === 1 ? x1 : x0 + dx * t1, by = t1 === 1 ? y1 : y0 + dy * t1;
    if (cur.length === 0 || cur[cur.length - 2] !== ax || cur[cur.length - 1] !== ay) {
      flush();
      cur.push(ax, ay);
    }
    cur.push(bx, by);
    if (t1 < 1) flush();
  }
  flush();
  return out;
}

/**
 * The sea polygons of a coast world from the coast layer's elements (its
 * natural=coastline ways), as assembleSea: metres, before simplifying.
 */
export function buildSea(elements, projection, ext) {
  const ways = elements.filter((el) => el.type === 'way' && el.tags?.natural === 'coastline' && el.geometry?.length >= 2);
  // Order-independent: the same snapshot in any response order gives the same chains.
  ways.sort((a, b) => a.id - b.id);
  const pieces = [];
  for (const chain of joinCoastline(ways)) {
    const flat = [];
    for (const g of chain) flat.push(...projection.forward(g.lat, g.lon));
    const n = flat.length / 2;
    const closed = n >= 4 && flat[0] === flat[2 * n - 2] && flat[1] === flat[2 * n - 1];
    const inside = (x, y) => x > ext.xMin && x < ext.xMax && y > ext.yMin && y < ext.yMax;
    let all = true;
    for (let i = 0; i < flat.length && all; i += 2) all = inside(flat[i], flat[i + 1]);
    if (closed && all) {
      pieces.push(flat);
      continue;
    }
    // A loop crossing the edge: start it outside, so its clipped runs all
    // start and end on the edge.
    let src = flat;
    if (closed) {
      let o = -1;
      for (let i = 0; i < n - 1 && o < 0; i++) {
        const x = flat[2 * i], y = flat[2 * i + 1];
        if (x < ext.xMin || x > ext.xMax || y < ext.yMin || y > ext.yMax) o = i;
      }
      if (o < 0) continue; // touches the edge without leaving: nothing to close against
      const ring = flat.slice(0, -2);
      src = [...ring.slice(2 * o), ...ring.slice(0, 2 * o), ring[2 * o], ring[2 * o + 1]];
    }
    for (const piece of clipCoast(src, ext)) pieces.push(snapToEdge(piece, ext));
  }
  return assembleSea(pieces, ext);
}

/** Put a clipped piece's end points exactly on the extent's edge (clipLine leaves float dust). */
function snapToEdge(piece, ext) {
  const out = piece.slice();
  for (const i of [0, out.length - 2]) {
    const x = out[i], y = out[i + 1];
    const d = [Math.abs(x - ext.xMin), Math.abs(x - ext.xMax), Math.abs(y - ext.yMin), Math.abs(y - ext.yMax)];
    const m = Math.min(...d);
    if (m > EDGE_EPS_M) continue;
    if (m === d[0]) out[i] = ext.xMin;
    else if (m === d[1]) out[i] = ext.xMax;
    else if (m === d[2]) out[i + 1] = ext.yMin;
    else out[i + 1] = ext.yMax;
  }
  return out;
}

/**
 * Visit every grid node inside the polygon (rings in metres, holes
 * excluded) by scanlines at node centres: the same rule the renderer uses
 * for the nodes under a water area (waterMesh.ts forNodesInside).
 */
export function forNodesInside(grid, rings, visit) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 1; i < rings[0].length; i += 2) {
    y0 = Math.min(y0, rings[0][i]);
    y1 = Math.max(y1, rings[0][i]);
  }
  const r0 = Math.max(0, Math.floor((yMax - y1) / cellSize));
  const r1 = Math.min(rows - 1, Math.ceil((yMax - y0) / cellSize));
  for (let r = r0; r <= r1; r++) {
    const y = yMax - r * cellSize;
    const xs = [];
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[2 * i + 1];
        const yj = ring[2 * j + 1];
        if (yi > y !== yj > y) xs.push(ring[2 * i] + ((y - yi) / (yj - yi)) * (ring[2 * j] - ring[2 * i]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - xMin) / cellSize));
      const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - xMin) / cellSize));
      for (let c = c0; c <= c1; c++) visit(c, r);
    }
  }
}

/**
 * The sea's rings for node scans: vertices on the world's edge pushed a
 * metre past it. The scanline rule is half-open in y, so a ring lying along
 * the north edge would leave that row of nodes out; pushed out, the sea's
 * nodes on every edge count as the sea's own. The renderer scans the sea the
 * same way (waterMesh.ts seaScanRings).
 */
export function seaScanRings(rings, grid) {
  const xMin = grid.xMin;
  const xMax = grid.xMin + (grid.cols - 1) * grid.cellSize;
  const yMax = grid.yMax;
  const yMin = grid.yMax - (grid.rows - 1) * grid.cellSize;
  const out = (v, lo, hi) => (Math.abs(v - lo) < 0.05 ? lo - 1 : Math.abs(v - hi) < 0.05 ? hi + 1 : v);
  return rings.map((r) => r.map((v, i) => (i % 2 === 0 ? out(v, xMin, xMax) : out(v, yMin, yMax))));
}

/**
 * Level the sea in `heights` (float grid, row-major from the north edge), in
 * place: every node inside a sea area of `water` (buildWater's layer,
 * decimetres) to SEA_LEVEL_M, every node within one cell outside it lowered
 * to SEA_LEVEL_M at most (the strip the shoreline's bilinear samples read).
 * Returns `nodes` (the sea's own node indices, for relevelSea), `inNodes`,
 * `stripNodes` lowered, and `before` (the range the sea nodes held).
 */
export function flattenSea({ grid, heights, water }) {
  const { cols, rows } = grid;
  const k = water.areaKinds.indexOf(SEA_KIND);
  const sea = new Uint8Array(heights.length);
  let before = { min: Infinity, max: -Infinity };
  if (k >= 0) {
    for (const area of water.areas) {
      if (area.k !== k) continue;
      const rings = seaScanRings(area.r.map((r) => r.map((v) => v / 10)), grid);
      forNodesInside(grid, rings, (c, r) => {
        sea[r * cols + c] = 1;
      });
    }
  }
  const nodes = [];
  for (let i = 0; i < sea.length; i++) {
    if (!sea[i]) continue;
    nodes.push(i);
    before = { min: Math.min(before.min, heights[i]), max: Math.max(before.max, heights[i]) };
    heights[i] = SEA_LEVEL_M;
  }
  // The strip: land nodes with a sea node among their 8 neighbours.
  let stripNodes = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (sea[i] || heights[i] <= SEA_LEVEL_M) continue;
      let near = false;
      for (let dr = -1; dr <= 1 && !near; dr++) {
        for (let dc = -1; dc <= 1 && !near; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && sea[rr * cols + cc]) near = true;
        }
      }
      if (near) {
        heights[i] = SEA_LEVEL_M;
        stripNodes++;
      }
    }
  }
  return { nodes: Int32Array.from(nodes), mask: sea, inNodes: nodes.length, stripNodes, before: nodes.length ? before : null };
}

/**
 * Steepest a beach may rise from the water: 1 in 25. GLO-30 is a surface
 * model at 30 m, so a beach reads as a shelf a few metres above the sea
 * (Santa Monica: 4–7 m right up to the waterline, then a drop) that hides
 * the sea from the road behind it. A real beach slopes down to the water.
 */
export const BEACH_SLOPE = 0.04;

/**
 * Metres from every node to the nearest node in `mask` (3-4 chamfer: exact
 * along rows, columns and diagonals, within 8 % elsewhere). Infinity
 * without any.
 */
export function maskDistance(grid, mask) {
  const { cols, rows, cellSize } = grid;
  const d = new Float64Array(cols * rows).fill(Infinity);
  for (let i = 0; i < d.length; i++) if (mask[i]) d[i] = 0;
  const a = cellSize, b = cellSize * Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c > 0) d[i] = Math.min(d[i], d[i - 1] + a);
      if (r > 0) {
        d[i] = Math.min(d[i], d[i - cols] + a);
        if (c > 0) d[i] = Math.min(d[i], d[i - cols - 1] + b);
        if (c < cols - 1) d[i] = Math.min(d[i], d[i - cols + 1] + b);
      }
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (c < cols - 1) d[i] = Math.min(d[i], d[i + 1] + a);
      if (r < rows - 1) {
        d[i] = Math.min(d[i], d[i + cols] + a);
        if (c < cols - 1) d[i] = Math.min(d[i], d[i + cols + 1] + b);
        if (c > 0) d[i] = Math.min(d[i], d[i + cols - 1] + b);
      }
    }
  }
  return d;
}

/**
 * Slope the beaches down to the sea: a node inside a beach (rings in metres;
 * natural=beach, not natural=sand, which also maps dunes: El Segundo's stand
 * 50 m above the sea)
 * stands at most BEACH_SLOPE × its distance to the sea above sea level.
 * Only lowers. Returns how many nodes moved and the deepest cut.
 */
export function slopeBeaches({ grid, heights, sea, beaches, slope = BEACH_SLOPE }) {
  const dist = maskDistance(grid, sea);
  let changed = 0;
  let maxCutM = 0;
  const seen = new Uint8Array(heights.length);
  for (const rings of beaches) {
    forNodesInside(grid, rings, (c, r) => {
      const i = r * grid.cols + c;
      if (seen[i] || sea[i]) return;
      seen[i] = 1;
      const cap = SEA_LEVEL_M + slope * dist[i];
      if (heights[i] <= cap) return;
      maxCutM = Math.max(maxCutM, heights[i] - cap);
      heights[i] = cap;
      changed++;
    });
  }
  return { changed, maxCutM };
}

/** After the route carve: sea nodes back to sea level, except those `keep(i)` names (the route core). */
export function relevelSea({ heights, nodes, keep }) {
  let n = 0;
  for (const i of nodes) {
    if (heights[i] === SEA_LEVEL_M || keep(i)) continue;
    heights[i] = SEA_LEVEL_M;
    n++;
  }
  return n;
}
