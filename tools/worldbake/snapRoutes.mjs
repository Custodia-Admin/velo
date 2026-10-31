// Put the p2e scenic routes onto the world heightfield.
//
// The trainer keeps feeling the smoothed p2e profile (Copernicus GLO-90 via
// Open-Meteo, floor + median + 1200 m mean). The world's raw DEM disagrees
// with it locally (bridges, cuttings, tree canopy in the source DEM), so a
// rider placed on raw terrain would bob up and down against a grade the legs
// don't feel. snapRoutes therefore:
//
//  1. resamples each route every `stepM` metres on the app's own distance
//     scale (haversine, densified like scenicRoutes.routeFromGeometry);
//  2. computes the render target = p2e profile + a slowly varying offset
//     (robust smooth of terrain − profile), so the road sits in the real
//     terrain but has the profile's shape;
//  3. carves a corridor into the float heightfield: nodes within
//     `coreCells` cells of the route take the target exactly, blending back to
//     natural terrain over `falloffM`;
//  4. after quantisation, sets every route sample's render elevation to
//     Heightfield.sampleHeight at that point — the same function the app
//     uses — so the vertical gap between route and ground is exactly zero.

import { readFileSync } from 'node:fs';

const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;

/** Same formula as src/lib/utils.ts haversine (the app's distance scale). */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parse the generated p2e geometry (src/lib/scenicRouteData.ts). */
export function loadScenicGeometry(path) {
  const src = readFileSync(path, 'utf8');
  const out = {};
  const re = /'([a-z0-9-]+)': \{\n {4}distanceM: (\d+),\n {4}ascentM: (\d+),\n {4}maxGradePct: ([\d.]+),\n {4}points: (\[.*\]),\n {2}\},/g;
  for (const m of src.matchAll(re)) out[m[1]] = { distanceM: +m[2], points: JSON.parse(m[5]) };
  return out;
}

/** Display names from src/lib/scenicRoutes.ts (`id: '…', name: '…'` pairs). */
export function loadScenicNames(path) {
  const src = readFileSync(path, 'utf8');
  const out = {};
  for (const m of src.matchAll(/id: '([a-z0-9-]+)',\s*name: '([^']+)'/g)) out[m[1]] = m[2];
  return out;
}

/** Replica of scenicRoutes.routeFromGeometry's point list (≤ 50 m segments). */
export function appRoutePoints(points) {
  const MAX_SEGMENT_M = 50;
  const lat = [], lon = [], ele = [], d = [];
  let dist = 0;
  const push = (la, lo, e) => {
    const k = lat.length;
    if (k > 0) {
      const step = haversine(lat[k - 1], lon[k - 1], la, lo);
      if (step < 0.01) return;
      dist += step;
    }
    lat.push(la); lon.push(lo); ele.push(e); d.push(dist);
  };
  for (let i = 0; i < points.length; i++) {
    const [la, lo, e] = points[i];
    if (i > 0) {
      const [la0, lo0, e0] = points[i - 1];
      const steps = Math.ceil(haversine(la0, lo0, la, lo) / MAX_SEGMENT_M);
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        push(la0 + (la - la0) * f, lo0 + (lo - lo0) * f, e0 + (e - e0) * f);
      }
    }
    push(la, lo, e);
  }
  return { lat, lon, ele, d, total: dist };
}

/** Resample the app route every `step` metres (plus the exact end). */
export function resampleRoute(route, step) {
  const s = [];
  for (let v = 0; v < route.total; v += step) s.push(v);
  if (route.total - s[s.length - 1] > 0.5) s.push(route.total);
  else s[s.length - 1] = route.total;
  const lat = [], lon = [], ele = [];
  let j = 0;
  for (const v of s) {
    while (j < route.d.length - 2 && route.d[j + 1] < v) j++;
    const span = route.d[j + 1] - route.d[j];
    const f = span > 0 ? Math.min(1, Math.max(0, (v - route.d[j]) / span)) : 0;
    lat.push(route.lat[j] + (route.lat[j + 1] - route.lat[j]) * f);
    lon.push(route.lon[j] + (route.lon[j + 1] - route.lon[j]) * f);
    ele.push(route.ele[j] + (route.ele[j + 1] - route.ele[j]) * f);
  }
  return { s, lat, lon, ele };
}

function windowed(values, half, fn) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = fn(values.slice(Math.max(0, i - half), i + half + 1));
  }
  return out;
}
const median = (w) => {
  const s = [...w].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (w) => w.reduce((a, b) => a + b, 0) / w.length;

/** Bilinear sample of a float node grid (same layout as Heightfield). */
export function sampleFloatGrid(grid, heights, x, y) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const fx = Math.min(cols - 1, Math.max(0, (x - xMin) / cellSize));
  const fy = Math.min(rows - 1, Math.max(0, (yMax - y) / cellSize));
  const c = Math.min(cols - 2, Math.floor(fx));
  const r = Math.min(rows - 2, Math.floor(fy));
  const tx = fx - c, ty = fy - r;
  const i = r * cols + c;
  const a = heights[i] + (heights[i + 1] - heights[i]) * tx;
  const b = heights[i + cols] + (heights[i + cols + 1] - heights[i + cols]) * tx;
  return a + (b - a) * ty;
}

/** Grade series (percent) over a centred window of ±`half` samples. */
export function gradeSeries(s, h, half) {
  const n = s.length;
  const g = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    g[i] = ((h[b] - h[a]) / (s[b] - s[a])) * 100;
  }
  return g;
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Steps 1–3: resample every route and carve the float grid in place.
 * Returns the per-route samples for `finishRoutes`.
 */
