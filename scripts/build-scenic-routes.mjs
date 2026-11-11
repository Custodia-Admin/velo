#!/usr/bin/env node
/**
 * Regenerates src/lib/scenicRouteData.ts — the geometry behind the
 * "Easy & Scenic" preset collection.
 *
 * Dev-time only. The app never calls these services; the output is a static
 * TypeScript module checked into the repo.
 *
 *   Geometry:  routing.openstreetmap.de bike profile (OSRM, OpenStreetMap data).
 *              Falls back to the OSRM demo server (router.project-osrm.org)
 *              if the bike instance is down. The demo server only runs the
 *              car profile, so the fallback is noted in the run log.
 *   Elevation: api.open-meteo.com/v1/elevation (Copernicus GLO-90 DEM)
 *
 * Both are free and keyless. Be polite: one request at a time, ~1.5 s pauses.
 *
 *   node scripts/build-scenic-routes.mjs              # rebuild everything
 *   ONLY=id1,id2 node scripts/build-scenic-routes.mjs # rebuild some, keep the rest
 *   SCENIC_CACHE=/tmp/x ...                           # response cache dir
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hairpins, removeRetraces, retracedStubs } from '../src/lib/routeReversals.ts';
import { SCENIC_ROUTE_SOURCES, osrmRouteUrl } from './scenicRouteSources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/lib/scenicRouteData.ts');
/** Response cache so re-runs don't hammer the free services. */
const CACHE = process.env.SCENIC_CACHE || join(ROOT, 'node_modules/.cache/scenic-routes');
mkdirSync(CACHE, { recursive: true });

/** [lat, lon] waypoints, in riding order, or an OSM relation: scripts/scenicRouteSources.mjs. */
const ROUTES = SCENIC_ROUTE_SOURCES;

/** Resampling step along the routed polyline, metres. */
const STEP_M = 50;
/** Elevation smoothing window, metres (DEM noise next to lake cliffs). */
const SMOOTH_M = 1200;
/** Elevation is fetched every N resampled points and linearly interpolated. */
const ELE_EVERY = 2;
/** Longest step the bike router may route on foot, metres. */
const MAX_PUSH_M = 500;
/**
 * Douglas–Peucker tolerance for the shipped polyline, metres. The line is the
 * routed OSM geometry itself, so it must stay on the road it follows: the
 * world bake draws that road, and a path is only 1.5 m wide. (Simplifying the
 * 50 m resample at 8 m cut every bend across the grass.)
 */
const SIMPLIFY_M = 1;

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

/**
 * An OSM bicycle route relation, chained in member order. Used where the
 * signed path is mapped as its own relation but the bike router prefers the
 * parallel main road (e.g. the Trasimeno shore path vs the SS71/SS75).
 */
