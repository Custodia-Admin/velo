/**
 * Tree meshes in unit space (height 0–1, crown radius ≈ 1 across): one per
 * crown shape and level of detail. Instances scale them by (crown radius,
 * height, crown radius). Crowns are clumps of noise-displaced lumps with
 * soft "foliage" normals (blended toward the crown centre, so light wraps
 * the canopy instead of faceting it) and baked ambient occlusion (darker
 * underneath and inside), trunks are thin tapered cylinders.
 *
 * Attributes: position, normal, aCrown (1 crown, 0 trunk), aAo (0–1).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { TREE_SHAPES, type TreeShape } from './treeField';

export type TreeLod = 'near' | 'far';

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 3D value noise in [0, 1] (CPU, for baking displacement). */
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

interface Lump {
  c: [number, number, number];
  s: [number, number, number];
}

/** A crown lump: icosphere displaced by noise, foliage normals, AO, as a non-indexed geometry. */
function lump(l: Lump, detail: number, rough: number, salt: number, crownC: [number, number, number], crownS: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const out = new Float32Array(n * 3);
  const ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const d = 1 + rough * (noise3(x * 2.1 + salt, y * 2.1, z * 2.1) - 0.5) * 2 + rough * 0.5 * (noise3(x * 5.3, y * 5.3 + salt, z * 5.3) - 0.5);
    const px = l.c[0] + x * d * l.s[0];
    const py = l.c[1] + y * d * l.s[1];
    const pz = l.c[2] + z * d * l.s[2];
    out[i * 3] = px;
    out[i * 3 + 1] = py;
    out[i * 3 + 2] = pz;
    // AO: underside and crown interior darker.
    const ty = (py - (crownC[1] - crownS[1])) / (2 * crownS[1]);
    const radial = Math.min(1, Math.hypot((px - crownC[0]) / crownS[0], (pz - crownC[2]) / crownS[2]));
    ao[i] = Math.min(1, Math.max(0.25, (0.45 + 0.55 * Math.min(1, Math.max(0, ty))) * (0.7 + 0.3 * radial)));
  }
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  // Foliage normals: blend face normals toward the direction from the crown centre.
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) {
    const rx = (out[i * 3] - crownC[0]) / crownS[0];
    const ry = (out[i * 3 + 1] - crownC[1]) / crownS[1];
    const rz = (out[i * 3 + 2] - crownC[2]) / crownS[2];
    const rl = Math.hypot(rx, ry, rz) || 1;
    const bx = nrm.getX(i) * 0.2 + (rx / rl) * 0.8;
    const by = nrm.getY(i) * 0.2 + (ry / rl) * 0.8;
    const bz = nrm.getZ(i) * 0.2 + (rz / rl) * 0.8;
    const bl = Math.hypot(bx, by, bz) || 1;
    nrm.setXYZ(i, bx / bl, by / bl, bz / bl);
  }
  g.setAttribute('aCrown', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  g.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
  g.deleteAttribute('uv');
  return g;
}

/** Tapered trunk from y0 to y1, radius r (unit space), with a slight lean. */
function trunk(y0: number, y1: number, r: number, sides: number, lean = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r * 0.6, r, y1 - y0, sides, 1, true).toNonIndexed();
  g.translate(0, (y0 + y1) / 2, 0);
  if (lean) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + lean * (p.getY(i) - y0));
  }
  g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  g.setAttribute('aCrown', new THREE.BufferAttribute(new Float32Array(n), 1));
  const ao = new Float32Array(n);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) ao[i] = 0.55 + 0.35 * Math.min(1, p.getY(i) / Math.max(y1, 1e-3));
  g.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
  g.deleteAttribute('uv');
  return g;
}

/** Spindle/cone crowns via a lathe profile (radius per height), noise-displaced. */
function lathe(profile: [number, number][], segments: number, rough: number, salt: number): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.001), y));
  const g = new THREE.LatheGeometry(pts, segments).toNonIndexed();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const yMin = profile[0][1];
  const yMax = profile[profile.length - 1][1];
  const cy = (yMin + yMax) / 2;
  const sy = (yMax - yMin) / 2;
  const ao = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const d = 1 + rough * (noise3(x * 6 + salt, y * 9, z * 6) - 0.5) * 2;
    pos.setXYZ(i, x * d, y, z * d);
    ao[i] = 0.45 + 0.55 * Math.min(1, Math.max(0, (y - yMin) / (yMax - yMin)));
  }
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const rx = pos.getX(i);
    const ry = (pos.getY(i) - cy) / sy;
    const rz = pos.getZ(i);
    const rl = Math.hypot(rx, ry, rz) || 1;
    const bx = nrm.getX(i) * 0.5 + (rx / rl) * 0.5;
    const by = nrm.getY(i) * 0.5 + (ry / rl) * 0.5;
    const bz = nrm.getZ(i) * 0.5 + (rz / rl) * 0.5;
    const bl = Math.hypot(bx, by, bz) || 1;
    nrm.setXYZ(i, bx / bl, by / bl, bz / bl);
  }
  g.setAttribute('aCrown', new THREE.BufferAttribute(new Float32Array(pos.count).fill(1), 1));
  g.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
  g.deleteAttribute('uv');
  return g;
}