export function carveRoutes({ grid, heights, projection, routes, snap }) {
  const { stepM, offsetMedianM, offsetMeanM, coreCells, falloffM } = snap;
  const core = coreCells * grid.cellSize;
  const reach = core + falloffM;
  const xMax = grid.xMin + (grid.cols - 1) * grid.cellSize;
  const yMin = grid.yMax - (grid.rows - 1) * grid.cellSize;
  const prepared = [];
  for (const r of routes) {
    const app = appRoutePoints(r.points);
    const rs = resampleRoute(app, stepM);
    const x = [], y = [];
    for (let i = 0; i < rs.s.length; i++) {
      const [px, py] = projection.forward(rs.lat[i], rs.lon[i]);
      if (px - reach < grid.xMin || px + reach > xMax || py - reach < yMin || py + reach > grid.yMax) {
        throw new Error(`route ${r.id} leaves the world at s=${rs.s[i].toFixed(0)} m`);
      }
      x.push(round2(px));
      y.push(round2(py));
    }
    const raw = x.map((px, i) => sampleFloatGrid(grid, heights, px, y[i]));
    const diff = raw.map((h, i) => h - rs.ele[i]);
    const offset = windowed(
      windowed(diff, Math.round(offsetMedianM / stepM / 2), median),
      Math.round(offsetMeanM / stepM / 2),
      mean,
    );
    const target = rs.ele.map((e, i) => e + offset[i]);
    prepared.push({ id: r.id, name: r.name, lengthM: app.total, s: rs.s.map(round2), x, y, profile: rs.ele, raw, target });
  }

  // Nearest-route target per node.
  const n = grid.cols * grid.rows;
  const best = new Float64Array(n).fill(Infinity);
  const tgt = new Float64Array(n);
  for (const p of prepared) {
    for (let k = 0; k + 1 < p.x.length; k++) {
      const ax = p.x[k], ay = p.y[k], bx = p.x[k + 1], by = p.y[k + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - grid.xMin) / grid.cellSize));
      const c1 = Math.min(grid.cols - 1, Math.ceil((Math.max(ax, bx) + reach - grid.xMin) / grid.cellSize));
      const r0 = Math.max(0, Math.floor((grid.yMax - Math.max(ay, by) - reach) / grid.cellSize));
      const r1 = Math.min(grid.rows - 1, Math.ceil((grid.yMax - Math.min(ay, by) + reach) / grid.cellSize));
      for (let r = r0; r <= r1; r++) {
        const ny = grid.yMax - r * grid.cellSize;
        for (let c = c0; c <= c1; c++) {
          const nx = grid.xMin + c * grid.cellSize;
          let t = len2 > 0 ? ((nx - ax) * dx + (ny - ay) * dy) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const ex = ax + dx * t - nx, ey = ay + dy * t - ny;
          const dist = Math.sqrt(ex * ex + ey * ey);
          const i = r * grid.cols + c;
          if (dist < best[i]) {
            best[i] = dist;
            tgt[i] = p.target[k] + (p.target[k + 1] - p.target[k]) * t;
          }
        }
      }
    }
  }
  let carved = 0;
  let maxCut = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] >= reach) continue;
    const u = best[i] <= core ? 0 : (best[i] - core) / falloffM;
    const w = u * u * (3 - 2 * u);
    const next = tgt[i] + (heights[i] - tgt[i]) * w;
    maxCut = Math.max(maxCut, Math.abs(next - heights[i]));
    heights[i] = next;
    carved++;
  }
  return { prepared, carvedNodes: carved, maxCutM: maxCut };
}

/** Step 4: render elevations from the final quantised Heightfield + stats. */
export function finishRoutes({ prepared, hf, snap }) {
  const half = Math.round(100 / snap.stepM); // ±100 m → 200 m grade window
  const routes = [];
  const info = [];
  for (const p of prepared) {
    const h = p.x.map((x, i) => hf.sampleHeight(x, p.y[i]));
    let maxGap = 0;
    for (let i = 0; i < h.length; i++) maxGap = Math.max(maxGap, Math.abs(h[i] - hf.sampleHeight(p.x[i], p.y[i])));
    const gRender = gradeSeries(p.s, h, half);
    const gProfile = gradeSeries(p.s, p.profile, half);
    const gRaw = gradeSeries(p.s, p.raw, half);
    let sum = 0, sumRaw = 0, maxDiff = 0;
    for (let i = 0; i < h.length; i++) {
      const d = Math.abs(gRender[i] - gProfile[i]);
      sum += d;
      sumRaw += Math.abs(gRaw[i] - gProfile[i]);
      if (d > maxDiff) maxDiff = d;
    }
    const meanAbs = sum / h.length;
    routes.push({ id: p.id, name: p.name, lengthM: round2(p.lengthM), stepM: snap.stepM, s: p.s, x: p.x, y: p.y, h });
    info.push({
      id: p.id,
      name: p.name,
      lengthM: round2(p.lengthM),
      maxGapM: maxGap,
      gradeMeanAbsDiffPct: Math.round(meanAbs * 1000) / 1000,
      report: {
        samples: h.length,
        gradeMaxAbsDiffPct: Math.round(maxDiff * 1000) / 1000,
        rawDemGradeMeanAbsDiffPct: Math.round((sumRaw / h.length) * 1000) / 1000,
        maxRenderMinusProfileM: Math.round(Math.max(...h.map((v, i) => Math.abs(v - p.profile[i]))) * 100) / 100,
      },
    });
  }
  return { routes, info };
}