async function relationGeometry(relId) {
  const q = `[out:json][timeout:90];relation(${relId});out geom;`;
  const j = await fetchJson(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
  const rel = j.elements[0];
  const segs = rel.members
    .filter((m) => m.type === 'way' && m.geometry)
    .map((m) => m.geometry.map((g) => [g.lat, g.lon]));
  const d = (a, b) => haversine(a[0], a[1], b[0], b[1]);
  let line = segs[0];
  // Orient the first way toward the second.
  const n = segs[1];
  if (Math.min(d(line[0], n[0]), d(line[0], n.at(-1))) < Math.min(d(line.at(-1), n[0]), d(line.at(-1), n.at(-1)))) {
    line = [...line].reverse();
  }
  for (const s0 of segs.slice(1)) {
    const s = d(line.at(-1), s0[0]) <= d(line.at(-1), s0.at(-1)) ? s0 : [...s0].reverse();
    const gap = d(line.at(-1), s[0]);
    if (gap > 30) throw new Error(`relation ${relId} has a ${Math.round(gap)} m gap near ${s[0]}`);
    line = line.concat(s.slice(1));
  }
  return { geometry: line, legs: [{ steps: [{ name: rel.tags?.name ?? `relation ${relId}`, distance: 0 }] }] };
}

async function routeGeometry(waypoints) {
  const coords = waypoints.map(([lat, lon]) => `${lon},${lat}`).join(';');
  const q = `${coords}?overview=full&geometries=geojson&steps=true`;
  let j;
  try {
    j = await fetchJson(osrmRouteUrl(waypoints));
  } catch (err) {
    console.warn(`bike router failed (${err.message}); trying the OSRM demo server (car profile)`);
    j = await fetchJson(`https://router.project-osrm.org/route/v1/cycling/${q}`);
  }
  if (j.code !== 'Ok') throw new Error(`routing failed: ${j.code}`);
  // A waypoint that snaps far from where we put it means the path we meant
  // isn't in the routing graph; the route would take some other road.
  for (const w of j.waypoints) {
    if (w.distance > 150) throw new Error(`waypoint snapped ${Math.round(w.distance)} m away near ${w.location}`);
  }
  // OSRM's bike profile happily routes across lakes by boat. Refuse.
  for (const leg of j.routes[0].legs) {
    for (const st of leg.steps) {
      if (st.mode === 'ferry') throw new Error(`ferry leg near ${st.maneuver.location} — move a waypoint onto the shore road`);
      // Boat lines can also come back as a long walk ("Ascona - Ronco", 2.1 km
      // of "pushing bike" straight over Lago Maggiore).
      if (st.mode === 'pushing bike' && st.distance > MAX_PUSH_M) {
        throw new Error(`${Math.round(st.distance)} m on foot ("${st.name}") near ${st.maneuver.location} — a boat line or a footpath; move a waypoint onto a road`);
      }
    }
  }
  return { geometry: j.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]), legs: j.routes[0].legs };
}

/**
 * Cut OSRM's waypoint artifacts out of the routed line: a waypoint just off
 * the through road gets visited by riding to it and straight back, which on
 * screen is a pointless U-turn. src/lib/routeReversals.ts finds every place
 * the line runs back over (or right beside) itself, cuts the stub back to the
 * junction it left from, and throws when a turnaround can't be cut without
 * the route still reversing (then a waypoint needs moving). The rest of the
 * line is the routed path untouched.
 */
function cleanLine(line) {
  const { points, cuts } = removeRetraces(line);
  for (const c of cuts) console.log(`  cut a ${Math.round(c.toM - c.fromM)} m ${c.kind === 'stub' ? 'out-and-back' : `out-and-back at the ${c.kind === 'head' ? 'start' : 'end'}`} at ${Math.round(c.fromM)} m`);
  return points;
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

/** Existing entries in the output file, so ONLY= runs keep the rest as-is. */
function loadExisting() {
  if (!existsSync(OUT)) return {};
  const src = readFileSync(OUT, 'utf8');
  const out = {};
  const re = /'([a-z0-9-]+)': \{\n    distanceM: (\d+),\n    ascentM: (\d+),\n    maxGradePct: ([\d.]+),\n    points: (\[.*\]),\n  \},/g;
  for (const m of src.matchAll(re)) {
    out[m[1]] = { id: m[1], distanceM: +m[2], ascentM: +m[3], maxGradePct: +m[4], points: JSON.parse(m[5]) };
  }
  return out;
}

/** Main roads/paths of a routed line, longest first (sanity check on the path taken). */
function wayNames(legs) {
  const byName = new Map();
  for (const leg of legs) for (const st of leg.steps) {
    const n = st.name || '(unnamed)';
    byName.set(n, (byName.get(n) ?? 0) + st.distance);
  }
  return [...byName].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, d]) => `${n} ${(d / 1000).toFixed(1)}km`).join(', ');
}

