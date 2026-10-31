// OSM elements → world vector layers (roads, water, landcover, buildings,
// vegetation seeds, POIs) in world metres. Encodings: docs/worlds/WORLD-FORMAT.md.
// Everything here is a pure function of (elements, projection, recipe), so
// the same cached Overpass responses always give byte-identical layers.

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
export const ROAD_FLAGS = { bridge: 1, tunnel: 2, unpaved: 4, oneway: 8 };
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
export const VEGETATION_KINDS = ['broadleaf', 'conifer', 'scrub', 'olive', 'park'];

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

export function buildWater(elements, projection, ext) {
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
  return {
    version: 1,
    units: 'dm',
    areaKinds: WATER_AREA_KINDS,
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

export function buildLandcover(elements, projection, ext) {
  const areas = [];
  const polys = []; // full-precision copies for vegetation seeding
  for (const el of elements) {
    const t = el.tags ?? {};
    const kind = landcoverKind(t);
    if (!kind) continue;
    for (const poly of polygonsOf(el, projection)) {
      const rings = finishPolygon(poly, ext, 3, 200);
      if (!rings) continue;
      const k = LANDCOVER_KINDS.indexOf(kind);
      areas.push({ k, r: rings });
      polys.push({ kind, tags: t, rings: rings.map((r) => r.map((v) => v / 10)) });
    }
  }
  return { layer: { version: 1, units: 'dm', kinds: LANDCOVER_KINDS, areas }, polys };
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

/** Buildings → binary (see WORLD-FORMAT.md "buildings.bin"). Outer rings only in v1. */
export function buildBuildings(elements, projection, ext) {
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
      const ring = simplifyLine([...outer, outer[0], outer[1]], 0.3).slice(0, -2).map(dm);
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
      list.push({ ring, h: Math.min(65535, Math.round(buildingHeight(t) * 10)), k: buildingKind(t) });
    }
  }
  const count = list.length;
  const totalVerts = list.reduce((s, b) => s + b.ring.length / 2, 0);
  const headBytes = 12;
  const metaBytes = count * (2 + 2 + 1);
  const pad = (4 - ((headBytes + metaBytes) % 4)) % 4;
  const firstBytes = count * 8;
  const deltaBytes = (totalVerts - count) * 4;
  const buf = Buffer.alloc(headBytes + metaBytes + pad + firstBytes + deltaBytes);
  buf.write('VWB1', 0, 'latin1');
  buf.writeUInt32LE(count, 4);
  buf.writeUInt32LE(totalVerts, 8);
  let o = headBytes;
  for (const b of list) { buf.writeUInt16LE(b.ring.length / 2, o); o += 2; }
  for (const b of list) { buf.writeUInt16LE(b.h, o); o += 2; }
  for (const b of list) { buf.writeUInt8(b.k, o); o += 1; }
  o += pad;
  for (const b of list) { buf.writeInt32LE(b.ring[0], o); buf.writeInt32LE(b.ring[1], o + 4); o += 8; }
  for (const b of list) {
    for (let i = 2; i < b.ring.length; i++) { buf.writeInt16LE(b.ring[i] - b.ring[i - 2], o); o += 2; }
  }
  return { bytes: buf, count, totalVerts };
}

/**
 * Tree instance seeds: a jittered global lattice per kind, kept where the
 * lattice point falls inside a forest/scrub/orchard/park polygon.
 * Deterministic (integer hash per lattice cell). Single mapped trees
 * (natural=tree) are not used: Overpass attic queries for them run out of
 * memory on the public instance.
 */
export function buildVegetation({ polys, ext, recipe }) {
  const { seed, maxInstances, spacingM } = recipe;
  const seen = new Set();
  const out = [];
  for (let pi = 0; pi < polys.length; pi++) {
    const { kind, tags, rings } = polys[pi];
    const spacing = spacingM[kind === 'forest' ? (tags.landuse === 'forest' ? 'forest' : 'wood') : kind];
    if (!spacing) continue;
    let vk;
    if (kind === 'forest') vk = tags.leaf_type === 'needleleaved' ? 1 : 0;
    else if (kind === 'scrub') vk = 2;
    else if (kind === 'orchard') vk = 3;
    else if (kind === 'park') vk = 4;
    else continue;
    const outer = rings[0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      x0 = Math.min(x0, outer[i]); x1 = Math.max(x1, outer[i]);
      y0 = Math.min(y0, outer[i + 1]); y1 = Math.max(y1, outer[i + 1]);
    }
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
        out.push({ x, y, k: vk, s: hash32(j, i, seed) & 0xff, h });
      }
    }
  }
  let thinned = out;
  if (out.length > maxInstances) {
    // Keep a hash-ranked subset: uniform thinning, stable across runs.
    thinned = [...out].sort((a, b) => a.h - b.h || a.x - b.x || a.y - b.y).slice(0, maxInstances);
  }
  const quantum = Math.max(0.25, Math.ceil(((Math.max(ext.xMax - ext.xMin, ext.yMax - ext.yMin) / 65535) * 100)) / 100);
  const items = thinned.map((t) => ({
    qx: Math.min(65535, Math.round((t.x - ext.xMin) / quantum)),
    qy: Math.min(65535, Math.round((t.y - ext.yMin) / quantum)),
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
  return { bytes: buf, count: n, lattice: out.length, quantum };
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
    out.push({ name, kind, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, osm: `${el.type}/${el.id}` });
  }
  return out;
}
