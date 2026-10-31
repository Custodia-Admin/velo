#!/usr/bin/env node
/**
 * Regenerates src/lib/scenicRouteData.ts — the geometry behind the
 * "Easy & Scenic" preset collection.
 *
 * Dev-time only. The app never calls these services; the output is a static
 * TypeScript module checked into the repo.
 *
 *   Geometry:  routing.openstreetmap.de bike profile (OSRM, OpenStreetMap data)
 *   Elevation: api.open-meteo.com/v1/elevation (Copernicus GLO-90 DEM)
 *
 * Both are free and keyless. Be polite: one request at a time, small pauses.
 *
 *   node scripts/build-scenic-routes.mjs
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/lib/scenicRouteData.ts');
/** Response cache so re-runs don't hammer the free services. */
const CACHE = join(ROOT, 'node_modules/.cache/scenic-routes');
mkdirSync(CACHE, { recursive: true });

/** [lat, lon] waypoints, in riding order. Loops repeat the start at the end. */
const ROUTES = [
  {
    id: 'scenic-lugano-melide',
    waypoints: [[46.0037, 8.9517], [45.9890, 8.9460], [45.9700, 8.9470], [45.9550, 8.9480], [45.9530, 8.9660]],
  },
  {
    id: 'scenic-locarno-brissago',
    waypoints: [[46.1670, 8.7980], [46.1550, 8.7710], [46.1400, 8.7450], [46.1190, 8.7120]],
  },
  {
    id: 'scenic-magadino-plain',
    waypoints: [[46.1920, 9.0170], [46.1650, 8.9500], [46.1700, 8.8800], [46.1780, 8.8500], [46.1670, 8.7980]],
  },
  {
    id: 'scenic-valle-maggia',
    waypoints: [[46.1880, 8.7540], [46.2480, 8.7080], [46.2850, 8.6570], [46.3160, 8.6030]],
  },
  {
    id: 'scenic-engadin-lakes',
    waypoints: [[46.4040, 9.6950], [46.4290, 9.7600], [46.4600, 9.7950], [46.4920, 9.8350]],
  },
  {
    id: 'scenic-lake-varese',
    // South-shore cycle path only; the north side climbs inland.
    waypoints: [[45.8440, 8.7160], [45.8170, 8.7080], [45.7930, 8.7300], [45.7900, 8.7600], [45.8080, 8.7980]],
  },
  {
    id: 'scenic-lake-como-menaggio',
    waypoints: [[46.0200, 9.2390], [46.0700, 9.2700], [46.1250, 9.2880], [46.1450, 9.3070]],
  },
  {
    id: 'scenic-lavaux-chillon',
    waypoints: [[46.5070, 6.6270], [46.5030, 6.6860], [46.4890, 6.7290], [46.4625, 6.8420], [46.4330, 6.9100], [46.4140, 6.9270]],
  },
  {
    id: 'scenic-riviera-dei-fiori',
    waypoints: [[43.8010, 7.7170], [43.8150, 7.7760], [43.8300, 7.8550], [43.8530, 7.9640]],
  },
  {
    id: 'scenic-lake-annecy',
    waypoints: [[45.8990, 6.1290], [45.8640, 6.1440], [45.8270, 6.2020], [45.7800, 6.2180]],
  },
];

/** Resampling step along the routed polyline, metres. */
const STEP_M = 50;
/** Elevation smoothing window, metres (DEM noise next to lake cliffs). */
const SMOOTH_M = 1200;
/** Elevation is fetched every N resampled points and linearly interpolated. */
const ELE_EVERY = 2;
/** Douglas–Peucker tolerance for the shipped polyline, metres. */
const SIMPLIFY_M = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchJson(url) {
  const key = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(key)) return JSON.parse(readFileSync(key, 'utf8'));
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'velo-scenic-route-builder (github.com/Custodia-Admin/velo)' } });
    } catch {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.ok) {
      const j = await res.json();
      writeFileSync(key, JSON.stringify(j));
      return j;
    }
    // 429 = per-minute quota on the free tier; wait out the minute.
    await sleep(res.status === 429 ? 65_000 : 2000 * (attempt + 1));
  }
  throw new Error(`fetch failed: ${url}`);
}

