// OSM elements → world vector layers (roads, water, landcover, buildings,
// vegetation seeds, POIs) in world metres. Encodings: docs/worlds/WORLD-FORMAT.md.
// Everything here is a pure function of (elements, projection, recipe), so
// the same cached Overpass responses always give byte-identical layers.

import { BEACH_KIND, SEA_KIND } from './coast.mjs';
import { hash32, simplifyLine } from './util.mjs';

export const ROAD_CLASSES = [
  // [class, default width m]
  ['motorway', 12],
  ['trunk', 10],
  ['primary', 8],
  ['secondary', 7],
  ['tertiary', 6],
  ['unclassified', 5],
  ['residential', 5],
  ['living_street', 4.5],
  ['pedestrian', 5],
  ['service', 3.5],
  ['track', 3],
  ['cycleway', 2.5],
  ['bridleway', 2],
  ['path', 1.5],
  ['footway', 1.5],
  ['steps', 2],
];
const ROAD_INDEX = new Map(ROAD_CLASSES.map(([c], i) => [c, i]));
/** `routeFill`: a way the OSM snapshot lacks under a scenic route, added by the bake (routeCoverage.mjs easeRoadsOntoRoutes). */
export const ROAD_FLAGS = { bridge: 1, tunnel: 2, unpaved: 4, oneway: 8, routeFill: 16 };
const UNPAVED = /^(unpaved|gravel|fine_gravel|dirt|earth|ground|grass|sand|mud|compacted|pebblestone|woodchips)$/;

export const WATER_AREA_KINDS = ['lake', 'river', 'pond'];
export const WATER_LINE_KINDS = [
  ['river', 15],
  ['canal', 6],
  ['stream', 2.5],
];
export const LANDCOVER_KINDS = [
  'forest', 'scrub', 'grass', 'park', 'farmland', 'orchard', 'vineyard', 'residential', 'industrial', 'cemetery',
];
export const BUILDING_KINDS = ['generic', 'house', 'apartments', 'church', 'industrial', 'shed', 'civic'];
/**
 * Where a building stands, for its palette and massing: the dense historic
 * core (stone, taller, tight), the modern suburb (plaster), the open
 * countryside (stone farmhouses, sheds) and industrial estates.
 */
export const BUILDING_DISTRICTS = ['suburb', 'old-town', 'rural', 'industrial'];
/**
 * Tree kinds. The first five come from landcover polygons; the rest give the
 * Umbrian countryside its character: cypress rows round cemeteries, poplars
 * and willows along the rivers, field-edge trees and tree rows, garden trees
 * in the suburbs.
 */
export const VEGETATION_KINDS = ['broadleaf', 'conifer', 'scrub', 'olive', 'park', 'cypress', 'riparian', 'hedgerow', 'garden'];
const VK = Object.fromEntries(VEGETATION_KINDS.map((k, i) => [k, i]));

const dm = (v) => Math.round(v * 10);

function parseMetres(v) {
  if (typeof v !== 'string') return undefined;
  const m = v.trim().match(/^(\d+(?:[.,]\d+)?)\s*(m|meters?|metres?)?$/i);
  return m ? parseFloat(m[1].replace(',', '.')) : undefined;
}

/** Project an Overpass `geometry` array → flat [x0,y0,...] metres. */
function projectGeom(geom, projection) {
  const flat = new Array(geom.length * 2);
  for (let i = 0; i < geom.length; i++) {
    const [x, y] = projection.forward(geom[i].lat, geom[i].lon);
    flat[2 * i] = x;
    flat[2 * i + 1] = y;
  }
  return flat;
}