function clumpCrown(center: [number, number, number], size: [number, number, number], lumps: number, detail: number, rough: number, salt: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [lump({ c: center, s: [size[0] * 0.78, size[1] * 0.8, size[2] * 0.78] }, detail, rough, salt, center, size)];
  for (let k = 0; k < lumps; k++) {
    const a = (k / lumps) * Math.PI * 2 + hash3(k, salt, 1) * 0.8;
    const rr = 0.42 + 0.18 * hash3(k, salt, 2);
    const yy = (hash3(k, salt, 3) - 0.35) * 0.9;
    const sc = 0.42 + 0.16 * hash3(k, salt, 4);
    parts.push(
      lump(
        {
          c: [center[0] + Math.cos(a) * rr * size[0], center[1] + yy * size[1], center[2] + Math.sin(a) * rr * size[2]],
          s: [sc * size[0], sc * size[1] * 1.15, sc * size[2]],
        },
        detail,
        rough,
        salt + k * 13,
        center,
        size,
      ),
    );
  }
  return parts;
}

function shapeParts(shape: TreeShape, lod: TreeLod): THREE.BufferGeometry[] {
  const near = lod === 'near';
  const det = near ? 1 : 0;
  const lumps = near ? 4 : 0;
  switch (shape) {
    case 'round':
      return [...(near ? [trunk(0, 0.5, 0.075, 6)] : []), ...clumpCrown([0, 0.62, 0], [0.95, 0.37, 0.95], lumps, det, near ? 0.16 : 0.08, 1)];
    case 'olive':
      return [
        ...(near ? [trunk(0, 0.42, 0.11, 6, 0.25), trunk(0, 0.38, 0.08, 5, -0.3)] : []),
        ...clumpCrown([0, 0.66, 0], [0.98, 0.33, 0.98], near ? 4 : 0, det, near ? 0.24 : 0.1, 7),
      ];
    case 'bush':
      return clumpCrown([0, 0.48, 0], [0.95, 0.5, 0.95], near ? 3 : 0, det, near ? 0.2 : 0.1, 11);
    case 'umbrella':
      return [
        ...(near ? [trunk(0, 0.8, 0.05, 6, 0.06)] : []),
        ...clumpCrown([0, 0.86, 0], [1, 0.13, 1], near ? 4 : 0, det, near ? 0.14 : 0.06, 5),
      ];
    case 'column':
      return [
        lathe(
          [
            [0.25, 0.0],
            [0.85, 0.08],
            [1.0, 0.28],
            [0.92, 0.5],
            [0.68, 0.72],
            [0.38, 0.9],
            [0.05, 1.0],
          ],
          near ? 9 : 4,
          near ? 0.14 : 0.04,
          3,
        ),
      ];
    case 'poplar':
      return [
        ...(near ? [trunk(0, 0.2, 0.25, 5)] : []),
        lathe(
          [
            [0.3, 0.12],
            [0.85, 0.25],
            [1.0, 0.45],
            [0.9, 0.65],
            [0.6, 0.85],
            [0.08, 1.0],
          ],
          near ? 9 : 4,
          near ? 0.18 : 0.05,
          9,
        ),
      ];
    case 'cone':
      return [
        ...(near ? [trunk(0, 0.15, 0.12, 5)] : []),
        lathe(
          [
            [0.9, 0.1],
            [1.0, 0.16],
            [0.7, 0.45],
            [0.38, 0.75],
            [0.03, 1.0],
          ],
          near ? 9 : 4,
          near ? 0.12 : 0.04,
          13,
        ),
      ];
  }
}

/** One merged unit geometry for a crown shape at a level of detail. */
export function treeGeometry(shape: TreeShape, lod: TreeLod): THREE.BufferGeometry {
  const parts = shapeParts(shape, lod);
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error(`tree geometry ${shape}/${lod} failed to merge`);
  merged.computeBoundingSphere();
  return merged;
}

/** Triangles per tree for a shape/LOD (for budgets and tests). */
export function treeTriangles(shape: TreeShape, lod: TreeLod): number {
  const g = treeGeometry(shape, lod);
  const n = g.getAttribute('position').count / 3;
  g.dispose();
  return n;
}

export const ALL_TREE_SHAPES = TREE_SHAPES;
