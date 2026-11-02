/**
 * Extruded buildings for the world renderer (geometry only; three.js types
 * for the buffers). Footprints come from the bundle (counter-clockwise outer
 * rings); each building gets walls from just below its lowest ground point
 * to its height, a hipped terracotta roof when the footprint allows (convex,
 * ≤ 10 corners) or a flat one, and a palette by district:
 *
 * - old town: Perugia travertine and sandstone, Assisi's pink Subasio
 *   limestone, some brick; a floor or two taller than the tag says;
 * - suburb: Umbrian plaster (ochre, cream, sand, faded pink);
 * - countryside: stone farmhouses (casali), plaster sheds;
 * - industrial: pale panels under flat grey roofs.
 *
 * Attributes: position (relative to the chunk origin), normal, color, aWall
 * (u along the wall in metres, v up the wall in metres, wall flag: 1 walls with
 * windows, 0.5 plain walls, 0 roof; seed, negative for stone).
 */

import * as THREE from 'three';

import type { Heightfield } from '@/lib/world/heightfield';
import type { BuildingsLayer } from '@/lib/world/loadWorld';

export const PLASTER = ['#c9a066', '#d4ad72', '#ddc79c', '#e4d6b6', '#d9bf8f', '#c98f6c', '#d2a184', '#cfc6b3', '#bfa98a', '#e0cfa8', '#c4945f', '#d8b07a'];
/** Perugia travertine / grey sandstone. */
export const STONE = ['#cdb29a', '#c2b39c', '#b5a590', '#a99c88', '#d0c0a6', '#bdae96'];
/** Assisi: pink and white Subasio limestone. */
export const STONE_PINK = ['#d6b7a0', '#dcbfaa', '#e2cdbb', '#cfae98', '#e6d6c6'];
export const BRICK = ['#a8664a', '#b07255', '#9d5f45', '#b98062'];
export const ROOFS = ['#a85b3d', '#b5694a', '#9c5940', '#8f5641', '#b87657', '#a4644b', '#9a6a52', '#a8734f', '#8e5a45', '#b2805e'];
export const IND_WALL = ['#c2c0b8', '#b6b3aa', '#d0cdc4', '#bdb8ac'];
export const IND_ROOF = ['#8f8e8a', '#9da1a3', '#7d7b76', '#a9a49a'];

/** World x east of which old-town stone is Assisi's pink limestone. */
export const ASSISI_X = 14000;

const KIND_CHURCH = 3;
const KIND_INDUSTRIAL = 4;
const KIND_SHED = 5;
const DISTRICT_OLD = 1;
const DISTRICT_RURAL = 2;
const DISTRICT_INDUSTRIAL = 3;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isConvex(pts: [number, number][]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) continue;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function ringArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export interface BuildingStyle {
  wall: string;
  roof: string;
  stone: boolean;
  /** Floors added on top of the tagged/default height. */
  extraFloors: number;
  pitched: boolean;
}

/** Palette and massing for one building (deterministic per index). */
export function buildingStyle(kind: number, district: number, x: number, area: number, rng: () => number): BuildingStyle {
  const pick = (list: readonly string[]) => list[Math.floor(rng() * list.length) % list.length];
  const industrial = kind === KIND_INDUSTRIAL || district === DISTRICT_INDUSTRIAL;
  if (industrial && kind !== KIND_CHURCH) {
    return { wall: pick(IND_WALL), roof: area > 300 ? pick(IND_ROOF) : pick(ROOFS), stone: false, extraFloors: 0, pitched: false };
  }
  const church = kind === KIND_CHURCH;
  const old = district === DISTRICT_OLD;
  const rural = district === DISTRICT_RURAL;
  const stoneShare = church ? 1 : old ? 0.72 : rural ? (kind === KIND_SHED ? 0.3 : 0.65) : 0.15;
  const stone = rng() < stoneShare;
  let wall: string;
  if (stone) {
    if (old && rng() < 0.18) wall = pick(BRICK);
    else wall = x > ASSISI_X ? pick(STONE_PINK) : pick(STONE);
  } else wall = pick(PLASTER);
  const extraFloors = old && !church ? (rng() < 0.6 ? 1 : 2) : 0;
  return { wall, roof: pick(ROOFS), stone, extraFloors, pitched: true };
}