/** Liang–Barsky: clip a polyline to the extent → list of polylines. */
export function clipLine(flat, ext) {
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
    const ax = x0 + dx * t0, ay = y0 + dy * t0, bx = x0 + dx * t1, by = y0 + dy * t1;
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

/** Sutherland–Hodgman: clip a closed ring (no repeated last vertex) to the extent. */
export function clipRing(flat, ext) {
  const edges = [
    (x) => x >= ext.xMin, (x) => x <= ext.xMax, (_x, y) => y >= ext.yMin, (_x, y) => y <= ext.yMax,
  ];
  const cut = [
    (ax, ay, bx, by) => { const t = (ext.xMin - ax) / (bx - ax); return [ext.xMin, ay + (by - ay) * t]; },
    (ax, ay, bx, by) => { const t = (ext.xMax - ax) / (bx - ax); return [ext.xMax, ay + (by - ay) * t]; },
    (ax, ay, bx, by) => { const t = (ext.yMin - ay) / (by - ay); return [ax + (bx - ax) * t, ext.yMin]; },
    (ax, ay, bx, by) => { const t = (ext.yMax - ay) / (by - ay); return [ax + (bx - ax) * t, ext.yMax]; },
  ];
  let poly = flat;
  for (let e = 0; e < 4; e++) {
    const n = poly.length / 2;
    if (n < 3) return [];
    const next = [];
    for (let i = 0; i < n; i++) {
      const ax = poly[2 * ((i + n - 1) % n)], ay = poly[2 * ((i + n - 1) % n) + 1];
      const bx = poly[2 * i], by = poly[2 * i + 1];
      const ain = edges[e](ax, ay), bin = edges[e](bx, by);
      if (bin) {
        if (!ain) next.push(...cut[e](ax, ay, bx, by));
        next.push(bx, by);
      } else if (ain) next.push(...cut[e](ax, ay, bx, by));
    }
    poly = next;
  }
  return poly.length >= 6 ? poly : [];
}

function ringArea(flat) {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += flat[2 * j] * flat[2 * i + 1] - flat[2 * i] * flat[2 * j + 1];
  return a / 2;
}

/** Drop the closing vertex of a closed way. */
function openRing(flat) {
  const n = flat.length;
  if (n >= 4 && flat[0] === flat[n - 2] && flat[1] === flat[n - 1]) return flat.slice(0, n - 2);
  return flat;
}

/** Join relation member ways (with geometry) into closed rings. */
function assembleRings(members, role, projection) {
  const parts = members
    .filter((m) => m.type === 'way' && (m.role === role || (role === 'outer' && m.role === '')) && m.geometry?.length >= 2)
    .map((m) => m.geometry.map((g) => [g.lat, g.lon]));
  const rings = [];
  const key = (p) => `${p[0]},${p[1]}`;
  while (parts.length) {
    let ring = parts.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const end = key(ring[ring.length - 1]);
      const idx = parts.findIndex((p) => key(p[0]) === end || key(p[p.length - 1]) === end);
      if (idx < 0) break;
      const [p] = parts.splice(idx, 1);
      ring = ring.concat((key(p[0]) === end ? p : [...p].reverse()).slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) {
      rings.push(openRing(projectGeom(ring.map(([lat, lon]) => ({ lat, lon })), projection)));
    }
  }
  return rings;
}

/** Element → list of polygons, each [outerRing, ...holes] (flat metre arrays, open). */
function polygonsOf(el, projection) {
  if (el.type === 'way') {
    const g = el.geometry;
    if (!g || g.length < 4 || g[0].lat !== g[g.length - 1].lat || g[0].lon !== g[g.length - 1].lon) return [];
    return [[openRing(projectGeom(g, projection))]];
  }
  if (el.type === 'relation' && el.members) {
    const outers = assembleRings(el.members, 'outer', projection);
    const inners = assembleRings(el.members, 'inner', projection);
    // Holes go with the outer ring that contains their first vertex.
    return outers.map((o) => [o, ...inners.filter((h) => pointInRing(h[0], h[1], o))]);
  }
  return [];
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

function pointInPolygon(x, y, rings) {
  let inside = false;
  for (const r of rings) if (pointInRing(x, y, r)) inside = !inside;
  return inside;
}

/** Polygons with more vertices than this get a cell index for point tests (a coast world's sea). */
const POLY_INDEX_MIN_VERTS = 4000;
const POLY_INDEX_CELL_M = 25;

/**
 * Exact point-in-polygon for big polygons: a grid where every cell an edge
 * may touch (its segment's bbox) is tested exactly, and every other cell
 * takes the answer of its centre, which no edge separates from the rest of
 * the cell. Same answers as pointInPolygon, without walking 10⁴ edges per
 * tree on a coast world's sea.
 */
function polygonTester(rings, bbox) {
  let verts = 0;
  for (const r of rings) verts += r.length / 2;
  if (verts < POLY_INDEX_MIN_VERTS) return (x, y) => pointInPolygon(x, y, rings);
  const s = POLY_INDEX_CELL_M;
  const [x0, y0, x1, y1] = bbox;
  const nx = Math.max(1, Math.ceil((x1 - x0) / s) + 1);
  const ny = Math.max(1, Math.ceil((y1 - y0) / s) + 1);
  const edge = new Uint8Array(nx * ny);
  const ci = (x) => Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / s)));
  const cj = (y) => Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / s)));
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const i0 = ci(Math.min(r[2 * i], r[2 * j])) - 1, i1 = ci(Math.max(r[2 * i], r[2 * j])) + 1;
      const j0 = cj(Math.min(r[2 * i + 1], r[2 * j + 1])) - 1, j1 = cj(Math.max(r[2 * i + 1], r[2 * j + 1])) + 1;
      for (let b = Math.max(0, j0); b <= Math.min(ny - 1, j1); b++) for (let a = Math.max(0, i0); a <= Math.min(nx - 1, i1); a++) edge[b * nx + a] = 1;
    }
  }
  const state = new Int8Array(nx * ny); // 0 unknown, 1 inside, -1 outside
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const k = cj(y) * nx + ci(x);
    if (edge[k]) return pointInPolygon(x, y, rings);
    if (!state[k]) state[k] = pointInPolygon(x0 + (ci(x) + 0.5) * s, y0 + (cj(y) + 0.5) * s, rings) ? 1 : -1;
    return state[k] > 0;
  };
}

/** Clip + simplify + quantise a polygon; null when nothing is left. */
function finishPolygon(rings, ext, tol, minArea) {
  const out = [];
  for (let i = 0; i < rings.length; i++) {
    const clipped = clipRing(rings[i], ext);
    if (!clipped.length) {
      if (i === 0) return null;
      continue;
    }
    const closed = simplifyLine([...clipped, clipped[0], clipped[1]], tol);
    const ring = closed.slice(0, -2);
    if (ring.length < 6) {
      if (i === 0) return null;
      continue;
    }
    if (i === 0 && Math.abs(ringArea(ring)) < minArea) return null;
    out.push(ring.map(dm));
  }
  return out;
}

export function buildRoads(elements, projection, ext) {
  const names = [];
  const nameIdx = new Map();
  const roads = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const t = el.tags ?? {};
    const cls = ROAD_INDEX.get(t.highway.replace(/_link$/, ''));
    if (cls === undefined) continue;
    let flags = 0;
    if (t.bridge && t.bridge !== 'no') flags |= ROAD_FLAGS.bridge;
    if (t.tunnel && t.tunnel !== 'no') flags |= ROAD_FLAGS.tunnel;
    if (UNPAVED.test(t.surface ?? '') || (t.highway === 'track' && !t.surface)) flags |= ROAD_FLAGS.unpaved;
    if (t.oneway === 'yes') flags |= ROAD_FLAGS.oneway;
    const width = parseMetres(t.width);
    for (const piece of clipLine(projectGeom(el.geometry, projection), ext)) {
      const p = simplifyLine(piece, 0.5).map(dm);
      const road = { c: cls };
      if (flags) road.f = flags;
      if (width && width >= 1 && width <= 40) road.w = width;
      if (t.name) {
        if (!nameIdx.has(t.name)) {
          nameIdx.set(t.name, names.length);
          names.push(t.name);
        }
        road.n = nameIdx.get(t.name);
      }
      road.p = p;
      roads.push(road);
    }
  }
  return {
    version: 1,
    units: 'dm',
    classes: ROAD_CLASSES.map(([c]) => c),
    widths: ROAD_CLASSES.map(([, w]) => w),
    flags: ROAD_FLAGS,
    names,
    roads,
  };
}

/**
 * Water layer. `sea` (coast worlds, coast.mjs buildSea) adds the sea
 * polygons as areas of kind `sea`, appended to `areaKinds`; without it the
 * layer is exactly as before.
 */