async function routeGeometry(waypoints) {
  const coords = waypoints.map(([lat, lon]) => `${lon},${lat}`).join(';');
  const url = `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
  const j = await fetchJson(url);
  if (j.code !== 'Ok') throw new Error(`routing failed: ${j.code}`);
  // OSRM's bike profile happily routes across lakes by boat. Refuse.
  for (const leg of j.routes[0].legs) {
    for (const st of leg.steps) {
      if (st.mode === 'ferry') throw new Error(`ferry leg near ${st.maneuver.location} — move a waypoint onto the shore road`);
    }
  }
  return j.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
}

function resample(line, step) {
  const out = [line[0]];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const [la0, lo0] = line[i - 1];
    const [la1, lo1] = line[i];
    const seg = haversine(la0, lo0, la1, lo1);
    if (seg < 0.01) continue;
    let d = step - carry;
    while (d <= seg) {
      const f = d / seg;
      out.push([la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f]);
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = line[line.length - 1];
  out.push(last);
  return out;
}

async function elevations(all) {
  const idx = [];
  for (let i = 0; i < all.length; i += ELE_EVERY) idx.push(i);
  if (idx[idx.length - 1] !== all.length - 1) idx.push(all.length - 1);
  const points = idx.map((i) => all[i]);
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const lat = chunk.map((p) => p[0].toFixed(5)).join(',');
    const lon = chunk.map((p) => p[1].toFixed(5)).join(',');
    const j = await fetchJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    out.push(...j.elevation);
    await sleep(1000);
  }
  // Interpolate back onto every resampled point.
  const full = new Array(all.length);
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1];
    for (let i = a; i <= b; i++) full[i] = out[k] + ((out[k + 1] - out[k]) * (i - a)) / (b - a || 1);
  }
  return full;
}

/** Rolling-minimum window, metres. */
const FLOOR_M = 800;

function smooth(values, window) {
  const half = Math.max(1, Math.round(window / STEP_M / 2));
  // Rolling minimum first: every route here follows a lake shore or valley
  // floor, so the road sits at the bottom of the 90 m DEM cell. Tunnels and
  // cliff-side cells otherwise read as phantom 10 %+ ramps.
  const fh = Math.max(1, Math.round(FLOOR_M / STEP_M / 2));
  const floor = values.map((_, i) => Math.min(...values.slice(Math.max(0, i - fh), i + fh + 1)));
  values = floor;
  // Median pass kills single-sample DEM spikes, mean pass rounds the profile.
  const med = values.map((_, i) => {
    const w = values.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  return med.map((_, i) => {
    const w = med.slice(Math.max(0, i - half), i + half + 1);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
}

/** Douglas–Peucker on [lat, lon, ele] using a local equirectangular projection. */
function simplify(points, tol) {
  // Closed loops: DP needs distinct endpoints, so split at the halfway index.
  const first = points[0], last = points[points.length - 1];
  if (points.length > 4 && haversine(first[0], first[1], last[0], last[1]) < 50) {
    const mid = Math.floor(points.length / 2);
    return [...simplifyOpen(points.slice(0, mid + 1), tol).slice(0, -1), ...simplifyOpen(points.slice(mid), tol)];
  }
  return simplifyOpen(points, tol);
}

function simplifyOpen(points, tol) {
  const lat0 = points[0][0] * (Math.PI / 180);
  const xy = points.map(([la, lo]) => [lo * 111320 * Math.cos(lat0), la * 110540]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * xy[i][0] - dx * xy[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function stats(points) {
  let dist = 0, ascent = 0, maxGrade = 0;
  // Grade over ~200 m windows, matching what a rider feels.
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    dist += d;
    cum.push(dist);
    const dEle = points[i][2] - points[i - 1][2];
    if (dEle > 0) ascent += dEle;
  }
  let j = 0;
  for (let i = 0; i < points.length; i++) {
    while (j < points.length - 1 && cum[j] - cum[i] < 200) j++;
    const run = cum[j] - cum[i];
    if (run >= 150) maxGrade = Math.max(maxGrade, Math.abs((points[j][2] - points[i][2]) / run) * 100);
  }
  return { distanceM: Math.round(dist), ascentM: Math.round(ascent), maxGradePct: +maxGrade.toFixed(1) };
}

const results = [];
for (const r of ROUTES) {
  process.stdout.write(`${r.id} … `);
  const line = await routeGeometry(r.waypoints);
  await sleep(500);
  const dense = resample(line, STEP_M);
  const raw = await elevations(dense);
  const ele = smooth(raw, SMOOTH_M);
  const withEle = dense.map(([la, lo], i) => [la, lo, ele[i]]);
  const shipped = simplify(withEle, SIMPLIFY_M).map(([la, lo, e]) => [+la.toFixed(5), +lo.toFixed(5), Math.round(e)]);
  const s = stats(withEle);
  console.log(`${(s.distanceM / 1000).toFixed(1)} km, +${s.ascentM} m, max ${s.maxGradePct}% (${shipped.length} pts)`);
  results.push({ id: r.id, ...s, points: shipped });
}

const body = results
  .map(
    (r) =>
      `  '${r.id}': {\n    distanceM: ${r.distanceM},\n    ascentM: ${r.ascentM},\n    maxGradePct: ${r.maxGradePct},\n    points: ${JSON.stringify(r.points)},\n  },`,
  )
  .join('\n');

writeFileSync(
  OUT,
  `/**
 * GENERATED by scripts/build-scenic-routes.mjs — do not edit by hand.
 *
 * Road geometry © OpenStreetMap contributors (ODbL), routed with the OSRM
 * bike profile at routing.openstreetmap.de. Elevation from the Copernicus
 * GLO-90 DEM via Open-Meteo, median + ${SMOOTH_M} m mean smoothed.
 * Points are [lat, lon, elevationM].
 */

export interface ScenicRouteGeometry {
  distanceM: number;
  ascentM: number;
  /** Steepest ~200 m stretch, percent (absolute). */
  maxGradePct: number;
  points: [number, number, number][];
}

export const SCENIC_ROUTE_GEOMETRY: Record<string, ScenicRouteGeometry> = {
${body}
};
`,
);
console.log(`wrote ${OUT}`);