export interface BuildingGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  walls: Float32Array;
  count: number;
}

/**
 * Geometry for the given buildings, positions relative to (originX, originZ)
 * in three.js coordinates (x east, y up, z south).
 */
export function buildBuildingGeometry(
  layer: BuildingsLayer,
  indices: readonly number[],
  hf: Heightfield,
  originX: number,
  originZ: number,
): BuildingGeometryData {
  const P: number[] = [];
  const N: number[] = [];
  const C: number[] = [];
  const A: number[] = [];
  const col = new THREE.Color();
  const rc = new THREE.Color();
  const weathered = new THREE.Color('#7d6a5c');
  const flatTint = new THREE.Color('#9b8f7c');
  const push = (x: number, h: number, y: number, nx: number, ny: number, nz: number, c: THREE.Color, u: number, v: number, wall: number, seed: number) => {
    P.push(x - originX, h, -y - originZ);
    N.push(nx, ny, nz);
    C.push(c.r, c.g, c.b);
    A.push(u, v, wall, seed);
  };
  /** A roof triangle from world (x, y, h) corners, wound to face up. */
  const tri = (a: number[], b: number[], c: number[], color: THREE.Color, seed: number) => {
    const ax = a[0], ay = a[2], az = -a[1];
    const ux = b[0] - ax, uy = b[2] - ay, uz = -b[1] - az;
    const vx = c[0] - ax, vy = c[2] - ay, vz = -c[1] - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    let bb = b;
    let cc = c;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      bb = c;
      cc = b;
    }
    for (const p of [a, bb, cc]) push(p[0], p[2], p[1], nx, ny, nz, color, 0, 0, 0, seed);
  };
  let count = 0;
  for (const i of indices) {
    const s = layer.start[i];
    const e = layer.start[i + 1];
    const pts: [number, number][] = [];
    for (let k = s; k < e; k++) pts.push([layer.xy[k * 2], layer.xy[k * 2 + 1]]);
    if (pts.length < 3) continue;
    if (ringArea(pts) < 0) pts.reverse();
    const kind = layer.kind[i];
    const district = layer.district[i];
    const rng = mulberry32(Math.imul(i + 1, 2654435761));
    let minH = Infinity;
    let maxH = -Infinity;
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      const h = hf.sampleHeight(p[0], p[1]);
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
      cx += p[0];
      cy += p[1];
    }
    cx /= pts.length;
    cy /= pts.length;
    const ar = Math.abs(ringArea(pts));
    const style = buildingStyle(kind, district, cx, ar, rng);
    const industrial = style.pitched === false;
    const church = kind === KIND_CHURCH;
    // Tagged heights are mostly per-type defaults: vary by whole floors.
    let hgt = layer.height[i] || 7;
    if (!industrial && !church) {
      const floors = Math.max(1, Math.round((hgt - 1) / 3.2));
      const df = rng() < 0.5 ? 0 : rng() < 0.55 ? 1 : -1;
      hgt = Math.max(3.6, (floors + df + style.extraFloors) * 3.2 + 1 + rng() * 0.8);
    }
    const base = minH - 1;
    const top = Math.max(minH + hgt, maxH + Math.min(hgt, 4));
    col.set(style.wall).multiplyScalar(0.84 + rng() * 0.28);
    rc.set(style.roof).multiplyScalar(0.8 + rng() * 0.32);
    if (!industrial && rng() < 0.3) rc.lerp(weathered, 0.35);
    const seed = (0.05 + rng() * 0.95) * (style.stone ? -1 : 1);
    // Walls.
    let u = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.05) continue;
      const nx = (b[1] - a[1]) / len;
      const ny = -(b[0] - a[0]) / len;
      const wl = (len > 2.6 ? 1 : 0.5) * (industrial ? 0.5 : 1);
      const vOff = base - minH;
      const quad: [number[], number, number, number][] = [
        [a, base, u, 0],
        [b, base, u + len, 0],
        [b, top, u + len, top - base],
        [a, base, u, 0],
        [b, top, u + len, top - base],
        [a, top, u, top - base],
      ];
      for (const [p, h, uu, vv] of quad) push(p[0], h, p[1], nx, 0, -ny, col, uu, vv + vOff, wl, seed);
      u += len;
    }
    // Roof.
    const convex = isConvex(pts);
    const pitched = style.pitched && convex && pts.length <= 10 && ar > 15 && (church || ar < 1800);
    if (pitched) {
      const pitch = Math.tan(((20 + rng() * 6) * Math.PI) / 180);
      if (pts.length === 4) {
        const e0 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        const e1 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
        const along = e0 >= e1 ? [(pts[1][0] - pts[0][0]) / e0, (pts[1][1] - pts[0][1]) / e0] : [(pts[2][0] - pts[1][0]) / e1, (pts[2][1] - pts[1][1]) / e1];
        const w = Math.min(e0, e1);
        const rh = (w / 2) * pitch;
        const half = Math.max(0, (Math.max(e0, e1) - w) / 2);
        const r1 = [cx - along[0] * half, cy - along[1] * half, top + rh];
        const r2 = [cx + along[0] * half, cy + along[1] * half, top + rh];
        for (let k = 0; k < 4; k++) {
          const a = [...pts[k], top];
          const b = [...pts[(k + 1) % 4], top];
          const ra = Math.hypot(a[0] - r1[0], a[1] - r1[1]) < Math.hypot(a[0] - r2[0], a[1] - r2[1]) ? r1 : r2;
          const rb = Math.hypot(b[0] - r1[0], b[1] - r1[1]) < Math.hypot(b[0] - r2[0], b[1] - r2[1]) ? r1 : r2;
          tri(a, b, rb, rc, seed);
          if (ra !== rb) tri(a, rb, ra, rc, seed);
        }
      } else {
        const rh = Math.min(3.2, Math.sqrt(ar) * 0.5 * pitch);
        const apex = [cx, cy, top + rh];
        for (let k = 0; k < pts.length; k++) tri([...pts[k], top], [...pts[(k + 1) % pts.length], top], apex, rc, seed);
      }
    } else {
      const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
      let tris: number[][] = [];
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, []);
      } catch {
        tris = [];
      }
      const roofC = industrial ? rc : rc.clone().lerp(flatTint, 0.25);
      for (const t of tris) tri([...pts[t[0]], top], [...pts[t[1]], top], [...pts[t[2]], top], roofC, seed);
    }
    count++;
  }
  return {
    positions: new Float32Array(P),
    normals: new Float32Array(N),
    colors: new Float32Array(C),
    walls: new Float32Array(A),
    count,
  };
}

/** Building indices per terrain chunk (by footprint centroid). */
export function bucketBuildings(layer: BuildingsLayer, locate: (x: number, y: number) => number, chunks: number): number[][] {
  const out: number[][] = Array.from({ length: chunks }, () => []);
  for (let i = 0; i < layer.count; i++) {
    const s = layer.start[i];
    const e = layer.start[i + 1];
    let x = 0;
    let y = 0;
    for (let k = s; k < e; k++) {
      x += layer.xy[k * 2];
      y += layer.xy[k * 2 + 1];
    }
    const n = Math.max(1, e - s);
    const c = locate(x / n, y / n);
    if (c >= 0 && c < chunks) out[c].push(i);
  }
  return out;
}

export { DISTRICT_OLD, DISTRICT_RURAL, DISTRICT_INDUSTRIAL };