export function buildWater(elements, projection, ext, { sea = null } = {}) {
  const areas = [];
  const lines = [];
  const lineIdx = new Map(WATER_LINE_KINDS.map(([k], i) => [k, i]));
  for (const el of elements) {
    const t = el.tags ?? {};
    if (t.waterway && lineIdx.has(t.waterway) && el.type === 'way') {
      if (t.tunnel && t.tunnel !== 'no') continue;
      const k = lineIdx.get(t.waterway);
      const width = parseMetres(t.width);
      for (const piece of clipLine(projectGeom(el.geometry, projection), ext)) {
        const line = { k, p: simplifyLine(piece, 1).map(dm) };
        if (width && width <= 200) line.w = width;
        lines.push(line);
      }
      continue;
    }
    const isArea = t.natural === 'water' || t.waterway === 'riverbank';
    if (!isArea) continue;
    const kind = t.waterway === 'riverbank' || t.water === 'river' || t.water === 'canal'
      ? 1
      : t.water === 'pond' || t.water === 'basin' || t.water === 'reservoir_pond'
        ? 2
        : 0;
    for (const poly of polygonsOf(el, projection)) {
      const rings = finishPolygon(poly, ext, 1, 20);
      if (rings) areas.push({ k: kind, r: rings });
    }
  }
  const areaKinds = sea ? [...WATER_AREA_KINDS, SEA_KIND] : WATER_AREA_KINDS;
  for (const poly of sea ?? []) {
    const rings = finishPolygon(poly, ext, 1, 20);
    if (rings) areas.push({ k: areaKinds.indexOf(SEA_KIND), r: rings });
  }
  return {
    version: 1,
    units: 'dm',
    areaKinds,
    lineKinds: WATER_LINE_KINDS.map(([k]) => k),
    lineWidths: WATER_LINE_KINDS.map(([, w]) => w),
    areas,
    lines,
  };
}

function landcoverKind(t) {
  const lu = t.landuse, n = t.natural, le = t.leisure;
  if (lu === 'forest' || n === 'wood') return 'forest';
  if (n === 'scrub' || n === 'heath') return 'scrub';
  if (lu === 'meadow' || lu === 'grass' || n === 'grassland' || lu === 'village_green' || lu === 'recreation_ground' || le === 'pitch' || le === 'golf_course') return 'grass';
  if (le === 'park' || le === 'garden') return 'park';
  if (lu === 'farmland' || lu === 'farmyard' || lu === 'allotments') return 'farmland';
  if (lu === 'orchard') return 'orchard';
  if (lu === 'vineyard') return 'vineyard';
  if (lu === 'residential') return 'residential';
  if (lu === 'industrial' || lu === 'commercial' || lu === 'retail' || lu === 'quarry') return 'industrial';
  if (lu === 'cemetery') return 'cemetery';
  return null;
}

/**
 * Landcover layer. `beach` (coast worlds: the coast layer's natural=beach
 * and natural=sand areas) adds them as kind `beach`, appended to `kinds`
 * after every other area; without it the layer is exactly as before.
 */
export function buildLandcover(elements, projection, ext, { beach = null } = {}) {
  const kinds = beach ? [...LANDCOVER_KINDS, BEACH_KIND] : LANDCOVER_KINDS;
  const areas = [];
  const polys = []; // full-precision copies for vegetation seeding
  const add = (el, kind) => {
    for (const poly of polygonsOf(el, projection)) {
      const rings = finishPolygon(poly, ext, 3, 200);
      if (!rings) continue;
      areas.push({ k: kinds.indexOf(kind), r: rings });
      polys.push({ kind, tags: el.tags ?? {}, rings: rings.map((r) => r.map((v) => v / 10)) });
    }
  };
  for (const el of elements) {
    const kind = landcoverKind(el.tags ?? {});
    if (kind) add(el, kind);
  }
  for (const el of beach ?? []) {
    const n = el.tags?.natural;
    if (n === 'beach' || n === 'sand') add(el, BEACH_KIND);
  }
  return { layer: { version: 1, units: 'dm', kinds, areas }, polys };
}

function buildingHeight(t) {
  const h = parseMetres(t.height);
  if (h && h > 1 && h < 150) return h;
  const lv = parseFloat(t['building:levels']);
  if (lv > 0 && lv < 40) return lv * 3.2 + 1;
  switch (t.building) {
    case 'house': case 'detached': case 'semidetached_house': case 'terrace': case 'farm': return 7;
    case 'apartments': case 'residential': return 12;
    case 'church': case 'cathedral': case 'chapel': return 14;
    case 'industrial': case 'warehouse': case 'commercial': case 'retail': return 8;
    case 'garage': case 'garages': case 'shed': case 'hut': case 'roof': case 'carport': case 'greenhouse': return 3;
    default: return 6;
  }
}

function buildingKind(t) {
  switch (t.building) {
    case 'house': case 'detached': case 'semidetached_house': case 'terrace': case 'farm': return 1;
    case 'apartments': case 'residential': return 2;
    case 'church': case 'cathedral': case 'chapel': return 3;
    case 'industrial': case 'warehouse': case 'commercial': case 'retail': return 4;
    case 'garage': case 'garages': case 'shed': case 'hut': case 'roof': case 'carport': case 'greenhouse': return 5;
    case 'public': case 'civic': case 'school': case 'university': case 'hospital': case 'government': case 'castle': case 'tower': return 6;
    default: return 0;
  }
}

/** Uniform grid over points for radius queries (metres). */
class PointGrid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  key(i, j) {
    return `${i},${j}`;
  }
  add(x, y, item) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let list = this.map.get(k);
    if (!list) this.map.set(k, (list = []));
    list.push(item);
  }
  *near(x, y, r) {
    const c = this.cell;
    for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
      for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
        const list = this.map.get(this.key(i, j));
        if (list) yield* list;
      }
    }
  }
}

/** Radius of the built-up density disc, m. */
export const DISTRICT_RADIUS_M = 70;
/** Footprint share of that disc from which a building counts as dense. */
export const OLD_TOWN_COVERAGE = 0.36;
/** Fewer buildings than this within 120 m = open countryside. */
export const RURAL_NEIGHBOURS = 5;

function ringBbox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]);
    y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/**
 * District per building, from the built fabric itself: medieval cores are
 * far denser (footprint share of a 70 m disc ≥ 0.36, with most neighbours
 * dense too) than any suburb; farmhouses stand alone; industrial kinds or
 * industrial landcover make an estate. `list` items need { cx, cy, area, k }.
 * Pure and deterministic. Returns indices into BUILDING_DISTRICTS.
 */