const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const existing = loadExisting();
const results = [];
const failed = [];
for (const r of ROUTES) {
  if (only && !only.has(r.id)) {
    if (!existing[r.id]) throw new Error(`${r.id} not in ONLY and not in ${OUT}`);
    results.push(existing[r.id]);
    continue;
  }
  process.stdout.write(`${r.id} … `);
  let line, legs;
  try {
    ({ geometry: line, legs } = r.relation ? await relationGeometry(r.relation) : await routeGeometry(r.waypoints));
    if (r.reverse) line = [...line].reverse();
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    failed.push(r.id);
    if (existing[r.id]) results.push(existing[r.id]);
    await sleep(1500);
    continue;
  }
  await sleep(1500);
  let clean;
  try {
    clean = cleanLine(line);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    failed.push(r.id);
    if (existing[r.id]) results.push(existing[r.id]);
    continue;
  }
  // Elevation on a 50 m profile (the DEM is 90 m), smoothed, then carried
  // onto the exact line by distance along it.
  const dense = resample(clean, STEP_M);
  const raw = await elevations(dense);
  const ele = smooth(raw, SMOOTH_M);
  const withEle = dense.map(([la, lo], i) => [la, lo, ele[i]]);
  const along = [0];
  for (let i = 1; i < clean.length; i++) along.push(along[i - 1] + haversine(clean[i - 1][0], clean[i - 1][1], clean[i][0], clean[i][1]));
  const kept = simplify(clean.map(([la, lo], i) => [la, lo, i]), SIMPLIFY_M);
  const profileS = [0];
  for (let i = 1; i < dense.length; i++) profileS.push(profileS[i - 1] + haversine(dense[i - 1][0], dense[i - 1][1], dense[i][0], dense[i][1]));
  const eleAt = (d) => {
    let k = 0;
    while (k < profileS.length - 2 && profileS[k + 1] < d) k++;
    const f = Math.min(1, Math.max(0, (d - profileS[k]) / (profileS[k + 1] - profileS[k] || 1)));
    return ele[k] + (ele[k + 1] - ele[k]) * f;
  };
  const shipped = kept.map(([la, lo, i]) => [+la.toFixed(5), +lo.toFixed(5), Math.round(eleAt(along[i]))]);
  const turns = hairpins(shipped);
  const stubs = retracedStubs(shipped);
  if (turns.length || stubs.length) {
    console.log(`FAILED: still turns back at ${[...turns.map((h) => h.distanceM), ...stubs.map((x) => x.tipM)].map((v) => Math.round(v)).join(', ')} m`);
    failed.push(r.id);
    if (existing[r.id]) results.push(existing[r.id]);
    continue;
  }
  const s = stats(withEle);
  // Distance is the shipped line's own length (what the app rides).
  s.distanceM = Math.round(shipped.reduce((a, p, i) => (i ? a + haversine(shipped[i - 1][0], shipped[i - 1][1], p[0], p[1]) : 0), 0));
  // Diagnostic only: the same grade measure on the unfloored DEM profile, so a
  // real hill hidden by the shore-floor smoothing still shows up in the log.
  const rawMax = stats(dense.map(([la, lo], i) => [la, lo, raw[i]])).maxGradePct;
  console.log(`${(s.distanceM / 1000).toFixed(1)} km, +${s.ascentM} m, max ${s.maxGradePct}% (raw DEM ${rawMax}%) (${shipped.length} pts) via ${wayNames(legs)}`);
  results.push({ id: r.id, ...s, points: shipped });
}

const body = results
  .map(
    (r) =>
      `  '${r.id}': {\n    distanceM: ${r.distanceM},\n    ascentM: ${r.ascentM},\n    maxGradePct: ${r.maxGradePct},\n    points: ${JSON.stringify(r.points)},\n  },`,
  )
  .join('\n');

if (failed.length) console.log(`not rebuilt: ${failed.join(', ')}`);
if (process.env.DRY) {
  console.log('DRY run: not writing');
  process.exit(failed.length ? 1 : 0);
}

writeFileSync(
  OUT,
  `/**
 * GENERATED by scripts/build-scenic-routes.mjs — do not edit by hand.
 *
 * Road geometry © OpenStreetMap contributors (ODbL), routed with the OSRM
 * bike profile at routing.openstreetmap.de, out-and-back stubs cut, kept to
 * within ${SIMPLIFY_M} m of the routed road. Elevation from the Copernicus
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
if (failed.length) process.exit(1);