export function classifyDistricts(list, industrialPolys = []) {
  const grid = new PointGrid(60);
  list.forEach((b, i) => grid.add(b.cx, b.cy, i));
  const R = DISTRICT_RADIUS_M;
  const disc = Math.PI * R * R;
  const dense = new Uint8Array(list.length);
  const neighbours = new Uint32Array(list.length);
  list.forEach((b, i) => {
    let cover = 0;
    let n = 0;
    for (const j of grid.near(b.cx, b.cy, 120)) {
      const o = list[j];
      const d = Math.hypot(o.cx - b.cx, o.cy - b.cy);
      if (d <= 120) n++;
      if (d <= R) cover += o.area;
    }
    neighbours[i] = n;
    dense[i] = cover / disc >= OLD_TOWN_COVERAGE ? 1 : 0;
  });
  const inIndustrial = (x, y) =>
    industrialPolys.some((p) => p.bbox[0] <= x && x <= p.bbox[2] && p.bbox[1] <= y && y <= p.bbox[3] && pointInPolygon(x, y, p.rings));
  return list.map((b, i) => {
    if (b.k === 4 || inIndustrial(b.cx, b.cy)) return 3;
    if (neighbours[i] < RURAL_NEIGHBOURS) return 2;
    if (dense[i]) {
      // A dense block among dense blocks: the historic core, not one tight courtyard.
      let d = 0;
      let all = 0;
      for (const j of grid.near(b.cx, b.cy, R)) {
        if (Math.hypot(list[j].cx - b.cx, list[j].cy - b.cy) > R) continue;
        all++;
        d += dense[j];
      }
      if (d >= 0.6 * all) return 1;
    }
    return 0;
  });
}

/**
 * Clear space between a scenic route's centreline and any building, m: the
 * half-width of the road the route rides on (OSM width tag, else its class
 * default) plus a margin, never under the minimum (the route line's depth
 * bias needs it) and at most the maximum, which also applies where no road
 * is mapped under the route.
 */
export const ROUTE_CLEAR_MIN_M = 3.5;
export const ROUTE_CLEAR_MAX_M = 6;
export const ROUTE_CLEAR_MARGIN_M = 1;
/** A road counts as the one under the route within this distance of it, m. */
export const ROUTE_ROAD_SNAP_M = 4;
/** Route polylines are split to segments this long before clearances are assigned, m. */
export const ROUTE_CLEAR_SEG_M = 10;

function segSegIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pointSegDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** Distance from segment ab to a closed ring (metres, open flat array); 0 when they touch or a is inside. */
export function segmentRingDistance(ax, ay, bx, by, ring) {
  if (pointInRing(ax, ay, ring) || pointInRing(bx, by, ring)) return 0;
  let d = Infinity;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cx = ring[2 * j], cy = ring[2 * j + 1], ex = ring[2 * i], ey = ring[2 * i + 1];
    if (segSegIntersect(ax, ay, bx, by, cx, cy, ex, ey)) return 0;
    d = Math.min(d, pointSegDist(ax, ay, cx, cy, ex, ey), pointSegDist(bx, by, cx, cy, ex, ey), pointSegDist(cx, cy, ax, ay, bx, by));
  }
  return d;
}

/** Times the polyline crosses the ring's outline. */
function ringCrossings(p, ring) {
  let k = 0;
  const n = ring.length / 2;
  for (let s = 0; s + 3 < p.length; s += 2) {
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if (segSegIntersect(p[s], p[s + 1], p[s + 2], p[s + 3], ring[2 * j], ring[2 * j + 1], ring[2 * i], ring[2 * i + 1])) k++;
    }
  }
  return k;
}

/** Segments of polylines bucketed by grid cell, for footprint queries. */
function segmentBuckets(lines, cell) {
  const map = new Map();
  lines.forEach((p, li) => {
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = Math.min(p[i], p[i + 2]), x1 = Math.max(p[i], p[i + 2]);
      const y0 = Math.min(p[i + 1], p[i + 3]), y1 = Math.max(p[i + 1], p[i + 3]);
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
          const key = `${gx},${gy}`;
          let list = map.get(key);
          if (!list) map.set(key, (list = []));
          list.push([li, i]);
        }
      }
    }
  });
  /** [line index, segment offset] pairs whose cells meet the bbox grown by `r`; deduplicated, in order. */
  return (bbox, r) => {
    const seen = new Set();
    const out = [];
    for (let gy = Math.floor((bbox[1] - r) / cell); gy <= Math.floor((bbox[3] + r) / cell); gy++) {
      for (let gx = Math.floor((bbox[0] - r) / cell); gx <= Math.floor((bbox[2] + r) / cell); gx++) {
        for (const e of map.get(`${gx},${gy}`) ?? []) {
          const key = e[0] * 1e7 + e[1];
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(e);
        }
      }
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  };
}

/** Split a flat polyline so no segment is longer than `maxSeg`. */
export function densifyLine(p, maxSeg) {
  const out = [p[0], p[1]];
  for (let i = 0; i + 3 < p.length; i += 2) {
    const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
    const k = Math.max(1, Math.ceil(len / maxSeg));
    for (let j = 1; j <= k; j++) out.push(p[i] + ((p[i + 2] - p[i]) * j) / k, p[i + 1] + ((p[i + 3] - p[i + 1]) * j) / k);
  }
  return out;
}

/**
 * Per-segment building clearance along each route (see ROUTE_CLEAR_*): the
 * nearest drawn road within ROUTE_ROAD_SNAP_M of the segment's midpoint sets
 * it. `roads` is the roads layer as built (dm). Returns the densified lines
 * and one clearance per segment.
 */
export function routeClearances(routeLines, roads) {
  const drawn = roads.roads.filter((r) => !(r.f && r.f & ROAD_FLAGS.tunnel));
  const lines = drawn.map((r) => r.p.map((v) => v / 10));
  const halfW = drawn.map((r) => (r.w ?? roads.widths[r.c]) / 2);
  const q = segmentBuckets(lines, 50);
  const outLines = [];
  const clear = [];
  for (const raw of routeLines) {
    const p = densifyLine(raw, ROUTE_CLEAR_SEG_M);
    const c = new Float64Array(p.length / 2 - 1);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
      let best = Infinity, hw = -1;
      for (const [li, k] of q([mx, my, mx, my], ROUTE_ROAD_SNAP_M)) {
        const l = lines[li];
        const d = pointSegDist(mx, my, l[k], l[k + 1], l[k + 2], l[k + 3]);
        if (d < best || (d === best && halfW[li] > hw)) {
          best = d;
          hw = halfW[li];
        }
      }
      c[i / 2] = best <= ROUTE_ROAD_SNAP_M
        ? Math.min(ROUTE_CLEAR_MAX_M, Math.max(ROUTE_CLEAR_MIN_M, hw + ROUTE_CLEAR_MARGIN_M))
        : ROUTE_CLEAR_MAX_M;
    }
    outLines.push(p);
    clear.push(c);
  }
  return { lines: outLines, clear };
}

/**
 * Which footprints (rings in metres) must go so nothing the rider follows
 * runs through a building:
 *
 * - `route`: closer to a scenic route centreline than that segment's
 *   clearance (`routeClear[line][segment]`, from `routeClearances`; a
 *   single `routeClearM` when not given): the route line is drawn there, on
 *   the road it rides;
 * - `road`: a drawn road's centreline passes right through (crosses the
 *   outline twice or more). Tunnels (incl. building passages) and steps are
 *   not drawn and are ignored; a driveway that ends inside a garage (one
 *   crossing) keeps its building.
 *
 * Returns a Uint8Array per footprint: 0 keep, 1 route, 2 road. Pure.
 */
export function buildingClearance(rings, { routeLines = [], routeClear = null, routeClearM = ROUTE_CLEAR_MAX_M, roadLines = [] } = {}) {
  const out = new Uint8Array(rings.length);
  const routeQ = segmentBuckets(routeLines, 50);
  const roadQ = segmentBuckets(roadLines, 50);
  const reach = routeClear ? routeClear.reduce((m, c) => c.reduce((a, v) => Math.max(a, v), m), 0) : routeClearM;
  rings.forEach((ring, bi) => {
    const bbox = ringBbox(ring);
    for (const [li, i] of routeQ(bbox, reach)) {
      const p = routeLines[li];
      const clearM = routeClear ? routeClear[li][i / 2] : routeClearM;
      if (segmentRingDistance(p[i], p[i + 1], p[i + 2], p[i + 3], ring) < clearM) {
        out[bi] = 1;
        return;
      }
    }
    const crossings = new Map();
    for (const [li, i] of roadQ(bbox, 0)) {
      const p = roadLines[li];
      const k = ringCrossings([p[i], p[i + 1], p[i + 2], p[i + 3]], ring);
      if (!k) continue;
      const total = (crossings.get(li) ?? 0) + k;
      if (total >= 2) {
        out[bi] = 2;
        return;
      }
      crossings.set(li, total);
    }
  });
  return out;
}

/** Standing water smaller than this gives way to a scenic route that runs through or beside it, m². */
export const ROUTE_DRY_WATER_MAX_M2 = 10000;

/**
 * Which water areas (the layer as built, dm) a scenic route must not run
 * through: a lake or pond (never a river, never the sea) smaller than
 * ROUTE_DRY_WATER_MAX_M2 that comes closer to a route centreline than that
 * segment's clearance (`routeClear`, from `routeClearances`: the rule that
 * keeps buildings off the route). OSM maps beach storm-drain channels and
 * creek-mouth lagoons this way, e.g. Santa Monica's Pico outlet
 * (`water=stream`, 12 × 70 m) under the beach path. Drawn as a flat sheet, it
 * reads as a flood across the path. Returns the indices of `water.areas` to
 * drop, ascending. Pure.
 */
export function routeWaterDrops(water, { routeLines = [], routeClear = null, routeClearM = ROUTE_CLEAR_MAX_M } = {}) {
  const standing = new Set(['lake', 'pond'].map((k) => water.areaKinds.indexOf(k)).filter((k) => k >= 0));
  const routeQ = segmentBuckets(routeLines, 50);
  const reach = routeClear ? routeClear.reduce((m, c) => c.reduce((a, v) => Math.max(a, v), m), 0) : routeClearM;
  const out = [];
  water.areas.forEach((a, ai) => {
    if (!standing.has(a.k)) return;
    const rings = a.r.map((r) => r.map((v) => v / 10));
    const areaM2 = Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0);
    if (areaM2 >= ROUTE_DRY_WATER_MAX_M2) return;
    for (const [li, i] of routeQ(ringBbox(rings[0]), reach)) {
      const p = routeLines[li];
      const clearM = routeClear ? routeClear[li][i / 2] : routeClearM;
      if (segmentRingDistance(p[i], p[i + 1], p[i + 2], p[i + 3], rings[0]) < clearM) {
        out.push(ai);
        return;
      }
    }
  });
  return out;
}

/**
 * Coast worlds: which of the water areas a route dried (`routeWaterDrops`)
 * become beach. Those are the ones whose outline touches a beach: a vertex
 * lies inside one or within `tolM` of its outline. OSM cuts such lagoons and
 * storm-drain channels out of the beach, so without this the default ground
 * (grass green) would show where they were. `areas` and `beaches` are in dm,
 * as in the layers. Returns the areas that touch, in order. Pure.
 */
export function waterOnBeach(areas, beaches, tolM = 2) {
  const bs = beaches.map((b) => b.r.map((r) => r.map((v) => v / 10)));
  return areas.filter((a) => {
    const ring = a.r[0].map((v) => v / 10);
    for (let i = 0; i + 1 < ring.length; i += 2) {
      const x = ring[i], y = ring[i + 1];
      for (const rings of bs) {
        if (pointInPolygon(x, y, rings)) return true;
        if (rings.some((r) => segmentRingDistance(x, y, x, y, r) <= tolM)) return true;
      }
    }
    return false;
  });
}

/**
 * Buildings → binary (see WORLD-FORMAT.md "buildings.bin"; VWB2 = VWB1 plus
 * one district byte per building). Outer rings only. Also returns the
 * footprints in metres so the vegetation pass keeps trees out of houses.
 *
 * `clear` drops footprints on the scenic routes and roads (see
 * `buildingClearance`); districts are classified before the drop so the
 * remaining buildings keep their palettes. Footprints are simplified at
 * `simplifyM` (Douglas-Peucker, the recipe's `buildingSimplifyM`).
 */
export const BUILDING_SIMPLIFY_M = 0.3;

export function buildBuildings(elements, projection, ext, landcoverPolys = [], clear = null, simplifyM = BUILDING_SIMPLIFY_M) {
  const list = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    for (const poly of polygonsOf(el, projection)) {
      const outer = poly[0];
      const n = outer.length / 2;
      if (n < 3) continue;
      let cx = 0, cy = 0;
      for (let i = 0; i < n; i++) { cx += outer[2 * i]; cy += outer[2 * i + 1]; }
      cx /= n; cy /= n;
      if (cx < ext.xMin || cx > ext.xMax || cy < ext.yMin || cy > ext.yMax) continue;
      const ring = simplifyLine([...outer, outer[0], outer[1]], simplifyM).slice(0, -2).map(dm);
      if (ring.length < 6 || ring.length / 2 > 65535) continue;
      // Counter-clockwise outer rings, so renderers extrude walls outward.
      let a = 0;
      const m = ring.length / 2;
      for (let i = 0, j = m - 1; i < m; j = i++) a += ring[2 * j] * ring[2 * i + 1] - ring[2 * i] * ring[2 * j + 1];
      if (Math.abs(a) / 200 < 8) continue; // < 8 m²
      if (a < 0) {
        const rev = [];
        for (let i = m - 1; i >= 0; i--) rev.push(ring[2 * i], ring[2 * i + 1]);
        ring.splice(0, ring.length, ...rev);
      }
      let ok = true;
      for (let i = 2; i < ring.length; i++) if (Math.abs(ring[i] - ring[i - 2]) > 32767) ok = false;
      if (!ok) continue;
      list.push({ ring, h: Math.min(65535, Math.round(buildingHeight(t) * 10)), k: buildingKind(t), cx, cy, area: Math.abs(a) / 200 });
    }
  }
  const industrial = landcoverPolys
    .filter((p) => p.kind === 'industrial')
    .map((p) => ({ rings: p.rings, bbox: ringBbox(p.rings[0]) }));
  const allDistricts = classifyDistricts(list, industrial);
  let district = allDistricts;
  const dropped = { route: 0, road: 0 };
  if (clear) {
    const why = buildingClearance(list.map((b) => b.ring.map((v) => v / 10)), clear);
    const keep = [];
    district = [];
    list.forEach((b, i) => {
      if (why[i] === 1) dropped.route++;
      else if (why[i] === 2) dropped.road++;
      else {
        keep.push(b);
        district.push(allDistricts[i]);
      }
    });
    list.splice(0, list.length, ...keep);
  }
  const count = list.length;
  const totalVerts = list.reduce((s, b) => s + b.ring.length / 2, 0);
  const headBytes = 12;
  const metaBytes = count * (2 + 2 + 1 + 1);
  const pad = (4 - ((headBytes + metaBytes) % 4)) % 4;
  const firstBytes = count * 8;
  const deltaBytes = (totalVerts - count) * 4;
  const buf = Buffer.alloc(headBytes + metaBytes + pad + firstBytes + deltaBytes);
  buf.write('VWB2', 0, 'latin1');
  buf.writeUInt32LE(count, 4);
  buf.writeUInt32LE(totalVerts, 8);
  let o = headBytes;
  for (const b of list) { buf.writeUInt16LE(b.ring.length / 2, o); o += 2; }
  for (const b of list) { buf.writeUInt16LE(b.h, o); o += 2; }
  for (const b of list) { buf.writeUInt8(b.k, o); o += 1; }
  for (const d of district) { buf.writeUInt8(d, o); o += 1; }
  o += pad;
  for (const b of list) { buf.writeInt32LE(b.ring[0], o); buf.writeInt32LE(b.ring[1], o + 4); o += 8; }
  for (const b of list) {
    for (let i = 2; i < b.ring.length; i++) { buf.writeInt16LE(b.ring[i] - b.ring[i - 2], o); o += 2; }
  }
  const districts = Object.fromEntries(BUILDING_DISTRICTS.map((name, i) => [name, district.filter((d) => d === i).length]));
  const footprints = list.map((b) => ({ cx: b.cx, cy: b.cy, ring: b.ring.map((v) => v / 10), r: Math.sqrt(b.area) }));
  return { bytes: buf, count, totalVerts, districts, footprints, dropped };
}

/** Segment index for clearance tests: every segment of every polyline, bucketed by cell. */
class SegmentGrid {
  constructor(cell) {
    this.cell = cell;
    this.grid = new PointGrid(cell);
  }
  addLine(p, halfWidth) {
    for (let i = 0; i + 3 < p.length; i += 2) {
      const seg = [p[i], p[i + 1], p[i + 2], p[i + 3], halfWidth];
      const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      const steps = Math.max(1, Math.ceil(len / this.cell));
      const seen = new Set();
      for (let k = 0; k <= steps; k++) {
        const x = p[i] + ((p[i + 2] - p[i]) * k) / steps;
        const y = p[i + 1] + ((p[i + 3] - p[i + 1]) * k) / steps;
        const key = this.grid.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
        if (seen.has(key)) continue;
        seen.add(key);
        this.grid.add(x, y, seg);
      }
    }
  }
  /** True when (x, y) lies within a segment's half-width + `margin`. */
  hits(x, y, margin) {
    for (const [ax, ay, bx, by, hw] of this.grid.near(x, y, this.cell)) {
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < hw + margin) return true;
    }
    return false;
  }
}

/** Points every `step` m along a polyline, `offset` m to its left (negative = right), jittered by hash. */
function alongLine(p, step, offset, jitterSeed, out) {
  let carry = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    let d = carry;
    for (; d < len; d += step) {
      const h = hash32(Math.round((ax + ux * d) * 10), Math.round((ay + uy * d) * 10), jitterSeed);
      const j = ((h & 0xffff) / 0x10000 - 0.5) * step * 0.5;
      const o = offset * (0.85 + (((h >>> 16) & 0xff) / 255) * 0.4);
      out.push({ x: ax + ux * (d + j) - uy * o, y: ay + uy * (d + j) + ux * o, h });
    }
    carry = d - len;
  }
}

/** Half-width a scenic route claims from trees, m (plus `roadClearM`). */
export const ROUTE_TREE_HALF_M = 2.5;

/** Defaults for the character kinds; a recipe's `vegetation.character` overrides them. */
export const CHARACTER_DEFAULTS = {
  /** Cypress spacing along cemetery boundaries, m (2 m inside the wall). */
  cypressM: 5,
  /** Poplar/willow spacing along each bank of a river or stream, m. */
  riparianM: 9,
  /** Field-edge tree spacing along farmland boundaries, m, and the share of 40 m runs kept. */
  hedgerowM: 9,
  hedgerowKeep: 0.32,
  /** OSM natural=tree_row spacing, m. */
  treeRowM: 7,
  /** Garden-tree lattice in residential land, m, and the share kept. */
  gardenM: 15,
  gardenKeep: 0.45,
  /** Lone field oaks: lattice m and share kept. */
  fieldOakM: 60,
  fieldOakKeep: 0.12,
  /** Clearance from road edges and building walls, m. */
  roadClearM: 1.8,
  buildingClearM: 1.5,
};

/**
 * Tree instance seeds (see WORLD-FORMAT.md "vegetation.bin").
 *
 * Woodland kinds come from a jittered global lattice per kind, kept where the
 * lattice point falls inside a forest/scrub/orchard/park polygon. Character
 * kinds follow lines: cypress rows round cemeteries, poplars along both banks
 * of rivers and streams, sparse field-edge trees on farmland boundaries, OSM
 * tree rows, garden trees in residential land and lone oaks in fields. Every
 * seed keeps clear of roads, buildings and open water. Character kinds are
 * kept whole; woodland is thinned uniformly to fit `maxInstances`, except
 * that with `corridor` ({ m, keep }) the woodland within `m` of a route keeps
 * the share `keep` first and the rest of the world shares what is left: the
 * woods the rider rides through stay dense while the far woods, drawn
 * low-poly and carried by the terrain's canopy texture, cost less.
 * Deterministic (integer hashes only). Single mapped trees (natural=tree) are
 * not used: Overpass attic queries for them run out of memory.
 */
export function buildVegetation({ polys, ext, recipe, roads = null, water = null, footprints = [], treeRows = [], routeLines = [] }) {
  const { seed, maxInstances, spacingM } = recipe;
  const C = { ...CHARACTER_DEFAULTS, ...(recipe.character ?? {}) };
  let corridorStats = null;
  const seen = new Set();
  const out = [];
  const character = [];

  const roadGrid = new SegmentGrid(40);
  if (roads) {
    for (const r of roads.roads) {
      if (r.f && r.f & ROAD_FLAGS.tunnel) continue;
      const w = r.w ?? roads.widths[r.c];
      roadGrid.addLine(r.p.map((v) => v / 10), w / 2);
    }
  }
  // Scenic routes count as roads too (some follow paths OSM has no road for).
  for (const p of routeLines) roadGrid.addLine(p, ROUTE_TREE_HALF_M);
  const bGrid = new PointGrid(40);
  for (const b of footprints) bGrid.add(b.cx, b.cy, b);
  const nearWall = (x, y, r) => {
    for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
      const ax = r[2 * j], ay = r[2 * j + 1], bx = r[2 * i], by = r[2 * i + 1];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < C.buildingClearM) return true;
    }
    return false;
  };
  // Open water and sand (a coast world's beaches, under a beach park's lattice) grow no trees.
  const waterPolys = [
    ...(water?.areas ?? []).map((a) => a.r.map((r) => r.map((v) => v / 10))),
    ...polys.filter((p) => p.kind === BEACH_KIND).map((p) => p.rings),
  ].map((rings) => {
    const bbox = ringBbox(rings[0]);
    return { rings, bbox, inside: polygonTester(rings, bbox) };
  });
  const blocked = (x, y) => {
    if (x < ext.xMin || x > ext.xMax || y < ext.yMin || y > ext.yMax) return true;
    if ((roads || routeLines.length) && roadGrid.hits(x, y, C.roadClearM)) return true;
    for (const b of bGrid.near(x, y, 40)) {
      if (Math.hypot(b.cx - x, b.cy - y) > b.r * 1.5 + C.buildingClearM + 2) continue;
      if (pointInRing(x, y, b.ring) || nearWall(x, y, b.ring)) return true;
    }
    return waterPolys.some((p) => p.bbox[0] <= x && x <= p.bbox[2] && p.bbox[1] <= y && y <= p.bbox[3] && p.inside(x, y));
  };
  const pushCharacter = (pts, k) => {
    for (const p of pts) {
      if (blocked(p.x, p.y)) continue;
      character.push({ x: p.x, y: p.y, k, s: (p.h >>> 8) & 0xff });
    }
  };
  const scatter = (rings, step, keep, salt, jitter) => {
    const [x0, y0, x1, y1] = ringBbox(rings[0]);
    const pts = [];
    for (let j = Math.floor(y0 / step); j <= Math.ceil(y1 / step); j++) {
      for (let i = Math.floor(x0 / step); i <= Math.ceil(x1 / step); i++) {
        const h = hash32(i, j, seed ^ salt);
        if ((h & 0xffff) / 0x10000 >= keep) continue;
        const x = (i + (((h >>> 16) & 0xff) / 255 - 0.5) * jitter) * step;
        const y = (j + (((h >>> 24) & 0xff) / 255 - 0.5) * jitter) * step;
        if (pointInPolygon(x, y, rings)) pts.push({ x, y, h });
      }
    }
    return pts;
  };

  for (let pi = 0; pi < polys.length; pi++) {
    const { kind, tags, rings } = polys[pi];
    const outer = rings[0];
    if (kind === 'cemetery') {
      const pts = [];
      alongLine([...outer, outer[0], outer[1]], C.cypressM, ringArea(outer) > 0 ? 2 : -2, seed ^ 0xc1, pts);
      pushCharacter(pts, VK.cypress);
      continue;
    }
    if (kind === 'farmland') {
      // Field-edge trees in runs (kept per 40 m block), like real hedgerows.
      const pts = [];
      alongLine([...outer, outer[0], outer[1]], C.hedgerowM, 0, seed ^ 0x4e, pts);
      pushCharacter(
        pts.filter((p) => (hash32(Math.floor(p.x / 40), Math.floor(p.y / 40), seed ^ 0x77) & 0xffff) / 0x10000 < C.hedgerowKeep),
        VK.hedgerow,
      );
      pushCharacter(scatter(rings, C.fieldOakM, C.fieldOakKeep, 0x0a6, 1), VK.broadleaf);
      continue;
    }
    if (kind === 'residential') {
      pushCharacter(scatter(rings, C.gardenM, C.gardenKeep, 0x6a2, 0.8), VK.garden);
      continue;
    }
    const spacing = spacingM[kind === 'forest' ? (tags.landuse === 'forest' ? 'forest' : 'wood') : kind];
    if (!spacing) continue;
    let vk;
    if (kind === 'forest') vk = tags.leaf_type === 'needleleaved' ? VK.conifer : VK.broadleaf;
    else if (kind === 'scrub') vk = VK.scrub;
    else if (kind === 'orchard') vk = VK.olive;
    else if (kind === 'park') vk = VK.park;
    else continue;
    const [x0, y0, x1, y1] = ringBbox(outer);
    const lattice = Math.round(spacing * 10);
    for (let j = Math.floor(y0 / spacing); j <= Math.ceil(y1 / spacing); j++) {
      for (let i = Math.floor(x0 / spacing); i <= Math.ceil(x1 / spacing); i++) {
        const key = `${lattice}:${i}:${j}`;
        if (seen.has(key)) continue;
        const h = hash32(i, j, seed ^ lattice);
        const x = (i + ((h & 0xffff) / 0x10000 - 0.5) * 0.8) * spacing;
        const y = (j + ((h >>> 16) / 0x10000 - 0.5) * 0.8) * spacing;
        if (x < ext.xMin || x > ext.xMax || y < ext.yMin || y > ext.yMax) continue;
        if (!pointInPolygon(x, y, rings)) continue;
        seen.add(key);
        if (blocked(x, y)) continue;
        out.push({ x, y, k: vk, s: hash32(j, i, seed) & 0xff, h });
      }
    }
  }

  if (water) {
    for (const line of water.lines) {
      const w = line.w ?? water.lineWidths[line.k];
      const p = line.p.map((v) => v / 10);
      const pts = [];
      alongLine(p, C.riparianM, w / 2 + 3, seed ^ 0x51, pts);
      alongLine(p, C.riparianM, -(w / 2 + 3), seed ^ 0x52, pts);
      pushCharacter(pts, VK.riparian);
    }
  }
  for (const p of treeRows) {
    const pts = [];
    alongLine(p, C.treeRowM, 0, seed ^ 0x7e, pts);
    pushCharacter(pts, VK.hedgerow);
  }

  // Character trees whole, then woodland thinned to fit: uniformly, or the
  // route corridor first at its own share.
  const kept = character.slice(0, maxInstances);
  const room = maxInstances - kept.length;
  const byHash = (a, b) => a.h - b.h || a.x - b.x || a.y - b.y;
  let thinned;
  if (recipe.corridor && routeLines.length) {
    const { m, keep } = recipe.corridor;
    const grid = new SegmentGrid(m);
    for (const p of routeLines) grid.addLine(p, m);
    const inside = (x, y) => {
      for (const [ax, ay, bx, by] of grid.grid.near(x, y, 2 * m)) {
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= m) return true;
      }
      return false;
    };
    const near = [];
    const far = [];
    for (const t of out) (inside(t.x, t.y) ? near : far).push(t);
    near.sort(byHash);
    far.sort(byHash);
    const nearKept = near.slice(0, Math.min(room, Math.round(near.length * keep)));
    thinned = [...nearKept, ...far.slice(0, room - nearKept.length)];
    corridorStats = { lattice: near.length, kept: nearKept.length, farLattice: far.length, farKept: thinned.length - nearKept.length };
  } else {
    thinned = out.length > room ? [...out].sort(byHash).slice(0, room) : out;
  }
  const quantum = Math.max(0.25, Math.ceil(((Math.max(ext.xMax - ext.xMin, ext.yMax - ext.yMin) / 65535) * 100)) / 100);
  const items = [...kept, ...thinned].map((t) => ({
    qx: Math.min(65535, Math.max(0, Math.round((t.x - ext.xMin) / quantum))),
    qy: Math.min(65535, Math.max(0, Math.round((t.y - ext.yMin) / quantum))),
    k: t.k,
    s: t.s,
  }));
  items.sort((a, b) => a.qy - b.qy || a.qx - b.qx || a.k - b.k || a.s - b.s);
  const n = items.length;
  const buf = Buffer.alloc(16 + n * 6);
  buf.write('VWV1', 0, 'latin1');
  buf.writeUInt32LE(n, 4);
  buf.writeFloatLE(quantum, 8);
  buf.writeUInt32LE(0, 12);
  let o = 16;
  for (const it of items) { buf.writeUInt16LE(it.qx, o); o += 2; }
  for (const it of items) { buf.writeUInt16LE(it.qy, o); o += 2; }
  for (const it of items) buf[o++] = it.k;
  for (const it of items) buf[o++] = it.s;
  const byKind = Object.fromEntries(VEGETATION_KINDS.map((k, i) => [k, items.filter((it) => it.k === i).length]));
  return { bytes: buf, count: n, lattice: out.length, character: character.length, quantum, byKind, ...(corridorStats ? { corridor: corridorStats } : {}) };
}

/** OSM natural=tree_row ways → polylines in world metres, clipped to the extent. */
export function buildTreeRows(elements, projection, ext) {
  const rows = [];
  for (const el of elements ?? []) {
    if (el.type !== 'way' || !el.geometry) continue;
    for (const piece of clipLine(projectGeom(el.geometry, projection), ext)) rows.push(piece);
  }
  return rows;
}

/**
 * How prominent a POI is for in-world labels: 3 = city/town, 2 = a place
 * with a Wikipedia article (basilicas, castles, named peaks), a non-village
 * with a Wikidata entry, or a village of 1,000+; 1 = everything else.
 */
export function poiRank(kind, t) {
  if (kind === 'town') return 3;
  const pop = parseInt(t.population ?? '', 10);
  if (t.wikipedia || (kind !== 'village' && t.wikidata) || pop >= 1000) return 2;
  return 1;
}

export function buildPois(elements, projection, ext) {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const t = el.tags ?? {};
    const name = t.name;
    if (!name) continue;
    let kind = null;
    if (t.place === 'city' || t.place === 'town') kind = 'town';
    else if (t.place) kind = 'village';
    else if (t.natural === 'peak') kind = 'peak';
    else if (t.tourism === 'viewpoint') kind = 'viewpoint';
    else if (t.amenity === 'place_of_worship') kind = 'church';
    else if (t.historic || t.tourism === 'attraction') kind = 'landmark';
    if (!kind) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined) continue;
    const [x, y] = projection.forward(lat, lon);
    if (x < ext.xMin || x > ext.xMax || y < ext.yMin || y > ext.yMax) continue;
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind, rank: poiRank(kind, t), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, osm: `${el.type}/${el.id}` });
  }
  return out;
}
